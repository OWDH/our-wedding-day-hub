"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const membership = require("./membership");

// Execute the real route handlers with Stripe/Firestore boundaries stubbed.
function loadApi({ vendor = {}, userRole = "vendor", stripeError = false, stripeOverrides = {}, resendResult = { data: { id: "email_test" } }, onWrite = () => {}, authOverrides = {}, firestoreOverride, inviteSecret = "stub" } = {}) {
  const routes = {};
  const app = { use() {}, post(name, handler) { routes[name] = handler; }, get(name, handler) { routes[name] = handler; } };
  const doc = { get: async () => ({ exists: true, data: () => vendor }), set: async (value) => { onWrite(value); } };
  const userDoc = { get: async () => ({ exists: true, data: () => ({ role: userRole }) }) };
  const db = firestoreOverride || { collection: name => ({ doc: () => name === "users" ? userDoc : doc }) };
  const admin = { initializeApp() {}, firestore: () => db, auth: () => ({ verifyIdToken: async () => ({ uid: "mandi", email: "m@example.test" }), getUser: async () => ({ uid: "mandi", email: "m@example.test", customClaims: vendor._serverClaims || {} }), ...authOverrides }) };
  admin.firestore.FieldValue = { serverTimestamp: () => "timestamp" };
  function Stripe() {
    return { customers: { list: async function* () { if (stripeError) throw new Error("Stripe unavailable"); } },
      prices: { retrieve: async id => id === membership.PRICE_IDS.setup
        ? { active: true, currency: "aud", unit_amount: 5000 }
        : { active: true, currency: "aud", unit_amount: 1725, recurring: { interval: "month", interval_count: 1 } } }, ...stripeOverrides };
  }
  const modules = {
    "firebase-functions/v2/https": { onRequest: (_opts, fn) => fn },
    "firebase-functions/v2/storage": { onObjectFinalized: () => {} },
    "firebase-functions/params": { defineSecret: name => ({ value: () => name === "FOUNDING_INVITE_SIGNING_KEY" ? inviteSecret : "stub" }) },
    "firebase-admin": admin, express: Object.assign(() => app, { json: () => {}, raw: () => {} }),
    "./founding-invites": require("./founding-invites"), cors: () => {}, stripe: Stripe, resend: { Resend: function() { this.emails = { send: async () => resendResult }; } }, sharp: () => {}, "./membership": membership
  };
  const exposed = {};
  vm.runInNewContext(fs.readFileSync(__dirname + "/index.js", "utf8") + "\nexports.testHandleStripeEvent = handleStripeEvent;", {
    require: name => Object.hasOwn(modules, name) ? modules[name] : require(name),
    exports: exposed, console: { error() {}, warn() {} }
  });
  return { ...routes, testHandleStripeEvent: exposed.testHandleStripeEvent };
}
async function invoke(handler, authenticated = true, body = {}) {
  const response = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  await handler({ headers: authenticated ? { authorization: "Bearer test" } : {}, body }, response);
  return response;
}

test("API authentication checks revocation and rejects disabled or revoked sessions", async () => {
  let checkRevoked;
  const routes = loadApi({ authOverrides: { verifyIdToken: async (_token, revoked) => {
    checkRevoked = revoked;
    throw new Error("auth/user-disabled");
  } } });
  const result = await invoke(routes["/redeem-founding-invite"]);
  assert.equal(checkRevoked, true);
  assert.equal(result.code, 401);
});

function inviteFixture({ emailVerified = true, record = {}, vendor = {}, claimFailure = false } = {}) {
  const { createInviteToken } = require("./founding-invites");
  const token = createInviteToken();
  const invite = { active: true, email: "m@example.test", expiresAt: { toMillis: () => Date.now() + 60000 }, ...record };
  let claims = { unrelatedClaim: "preserved" }, writes = 0, failClaim = claimFailure;
  const refs = {};
  for (const name of ["users", "vendors", "foundingVendorInvites"]) {
    refs[name] = { get: async () => ({ exists: true, data: () => name === "users" ? { role: "vendor" } : name === "vendors" ? vendor : invite }), set: async () => {} };
  }
  // Serialize transactions to model Firestore's retry/commit isolation.
  let queue = Promise.resolve();
  const db = { collection: name => ({ doc: () => refs[name] }), runTransaction(fn) {
    const result = queue.then(() => fn({ get: ref => ref.get(), update(_ref, value) { writes++; Object.assign(invite, value); } }));
    queue = result.catch(() => {});
    return result;
  } };
  const routes = loadApi({ firestoreOverride: db, inviteSecret: "a".repeat(43), authOverrides: {
    getUser: async () => ({ email: "m@example.test", emailVerified, customClaims: claims }),
    setCustomUserClaims: async (_uid, value) => { if (failClaim) { failClaim = false; throw new Error("Auth unavailable"); } claims = value; }
  } });
  return { redeem: authenticated => invoke(routes["/redeem-founding-invite"], authenticated, { token }),
    claims: () => claims, writes: () => writes };
}

test("invitation route requires authentication and verified email", async () => {
  assert.equal((await inviteFixture().redeem(false)).code, 401);
  const unverified = inviteFixture({ emailVerified: false });
  assert.equal((await unverified.redeem()).code, 403);
  assert.equal(unverified.writes(), 0);
});

test("invalid, expired, foreign, consumed and restricted invitations never grant claims", async () => {
  for (const options of [
    { record: { active: false } }, { record: { email: "other@example.test" } },
    { record: { expiresAt: { toMillis: () => 0 } } }, { record: { redeemedBy: "other-vendor" } },
    { vendor: { accountStatus: "suspended" } }
  ]) {
    const fixture = inviteFixture(options);
    assert.equal((await fixture.redeem()).code, 403);
    assert.equal(fixture.writes(), 0);
    assert.equal(fixture.claims().owdhComplimentaryVendor, undefined);
  }
});

test("concurrent same-vendor redemption consumes invitation once and preserves other claims", async () => {
  const fixture = inviteFixture();
  const results = await Promise.all([fixture.redeem(), fixture.redeem()]);
  assert.ok(results.every(r => r.code === 200 && r.body.access === true));
  assert.equal(fixture.writes(), 1);
  assert.equal(fixture.claims().owdhComplimentaryVendor, true);
  assert.equal(fixture.claims().unrelatedClaim, "preserved");
});

test("claim-write failure can resume a consumed invitation without consuming it twice", async () => {
  const fixture = inviteFixture({ claimFailure: true });
  assert.equal((await fixture.redeem()).code, 503);
  assert.equal((await fixture.redeem()).code, 200);
  assert.equal(fixture.writes(), 1);
  assert.equal(fixture.claims().owdhComplimentaryVendor, true);
});
test("both production-missing membership routes exist and require authentication", async () => {
  const routes = loadApi();
  for (const name of ["/verify-membership", "/confirm-checkout"]) {
    assert.equal(typeof routes[name], "function");
    assert.equal((await invoke(routes[name], false)).code, 401);
  }
});

test("stored checkout lookup outage cannot create another checkout", async () => {
  let created = 0;
  const routes = loadApi({ vendor: { stripeCustomerId: "cus_m", stripeCheckoutSessionId: "cs_old" }, stripeOverrides: {
    subscriptions: { list: async function* () {} },
    checkout: { sessions: { retrieve: async () => { throw new Error("Stripe unavailable"); }, create: async () => { created++; } } }
  } });
  const result = await invoke(routes["/create-checkout-session"], true, { plan: "feature" });
  assert.equal(result.code, 503);
  assert.equal(created, 0);
});

test("a stored checkout for another vendor cannot be reused or expired", async () => {
  let expired = 0;
  const routes = loadApi({ vendor: { stripeCustomerId: "cus_m", stripeCheckoutSessionId: "cs_old" }, stripeOverrides: {
    subscriptions: { list: async function* () {} },
    checkout: { sessions: { retrieve: async () => ({ status: "open", url: "https://checkout.stripe.com/example", client_reference_id: "other", metadata: { plan: "feature" } }), expire: async () => { expired++; } } }
  } });
  const result = await invoke(routes["/create-checkout-session"], true, { plan: "feature" });
  assert.equal(result.code, 403);
  assert.equal(expired, 0);
});

test("a completed checkout for a cancelled subscription does not loop as already paid", async () => {
  let created = 0;
  const routes = loadApi({ vendor: { stripeCustomerId: "cus_m", stripeCheckoutSessionId: "cs_old" }, stripeOverrides: {
    subscriptions: { list: async function* () {}, retrieve: async () => ({ status: "canceled", items: { data: [{ price: { id: "price_1U0a6eIfhRO5Mn4B4dMrAkhr" } }] } }) },
    checkout: { sessions: {
      retrieve: async () => ({ id: "cs_old", mode: "subscription", status: "complete", payment_status: "paid", client_reference_id: "mandi", customer: "cus_m", subscription: "sub_old" }),
      create: async (_args, opts) => { created++; assert.equal(opts.idempotencyKey, "owdh-checkout:mandi:feature:2"); return { id: "cs_new", url: "https://checkout.stripe.com/new" }; }
    } }
  } });
  const result = await invoke(routes["/create-checkout-session"], true, { plan: "feature" });
  assert.equal(result.code, 200);
  assert.equal(result.body.alreadyPaid, undefined);
  assert.equal(created, 1);
});

test("restricted accounts cannot open checkout", async () => {
  const result = await invoke(loadApi({ vendor: { accountStatus: "suspended" }, stripeError: true })["/create-checkout-session"], true, { plan: "feature" });
  assert.equal(result.code, 403);
});
test("Stripe outage is 503, never a confirmed unpaid response", async () => {
  const result = await invoke(loadApi({ stripeError: true })["/verify-membership"]);
  assert.equal(result.code, 503);
  assert.equal(result.body.access, undefined);
});
test("successful verification with no Stripe membership returns unpaid", async () => {
  const result = await invoke(loadApi()["/verify-membership"]);
  assert.equal(result.code, 200);
  assert.equal(result.body.access, false);
});
test("only server claims grant complimentary access; forged vendor flags do not", async () => {
  const allowed = await invoke(loadApi({ vendor: { _serverClaims: { owdhComplimentaryVendor: true } }, stripeError: true })["/verify-membership"]);
  assert.equal(allowed.body.access, true);
  const denied = await invoke(loadApi({ vendor: { _serverClaims: { owdhComplimentaryVendor: true }, accountStatus: "suspended" } })["/verify-membership"]);
  assert.equal(denied.body.access, false);
  const forged = await invoke(loadApi({ vendor: { complimentaryPlan: true, foundingVendor: true, paymentStatus: "free_invite" } })["/verify-membership"]);
  assert.equal(forged.body.access, false);
});


test("delayed subscription updates use current Stripe state", async () => {
  const writes = [];
  const current = { id: "sub_current", customer: "cus_m", status: "active", metadata: { firebaseUid: "mandi" }, items: { data: [{ price: { id: "price_1U0a6eIfhRO5Mn4B4dMrAkhr" } }] } };
  const api = loadApi({ vendor: { stripeSubscriptionId: current.id }, onWrite: value => writes.push(value), stripeOverrides: { subscriptions: { retrieve: async () => current } } });
  await api.testHandleStripeEvent({ type: "customer.subscription.updated", data: { object: { ...current, status: "canceled" } } });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].paymentStatus, "paid");
});

test("cancellation of an old subscription cannot revoke its replacement", async () => {
  const writes = [];
  const old = { id: "sub_old", customer: "cus_m", status: "canceled", metadata: { firebaseUid: "mandi" } };
  const api = loadApi({ vendor: { stripeSubscriptionId: "sub_new" }, onWrite: value => writes.push(value), stripeOverrides: { subscriptions: { retrieve: async () => old } } });
  await api.testHandleStripeEvent({ type: "customer.subscription.deleted", data: { object: old } });
  assert.equal(writes.length, 0);
});

test("late paid invoice for a cancelled old subscription cannot revoke its replacement", async () => {
  const writes = [];
  const old = { id: "sub_old", customer: "cus_m", status: "canceled", metadata: { firebaseUid: "mandi" },
    items: { data: [{ price: { id: membership.PRICE_IDS.edit } }] } };
  const api = loadApi({ vendor: { stripeSubscriptionId: "sub_new", subscriptionActive: true, stripeSubscriptionStatus: "active" },
    onWrite: value => writes.push(value),
    stripeOverrides: { subscriptions: { retrieve: async () => old } } });
  await api.testHandleStripeEvent({ type: "invoice.paid", data: { object: { id: "in_late", subscription: "sub_old" } } });
  assert.equal(writes.length, 0);
});

test("late paid invoice for an old active subscription cannot overwrite a newer active membership", async () => {
  const writes = [];
  const old = { id: "sub_old", customer: "cus_m", status: "active",
    metadata: { firebaseUid: "mandi" },
    items: { data: [{ price: { id: membership.PRICE_IDS.edit } }] } };
  const api = loadApi({ vendor: { stripeSubscriptionId: "sub_new", subscriptionActive: true,
    stripeSubscriptionStatus: "active", membershipTier: "icon" },
    onWrite: value => writes.push(value),
    stripeOverrides: { subscriptions: { retrieve: async () => old } } });
  await api.testHandleStripeEvent({ type: "invoice.paid", data: { object: { id: "in_delayed_active", subscription: "sub_old" } } });
  assert.equal(writes.length, 0);
});

test("new active membership replaces an inactive old membership", async () => {
  const writes = [];
  const replacement = { id: "sub_new", customer: "cus_m", status: "active",
    metadata: { firebaseUid: "mandi" },
    items: { data: [{ price: { id: membership.PRICE_IDS.icon } }] } };
  const api = loadApi({ vendor: { stripeSubscriptionId: "sub_old", subscriptionActive: false,
    stripeSubscriptionStatus: "canceled" }, onWrite: value => writes.push(value),
    stripeOverrides: { subscriptions: { retrieve: async () => replacement } } });
  await api.testHandleStripeEvent({ type: "invoice.paid", data: { object: { id: "in_new", subscription: "sub_new" } } });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].stripeSubscriptionId, "sub_new");
  assert.equal(writes[0].subscriptionActive, true);
});

test("paid invoice for the current now-cancelled subscription still revokes access", async () => {
  const writes = [];
  const current = { id: "sub_current", customer: "cus_m", status: "canceled", metadata: { firebaseUid: "mandi" },
    items: { data: [{ price: { id: membership.PRICE_IDS.edit } }] } };
  const api = loadApi({ vendor: { stripeSubscriptionId: "sub_current", subscriptionActive: true },
    onWrite: value => writes.push(value),
    stripeOverrides: { subscriptions: { retrieve: async () => current } } });
  await api.testHandleStripeEvent({ type: "invoice.paid", data: { object: { id: "in_cancelled", subscription: "sub_current" } } });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].paymentStatus, "cancelled");
});

test("notification provider errors never report successful delivery", async () => {
  const api = loadApi({ resendResult: { data: null, error: { message: "Provider rejected" } } });
  const enquiry = await invoke(api["/send-enquiry-notification"], true, { vendorEmail: "vendor@example.test", coupleName: "Test", message: "Test" });
  const message = await invoke(api["/send-message-notification"], true, { conversationId: "test", recipientEmail: "vendor@example.test", messageBody: "Test" });
  assert.equal(enquiry.code, 500);
  assert.equal(message.code, 500);
  assert.equal(enquiry.body.success, undefined);
  assert.equal(message.body.success, undefined);
});


test("couple accounts cannot obtain or reconcile vendor membership", async () => {
  const api = loadApi({ userRole: "couple", stripeError: true });
  for (const route of ["/create-checkout-session", "/confirm-checkout", "/verify-membership"]) {
    const result = await invoke(api[route], true, { plan: "feature", sessionId: "cs_test" });
    assert.equal(result.code, 403);
  }
});


test("paid vendor verification preserves an existing tier without another checkout", async () => {
  const writes = [];
  const current = { id: "sub_current", customer: "cus_m", status: "active", metadata: { firebaseUid: "mandi" }, items: { data: [{ price: { id: membership.PRICE_IDS.edit } }] } };
  const api = loadApi({ vendor: { stripeSubscriptionId: current.id, membershipTier: "icon" }, onWrite: value => writes.push(value), stripeOverrides: { subscriptions: { retrieve: async () => current } } });
  const result = await invoke(api["/verify-membership"]);
  assert.equal(result.code, 200);
  assert.equal(result.body.access, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].membershipTier, undefined);
});

test("Edit checkout validates the current AUD14.75 price", async () => {
  let created = 0;
  const api = loadApi({ vendor: { stripeCustomerId: "cus_m" }, stripeOverrides: {
    subscriptions: { list: async function* () {} },
    prices: { retrieve: async id => id === membership.PRICE_IDS.setup
      ? { active: true, currency: "aud", unit_amount: 5000 }
      : { active: true, currency: "aud", unit_amount: 1475, recurring: { interval: "month", interval_count: 1 } } },
    checkout: { sessions: { create: async args => { created++; assert.equal(args.line_items[1].price, membership.PRICE_IDS.edit); return { id: "cs_new", url: "https://checkout.stripe.com/example" }; } } }
  } });
  const result = await invoke(api["/create-checkout-session"], true, { plan: "edit" });
  assert.equal(result.code, 200);
  assert.equal(created, 1);
});

test("completed checkout confirms payment without overwriting a current tier", async () => {
  const writes = [];
  const current = { id: "sub_current", customer: "cus_m", status: "active", metadata: { firebaseUid: "mandi" }, items: { data: [{ price: { id: membership.PRICE_IDS.edit } }] } };
  const api = loadApi({ vendor: { membershipTier: "icon" }, onWrite: value => writes.push(value), stripeOverrides: {
    subscriptions: { retrieve: async () => current },
    checkout: { sessions: { retrieve: async () => ({ id: "cs_paid", mode: "subscription", client_reference_id: "mandi", status: "complete", payment_status: "paid", customer: "cus_m", subscription: current.id }) } }
  } });
  const result = await invoke(api["/confirm-checkout"], true, { sessionId: "cs_paid" });
  assert.equal(result.code, 200);
  assert.equal(result.body.access, true);
  assert.equal(writes[0].membershipTier, undefined);
});
