# Vendor payment recovery

This patch is not deployed by opening or merging the pull request. Deploy the Firebase backend first. Do not publish the frontend before the new backend passes its route checks.

## Deployment

Before deployment, confirm checkout price configuration against the advertised rates.
Current and legacy membership prices remain recognised. Edit checkout validation and
public pricing now use the existing Stripe rate of AUD 14.75/month, matching the live
catalogue inspected on 16 October. Setup remains AUD 50; Spotlight AUD 15.95, Feature
AUD 17.25 and Icon AUD 19.95. All prices must still pass live active/AUD/interval checks.
STRIPE_PRICE_* overrides remain supported. Existing Stripe subscriptions are unchanged.
Existing non-empty vendor tiers are preserved during verification and reconciliation;
any entitlement changes require a separate review. New signup/checkout stores the
selected tier as before.

Use an authorised Google Cloud/Firebase environment with the existing production secrets. Do not copy keys into source control or chat.

```sh
cd docs/functions
npm ci
npm test
cd ..
firebase deploy --project ourweddingdayhub --only functions:api,functions:stripeWebhook
cd functions
node check-membership-deployment.js
```

Confirm the Stripe webhook destination and event subscriptions match the deployed handler. Existing function secret bindings are retained. Check deployed Firestore rules prevent ordinary vendors from writing membership/payment flags or granting complimentary access. The production rules were published on 14 October. The full rules capture is retained privately and is not included in this public repository. Owner updates to billing/access fields were denied in the Firebase rules simulator, while administrator updates and public reads were allowed. This narrowly protects updates; owner create/delete permissions retain existing behaviour and need a separate lifecycle review. Rules changes are not covered by the 38 Node tests.

## Live recovery status (15 October 2026)

The Firebase console inventory contains 148 users and 139 vendors, with no duplicate normalised user emails and no vendor UID lacking a matching user. All 11 subscriptions in the supplied active-subscription export match a unique user email and an existing vendor UID, and have a successful non-refunded payment for the same Stripe customer ID in the supplied payment export.

Full document checks identified five further paid subscribers with pending/unknown payment status and inactive subscription flags. Those five records were repaired. Four already-active paid records received their missing Stripe customer/subscription/status references. The two originally reported accounts were rechecked. Final console read-back verified all 11 are paid, subscriptionActive=true, stripeSubscriptionStatus=active and linked to their exported customer and subscription IDs. A blank vendor business name and email were restored from the matching existing user document. No Stripe transactions, contracted prices, membership tiers, complimentary grants or publication/approval flags were changed. The private before/after audit is ignored by Git.

This is export-based reconciliation, not a fresh unrestricted Stripe API audit. The exports do not prove the status of subscriptions omitted from them. One historical paying customer absent from the subscription export was left unchanged. Query grid columns are virtualised, so missing extracted keys were not treated as missing database fields; the 11 subscriber records were inspected individually before repair.

The live login, pricing and registration pages were inspected in the browser. The published Edit rate is AUD 14.95, confirming the discrepancy with the supplied AUD 14.75 Stripe price. No account was created and no real payment or vendor password was used. Successful vendor login and a complete safe test checkout remain unverified.

The Firebase Functions console lists the API and image-conversion functions, with no standalone stripeWebhook function. The existing API also has a webhook route in source; absence of a standalone function does not establish whether Stripe has a working endpoint configured. The deployment checker still fails. Google Cloud function management returns Site Unavailable in this browser, and there is no usable authenticated deployment runtime available. Keep this PR's frontend unpublished until the backend is deployed and route checks pass.

## Vendor and customer reconciliation

In an authorised Cloud Shell/server with Application Default Credentials and permission to access the existing Stripe secret:

```sh
cd docs/functions
node reconcile-vendors.js
```

The default is read-only. It inventories all vendor and user documents and paginates all Stripe customers, subscriptions Checkout Sessions and invoices. It matches Firebase UID, Stripe IDs and normalised account email, and checks actual membership price IDs. Reports are private, ignored by Git and contain the proposed patch and original payment fields.

Review the report, including both reported affected vendors. Then run:

```sh
node reconcile-vendors.js --apply
```

Apply performs a fresh inventory and only updates unique, verified active OWDH subscriptions whose current invoice has a successful, non-zero payment. Setup-payment flags are only set when a paid invoice contains the actual setup price. Each subscription is rechecked and each vendor write has a Firestore version precondition. Complimentary and restricted accounts are preserved. Ambiguous identities, missing user records, inactive memberships and unmatched Stripe subscriptions require manual review. The script never charges, cancels, deletes, publishes profiles or automatically revokes existing access. Couple accounts are inventoried but not assigned vendor billing states.

## Verification after deployment

The 14 October source review passes 38 regression tests and 42 JavaScript syntax
checks. The registration, login, dashboard, payment-required, payment-success and
contact pages have no missing local linked files. Live API probes still return 404
for membership-health, verify-membership and confirm-checkout. Successful unit tests
do not establish deployment or real account access. Live page probes from the shell
returned 403, so visual browser testing and real mail/form delivery remain unverified.

Checkout recovery now fails safely on Stripe lookup outages, validates session
ownership, replaces stale-price checkout sessions and avoids treating cancelled
subscriptions' historical sessions as current access. Subscription webhooks re-read
current Stripe state and old-subscription cancellations cannot revoke replacements.
Notification routes check Resend's returned error and message ID instead of reporting
success merely because the SDK call resolved. No test sends real messages or charges.
Membership routes and webhook writes require an existing vendor user/profile pair;
couple accounts cannot be assigned vendor access through those routes.

Publish the frontend only after backend checks pass. Use a separate Stripe test environment for new registration, checkout, cancelled checkout, expired session, payment return after sign-out, webhook delay and returning login. Confirm an existing paid vendor is not sent to another checkout; an unrelated subscription and another vendor's session cannot grant access; Stripe outage shows retry rather than an unpaid classification. Production payments and returning login for Mandi and Ray remain unverified until the live audit and account checks run.

For rollback, retain the private reconciliation report and the vendor's `paymentReconciliationPrevious` fields. Restore only payment fields changed by this run, after checking for newer Stripe events. Do not overwrite a whole vendor document.


## 16 October deployment evidence and remaining release checks

The user deployed api and stripeWebhook from commit 6e1a19a via their authorised Cloud
Shell. The live route checker passed. A fresh audit read 140 vendors, 149 users, 18
Stripe customers, 16 subscriptions and 33 invoices. Setup-fee flags were repaired
for the 11 uniquely matched, currently paid subscribers. Direct Firebase read-back
confirmed all 11 paid, active, setup-paid and original tiers preserved. No charge,
subscription change or automated revocation was performed. The 64 unmatched/inactive
review rows were left unchanged; their count is not a count of payment failures.

The destination is active with all five required events selected, but no real delivery
was observed in the supplied screenshots. Run live-payment-preflight.js in authorised
Cloud Shell for read-only live price and webhook configuration checks. After the latest
backend is deployed, optional --resend-invoice <invoice_id> uses the official Stripe CLI
and the existing server key to resend one real, previously paid invoice event. It
validates an active membership and unique unrestricted vendor first; no payment or
subscription is created. Credentials are not printed. A fresh processed-event record
confirms handler completion; a queued replay alone is not success. Requires the CLI
and API permission to resend. Do not put credentials or private report data in GitHub.

Do not publish frontend until the matching backend is deployed and preflight passes.
Authenticated browser login and a complete separate Stripe test checkout remain
unverified; route regression tests and invoice reconciliation do not establish them.
Earlier sections record historical checks and blockers, not the current deployment.
