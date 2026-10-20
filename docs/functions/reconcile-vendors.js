"use strict";

// Run only in an authorised server/Cloud Shell. No keys are printed or written.
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { planReconciliation } = require("./reconcile");

let auditStage = "initialisation";
async function main() {
  const apply = process.argv.includes("--apply");
  const project = "ourweddingdayhub";
  const { initializeApp } = require("firebase-admin/app");
  const { getFirestore, FieldValue } = require("firebase-admin/firestore");
  initializeApp({ projectId: project });
  const db = getFirestore();
  auditStage = "stripe_secret_access";
  const secret = process.env.STRIPE_SECRET_KEY || execFileSync("gcloud", ["secrets", "versions", "access", "latest",
    "--secret=STRIPE_SECRET_KEY", "--project=" + project], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  auditStage = "stripe_key_validation";
  if (!secret.startsWith("sk_live_") && !secret.startsWith("rk_live_")) throw new Error("Live Stripe key required for production audit.");
  const stripe = require("stripe")(secret, { maxNetworkRetries: 3 });
  const collect = async iterable => { const values = []; for await (const value of iterable) values.push(value); return values; };
  auditStage = "firestore_and_stripe_inventory";
  const [vendorSnap, userSnap, customers, subscriptions, sessions, invoices] = await Promise.all([
    db.collection("vendors").get(), db.collection("users").get(),
    collect(stripe.customers.list({ limit: 100 })), collect(stripe.subscriptions.list({ status: "all", limit: 100 })),
    collect(stripe.checkout.sessions.list({ limit: 100 })), collect(stripe.invoices.list({ limit: 100 }))
  ]);
  const vendors = vendorSnap.docs.map(d => ({ ...d.data(), id: d.id }));
  const users = userSnap.docs.map(d => ({ ...d.data(), id: d.id }));
  const report = { generatedAt: new Date().toISOString(), mode: apply ? "apply" : "dry-run",
    counts: { vendors: vendors.length, users: users.length, stripeCustomers: customers.length, stripeSubscriptions: subscriptions.length, stripeInvoices: invoices.length },
    ...planReconciliation(vendors, users, customers, subscriptions, sessions, invoices) };
  // Save the plan BEFORE any writes. Reports contain private account details.
  const directory = path.join(__dirname, "private-audits");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const output = path.join(directory, Date.now() + "-" + report.mode + ".json");
  fs.writeFileSync(output, JSON.stringify(report, null, 2), { mode: 0o600 });
  let applied = 0;
  if (apply) {
    for (const row of report.vendors.filter(r => r.decision === "update")) {
      // Recheck Stripe just before writing and retain the exact Firestore version.
      const sub = await stripe.subscriptions.retrieve(row.patch.stripeSubscriptionId);
      const latestInvoice = sub.latest_invoice ? await stripe.invoices.retrieve(typeof sub.latest_invoice === "string" ? sub.latest_invoice : sub.latest_invoice.id) : null;
      if (!latestInvoice || latestInvoice.status !== "paid" || Number(latestInvoice.amount_paid) <= 0) {
        row.result = "skipped_payment_not_verified"; continue;
      }
      const originalSub = subscriptions.find(s => s.id === sub.id);
      if (sub.status !== originalSub.status || JSON.stringify(sub.items) !== JSON.stringify(originalSub.items)) {
        row.result = "skipped_stripe_changed"; continue;
      }
      const ref = db.collection("vendors").doc(row.uid);
      await db.runTransaction(async tx => {
        const fresh = await tx.get(ref);
        const original = vendorSnap.docs.find(d => d.id === row.uid);
        if (!fresh.exists || !fresh.updateTime.isEqual(original.updateTime)) throw new Error("Account changed during audit; rerun before applying.");
        tx.set(ref, { ...row.patch, updatedAt: FieldValue.serverTimestamp(),
          paymentVerifiedAt: FieldValue.serverTimestamp(), paymentVerificationSource: "stripe_subscription",
          paymentReconciliationPrevious: row.before }, { merge: true });
      });
      row.result = "updated"; applied++;
      fs.writeFileSync(output, JSON.stringify(report, null, 2), { mode: 0o600 });
    }
  }
  console.log(JSON.stringify({ ...report.counts, updatesProposed: report.vendors.filter(r => r.decision === "update").length,
    manualReview: report.vendors.filter(r => r.decision === "review").length, applied, report: output }));
}
main().catch(error => {
  const diagnostic = { stage: auditStage, code: typeof error.code === "string" || typeof error.code === "number" ? error.code : null,
    status: error.statusCode || error.status || null };
  console.error("Reconciliation stopped without further writes:", JSON.stringify(diagnostic));
  process.exitCode = 1;
});
