# Polar billing deployment

Billing is implemented for the portable Worker/Node account runtime and is disabled by default. No product, customer, webhook endpoint, checkout, or real transaction has been created by this implementation. Offline tests validate local behavior; they do not establish live payment acceptance, webhook delivery, provider conformance, or production readiness. Production release gates remain in [security.md](../spec/security.md) and the decision ledger in [DEVLOG.md](../../DEVLOG.md). Pricing economics and production sign-offs remain provisional.

| Plan | Included hosted storage | Annual price before applicable tax |
| --- | ---: | ---: |
| Free | 500 MB (500,000,000 bytes) | Free |
| Plus | 5 GB (5,000,000,000 bytes) | US $5 |
| Pro | 100 GB (100,000,000,000 bytes) | US $30 |

These are decimal byte limits. The account runtime enforces its entitlement for shared hosted storage; a display, checkout redirect, submitted plan name, customer metadata, or email address cannot raise it. Downgrades preserve stored data and allow read/export/delete. Positive growth requires available capacity. External storage connected by the owner does not consume this hosted capacity.

## Operator configuration

Use the runtime's secret mechanism for `POLAR_ACCESS_TOKEN` and `POLAR_WEBHOOK_SECRET`; do not put them in source, a browser bundle, page state, or logs. The access token should be limited to one intended Polar organization with product/customer/subscription read, checkout write, and customer session write scopes. Sandbox and production must have separate credentials, products, and webhook endpoints.

Set non-secret variables:

```text
BILLING_ENABLED=false
POLAR_SERVER=sandbox
POLAR_PRODUCT_ID_PLUS=
POLAR_PRODUCT_ID_PRO=
```

`POLAR_SERVER` accepts only `sandbox` or `production`. There is no configurable provider base URL. `APP_ORIGIN` is the existing canonical app origin and supplies both checkout and portal return URLs; browsers cannot submit an alternate return URL. Documentation examples use `https://3sln.example` until publication authority is agreed.

Create two distinct recurring products in the intended organization: one fixed catalog price each, `usd`, annual interval count 1, respectively 500 and 3000 cents. Neither product nor price may be archived. Both product IDs are required even if a request only selects one plan. Each account service checks both products through Polar before checkout or reconciliation, with a five-minute in-memory cache of a successful check. A product mismatch prevents billing actions. This check verifies configured products, not deployment approval or payment settlement. Set `BILLING_ENABLED=true` only after recording operator review of products, webhook configuration, entitlement policy, and the applicable release gates. Production activation has not been performed here.

Once the operator has supplied the environment variables and secrets, this explicit read-only preflight verifies both products through Polar while the app's billing flag stays disabled:

```sh
node --input-type=module -e 'import {verifyBillingCatalog} from "./packages/billing/index.mjs"; console.log(JSON.stringify(await verifyBillingCatalog(process.env), null, 2))'
```

The command only reads product configuration and prints non-secret catalog evidence for the ledger. It does not create a checkout, write account state, or enable billing. The implementation session did not run it against a live provider. Missing credentials fail before any provider request.

Use the `2026-10` webhook API version and subscribe to `customer.state_changed` and relevant subscription lifecycle events. `order.paid`, `order.refunded`, and `order.updated` also trigger fresh reconciliation; their payloads do not themselves grant capacity. Customer create/update/delete events are supported. Do not subscribe this endpoint to unrelated product or benefit events. An unrecognized API-version event fails validation and needs operator attention. A supported but unrelated event is acknowledged without account routing. The implementation uses the current maintained [Polar TypeScript SDK](https://github.com/polarsource/polar/tree/main/sdk/typescript), pinned to `@polar-sh/sdk` 1.0.2 and its `2026-10` API. Its package declares Node 24 or later; local Node and Worker compatibility checks still apply when changing runtime versions.

## Identity and entitlement authority

Checkout and portal are owner-authenticated POST actions with the runtime's same-origin and CSRF checks. The server supplies the authenticated account UUID as Polar's dedicated `external_customer_id`. Polar's [customer external ID](https://polar.sh/docs/features/customer-management) is unique within its organization and immutable once set. Browser metadata and customer email are never an identity fallback. The portal uses the provider customer ID only after fetching and verifying its external ID and organization.

The [customer state event](https://polar.sh/docs/api-reference/webhooks/customer.state_changed) is a notification to reconcile authoritative customer and subscription state through the provider API. Reconciliation verifies customer identity, the organization shared by both catalog products, subscription ownership, product mapping, annual USD amount, period dates, and termination state. A checkout completion redirect does not change entitlement. Existing paid subscribers use the customer portal for subscription management; a second paid checkout is rejected.

Paid `active` subscriptions grant the selected plan until the current period end or earlier scheduled end. Cancellation scheduled for period end retains access until that deadline. A canceled subscription without that flag, an ended/revoked subscription, deletion, unpaid, incomplete, trialing, or paused status grants no new paid capacity. A `past_due` subscription may retain an already verified grant only until its previous paid-through deadline; failed renewal cannot extend it. These are application policy choices and need operator acceptance, not claims that Polar handles all refund or dispute scenarios identically. Refund and dispute operations require operator/provider policy verification before production launch. Reconciliation uses current subscription state, so an old notification cannot replay its embedded plan into account state. A provider error returns a retryable failure and keeps the last verified paid deadline; local expiry still takes effect during outages.

The pure `entitlementFromState` resolver and `BILLING_STATE_KEY` (`billing/state`) let quota transactions read the same durable state without nesting another metadata transaction. Callers must first check `state.owner === owner`. Every paid entitlement is checked for expiry at use time; expiry needs no successful browser visit or webhook.

## Webhook and persistence boundary

Verify the raw HTTP request before looking up its recipient account. The body is bounded to 256 KiB, decoded as valid UTF-8, and passed to the official SDK [webhook verifier](https://github.com/polarsource/polar/blob/main/sdk/typescript/src/webhooks.ts). Verification requires the signed ID, timestamp, and signature headers and accepts only a delivery within the SDK's five-minute window. The verified descriptor contains only ID, customer external ID, event type, event timestamp, and a body SHA-256. It is an internal server/DO message; do not expose an HTTP action that accepts a purportedly verified descriptor from the browser. Route only after verification, then check the local identity is an active account before calling its billing method.

Each account shard keeps the event ID and payload hash durably alongside entitlement state. Repeating the same event ID is idempotent; reusing it with another body is rejected. Successful history is retained for 35 days and capped at 4096 records per account. At capacity, the service fails closed with a retryable error until expired history can be cleaned or the operator investigates the event rate. A late redelivery after history expiry still fetches current provider state. No global billing lock or identity-directory account scan is required.

The enclosing account gate serializes billing and quota mutations; provider calls run outside short metadata transactions. Provider requests time out after five seconds. Reconciliation fetches at most eight subscriptions concurrently and fails closed above that bound, so provider requests fit within the account gate's short runtime budget. A monotonic reconciliation revision prevents an earlier overlapping fetch from overwriting a later request. If the runtime crashes after updating state and before recording a delivered event, retrying reconciles current provider state again. Billing records and replay history are separate from message archival keys and survive normal warm-message eviction. Account lifecycle removal must continue to honor the project's data-retention and billing obligations before production activation.

## Verification and remaining live checks

`node --test tests/billing.test.mjs` uses offline provider fixtures and authentic signatures generated by `standardwebhooks` 1.1.1 and verified by the installed Polar SDK. It covers bounded and changed raw bodies, old/future timestamps, API-version mismatch, external-ID ownership, price mismatch, trusted return hosts, replay persistence, out-of-order delivery, subscription transitions, provider errors, and paid expiry. Run `npm test` and Worker/Node/runtime browser checks after integration changes.

Before live enablement, record sandbox product responses, actual webhook API version/signature/identity shapes, active and canceled subscription transitions, portal URLs, expiry behavior, failure retry, and refund/revocation behavior with reviewer/date/outcome evidence in DEVLOG.md. No live sandbox transaction has been attempted with missing keys. Production payment, dispute, delivery, capacity economics, and lifecycle-retention verification remain unsigned.
