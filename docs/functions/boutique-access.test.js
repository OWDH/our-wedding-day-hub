"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(__dirname + "/../dashboard.html", "utf8");
const helper = source.slice(source.indexOf("  function hasShopAccess(v)"), source.indexOf("  function getPlanAccessLabel"));
const context = vm.createContext({});
vm.runInContext(helper, context);

test("current Icon and legacy Platinum subscribers can use Boutique across stored tier fields", () => {
  for (const field of ["membershipTier", "plan", "tier"]) {
    for (const tier of ["icon", "The Icon", " ICON ", "platinum", "platinum_prestige", "platinum-prestige", "Platinum Prestige"]) {
      assert.equal(context.hasShopAccess({ [field]: tier, subscriptionActive: true }), true, `${field}: ${tier}`);
    }
  }
});
test("lower tiers do not inherit Boutique access", () => {
  for (const tier of ["edit", "spotlight", "feature", "classic", "signature", "elite", "", "icon-plus"]) {
    assert.equal(context.hasShopAccess({ membershipTier: tier, subscriptionActive: true }), false, tier);
  }
});
test("existing founding, complimentary and manual grants are retained", () => {
  for (const grant of [{ founding: true }, { foundingVendor: true }, { complimentaryPlan: true },
    { plan: "complimentary" }, { accessType: "complimentary-invite" },
    { paymentStatus: "free_invite" }, { paymentStatus: "free_link" }, { shopAccess: true }]) {
    assert.equal(context.hasShopAccess(grant), true);
    assert.equal(context.hasShopAccess({ ...grant, accountStatus: "suspended" }), false);
  }
  assert.equal(context.hasShopAccess({ membershipTier: "icon", accountStatus: "disabled" }), false);
  assert.equal(context.hasShopAccess(null), false);
});
test("profile save never rewrites protected Boutique entitlement", () => {
  const save = source.slice(source.indexOf("  async function saveVendorData"), source.indexOf('  saveProductBtn.addEventListener'));
  const write = save.slice(save.indexOf('await setDoc(doc(db,"vendors"'), save.indexOf('currentProfileImageUrl = pi'));
  assert.ok(write.includes('businessName:businessName.value.trim()'));
  assert.doesNotMatch(write, /shopAccess\s*:/);
});
test("Boutique loads without a composite index and retains products lacking timestamps", async () => {
  const loader = source.slice(source.indexOf("  async function loadBoutiqueProducts"), source.indexOf("  async function deleteBoutiqueProduct"));
  const docs = [
    { id: "old", data: () => ({ createdAt: { seconds: 10 } }) },
    { id: "legacy", data: () => ({ name: "No timestamp" }) },
    { id: "new", data: () => ({ createdAt: { toMillis: () => 20000 } }) }
  ];
  const state = { db: {}, collection: () => "products", where: (...args) => args,
    query: (...args) => { assert.equal(args.length, 2); return args; },
    getDocs: async () => ({ docs }), renderBoutiqueProducts: () => {},
    document: { getElementById: () => null } };
  vm.createContext(state);
  vm.runInContext("let currentBoutiqueProducts = [];" + loader + "\nasync function result() { await loadBoutiqueProducts('vendor'); return currentBoutiqueProducts.map(p => p.id); }", state);
  assert.deepEqual(Array.from(await state.result()), ["new", "old", "legacy"]);
});
