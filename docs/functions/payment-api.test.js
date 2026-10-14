"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const membership = require("./membership");

// Execute the real route handlers with Stripe/Firestore boundaries stubbed.
function loadApi({ vendor = {}, stripeError = false } = {}) {
  const routes = {};
  const app = { use() {}, post(name, handler) { routes[name] = handler; }, get(name, handler) { routes[name] = handler; } };
  const doc = { get: async () => ({ exists: true, data: () => vendor }), set: async () => {} };
  const db = { collection: () => ({ doc: () => doc }) };
  const admin = { initializeApp() {}, firestore: () => db, auth: () => ({ verifyIdToken: async () => ({ uid: "mandi", email: "m@example.test" }) }) };
  function Stripe() {
    return { customers: { list: async function* () { if (stripeError) throw new Error("Stripe unavailable"); } } };
  }
  const modules = {
    "firebase-functions/v2/https": { onRequest: (_opts, fn) => fn },
    "firebase-functions/v2/storage": { onObjectFinalized: () => {} },
    "firebase-functions/params": { defineSecret: () => ({ value: () => "stub" }) },
    "firebase-admin": admin, express: Object.assign(() => app, { json: () => {}, raw: () => {} }),
    cors: () => {}, stripe: Stripe, resend: { Resend() {} }, sharp: () => {}, "./membership": membership
  };
  vm.runInNewContext(fs.readFileSync(__dirname + "/index.js", "utf8"), {
    require: name => Object.hasOwn(modules, name) ? modules[name] : require(name),
    exports: {}, console: { error() {}, warn() {} }
  });
  return routes;
}
async function invoke(handler, authenticated = true) {
  const response = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  await handler({ headers: authenticated ? { authorization: "Bearer test" } : {}, body: {} }, response);
  return response;
}
test("both production-missing membership routes exist and require authentication", async () => {
  const routes = loadApi();
  for (const name of ["/verify-membership", "/confirm-checkout"]) {
    assert.equal(typeof routes[name], "function");
    assert.equal((await invoke(routes[name], false)).code, 401);
  }
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
