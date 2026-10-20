"use strict";
const { createHmac, randomBytes } = require("node:crypto");

const INVITE_TOKEN_PATTERN = /^fvi_[A-Za-z0-9_-]{43}$/;
const COMPLIMENTARY_CLAIM = "owdhComplimentaryVendor";
const INVITE_COLLECTION = "foundingVendorInvites";

function createInviteToken() {
  return "fvi_" + randomBytes(32).toString("base64url");
}

function invitationDocumentId(token, secretKey) {
  if (typeof token !== "string" || !INVITE_TOKEN_PATTERN.test(token)) {
    throw new Error("Invalid invitation format.");
  }
  if (typeof secretKey !== "string" || !/^[A-Za-z0-9_-]{43,}$/.test(secretKey)
      || Buffer.from(secretKey, "base64url").length < 32) {
    throw new Error("A strong founding invitation signing key is required.");
  }
  return createHmac("sha256", Buffer.from(secretKey, "base64url")).update(token, "utf8").digest("hex");
}

function normaliseInviteEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function isValidInviteRecord(invite, email, now = Date.now()) {
  if (!invite || invite.active !== true || !invite.email) return false;
  if (normaliseInviteEmail(invite.email) !== normaliseInviteEmail(email)) return false;
  const expiresAt = invite.expiresAt && typeof invite.expiresAt.toMillis === "function"
    ? invite.expiresAt.toMillis() : NaN;
  return Number.isFinite(expiresAt) && expiresAt > now;
}

function hasVerifiedComplimentaryClaim(userRecord) {
  return Boolean(userRecord && userRecord.customClaims
    && userRecord.customClaims[COMPLIMENTARY_CLAIM] === true);
}

module.exports = {
  COMPLIMENTARY_CLAIM,
  INVITE_COLLECTION,
  INVITE_TOKEN_PATTERN,
  createInviteToken,
  invitationDocumentId,
  normaliseInviteEmail,
  isValidInviteRecord,
  hasVerifiedComplimentaryClaim
};
