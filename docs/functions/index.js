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

admin.initializeApp();

const db = admin.firestore();

const stripeSecret = defineSecret("STRIPE_SECRET_KEY");
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
app.use(express.json());

const PRICE_IDS = {
  setup: "price_1TGpBgIfhRO5Mn4BGzLRUsB9",
  classic: "price_1TGo2OIfhRO5Mn4BUEpXk9p8",
  signature: "price_1TGp0cIfhRO5Mn4BUIferLow",
  elite: "price_1TGp1ZIfhRO5Mn4BqfzdgLud",
  platinum: "price_1TGp2pIfhRO5Mn4B3lrSq0Dj"
};

// ── WEBP IMAGE CONVERSION ──
// Automatically converts uploaded images to WebP when vendors upload photos
exports.convertToWebP = onObjectFinalized(
  { memory: "512MiB", timeoutSeconds: 120 },
  async (event) => {
    const filePath = event.data.name;
    const contentType = event.data.contentType;
    const bucket = admin.storage().bucket(event.data.bucket);

    // Only process images
    if (!contentType || !contentType.startsWith("image/")) return;

    // Skip if already a WebP
    if (contentType === "image/webp") return;

    // Skip if it's a thumbnail or already processed
    if (filePath.includes("_webp") || filePath.includes("thumb_")) return;

    // Only process vendor images
    const vendorFolders = [
      "vendor-gallery-images",
      "vendor-profile-images",
      "vendor-logos",
      "vendor-gallery-videos",
      "boutique-product-images"
    ];
    const isVendorImage = vendorFolders.some(folder => filePath.includes(folder));
    if (!isVendorImage) return;

    console.log(`Converting to WebP: ${filePath}`);

    const fileName = path.basename(filePath);
    const fileDir = path.dirname(filePath);
    const fileNameWithoutExt = path.basename(fileName, path.extname(fileName));
    const webpFileName = `${fileNameWithoutExt}.webp`;
    const webpFilePath = path.join(fileDir, webpFileName);
    const tempFilePath = path.join(os.tmpdir(), fileName);
    const tempWebpPath = path.join(os.tmpdir(), webpFileName);

    try {
      // Download the original file
      await bucket.file(filePath).download({ destination: tempFilePath });

      // Convert to WebP at quality 85
      await sharp(tempFilePath)
        .webp({ quality: 85 })
        .toFile(tempWebpPath);

      // Upload the WebP version to the same folder
      await bucket.upload(tempWebpPath, {
        destination: webpFilePath,
        metadata: {
          contentType: "image/webp",
          cacheControl: "public, max-age=31536000"
        }
      });

      // Get the public download URL of the new WebP file
      const webpFile = bucket.file(webpFilePath);
      await webpFile.makePublic();
      const webpUrl = `https://storage.googleapis.com/${event.data.bucket}/${webpFilePath}`;

      // Update Firestore — find the vendor doc that has this original URL and swap it
      const originalFile = bucket.file(filePath);
      await originalFile.makePublic();
      const originalUrl = `https://storage.googleapis.com/${event.data.bucket}/${filePath}`;

      await updateFirestoreImageUrl(originalUrl, webpUrl, filePath);

      // Delete the original non-WebP file to save storage
      await bucket.file(filePath).delete();

      console.log(`Successfully converted ${filePath} → ${webpFilePath}`);
    } catch (err) {
      console.error(`WebP conversion error for ${filePath}:`, err);
    } finally {
      // Clean up temp files
      if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
      if (fs.existsSync(tempWebpPath)) fs.unlinkSync(tempWebpPath);
    }
  }
);

// Finds the vendor in Firestore that has the old image URL and replaces it with the WebP URL
async function updateFirestoreImageUrl(oldUrl, newUrl, filePath) {
  try {
    // Work out which vendor this belongs to from the file path
    // Path format: vendor-gallery-images/{uid}/timestamp-filename.jpg
    const parts = filePath.split("/");
    if (parts.length < 2) return;
    const uid = parts[1];

    const vendorRef = db.collection("vendors").doc(uid);
    const vendorSnap = await vendorRef.get();
    if (!vendorSnap.exists) return;

    const vendorData = vendorSnap.data();
    const updates = {};

    // Check coverImageUrl
    if (vendorData.coverImageUrl === oldUrl) {
      updates.coverImageUrl = newUrl;
    }

    // Check profileImageUrl
    if (vendorData.profileImageUrl === oldUrl) {
      updates.profileImageUrl = newUrl;
    }

    // Check logoUrl
    if (vendorData.logoUrl === oldUrl) {
      updates.logoUrl = newUrl;
    }

    // Check images array
    if (Array.isArray(vendorData.images)) {
      const updatedImages = vendorData.images.map(url => url === oldUrl ? newUrl : url);
      if (JSON.stringify(updatedImages) !== JSON.stringify(vendorData.images)) {
        updates.images = updatedImages;
        // Also update coverImageUrl if it was the first image
        if (!updates.coverImageUrl && vendorData.images[0] === oldUrl) {
          updates.coverImageUrl = newUrl;
        }
      }
    }

    if (Object.keys(updates).length > 0) {
      await vendorRef.update(updates);
      console.log(`Updated Firestore for vendor ${uid}:`, updates);
    }

    // Also check boutique products
    const productsSnap = await db.collection("boutiqueProducts")
      .where("vendorId", "==", uid)
      .get();

    for (const productDoc of productsSnap.docs) {
      const product = productDoc.data();
      if (Array.isArray(product.images)) {
        const updatedImages = product.images.map(url => url === oldUrl ? newUrl : url);
        if (JSON.stringify(updatedImages) !== JSON.stringify(product.images)) {
          await productDoc.ref.update({ images: updatedImages });
          console.log(`Updated boutique product ${productDoc.id}`);
        }
      }
    }
  } catch (err) {
    console.error("Firestore URL update error:", err);
  }
}

async function getConstantContactAccessToken() {
  const tokenRef = db.collection("constantContact").doc("tokens");
  const tokenSnap = await tokenRef.get();
  const tokenData = tokenSnap.exists ? tokenSnap.data() : {};

  const now = Date.now();

  if (
    tokenData.accessToken &&
    tokenData.expiresAt &&
    tokenData.expiresAt > now + 5 * 60 * 1000
  ) {
    return tokenData.accessToken;
  }

  const refreshToken =
    tokenData.refreshToken || constantContactRefreshToken.value();

  const basicAuth = Buffer.from(
    `${CONSTANT_CONTACT_CLIENT_ID}:${constantContactClientSecret.value()}`
  ).toString("base64");

  const response = await fetch(
    "https://authz.constantcontact.com/oauth2/default/v1/token",
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${basicAuth}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken
      })
    }
  );

  const data = await response.json();

  if (!response.ok) {
    console.error("Constant Contact token refresh error:", data);
    throw new Error("Could not refresh Constant Contact token.");
  }

  await tokenRef.set(
    {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshToken,
      expiresAt: now + data.expires_in * 1000,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    },
    { merge: true }
  );

  return data.access_token;
}

app.post("/create-checkout-session", async (req, res) => {
  try {
    const { plan } = req.body;

    if (!plan || !PRICE_IDS[plan]) {
      return res.status(400).json({ error: "Invalid plan selected." });
    }

    const stripe = new Stripe(stripeSecret.value());

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [
        { price: PRICE_IDS.setup, quantity: 1 },
        { price: PRICE_IDS[plan], quantity: 1 }
      ],
      success_url:
        "https://ourweddingdayhub.com/payment-success.html?paid=true&session_id={CHECKOUT_SESSION_ID}",
      cancel_url: "https://ourweddingdayhub.com/signup.html",
      allow_promotion_codes: true
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error("Stripe session error:", error);
    res.status(500).json({ error: "Unable to create checkout session." });
  }
});

app.post("/add-to-constant-contact", async (req, res) => {
  try {
    const { email, name, type } = req.body;

    if (!email || !type) {
      return res.status(400).json({ error: "Missing email or account type." });
    }

    let listId;
    if (type === "vendor") {
      listId = constantContactVendorListId.value();
    } else if (type === "couple") {
      listId = constantContactCoupleListId.value();
    } else {
      return res.status(400).json({ error: "Invalid account type." });
    }

    const accessToken = await getConstantContactAccessToken();

    const response = await fetch(
      "https://api.cc.email/v3/contacts/sign_up_form",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          email_address: {
            address: email,
            permission_to_send: "implicit"
          },
          first_name: name || "",
          list_memberships: [listId]
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error("Constant Contact error:", data);
      return res.status(400).json({
        error: "Unable to add contact to Constant Contact.",
        details: data
      });
    }

    res.json({ success: true, data });
  } catch (error) {
    console.error("Constant Contact function error:", error);
    res.status(500).json({ error: "Unable to add contact to Constant Contact." });
  }
});

// ── MESSAGE NOTIFICATION ──
app.post("/send-message-notification", async (req, res) => {
  try {
    const {
      conversationId,
      senderName,
      recipientEmail,
      recipientName,
      messageBody,
      recipientType
    } = req.body;

    if (!conversationId || !recipientEmail || !messageBody) {
      return res.status(400).json({ error: "Missing required fields." });
    }

    const convSnap = await db.collection("conversations").doc(conversationId).get();
    if (!convSnap.exists) {
      return res.status(404).json({ error: "Conversation not found." });
    }

    const conv = convSnap.data();
    const unreadCount = recipientType === "vendor"
      ? (conv.vendorUnread || 0)
      : (conv.coupleUnread || 0);

    if (unreadCount > 1) {
      return res.json({ success: true, skipped: true, reason: "Already has unread messages." });
    }

    const resend = new Resend(resendApiKey.value());

    const dashboardLink = recipientType === "vendor"
      ? `${SITE_URL}/dashboard.html`
      : `${SITE_URL}/couple-dashboard.html`;

    const previewText = messageBody.length > 120
      ? messageBody.slice(0, 120) + "..."
      : messageBody;

    await resend.emails.send({
      from: `Our Wedding Day Hub <${FROM_EMAIL}>`,
      to: recipientEmail,
      subject: `New message from ${senderName} on Our Wedding Day Hub`,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
        </head>
        <body style="margin:0; padding:0; background:#f7f1ed; font-family: Georgia, serif;">
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#f7f1ed; padding: 40px 20px;">
            <tr>
              <td align="center">
                <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
                  <tr>
                    <td align="center" style="padding-bottom: 28px;">
                      <img src="${SITE_URL}/images/logo.png" alt="Our Wedding Day Hub" width="90" style="display:block;">
                    </td>
                  </tr>
                  <tr>
                    <td style="background:#fffaf7; border-radius:24px; border:1px solid rgba(223,210,200,0.9); padding:40px 36px;">
                      <p style="margin:0 0 8px; font-size:12px; letter-spacing:0.2em; text-transform:uppercase; color:#b08d7d;">New Message</p>
                      <h1 style="margin:0 0 16px; font-family:'Georgia',serif; font-size:28px; font-weight:400; color:#3b2f2a; line-height:1.1;">
                        ${senderName} sent you a message
                      </h1>
                      <p style="margin:0 0 24px; color:#9b8579; line-height:1.75; font-size:15px;">
                        Hi ${recipientName || "there"}, you have a new message waiting for you on Our Wedding Day Hub.
                      </p>
                      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
                        <tr>
                          <td style="background:#f4e7df; border-radius:16px; padding:20px 22px; border-left:3px solid #a97c66;">
                            <p style="margin:0; color:#5b4a43; font-style:italic; line-height:1.75; font-size:15px;">
                              "${previewText}"
                            </p>
                            <p style="margin:8px 0 0; font-size:12px; color:#b08d7d;">— ${senderName}</p>
                          </td>
                        </tr>
                      </table>
                      <table width="100%" cellpadding="0" cellspacing="0">
                        <tr>
                          <td align="center">
                            <a href="${dashboardLink}" style="display:inline-block; background:linear-gradient(135deg,#d6b19a,#a97c66); color:#fffaf7; text-decoration:none; padding:14px 32px; border-radius:999px; font-size:15px; font-weight:bold; letter-spacing:0.04em;">
                              View Message
                            </a>
                          </td>
                        </tr>
                      </table>
                      <p style="margin:28px 0 0; color:#b08d7d; font-size:13px; text-align:center; line-height:1.7;">
                        You're receiving this because someone messaged you on<br>
                        <a href="${SITE_URL}" style="color:#a97c66;">ourweddingdayhub.com</a>
                      </p>
                    </td>
                  </tr>
                  <tr>
                    <td align="center" style="padding-top:24px;">
                      <p style="margin:0; color:#b08d7d; font-size:12px; line-height:1.7;">
                        Our Wedding Day Hub • ABN 76 688 637 041 • Australia<br>
                        Proudly inclusive • Worldwide • Built with heart
                      </p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </body>
        </html>
      `
    });

    res.json({ success: true });
  } catch (error) {
    console.error("Message notification error:", error);
    res.status(500).json({ error: "Unable to send message notification." });
  }
});

// ── ENQUIRY NOTIFICATION ──
app.post("/send-enquiry-notification", async (req, res) => {
  try {
    const {
      vendorEmail,
      vendorName,
      coupleName,
      coupleEmail,
      preferredDate,
      message
    } = req.body;

    if (!vendorEmail || !coupleName || !message) {
      return res.status(400).json({ error: "Missing required fields." });
    }

    const resend = new Resend(resendApiKey.value());

    await resend.emails.send({
      from: `Our Wedding Day Hub <${FROM_EMAIL}>`,
      to: vendorEmail,
      subject: `New booking enquiry from ${coupleName} on Our Wedding Day Hub`,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
        </head>
        <body style="margin:0; padding:0; background:#f7f1ed; font-family: Georgia, serif;">
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#f7f1ed; padding: 40px 20px;">
            <tr>
              <td align="center">
                <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
                  <tr>
                    <td align="center" style="padding-bottom: 28px;">
                      <img src="${SITE_URL}/images/logo.png" alt="Our Wedding Day Hub" width="90" style="display:block;">
                    </td>
                  </tr>
                  <tr>
                    <td style="background:#fffaf7; border-radius:24px; border:1px solid rgba(223,210,200,0.9); padding:40px 36px;">
                      <p style="margin:0 0 8px; font-size:12px; letter-spacing:0.2em; text-transform:uppercase; color:#b08d7d;">New Enquiry</p>
                      <h1 style="margin:0 0 16px; font-family:'Georgia',serif; font-size:28px; font-weight:400; color:#3b2f2a; line-height:1.1;">
                        ${coupleName} sent you a booking enquiry
                      </h1>
                      <p style="margin:0 0 24px; color:#9b8579; line-height:1.75; font-size:15px;">
                        Hi ${vendorName || "there"}, you have a new booking enquiry on Our Wedding Day Hub.
                      </p>
                      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
                        <tr>
                          <td style="background:#f4e7df; border-radius:16px; padding:20px 22px; border-left:3px solid #a97c66;">
                            ${preferredDate ? `<p style="margin:0 0 10px; font-size:13px; font-weight:bold; color:#6f5143; letter-spacing:0.06em; text-transform:uppercase;">Preferred Date</p>
                            <p style="margin:0 0 16px; color:#3b2f2a; font-size:15px;">${preferredDate}</p>` : ""}
                            <p style="margin:0 0 10px; font-size:13px; font-weight:bold; color:#6f5143; letter-spacing:0.06em; text-transform:uppercase;">Message</p>
                            <p style="margin:0; color:#5b4a43; font-style:italic; line-height:1.75; font-size:15px;">"${message}"</p>
                          </td>
                        </tr>
                      </table>
                      <p style="margin:0 0 24px; color:#9b8579; font-size:14px; line-height:1.7;">
                        Reply directly to <a href="mailto:${coupleEmail}" style="color:#a97c66;">${coupleEmail}</a> or view the enquiry in your dashboard.
                      </p>
                      <table width="100%" cellpadding="0" cellspacing="0">
                        <tr>
                          <td align="center">
                            <a href="${SITE_URL}/dashboard.html" style="display:inline-block; background:linear-gradient(135deg,#d6b19a,#a97c66); color:#fffaf7; text-decoration:none; padding:14px 32px; border-radius:999px; font-size:15px; font-weight:bold; letter-spacing:0.04em;">
                              View in Dashboard
                            </a>
                          </td>
                        </tr>
                      </table>
                      <p style="margin:28px 0 0; color:#b08d7d; font-size:13px; text-align:center; line-height:1.7;">
                        You're receiving this because someone enquired through your profile on<br>
                        <a href="${SITE_URL}" style="color:#a97c66;">ourweddingdayhub.com</a>
                      </p>
                    </td>
                  </tr>
                  <tr>
                    <td align="center" style="padding-top:24px;">
                      <p style="margin:0; color:#b08d7d; font-size:12px; line-height:1.7;">
                        Our Wedding Day Hub • ABN 76 688 637 041 • Australia<br>
                        Proudly inclusive • Worldwide • Built with heart
                      </p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </body>
        </html>
      `
    });

    res.json({ success: true });
  } catch (error) {
    console.error("Enquiry notification error:", error);
    res.status(500).json({ error: "Unable to send enquiry notification." });
  }
});

exports.api = onRequest(
  {
    secrets: [
      stripeSecret,
      resendApiKey,
      constantContactClientSecret,
      constantContactRefreshToken,
      constantContactVendorListId,
      constantContactCoupleListId
    ]
  },
  app
);
