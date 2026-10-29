'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const read = name => fs.readFileSync(__dirname + '/../' + name, 'utf8');
const helper = read('registration-categories.js').replace('export ', '');
const firebase = read('firebase.js');
const transaction = firebase.slice(firebase.indexOf('async function ensureRegistrationCategories'), firebase.indexOf('\nexport {'));
function context(extra = {}) {
  const c = vm.createContext(extra); vm.runInContext(helper, c); return c;
}
test('registration maps Magician only when no explicit categories exist', () => {
  const c = context();
  assert.deepEqual(Array.from(c.withRegistrationCategories({primaryCategory:'Magician'}).categories), ['magician']);
  for (const v of [{primaryCategory:'Magician',categories:[]}, {primaryCategory:'Magician',categories:['wedding_dj']}, {primaryCategory:'Magician',category:'wedding_band'}, {primaryCategory:'Other'}]) {
    assert.equal(c.withRegistrationCategories(v), v);
  }
});
test('signup category transaction persists, retries safely, and respects removal/replacement', async () => {
  let stored = {primaryCategory:'Magician',paymentStatus:'pending',published:false};
  const c = context({db:{},runTransaction:async (_, callback) => callback({
    get:async () => ({exists:()=>true,data:()=>stored}),
    update:(_, patch) => {stored = {...stored,...patch};}
  })});
  vm.runInContext(transaction, c);
  assert.equal(await c.ensureRegistrationCategories({}),true);
  assert.deepEqual(Array.from(stored.categories),['magician']);
  assert.equal(stored.paymentStatus,'pending'); assert.equal(stored.published,false);
  assert.equal(await c.ensureRegistrationCategories({}),false);
  stored.categories=[];
  assert.equal(await c.ensureRegistrationCategories({}),false);
  stored.categories=['wedding_dj'];
  assert.equal(await c.ensureRegistrationCategories({}),false);
});
test('actual public filters include Magician and preserve entertainment, keyword, location and dates', () => {
  const s=read('categories.html'); const c=context();
  vm.runInContext(s.slice(s.indexOf('const CATEGORY_GROUPS='),s.indexOf('const MAIN_CATEGORY_ORDER=')),c);
  for(const name of ['cleanArray','getVendorCategories','getMainCategoryForSubcategory','normalizeLocationText','getKeywordSearchText','vendorMatchesMainCategory','vendorMatchesSubcategory','vendorMatchesLocation','vendorMatchesKeyword','normalizeDateValue','vendorMatchesDate']) {
    const line=s.split('\n').find(l=>l.includes('function '+name+'(')); assert.ok(line,name); vm.runInContext(line,c);
  }
  const v=c.withRegistrationCategories({primaryCategory:'Magician',businessName:'Magic Show',displayLocation:'Sydney',blockedDates:['2026-12-01']});
  assert.equal(c.vendorMatchesMainCategory(v,'entertainment'),true);
  assert.equal(c.vendorMatchesSubcategory(v,'magician'),true);
  assert.equal(c.vendorMatchesKeyword(v,'magic'),true);
  assert.equal(c.vendorMatchesLocation(v,'Sydney'),true);
  assert.equal(c.vendorMatchesLocation(v,'Perth'),false);
  assert.equal(c.vendorMatchesDate(v,'2026-12-01'),false);
  assert.equal(c.vendorMatchesDate(v,'2026-12-02'),true);
  for(const slug of ['wedding_dj','wedding_singer','wedding_band']) {
    assert.equal(c.vendorMatchesMainCategory({categories:[slug]},'entertainment'),true);
    assert.equal(c.vendorMatchesSubcategory({categories:[slug]},slug),true);
    assert.equal(c.vendorMatchesSubcategory({categories:[slug]},'magician'),false);
  }
});
test('all interfaces use compatibility mapping and signup maps before checkout', () => {
  for(const name of ['admin-vendors.html','dashboard.html','categories.html','vendor.html']) assert.match(read(name),/withRegistrationCategories\([^)]*data\(\)/);
  const s=read('signup.html');
  assert.ok(s.indexOf("ensureRegistrationCategories(doc(db, 'vendors', uid))",s.indexOf('const vendorData')) < s.indexOf("callFunctionsApi('/create-checkout-session'"));
});

test('dashboard clears the legacy single category when removing all selections', () => {
  assert.match(read('dashboard.html'), /categories:cats, category:cats\[0\]\|\|""/);
  assert.match(read('admin-vendors.html'), /categories:\s*cats, category: cats\[0\]\|\|""/);
});
