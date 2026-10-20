"use strict";

// Read-only production snapshot. Private output is always outside the repository.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const PROJECT = "ourweddingdayhub";

async function collectDocuments(baseUrl, readJson) {
  const documents = [];
  const seen = new Set();
  let pageToken;
  do {
    const url = new URL(baseUrl);
    url.searchParams.set("pageSize", "1000");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const result = await readJson(url.toString());
    if (result.documents !== undefined && !Array.isArray(result.documents)) throw new Error("Unexpected document response");
    documents.push(...(result.documents || []));
    pageToken = result.nextPageToken;
    if (pageToken && seen.has(pageToken)) throw new Error("Repeated pagination token");
    if (pageToken) seen.add(pageToken);
  } while (pageToken);
  return documents;
}

function authSnapshot(user) {
  return { uid: user.uid, email: user.email || null, emailVerified: user.emailVerified,
    disabled: user.disabled, customClaims: user.customClaims || {}, tenantId: user.tenantId || null };
}

async function main() {
  let stage = "initialisation";
  let directory;
  let app;
  try {
    directory = fs.mkdtempSync(path.join(os.homedir(), "owdh-private-backup-"));
    fs.chmodSync(directory, 0o700);
    const manifest = { project: PROJECT, startedAt: new Date().toISOString(), complete: false,
      purpose: "Pre-migration snapshot; not an atomic database export", files: [], counts: {} };
    const write = (name, value) => {
      const content = JSON.stringify(value, null, 2) + "\n";
      fs.writeFileSync(path.join(directory, name), content, { mode: 0o600, flag: "wx" });
      manifest.files.push({ name, sha256: crypto.createHash("sha256").update(content).digest("hex") });
    };
    fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    stage = "gcloud_authentication";
    // Capture the existing user's token in memory; never print or persist it.
    const token = execFileSync("gcloud", ["auth", "print-access-token"],
      { encoding: "utf8", timeout: 45000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (!token) throw new Error("No access token");
    const readJson = async url => {
      const result = await fetch(url, { method: "GET", signal: AbortSignal.timeout(45000),
        headers: { Authorization: "Bearer " + token, "X-Goog-User-Project": PROJECT } });
      if (!result.ok) throw Object.assign(new Error("Read failed"), { status: result.status });
      return result.json();
    };
    for (const collection of ["vendors", "users", "foundingVendorInvites"]) {
      stage = "firestore_" + collection;
      const documents = await collectDocuments(
        `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/${collection}`, readJson);
      // Preserve REST typed values, document names and update times for restoration.
      write(collection + ".firestore.json", { collection, documents });
      manifest.counts[collection] = documents.length;
      if (collection !== "foundingVendorInvites" && documents.length === 0) throw new Error("Expected production records missing");
    }
    stage = "authentication_claims";
    const { initializeApp } = require("firebase-admin/app");
    const { getAuth } = require("firebase-admin/auth");
    app = initializeApp({ projectId: PROJECT,
      credential: { getAccessToken: async () => ({ access_token: token, expires_in: 3600 }) } }, "production-backup");
    const users = [];
    let nextPageToken;
    do {
      const page = await getAuth(app).listUsers(1000, nextPageToken);
      users.push(...page.users.map(authSnapshot));
      nextPageToken = page.pageToken;
    } while (nextPageToken);
    write("auth-claims.json", { users });
    manifest.counts.authUsers = users.length;
    if (users.length === 0) throw new Error("Expected production Auth users missing");
    manifest.counts.serverComplimentaryClaims = users.filter(u => u.customClaims.owdhComplimentaryVendor === true).length;
    stage = "firestore_rules";
    const release = await readJson(`https://firebaserules.googleapis.com/v1/projects/${PROJECT}/releases/cloud.firestore`);
    if (!release.rulesetName || !release.rulesetName.startsWith(`projects/${PROJECT}/rulesets/`)) throw new Error("Unexpected ruleset");
    write("firestore-release.json", release);
    write("firestore-ruleset.json", await readJson("https://firebaserules.googleapis.com/v1/" + release.rulesetName));
    stage = "firestore_indexes";
    write("firestore-indexes.json", await collectIndexes(readJson));
    for (const name of ["api", "stripeWebhook", "convertToWebP"]) {
      stage = "function_configuration_" + name;
      const metadata = execFileSync("gcloud", ["functions", "describe", name, "--gen2", "--region=us-central1",
        "--project=" + PROJECT, "--format=json"], { encoding: "utf8", timeout: 45000, stdio: ["ignore", "pipe", "ignore"] });
      write(name + ".function.json", JSON.parse(metadata));
    }
    stage = "project_permissions";
    const iam = execFileSync("gcloud", ["projects", "get-iam-policy", PROJECT, "--format=json"],
      { encoding: "utf8", timeout: 45000, stdio: ["ignore", "pipe", "ignore"] });
    write("project-iam.json", JSON.parse(iam));
    // Read each saved file back and verify it before marking this backup complete.
    for (const file of manifest.files) {
      const checksum = crypto.createHash("sha256").update(fs.readFileSync(path.join(directory, file.name))).digest("hex");
      if (checksum !== file.sha256) throw new Error("Backup verification failed");
    }
    manifest.complete = true;
    manifest.completedAt = new Date().toISOString();
    fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ status: "BACKUP_COMPLETE", project: PROJECT, directory,
      files: manifest.files.length, ...manifest.counts, productionWrites: 0 }, null, 2));
  } catch (error) {
    // No API response bodies, credentials or customer records go to stdout/stderr.
    console.error(JSON.stringify({ status: "BACKUP_INCOMPLETE", stage, directory,
      code: typeof error.code === "string" || typeof error.code === "number" ? error.code : null,
      httpStatus: error.status || null, productionWrites: 0 }));
    process.exitCode = 1;
  } finally {
    if (app) await require("firebase-admin/app").deleteApp(app);
  }
}

async function collectIndexes(readJson) {
  const indexes = [];
  let pageToken;
  do {
    const url = new URL(`https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/collectionGroups/-/indexes`);
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const page = await readJson(url.toString());
    indexes.push(...(page.indexes || []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return { indexes };
}

module.exports = { collectDocuments, authSnapshot };
if (require.main === module) main();
