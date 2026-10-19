# Founding-vendor invitation security rollout

**Do not merge the frontend change before the Firebase backend is deployed.** The public site uses GitHub Pages and the API uses separately deployed Cloud Functions. Until backend deployment, invitation redemption will fail safely without granting free access.

## Scope

- Remove the publicly embedded legacy code and any client-side write of complimentary membership statuses.
- Authenticate vendors with Firebase ID tokens and a matching existing `users` document with role `vendor`.
- Require a verified Firebase Auth email address matching the invitation.
- Accept **only** high-entropy `fvi_` invitation tokens, authenticated through a server-secret HMAC digest; do not store raw tokens in Firestore.
- The server transaction marks a private invitation as redeemed by the vendor's UID. Only Firebase Admin grants the `owdhComplimentaryVendor` Firebase Auth custom claim.
- `verify-membership` and checkout prevention check **Firebase Admin claims** instead of reading complimentary flags from mutable vendor records.

## REQUIRED before switching production traffic

1. Obtain authorised Firebase project `ourweddingdayhub` admin access, record the current Firestore rules and IAM accounts, and back up existing vendor and user records.
2. Query and individually verify the genuinely complimentary/founding vendors using historical entitlements and approved owner records. **Do not infer entitlement only from client-editable flags**. Set custom claim `owdhComplimentaryVendor:true` for each verified UID with Firebase Admin; retain other existing claims. Check the count against the approved list before enabling the new gate.
3. Generate a 32-byte random signing key, encoded as base64url, using a secure secret manager. Store it as Firebase Functions secret `FOUNDING_INVITE_SIGNING_KEY`, never in code, logs or chat. Issue *new* per-vendor invitations, not the published legacy code.
4. Add private documents `foundingVendorInvites/<HMAC_SHA256(secret,token)>` with `{active:true,email:"invited@example.com",expiresAt:Firestore.Timestamp.fromDate(...)}`. Generate tokens with `createInviteToken()` from `docs/functions/founding-invites.js`; share each token privately with its intended vendor only. Tokens are redeemed at most once.
5. Verify deployed Firestore security rules explicitly **deny all client writes** to `foundingVendorInvites`, `stripeEvents`, and protected vendor fields: `paymentStatus`, `subscriptionActive`, `paidSetupFee`, `complimentaryPlan`, `plan`, `accessType`, `founding`, `foundingVendor`, `shopAccess`, `stripeCustomerId`, `stripeSubscriptionId`, `stripeCheckoutSessionId`, `membershipTier`, and any other billing/role fields. Preserve normal profile-edit permissions. Firebase Auth custom claims cannot be set by client SDK.
6. Deploy the matching Cloud Functions API **before** publishing the new signup/paywall and use the server `/membership-health`, `/verify-membership` route to verify it is live. Keep the existing webhook and payment secret configuration.
7. Test unverified email, invalid/expired/reused token, wrong email, two-device concurrent redemption, paid-tier signup, legacy founding vendor, locked account, and dashboard access with forged frontend Firestore fields.
8. Publish frontend after backend tests and migrations, and monitor errors and access reports.

## Rollback

Revert only the frontend if authorised backend deployment fails; do not grant membership based on the old public code. Restore previous server release only after checking the security impact. Never revoke a genuinely entitled account without reconciling it and recording the reason. Do not expose raw invitation tokens or signing keys in GitHub PRs or chat.

**Current limitation:** Firestore rules, the live Firebase project and Stripe records are external to this repository. Passing local tests cannot certify production security; authenticated Firebase access and deployment are mandatory.
