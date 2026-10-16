# Membership payment repair

Deploy the matching Firebase backend before publishing frontend changes. Run npm ci and npm test from docs/functions, then deploy only the API and Stripe webhook functions using the existing authorised production environment. Keep secret values out of source control and chat.

Edit checkout and public display use the existing A$14.75 monthly price. Other configured prices must pass the active AUD and monthly interval checks. Existing contracted subscriptions and non-empty vendor tiers are preserved during reconciliation.

Run check-membership-deployment.js for route checks and live-payment-preflight.js for read-only price and destination configuration checks. Optional --resend-invoice <invoice_id> resends a previously paid invoice event through the official Stripe CLI after checking an active membership and unique unrestricted vendor. This does not create a charge or subscription. A queued replay is not proof of successful delivery; verify handler completion and Stripe delivery status.

reconcile-vendors.js defaults to read-only. Keep its reports private. Review proposed patches before using --apply. Do not automatically revoke unmatched accounts or infer payment failures from missing matches.

Verify authenticated browser login and a complete checkout in a separate Stripe test environment. Unit tests, route availability and reconciliation do not prove a complete browser journey.

For rollback, use private before-and-after audit records and restore only the fields changed by the run, after checking for newer payment events. Do not replace entire vendor documents.
