"use strict";
const { test, before, after, beforeEach } = require("node:test");
const fs = require("node:fs");
const { initializeTestEnvironment, assertSucceeds, assertFails } = require("@firebase/rules-unit-testing");
const { doc, setDoc, updateDoc, getDoc, deleteDoc } = require("firebase/firestore");
let env;
const signup = { email: "vendor@example.test", role: "vendor", createdAt: 1,
  businessName: "Test", primaryCategory: "Photography", approved: false, visible: false,
  profileVisible: false, published: false, membershipTier: "icon", paymentStatus: "pending", subscriptionActive: false };
const db = uid => env.authenticatedContext(uid, { email: uid + "@example.test" }).firestore();
before(async () => { env = await initializeTestEnvironment({ projectId: "demo-owdh-security",
  firestore: { host: "127.0.0.1", port: 8080, rules: fs.readFileSync(__dirname + "/../docs/firestore.rules", "utf8") } }); });
after(async () => { if (env) await env.cleanup(); });
beforeEach(async () => { await env.clearFirestore(); });
async function seed(path, data) { await env.withSecurityRulesDisabled(async context => setDoc(doc(context.firestore(), path), data)); }

test("normal signup and profile editing remain permitted", async () => {
  await assertSucceeds(setDoc(doc(db("vendor"), "users/vendor"), { role: "vendor", email: signup.email }));
  await assertSucceeds(setDoc(doc(db("vendor"), "vendors/vendor"), signup));
  await assertSucceeds(updateDoc(doc(db("vendor"), "vendors/vendor"), { businessName: "Changed", images: [], uid: "vendor" }));
  await assertSucceeds(updateDoc(doc(db("vendor"), "users/vendor"), { name: "Changed", role: "vendor" }));
});
test("signup cannot issue free, paid, administrative or Boutique grants", async () => {
  for (const forgery of [{ paymentStatus: "free_invite" }, { subscriptionActive: true }, { shopAccess: true },
    { complimentaryPlan: true }, { founding: true }, { stripeCustomerId: "cus_other" }, { role: "admin" }, { accountStatus: "active" }]) {
    await assertFails(setDoc(doc(db("vendor"), "vendors/vendor"), { ...signup, ...forgery }));
  }
  await assertFails(setDoc(doc(db("vendor"), "users/vendor"), { role: "admin" }));
});
test("protected membership and role fields cannot be changed or deleted then recreated", async () => {
  await seed("vendors/vendor", { ...signup, paymentStatus: "paid", subscriptionActive: true });
  await seed("users/vendor", { role: "vendor" });
  for (const key of ["shopAccess", "tier", "paymentStatus", "complimentaryPlan", "foundingVendor", "accountStatus", "stripeCustomerId"]) {
    await assertFails(updateDoc(doc(db("vendor"), "vendors/vendor"), { [key]: "forged" }));
  }
  await assertFails(deleteDoc(doc(db("vendor"), "vendors/vendor")));
  await assertFails(updateDoc(doc(db("vendor"), "users/vendor"), { role: "admin" }));
  await assertFails(deleteDoc(doc(db("vendor"), "users/vendor")));
});
test("private invitations and webhook deduplication are inaccessible to clients", async () => {
  for (const path of ["foundingVendorInvites/token", "stripeEvents/event"]) {
    await seed(path, { active: true });
    await assertFails(getDoc(doc(db("vendor"), path)));
    await assertFails(setDoc(doc(db("vendor"), path), { active: false }));
  }
});
test("Boutique editing preserves ownership and other vendors cannot take over", async () => {
  await seed("vendors/vendor", { ...signup, subscriptionActive: true });
  await assertSucceeds(setDoc(doc(db("vendor"), "boutiqueProducts/product"), { vendorId: "vendor", name: "Test" }));
  await assertSucceeds(updateDoc(doc(db("vendor"), "boutiqueProducts/product"), { name: "Updated" }));
  await assertFails(updateDoc(doc(db("vendor"), "boutiqueProducts/product"), { vendorId: "other" }));
  await assertFails(deleteDoc(doc(db("other"), "boutiqueProducts/product")));
  await assertSucceeds(deleteDoc(doc(db("vendor"), "boutiqueProducts/product")));
});
test("Boutique rejects unpaid, lower-tier and restricted vendors while preserving existing grants", async () => {
  for (const vendor of [signup, { ...signup, membershipTier: 'edit', subscriptionActive: true }, { ...signup, subscriptionActive: true, accountStatus: 'suspended' }]) {
    await seed('vendors/vendor', vendor);
    await assertFails(setDoc(doc(db('vendor'), 'boutiqueProducts/product'), { vendorId: 'vendor' }));
  }
  for (const grant of [{ founding: true }, { shopAccess: true }, { complimentaryPlan: true }]) {
    await seed('vendors/vendor', { ...signup, ...grant });
    await assertSucceeds(setDoc(doc(db('vendor'), 'boutiqueProducts/product'), { vendorId: 'vendor' }));
  }
});
test("conversation participants can message but outsiders cannot read, impersonate or gain access", async () => {
  await seed("conversations/chat", { vendorId: "vendor", coupleId: "couple" });
  await assertSucceeds(setDoc(doc(db("couple"), "conversations/chat/messages/message"), { senderId: "couple", body: "Hello", read: false }));
  await assertSucceeds(getDoc(doc(db("vendor"), "conversations/chat/messages/message")));
  await assertFails(getDoc(doc(db("other"), "conversations/chat/messages/message")));
  await assertFails(setDoc(doc(db("other"), "conversations/chat/messages/forgery"), { senderId: "other" }));
  await assertFails(setDoc(doc(db("vendor"), "conversations/chat/messages/impersonation"), { senderId: "couple" }));
  await assertFails(updateDoc(doc(db("vendor"), "conversations/chat"), { coupleId: "other" }));
  await assertSucceeds(updateDoc(doc(db("vendor"), "conversations/chat"), { vendorUnread: 0 }));
});
