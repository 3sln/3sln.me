# Email bridge (BRIDGE) security review

Status: provisional, 2026-10-21. One independent agent review, plus a re-review of the fixes (EB-1, 2, 6, 7 and 8 confirmed; EB-3 and EB-4 completed afterwards; EB-10 found and fixed). It covers the uncommitted BRIDGE slice (`packages/email-bridge/*`, the Worker `email` handler in `apps/worker/index.mjs`, `tests/email-bridge*.mjs`). It is not a human sign-off. Human reviewer: ______ Date: ______ Outcome: ______.

Scope: spam and amplification, backscatter, recipient enumeration through response differences, header injection, provenance confusion, plus MIME denial of service, dedup bypass, unbounded state, crash consistency and fail-open paths. Design inputs: [public email bridge](../architecture/public-email-bridge.md), [messaging app §13](../architecture/messaging-app.md#13-email-bridge-handoff) and [BindleBox spec §9](../spec/bindlebox.md).

## What was built

- **Inbound adapter:** the Cloudflare Email Routing `email(message, env, ctx)` handler, plus a minimal Node adapter with injected stores.
- **Bounded parse:** the stream read stops at 1 MiB whatever `rawSize` claims. Limits cover header bytes, field count and size, line length, multipart depth 4, 32 leaves and 16 delivered parts. Base64, quoted-printable and charsets are decoded strictly, and anything ambiguous is refused whole.
- **Generic refusal:** one reason text for every refusal.
- **Holding queue:** one per owner, with count, byte, per-sender and daily caps. It holds mail for 7 days less an hour, and items expire visibly.
- **Delivery:** to the `public-message-intake` occupant through a brokered port, with `tx = UUIDv5(email-bridge, contract, owner, fingerprint)`. Delivery fails closed when there is no occupant, the flags are off or the owner's switch is off.
- **Auto-reply:** one invariant auto-reply, built as raw bytes for the platform's per-event `reply()`.
- **Follow-up:** sent once on recipient acceptance, from the `notify@` system role.
- **Flags:** everything is behind the new `EMAIL_BRIDGE_ENABLED` (default `"false"` in both Wrangler flag tables) and `BINDLEBOX_ENABLED`. The owner setting also defaults to off.

## Findings

| ID | Severity | Finding | Outcome |
| --- | --- | --- | --- |
| EB-1 | High (depends on receiver setup), confirmed | **Sender-written results trusted.** With the configured authserv-id, a single `Authentication-Results` header was trusted. If the receiver does not add its own header, the sender's copy counted. Effects: a Node reply to a forged victim; a follow-up after a platform `reply()` failed DMARC; and a forged `dmarc:"pass"` signed into provenance. | **Fixed.** The authserv-id is honoured only together with `EMAIL_BRIDGE_AUTHSERV_STRIPS=true`, the operator's attestation that the MTA removes sender copies (RFC 8601 §5). Cloudflare leaves both unset, so results are `unknown`. The ledger records the reply gate. Under `platform`, a follow-up needs the platform to have actually sent the reply. Only under `trusted` does `dmarc=pass` count. Regressions in `tests/email-bridge-review.test.mjs`. With the attestation set, a forged header is trusted **by design**. The attestation needs an operator sign-off: Reviewer ___ Date ___ Outcome ___. |
| EB-2 | Medium, confirmed | **Budgets charged before the narrowest check.** One sender could spend the recipient's daily reply cap. Domain and global units were charged before the sender cooldown, and forged senders whose replies fail DMARC burned the global budget. | **Fixed.** Order is now suppression (read-only), then the sender's 30-day cooldown, then domain, then global. The recipient cap is charged in the claim commit. Units are refunded on any budget miss (the cooldown included) and when `reply()` fails. |
| EB-3 | Medium, reasoned | **Ingress budget exhaustion.** The fleet-wide ingress budget was charged before the recipient was resolved, so mail to nonexistent handles could stop all intake. One sender could also fill a recipient's 200 messages a day. | **Fixed after re-review.**<br>• The budget is charged only after directory eligibility.<br>• A per-owner, per-envelope-sender intake cap of 20 a day was added.<br>• The re-review found that directory lookups for nonexistent handles were now unthrottled. A bounded per-source limit (the envelope domain hashed into 256 buckets, 2,000 an hour each) now runs before any lookup.<br>• Residual: mail to paid users who have opted out still charges the global budget, and rotating envelope senders gets around the per-sender cap; owner daily totals bound both. |
| EB-4 | Medium/low, reasoned | **Timing reveals recipient state.** The response text is identical, but each refusal class does different work first: unknown means one directory lookup; unpaid adds an account RPC; opted-out adds a parse and an object round trip. Timing can therefore reveal existence, paid status and opt-in. | **Partly mitigated.**<br>• The re-review found EB-3's limiter made known recipients slower still.<br>• The Worker handler now answers every outcome no sooner than a 1.5 s floor (`RESPONSE_FLOOR_MS`).<br>• Residual: large accepted mail can exceed the floor.<br>• The design already says SMTP cannot give recipient-existence privacy.<br>• This remains a release gate item. |
| EB-5 | Low/medium, reasoned | **Occupant budgets keyed on the unverified header From.** The BindleBox occupant charges its per-sender and per-domain budgets by the header From even when DMARC did not pass. Spoofed mail can therefore throttle a real sender's mail at the recipient. | **Fixed in the core integration pass.** Budgets use the verified consumer/channel provenance and the signed envelope sender/domain, irrespective of header From or DMARC. Null or malformed envelopes share a bounded unverified bucket per consumer/channel. Regression tests cover forged and rotating From headers, domain caps and provenance isolation. |
| EB-6 | Low, confirmed | **Display spoofing.** Bidi overrides, C1 and zero-width characters survived into `headerFrom`. | **Fixed.** They are now replaced. |
| EB-7 | Low, reasoned | **Refusal after commit.** A failing sender shard after the owner commit made the edge refuse mail that was already held, which the sender's MTA would then bounce. | **Fixed.** A sender-gate error suppresses the reply (`suppressed:error`) and keeps the acceptance. |
| EB-8 | Low, reasoned | **Cooldown windows never pruned.** Sender-store cleanup scanned only the first 8 keys in key order, so per-sender cooldown windows were never pruned. | **Fixed.** Windows now expire through an end-time index. Suppression rows remain permanent by design. |
| EB-10 | Low, re-review | **Refund in the wrong window.** A refund lowered whichever window was current, so one that crossed a rollover undercounted the new day. | **Fixed.** `consume` returns the window it charged, and a refund applies only to that window. |
| EB-9 | Info | **Operational notes.** (1) `postmaster`/`abuse` are refused, so route them separately if a catch-all points at the Worker. (2) The reply carries no `In-Reply-To`; if it is ever added, validate it like `Message-ID`. (3) The ingress limiter is a single hot key. | **Noted** for staging. |

Checked and found sound:

- **Header injection:** every generated address is re-validated as a strict dot-atom mailbox. Texts, subjects and headers are fixed, the `Message-ID` is a hash, and nothing inbound is echoed.
- **Invariance:** the reply depends only on the two envelope addresses, the link, the time and the fingerprint. It is decided in admit, before any delivery.
- **Backscatter:** a reply needs envelope, header From and Reply-To to agree, no automation hint, a non-null sender and a DMARC gate.
- **Claim before send:** crashes never cause a re-send, and duplicate and retried mail collapses through the fingerprint.
- **Message-ID reuse:** a reused Message-ID with other content is refused as a conflict.
- **Follow-up:** at most once per item.
- **MIME parsing:** the parser resisted contrived Content-Type and boundary inputs.
- **Owner binding:** each object is bound to one owner.
- **Fail-closed paths:** missing flags, bindings, `EmailMessage`, signer or occupant all fail closed.

## Spec and implementation differences to reconcile

- **Holding window:** §13 says 30 days, but the occupant accepts `receivedAt` only within 7 days (spec §9). Mail is held for 7 days less an hour. Choose one rule.
- **Follow-up trust:** the earlier bridge design required independent mailbox confirmation before an acceptance notice. This slice instead sends the follow-up to a reply-safe sender whose DMARC was validated by the platform (or by a trusted result). This needs product sign-off.
- **Subject delivery:** the subject reaches the occupant in a `text/rfc822-headers` part (From, Subject, Date). B7 stores `subject:''`.
- **Unknown recipients:** they are refused at SMTP time, as §13 step 1 says. Only accepted mail is ever answered.

## Not production-verified

Nothing here was run against real Email Routing, `reply()` or DMARC behaviour. The core integration pass wires the following locally (still provisional, flags off):

- the `EMAIL_BRIDGE` object binding and append-only SQLite migration `v9` in both Wrangler configurations;
- the account RPCs `emailBridgeEntitled`, `integrationsIntakeSeat` and `integrationsIntakeDeliver`, the `PROVIDER_CONSUMERS` row for feature `email-bridge`, and the X7 intake `deliver` call. Entitlement, the exclusive seat and its exact record/incarnation are rechecked at delivery. The intake slot is recognized only with the bridge and BindleBox flags enabled;
- the `EMAIL_BRIDGE_SIGNING_JWK` configuration read and public-only key publication (secret provisioning remains an operator task);
- owner settings routes and the BindleBox-to-provider acceptance hook (`bridge.accepted`);
Email Routing configuration for the receiving domain and real provider verification remain outstanding.

The dynamic `import('cloudflare:email')` was bundled by the dry run but has not been exercised in workerd. Follow the production gates in [security.md](../spec/security.md) and [DEVLOG](../../DEVLOG.md).


## Core integration, 2026-10-21 (provisional)

Owner routes use the existing session, selected-account, Origin and CSRF checks: `GET /api/email-bridge` reads settings, `PUT /api/email-bridge` changes `{enabled,autoReply}`, and `POST /api/email-bridge/accepted` takes `{jti}`. The owner switch defaults off. Enabling requires current confirmed paid entitlement; delivery checks entitlement again. Production release remains disabled.

The bridge publishes `GET|HEAD /.well-known/bindle/email-bridge-keys.json` and the exact `GET|HEAD /keys/email-bridge/<kid>` named in provenance. Both require the bridge deployment flags and a valid configured signing key. Responses contain only public P-256 coordinates and verification metadata. Private/public key consistency is checked before signing or publication. Node reads the same configuration; its durable owner adapter may be injected as `EMAIL_BRIDGE_OWNER`. No Node SMTP HTTP route or demo route is added.

Production **requires `EMAIL_BRIDGE_SIGNING_JWK` to be set as a Wrangler secret by the authorized operator**, never a Wrangler `vars` entry or committed file. Its JSON format is `{ "kid": "<operator-selected-id>", "privateJWK": <private ES256 P-256 JWK> }`. The operator can provision it with `npx wrangler secret put EMAIL_BRIDGE_SIGNING_JWK`; this integration does not run that command or create a production key. Keep the deployment flags off until the existing release gates and sign-offs are satisfied.

The provisional links resource adds `consumerKey({consumer,keyId})` and `accepted({jti})` only when the bridge is enabled. Both use the ordinary authenticated federation context. Acceptance additionally requires the caller to be the current exclusive public-intake occupant with the exact connection/generation. BindleBox's `providerLink` services adapter exposes these two methods through its injected `links` service. `intake.accept({id})` records the owner's explicit acceptance and notifies the provider with the stored provenance jti; retries reuse that jti. Reading, classification and rescue do not send an acceptance notice. No guest identity, conversation admission or reply capability is created. This contract extension remains provisional: Reviewer ___ Date ___ Outcome ___.

The intake transport preserves the bridge's deterministic transaction UUID, mints an invoke token restricted to the intake `deliver` method and `email-bridge` feature, and uses the existing SSRF-safe Worker/Node transports. Only this call opts into a 1,500,000-byte request ceiling, sufficient for base64-encoded parts bounded to 1 MiB plus metadata; discovery/describe retain their existing 64 KiB request limit. Indeterminate transport outcomes remain bound to the attempted seat and cannot be retried against a replacement occupant.

This is implemented and tested local behavior, not evidence of configured Email Routing, external delivery, live DMARC conformance, or human approval. The holding-window, follow-up-without-mailbox-confirmation and authserv-attestation decisions above remain unsigned.
