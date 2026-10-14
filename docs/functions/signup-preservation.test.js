"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(__dirname + "/../firebase.js", "utf8");
const helper = source.slice(source.indexOf("async function ensureSignupDocument"), source.indexOf("export {"));

test("signup retry cannot reset an existing paid, visible profile", async () => {
  const original = { paymentStatus: "paid", membershipTier: "spotlight", visible: true, bio: "Existing biography" };
  let writes = 0;
  const context = { db: {}, runTransaction: async (_db, callback) => callback({
    get: async () => ({ exists: () => true, data: () => original }), set: () => { writes++; }
  }) };
  vm.createContext(context); vm.runInContext(helper, context);
  assert.equal(await context.ensureSignupDocument({}, { paymentStatus: "pending", visible: false }), false);
  assert.equal(writes, 0);
  assert.equal(original.paymentStatus, "paid");
});
test("partial signup creates its missing document and a retry preserves it", async () => {
  let saved = null;
  const context = { db: {}, runTransaction: async (_db, callback) => callback({
    get: async () => ({ exists: () => Boolean(saved) }), set: (_ref, value) => { saved = value; }
  }) };
  vm.createContext(context); vm.runInContext(helper, context);
  assert.equal(await context.ensureSignupDocument({}, { membershipTier: "icon" }), true);
  assert.equal(await context.ensureSignupDocument({}, { membershipTier: "edit" }), false);
  assert.equal(saved.membershipTier, "icon");
});
