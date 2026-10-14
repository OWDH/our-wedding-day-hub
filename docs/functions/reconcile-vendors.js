"use strict";

// Run only in an authorised server/Cloud Shell. No keys are printed or written.
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { planReconciliation } = require("./reconcile");

async function main() {
  const apply = process.argv.includes("--apply");
  const project = "ourweddingdayhub";
  const admin = require("firebase-admin");
  admin.initializeApp({ projectId: project });
  const db = admin.firestore();
  const secret = process.env.STRIPE_SECRET_KEY || execFileSync("gcloud", ["secrets", "versions", "access", "latest",
    "--secret=STRIPE_SECRET_KEY", "--project=" + project], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  if (!secret.startsWith("sk_live_") && !secret.startsWith("rk_live_")) throw new Error("Live Stripe key required for production audit.");
  const stripe = require("stripe")(secret, { maxNetworkRetries: 3 });
  const collect = async iterable => { const values = []; for await (const value of iterable) values.push(value); return values; };
  const [vendorSnap, userSnap, customers, subscriptions, sessions] = await Promise.all([
    db.collection("vendors").get(), db.collection("users").get(),
    collect(stripe.customers.list({ limit: 100 })), collect(stripe.subscriptions.list({ status: "all", limit: 100 })),
    collect(stripe.checkout.sessions.list({ limit: 100 }))
  ]);
  const vendors = vendorSnap.docs.map(d => ({ ...d.data(), id: d.id }));
  const users = userSnap.docs.map(d => ({ ...d.data(), id: d.id }));
  const report = { generatedAt: new Date().toISOString(), mode: apply ? "apply" : "dry-run",
    counts: { vendors: vendors.length, users: users.length, stripeCustomers: customers.length, stripeSubscriptions: subscriptions.length },
    ...planReconciliation(vendors, users, customers, subscriptions, sessions) };
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
      const originalSub = subscriptions.find(s => s.id === sub.id);
      if (sub.status !== originalSub.status || JSON.stringify(sub.items) !== JSON.stringify(originalSub.items)) {
        row.result = "skipped_stripe_changed"; continue;
      }
      const ref = db.collection("vendors").doc(row.uid);
      await db.runTransaction(async tx => {
        const fresh = await tx.get(ref);
        const original = vendorSnap.docs.find(d => d.id === row.uid);
        if (!fresh.exists || !fresh.updateTime.isEqual(original.updateTime)) throw new Error("Account changed during audit; rerun before applying.");
        tx.set(ref, { ...row.patch, updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          paymentVerifiedAt: admin.firestore.FieldValue.serverTimestamp(), paymentVerificationSource: "stripe_subscription",
          paymentReconciliationPrevious: row.before }, { merge: true });
      });
      row.result = "updated"; applied++;
      fs.writeFileSync(output, JSON.stringify(report, null, 2), { mode: 0o600 });
    }
  }
  console.log(JSON.stringify({ ...report.counts, updatesProposed: report.vendors.filter(r => r.decision === "update").length,
    manualReview: report.vendors.filter(r => r.decision === "review").length, applied, report: output }));
}
main().catch(error => { console.error("Reconciliation stopped. No further accounts will be changed. Check access and the private audit report."); process.exitCode = 1; });
