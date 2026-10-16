"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { planReconciliation } = require("./reconcile");
const { PRICE_IDS, membershipPlanFromSubscription, sessionBelongsToVendor, canReuseCheckout, revokeMembershipPatch } = require("./membership");
const vendor = { id: "mandi", businessName: "Married by Mandi", email: "m@example.test", paymentStatus: "pending" };
const user = { id: "mandi", email: vendor.email, role: "vendor" };
const customer = { id: "cus_m", email: vendor.email };
const subscription = { id: "sub_m", customer: customer.id, status: "active", latest_invoice: "in_m", items: { data: [{ price: { id: PRICE_IDS.spotlight } }] } };
const invoice = { id: "in_m", subscription: "sub_m", status: "paid", amount_paid: 1595, currency: "aud", lines: { data: [] } };
const plan = (vendors = [vendor], users = [user], customers = [customer], subs = [subscription], sessions = [], invoices = [invoice]) => planReconciliation(vendors, users, customers, subs, sessions, invoices);

test("verified email and actual membership price produce a targeted repair", () => {
  const row = plan().vendors[0];
  assert.equal(row.decision, "update");
  assert.equal(row.patch.membershipTier, "spotlight");
  assert.equal(row.patch.stripeSubscriptionId, "sub_m");
  assert.equal(row.patch.published, undefined);
});
test("duplicate identity and duplicate subscriptions never become writes", () => {
  assert.equal(plan([vendor, { ...vendor, id: "other" }]).vendors[0].decision, "review");
  assert.equal(plan(undefined, undefined, undefined, [subscription, { ...subscription, id: "sub_second" }]).vendors[0].decision, "review");
});
test("conflicting Stripe UID never overrides account identity", () => {
  assert.equal(plan(undefined, undefined, undefined, [{ ...subscription, metadata: { firebaseUid: "other" } }]).vendors[0].decision, "review");
});
test("UID checkout reference recovers a changed payment email", () => {
  const row = plan(undefined, undefined, [{ ...customer, email: "payer@example.test" }], undefined,
    [{ id: "cs_m", client_reference_id: "mandi", customer: "cus_m", subscription: "sub_m", status: "complete", payment_status: "paid" }]).vendors[0];
  assert.equal(row.decision, "update");
});
test("missing users, restricted accounts and cancelled subscriptions require review", () => {
  assert.equal(plan(undefined, []).vendors[0].decision, "review");
  assert.equal(plan([{ ...vendor, accountStatus: "suspended" }]).vendors[0].decision, "review");
  assert.equal(plan(undefined, undefined, undefined, [{ ...subscription, status: "canceled" }]).vendors[0].decision, "review");
});
test("complimentary accounts are preserved and repeat audits are idempotent", () => {
  assert.equal(plan([{ ...vendor, complimentaryPlan: true }]).vendors[0].decision, "preserve");
  const patch = plan().vendors[0].patch;
  assert.equal(plan([{ ...vendor, ...patch }]).vendors[0].decision, "unchanged");
});
test("unrelated Stripe subscriptions cannot grant membership even with plan metadata", () => {
  const unrelated = { ...subscription, metadata: { plan: "spotlight" }, items: { data: [{ price: { id: "price_other" } }] } };
  assert.equal(membershipPlanFromSubscription(unrelated), "");
  assert.equal(plan(undefined, undefined, undefined, [unrelated]).vendors[0].decision, "review");
});
test("confirmation rejects another vendor and unbound session ids", () => {
  assert.equal(sessionBelongsToVendor({ client_reference_id: "other", customer: "cus_m" }, "mandi", { stripeCustomerId: "cus_m" }), false);
  assert.equal(sessionBelongsToVendor({ customer: "cus_other" }, "mandi", {}), false);
  assert.equal(sessionBelongsToVendor({ client_reference_id: "mandi" }, "mandi", {}), true);
});
test("checkout reuse requires the same tier and cancellation clears access flags", () => {
  const session = { status: "open", url: "https://checkout.stripe.com/example", metadata: { plan: "classic", recurringPriceId: PRICE_IDS.edit } };
  assert.equal(canReuseCheckout(session, "edit"), true);
  assert.equal(canReuseCheckout(session, "spotlight"), false);
  assert.equal(revokeMembershipPatch("canceled").paidSetupFee, false);
});

test("an active subscription without captured invoice payment is never labelled paid", () => {
  assert.equal(plan(undefined, undefined, undefined, undefined, undefined, []).vendors[0].decision, "review");
  assert.equal(plan(undefined, undefined, undefined, undefined, undefined, [{ ...invoice, amount_paid: 0 }]).vendors[0].decision, "review");
  assert.equal(plan().vendors[0].patch.paidSetupFee, undefined);
});

test("current exported recurring prices and legacy memberships are recognised", () => {
  const cases = [
    ["price_1U0a7yIfhRO5Mn4BnUZjUwtJ", "edit"],
    ["price_1U0a7MIfhRO5Mn4B8ySS16FY", "spotlight"],
    ["price_1U0a6eIfhRO5Mn4B4dMrAkhr", "feature"],
    ["price_1U0a5rIfhRO5Mn4Bl8KEfFXc", "icon"]
  ];
  for (const [id, plan] of cases) {
    assert.equal(membershipPlanFromSubscription({ items: { data: [{ price: { id } }] } }), plan);
  }
  assert.equal(membershipPlanFromSubscription({ items: { data: [
    { price: { id: cases[0][0] } }, { price: { id: cases[1][0] } }
  ] } }), "");
});


test("an open checkout without the current price identity cannot be reused", () => {
  assert.equal(canReuseCheckout({ status: "open", url: "https://checkout.stripe.com/test", metadata: { plan: "feature" } }, "feature"), false);
  assert.equal(canReuseCheckout({ status: "open", url: "https://checkout.stripe.com/test", metadata: { plan: "feature", recurringPriceId: "price_legacy" } }, "feature"), false);
});

test("paid subscription audit preserves a manually assigned vendor tier", () => {
  const row = plan([{ ...vendor, membershipTier: "icon" }]).vendors[0];
  assert.equal(row.decision, "update");
  assert.equal(row.patch.membershipTier, undefined);
  assert.equal(row.patch.paymentStatus, "paid");
});
