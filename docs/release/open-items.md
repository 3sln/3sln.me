# Open items for the project owner

Status: consolidated checklist, written 2026-10-21 from [DEVLOG.md](../../DEVLOG.md) (entries from "2026-10-20 — Scope reduction" onward, plus the 2026-10-14 boot, federation, lifecycle and client-metadata entries for the older flags), [implementation-roadmap.md](../architecture/implementation-roadmap.md) and the `docs/release/*-review.md` files those entries cite.

How to read this file:

- Everything is **provisional and flag-off**. No flag below is enabled in production, `RELEASE_READY` is `false`, and no row implies reviewer sign-off or production verification. See [security.md](../spec/security.md) and `release-status.json` (all 13 release gates are `false`).
- "Recommendation" means what DEVLOG or the design docs record. Where the owner's brief supplied context that is **not recorded in the repo**, the row says so.
- Review files sometimes lag DEVLOG (a finding marked "Open" in the review table but "fixed" in a later DEVLOG integration entry). Where that happens the row says which source is newer. Treat any row marked *(uncertain)* as needing a quick check against the code before relying on it.
- This file does not edit DEVLOG.md. Decisions made here still need to be recorded there.

## 1. Decisions pending from the owner

### 1a. Headline decisions

| # | Decision | Context | Recommendation on record |
| --- | --- | --- | --- |
| D1 | **BindleBox cutover data reset (BB-CUT, irreversible)** | Wave 6 removes peer messaging from core and 3sln.me with a `messaging-retired-v1` reset step. All existing local messages, contacts, conversations and blocks are discarded rather than migrated. `/api/collections` is deleted. DEVLOG: "BB-CUT awaits explicit user confirmation of the irreversible message data reset." Sources: [messaging-extraction.md](../architecture/messaging-extraction.md) §4, roadmap Wave 6, [messaging-app.md](../architecture/messaging-app.md) §19 Q8. | Reset instead of migration (extraction plan; review S-19 accepts dropped blocks "only because no production users exist"). Tag the commit before cutover. Prerequisites in roadmap: all BB-B streams, C1b, IDKEYS-2, X4, durable queue recovery on Node and workerd, simulator scenarios, browser checks. Roadmap-prerequisite status looks met locally *(uncertain; not re-verified here)*. |
| D2 | **Messaging app name** | The interop spec is named "Bindle Messaging" (user decision, DEVLOG 2026-10-20). The *app* name is open. A mechanical rename of `bindlebox` docs, packages (`packages/bindlebox-*`, `apps/bindlebox`, `tests/bindlebox`, `scripts/bindlebox.mjs`), the `BINDLEBOX_ENABLED` flag and the `bindlebox.md` spec follows the decision. | DEVLOG still records the coordinator recommending "Parley" with "3sln Messages" as the plain fallback. **Per the owner's brief (not recorded in DEVLOG): Parley and Parlay were rejected over name clashes, and a naming pass was offered.** BindleBox was the original proposal (picked from eight candidates, no trademark search). No trademark search has been done for any candidate. DEVLOG's Parley line is stale. |
| D3 | **Conversation gate: option A vs C** | A = shared-secret gate, independently signed events, no sequencer (implemented in BB-B4, "provisional pending user confirmation"). C = drop the secret in favour of identity plus bilateral admission. [messaging-app.md](../architecture/messaging-app.md) §19 Q4, [conversation-contact-design.md](../architecture/conversation-contact-design.md). | Option A was built as "the user's stated preference" and "the earlier preference". No recommendation for C is recorded. Changing to C would rework `packages/bindlebox-engine/domains/conversations.mjs` and spec §6. |
| D4 | **24 h delegation certificates** | `key-delegation.v1` certificates limited to message/receipt/archive signing, `DELEGATION_CERTIFICATE_SECONDS` host-configurable, 24 h maximum. Status checks are mandatory for lasting-effect records and receipts, not plain messages. Alternative: shorter certificates and more renewals. DEVLOG: "24 h delegation certificates as a provisional default pending the user's answer." | Keep 24 h (provisional default). BB4-I1 (retries carry renewed certificates) was fixed to support it. |
| D5 | **Invariant auto-reply policy** | Email bridge sends one invariant auto-reply to every aligned, DMARC-validated sender of accepted public email, regardless of occupancy; the owner can opt out. Required by [extensions.md](../spec/extensions.md) §9.8; marketing value. [messaging-app.md](../architecture/messaging-app.md) §19 Q3. | Accept (implemented that way, owner opt-out default off). |
| D6 | **Bundled instance as opt-in** | Whether BindleBox is offered as an opt-in default occupant at signup, or needs explicit installation. §19 Q5. | Recommended: offer it as an **opt-in** default occupant at signup. **Tension to resolve:** the accepted extensions decision is "built-in occupants are never preselected" (SEC-22, neutral ordering). An opt-in offer at signup must be shown as a neutral choice, not a preselection. |
| D7 | **Email-only public intake in v1** | Whether a handle accepts Bindle-native messages from strangers in v1, or only bridged email. §19 Q6. | Email only (recommended; no public per-entity slot resolution, as extensions Q1 was answered "not needed"). |
| D8 | **Spam thresholds** | `T_high` 0.97 (auto-reject to `sys:spam`, recoverable 500 items / 7 days) and `T_low` 0.70 (`sys:suspected.spam`), bound to the classifier model version, calibration mode on model change, no auto-reject without a classifier. [messaging-app.md](../architecture/messaging-app.md) §12.1, §19 Q7. | 0.97 / 0.70 are the provisional values in DEVLOG. **Per the owner's brief (not recorded in DEVLOG or docs): the coordinator suggested 0.98.** Live Clef accuracy is unverified, so any value is unvalidated. |
| D9 | **Slot registry location** | Where slot manifests are published. [extensibility-design.md](../architecture/extensibility-design.md) §11 Q5. | Recommended: a generic `/artefacts/slots/` registry (classifier slot there; messaging slots in the messaging spec). Implemented locally as `docs/artefacts/slots/item-classifier-v1.json`; not published remotely. |
| D10 | **Integration manifest location** | Member of OAuth client metadata (one source of truth, shares the 16 KiB bound) versus a separate document with a second fetch. extensibility Q3. | No explicit recommendation recorded. The implemented design (EXT-X3) is the client-metadata member `bindle_integration`; confirm or request the separate document. |
| D11 | **Link inheritance on occupant change** | A new messaging occupant can list, rotate, evaluate and revoke links the previous occupant issued. [core-links-review.md](core-links-review.md) item 6; [bindlebox.md](../spec/bindlebox.md) §4.2. | Provisional rule: links stay with the slot and are inherited; owner sees previous occupant's links with bulk revoke and reissue (review S-14). "To be recorded as a decision in DEVLOG" is still outstanding. |
| D12 | **Email bridge: hold duration, follow-up confirmation, authserv attestation** | See 1c. | Needs sign-off; no coordinator recommendation recorded beyond the implemented defaults. |

### 1b. Events and consent questions Q1–Q12

Source: [consent-experience.md](../architecture/consent-experience.md) §13 and [events-consent-review.md](events-consent-review.md). DEVLOG records no separate coordinator answers; the "default in design" column is what revision 2 and the code assume.

| Q | Question | Default in design / code | Status |
| --- | --- | --- | --- |
| Q1 | Bus as an `exclusive` slot with a critical `bus` member (one bus per entity per manifest) vs a new primitive | Slot (implemented, EV-1/EV-2) | Needs confirmation |
| Q2 | UI name "Event feed" vs spec name "event bus" | Event feed in UI | Needs confirmation |
| Q3 | Doorbell-only push, or records inline later | Doorbell only (implemented, EV-3) | Needs confirmation |
| Q4 | Long-poll only in v1, SSE deferred | Long-poll only | Needs confirmation |
| Q5 | New readers see no history unless owner opts in | No history (implemented) | Needs confirmation |
| Q6 | Suppression secrecy (one-click blocked notice) vs telling apps `suppressed` | Secret (implemented, IA-1/IA-2) | Accepted residual awaiting user decision |
| Q7 | Refuse act-as-you, money and identity items for unreviewed apps | Refuse (implemented; IA-R1 fixed) | Needs confirmation |
| Q8 | Separate event allowance, 2,000/day Free, 20,000 paid, at most half per publisher | Implemented. EV-2 adds a provisional 25% readers' share for charged empty reads (deviation from spec §9) | Deviation needs sign-off |
| Q9 | Reference limits: buses 8 Free / 32 paid, retention 7 / 30 d, 10,000 records or 16 MiB per feed, decline ladder 24 h / 7 d / 30 d, caps 3/h, 6/d, 20 per 30 d | Implemented | Needs confirmation |
| Q10 | Who reviews contracts for the provider catalogue; is the label "Checked by 3sln.me" legally acceptable | Open | Owner/legal decision; blocks reviewed-contract wording in consent |
| Q11 | May an app *ask* the owner to turn on push (via `configure`-style UX) | Owner-initiated only; app-initiated push request is **not built** | Needs decision |
| Q12 | Move long-poll waits out of the account Durable Object into a per-feed notifier if residency costs are material | Waits are held in a separate `EventBusWaiter` DO (`EVENT_BUS_WAITS`, migration v8) | Largely moot; revisit on cost evidence |

### 1c. Email bridge sign-offs

Source: [email-bridge-review.md](email-bridge-review.md) "Spec and implementation differences".

| Item | Detail | Recommendation |
| --- | --- | --- |
| Hold duration | Mail is held 7 days less 1 hour (occupant accepts `receivedAt` only within 7 days, bindlebox spec §9); [public-email-bridge.md](../architecture/public-email-bridge.md) §13 says 30 days | Choose one rule. DEVLOG records the question, no recommendation. |
| Follow-up without mailbox confirmation | Follow-up goes once, on acceptance, to a DMARC-validated reply-safe sender; the earlier design required independent mailbox confirmation | Needs product sign-off |
| `EMAIL_BRIDGE_AUTHSERV_STRIPS` attestation | SPF/DKIM/DMARC provenance is trusted only when the operator attests the upstream `authserv-id` stripping behaviour (EB-1 high, fixed this way) | Operator must verify real Cloudflare behaviour first |

### 1d. Other items marked as awaiting the user

| Item | Where recorded |
| --- | --- |
| AMD-C12–C20 (events, incremental authorization, consent) proposed and **unsigned**. AMD-C1–C11 were approved provisionally 2026-10-20 | DEVLOG 2026-10-20 (events entry); [consent-experience.md](../architecture/consent-experience.md) §12 |
| Activity open questions: push caps (3/app/h, 10/app/day; 6 and 20 per account), whether updates mark read items unread, 90-day maximum expiry / 32 revisions, messaging app name and historical transfer approach | [activity-design-review.md](activity-design-review.md) "Open questions for the user" |
| Provisional deviation from integrations §2.3: added JWKS keys stay pending until a pinned key vouches (fixes X3 S1 high) | DEVLOG X3 entry |
| Provisional app credential lifetime model: 15 min Bearer / 60 min DPoP access tokens, rotating refresh with reuse detection, no absolute lifetime, 180-day idle (`APP_REFRESH_IDLE_DAYS`), app approval choices `ongoing` (default) / `1h` / `8h`. Supersedes the earlier 30 d / 7 d cap. Roadmap conflict-resolution item 14 still states 30 d / 7 d and is stale | DEVLOG LA1/LA2 entries; [linked-approval.md](../architecture/linked-approval.md) §15 Q1, Q4 ("pending user confirmation") |
| ACT2-R8: named IANA time zones in quiet hours (design said fixed offsets only) | [activity-design-review.md](activity-design-review.md) |
| BB4-I3 spec reconciliation: genesis-only membership, awaiting-secret 503, one epoch per event, proposal auto-accept for listed peers vs §6.3 "never auto-accepted" | [bindlebox.md](../spec/bindlebox.md) lines marked "Provisional BB4-I3" |
| BindleBox spec items for the design owner: `secret-share` should require a status check; envelopes signed per recipient; multicast results lack per-context status; gap/introduction liveness | DEVLOG BB-B1 entry; [bindlebox-protocol-review.md](bindlebox-protocol-review.md) |
| LH-6: conditional links cannot admit authors from other hosts (functional gap, to be recorded) | [link-handoff-bridge-review.md](link-handoff-bridge-review.md) |
| Owner-approved device-auth defaults (30 d etc.) were accepted 2026-10-20; the device-authorization checkpoints DA1–DA5 remain pending | [device-authorization.md](../spec/device-authorization.md) §11 |
| Terms and privacy approval, and the other release gates | `release-status.json` |

## 2. Per feature flag: gates before enabling in production

Defaults are from `wrangler.jsonc`. All are off unless stated. "Missing verification" lists what has **not** been observed anywhere outside local tests. Common to every flag: the release gates in [security.md](../spec/security.md) ("Required verification before a public beta") and the sign-off checkpoints S1–S5 (all unchecked).

| Flag | What it enables | Open findings and gates that block it | Required secrets / config | Verification still missing |
| --- | --- | --- | --- | --- |
| `DEVICE_AUTHORIZATION_ENABLED` | Link-plus-code approval, RFC 8628 device grant for reviewed clients, `/approve`, legacy `/api/auth/device/*` aliases on the new core, feature `device-authorization.v1` (declared only when mounted), LA7 devices UI | No High open. Accepted residuals: LA2-S8 per-instance `jti`/optional nonce (shared store is an LA3 follow-up), LA2-S12, LA3-S6. LA2-S2 (SDK token ceilings) is marked "Open" in [linked-approval-review.md](linked-approval-review.md) but DEVLOG's Wave 2a integration says SDK lifetimes were aligned *(review table stale)*. Sign-offs DA1–DA5 blank | `LINKED_CODE_KEY` or `KEY_ENCRYPTION_KEY` (code HMAC index); Turnstile site and secret keys (inline sign-in on `/approve`); optional `APP_REFRESH_IDLE_DAYS`, `APP_ACCESS_TOKEN_MINUTES`, `APP_DPOP_ACCESS_TOKEN_MINUTES` | WebKit/iOS evidence (4 WebKit skips); a real CLI against a deployed Worker; real passkey step-up across devices; production Turnstile on `/approve`; owner confirmation of lifetime model |
| `EXTENSIONS_ENABLED` | Slot and extension declarations (EXT-X1/X2) in manifests | AMD-C1–C11 runtime work was deferred to EXT-X1 and tracked in the roadmap table; whether each has fully landed is **uncertain** and needs reconciling in DEVLOG. Slot registry location (D9). Conformance against a provider without support not exercised in production | None known | Independent integration server and unsupporting-provider conformance (local fixture only); flags alone do not advertise support (mount evidence needed) |
| `INTEGRATIONS_ENABLED` | Connections domain (X4), Apps and integrations console (X11) and access views (CX-3), integration events outbox (X6), discovery and brokered records (X7), EV-3 doorbells (with `EVENT_BUSES_ENABLED`), classifier and Drive built-ins | Open per [extensibility-review.md](extensibility-review.md): W5-S4 durable cross-isolate assertion `jti` store (Low, production need); W5-S3 review screen does not diff jwks/auth method/redirects; W5-S6 `hint_endpoint`, `bindle_connection` and connection-bound refresh unimplemented (declaration provisional); X7 issuer-wide hint directory and AMD-C10 checks; X6-S7 accepted; "ordinary re-consent re-pins a changed snapshot without staged review" (suspicion, unresolved); request history needs an audit store that does not exist; CX-3 shell composition and integration-hosted feed management pending. Decisions D10, Q10 | `KEY_ENCRYPTION_KEY`; production ports `BROKERING_MINT`, `INTEGRATION_EGRESS`, `MESSAGING_DESCRIBE` (docs say production wiring needs them); `vendor/tldts` is vendored, no config | Worker egress is screened but **not connection-pinned** (DoH only): verification against private and rebinding targets required; Node pinned POST egress is local only; no real third-party integration |
| `BROKERING_ENABLED` | `/oauth/brokering/jwks` and purpose-separated ES256 brokering keys (invoke, describe, discover, event); `brokering_jwks_uri` now lives in `brokered-resources.v1` | [brokering-keys-review.md](brokering-keys-review.md): key-compromise runbook with generation bump, X6/X8 events and **CDN purge of the JWKS path** is still to be written; removed keys remain trusted up to 1 h by caching integrations (accepted) | `KEY_ENCRYPTION_KEY` (HKDF source; sealed keys); key provisioning | Rotation and compromise drill; CDN purge procedure |
| `BROKERED_INTROSPECTION_MOUNTED` | One mount switch for RFC 7662 introspection (own rate limit), `integrations.v1` and `brokered-resources.v1` declarations, minting, severance drain and snapshot port (X8). Write-capable brokered contracts are mintable only while mounted | X8-R2 partly fixed: grant IDs do not rotate on re-approval (only a changed field revokes tokens) and read-only access relies on the 360 s bound; X8-R5 partly fixed (forged tokens naming a real connection still cost an account RPC; per-IP limits belong to the adapter); durable limiter and `jti` store needed (per process today). R7 (three disagreeing switches) is marked closed in DEVLOG, "Open" in the review table *(review stale)* | Pinned `private_key_jwt` client keys; adapter per-IP limits | Live conformance with an independent integration (EXT-X9b is local fixtures only); 360 s bounded-revocation behaviour with a real integration |
| `ACTIVITY_V2_ENABLED` | Signed app activity (`packages/activity`), activity center UI (ACT-3), per-app push policy (ACT-2), `/api/activity` | [activity-design-review.md](activity-design-review.md): ACT1-S6 (activity reuses the v1 ES256 key; separation is in-payload only), ACT1-S7 (admission toggle shared with v1), ACT1-S10 and ACT2-R11 (`allowedMethods` answers 405 not 404 with flag off), ACT1 audit principal missing, ACT2-R8 (zones deviation), ACT2-R9 (preview enablement without device proof). Not done per review: scheduler driving the push outbox *(uncertain whether later wired)*, service-worker rendering of activity notices *(uncertain; LA7 added approval-notice rendering only)*, per-device preview proof, digest recompute on zone change. Lifecycle export/erase hooks *(uncertain)*. Owner questions in 1d | `VAPID_PRIVATE_KEY` secret (public key set); `PUSH_ENABLED` | Real Web Push delivery (`notificationTransportsVerified` is false); service-worker rendering on real devices; search and date filters are page-scoped and owner/system facets need backend data |
| `EVENT_BUSES_ENABLED` | Bus manifest validation (EV-1), 3sln.me-hosted bus (EV-2), doorbells (EV-3, also needs `INTEGRATIONS_ENABLED`) | EV2-S4 sweep wiring implemented locally (was a gate); EV2-S5 accepted; EV3 residuals (subscribe caps hint at other subscribers; subscribed bus wakes alarm per publish); app-initiated push (Q11) unbuilt; AMD-C12–C20 unsigned; Q1–Q12 above. `docs/artefacts/event-bus-v1.json` is provisional and unpublished | `EVENT_BUS_WAITS` DO binding and migration v8 deployed; event allowance config | Production cost of long-poll residency (Q12); real workerd deployment; EV-4 integration-hosted bus against a third-party |
| `INCREMENTAL_AUTH_ENABLED` | `grant-more` and `configure` entry intents, suppression, caps and cooldowns, consent walkthrough (CX-2), embedded request element (IA-4) | IA-R2 closed (login re-runs now count as `grant-more`). Centralized pre-owner store `bindle-incremental-v1` "needs capacity review before enabling". Partial-commit recovery proven only with fault-injected ports, not real Node ports. AMD-C12–C20 unsigned. Q6–Q9 | Same federation config as the authorization entry | Consent comprehension research with real users (security.md "Consent" row); Firefox and WebKit/mobile evidence for the embedded popup flow (Chromium and Firefox checked locally) |
| `BINDLEBOX_ENABLED` | The separate messaging app (Worker and Node shells, web client, archive, bridge receiver). Prerequisite for the bridge | D1–D8; spec reconciliation BB4-I3 unsigned. Open: BB2-I1 (no policy-change operation yet, must clear `decision/{jti}/*` when added); BB6 archive residuals (BB6-S8 control-field schema portability, imported rows from an old occupant marked unverified, legacy/redacted imports unverified); LH-6; LH-7b accepted; IDKEYS review item 7 (race in `packages/conversations/runtime.mjs`, deleted at cutover, the replacement must not repeat it); KD-8/9/10 accepted. Messaging-address `describe` needs EXT-X7 production wiring or descriptors answer `recipient_unavailable` | `BINDLEBOX_KEY_ENCRYPTION_KEY`, `BINDLEBOX_EGRESS`, `BINDLEBOX_CLIENT_ID`, `BINDLEBOX_SERVICES`, a **durable authenticated key-holder service** (mandatory outside local tests; the Node helper is disposable), `CLASSIFIER_MODEL_VERSION` | Production key custody and recovery; durable queue recovery on deployed workerd/SQLite Durable Objects (local workerd tests pass); live classifier accuracy; real multi-host federation between instances; archive restore drill |
| `EMAIL_BRIDGE_ENABLED` | Public handle email intake, held queue, one invariant auto-reply, delivery to the public-intake occupant. Needs `BINDLEBOX_ENABLED`, paid entitlement and the owner opt-in (default off) | EB-4 timing side channel only partly mitigated (1.5 s floor; "remains a release gate item"); decisions in 1c; EB-9 notes (route `postmaster`/`abuse` separately, ingress limiter is a single hot key); [public-email-bridge.md](../architecture/public-email-bridge.md) unsigned; spam thresholds D8 | `EMAIL_BRIDGE` DO binding and migration v9 (in both wrangler configs); **`EMAIL_BRIDGE_SIGNING_JWK` as a Wrangler secret** (`{kid, privateJWK}`), never a var; `EMAIL_BRIDGE_AUTHSERV_STRIPS`; Email Routing configured for the receiving domain; `EMAIL`/`MAIL_SENDER_DOMAIN` already set for sending | **Never run against real Email Routing, `reply()` or live DMARC.** The dynamic `import('cloudflare:email')` is bundled by the dry run but not exercised in workerd. Backscatter and deliverability untested |
| `LIFECYCLE_ENABLED` (default false), `LIFECYCLE_DRY_RUN` (default true), `LIFECYCLE_PURGE_ENABLED` (default false) | Scheduled warnings, suspension and purge of unpaid inactive accounts; cold tiering (`LIFECYCLE_COLD_*`) | [lifecycle-runner-review.md](lifecycle-runner-review.md) reviewer blank. Ever-paid marker and fresh Polar check required before purge are implemented and tested with doubles. Cold-tier threshold is 4 MiB while hosted objects cap at 1 MiB, so nothing tiers today. Notices are English-only. Retention policy and legal wording need owner sign-off | Polar production credentials; `accounts@sys.3sln.me` sender; cron `17 */6 * * *` | **Polar list behaviour unverified offline: a sandbox check is required before purge is ever enabled.** `accounts@` mail never verified with a real recipient; admin-hold freeze observed only in tests |
| `CLIENT_METADATA_ENABLED` | `client-id-metadata.v1` (metadata-document clients) | [client-metadata-review.md](client-metadata-review.md) residuals: distinct-ID flood can exhaust the global budget and evict cached clients; Node ignored `Cache-Control` (later fixed per Wave 2a); a token without Origin survives up to 5 min after a block. Sign-off blank | None; admin block list | Workers egress against private and rebinding targets (explicit gate in security.md) |
| `FEDERATION_ENABLED`, `FEDERATION_ENTRY_ENABLED`, `EMBED_ORIGIN` | Federation routes, the provider authorization-entry page and the dedicated embed origin (islands). Entry and embed origin are **not set** in `wrangler.jsonc` | DEVLOG: entry flag "remains off pending human sign-off, registered production clients or `client-id-metadata.v1`, Firefox/WebKit/mobile evidence, checks against a deployed Worker". Embed islands open: EL-2 (pagehide session end departs from EIR-4), EL-3 (FedCM can lose activation), EL-11; FedCM provider endpoints do not exist. [federation-mount-review.md](federation-mount-review.md) M2 (provider UI for `?entry=`) appears addressed by the A7 entry page *(uncertain)* | `FEDERATION_CLIENTS` (static registrations), a separate embed hostname and DNS; `FEDERATION_SCHEMAS` | WebKit/iOS and mobile browsers; deployed-Worker run; FedCM verified only against a test double; same-site cookie behaviour on the real embed origin |
| `BOOTSTRAP_TOKEN_SHA256`, `ADMIN_ENABLED`, `ADMIN_CLAIMS_ENABLED`, `BOOT_ACCESS_HOURS` | Boot principal (single-use claim or restore, expires) and admin console; `AdminAuthority` DO (migration v6) | [boot-and-admin-review.md](boot-and-admin-review.md) and [admin-ui-review.md](admin-ui-review.md): no Critical/High open. Deferred: runtime badge editing, external audit-anchoring; reservations created before the expiry index are not released; UX finding U13 partial. Sign-off blank | Operator mints a token and deploys **only its SHA-256 digest**; never the token | Real passkey admin step-up on a deployed host; boot token one-time consumption on production storage |
| `MCP_ENABLED` | MCP service | Not examined in depth here ([mcp-audit.md](mcp-audit.md)) | `MCP_CLIENTS` | Not assessed |

Production release overall: `RELEASE_READY=false`, all 13 gates in `release-status.json` are `false` (Turnstile production configuration, bot protection, real browser flows, durable storage and archive recovery, notification transports, email lifecycle, storage provider conformance, federated OAuth conformance, general preference consent, web archive rendering, lifecycle notices and deletion, red-team findings, terms and privacy).

## 3. Open review findings by severity

Source of truth is DEVLOG where it is newer than the review file. "Partly" means partly fixed. Counts are what is listed below, not a count of every finding in each review (most findings are fixed).

### Release blockers or High still open

None recorded as open after Wave 5 plus the BRIDGE integration. Items that were High and are now closed, so that nothing is lost: LA-R1/R2, LA2-S2 (see stale note), IA-R1, IA-R2a, X3-S1, S1 token-endpoint downgrade (Wave 5 review), EB-1, BR-1, BB6-S3/S4. Remaining production **gates** (not findings) are the "Missing verification" column in section 2.

### Medium (6)

| ID | Finding | Status | Review |
| --- | --- | --- | --- |
| X8-R2 | Re-approval keeps the same `bindle.grant` ID; federation-side revocation may not reach the X6 outbox | Partly: `iat` check added; grant IDs still not rotated; read access relies on 360 s | [extensibility-review.md](extensibility-review.md) |
| X8-R5 | Forged tokens naming a real connection cost an account RPC and key resolution before authentication; timing reveals connection existence | Partly: read-only verify and per-IP limit added; adapter-level limits and a durable limiter still needed | same |
| W5-S3 | Staged integration change approval now needs step-up, but the review UI does not diff jwks, auth method and redirects | Fixed (step-up); diff open | same |
| EB-4 | Email bridge timing reveals recipient existence, paid status and opt-in | Partly: 1.5 s response floor; large mail can exceed it | [email-bridge-review.md](email-bridge-review.md) |
| BB6-S8 | Archive import trusts rows from any valid signer | Partly: anchored import, allowlists, envelope and body re-verification added; control-field schema portability and previous-occupant trust remain | [bindlebox-archive-review.md](bindlebox-archive-review.md) |
| Re-consent re-pin | Ordinary re-consent re-pins a changed integration snapshot without staged review before revalidation | Open suspicion, to resolve with X3/X4 | [extensibility-review.md](extensibility-review.md) (note after W5-S6) |

### Low and Info (15)

| ID | Finding | Status | Review |
| --- | --- | --- | --- |
| W5-S4 | Token-endpoint assertion `jti` cache is per isolate | Open: durable cross-isolate store needed | [extensibility-review.md](extensibility-review.md) |
| W5-S6 | `hint_endpoint`, `bindle_connection`, connection-bound refresh not implemented although `integrations.v1` is declared | Open and disclosed | same |
| X7 | Issuer-wide connection to account hint directory; AMD-C10 checks | Open | same, [wave4-integration.md](wave4-integration.md) |
| X6-S7 | Issuer exclusion covers host and subdomains only | Accepted, open | same |
| LA2-S8, S12; LA3-S6 | Per-instance RPC `jti`; refresh grace alternation; owner shard wakes | Accepted residuals | [linked-approval-review.md](linked-approval-review.md) |
| ACT1-S6 | Activity reuses the v1 ES256 key | Open | [activity-design-review.md](activity-design-review.md) |
| ACT1-S7 | Admission toggle shared with v1 messages | Partly | same |
| ACT1-S9 | Audit lacks the app principal | Open | same |
| ACT1-S10, ACT2-R11 | `allowedMethods` lists activity paths with flag off (405 not 404) | Open, low | same |
| ACT2-R8, R9 | Named zones deviation; preview enablement without device proof | Open | same |
| BB2-I1 | Owner policy change does not clear cached audience decisions | Open until a policy-change operation exists | [bindlebox-receive-review.md](bindlebox-receive-review.md) |
| LH-6, LH-7b | Conditional links cannot admit other-host authors; O(N) fingerprint pruning | Accepted, provisional | [link-handoff-bridge-review.md](link-handoff-bridge-review.md) |
| EV2-S5, EV3 residuals | Refusal reveals shared limit; subscribe caps and alarm wakes | Accepted | [events-consent-review.md](events-consent-review.md) |
| IDKEYS #7 | Key/pointer race in `packages/conversations/runtime.mjs` | Open; module deleted at BB-CUT, replacement must not repeat | [identity-keys-review.md](identity-keys-review.md) |
| KD-8/9/10, core-links #6/#7, brokering #8 | Timing difference, pruned-key alias check, double caching, link inheritance, non-canonical base64url, raw `KEY_ENCRYPTION_KEY` use | Accepted | [key-delegation-review.md](key-delegation-review.md), [core-links-review.md](core-links-review.md), [brokering-keys-review.md](brokering-keys-review.md) |

Not yet reviewed or not independently re-reviewed (per DEVLOG): every revision-2 fix to the events and consent design; EV-3 fixes; the A-1 to A-8 abuse cases; EB fixes; the Wave 4 and Wave 5 integration passes (coordinator-verified only); the BB-B8 shell ("independent review pending").

Review files that disagree with DEVLOG and should be refreshed: [linked-approval-review.md](linked-approval-review.md) (LA2-S2, LA2 open list), [extensibility-review.md](extensibility-review.md) (X8-R7, X3-S2, X4-R2 admin hook), [key-delegation-review.md](key-delegation-review.md) (KD-4 closed by X4), [bindlebox-archive-review.md](bindlebox-archive-review.md) (S7 and S8 gates implemented locally).

## 4. Unsigned design sign-offs

Every row has a blank Reviewer, Date and Outcome (or a "Pending" slot). Recorded in DEVLOG as "Reviewer ___ Date ___ Outcome ___" unless noted.

| Doc | Slot |
| --- | --- |
| [messaging-app.md](../architecture/messaging-app.md) | Sign-off table: name, signing model, links boundary, send queue, bridge handoff and auto-reply, data reset, spike decisions D1–D4 (7 rows, all `___`) |
| [messaging-extraction.md](../architecture/messaging-extraction.md) | Reviewer line |
| [bindlebox.md](../spec/bindlebox.md) | Interop spec; BB4-I3 reconciliation "pending" |
| [extensibility-design.md](../architecture/extensibility-design.md), [extensions.md](../spec/extensions.md), [integrations.md](../spec/integrations.md) | Revision 2 provisional; AMD-C1–C11 provisional only |
| [events.md](../spec/events.md), [incremental-authorization.md](../spec/incremental-authorization.md), [consent-experience.md](../architecture/consent-experience.md) | Revision 2; AMD-C12–C20 unsigned |
| [device-authorization.md](../spec/device-authorization.md) | DA1–DA5 all "Pending" |
| [linked-approval.md](../architecture/linked-approval.md) | Architecture/security/product line |
| [activity.md](../spec/activity.md), [activity-center.md](../architecture/activity-center.md) | Provisional, reviewer blank |
| [public-email-bridge.md](../architecture/public-email-bridge.md), [email-bridge-review.md](email-bridge-review.md) | Reviewer blank |
| [auth.md](../spec/auth.md) | A1–A5 unchecked, includes the provisional token-lifetime line |
| [security.md](../spec/security.md) | S1–S5 unchecked |
| [account-lifecycle.md](../spec/account-lifecycle.md), [account-lifecycle-executor-design.md](account-lifecycle-executor-design.md), [lifecycle-runner-review.md](lifecycle-runner-review.md) | Decision table "Pending" |
| [federation-implementation.md](../spec/federation-implementation.md), [client-metadata-review.md](client-metadata-review.md), [components-profile.md](../architecture/components-profile.md) | Reviewer blank; `client-id-metadata.v1` declaration needs sign-off |
| [embed-islands.md](../architecture/embed-islands.md), [adaptive-app-sign-in.md](../architecture/adaptive-app-sign-in.md), [embeddable-elements.md](../architecture/embeddable-elements.md) | Architecture/security/frontend sign-off blank |
| [boot-and-admin.md](../architecture/boot-and-admin.md), [admin-ui-review.md](admin-ui-review.md) | Reviewer blank |
| [bindle-links.md](../architecture/bindle-links.md), [links.md](../spec/links.md) | Sign-off blank |
| [app-engine.md](../architecture/app-engine.md) | "User sign-off: Reviewer ___ Date ___" |
| [recovery-identity.md](../spec/recovery-identity.md), [messaging.md](../spec/messaging.md), [app-metadata.md](../spec/app-metadata.md) | Reviewer blank (older, outside the scope-reduction period) |
| [wave4-integration.md](wave4-integration.md) | Six decision rows, all "provisional" |

## 5. Known environment limits

- **WebKit and iOS Safari cannot be tested here.** WebKit page creation times out; every browser gate reports 4 WebKit skips. Chromium and Firefox pass. Passkeys, popup/redirect sign-in, FedCM, `/approve` and islands have no WebKit or iOS evidence.
- **Cloudflare Email Routing is unverified.** The bridge has never received real mail, never used `reply()`, and `import('cloudflare:email')` has not run in workerd. Only one outbound message (`notify@sys.3sln.me`) has been verified end to end through Email Sending; the other sender roles, reminders and suppression handling are not.
- **Polar is unverified offline.** The lifecycle purge guard, refund, chargeback and archived-product handling are tested only with doubles. A sandbox check is required before purge is ever enabled.
- **No real push delivery evidence** (`notificationTransportsVerified` false); service-worker rendering is tested locally only.
- **Workers egress is not connection-pinned** (strictly-public fetch plus DoH). Rebinding and private-target tests against a deployed Worker are outstanding. Node uses DNS-pinned egress, tested locally.
- **Turnstile production configuration and bot protection** are unverified (release gates). Local runs use throwaway keys or doubles.
- **No deployed-Worker conformance** for federation, device authorization, integrations or brokering with a third-party server. Only repo fixtures (`tests/fixtures/integration-server.mjs`, `integration-bus.mjs`) exist.
- **FedCM** is verified only against a test double; provider FedCM endpoints do not exist.
- **Classifier accuracy** (Clef / `CLASSIFIER_MODEL_VERSION`) is unmeasured; spam thresholds are unvalidated.
- **No trademark search** for any messaging app name.
- **Consent comprehension research** with real users has not been done.
- **Test-environment history to keep in mind:** the Codex sandbox could not bind localhost (Worker tests ran elsewhere); load-sensitive flakes were fixed at the root but parallel e2e runs have shown unexpected browser closures, so full e2e runs serially; Codex capacity errors forced Claude to finish X11 and X8 integration. The standing gate set is `npm test` (core 2012 at last record), `test:worker` 67, `test:ui-state` 290, `test:bindlebox` 196, `test:bindlebox:web` 41, DOM, `build:assets`, `check:worker` (dry run only), and `test:e2e` 213 twice (flags off, and `E2E_DEVICE_AUTHORIZATION=1`).
- **Not re-run for this document.** Numbers above are copied from DEVLOG and the review files, not re-executed.
