"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { collectDocuments, authSnapshot } = require("./backup-production");

test("private backup preserves typed Firestore values across pagination", async () => {
  const one = { name: "projects/demo/databases/(default)/documents/vendors/one",
    fields: { timestamp: { timestampValue: "2026-10-20T00:00:00Z" } }, updateTime: "2026-10-20T00:00:00Z" };
  const two = { name: "projects/demo/databases/(default)/documents/vendors/two", fields: { founded: { booleanValue: true } } };
  let calls = 0;
  const result = await collectDocuments("https://firestore.googleapis.com/collection", async url => {
    assert.equal(new URL(url).searchParams.get("pageSize"), "1000");
    if (++calls === 1) return { documents: [one], nextPageToken: "page2" };
    assert.equal(new URL(url).searchParams.get("pageToken"), "page2");
    return { documents: [two] };
  });
  assert.deepEqual(result, [one, two]);
});

test("backup rejects repeated pages and malformed results instead of reporting completion", async () => {
  await assert.rejects(collectDocuments("https://firestore.googleapis.com/collection", async () => ({ documents: {}, nextPageToken: "x" })));
  await assert.rejects(collectDocuments("https://firestore.googleapis.com/collection", async () => ({ documents: [], nextPageToken: "x" })));
});

test("Auth claim snapshot preserves unrelated grants but excludes password material", () => {
  const snapshot = authSnapshot({ uid: "test", emailVerified: true, disabled: false,
    customClaims: { unrelated: "preserved", owdhComplimentaryVendor: true }, passwordHash: "do-not-export", passwordSalt: "do-not-export" });
  assert.deepEqual(snapshot.customClaims, { unrelated: "preserved", owdhComplimentaryVendor: true });
  assert.equal(snapshot.passwordHash, undefined);
  assert.equal(snapshot.passwordSalt, undefined);
});
