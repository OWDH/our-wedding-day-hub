"use strict";
// Run in the project's authorised Cloud Shell. Never prints credentials.
const { execFileSync, spawnSync } = require("node:child_process");
const { PRICE_IDS, checkoutPriceMatches, invoiceSubscriptionId, membershipPlanFromSubscription } = require("./membership");
const project = "ourweddingdayhub";
const webhookUrl = "https://us-central1-ourweddingdayhub.cloudfunctions.net/stripeWebhook";
const events = ["checkout.session.completed", "checkout.session.async_payment_succeeded", "invoice.paid", "customer.subscription.updated", "customer.subscription.deleted"];
let stage = "credentials";
function secret(name) {
  return execFileSync("gcloud", ["secrets", "versions", "access", "latest", "--secret=" + name, "--project=" + project], {encoding:"utf8", timeout:20000, stdio:["ignore","pipe","ignore"]}).trim();
}
async function main() {
  const key = secret("STRIPE_SECRET_KEY");
  if (!/^(sk|rk)_live_/.test(key)) throw new Error("Production key required");
  const stripe = require("stripe")(key, {timeout:15000, maxNetworkRetries:0});
  stage = "prices";
  console.log("Checking live Stripe prices...");
  const prices = await Promise.all(Object.entries(PRICE_IDS).map(async ([plan,id]) => {
    const price = await stripe.prices.retrieve(id);
    return {plan, aud:price.unit_amount / 100, valid:checkoutPriceMatches(plan,price)};
  }));
  console.table(prices);
  if (prices.some(p=>!p.valid)) throw new Error("Price mismatch");
  stage = "webhook_configuration";
  const endpoints = [];
  for await (const e of stripe.webhookEndpoints.list({limit:100})) if (e.url === webhookUrl) endpoints.push(e);
  if (endpoints.length !== 1) throw new Error("Expected one webhook destination");
  const endpoint = endpoints[0];
  const enabled = new Set(endpoint.enabled_events);
  const configured = endpoint.status === "enabled" && endpoint.livemode === true && events.every(e => enabled.has(e) || enabled.has("*"));
  console.log(JSON.stringify({webhook: endpoint.url, live: endpoint.livemode, enabled: endpoint.status, requiredEventsPresent: configured}));
  if (!configured) throw new Error("Webhook configuration mismatch");
  const arg = process.argv.indexOf("--resend-invoice");
  if (arg === -1) { console.log("READ-ONLY PREFLIGHT PASSED. No Stripe events resent and no accounts changed."); return; }
  const invoiceId = process.argv[arg+1];
  if (!/^in_[A-Za-z0-9]+$/.test(invoiceId || "")) throw new Error("Invoice ID required");
  stage = "validate_replay";
  const invoice = await stripe.invoices.retrieve(invoiceId);
  if (invoice.status !== "paid" || invoice.currency !== "aud" || invoice.amount_paid <= 0) throw new Error("Expected a paid AUD invoice");
  const sub = await stripe.subscriptions.retrieve(invoiceSubscriptionId(invoice));
  if (sub.status !== "active" || !membershipPlanFromSubscription(sub)) throw new Error("Expected an active OWDH membership");
  const { initializeApp, deleteApp } = require("firebase-admin/app");
  const { getFirestore } = require("firebase-admin/firestore");
  const app = initializeApp({projectId:project});
  const db = getFirestore(app);
  const matches = await db.collection("vendors").where("stripeSubscriptionId", "==", sub.id).limit(2).get();
  if (matches.size !== 1 || matches.docs[0].data().accountStatus && matches.docs[0].data().accountStatus !== "active") throw new Error("Vendor identity or restriction needs review");
  let event = null;
  const cutoff = Math.floor(Date.now()/1000) - 29*86400;
  for await (const item of stripe.events.list({type:"invoice.paid",created:{gte:cutoff},limit:100})) {
    if (item.data.object.id === invoiceId) { event=item; break; }
  }
  if (!event) throw new Error("No recent matching invoice.paid event");
  const eventRef = db.collection("stripeEvents").doc(event.id);
  const before = await eventRef.get();
  if (before.exists && before.data().status === "processed") {
    console.log("This event was already processed. Use Stripe delivery status to verify a further retry.");
    await deleteApp(app); return;
  }
  stage = "stripe_cli_replay";
  console.log("Resending the existing paid-invoice event through Stripe; this does not create a payment.");
  const result = spawnSync("stripe", ["events","resend",event.id,"--webhook-endpoint="+endpoint.id,"--live"], {
    env:{...process.env, STRIPE_API_KEY:key}, encoding:"utf8",timeout:45000,stdio:["ignore","pipe","pipe"]
  });
  if (result.error || result.status !== 0) {
    console.log("Stripe CLI replay did not complete. Install the official CLI if missing; otherwise check destination permissions. No payment was created.");
    process.exitCode=1; await deleteApp(app); return;
  }
  stage = "verify_delivery";
  for (let attempt=0;attempt<12;attempt++) {
    const receipt = await eventRef.get();
    if (receipt.exists && receipt.data().status === "processed") {
      console.log("REAL STRIPE EVENT PROCESSED: signature accepted and handler completed.");
      await deleteApp(app); return;
    }
    if (receipt.exists && receipt.data().status === "failed") throw new Error("Webhook processing failed");
    await new Promise(resolve=>setTimeout(resolve,2500));
  }
  console.log("Replay requested; processing not confirmed. Check Stripe Event deliveries for the HTTP status.");
  process.exitCode=1; await deleteApp(app);
}
const deadline = setTimeout(() => { console.error("Preflight time limit reached at stage:",stage); process.exit(1); },150000);
main().catch(error => {
  console.error("Stopped:", JSON.stringify({stage, code:error.code || error.type || null, status:error.statusCode || null}));
  process.exitCode=1;
}).finally(()=>{clearTimeout(deadline); process.exit(process.exitCode || 0);});
