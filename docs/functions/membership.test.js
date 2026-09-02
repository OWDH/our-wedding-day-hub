"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizePlan,
  resolvePlanPriceId,
  checkoutIdempotencyKey,
  customerIdempotencyKey,
  subscriptionGrantsAccess,
  sessionGrantsAccess,
  isComplimentaryVendor,
  vendorShouldHaveDashboardAccess,
  grantMembershipPatch,
  revokeMembershipPatch,
  nextCheckoutAttempt,
  uidFromStripeObject,
  invoiceSubscriptionId,
  customerEmailFromStripeObject,
  stripeEventClaimDecision,
  EVENT_STALE_MS,
  PRICE_IDS
} = require("./membership");

test("normalizePlan maps current and legacy names", () => {
  assert.equal(normalizePlan("edit"), "edit");
  assert.equal(normalizePlan("classic"), "edit");
  assert.equal(normalizePlan("The Spotlight"), "spotlight");
  assert.equal(normalizePlan("platinum"), "icon");
  assert.equal(normalizePlan("setup"), "");
  assert.equal(normalizePlan(""), "");
});

test("resolvePlanPriceId accepts frontend tier names that previously 400'd", () => {
  assert.equal(resolvePlanPriceId("edit"), PRICE_IDS.edit);
  assert.equal(resolvePlanPriceId("spotlight"), PRICE_IDS.spotlight);
  assert.equal(resolvePlanPriceId("feature"), PRICE_IDS.feature);
  assert.equal(resolvePlanPriceId("icon"), PRICE_IDS.icon);
  assert.equal(resolvePlanPriceId("classic"), PRICE_IDS.edit);
  assert.equal(resolvePlanPriceId("unknown"), null);
});

test("idempotency keys are stable and unique per vendor/plan/attempt", () => {
  assert.equal(
    checkoutIdempotencyKey("uid1", "classic", 1),
    checkoutIdempotencyKey("uid1", "edit", 1)
  );
  assert.notEqual(
    checkoutIdempotencyKey("uid1", "edit", 1),
    checkoutIdempotencyKey("uid1", "edit", 2)
  );
  assert.equal(customerIdempotencyKey("uid1"), "owdh-customer:uid1");
});

test("subscription and session status gates", () => {
  assert.equal(subscriptionGrantsAccess("active"), true);
  assert.equal(subscriptionGrantsAccess("trialing"), true);
  assert.equal(subscriptionGrantsAccess("past_due"), true);
  assert.equal(subscriptionGrantsAccess("canceled"), false);
  assert.equal(sessionGrantsAccess({ status: "complete", payment_status: "paid" }), true);
  assert.equal(sessionGrantsAccess({ status: "open", payment_status: "unpaid" }), false);
});

test("complimentary and paid vendors unlock the dashboard", () => {
  assert.equal(isComplimentaryVendor({ paymentStatus: "free_invite" }), true);
  assert.equal(vendorShouldHaveDashboardAccess({ paymentStatus: "pending", subscriptionActive: false }), false);
  assert.equal(vendorShouldHaveDashboardAccess({ paymentStatus: "paid" }), true);
  assert.equal(vendorShouldHaveDashboardAccess({ stripeSubscriptionStatus: "active" }), true);
  assert.equal(vendorShouldHaveDashboardAccess({ complimentaryPlan: true }), true);
  assert.equal(vendorShouldHaveDashboardAccess({ paymentStatus: "paid", accountStatus: "suspended" }), false);
});

test("grant and revoke patches write Stripe identifiers, not cookies", () => {
  const granted = grantMembershipPatch({
    customerId: "cus_1",
    subscriptionId: "sub_1",
    sessionId: "cs_1",
    plan: "classic",
    subscriptionStatus: "active"
  });
  assert.equal(granted.paymentStatus, "paid");
  assert.equal(granted.subscriptionActive, true);
  assert.equal(granted.paidSetupFee, true);
  assert.equal(granted.membershipTier, "edit");
  assert.equal(granted.stripeSubscriptionId, "sub_1");
  assert.equal(granted.stripeCheckoutSessionId, "cs_1");

  const revoked = revokeMembershipPatch("canceled");
  assert.equal(revoked.subscriptionActive, false);
  assert.equal(revoked.paymentStatus, "cancelled");
});

test("nextCheckoutAttempt only increments after a closed session", () => {
  assert.equal(nextCheckoutAttempt({}, null), 1);
  assert.equal(nextCheckoutAttempt({ stripeCheckoutAttempt: 1 }, { status: "open" }), 1);
  assert.equal(nextCheckoutAttempt({ stripeCheckoutAttempt: 1 }, { status: "expired" }), 2);
});

test("uid is read from Stripe session reference or metadata", () => {
  assert.equal(uidFromStripeObject({ client_reference_id: "uid-a" }), "uid-a");
  assert.equal(uidFromStripeObject({ metadata: { firebaseUid: "uid-b" } }), "uid-b");
});

test("invoice subscription id supports current and legacy Stripe invoice shapes", () => {
  assert.equal(invoiceSubscriptionId({ subscription: "sub_legacy" }), "sub_legacy");
  assert.equal(
    invoiceSubscriptionId({
      parent: { subscription_details: { subscription: "sub_new" } }
    }),
    "sub_new"
  );
  assert.equal(invoiceSubscriptionId({}), "");
});

test("customer email is normalised from Checkout session fields", () => {
  assert.equal(
    customerEmailFromStripeObject({ customer_details: { email: "Alex@Hub.com" } }),
    "alex@hub.com"
  );
  assert.equal(customerEmailFromStripeObject({ customer_email: "pay@hub.com" }), "pay@hub.com");
});

test("webhook event claim is idempotent and stale-safe", () => {
  assert.equal(stripeEventClaimDecision(null), "claim");
  assert.equal(stripeEventClaimDecision({ status: "processed" }), "duplicate");
  assert.equal(stripeEventClaimDecision({ status: "failed" }), "claim");
  assert.equal(
    stripeEventClaimDecision({ status: "processing", startedAtMs: Date.now() }),
    "in_progress"
  );
  assert.equal(
    stripeEventClaimDecision({
      status: "processing",
      startedAtMs: Date.now() - EVENT_STALE_MS - 1
    }),
    "claim"
  );
});
