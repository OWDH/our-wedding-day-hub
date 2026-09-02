"use strict";

// Live Stripe Price IDs currently used by /create-checkout-session.
// Confirm in the Stripe Dashboard that these still match public pricing:
//   setup      = $50 one-time
//   edit       = $14.95/mo  (legacy name: classic)
//   spotlight  = $15.95/mo  (legacy name: signature)
//   feature    = $17.25/mo  (legacy name: elite)
//   icon       = $19.95/mo  (legacy name: platinum)
const PRICE_IDS = {
  setup: "price_1TGpBgIfhRO5Mn4BGzLRUsB9",
  edit: "price_1TGo2OIfhRO5Mn4BUEpXk9p8",
  spotlight: "price_1TGp0cIfhRO5Mn4BUIferLow",
  feature: "price_1TGp1ZIfhRO5Mn4BqfzdgLud",
  icon: "price_1TGp2pIfhRO5Mn4B3lrSq0Dj"
};

const PLAN_ALIASES = {
  classic: "edit",
  signature: "spotlight",
  elite: "feature",
  platinum: "icon",
  "the edit": "edit",
  "the spotlight": "spotlight",
  "the feature": "feature",
  "the icon": "icon"
};

const ACCESS_STATUSES = new Set(["active", "trialing", "past_due"]);
const EVENT_STALE_MS = 2 * 60 * 1000;

function normalizePlan(plan) {
  const raw = String(plan || "").trim().toLowerCase();
  if (!raw || raw === "setup") return "";
  return PLAN_ALIASES[raw] || raw;
}

function resolvePlanPriceId(plan) {
  const normalized = normalizePlan(plan);
  return normalized ? PRICE_IDS[normalized] || null : null;
}

function checkoutIdempotencyKey(uid, plan, attempt) {
  return `owdh-checkout:${uid}:${normalizePlan(plan)}:${attempt}`;
}

function customerIdempotencyKey(uid) {
  return `owdh-customer:${uid}`;
}

function subscriptionGrantsAccess(status) {
  return ACCESS_STATUSES.has(String(status || "").toLowerCase());
}

function sessionGrantsAccess(session) {
  if (!session) return false;
  const paid = session.payment_status === "paid" || session.payment_status === "no_payment_required";
  const complete = session.status === "complete";
  return Boolean(paid && complete);
}

function isComplimentaryVendor(vendor) {
  if (!vendor) return false;
  return vendor.complimentaryPlan === true
    || vendor.plan === "complimentary"
    || vendor.accessType === "complimentary-invite"
    || vendor.founding === true
    || vendor.foundingVendor === true
    || vendor.paymentStatus === "free_invite"
    || vendor.paymentStatus === "free_link";
}

function isAccountActive(vendor) {
  return !vendor || !vendor.accountStatus || vendor.accountStatus === "active";
}

function vendorHasLocalPaidFlag(vendor) {
  if (!vendor) return false;
  return vendor.paymentStatus === "paid"
    || vendor.subscriptionActive === true
    || vendor.paidSetupFee === true
    || subscriptionGrantsAccess(vendor.stripeSubscriptionStatus);
}

function vendorShouldHaveDashboardAccess(vendor) {
  return isAccountActive(vendor) && (isComplimentaryVendor(vendor) || vendorHasLocalPaidFlag(vendor));
}

function stripeObjectId(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  return value.id || "";
}

function invoiceSubscriptionId(invoice) {
  if (!invoice) return "";
  return stripeObjectId(invoice.subscription)
    || stripeObjectId(
      invoice.parent
      && invoice.parent.subscription_details
      && invoice.parent.subscription_details.subscription
    );
}

function uidFromStripeObject(obj) {
  if (!obj) return "";
  return obj.client_reference_id || (obj.metadata && obj.metadata.firebaseUid) || "";
}

function customerEmailFromStripeObject(obj) {
  if (!obj) return "";
  const email = obj.customer_email
    || (obj.customer_details && obj.customer_details.email)
    || obj.email
    || "";
  return String(email).trim().toLowerCase();
}

function stripeEventClaimDecision(existing, now = Date.now()) {
  if (!existing) return "claim";
  if (existing.status === "processed") return "duplicate";
  if (existing.status === "processing") {
    const startedAt = Number(existing.startedAtMs) || 0;
    if (startedAt && now - startedAt < EVENT_STALE_MS) return "in_progress";
  }
  return "claim";
}

function grantMembershipPatch({ customerId, subscriptionId, sessionId, plan, subscriptionStatus }) {
  const patch = {
    paymentStatus: "paid",
    subscriptionActive: true,
    paidSetupFee: true,
    stripeSubscriptionStatus: subscriptionStatus || "active"
  };
  if (customerId) patch.stripeCustomerId = customerId;
  if (subscriptionId) patch.stripeSubscriptionId = subscriptionId;
  if (sessionId) patch.stripeCheckoutSessionId = sessionId;
  const normalized = normalizePlan(plan);
  if (normalized) patch.membershipTier = normalized;
  return patch;
}

function revokeMembershipPatch(subscriptionStatus) {
  return {
    paymentStatus: "cancelled",
    subscriptionActive: false,
    stripeSubscriptionStatus: subscriptionStatus || "canceled"
  };
}

function nextCheckoutAttempt(vendor, existingSession) {
  const current = Math.max(1, Number((vendor && vendor.stripeCheckoutAttempt) || 1));
  if (!existingSession || existingSession.status === "open") return current;
  return current + 1;
}

module.exports = {
  PRICE_IDS,
  PLAN_ALIASES,
  EVENT_STALE_MS,
  normalizePlan,
  resolvePlanPriceId,
  checkoutIdempotencyKey,
  customerIdempotencyKey,
  subscriptionGrantsAccess,
  sessionGrantsAccess,
  isComplimentaryVendor,
  vendorHasLocalPaidFlag,
  vendorShouldHaveDashboardAccess,
  stripeObjectId,
  invoiceSubscriptionId,
  uidFromStripeObject,
  customerEmailFromStripeObject,
  stripeEventClaimDecision,
  grantMembershipPatch,
  revokeMembershipPatch,
  nextCheckoutAttempt
};
