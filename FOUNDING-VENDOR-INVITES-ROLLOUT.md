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

## Execution checkpoint: 20 October 2026

- Continued PR #12 on `security/server-authorised-founding-invites-20261020` from `de0c3354860a5212f6da8901729726f1d4dc6bb6`.
- Fixed the missing frontend call to `/redeem-founding-invite`. The paywall now refreshes email verification, offers resend/retry, redeems through the authenticated server, refreshes custom claims, and opens the dashboard only after confirmed activation. Invitation failures never fall through to checkout. Successful activation removes the invitation from the current browser history entry; the page suppresses outgoing referrers.
- API authentication now checks revoked tokens and disabled users through `verifyIdToken(token, true)`.
- Added executable frontend flow tests and backend route tests for authentication, email ownership, expiry, restriction, prior redemption, same-vendor concurrency, unrelated-claim preservation and recovery after an Auth claim-write failure. Concurrency uses a serialized test double, not a production Firestore/emulator test.
- Fixed regression workflow coverage for signup-only changes and corrected an overescaped security assertion.
- Local full regression: **64 passed, 0 failed**, Node v24.19.0. GitHub Actions uses Node 22; inspect the run for the updated commit before rollout.
- **No production deployment or account migration was performed. PR remains unmerged.** Firebase Console redirected to Google sign-in. No Firebase CLI credentials or Application Default Credentials were available in this execution environment. The production website could not be reached from the local runtime because its proxy connection timed out; this does not establish a site outage.
- Next: authenticate an authorised Firebase project account, inspect/export deployed rules and relevant records, verify approved founding entitlements, migrate claims, provision the invitation secret, deploy backend, run authenticated staging/production checks, then merge/publish the frontend.
- Still blocked: deployed Firestore/Storage rules and indexes, Stripe/webhook production checks, authenticated Boutique product operations and customer journeys, and former-staff IAM review. Boutique UI still recognises legacy Firestore entitlement fields; server-enforced rules must protect these before security sign-off. Do not invent a replacement ruleset without inspecting deployed collections and permissions.

### Firebase inspection and rules hardening

- Google sign-in subsequently succeeded. Inspected the live Firestore rules and found unrestricted vendor creation/deletion, unprotected `shopAccess`/`tier`, cross-conversation message access, and unrestricted legacy product writes. Captured the existing rules in `security/firestore.pre-hardening-20261020.rules` before editing.
- Added `docs/firestore.rules` from that deployed baseline, configured it in `docs/firebase.json`, and added a separate emulator regression suite. Normal signup, profile editing, eligible Boutique CRUD and participant messaging are preserved. Protected-field creation/update/delete bypasses, account-role escalation, product ownership transfer and outsider messaging are denied.
- Boutique eligibility temporarily recognises existing, now immutable historical grants alongside Auth claims. This preserves founding access while the independent entitlement audit and custom-claim migration remain outstanding. This is **not** certification of historical grants. Do not remove legacy recognition until the approved migration is complete.
- Rules emulator result: **8 passed, 0 failed**, including Icon/Platinum case and whitespace variants, using Firebase CLI 14.16.0 and Java 17. Latest CLI 15.34.0 required Java 21, so the test harness pins the Java-17-compatible CLI. CI covers both rules and API/frontend regressions.
- Firebase lists three deployed functions: `api`, `stripeWebhook`, `convertToWebP` in `us-central1`. Authenticated Console access is working, but the Cloud Shell iframe shows **Site Unavailable**, and the connected Desktop Commander device is offline. Functions deployment and Auth-claims migration still require an available authorised CLI/runtime. Do not merge PR #12 until those dependencies pass.
- **Production rules are staged but unpublished.** Automatic approval review rejected the Publish action, stating that a production Firestore security-setting change requires explicit confirmation at action time despite standing approval and passing tests. Do not bypass the rejection with a different deployment method. The precise next action is owner confirmation to publish this tested ruleset, followed by live validation.
- Separate blocker after rules approval: restore an authorised deployment runtime, provision the secret, independently confirm founding-vendor entitlements, migrate claims, deploy Functions, and run authenticated production QA before merging the frontend. No real charges, vendor records, Auth claims or staff permissions have been changed during this execution.
