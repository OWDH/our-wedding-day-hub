"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { selectQaAccount, assertQaDocuments } = require("./production-invitation-qa");
const account = { uid: "qa", email: "owdh-qa-012345abcdef@example.com", displayName: "TTM QA Test Vendor", disabled: false };
const stringValue = value => ({ stringValue: value });
function fixture() {
  const user = { fields: { isTestAccount: { booleanValue: true }, email: stringValue(account.email), role: stringValue("vendor") } };
  const vendor = structuredClone(user);
  Object.assign(vendor.fields, { uid: stringValue(account.uid), accountStatus: stringValue("active"),
    ...Object.fromEntries(["visible", "published", "profileVisible"].map(key => [key, { booleanValue: false }])) });
  return { user, vendor };
}
test("production QA refuses real accounts, disabled users, ambiguous matches and incomplete inventories", () => {
  assert.equal(selectQaAccount([account]), account);
  for (const users of [[], [{ ...account, email: "customer@example.com" }],
    [{ ...account, disabled: true }], [account, { ...account, uid: "other" }]]) {
    assert.throws(() => selectQaAccount(users));
  }
  assert.throws(() => selectQaAccount([account], "next-page"));
});
test("production QA requires hidden marked documents matching the exact synthetic account", () => {
  const { user, vendor } = fixture();
  assert.doesNotThrow(() => assertQaDocuments(account, user, vendor));
  for (const change of [v => delete v.fields.isTestAccount,
    v => v.fields.email = stringValue("customer@example.com"),
    v => v.fields.uid = stringValue("customer"),
    v => v.fields.published = { booleanValue: true },
    v => v.fields.stripeCustomerId = stringValue("cus_customer")]) {
    const altered = structuredClone(vendor); change(altered);
    assert.throws(() => assertQaDocuments(account, user, altered));
  }
});
