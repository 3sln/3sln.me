# Polar billing deployment

Billing is implemented for the portable Worker/Node account runtime and is disabled by default. No product, customer, webhook endpoint, checkout, or real transaction has been created by this implementation. Offline tests validate local behavior; they do not establish live payment acceptance, webhook delivery, provider conformance, or production readiness. Production release gates remain in [security.md](../spec/security.md) and the decision ledger in [DEVLOG.md](../../DEVLOG.md). Pricing economics and production sign-offs remain provisional.

| Plan | Included hosted storage | Base annual USD catalog price |
| --- | ---: | ---: |
| Free | 500 MB (500,000,000 bytes) | Free |
| Paid | 5 GB (5,000,000,000 bytes) | US $5 |
| Plus | 100 GB (100,000,000,000 bytes) | US $35 |
| Ultra | 1 TB (1,000,000,000,000 bytes) | US $250 |

These are decimal byte limits. All three paid plans initially use the same combined activity and paid-feature policy; their storage capacity and annual price differ. The account runtime enforces its entitlement for shared hosted storage; a display, checkout redirect, submitted plan name, customer metadata, or email address cannot raise it. Current downgrades preserve stored data and allow read/export/delete. A finite over-quota grace/cutoff and resumable offload are being specified in [offload and retention](../architecture/offload-retention.md); automatic cutoff is not enabled until those escape and deletion paths are verified. Positive growth requires available capacity. External storage connected by the owner does not consume this hosted capacity.

## Operator configuration

Use the runtime's secret mechanism for `POLAR_ACCESS_TOKEN` and `POLAR_WEBHOOK_SECRET`; do not put them in source, a browser bundle, page state, or logs. The access token should be limited to one intended Polar organization with product/customer/subscription/order read, subscription write, checkout write, and customer session write scopes. Sandbox and production must have separate credentials, products, and webhook endpoints.

Set non-secret variables:

```text
BILLING_ENABLED=false
POLAR_SERVER=production
POLAR_CATALOG_MODE=metadata
POLAR_METADATA_PREFIX=3sln_me_
POLAR_ORGANIZATION_ID=
# Optional IDs for explicitly selected static mode:
POLAR_PRODUCT_ID_PAID=
POLAR_PRODUCT_ID_PLUS=
POLAR_PRODUCT_ID_ULTRA=
```

`POLAR_SERVER` accepts only `sandbox` or `production`. There is no configurable provider base URL. `APP_ORIGIN` is the existing canonical app origin and supplies both checkout and portal return URLs; browsers cannot submit an alternate return URL. Documentation examples use `https://3sln.example` until publication authority is agreed.

Create three distinct recurring products in the intended organization: annual interval count 1 and an approved fixed USD base price, respectively 500, 3500 and 25000 cents for Paid, Plus and Ultra. No product or price may be archived. All three product IDs are required in static mode even if a request only selects one plan. Metadata mode discovers them through the pinned organization and service tags below. Additional currencies may have their own fixed catalog amounts. Each account service checks all three products and their active currency price sets through Polar before checkout or reconciliation, with a five-minute in-memory cache of a successful check. A product mismatch prevents billing actions. This check verifies configured products, not deployment approval or payment settlement. Set `BILLING_ENABLED=true` only after recording operator review of products, webhook configuration, entitlement policy, and the applicable release gates. The operator has authorized gated production checkout verification after correcting the live catalog and confirming signed webhook200responses. Hosted billing is enabled for authenticated accounts; public signup stays closed. Live purchases and financial lifecycle conformance remain unverified.

Once the operator has supplied the environment variables and secrets, this explicit read-only preflight verifies all three products through Polar while the app's billing flag stays disabled:

```sh
node --input-type=module -e 'import {verifyBillingCatalog} from "./packages/billing/index.mjs"; console.log(JSON.stringify(await verifyBillingCatalog(process.env), null, 2))'
```

The command only reads product configuration and prints non-secret catalog evidence for the ledger. It does not create a checkout, write account state, or enable billing. The implementation session did not run it against a live provider. Missing credentials fail before any provider request.

Use the `2026-10` webhook API version and the single endpoint `https://3sln.me/api/billing/webhook`. Subscribe to:

```text
product.created
product.updated
customer.state_changed
customer.deleted
subscription.created
subscription.updated
order.paid
order.updated
order.refunded
refund.created
refund.updated
```

`subscription.updated` covers all subscription changes, including renewals; extra supported lifecycle events are safe but unnecessary for this selection. [Polar subscription event documentation](https://polar.sh/docs/api-reference/webhooks/subscription.updated).

Polar webhook selection is organization-wide. Authenticate the bounded raw body before deciding to ignore an event. Unknown event types and authenticated events for unrelated organizations, products or customers must return successful ignored acknowledgements without changing account entitlements. Relevant product updates trigger fresh validated catalog discovery; account events trigger authoritative provider reconciliation, never grants copied from payloads. Refund routing resolves the original order and checks product/customer ownership. Product archiving or removing service tags must still invalidate previously relevant catalog entries. Empty customer subscription state must still reach a known account for revocation reconciliation. Malformed relevant payloads and invalid signatures remain errors, rather than being silently accepted. Implementation and regression evidence for these global filtering rules are tracked in DEVLOG.md.

The implementation uses the maintained [Polar TypeScript SDK](https://github.com/polarsource/polar/tree/main/sdk/typescript), pinned to `@polar-sh/sdk` 1.0.2 and its `2026-10` API. Its package declares Node24 or later.

## Identity and entitlement authority

Checkout and portal are owner-authenticated POST actions with the runtime's same-origin and CSRF checks. The server supplies the authenticated account UUID as Polar's dedicated `external_customer_id`. Polar's [customer external ID](https://polar.sh/docs/features/customer-management) is unique within its organization and immutable once set. Browser metadata and customer email are never an identity fallback. The portal uses the provider customer ID only after fetching and verifying its external ID and organization.

The [customer state event](https://polar.sh/docs/api-reference/webhooks/customer.state_changed) is a notification to reconcile authoritative customer and subscription state through the provider API. Reconciliation verifies customer identity, the organization shared by all three catalog products, subscription ownership, product mapping, verified annual price and currency, period dates, and termination state. A checkout completion redirect does not change entitlement. Existing paid subscribers change tiers through the app and use the customer portal for payment methods, invoices and cancellation; a second paid checkout is rejected.

Paid `active` subscriptions grant the selected plan until the current period end or earlier scheduled end. Cancellation scheduled for period end retains access until that deadline. A canceled subscription without that flag, an ended/revoked subscription, deletion, unpaid, incomplete, trialing, or paused status grants no new paid capacity. A `past_due` subscription may retain an already verified grant only until its previous paid-through deadline; failed renewal cannot extend it. These are application policy choices and need operator acceptance, not claims that Polar handles all refund or dispute scenarios identically. Refund and dispute operations require operator/provider policy verification before production launch. Reconciliation uses current subscription state, so an old notification cannot replay its embedded plan into account state. A provider error returns a retryable failure and keeps the last verified paid deadline; local expiry still takes effect during outages.

The pure `entitlementFromState` resolver and `BILLING_STATE_KEY` (`billing/state`) let quota transactions read the same durable state without nesting another metadata transaction. Callers must first check `state.owner === owner`. Every paid entitlement is checked for expiry at use time; expiry needs no successful browser visit or webhook.

## Webhook and persistence boundary

Verify the raw HTTP request before looking up its recipient account. The body is bounded to 256 KiB, decoded as valid UTF-8, and passed to the official SDK [webhook verifier](https://github.com/polarsource/polar/blob/main/sdk/typescript/src/webhooks.ts). Verification requires the signed ID, timestamp, and signature headers and accepts only a delivery within the SDK's five-minute window. The verified descriptor contains only ID, customer external ID, event type, event timestamp, and a body SHA-256. It is an internal server/DO message; do not expose an HTTP action that accepts a purportedly verified descriptor from the browser. Route only after verification, then check the local identity is an active account before calling its billing method.

Each account shard keeps the event ID and payload hash durably alongside entitlement state. Repeating the same event ID is idempotent; reusing it with another body is rejected. Successful history is retained for 35 days and capped at 4096 records per account. At capacity, the service fails closed with a retryable error until expired history can be cleaned or the operator investigates the event rate. A late redelivery after history expiry still fetches current provider state. No global billing lock or identity-directory account scan is required.

The enclosing account gate serializes billing and quota mutations; provider calls run outside short metadata transactions. Provider requests time out after five seconds. Reconciliation fetches at most eight subscriptions concurrently and fails closed above that bound, so provider requests fit within the account gate's short runtime budget. A monotonic reconciliation revision prevents an earlier overlapping fetch from overwriting a later request. If the runtime crashes after updating state and before recording a delivered event, retrying reconciles current provider state again. Billing records and replay history are separate from message archival keys and survive normal warm-message eviction. Account lifecycle removal must continue to honor the project's data-retention and billing obligations before production activation.

## Verification and remaining live checks

The operator selected production Polar verification using a discount code. Before live enablement, record production product responses, actual webhook API version/signature/identity shapes, active and canceled subscription transitions, portal URLs, expiry behavior, failure retry, and refund/revocation behavior with reviewer/date/outcome evidence in DEVLOG.md. No live verification transaction has been performed yet. A discount does not replace checking authenticated checkout ownership, signed webhook delivery, effective subscription state, or financial-failure handling. Include zero-total checkout if the code covers the full price; permanent ever-paid handle eligibility remains a separate anti-abuse policy. Checkout allows discount-code entry. A verified positive discounted payment can qualify for a permanent short handle; a zero-total or entirely account-credit-funded order does not create that payment marker, while subscription quota follows verified effective subscription state. Existing permanent markers remain valid. Production payment, dispute, delivery, capacity economics, and lifecycle-retention verification remain unsigned.

## Catalog revision and retained entitlements

The current catalog revision uses `paid`, `plus` and `ultra`, with versioned billing state. Unversioned historical `plus` means the former 5 GB plan and maps to `paid`; historical `pro` means 100 GB and maps to `plus`. Unknown catalog versions fail closed to Free. Never rewrite old `plus` as new `plus` without this distinction.

Verified legacy subscription capacity may remain only through its originally verified paid deadline, subject to live customer/subscription/organization checks and termination state. A price change is not permission to extend that deadline or trust an unknown product. New checkouts and catalog preflight require valid configured fixed prices; static-ID mode additionally checks the reviewed USD base anchors. There are no verified live payments in this project yet.

Existing permanent ever-paid markers and handle claims survive the rename. Historical orders for products or prices outside the current configured catalog cannot automatically establish a never-recorded eligibility claim. If an operator already has subscribers/orders under an old catalog, reconcile and preserve their eligibility before retiring old products or replacing their prices; do not rely on this rename to discover unconfigured history.

Refund and dispute handling still requires operational verification against actual provider behavior; a refund event does not itself prove a subscription was revoked.

## Regional prices and currency selection

Enable the currencies and their actual annual amounts on each of the three Polar products. Prices are read from Polar; the app does not convert USD at a guessed exchange rate. The common currency set across all three paid tiers keeps the comparison and checkout consistent. The initial USD defaults are $5, $35 and $250; they are not promised prices in other currencies.

`GET /api/billing` selects a configured currency using a trusted Worker country hint; `?currency=eur` requests an available explicit override. Unknown or unavailable overrides are rejected. Node has no automatic country geolocation adapter and uses the reviewed fallback currency unless an override is selected. Country is presentation context, not identity or entitlement authority.

`POST /api/billing/checkout` accepts only `plan`, optional `currency` and optional `locale`. The server chooses the reviewed product and supplies the authenticated account UUID, exact return origins and trusted client IP. It never accepts client price amounts, product IDs, country overrides or provider URLs. Sending explicit currency keeps checkout aligned with the displayed configured price; the client IP lets Polar apply its own location-sensitive checkout behavior instead of the server's location. [Polar products and currencies](https://polar.sh/docs/features/products), [checkout creation](https://polar.sh/docs/api-reference/checkouts/create-session).

Provider-backed prices include their actual amount, currency and exponent. Polar has an explicit zero-decimal currency set; other supported payment currencies use its two-decimal factor even when Intl has a different default. The display uses that provider convention. Tax inclusion/addition and discounts remain checkout-dependent, so the portal price is a configured catalog quote, not a final tax-inclusive invoice total.

With billing disabled, the UI identifies the reviewed USD base catalog as provisional. An enabled provider failure makes paid prices unavailable and disables checkout rather than substituting a guessed regional amount. Read-only price status does not create disposable checkout sessions. Live price, tax and checkout verification awaits the operator's Polar credentials and products.

## Product metadata and shared webhook

Use metadata catalog mode to manage the actual plan parameters in Polar:

```text
POLAR_CATALOG_MODE=metadata
POLAR_ORGANIZATION_ID=<your organization UUID>
```

Each qualifying product must be an active annual fixed-price product in that organization and carry these metadata fields (numbers may be integer values or canonical decimal strings):

```json
{
  "3sln_me_catalog": "1",
  "3sln_me_service": "https://3sln.me",
  "3sln_me_plan": "paid",
  "3sln_me_storage_bytes": "5000000000",
  "3sln_me_activity_hour": "2000",
  "3sln_me_activity_day": "10000"
}
```

For Plus:

```json
{
  "3sln_me_catalog": "1",
  "3sln_me_service": "https://3sln.me",
  "3sln_me_plan": "plus",
  "3sln_me_storage_bytes": "100000000000",
  "3sln_me_activity_hour": "2000",
  "3sln_me_activity_day": "10000"
}
```

For Ultra:

```json
{
  "3sln_me_catalog": "1",
  "3sln_me_service": "https://3sln.me",
  "3sln_me_plan": "ultra",
  "3sln_me_storage_bytes": "1000000000000",
  "3sln_me_activity_hour": "2000",
  "3sln_me_activity_day": "10000"
}
```

Set the product names to Paid, Plus and Ultra. All three initially share the activity values above. Configure their real currency-specific amounts in Polar. The initial USD defaults are $5, $35 and $250 yearly; metadata mode treats validated provider prices as authoritative, so changing a price in Polar does not require a source deployment. Minute bursts, the service ceiling, archive reserves and paid-handle eligibility are not metadata-controlled.

There must be exactly one qualifying product for each stable paid ID. Other products are ignored; wrong-origin tags, duplicate qualifying IDs and malformed parameters never become entitlements. Storage is bounded to 1 TB, with positive hour/day activity values and hour ≤ day ≤100,000. These are service billing fields, outside the Bindle protocol. Self-hosts use their exact APP_ORIGIN in the service field and can configure their own metadata prefix with `POLAR_METADATA_PREFIX`; the hosted default is `3sln_me_`. Static mode remains an explicit alternative; metadata failure never silently switches modes.

Use the single `https://3sln.me/api/billing/webhook` endpoint and signing secret for product, customer, subscription and order events. The pinned API supports `product.created` and `product.updated`; archiving is reconciled through updates/discovery, not an invented product-deleted event. A verified event triggers fresh API reads. Catalog updates replace only a fully validated whole snapshot, with monotonic refresh ordering and bounded cache convergence. Account events reconcile live subscription state, rather than copying amounts or plan grants from the webhook payload.

Login and billing-sensitive actions also verify live state through the API, with bounded active refresh. Provider outages retain only the previously verified paid-through entitlement and never extend its deadline; login and safety operations remain available. Changes may take up to the documented cache/refresh interval to converge. A product becoming unavailable for new checkout does not by itself revoke an existing paid subscription. Live webhook delivery, product editing and subscription/refund tests remain operator verification work until credentials are configured.

## Subscription tier changes

Polar changes the product on an existing subscription through its customer portal or subscription-update API. Its `invoice`, `prorate` and `next_period` behaviors respectively apply and bill the proration now, apply now with adjustment at the next invoice, or schedule the change at renewal without proration. The API also exposes `reset`; it is not selected by this application. [Subscription API](https://polar.sh/docs/api-reference/subscriptions/update), [proration guidance](https://polar.sh/features/subscriptions).

The user-approved 3sln.me policy is immediate invoiced/prorated upgrades and renewal-time downgrades. App plan changes use the existing verified subscription, with invoice behavior for higher tiers and next-period behavior for lower tiers. A confirmation identifies the target plan, its configured annual currency price, and whether Polar will charge a prorated difference now or apply the change at renewal. The app does not invent an exact tax-inclusive prorated amount.

Disable customer portal plan updates (`customer_portal_settings.subscription.update_plan=false`) so the organization's single portal proration default cannot bypass the app's direction-specific policy. This setting affects the whole Polar organization, including unrelated products; review that impact or use a dedicated organization for 3sln.me before changing it. The portal remains available for payment methods, invoices and cancellation. No live organization settings were changed here. [Organization settings](https://polar.sh/docs/api-reference/organizations/update). Proration policy reviewer ___ / Date ___ / Outcome ___.

Confirmed account capacity follows the live effective subscription product and required paid-order evidence, not a future `pending_update`. A failed upgrade cannot grant the larger plan merely because a request or event named it. Downgrades preserve stored data and allow reads/export/deletion; positive growth requires available capacity. Switching tiers must not create a second parallel subscription or reset accumulated activity usage.

## Upgrade activation grace

A known accepted upgrade can provisionally expose the requested capacity for at most 15 minutes while its invoice settles, bounded by the source paid-through deadline. The account must already have a valid paid entitlement, and a fresh provider read must show the exact requested target product. A click, unconfirmed external request, new unpaid checkout or arbitrary webhook payload cannot start this grace.

A separate durable spent-grace record prevents extending the window by repeating requests, changing targets, reconnecting, recovery or journal expiry within the same confirmed billing period. The UI identifies activation as provisional. Verified corresponding payment settles the upgrade; definitive pending-payment failure, refund evidence or revocation ends grace immediately. After settlement, later refunds follow the live subscription policy described above; a refund alone does not imply automatic capacity revocation. Expiry restores the original capacity and pauses positive growth if over quota; data stays readable/deletable during the separate over-quota retention policy. Activity counters do not reset with provisional capacity.

## Local verification history

`node --test tests/billing.test.mjs` uses offline provider fixtures and authentic signatures generated by `standardwebhooks` 1.1.1 and verified by the installed Polar SDK. It covers bounded and changed raw bodies, old/future timestamps, API-version mismatch, external-ID ownership, price mismatch, trusted return hosts, replay persistence, out-of-order delivery, subscription transitions, provider errors, and paid expiry. Run `npm test` and Worker/Node/runtime browser checks after integration changes.
