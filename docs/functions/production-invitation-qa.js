"use strict";

// Operator-run production QA. Never accepts a customer UID or prints credentials.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { initializeApp, deleteApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { createInviteToken, invitationDocumentId } = require("./founding-invites");
const PROJECT = "ourweddingdayhub";
const ROOT = `projects/${PROJECT}/databases/(default)/documents`;
const API = `https://us-central1-${PROJECT}.cloudfunctions.net/api`;
const CLAIM = "owdhComplimentaryVendor";

function selectQaAccount(users, nextPage) {
  assert.ok(!nextPage, "Incomplete Auth inventory");
  const choices = users.filter(u => /^owdh-qa-[a-f0-9]{12}@example\.com$/.test(u.email || "")
    && u.displayName === "TTM QA Test Vendor" && !u.disabled);
  assert.equal(choices.length, 1, "Exactly one dedicated QA account required");
  return choices[0];
}

function assertQaDocuments(account, user, vendor) {
  for (const doc of [user, vendor]) {
    assert.equal(doc.fields?.isTestAccount?.booleanValue, true, "Dedicated QA marker required");
    assert.equal(doc.fields?.email?.stringValue, account.email, "QA identity mismatch");
  }
  assert.equal(user.fields.role?.stringValue, "vendor");
  assert.equal(vendor.fields.uid?.stringValue, account.uid);
  for (const field of ["published", "profileVisible", "visible"]) {
    assert.equal(vendor.fields[field]?.booleanValue, false, "QA profile must be hidden");
  }
  assert.equal(vendor.fields.accountStatus?.stringValue, "active");
  assert.ok(!vendor.fields.stripeCustomerId && !vendor.fields.stripeSubscriptionId,
    "QA account must not be linked to Stripe");
}

async function main() {
  let app, auth, account, original, oauth, journalPath, stage = "setup", mutated = false;
  const created = [];
  const saveJournal = status => {
    if (journalPath) fs.writeFileSync(journalPath, JSON.stringify({ project: PROJECT,
      uid: account.uid, original, invitationIds: created, status }, null, 2), { mode: 0o600 });
  };
  const check = async (label, run) => {
    stage = label;
    await run();
    console.log(`PASS ${label}`);
  };
  const request = async (url, options = {}) => {
    const response = await fetch(url, { ...options, signal: AbortSignal.timeout(30000) });
    const value = await response.json().catch(() => ({}));
    return { status: response.status, value };
  };
  const firestore = (relative, method = "GET", body) => request(
    `https://firestore.googleapis.com/v1/${ROOT}${relative}`, {
      method, headers: { Authorization: `Bearer ${oauth}`, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
  try {
    oauth = execFileSync("gcloud", ["auth", "print-access-token"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    app = initializeApp({ projectId: PROJECT, credential: {
      getAccessToken: async () => ({ access_token: oauth, expires_in: 3600 })
    } }, "production-invitation-qa");
    auth = getAuth(app);
    const page = await auth.listUsers(1000);
    account = selectQaAccount(page.users, page.pageToken);
    const user = await firestore(`/users/${account.uid}`);
    const vendor = await firestore(`/vendors/${account.uid}`);
    assert.equal(user.status, 200); assert.equal(vendor.status, 200);
    assertQaDocuments(account, user.value, vendor.value);
    const config = fs.readFileSync(path.join(__dirname, "../firebase.js"), "utf8");
    const apiKey = config.match(/apiKey:\s*["']([^"']+)["']/)?.[1];
    assert.ok(apiKey, "Public Firebase configuration required");
    stage = "test_account_login";
    const password = execFileSync("python3", ["-c",
      "import getpass; print(getpass.getpass('Test vendor password (hidden): '))"],
    { encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] }).trim();
    const login = await request(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: account.email, password, returnSecureToken: true })
    });
    assert.equal(login.status, 200, "Test vendor login failed");
    assert.equal(login.value.localId, account.uid, "Login must match dedicated QA UID");
    const idToken = login.value.idToken;
    const call = (route, body) => request(`${API}/${route}`, {
      method: "POST", headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body || {})
    });
    stage = "read_signing_key";
    const secret = execFileSync("gcloud", ["secrets", "versions", "access", "1",
      "--secret=FOUNDING_INVITE_SIGNING_KEY", `--project=${PROJECT}`],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const invite = async (email, expiryOffset = 600000, redeemedBy) => {
      const token = createInviteToken();
      const id = invitationDocumentId(token, secret);
      const fields = { active: { booleanValue: true }, email: { stringValue: email },
        expiresAt: { timestampValue: new Date(Date.now() + expiryOffset).toISOString() },
        isTestAccount: { booleanValue: true } };
      if (redeemedBy) fields.redeemedBy = { stringValue: redeemedBy };
      // Journal the generated path before a potentially ambiguous network result.
      created.push(id);
      saveJournal("running");
      const result = await firestore(":commit", "POST", { writes: [{
        update: { name: `${ROOT}/foundingVendorInvites/${id}`, fields },
        currentDocument: { exists: false }
      }] });
      assert.equal(result.status, 200, "QA invitation creation failed");
      return { token, id };
    };
    original = { claims: account.customClaims || {}, emailVerified: account.emailVerified };
    assert.equal(original.claims[CLAIM], true, "QA account must start with its expected test grant");
    journalPath = path.join(os.homedir(), `owdh-qa-recovery-${Date.now()}.json`);
    fs.writeFileSync(journalPath, "", { flag: "wx", mode: 0o600 });
    saveJournal("running");
    const deniedClaims = { ...original.claims };
    delete deniedClaims[CLAIM];
    mutated = true;
    await auth.setCustomUserClaims(account.uid, deniedClaims);
    await check("legacy profile flags alone do not grant membership", async () => {
      const result = await call("verify-membership");
      assert.equal(result.status, 200); assert.equal(result.value.access, false);
    });
    const valid = await invite(account.email);
    await auth.updateUser(account.uid, { emailVerified: false });
    await check("unverified account rejected", async () => {
      assert.equal((await call("redeem-founding-invite", { token: valid.token })).status, 403);
    });
    await auth.updateUser(account.uid, { emailVerified: true });
    for (const [label, token, expected] of [
      ["malformed token rejected", "not-a-valid-invitation", 400],
      ["wrong email rejected", (await invite("owdh-qa-wrong@example.com")).token, 403],
      ["expired invitation rejected", (await invite(account.email, -60000)).token, 403],
      ["invitation used by another UID rejected", (await invite(account.email, 600000, "owdh-qa-other-uid")).token, 403]
    ]) {
      await check(label, async () => {
        assert.equal((await call("redeem-founding-invite", { token })).status, expected);
        assert.notEqual((await auth.getUser(account.uid)).customClaims?.[CLAIM], true);
      });
    }
    await check("concurrent redemption succeeds for the intended vendor", async () => {
      const results = await Promise.all([1, 2].map(() => call("redeem-founding-invite", { token: valid.token })));
      for (const result of results) {
        assert.equal(result.status, 200); assert.equal(result.value.access, true);
      }
      const saved = await firestore(`/foundingVendorInvites/${valid.id}`);
      assert.equal(saved.status, 200);
      assert.equal(saved.value.fields.redeemedBy?.stringValue, account.uid);
      assert.ok(saved.value.fields.redeemedAt?.timestampValue);
      assert.equal((await auth.getUser(account.uid)).customClaims?.[CLAIM], true);
    });
    await check("server grant unlocks membership", async () => {
      const result = await call("verify-membership");
      assert.equal(result.status, 200); assert.equal(result.value.access, true);
      assert.equal(result.value.source, "complimentary");
    });
    console.log("INVITATION_QA_PASSED");
  } catch (_) {
    // Never print error bodies, tokens, passwords or secret values.
    console.error(`INVITATION_QA_FAILED at ${stage}; previous PASS lines show progress.`);
    process.exitCode = 1;
  } finally {
    let cleanupOk = true;
    if (mutated) {
      try {
        await auth.updateUser(account.uid, { emailVerified: original.emailVerified });
        await auth.setCustomUserClaims(account.uid, original.claims);
        const restored = await auth.getUser(account.uid);
        assert.deepEqual(restored.customClaims || {}, original.claims);
        assert.equal(restored.emailVerified, original.emailVerified);
      } catch (_) { cleanupOk = false; }
    }
    for (const id of created) {
      try {
        const result = await firestore(`/foundingVendorInvites/${id}`, "DELETE");
        if (![200, 404].includes(result.status)) cleanupOk = false;
      } catch (_) { cleanupOk = false; }
    }
    console.log(cleanupOk ? "QA_CLEANUP_COMPLETE" : "QA_CLEANUP_NEEDS_REVIEW");
    saveJournal(cleanupOk ? "cleanup_complete" : "cleanup_needs_review");
    if (!cleanupOk && journalPath) console.log("Private recovery journal:", journalPath);
    if (!cleanupOk) process.exitCode = 1;
    if (app) await deleteApp(app);
  }
}

module.exports = { selectQaAccount, assertQaDocuments };
if (require.main === module) main();
