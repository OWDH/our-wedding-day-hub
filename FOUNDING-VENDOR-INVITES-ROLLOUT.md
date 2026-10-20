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
- **Production Firestore rules published on 20 October 2026 at 10:56 am Australia/Sydney.** The user explicitly approved publication after automatic approval review required confirmation. Firebase displayed the new starred release and removed the unpublished controls. The published editor contents exactly matched the tested source in commit `9d09b5e1dd30cf0a135051b3a7f92cfd46a004a6`.
- Post-publication Firebase Rules Playground checks: unauthenticated invitation read **denied**; simulated signed-in vendor invitation read **denied**; public vendor-profile read **allowed**. Synthetic document paths were used; no production test records were created or modified. These simulations do not replace authenticated customer-journey testing.
- Code validation before publication: 64 API/frontend/reconciliation regressions plus 8 Firestore emulator tests passed; GitHub Actions run `39344191034` passed both jobs.
- Remaining blocker after rules publication: restore an authorised deployment runtime, provision the secret, independently confirm founding-vendor entitlements, migrate claims, deploy Functions, and run authenticated production QA before merging the frontend. No real charges, vendor records, Auth claims or staff permissions have been changed during this execution.


### Node 22 dependency remediation before manual deployment

- The Cloud Shell installation and 64 regressions passed under Node 22.23.3; Firebase Admin and sharp loaded successfully. Registry audit identified 10 moderate runtime dependency findings.
- Upgraded and pinned Firebase Admin 14.5.0 and Firebase Functions 7.4.0. Converted production and maintenance scripts from the removed namespaced Admin API to modular app, Auth, Firestore and Storage imports. Preserved the existing handlers, secret bindings, subscription logic and claims merge behavior.
- Pinned the transitive `qs` dependency to 6.16.1 through an override, retaining the application's existing Express 4 API. No forced dependency upgrade command is required on the deployment host.
- Added a regression that loads all three production exports with the real SDKs, checks required Admin APIs and loads sharp without contacting production. Updated boundary mocks for the modular SDK.
- Validation: 65 regressions passed with Node 22; `npm audit --omit=dev --json` reported zero known vulnerabilities. CI now audits runtime dependencies at moderate severity or above.
- Manual operator must pull this commit, run `npm ci`, `npm test` (65 tests) and `npm audit --omit=dev` before preparing private backups and the approved founding-vendor migration. No Functions deployment or vendor/Auth mutation has been performed by this patch.


### Approved migration baseline: 20 October 2026, 11:43 Australia/Sydney

- After the private backup completed, the operator explicitly directed: **use the existing ones**. Existing complimentary/founding markers are therefore the authorised baseline for this migration; this supersedes the earlier request to wait for a separate historical owner list. It does not establish that every historical marker was independently audited.
- `migrate-existing-founders.js` defaults to a private, read-only dry run against the latest complete, checksummed project backup in the Cloud Shell home directory. It reuses the application's existing complimentary-marker definition. Paid-only and Boutique-only accounts do not qualify.
- Migration eligibility requires a matching vendor user document and enabled Auth account, consistent recorded emails and no explicit server denial. Existing unverified-email founders may retain their previously granted access; email verification remains mandatory for new invitations. Restricted and mismatched accounts require review before switching the backend gate.
- The explicit apply mode requires the saved plan path, reconstructs eligible UIDs from the verified backup, rechecks current documents/update times and restrictions, preserves the latest unrelated claims, records before/after claims privately and verifies each grant. It never writes Firestore records or Stripe data. No apply command has been run during preparation.
- Added five targeted migration-planning/claims regression tests, all passing. Next operator action: pull the helper and run its default dry run; inspect only the counts and review reasons in chat, retaining customer records and plan files privately.

### Operator-confirmed progress: 20 October 2026, 12:04 Australia/Sydney

- Operator screenshot confirms `MIGRATION_COMPLETE`: 59 grants, zero skips, no Firestore or Stripe writes. The helper verifies claims after each grant and retains its private recovery journal.
- Operator created version 1 of `FOUNDING_INVITE_SIGNING_KEY` directly from a random 32-byte key through stdin. The secret value was not displayed or shared.
- Of six held records, three have no Auth UID match. The other three have matching users/Auth emails and enabled vendor accounts, but different public vendor contact emails. Dashboard profile saving independently edits `vendors.email`, so contact-email equality is not an identity requirement. Corrected migration eligibility to accept a differing contact email only when users/Auth emails match. Shared UID, vendor role, account restrictions, explicit denials, live revalidation and journal checks remain enforced; no contact email is rewritten.
- Thirteen targeted migration tests pass. Next: regenerate the private dry-run plan, apply eligible remaining grants, then deploy Functions and complete authenticated production QA. PR #12 remains unmerged.

### Operator-confirmed deployment and QA: 20 October 2026, 12:32 Australia/Sydney

- Final apply screenshot: 3 newly granted, 59 already granted, zero skipped. Total 62 migrated accounts. Three records without matching Auth UIDs remain untouched.
- All three production Functions (`api`, `stripeWebhook`, `convertToWebP`) successfully updated to Node 22 after 81 predeploy tests passed. Signing-key runtime access was granted. No PR merge has occurred.
- Production API smoke checks passed: health 200; unauthenticated membership verification, checkout confirmation and invitation redemption each 401.
- Dedicated synthetic vendor account created with server complimentary claim and hidden profile. Operator screenshots confirm successful login, dashboard and Boutique form access, draft create/edit/delete, and image upload/display. Image conversion completion and image-object cleanup are not established by the thumbnail alone.
- Added an operator-run production invitation QA helper restricted to a uniquely identified synthetic QA Auth account with matching test-marked hidden user/vendor documents and no Stripe linkage. It prompts privately for the QA password, holds tokens/signing key only in memory, journals recovery state privately before mutation, tests grant enforcement and invitation validation, restores QA claims/verification and removes generated invitations. Its two local safeguard tests pass. Production invitation checks remain pending until the operator runs it.
