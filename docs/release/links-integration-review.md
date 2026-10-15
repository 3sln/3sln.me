# Links integration (L4, L5, L6): independent review

Date: 2026-10-14. Scope: the integration slice that routed the previously unrouted Bindle links, authored contact delivery and tag libraries end to end on the local Worker and Node adapters, moved developer contact to one conditional link, and added the contact-page opener flow and owner intake editing. Two independent agent reviewers audited the working-tree diff: a security reviewer and a UI/UX red-team reviewer. Their reports are summarized below with dispositions. This is local evidence only: nothing was deployed, no production gate changed, and no capability here is production-verified. Human sign-off: reviewer ___ / date ___ / outcome ___.

## What was wired

- **Edge routing (review finding #7).** `packages/runtime/http.mjs` takes every contact-route decision from the shared raw-query parser (`parseLinkQuery`). New-form links route on `parseLinkMeta(...).claims.sub` after an exact `aud` pre-check; legacy links route on the `sig` payload. The account object re-verifies everything. `bindle_data` is accepted only by a JSON-inspection GET and is `link_malformed` on HTML, HEAD, the metadata, profile and bearer representations and on POST.
- **Representations.** HTML composer; JSON inspection (the only evaluator of responses, with the bounded `LinkReplayRecord` and per-claimed-principal rate limit); `application/vnd.bindle.contact-intake+json` metadata (side-effect free, `Accept-Language` labels); the contact-profile representation; the contact-delivery bearer (`Accept: …contact-token+jwt; profile="contact-delivery-v1"`).
- **Authored delivery only (D10 cutover).** Strict two-part multipart POST and `POST /bindle/rpc` with a contact-delivery bearer both reach `ContactDeliveryService` (prepare/commit split). Anonymous `?sig=` multipart and inbox-bearer `/api/messages` submission return `403 author_required` with a clear message. Receipts are author-scoped, retained for the spec horizon and collected by bounded alarm sweeps.
- **Ports.** `parents.verify/live` (URL or bearer credential; legacy carve-out profile), `intake`, `localAuthorResolver` backed by an `IDENTITY_ACCOUNT` directory port plus the author account's `identitySigningKey`, and the admission key. Blob staging, storage quota, receipt budget and activity admission wrap the commit exactly like legacy receipt.
- **Conditional links.** Per-author-per-UTC-day quotas, delivery-time host policy read from a recorded decision (positive final decisions reused to UTC midnight, everything else at most 15 minutes), policy-derived `priority:*` tags with provenance `policy`; the L0 503 refusal of conditional parents is removed.
- **Owner operations.** `POST /api/contact-links`, `GET/PUT /api/contacts/:id/intake`, `POST /api/contacts/:id/rotate`, `POST /api/links/respond` (same-host response signing after an explicit click), `POST /api/links/envelope` (the author's provider signs an envelope it constructs), `GET/PUT /api/tags/labels`, `POST /api/rules/:id/restore`, `data.tagLabels` in the account snapshot, `migrateTags` in search documents.
- **Developer contact (L5).** One conditional link owned by the protected developer identity, policy from the operator registry: eligible with a confirmed paid entitlement, or while the active population is below 1,500; same-host principals only. `GET /api/developer-contact` returns the link and the caller's eligibility. Daily-grant issuance and its internal grant path are removed; expired daily grants are reclaimed in bounded passes and unexpired ones expire naturally.
- **Multi-account follow-up.** Signing out of an account (single, saved-account or all) removes that account's push subscription for this device, best effort, before the session is revoked.

## Implementation decisions and spec differences (provisional)

| Topic | Implemented | Spec relation |
| --- | --- | --- |
| Revocation fence | The author key is re-resolved immediately before the account gate, not inside the owner transaction. Cross-account calls inside a Durable Object's `blockConcurrencyWhile` can deadlock when two accounts deliver to each other. | Narrows the L0 "resolve inside the transaction" note; the window is the gate wait plus blob staging. |
| HTML with `bindle_data` | `400 link_malformed`, per §7.2 and conformance item 14. | §9.3 has a provider redirect land on the HTML page with data; cross-host opening is unimplemented, so the conflict is only on paper. Needs spec reconciliation. |
| Legacy inbox bearer | `406` unless the legacy parent allows the conversation-v1 invitation MIME; such bearers are usable only through the conversation invitation route. | §6.1 says a legacy inbox-bearer request returns 406. Kept narrowly so existing conversation-v1 invitations keep working; anonymous message submission with any bearer is refused. |
| Admission receipt signer | The recipient account's identity signing key (domain-separated prefix). | S16 admission-key discovery is undefined. |
| RPC errors | HTTP error framing for both pre-dispatch and method errors. | Spec asks method errors to use the existing RPC error framing. |
| Conditional issuance | Only the trusted system path (developer contact) issues conditional links; ordinary owners issue unconditional new-form links. | Allowed: whether tenants may issue conditional links is host policy (§7.1). |
| Developer link URL | Uses the developer's canonical handle in the path, because the edge binds the path handle to the account's canonical handle. | No spec impact. |
| Contact-page CSP | The contact page alone allows `connect-src 'self' https:` (plus `http://localhost:*` locally) so handle discovery can fetch other providers' public manifests without credentials. | Accepted provisional risk (review R4): a script injection on that page could exfiltrate to any HTTPS host. Alternative pending decision: a same-origin SSRF-guarded discovery endpoint, restoring `connect-src 'self'`. |
| Manifest | `features["intents.v1"] = {intents, login_endpoint}` merged into the existing manifest; `link-response.v1` is reserved in links §9.3 and not advertised. | Follows the core `features` container. |
| Browser evidence | A local Worker cannot bootstrap the protected developer identity (it needs an email or push provider), so the developer-contact and conditional opener browser checks run on the Node adapter with a loopback-only captured mailer. | Environment limitation. |

## Review findings and dispositions

### Security review

The reviewer probed the real Node adapter and an in-memory controller harness. No Critical or High finding. Confirmed absent: any anonymous delivery path, author or audience verification bypass, credential confusion between inbox, endpoint, delivery-bearer, meta and data tokens, an edge-versus-account parser differential, nonce burn by non-inspection representations, quota bypass through RPC, rotation or concurrency, Durable Object gate faults, and unbounded storage growth.

| # | Severity | Finding | Disposition |
| --- | --- | --- | --- |
| S1 | Low | The per-principal `link-audience` window was charged for the *claimed* principal before verification, so anyone could lock a chosen account out of JSON-inspection evaluation from a few IPs. | **Fixed.** The window is keyed by claimed principal plus network; the replay record's per-principal cap still applies after verification. |
| S2 | Low | Renewing the developer link created a second parent, doubling an author's daily allowance. | **Fixed.** A renewed parent inherits the quota family of the link it replaces; the per-author day counter is keyed by that family. The old link stays valid until its own expiry (at most 7 days), as intended for already shared URLs. |
| S3 | Low | Multipart and RPC framing were parsed and hashed before the credential was verified. | **Fixed.** The edge verifies the link or bearer (`verifyLinkCredential`) before reading the body. |
| S4 | Info | A delivery bearer minted before a challenge rotation remains usable for at most 300 s. | Accepted: §7.1 invalidates responses, not bearers; bearers are short-lived and still require author proofs. |
| S5 | Info | An exact replay of an accepted conditional delivery was refused once the decision expired. | **Fixed.** The receipt lookup now precedes policy evaluation. |
| S6 | Info/Low | The signed-out return entry kept the capability in `sessionStorage` until consumed. | **Fixed in the UI rework:** bounded expiry and cleared when abandoned; recorded as a deviation from "memory only" in contact-tokens URL secrecy. |
| S7 | Info | The address bar was not scrubbed when client capture rejected the link. | **Fixed in the UI rework:** any `sig`/`bindle_*` component is scrubbed. |
| S8 | Info | New-form POST credential failures returned `unauthorized`; `forbidden_tags` was 403 while links §6.2 says 400. | **Fixed.** `link_invalid` for new-form credentials; `forbidden_tags` is 400. |
| S9 | Info | `GET /api/developer-contact` had no rate limit. | **Fixed.** Per-user `developer-contact` window. |
| S10 | Info | Captured `bindle_data` could be auto-evaluated and labelled with the signed-in account. | **Fixed in the UI rework:** captured data is never auto-evaluated. |

### UI/UX red-team review

The reviewer confirmed no anonymous sending, no auto-signing or auto-posting after return, disclosure before signing, account-scoped eligibility, retry identity reuse, error mapping and Spanish coverage. Findings F1–F23 were confirmed from code and screenshots. The user's later scope change (no composer on the public page; console handoff; `web+bindle` intents; sign in or sign up with any provider) moved the composer and audience flow into the console and is part of the same rework.

| # | Severity | Finding | Disposition |
| --- | --- | --- | --- |
| U1 | High | Developer panel help text overlapped. | Fixed (scoped margins). |
| U2 | High | Unscoped dark-mode rules made suspected tags and eligibility unreadable in the light console. | Fixed (scoped to public pages, contrast checked). |
| U3 | Medium | Links accepting only app content still offered a composer after disclosure. | Fixed (state shown before any disclosure). |
| U4 | Medium | Optional system tags were not localized for senders; the editor persisted English system labels. | Fixed. |
| U5 | Medium | The intake editor dropped other-locale labels. | Fixed (merge; locale-labelled input). |
| U6 | Medium | Return target lost across email links and long sign-ups. | Fixed with the session-scoped handoff and a lost-target notice. |
| U7 | Medium | Ineligible developer panel still pushed Open/Copy with contradictory copy. | Fixed. |
| U8 | Medium | Captured data could show eligibility for an unchecked account. | Fixed (see S10). |
| U9 | Medium | Ineligible/stale states did not name the account; button labels mismatched behaviour. | Fixed. |
| U10 | Medium | Rules and organize forms required hidden tag IDs. | Fixed (labelled picker / visible IDs). |
| U11 | Low | Expiry dates without a year. | Fixed. |
| U12–U23 | Low/Info | Retry-After localization, `translate=no` scope, bidi isolation, disclosure naming `aud`'s origin, button spacing, focus and live regions, intake editor scale, rotation copy and Cancel, push-unsubscribe timeouts, `isTrusted` gating, sent-state account naming, modal backdrop. | Fixed in the UI rework except U23 (a full-page capture artefact; no backdrop defect reproduced). |

### Previews, intents and handoff review

A third independent reviewer audited the late additions (server previews, oEmbed, avatar route, `web+bindle` intents, console handoff, other-provider discovery, `bindle_intent`). No XSS, SSRF, auto-action or `bindle_intent` open redirect was found.

| # | Severity | Finding | Disposition |
| --- | --- | --- | --- |
| R1 | Medium | The console send view never showed the recipient. | **Fixed.** "To: handle@host" is shown in every handoff state. |
| R2 | Medium | The protocol handler and other providers' `bindle_intent` put the capability in a server-visible `/console` query. | **Documented.** `intent` and `bindle_intent` join `sig`/`bindle_*` in the production log-redaction gate (provisional; see DEVLOG paragraph). The fragment handoff remains the default. |
| R3 | Medium | The avatar route was an owner-controlled open redirect to any HTTPS URL. | **Fixed.** It redirects only to HTTPS image paths (`.png/.jpg/.jpeg/.webp/.gif/.avif`); anything else gets the generic card. Tested. |
| R4 | Low–Med | Contact-page `connect-src https:` widens exfiltration channels. | Accepted provisionally; alternative recorded above. |
| R5 | Low | `handle_links` with `navigate-existing` could discard in-progress work. | **Fixed.** `launch_handler` is `navigate-new`. |
| R6 | Low | Repository reads ran before the preview rate limit. | **Fixed.** Limit first. Shared unfurler IPs may still exhaust the per-network bucket (generic card) — noted. |
| R7 | Low | The primary call to action was a `web+bindle:` link most visitors cannot open. | **Fixed.** "Sign in or sign up" is primary; intent links are secondary. |
| R8 | Low | Discovery error said "below". | **Fixed.** |
| R9 | Low | Identity anchor lacked the host. | **Fixed.** `handle@host`. |
| R10 | Info | Inventory failure silently skips the chooser. | Open (current account is still shown as sender). |
| R11 | Info | Owner name/avatar reach third-party unfurlers. | Consistent with the user rule; profile-sharing copy update left to UI follow-up. |

## Verification (local only)

- `npm test` 976/976; `npm run test:worker` 49/49; `npm run test:ui-state` 155/155; `npm run build:assets` and `npm run check:worker` (dry run) pass.
- Real Chromium via `scripts/run-browser-checks.mjs` against `wrangler dev`: `tests/e2e/links-worker.test.mjs` (tag labels, new-form link, intake edit without reissue, public page with intents and no composer, signed-out sign-in → console handoff → authored send, signed-in handoff) passes. `tests/e2e/links-conditional.test.mjs` (Node adapter with loopback mailer: developer link, eligible disclosure → Continue as → send with `priority:free`, ineligible paid-required, signed-out, discovery failure without redirect) passes. Updated contact cases in `ui-adversarial` pass.
- Not attributable to this slice and left failing: `worker-flow` signup tests and `recovery-layout` (recovery setup copy changed elsewhere), `ui-adversarial` expired-session and pending-email cases, multi-account, app-connection, plans/search layout and other cases that hit shared signup rate limits in the full suite.
