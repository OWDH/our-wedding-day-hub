"use strict";

// Existing Firestore complimentary markers are the baseline explicitly approved
// by the operator. No paid-only or Boutique-only records are promoted.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { execFileSync } = require("node:child_process");
const { isComplimentaryVendor } = require("./membership");
const PROJECT = "ourweddingdayhub";
const CLAIM = "owdhComplimentaryVendor";
const normalEmail = value => String(value || "").trim().toLowerCase();

function fields(document) {
  const result = {};
  for (const [key, value] of Object.entries(document.fields || {})) {
    if (Object.hasOwn(value, "booleanValue")) result[key] = value.booleanValue;
    else if (Object.hasOwn(value, "stringValue")) result[key] = value.stringValue;
  }
  return result;
}

function decision(vendor, user, auth) {
  if (!isComplimentaryVendor(vendor)) return "not_complimentary";
  if (vendor.accountStatus && vendor.accountStatus !== "active") return "restricted_vendor";
  if (!user || user.role !== "vendor") return "missing_or_nonvendor_user";
  if (!auth || auth.disabled) return "missing_or_disabled_auth";
  if (!normalEmail(auth.email)) return "missing_auth_email";
  // vendors.email is an independently editable public contact address (dashboard.html).
  // Identity is the shared document UID plus the users/Auth email, never that contact address.
  if (user.email && normalEmail(user.email) !== normalEmail(auth.email)) return "email_mismatch";
  if (vendor.email && normalEmail(vendor.email) !== normalEmail(auth.email)
    && normalEmail(user.email) !== normalEmail(auth.email)) return "email_mismatch";
  if (auth.customClaims && auth.customClaims[CLAIM] === false) return "explicit_server_denial";
  if (auth.customClaims && auth.customClaims[CLAIM] === true) return "already_granted";
  return "grant";
}

function claimsWithGrant(auth) {
  const claims = { ...(auth.customClaims || {}), [CLAIM]: true };
  if (Buffer.byteLength(JSON.stringify(claims), "utf8") > 1000) throw new Error("Claims limit exceeded");
  return claims;
}

function safeDiagnostic(error, token) {
  let message = String(error.message || "Unknown error");
  if (token) message = message.split(token).join("[redacted]");
  message = message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/ya29\.[A-Za-z0-9_.-]+/g, "[redacted]")
    .replace(/https?:\/\/[^\s"']+/g, "[endpoint]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]");
  return { name: error.name || "Error", message: message.slice(0, 500),
    operation: error.operation || null,
    causeCode: typeof (error.cause && error.cause.code) === "string" ? error.cause.code : null };
}

function readBackup(directory) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8"));
  if (!manifest.complete || manifest.project !== PROJECT) throw new Error("Complete project backup required");
  for (const required of ["vendors.firestore.json", "users.firestore.json", "auth-claims.json"]) {
    if (!manifest.files.some(file => file.name === required)) throw new Error("Required backup file is not verified");
  }
  for (const file of manifest.files) {
    if (path.basename(file.name) !== file.name) throw new Error("Invalid backup filename");
    const digest = crypto.createHash("sha256").update(fs.readFileSync(path.join(directory, file.name))).digest("hex");
    if (digest !== file.sha256) throw new Error("Backup checksum mismatch");
  }
  const read = name => JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"));
  return { manifest, vendors: read("vendors.firestore.json").documents,
    users: read("users.firestore.json").documents, auth: read("auth-claims.json").users };
}

function latestBackup() {
  const choices = [];
  for (const entry of fs.readdirSync(os.homedir(), { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("owdh-private-backup-")) continue;
    const directory = path.join(os.homedir(), entry.name);
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8"));
      if (manifest.complete && manifest.project === PROJECT) choices.push({ directory, startedAt: manifest.startedAt });
    } catch (_) { /* Ignore unfinished backups. */ }
  }
  choices.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  if (!choices.length) throw new Error("No complete backup");
  return choices[0].directory;
}

function planFromBackup(directory, backup) {
  const id = doc => doc.name.split("/").pop();
  const users = new Map(backup.users.map(doc => [id(doc), doc]));
  const auth = new Map(backup.auth.map(user => [user.uid, user]));
  const rows = backup.vendors.map(doc => {
    const uid = id(doc), userDoc = users.get(uid), authRecord = auth.get(uid);
    const vendor = fields(doc);
    return { uid, candidate: isComplimentaryVendor(vendor),
      decision: decision(vendor, userDoc ? fields(userDoc) : null, authRecord),
      vendorUpdateTime: doc.updateTime, userUpdateTime: userDoc && userDoc.updateTime };
  });
  return { project: PROJECT, createdAt: new Date().toISOString(), sourceBackup: directory,
    approvalBasis: "Operator explicitly approved the existing complimentary/founding records", rows };
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const checkLive = args.includes("--check-live");
  const planIndex = args.indexOf("--plan");
  let stage = "backup_validation", journalPath, app, accessToken;
  const counts = { granted: 0, alreadyGranted: 0, skipped: 0 };
  try {
    if (!apply && !checkLive) {
      const directory = latestBackup();
      const plan = planFromBackup(directory, readBackup(directory));
      const planPath = path.join(directory, "founding-migration-plan-" + Date.now() + ".json");
      fs.writeFileSync(planPath, JSON.stringify(plan, null, 2), { mode: 0o600, flag: "wx" });
      const reviewReasons = {};
      for (const row of plan.rows.filter(row => row.candidate && !["grant", "already_granted"].includes(row.decision))) {
        reviewReasons[row.decision] = (reviewReasons[row.decision] || 0) + 1;
      }
      console.log(JSON.stringify({ status: "DRY_RUN_COMPLETE", vendors: plan.rows.length,
        existingComplimentaryCandidates: plan.rows.filter(row => row.candidate).length,
        grantsProposed: plan.rows.filter(row => row.decision === "grant").length,
        alreadyGranted: plan.rows.filter(row => row.decision === "already_granted").length,
        reviewReasons, plan: planPath, productionWrites: 0 }, null, 2));
      return;
    }
    if (planIndex === -1 || !args[planIndex + 1]) throw new Error("Explicit plan path required");
    const planPath = path.resolve(args[planIndex + 1]);
    const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
    const directory = path.dirname(planPath);
    if (path.resolve(plan.sourceBackup) !== directory || plan.project !== PROJECT) throw new Error("Wrong project or backup");
    // Reconstruct eligible UIDs from the checksummed backup rather than trusting
    // an edited plan to grant arbitrary accounts.
    const baseline = planFromBackup(directory, readBackup(directory));
    const baselineRows = new Map(baseline.rows.map(row => [row.uid, row]));
    const selected = plan.rows.filter(row => row.decision === "grant");
    if (new Set(selected.map(row => row.uid)).size !== selected.length) throw new Error("Duplicate UID in plan");
    for (const row of selected) {
      const original = baselineRows.get(row.uid);
      if (!original || original.decision !== "grant" || original.vendorUpdateTime !== row.vendorUpdateTime
        || original.userUpdateTime !== row.userUpdateTime) throw new Error("Plan differs from approved baseline");
    }
    stage = "authentication";
    const token = execFileSync("gcloud", ["auth", "print-access-token"],
      { encoding: "utf8", timeout: 45000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    accessToken = token;
    const { initializeApp, deleteApp } = require("firebase-admin/app");
    const { getAuth } = require("firebase-admin/auth");
    app = initializeApp({ projectId: PROJECT,
      credential: { getAccessToken: async () => ({ access_token: token, expires_in: 3600 }) } }, "founder-migration");
    const auth = getAuth(app);
    const getDoc = async (collection, uid) => {
      const response = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/${collection}/${encodeURIComponent(uid)}`,
        { signal: AbortSignal.timeout(45000), headers: { Authorization: "Bearer " + token, "X-Goog-User-Project": PROJECT } });
      if (!response.ok) throw Object.assign(new Error("Read failed"), { status: response.status });
      return response.json();
    };
    const labelled = (operation, promise) => promise.catch(error => { error.operation = operation; throw error; });
    const readAccount = row => Promise.all([
      labelled("read_vendor_document", getDoc("vendors", row.uid)),
      labelled("read_user_document", getDoc("users", row.uid)),
      labelled("read_auth_user", auth.getUser(row.uid))
    ]);
    if (checkLive) {
      stage = "revalidate_account";
      if (!selected.length) throw new Error("No selected accounts in plan");
      const row = selected[0];
      const [vendorDoc, userDoc, user] = await readAccount(row);
      console.log(JSON.stringify({ status: "LIVE_CHECK_COMPLETE", checked: 1,
        decision: decision(fields(vendorDoc), fields(userDoc), user),
        vendorUnchanged: vendorDoc.updateTime === row.vendorUpdateTime,
        userUnchanged: userDoc.updateTime === row.userUpdateTime, productionWrites: 0 }, null, 2));
      return;
    }
    journalPath = path.join(directory, "founding-migration-results-" + Date.now() + ".json");
    const journal = { project: PROJECT, plan: planPath, startedAt: new Date().toISOString(), complete: false, results: [] };
    const save = () => fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2), { mode: 0o600 });
    save();
    for (const row of selected) {
      stage = "revalidate_account";
      const [vendorDoc, userDoc, user] = await readAccount(row);
      const currentDecision = decision(fields(vendorDoc), fields(userDoc), user);
      if (currentDecision === "already_granted") {
        counts.alreadyGranted++; journal.results.push({ uid: row.uid, result: "already_granted" }); save(); continue;
      }
      if (currentDecision !== "grant" || vendorDoc.updateTime !== row.vendorUpdateTime || userDoc.updateTime !== row.userUpdateTime) {
        counts.skipped++; journal.results.push({ uid: row.uid, result: "skipped_changed_or_restricted", reason: currentDecision }); save(); continue;
      }
      // Refresh claims immediately before setting the merged value. The public
      // invitation endpoint is not yet deployed; do not run competing claim writers.
      const latest = await auth.getUser(row.uid);
      if (latest.disabled || normalEmail(latest.email) !== normalEmail(user.email)
        || latest.customClaims && latest.customClaims[CLAIM] === false) {
        counts.skipped++; journal.results.push({ uid: row.uid, result: "skipped_auth_changed" }); save(); continue;
      }
      const merged = claimsWithGrant(latest);
      const result = { uid: row.uid, result: "claim_write_pending", beforeClaims: latest.customClaims || {}, expectedClaims: merged };
      journal.results.push(result); save();
      stage = "set_custom_claim";
      await auth.setCustomUserClaims(row.uid, merged);
      stage = "verify_custom_claim";
      const verified = await auth.getUser(row.uid);
      if (!isDeepStrictEqual(verified.customClaims, merged)) throw new Error("Claims verification failed");
      result.result = "granted_and_verified"; counts.granted++; save();
    }
    journal.complete = true; journal.completedAt = new Date().toISOString(); save();
    await deleteApp(app); app = null;
    console.log(JSON.stringify({ status: counts.skipped ? "MIGRATION_REQUIRES_REVIEW" : "MIGRATION_COMPLETE",
      ...counts, journal: journalPath, firestoreWrites: 0, stripeWrites: 0 }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ status: "MIGRATION_STOPPED", stage, ...counts, journal: journalPath,
      code: typeof error.code === "string" || typeof error.code === "number" ? error.code : null,
      httpStatus: error.status || null, diagnostic: safeDiagnostic(error, accessToken) }));
    process.exitCode = 1;
  } finally {
    if (app) await require("firebase-admin/app").deleteApp(app);
  }
}

module.exports = { fields, decision, claimsWithGrant, planFromBackup, safeDiagnostic };
if (require.main === module) main();
