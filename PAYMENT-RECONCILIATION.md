# Vendor payment recovery

This patch is not deployed by opening or merging the pull request. Deploy the Firebase backend first. Do not publish the frontend before the new backend passes its route checks.

## Deployment

Before deployment, confirm checkout price configuration against the advertised rates.
Current recurring price IDs from the supplied Stripe export are recognised alongside
legacy prices. New checkouts use the current IDs and verify active AUD monthly rates
plus the AUD 50 one-time setup price before creating a Checkout Session. The export's
Edit price is AUD 14.75, while the website advertises AUD 14.95. Resolve that business
pricing discrepancy and set STRIPE_PRICE_EDIT to the approved Stripe Price ID before
deployment. The guard deliberately prevents charging an unverified amount. Other
overrides are STRIPE_PRICE_SETUP, STRIPE_PRICE_SPOTLIGHT, STRIPE_PRICE_FEATURE and
STRIPE_PRICE_ICON. Existing subscriptions keep their contracted prices.

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

## Live recovery status (14 October 2026)

Two affected vendor records were matched against their user identities and the supplied successful payment and active subscription exports. Their payment status, active flag and Stripe identifiers were repaired and read back in the Firebase console. One vendor profile email typo was corrected to match the existing login and Stripe identity. No Stripe transactions or publication/approval flags were changed. These repairs do not establish successful vendor login or a completed end-to-end checkout test.

The console inventory contains 148 users and 139 vendors. Query grid columns are virtualised, so missing extracted keys cannot establish missing database fields. All 11 exported active subscriptions match a unique normalised user email and an existing vendor UID; complete document checks remain required before further writes. Export absence cannot establish cancellation or justify revoking access. Private inventories and payment exports must remain outside Git.

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
