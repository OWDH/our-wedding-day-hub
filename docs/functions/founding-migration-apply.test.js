"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const vm = require("node:vm");
const { planFromBackup } = require("./migrate-existing-founders");
const { safeDiagnostic } = require("./migrate-existing-founders");

test("migration diagnostics exclude live tokens, endpoints and email addresses", () => {
  const token = "exact-private-access-token";
  const result = safeDiagnostic(new Error(token + " Bearer another-token https://example.test/private v@example.test"), token);
  for (const secret of [token, "another-token", "example.test", "v@example.test"]) assert.equal(result.message.includes(secret), false);
});

async function runMigration({ changed = false, disabled = false, serverClaim, forged = false, lostWriteResponse = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "owdh-migration-test-"));
  try {
    const vendor = { name: "projects/p/databases/(default)/documents/vendors/vendor", updateTime: "vendor-original",
      fields: { founding: { booleanValue: true }, email: { stringValue: "v@example.test" } } };
    const userDoc = { name: "projects/p/databases/(default)/documents/users/vendor", updateTime: "user-original",
      fields: { role: { stringValue: "vendor" }, email: { stringValue: "v@example.test" } } };
    const authUser = { uid: "vendor", email: "v@example.test", disabled: false, customClaims: { otherGrant: "keep" } };
    const backup = { vendors: [vendor], users: [userDoc], auth: [authUser] };
    const files = [];
    for (const [name, data] of Object.entries({ "vendors.firestore.json": { documents: backup.vendors },
      "users.firestore.json": { documents: backup.users }, "auth-claims.json": { users: backup.auth } })) {
      const content = JSON.stringify(data);
      fs.writeFileSync(path.join(directory, name), content);
      files.push({ name, sha256: crypto.createHash("sha256").update(content).digest("hex") });
    }
    fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify({ complete: true, project: "ourweddingdayhub", files }));
    const plan = planFromBackup(directory, backup);
    if (forged) plan.rows[0].uid = "unapproved-account";
    const planPath = path.join(directory, "plan.json");
    fs.writeFileSync(planPath, JSON.stringify(plan));
    let claims = { otherGrant: "keep" };
    if (serverClaim !== undefined) claims.owdhComplimentaryVendor = serverClaim;
    let writes = 0, journalBeforeWrite;
    const fakeAuth = {
      getUser: async () => ({ ...authUser, disabled, customClaims: claims }),
      setCustomUserClaims: async (uid, value) => {
        assert.equal(uid, "vendor");
        const journalFile = fs.readdirSync(directory).find(name => name.startsWith("founding-migration-results-"));
        journalBeforeWrite = JSON.parse(fs.readFileSync(path.join(directory, journalFile), "utf8"));
        writes++; claims = value;
        if (lostWriteResponse) throw new Error("Write response lost");
      }
    };
    const modules = {
      "node:child_process": { execFileSync: () => "fixture-token-never-log" },
      "firebase-admin/app": { initializeApp: () => ({}), deleteApp: async () => {} },
      "firebase-admin/auth": { getAuth: () => fakeAuth }
    };
    const logs = [], errors = [];
    const processStub = { argv: ["node", "migration.js", "--apply", "--plan", planPath] };
    const sandbox = { require: name => modules[name] || require(name), module: { exports: {} },
      process: processStub, Buffer, AbortSignal, console: { log: s => logs.push(JSON.parse(s)), error: s => errors.push(JSON.parse(s)) },
      fetch: async (url, options) => {
        assert.equal(options.method || "GET", "GET");
        return { ok: true, json: async () => url.includes("/vendors/") ? { ...vendor, updateTime: changed ? "changed" : vendor.updateTime } : userDoc };
      }
    };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(__dirname + "/migrate-existing-founders.js", "utf8") + "\nmodule.exports.run = main;", sandbox);
    await sandbox.module.exports.run();
    assert.equal(JSON.stringify({ logs, errors }).includes("fixture-token-never-log"), false);
    return { logs, errors, writes, claims, journalBeforeWrite, exitCode: processStub.exitCode };
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

test("actual apply journals first, preserves unrelated claims and verifies a single grant", async () => {
  const result = await runMigration();
  assert.equal(result.writes, 1);
  assert.equal(result.claims.otherGrant, "keep");
  assert.equal(result.claims.owdhComplimentaryVendor, true);
  assert.equal(result.journalBeforeWrite.results[0].result, "claim_write_pending");
  assert.equal(result.journalBeforeWrite.results[0].beforeClaims.otherGrant, "keep");
  assert.equal(result.logs[0].status, "MIGRATION_COMPLETE");
  assert.equal(result.logs[0].granted, 1);
  assert.equal(result.logs[0].firestoreWrites, 0);
  assert.equal(result.logs[0].stripeWrites, 0);
});
test("apply skips changed Firestore records without granting access", async () => {
  const result = await runMigration({ changed: true });
  assert.equal(result.writes, 0);
  assert.equal(result.logs[0].status, "MIGRATION_REQUIRES_REVIEW");
  assert.equal(result.logs[0].skipped, 1);
});
test("apply skips disabled users and explicit server denials", async () => {
  for (const options of [{ disabled: true }, { serverClaim: false }]) {
    const result = await runMigration(options);
    assert.equal(result.writes, 0);
    assert.equal(result.logs[0].skipped, 1);
  }
});
test("reapplying a previously granted account does not rewrite claims", async () => {
  const result = await runMigration({ serverClaim: true });
  assert.equal(result.writes, 0);
  assert.equal(result.logs[0].alreadyGranted, 1);
});
test("modified plan cannot introduce an account absent from the approved backup", async () => {
  const result = await runMigration({ forged: true });
  assert.equal(result.writes, 0);
  assert.equal(result.errors[0].status, "MIGRATION_STOPPED");
  assert.equal(result.exitCode, 1);
});
test("lost claim-write response stops safely with a pre-write recovery journal", async () => {
  const result = await runMigration({ lostWriteResponse: true });
  assert.equal(result.writes, 1);
  assert.equal(result.errors[0].status, "MIGRATION_STOPPED");
  assert.equal(result.claims.owdhComplimentaryVendor, true);
  assert.equal(result.journalBeforeWrite.results[0].beforeClaims.otherGrant, "keep");
});
