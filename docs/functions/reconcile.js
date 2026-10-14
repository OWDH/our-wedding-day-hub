"use strict";

const { membershipPlanFromSubscription, subscriptionGrantsAccess, stripeObjectId,
  uidFromStripeObject, isComplimentaryVendor, grantMembershipPatch } = require("./membership");

const emailKey = value => String(value || "").trim().toLowerCase();

// Pure planning step. An ambiguous match never becomes a write.
function planReconciliation(vendors, users, customers, subscriptions, sessions) {
  const rows = [];
  const matchedCustomers = new Set();
  for (const vendor of vendors) {
    const user = users.find(u => u.id === vendor.id);
    const emails = new Set([emailKey(vendor.email), emailKey(user && user.email)].filter(Boolean));
    const candidates = customers.filter(c => !c.deleted && (c.id === vendor.stripeCustomerId
      || uidFromStripeObject(c) === vendor.id || emails.has(emailKey(c.email))));
    const customerIds = new Set(candidates.map(c => c.id));
    const checkoutMatches = sessions.filter(s => uidFromStripeObject(s) === vendor.id);
    checkoutMatches.forEach(s => { if (s.customer) customerIds.add(stripeObjectId(s.customer)); });
    const related = subscriptions.filter(s => s.id === vendor.stripeSubscriptionId
      || uidFromStripeObject(s) === vendor.id || customerIds.has(stripeObjectId(s.customer)));
    const memberships = related.filter(s => membershipPlanFromSubscription(s));
    const active = memberships.filter(s => subscriptionGrantsAccess(s.status));
    const conflict = candidates.some(c => uidFromStripeObject(c) && uidFromStripeObject(c) !== vendor.id)
      || memberships.some(s => uidFromStripeObject(s) && uidFromStripeObject(s) !== vendor.id)
      || vendors.some(other => other.id !== vendor.id && (
        (other.stripeCustomerId && customerIds.has(other.stripeCustomerId))
        || (emailKey(other.email) && emails.has(emailKey(other.email)))
        || (emailKey((users.find(u => u.id === other.id) || {}).email) && emails.has(emailKey((users.find(u => u.id === other.id) || {}).email)))
      ));
    const row = { uid: vendor.id, businessName: vendor.businessName || "", decision: "review",
      current: { paymentStatus: vendor.paymentStatus || "unknown", subscriptionActive: vendor.subscriptionActive === true },
      before: Object.fromEntries(["paymentStatus", "subscriptionActive", "paidSetupFee", "stripeSubscriptionStatus", "stripeCustomerId", "stripeSubscriptionId", "membershipTier"].map(key => [key, vendor[key] === undefined ? null : vendor[key]])),
      customers: [...customerIds], subscriptions: memberships.map(s => ({ id: s.id, status: s.status, plan: membershipPlanFromSubscription(s) })),
      checkoutSessions: checkoutMatches.map(s => ({ id: s.id, status: s.status, paymentStatus: s.payment_status })), patch: null };
    if (conflict || active.length > 1) row.reason = "Ambiguous identity or multiple active memberships; manual review required.";
    else if (isComplimentaryVendor(vendor)) { row.decision = "preserve"; row.reason = "Existing complimentary access retained."; }
    else if (!user || user.role !== "vendor") row.reason = "Missing or conflicting user role; do not infer or overwrite account identity.";
    else if (vendor.accountStatus && vendor.accountStatus !== "active") row.reason = "Account restricted; preserve restriction.";
    else if (active.length === 1) {
      const sub = active[0];
      // A customer cannot belong to two vendor records, even when email differs.
      const duplicate = vendors.some(v => v.id !== vendor.id && (v.stripeSubscriptionId === sub.id
        || v.stripeCustomerId === stripeObjectId(sub.customer)))
        || sessions.some(s => stripeObjectId(s.subscription) === sub.id && uidFromStripeObject(s) && uidFromStripeObject(s) !== vendor.id);
      if (duplicate) row.reason = "Stripe identifiers belong to another vendor; manual review required.";
      else {
        row.patch = grantMembershipPatch({ customerId: stripeObjectId(sub.customer), subscriptionId: sub.id,
          plan: membershipPlanFromSubscription(sub), subscriptionStatus: sub.status });
        row.decision = Object.entries(row.patch).every(([key, value]) => vendor[key] === value) ? "unchanged" : "update";
        row.reason = "Unique matching current OWDH subscription verified in Stripe.";
        matchedCustomers.add(stripeObjectId(sub.customer));
      }
    } else row.reason = memberships.length ? "No current qualifying subscription; review history before any access removal."
      : "No verified membership found; do not mark paid or request another charge automatically.";
    rows.push(row);
  }
  return { vendors: rows, usersWithoutVendor: users.filter(u => u.role === "vendor" && !vendors.some(v => v.id === u.id)).map(u => u.id),
    stripeMembershipsWithoutMatchedVendor: subscriptions.filter(s => membershipPlanFromSubscription(s) && !matchedCustomers.has(stripeObjectId(s.customer)))
      .map(s => ({ subscriptionId: s.id, customerId: stripeObjectId(s.customer), status: s.status })) };
}

module.exports = { planReconciliation };
