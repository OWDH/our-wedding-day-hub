"use strict";

// Historical Stripe Price IDs retained for membership recognition.
// New checkout pricing is configured separately and checked against public rates:
//   setup      = $50 one-time
//   edit       = $14.75/mo  (legacy name: classic)
//   spotlight  = $15.95/mo  (legacy name: signature)
//   feature    = $17.25/mo  (legacy name: elite)
//   icon       = $19.95/mo  (legacy name: platinum)
const LEGACY_PRICE_IDS = {
  setup: "price_1TGpBgIfhRO5Mn4BGzLRUsB9",
  edit: "price_1TGo2OIfhRO5Mn4BUEpXk9p8",
  spotlight: "price_1TGp0cIfhRO5Mn4BUIferLow",
  feature: "price_1TGp1ZIfhRO5Mn4BqfzdgLud",
  icon: "price_1TGp2pIfhRO5Mn4B3lrSq0Dj"
};

// Existing subscriptions retain their legacy prices. New checkout prices use
// the current exported prices; an explicit deployment override is supported.
const PRICE_IDS = {
  setup: process.env.STRIPE_PRICE_SETUP || LEGACY_PRICE_IDS.setup,
  edit: process.env.STRIPE_PRICE_EDIT || "price_1U0a7yIfhRO5Mn4BnUZjUwtJ",
  spotlight: process.env.STRIPE_PRICE_SPOTLIGHT || "price_1U0a7MIfhRO5Mn4B8ySS16FY",
  feature: process.env.STRIPE_PRICE_FEATURE || "price_1U0a6eIfhRO5Mn4B4dMrAkhr",
  icon: process.env.STRIPE_PRICE_ICON || "price_1U0a5rIfhRO5Mn4Bl8KEfFXc"
};
const EXPECTED_PRICE_CENTS = { setup: 5000, edit: 1475, spotlight: 1595, feature: 1725, icon: 1995 };
function checkoutPriceMatches(plan, price) {
  return Boolean(price && price.active === true && price.currency === "aud"
    && price.unit_amount === EXPECTED_PRICE_CENTS[plan]
    && (plan === "setup" ? !price.recurring
      : price.recurring && price.recurring.interval === "month" && price.recurring.interval_count === 1));
}

// Additional live recurring prices from the 14 October 2026 Stripe export.
// Preserve recognition of exported memberships independent of checkout overrides.
const EXPORTED_MEMBERSHIP_PRICES = {
  price_1U0a7yIfhRO5Mn4BnUZjUwtJ: "edit",
  price_1U0a7MIfhRO5Mn4B8ySS16FY: "spotlight",
  price_1U0a6eIfhRO5Mn4B4dMrAkhr: "feature",
  price_1U0a5rIfhRO5Mn4Bl8KEfFXc: "icon"
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

function grantMembershipPatch({ customerId, subscriptionId, sessionId, plan, subscriptionStatus, existingTier }) {
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
  if (normalized && !existingTier) patch.membershipTier = normalized;
  return patch;
}

function revokeMembershipPatch(subscriptionStatus) {
  return {
    paymentStatus: "cancelled",
    subscriptionActive: false,
    paidSetupFee: false,
    stripeSubscriptionStatus: subscriptionStatus || "canceled"
  };
}

function nextCheckoutAttempt(vendor, existingSession) {
  const current = Math.max(1, Number((vendor && vendor.stripeCheckoutAttempt) || 1));
  if (!existingSession || existingSession.status === "open") return current;
  return current + 1;
}

// A subscription must contain an actual OWDH recurring price, not just metadata.
function membershipPlanFromSubscription(subscription) {
  const plans = new Set(((subscription.items && subscription.items.data) || [])
    .map(item => {
      const priceId = stripeObjectId(item.price);
      return EXPORTED_MEMBERSHIP_PRICES[priceId]
        || Object.keys(PRICE_IDS).find(plan => plan !== "setup" && PRICE_IDS[plan] === priceId)
        || Object.keys(LEGACY_PRICE_IDS).find(plan => plan !== "setup" && LEGACY_PRICE_IDS[plan] === priceId);
    })
    .filter(Boolean));
  return plans.size === 1 ? [...plans][0] : "";
}
function sessionBelongsToVendor(session, uid, vendor = {}) {
  const reference = uidFromStripeObject(session);
  if (reference) return reference === uid;
  return Boolean(vendor.stripeCustomerId && stripeObjectId(session.customer) === vendor.stripeCustomerId);
}
function canReuseCheckout(session, plan) {
  return Boolean(session && session.status === "open" && session.url
    && session.metadata && session.metadata.recurringPriceId === resolvePlanPriceId(plan)
    && normalizePlan(session.metadata && session.metadata.plan) === normalizePlan(plan));
}

module.exports = {
  PRICE_IDS,
  checkoutPriceMatches,
  membershipPlanFromSubscription,
  sessionBelongsToVendor,
  canReuseCheckout,
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
