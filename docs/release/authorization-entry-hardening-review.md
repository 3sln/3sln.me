# Authorization entry hardening: review record

Status: provisional, local evidence only, 2026-10-14. Sign-off: reviewer ___ / date ___ / outcome ___ (unsigned; nothing here is approval).

Scope: the server gaps that kept `FEDERATION_ENTRY_ENABLED` off, from [authorize-entry UI review](authorize-entry-ui-review.md) "Server gaps", [implementation review](authorization-entry-impl-review.md) and [federation mount review](federation-mount-review.md) M5. Files:

- `packages/federation/authorization-entries.mjs`, `packages/federation/service.mjs`
- `packages/runtime/federation-entry-http.mjs`, `packages/runtime/federation.mjs`, the entry parts of `packages/runtime/http.mjs`
- `apps/worker/{federation,index}.mjs`, `apps/node/resources.mjs`
- `apps/web/src/bl/authorize-entry{,-embed}.mjs`

One independent reviewer (OAuth and privacy-leak lens) read the diff and confirmed two findings with proofs of concept, which it then deleted. It edited no files.

## What changed

| Gap | Change |
| --- | --- |
| **S1 (high): pre-consent probe** | Each owner now has its own durable selection (`selection/<hash>/<owner>`), so one caller never sees another owner's choice. Owner steps authenticate the caller's live session and CSRF (`entryIdentity`) before they read any entry state; the unverified cookie prefix is only a routing hint. Cancel consults no owner: one transaction and one generic `access_denied`, whatever was chosen. Owner steps never change embed state: the plain page declares plain mode as it loads (`POST …/plain`), and a selection never flips it (review finding 1). Only one owner can decide an entry: a concurrent decision by another owner gets the same answer as a completed entry. The embed challenge no longer refuses on selection. |
| **End-session hook** | `entryEndSession` in `packages/runtime/http.mjs`, used by both Worker and Node. It ends only this browser's session for the entry subject, never other saved accounts or devices. With member cookies, the subject's cookie is authenticated by name. The page must name exactly that member and session context and send its live CSRF (`IdentityAction('logout')`). Revocation precedes success, and only that member's cookie (plus the default, if it pointed there) is cleared. With no member cookies, the legacy session is the one ended. No session for the subject is still `completed` (auth.md). The store's `endTarget` → hook → `finishSession` keeps the entry open if the hook refuses. `end-session` is advertised only where the adapter passes `endSession:true`, which Worker and Node now do; `FEDERATION_END_SESSION_ENABLED` is gone. |
| **Anonymous CSRF** | Every entry POST (select, decision, end-session, plain, embed challenge and verify) needs the exact Origin, `Sec-Fetch-Site: same-origin` and `X-Bindle-Entry-Token`. The token is `SHA-256(entryId, stored salt)`: it is never stored, returned only by the same-origin view, and compared in constant time. The public nonce is no longer used as a CSRF value. The page sends cancel and "stay signed in" with `credentials:'omit'`. |
| **`maxAge:0`** | `reauthenticationFresh`: a credential verified at or after the entry's creation is always fresh; older ones count only within `maxAge`. The check runs in the entry store, in `beginEntryAuthorization` and in `approve`. `authTime` is the credential sign-in or a later step-up; device-approval sessions count only from a step-up (review finding 6). |
| **`embed.origin`** | The view carries `embed.origin` for embed entries. |
| **Already approved** | The owner-authenticated select response may carry `approved`. That is only for this owner, and only when live grants to this client cover every requested fragment: same digest and epoch, all fields and methods, resources still assigned with the granted generation and scope. The page resubmits it on the same "Continue as" click; a refusal falls back to the consent review. `approve` re-validates everything. |
| **M5: sharding** | 64 shards keyed by the entry ID's first character, like the MCP stores. Budgets for the caller and for each client from that caller live on the caller's shard. Each shard holds `ceil(global/64)` of the global budget. Worker: `FederationObject` instances `bindle-federation-v1/authorization-entries/<00–63>`, each pinned to its shard by a stored marker, and IDs minted on the host's own shard; the facade calls `admit` and then `create`. The former global instance only drains. Node: one SQLite file per shard, each with its own alarm. An entry and its selections and decision hold all live on one shard, so retries resume the same decision. |

## Findings and dispositions

| # | Severity | Finding | Disposition |
| --- | --- | --- | --- |
| 1 | Medium | For embed entries in plain mode, `select` persisted `plain:true`. The view (`embed.plain`) and the document's COOP then revealed that, and when, an account was chosen. | **Fixed.** `gate` never writes. The plain page declares plain mode at boot through a page-token-bound anonymous route, before any account request, and an undeclared plain select is refused. The S1 matrix now also runs every probe on embed plain entries. This reverses impl-review F4: anyone holding the page token can force plain mode. That is an irreversible downgrade to the COOP-isolated page, with no claim. The app can already force it by using up the handshake challenges. |
| 2 | Low | A double submit could release the decision hold after the first attempt had already issued a code, so another owner could obtain a second code. | **Fixed.** Holds carry an attempt ID. Only the attempt that took the hold releases it, and only after a refusal that proves nothing was issued. A retry under an existing hold never releases. Test added. |
| 3 | Low | On the Worker every owner fault arrives typed, so "untyped keeps the hold" never applied. | **Fixed** by the same allowlist: `temporarily_unavailable`, `invalid_request` and unknown codes keep the hold. |
| 4 | Medium | `priorApproval` ignored resource generation and scope, so "already approved" could cover a reconnected or rescoped resource without review. | **Fixed.** Generation and normalized scope must equal the grant's. Test added. Requests whose `purpose` changed still count as covered (grants do not store purpose); this is recorded as residual. |
| 5 | Medium–Low | With `SESSION_COOKIE_KEY` set, a browser holding only a legacy session got `completed` while that session stayed live. An undecryptable member cookie was left in place. | **Fixed.** The legacy session is ended when no member cookies exist, and an undecryptable member cookie is cleared. An `unauthorized` logout result (session gone, or account not active, so the session is unusable) counts as ended. Tests added. |
| 6 | Low | Device-approval sessions, which any session up to 15 minutes old can mint in a chain, satisfied `maxAge:0`. | **Fixed.** Non-credential sessions count only from a step-up. Test added. |
| 7 | Info | Unused selection `session` hash; the app can use up embed challenges (downgrade only); a cancel that races an in-flight approval can give both outcomes; an app can complete its own end-session entry with no cookies; end-session is no longer separately gated; the old global entry instance only drains; Node shard alarms re-arm lazily after a restart. | **Accepted.** Cancel must not consult the hold, because that would reveal an in-progress decision. `result=completed` means "no session for this subject remains in the browser that posted", not proof about the user's browser. In-flight entries at deploy time expire (≤ 10 min). The coordinator should confirm that end-session needs no gate beyond `FEDERATION_ENTRY_ENABLED`. |

## What held (reviewer)

- **Owner steps:** owner steps authenticate before reading entry state, and each sees only its own selection. The S1 matrix matches byte for byte and in work counts. `approve` refuses non-entry routes for entry requests.
- **CSRF and the hook:**
  - The CSRF triple holds, the page token is compared in constant time, and `approved` is sent without CORS.
  - The hook requires the named member, its session context and CSRF. It revokes only that member, and does so before success.
- **Freshness:** the same function checks freshness three times, and `authAfter` comes only from the entry store.
- **Sharding:**
  - IDs carry their shard, and a host refuses foreign IDs.
  - The facade cannot skip admission.
  - Shard markers stop role and shard confusion.

## Evidence (2026-10-14, local)

- **Unit and suite runs:**
  - `npm test`: 1133/1133.
  - `npm run test:worker`: 51/51.
  - `npm run test:ui-state`: 185/185.
  - `npm run build:assets` and `npm run check:worker` (dry run) pass.
- **New tests:**
  - `tests/authorization-entries.test.mjs`: the S1 matrix of 20 probes × 4 selection states × {plain, embed-plain}, plus decision hold, double submit, `maxAge:0`, end-session through the hook, already approved (with generation and scope), sharded store and Worker facade.
  - `tests/federation-mount.test.mjs`: the real `entryEndSession` hook, including the legacy and undecryptable-cookie cases.
  - `tests/browser/authorize-entry.mjs`: page token, anonymous cancel, the plain declaration, already approved.
  - Updates in `tests/embed-bindings.test.mjs` and `tests/islands-worker.test.mjs` for the page token.
- **Browser gate** `npm run test:e2e`: all green (portal 85/85, federation 4/4, authorization entry 2/2, entry UI 5/5), on Chromium against a real local Worker, including `tests/e2e/authorization-entry-ui.test.mjs`. End-session now runs against the Worker's real hook: only the named account leaves the browser.
- **Not run:** Firefox, WebKit, mobile engines, deployed Workers.
