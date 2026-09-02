const { onRequest } = require("firebase-functions/v2/https");
const { onObjectFinalized } = require("firebase-functions/v2/storage");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");
const { Resend } = require("resend");
const sharp = require("sharp");
const path = require("path");
const os = require("os");
const fs = require("fs");
const {
  PRICE_IDS,
  normalizePlan,
  resolvePlanPriceId,
  checkoutIdempotencyKey,
  customerIdempotencyKey,
  subscriptionGrantsAccess,
  sessionGrantsAccess,
  isComplimentaryVendor,
  stripeObjectId,
  invoiceSubscriptionId,
  uidFromStripeObject,
  customerEmailFromStripeObject,
  stripeEventClaimDecision,
  grantMembershipPatch,
  revokeMembershipPatch,
  nextCheckoutAttempt
} = require("./membership");

admin.initializeApp();

const db = admin.firestore();

const stripeSecret = defineSecret("STRIPE_SECRET_KEY");
const stripeWebhookSecret = defineSecret("STRIPE_WEBHOOK_SECRET");
const resendApiKey = defineSecret("RESEND_API_KEY");

const constantContactClientSecret = defineSecret("CONSTANT_CONTACT_CLIENT_SECRET");
const constantContactRefreshToken = defineSecret("CONSTANT_CONTACT_REFRESH_TOKEN");
const constantContactVendorListId = defineSecret("CONSTANT_CONTACT_VENDOR_LIST_ID");
const constantContactCoupleListId = defineSecret("CONSTANT_CONTACT_COUPLE_LIST_ID");

const CONSTANT_CONTACT_CLIENT_ID = "b5586c07-4edd-442e-af03-cba30ffa9f1a";
const FROM_EMAIL = "noreply@ourweddingdayhub.com";
const SITE_URL = "https://ourweddingdayhub.com";

const app = express();

app.use(cors({ origin: true }));
app.use((req, res, next) => {
  if (req.path === "/stripe-webhook") {
    return express.raw({ type: "application/json" })(req, res, next);
  }
  return express.json()(req, res, next);
});
