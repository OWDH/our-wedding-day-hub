"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createInviteToken, invitationDocumentId, isValidInviteRecord,
  hasVerifiedComplimentaryClaim, INVITE_TOKEN_PATTERN
} = require("./founding-invites");
const { createHash } = require("node:crypto");
const key = createHash("sha256").update("fixture-only-not-production").digest("base64url");

test("tokens are high entropy and only server keyed digests are stored", () => {
  const one = createInviteToken(), two = createInviteToken();
  assert.match(one, INVITE_TOKEN_PATTERN);
  assert.notEqual(one, two);
  assert.match(invitationDocumentId(one, key), /^[0-9a-f]{64}$/);
  assert.notEqual(invitationDocumentId(one, key), invitationDocumentId(two, key));
});

test("short secrets and legacy publicly known invite code cannot be redeemed", () => {
  assert.throws(() => invitationDocumentId("foundingvendor2026", key));
  assert.throws(() => invitationDocumentId(createInviteToken(), "short"));
});

test("invites are email bound, time limited and server-activated", () => {
  const record = { active: true, email: "Vendor@Example.test",
    expiresAt: { toMillis: () => 2000 } };
  assert.equal(isValidInviteRecord(record, "vendor@example.test", 1000), true);
  assert.equal(isValidInviteRecord(record, "other@example.test", 1000), false);
  assert.equal(isValidInviteRecord(record, "vendor@example.test", 2000), false);
  assert.equal(isValidInviteRecord({ ...record, active: false }, "vendor@example.test", 1000), false);
  assert.equal(hasVerifiedComplimentaryClaim({customClaims:{owdhComplimentaryVendor:true}}), true);
  assert.equal(hasVerifiedComplimentaryClaim({customClaims:{}}), false);
});
