const { onRequest } = require("firebase-functions/v2/https");
const { onObjectFinalized } = require("firebase-functions/v2/storage");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");
const { Resend } = require("resend");
const sharp = require("sharp");
const path = require("path");
const os = require("os");
const fs = require("fs");
const {
  PRICE_IDS,
  normalizePlan,
  resolvePlanPriceId,
  checkoutIdempotencyKey,
  customerIdempotencyKey,
  subscriptionGrantsAccess,
  sessionGrantsAccess,
  isComplimentaryVendor,
  stripeObjectId,
  invoiceSubscriptionId,
  uidFromStripeObject,
  customerEmailFromStripeObject,
  stripeEventClaimDecision,
  grantMembershipPatch,
  revokeMembershipPatch,
  nextCheckoutAttempt
} = require("./membership");

admin.initializeApp();
const db = admin.firestore();
const stripeSecret = defineSecret("STRIPE_SECRET_KEY");
const stripeWebhookSecret = defineSecret("STRIPE_WEBHOOK_SECRET");
const resendApiKey = defineSecret("RESEND_API_KEY");
const constantContactClientSecret = defineSecret("CONSTANT_CONTACT_CLIENT_SECRET");
const constantContactRefreshToken = defineSecret("CONSTANT_CONTACT_REFRESH_TOKEN");
const constantContactVendorListId = defineSecret("CONSTANT_CONTACT_VENDOR_LIST_ID");
const constantContactCoupleListId = defineSecret("CONSTANT_CONTACT_COUPLE_LIST_ID");
const CONSTANT_CONTACT_CLIENT_ID = "b5586c07-4edd-442e-af03-cba30ffa9f1a";
const FROM_EMAIL = "noreply@ourweddingdayhub.com";
const SITE_URL = "https://ourweddingdayhub.com";
const app = express();
app.use(cors({ origin: true }));
app.use((req, res, next) => {
  if (req.path === "/stripe-webhook") return express.raw({ type: "application/json" })(req, res, next);
  return express.json()(req, res, next);
});

exports.convertToWebP = onObjectFinalized({ memory: "512MiB", timeoutSeconds: 120 }, async (event) => {
  const filePath = event.data.name;
  const contentType = event.data.contentType;
  const bucket = admin.storage().bucket(event.data.bucket);
  if (!contentType || !contentType.startsWith("image/")) return;
  if (contentType === "image/webp") return;
  if (filePath.includes("_webp") || filePath.includes("thumb_")) return;
  const vendorFolders = ["vendor-gallery-images", "vendor-profile-images", "vendor-logos", "vendor-gallery-videos", "boutique-product-images"];
  if (!vendorFolders.some((folder) => filePath.includes(folder))) return;
  const fileName = path.basename(filePath);
  const fileDir = path.dirname(filePath);
  const webpFileName = `${path.basename(fileName, path.extname(fileName))}.webp`;
  const webpFilePath = path.join(fileDir, webpFileName);
  const tempFilePath = path.join(os.tmpdir(), fileName);
  const tempWebpPath = path.join(os.tmpdir(), webpFileName);
  try {
    await bucket.file(filePath).download({ destination: tempFilePath });
    await sharp(tempFilePath).webp({ quality: 85 }).toFile(tempWebpPath);
    await bucket.upload(tempWebpPath, { destination: webpFilePath, metadata: { contentType: "image/webp", cacheControl: "public, max-age=31536000" } });
    await bucket.file(webpFilePath).makePublic();
    await bucket.file(filePath).makePublic();
    const webpUrl = `https://storage.googleapis.com/${event.data.bucket}/${webpFilePath}`;
    const originalUrl = `https://storage.googleapis.com/${event.data.bucket}/${filePath}`;
    await updateFirestoreImageUrl(originalUrl, webpUrl, filePath);
    await bucket.file(filePath).delete();
  } catch (err) {
    console.error(`WebP conversion error for ${filePath}:`, err);
  } finally {
    if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
    if (fs.existsSync(tempWebpPath)) fs.unlinkSync(tempWebpPath);
  }
});

async function updateFirestoreImageUrl(oldUrl, newUrl, filePath) {
  try {
    const parts = filePath.split("/");
    if (parts.length < 2) return;
    const uid = parts[1];
    const vendorRef = db.collection("vendors").doc(uid);
    const vendorSnap = await vendorRef.get();
    if (!vendorSnap.exists) return;
    const vendorData = vendorSnap.data();
    const updates = {};
    if (vendorData.coverImageUrl === oldUrl) updates.coverImageUrl = newUrl;
    if (vendorData.profileImageUrl === oldUrl) updates.profileImageUrl = newUrl;
    if (vendorData.logoUrl === oldUrl) updates.logoUrl = newUrl;
    if (Array.isArray(vendorData.images)) {
      const updatedImages = vendorData.images.map((url) => (url === oldUrl ? newUrl : url));
      if (JSON.stringify(updatedImages) !== JSON.stringify(vendorData.images)) {
        updates.images = updatedImages;
        if (!updates.coverImageUrl && vendorData.images[0] === oldUrl) updates.coverImageUrl = newUrl;
      }
    }
    if (Object.keys(updates).length) await vendorRef.update(updates);
  } catch (err) {
    console.error("Firestore URL update error:", err);
  }
}

async function getConstantContactAccessToken() {
  const tokenRef = db.collection("constantContact").doc("tokens");
  const tokenSnap = await tokenRef.get();
  const tokenData = tokenSnap.exists ? tokenSnap.data() : {};
  const now = Date.now();
  if (tokenData.accessToken && tokenData.expiresAt && tokenData.expiresAt > now + 5 * 60 * 1000) return tokenData.accessToken;
  const refreshToken = tokenData.refreshToken || constantContactRefreshToken.value();
  const basicAuth = Buffer.from(`${CONSTANT_CONTACT_CLIENT_ID}:${constantContactClientSecret.value()}`).toString("base64");
  const response = await fetch("https://authz.constantcontact.com/oauth2/default/v1/token", {
    method: "POST",
    headers: { Authorization: `Basic ${basicAuth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken })
  });
  const data = await response.json();
  if (!response.ok) throw new Error("Could not refresh Constant Contact token.");
  await tokenRef.set({
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    expiresAt: now + data.expires_in * 1000,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
  return data.access_token;
}

function getStripe() { return new Stripe(stripeSecret.value()); }

async function requireFirebaseUser(req) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) {
    const err = new Error("Sign in required.");
    err.status = 401;
    throw err;
  }
  try {
    return await admin.auth().verifyIdToken(header.slice(7));
  } catch (error) {
    const err = new Error("Sign in required.");
    err.status = 401;
    throw err;
  }
}

async function findVendorUid({ uid, customerId, subscriptionId, email }) {
  if (uid) return uid;
  if (subscriptionId) {
    const snap = await db.collection("vendors").where("stripeSubscriptionId", "==", subscriptionId).limit(1).get();
    if (!snap.empty) return snap.docs[0].id;
  }
  if (customerId) {
    const snap = await db.collection("vendors").where("stripeCustomerId", "==", customerId).limit(1).get();
    if (!snap.empty) return snap.docs[0].id;
  }
  const normalisedEmail = String(email || "").trim().toLowerCase();
  if (normalisedEmail) {
    const vendorSnap = await db.collection("vendors").where("email", "==", normalisedEmail).limit(1).get();
    if (!vendorSnap.empty) return vendorSnap.docs[0].id;
    const userSnap = await db.collection("users").where("email", "==", normalisedEmail).limit(1).get();
    if (!userSnap.empty) return userSnap.docs[0].id;
  }
  return "";
}

async function findLiveSubscription(stripe, { customerId, email }) {
  const customerIds = [];
  if (customerId) customerIds.push(customerId);
  const normalisedEmail = String(email || "").trim().toLowerCase();
  if (normalisedEmail) {
    const existingCustomers = await stripe.customers.list({ email: normalisedEmail, limit: 5 });
    for (const customer of existingCustomers.data) {
      if (!customerIds.includes(customer.id)) customerIds.push(customer.id);
    }
  }
  for (const id of customerIds) {
    const subs = await stripe.subscriptions.list({ customer: id, status: "all", limit: 10 });
    const liveSub = subs.data.find((sub) => subscriptionGrantsAccess(sub.status));
    if (liveSub) return liveSub;
  }
  return null;
}

async function applyGrantFromSession(session, fallbackUid) {
  const uid = await findVendorUid({
    uid: uidFromStripeObject(session) || fallbackUid || "",
    customerId: stripeObjectId(session.customer),
    subscriptionId: stripeObjectId(session.subscription),
    email: customerEmailFromStripeObject(session)
  });
  if (!uid) throw new Error("Checkout session is missing vendor id.");
  let subscriptionStatus = "active";
  const subscriptionId = stripeObjectId(session.subscription);
  if (subscriptionId) {
    try {
      const sub = await getStripe().subscriptions.retrieve(subscriptionId);
      subscriptionStatus = sub.status;
    } catch (error) {
      console.warn("Subscription retrieve failed:", error.message);
    }
  }
  const patch = grantMembershipPatch({
    customerId: stripeObjectId(session.customer),
    subscriptionId,
    sessionId: session.id,
    plan: session.metadata && session.metadata.plan,
    subscriptionStatus
  });
  patch.paidAt = admin.firestore.FieldValue.serverTimestamp();
  patch.updatedAt = admin.firestore.FieldValue.serverTimestamp();
  await db.collection("vendors").doc(uid).set(patch, { merge: true });
  return { uid, access: subscriptionGrantsAccess(subscriptionStatus) || sessionGrantsAccess(session) };
}

async function applySubscriptionUpdate(subscription, fallbackUid) {
  let email = customerEmailFromStripeObject(subscription);
  if (!email && subscription.customer) {
    try {
      const customerId = stripeObjectId(subscription.customer);
      if (customerId) {
        const customer = await getStripe().customers.retrieve(customerId);
        email = customerEmailFromStripeObject(customer);
      }
    } catch (error) {
      console.warn("Customer retrieve for subscription failed:", error.message);
    }
  }
  const uid = await findVendorUid({
    uid: uidFromStripeObject(subscription) || fallbackUid || "",
    customerId: stripeObjectId(subscription.customer),
    subscriptionId: subscription.id,
    email
  });
  if (!uid) return;
  const vendorRef = db.collection("vendors").doc(uid);
  const vendorSnap = await vendorRef.get();
  const vendor = vendorSnap.exists ? vendorSnap.data() : {};
  if (isComplimentaryVendor(vendor)) return;
  const status = subscription.status;
  const patch = subscriptionGrantsAccess(status)
    ? grantMembershipPatch({ customerId: stripeObjectId(subscription.customer), subscriptionId: subscription.id, plan: subscription.metadata && subscription.metadata.plan, subscriptionStatus: status })
    : revokeMembershipPatch(status);
  patch.updatedAt = admin.firestore.FieldValue.serverTimestamp();
  await vendorRef.set(patch, { merge: true });
}

app.post("/create-checkout-session", async (req, res) => {
  try {
    const decoded = await requireFirebaseUser(req);
    const uid = decoded.uid;
    const plan = normalizePlan(req.body && req.body.plan);
    const planPriceId = resolvePlanPriceId(plan);
    if (!planPriceId) return res.status(400).json({ error: "Invalid plan selected." });
    const vendorRef = db.collection("vendors").doc(uid);
    const vendorSnap = await vendorRef.get();
    const vendor = vendorSnap.exists ? vendorSnap.data() : {};
    if (isComplimentaryVendor(vendor)) return res.status(409).json({ error: "Membership already active.", alreadyPaid: true });
    const stripe = getStripe();
    let existingSession = null;
    const email = decoded.email || vendor.email || "";
    const liveSub = await findLiveSubscription(stripe, { customerId: vendor.stripeCustomerId || "", email });
    if (liveSub) {
      await applySubscriptionUpdate(liveSub, uid);
      return res.status(409).json({ error: "Membership already active.", alreadyPaid: true });
    }
    if (vendor.stripeCheckoutSessionId) {
      try {
        existingSession = await stripe.checkout.sessions.retrieve(vendor.stripeCheckoutSessionId);
        if (existingSession.status === "open" && existingSession.url) return res.json({ url: existingSession.url, reused: true });
        if (sessionGrantsAccess(existingSession)) {
          await applyGrantFromSession(existingSession, uid);
          return res.status(409).json({ error: "Membership already active.", alreadyPaid: true });
        }
      } catch (retrieveError) {
        console.warn("Existing checkout retrieve failed:", retrieveError.message);
        existingSession = null;
      }
    }
    let customerId = vendor.stripeCustomerId || "";
    if (!customerId && email) {
      const existingCustomers = await stripe.customers.list({ email, limit: 1 });
      if (existingCustomers.data[0]) customerId = existingCustomers.data[0].id;
    }
    if (!customerId) {
      const customer = await stripe.customers.create({ email: email || undefined, metadata: { firebaseUid: uid } }, { idempotencyKey: customerIdempotencyKey(uid) });
      customerId = customer.id;
    }
    const attempt = nextCheckoutAttempt(vendor, existingSession);
    const idempotencyKey = checkoutIdempotencyKey(uid, plan, attempt);
    let session;
    try {
      session = await stripe.checkout.sessions.create({
        mode: "subscription",
        customer: customerId,
        client_reference_id: uid,
        line_items: [{ price: PRICE_IDS.setup, quantity: 1 }, { price: planPriceId, quantity: 1 }],
        success_url: `${SITE_URL}/payment-success.html?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${SITE_URL}/payment-required.html`,
        allow_promotion_codes: true,
        metadata: { firebaseUid: uid, plan },
        subscription_data: { metadata: { firebaseUid: uid, plan } }
      }, { idempotencyKey });
    } catch (createError) {
      if (createError && createError.code === "idempotency_error" && vendor.stripeCheckoutSessionId) {
        session = await stripe.checkout.sessions.retrieve(vendor.stripeCheckoutSessionId);
      } else throw createError;
    }
    await vendorRef.set({
      membershipTier: plan,
      paymentStatus: "pending",
      stripeCustomerId: customerId,
      stripeCheckoutSessionId: session.id,
      stripeCheckoutAttempt: attempt,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    res.json({ url: session.url });
  } catch (error) {
    if (error.status === 401) return res.status(401).json({ error: "Sign in required." });
    console.error("Stripe session error:", error);
    res.status(500).json({ error: "Payment is not available right now. Please try again." });
  }
});

app.post("/confirm-checkout", async (req, res) => {
  try {
    const decoded = await requireFirebaseUser(req);
    const sessionId = req.body && req.body.sessionId;
    if (!sessionId || typeof sessionId !== "string" || !sessionId.startsWith("cs_")) return res.status(400).json({ error: "Missing checkout session." });
    const session = await getStripe().checkout.sessions.retrieve(sessionId);
    const sessionUid = uidFromStripeObject(session);
    if (sessionUid && sessionUid !== decoded.uid) return res.status(403).json({ error: "This payment does not belong to your account." });
    if (!sessionGrantsAccess(session) && session.payment_status !== "paid") {
      return res.json({ access: false, status: session.status, payment_status: session.payment_status });
    }
    const result = await applyGrantFromSession(session, decoded.uid);
    res.json({ access: result.access, source: "checkout_session" });
  } catch (error) {
    if (error.status === 401) return res.status(401).json({ error: "Sign in required." });
    console.error("confirm-checkout error:", error);
    res.status(500).json({ error: "Unable to confirm payment." });
  }
});

app.post("/verify-membership", async (req, res) => {
  try {
    const decoded = await requireFirebaseUser(req);
    const vendorRef = db.collection("vendors").doc(decoded.uid);
    const vendorSnap = await vendorRef.get();
    const vendor = vendorSnap.exists ? vendorSnap.data() : {};
    if (isComplimentaryVendor(vendor)) return res.json({ access: true, source: "complimentary", status: vendor.stripeSubscriptionStatus || "complimentary" });
    const stripe = getStripe();
    const email = decoded.email || vendor.email || "";
    if (vendor.stripeSubscriptionId) {
      try {
        const subscription = await stripe.subscriptions.retrieve(vendor.stripeSubscriptionId);
        await applySubscriptionUpdate(subscription, decoded.uid);
        if (subscriptionGrantsAccess(subscription.status)) return res.json({ access: true, source: "subscription", status: subscription.status });
      } catch (retrieveError) {
        console.warn("Stored subscription retrieve failed:", retrieveError.message);
      }
    }
    const liveSub = await findLiveSubscription(stripe, { customerId: vendor.stripeCustomerId || "", email });
    if (liveSub) {
      await applySubscriptionUpdate(liveSub, decoded.uid);
      return res.json({ access: subscriptionGrantsAccess(liveSub.status), source: "subscription", status: liveSub.status });
    }
    if (vendor.stripeCheckoutSessionId) {
      const session = await stripe.checkout.sessions.retrieve(vendor.stripeCheckoutSessionId);
      if (sessionGrantsAccess(session) || session.payment_status === "paid") {
        const result = await applyGrantFromSession(session, decoded.uid);
        return res.json({ access: result.access, source: "checkout_session", status: session.status });
      }
      return res.json({ access: false, source: "checkout_session", status: session.status });
    }
    res.json({ access: false, source: "none", status: vendor.stripeSubscriptionStatus || vendor.paymentStatus || "unpaid" });
  } catch (error) {
    if (error.status === 401) return res.status(401).json({ error: "Sign in required." });
    console.error("verify-membership error:", error);
    try {
      const decoded = await requireFirebaseUser(req);
      const vendorSnap = await db.collection("vendors").doc(decoded.uid).get();
      const vendor = vendorSnap.exists ? vendorSnap.data() : {};
      const access = isComplimentaryVendor(vendor) || subscriptionGrantsAccess(vendor.stripeSubscriptionStatus);
      return res.json({ access, source: "cached", status: vendor.stripeSubscriptionStatus || "unknown" });
    } catch (fallbackError) {
      res.status(500).json({ error: "Unable to verify membership." });
    }
  }
});

app.post("/add-to-constant-contact", async (req, res) => {
  try {
    const { email, name, type } = req.body;
    if (!email || !type) return res.status(400).json({ error: "Missing email or account type." });
    let listId;
    if (type === "vendor") listId = constantContactVendorListId.value();
    else if (type === "couple") listId = constantContactCoupleListId.value();
    else return res.status(400).json({ error: "Invalid account type." });
    const accessToken = await getConstantContactAccessToken();
    const response = await fetch("https://api.cc.email/v3/contacts/sign_up_form", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ email_address: { address: email, permission_to_send: "implicit" }, first_name: name || "", list_memberships: [listId] })
    });
    const data = await response.json();
    if (!response.ok) return res.status(400).json({ error: "Unable to add contact to Constant Contact.", details: data });
    res.json({ success: true, data });
  } catch (error) {
    console.error("Constant Contact function error:", error);
    res.status(500).json({ error: "Unable to add contact to Constant Contact." });
  }
});

app.post("/send-message-notification", async (req, res) => {
  try {
    const { conversationId, senderName, recipientEmail, recipientName, messageBody, recipientType } = req.body;
    if (!conversationId || !recipientEmail || !messageBody) return res.status(400).json({ error: "Missing required fields." });
    const convSnap = await db.collection("conversations").doc(conversationId).get();
    if (!convSnap.exists) return res.status(404).json({ error: "Conversation not found." });
    const conv = convSnap.data();
    const unreadCount = recipientType === "vendor" ? (conv.vendorUnread || 0) : (conv.coupleUnread || 0);
    if (unreadCount > 1) return res.json({ success: true, skipped: true });
    const dashboardLink = recipientType === "vendor" ? `${SITE_URL}/dashboard.html` : `${SITE_URL}/couple-dashboard.html`;
    const previewText = messageBody.length > 120 ? messageBody.slice(0, 120) + "..." : messageBody;
    const resend = new Resend(resendApiKey.value());
    await resend.emails.send({
      from: `Our Wedding Day Hub <${FROM_EMAIL}>`,
      to: recipientEmail,
      subject: `New message from ${senderName} on Our Wedding Day Hub`,
      html: `<p>Hi ${recipientName || "there"},</p><p>${senderName} sent you a message:</p><p>"${previewText}"</p><p><a href="${dashboardLink}">View Message</a></p>`
    });
    res.json({ success: true });
  } catch (error) {
    console.error("Message notification error:", error);
    res.status(500).json({ error: "Unable to send message notification." });
  }
});

app.post("/send-enquiry-notification", async (req, res) => {
  try {
    const { vendorEmail, vendorName, coupleName, coupleEmail, preferredDate, message } = req.body;
    if (!vendorEmail || !coupleName || !message) return res.status(400).json({ error: "Missing required fields." });
    const resend = new Resend(resendApiKey.value());
    await resend.emails.send({
      from: `Our Wedding Day Hub <${FROM_EMAIL}>`,
      to: vendorEmail,
      subject: `New booking enquiry from ${coupleName} on Our Wedding Day Hub`,
      html: `<p>Hi ${vendorName || "there"},</p><p>${coupleName} sent a booking enquiry${preferredDate ? ` for ${preferredDate}` : ""}.</p><p>"${message}"</p><p>Reply to <a href="mailto:${coupleEmail}">${coupleEmail}</a> or <a href="${SITE_URL}/dashboard.html">open your dashboard</a>.</p>`
    });
    res.json({ success: true });
  } catch (error) {
    console.error("Enquiry notification error:", error);
    res.status(500).json({ error: "Unable to send enquiry notification." });
  }
});

async function beginStripeEvent(event) {
  const ref = db.collection("stripeEvents").doc(event.id);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const existing = snap.exists ? snap.data() : null;
    const decision = stripeEventClaimDecision(existing);
    if (decision !== "claim") return decision;
    tx.set(ref, { status: "processing", type: event.type, startedAtMs: Date.now(), startedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    return "claimed";
  });
}
async function markStripeEventProcessed(event) {
  await db.collection("stripeEvents").doc(event.id).set({ status: "processed", type: event.type, processedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
}
async function markStripeEventFailed(event) {
  await db.collection("stripeEvents").doc(event.id).set({ status: "failed", type: event.type, failedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
}
async function handleStripeEvent(event) {
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      const session = event.data.object;
      if (session.mode && session.mode !== "subscription") return;
      if (!sessionGrantsAccess(session) && session.payment_status !== "paid") return;
      await applyGrantFromSession(session, uidFromStripeObject(session));
      return;
    }
    case "invoice.paid": {
      const invoice = event.data.object;
      const subscriptionId = invoiceSubscriptionId(invoice);
      if (!subscriptionId) return;
      const subscription = await getStripe().subscriptions.retrieve(subscriptionId);
      await applySubscriptionUpdate(subscription);
      return;
    }
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      await applySubscriptionUpdate(event.data.object);
      return;
    default:
      return;
  }
}
function constructStripeEvent(req) {
  const signature = req.headers["stripe-signature"];
  const rawBody = req.rawBody || req.body;
  if (!signature) throw new Error("Missing Stripe signature.");
  return getStripe().webhooks.constructEvent(rawBody, signature, stripeWebhookSecret.value());
}
async function processStripeWebhook(req, res) {
  if (req.method !== "POST") {
    res.status(405).send("Method Not Allowed");
    return;
  }
  let event;
  try {
    event = constructStripeEvent(req);
  } catch (error) {
    console.error("Stripe webhook signature failed:", error.message);
    res.status(400).send(`Webhook Error: ${error.message}`);
    return;
  }
  try {
    const claim = await beginStripeEvent(event);
    if (claim === "duplicate") {
      res.json({ received: true, duplicate: true });
      return;
    }
    if (claim === "in_progress") {
      res.status(500).json({ error: "Webhook already processing." });
      return;
    }
    await handleStripeEvent(event);
    await markStripeEventProcessed(event);
    res.json({ received: true });
  } catch (error) {
    console.error("Stripe webhook handler failed:", error);
    try { await markStripeEventFailed(event); } catch (markError) { console.error("Failed to mark Stripe event as failed:", markError); }
    res.status(500).json({ error: "Webhook handler failed." });
  }
}

app.post("/stripe-webhook", (req, res) => processStripeWebhook(req, res));

exports.api = onRequest({
  secrets: [stripeSecret, stripeWebhookSecret, resendApiKey, constantContactClientSecret, constantContactRefreshToken, constantContactVendorListId, constantContactCoupleListId]
}, app);

exports.stripeWebhook = onRequest({
  secrets: [stripeSecret, stripeWebhookSecret]
}, (req, res) => processStripeWebhook(req, res));
