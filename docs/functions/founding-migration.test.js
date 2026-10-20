"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { fields, decision, claimsWithGrant, planFromBackup } = require("./migrate-existing-founders");
const user = { role: "vendor", email: "vendor@example.test" };
const auth = { uid: "vendor", email: "vendor@example.test", disabled: false, emailVerified: false };

test("migration selects existing complimentary markers without requiring old accounts to reverify email", () => {
  for (const grant of [{ complimentaryPlan: true }, { plan: "complimentary" }, { accessType: "complimentary-invite" },
    { founding: true }, { foundingVendor: true }, { paymentStatus: "free_invite" }, { paymentStatus: "free_link" }]) {
    assert.equal(decision(grant, user, auth), "grant");
  }
});
test("paid tiers, setup fees and manual Boutique permissions alone never become free membership", () => {
  for (const vendor of [{ membershipTier: "icon", subscriptionActive: true }, { paidSetupFee: true }, { shopAccess: true }, { founding: "true" }]) {
    assert.equal(decision(vendor, user, auth), "not_complimentary");
  }
});
test("restricted, mismatched and explicitly denied accounts stay ungranted", () => {
  assert.equal(decision({ founding: true, accountStatus: "suspended" }, user, auth), "restricted_vendor");
  assert.equal(decision({ founding: true }, { role: "couple" }, auth), "missing_or_nonvendor_user");
  assert.equal(decision({ founding: true }, user, { ...auth, disabled: true }), "missing_or_disabled_auth");
  assert.equal(decision({ founding: true }, { ...user, email: "other@example.test" }, auth), "email_mismatch");
  assert.equal(decision({ founding: true }, user, { ...auth, customClaims: { owdhComplimentaryVendor: false } }), "explicit_server_denial");
  assert.equal(decision({ founding: true }, user, { ...auth, customClaims: { owdhComplimentaryVendor: true } }), "already_granted");
});
test("public vendor contact email may differ only when the user email confirms the Auth identity", () => {
  const vendor = { founding: true, email: "contact@example.test" };
  assert.equal(decision(vendor, user, auth), "grant");
  assert.equal(decision(vendor, { role: "vendor" }, auth), "email_mismatch");
  assert.equal(decision(vendor, { ...user, email: vendor.email }, auth), "email_mismatch");
  assert.equal(decision(vendor, user, { ...auth, disabled: true }), "missing_or_disabled_auth");
  assert.equal(decision(vendor, user, { ...auth, customClaims: { owdhComplimentaryVendor: false } }), "explicit_server_denial");
});
test("claim merge preserves unrelated claims and rejects oversized Auth payloads", () => {
  assert.deepEqual(claimsWithGrant({ customClaims: { anotherGrant: "keep" } }), { anotherGrant: "keep", owdhComplimentaryVendor: true });
  assert.throws(() => claimsWithGrant({ customClaims: { oversized: "x".repeat(1000) } }));
});
test("typed backup plan binds eligible UIDs to their original document update times", () => {
  const vendor = { name: "projects/p/databases/(default)/documents/vendors/vendor", updateTime: "original",
    fields: { founding: { booleanValue: true }, email: { stringValue: auth.email } } };
  const userDoc = { name: "projects/p/databases/(default)/documents/users/vendor", updateTime: "user-time",
    fields: { role: { stringValue: "vendor" }, email: { stringValue: auth.email } } };
  assert.deepEqual(fields(vendor), { founding: true, email: auth.email });
  const plan = planFromBackup("/private", { vendors: [vendor], users: [userDoc], auth: [auth] });
  assert.equal(plan.rows[0].decision, "grant");
  assert.equal(plan.rows[0].uid, "vendor");
  assert.equal(plan.rows[0].vendorUpdateTime, "original");
  assert.equal(plan.rows[0].userUpdateTime, "user-time");
});
