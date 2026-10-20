"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");

test("production exports load with real Firebase SDKs and native image dependencies", () => {
  const child = spawnSync(process.execPath, ["-e", `
    const assert = require('node:assert/strict');
    const { getAuth } = require('firebase-admin/auth');
    const { getFirestore, FieldValue } = require('firebase-admin/firestore');
    const { getStorage } = require('firebase-admin/storage');
    require('sharp');
    const functions = require('./index');
    for (const name of ['api', 'stripeWebhook', 'convertToWebP']) {
      assert.equal(typeof functions[name], 'function', name);
    }
    assert.equal(typeof getAuth().setCustomUserClaims, 'function');
    assert.equal(typeof getFirestore().runTransaction, 'function');
    assert.equal(typeof FieldValue.serverTimestamp, 'function');
    assert.equal(typeof getStorage().bucket, 'function');
  `], { cwd: __dirname, encoding: "utf8", timeout: 15000,
    env: { ...process.env, GCLOUD_PROJECT: "demo-owdh-runtime-check" } });
  assert.equal(child.status, 0, child.stderr || String(child.error || "Runtime load failed"));
});
