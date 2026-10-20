"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function loadPage({ verified = true, apiError = false, response = { access: true }, search = "?invite=fvi_test" } = {}) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { hidden: false, dataset: {}, classList: { toggle() {} },
      addEventListener(name, fn) { this[name] = fn; } });
    return elements.get(id);
  };
  const calls = [];
  const user = { uid: "vendor", emailVerified: verified, async reload() { calls.push("reload"); },
    async getIdToken(force) { calls.push(["refresh", force]); } };
  let authChanged;
  const location = { search, href: "payment-required.html" };
  const context = { URLSearchParams, navigator: { language: "en-AU" }, console: { warn() {}, error() {} },
    window: { location, history: { replaceState(...args) { calls.push(["history", ...args]); } } },
    document: { getElementById: element, querySelector: element, querySelectorAll: () => [] },
    auth: {}, onAuthStateChanged(_auth, fn) { authChanged = fn; },
    async callFunctionsApi(path, options) {
      calls.push([path, options]);
      if (apiError) throw new Error("service unavailable");
      return response;
    }, async sendEmailVerification() { calls.push("email"); }, signOut() {},
  };
  const html = fs.readFileSync(__dirname + "/../payment-required.html", "utf8");
  const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1].replace(/^\s*import[^\n]+\n/m, "");
  vm.runInNewContext(script, context);
  return { calls, user, location, element, login: () => authChanged(user),
    click: () => element("goToPaymentBtn").click({ preventDefault() {} }) };
}

test("verified invitation redeems on the server, refreshes claims and opens dashboard", async () => {
  const page = loadPage();
  await page.login();
  assert.equal(page.calls[0], "reload");
  const redemption = page.calls.find(c => c[0] === "/redeem-founding-invite");
  assert.equal(redemption[1].body.token, "fvi_test");
  assert.ok(page.calls.some(c => c[0] === "refresh" && c[1] === true));
  assert.ok(page.calls.some(c => c[0] === "history" && c[3] === "payment-required.html"));
  assert.equal(page.location.href, "dashboard.html");
  assert.equal(page.element("tierGrid").hidden, true);
});

test("unverified email can resend and retry after verification without checkout", async () => {
  const page = loadPage({ verified: false });
  await page.login();
  assert.equal(page.calls.filter(c => Array.isArray(c)).length, 0);
  assert.equal(page.element("resendVerificationBtn").hidden, false);
  await page.element("resendVerificationBtn").click();
  assert.ok(page.calls.includes("email"));
  page.user.emailVerified = true;
  await page.click();
  assert.equal(page.location.href, "dashboard.html");
  assert.equal(page.calls.some(c => c[0] === "/create-checkout-session"), false);
});

test("invalid, expired or unavailable invitation stays recoverable without payment or redirect", async () => {
  for (const options of [{ apiError: true }, { response: { access: false } }]) {
    const page = loadPage(options);
    await page.login();
    await page.click();
    assert.equal(page.location.href, "payment-required.html");
    assert.equal(page.calls.some(c => c[0] === "/create-checkout-session"), false);
    assert.match(page.element("prStatus").textContent, /could not activate/);
  }
});

test("ordinary unpaid signup retains membership check and paid checkout", async () => {
  const page = loadPage({ search: "", response: { access: false } });
  await page.login();
  await page.click();
  assert.ok(page.calls.some(c => c[0] === "/verify-membership"));
  assert.ok(page.calls.some(c => c[0] === "/create-checkout-session"));
  assert.equal(page.calls.some(c => c[0] === "/redeem-founding-invite"), false);
});
