"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const membership = require("./membership");

// Execute the real route handlers with Stripe/Firestore boundaries stubbed.
function loadApi({ vendor = {}, userRole = "vendor", stripeError = false, stripeOverrides = {}, resendResult = { data: { id: "email_test" } }, onWrite = () => {} } = {}) {
  const routes = {};
  const app = { use() {}, post(name, handler) { routes[name] = handler; }, get(name, handler) { routes[name] = handler; } };
  const doc = { get: async () => ({ exists: true, data: () => vendor }), set: async (value) => { onWrite(value); } };
  const userDoc = { get: async () => ({ exists: true, data: () => ({ role: userRole }) }) };
  const db = { collection: name => ({ doc: () => name === "users" ? userDoc : doc }) };
  const admin = { initializeApp() {}, firestore: () => db, auth: () => ({ verifyIdToken: async () => ({ uid: "mandi", email: "m@example.test" }) }) };
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
    "firebase-functions/params": { defineSecret: () => ({ value: () => "stub" }) },
    "firebase-admin": admin, express: Object.assign(() => app, { json: () => {}, raw: () => {} }),
    cors: () => {}, stripe: Stripe, resend: { Resend: function() { this.emails = { send: async () => resendResult }; } }, sharp: () => {}, "./membership": membership
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
test("complimentary access works without Stripe but suspended accounts stay restricted", async () => {
  const allowed = await invoke(loadApi({ vendor: { complimentaryPlan: true }, stripeError: true })["/verify-membership"]);
  assert.equal(allowed.body.access, true);
  const denied = await invoke(loadApi({ vendor: { complimentaryPlan: true, accountStatus: "suspended" } })["/verify-membership"]);
  assert.equal(denied.body.access, false);
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
