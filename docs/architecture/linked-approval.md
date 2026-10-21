# Linked approval: approving sign-ins from another device

Status: **provisional design, 2026-10-20.** The LA1 identity core is implemented locally behind `DEVICE_AUTHORIZATION_ENABLED` and is unrouted (§10.1). The app device grant (LA2) and the routes (LA3) remain unimplemented. §7.3 distinguishes the existing local LA1a/step-up fixes. Nothing here establishes production verification. This is a 3sln.me host design. The only Bindle interop it relies on is [device authorization](../spec/device-authorization.md) (`device-authorization.v1`, proposed). Everything about pages, wording, account choice and provider-session extension is host policy. Decisions are provisional until signed off in DEVLOG.md. Independent security review: [linked-approval-review](../release/linked-approval-review.md).

Architecture/security/product sign-off: reviewer ___ / date ___ / outcome ___.

Builds on: [device login spec](../spec/device-login.md) and its [cancellation review](../release/device-login-cancellation-review.md), [auth](../spec/auth.md), [adaptive app sign-in](adaptive-app-sign-in.md) (app sessions, §12), [multi-account sessions](multi-account-sessions.md) and [multi-account UI](multi-account-ui.md), [client ID metadata](../spec/federation-implementation.md#client-id-metadata-documents-client-id-metadatav1), and the [application engine](app-engine.md).

## 1. Direction and summary

User direction (2026-10-20): extend the QR device sign-in, which extends a login from one device to another, to other uses such as console or CLI applications signing in. It need not be a QR code; a link plus a correlation code is enough. The user opens the link in a signed-in browser (or opens it and then signs in) and approves. A derived owner session expires no later than the approving session. Accepted 2026-10-20: an app approval instead requires a fresh sign-in at approval and may grant at most 30 days absolute with a 7-day idle limit; explicit termination of the approving session still revokes its approved devices and apps.

Design in one paragraph. One **linked approval** mechanism serves two kinds of request:

- **`session` kind.** Provider-session extension: a TV or another browser gets a provider owner session. This is the existing device sign-in, generalized.
- **`app` kind.** A client without a browser redirect (CLI, console tool, TV app) gets app credentials through the Bindle device authorization grant.

Both kinds issue a short **user code** from one namespace. Both are approved on one host page, **Approve a sign-in** (`/approve`): enter the code, choose the account, confirm with a fresh passkey or password, review what is being granted and for how long, then approve or deny. A `session` credential expires no later than the approving session. An `app` credential may last up to 30 days with a 7-day idle limit, only after a fresh passkey or password sign-in in the approval flow; step-up alone does not qualify. Ordinary sign-out also revokes approved descendants, after a warning. A derived session can approve another owner session only after its own fresh passkey or password confirmation, and the user always types the code shown on the device: a QR code or link identifies a request but never supplies the code.

## 2. Decisions

| ID | Decision | Section |
| --- | --- | --- |
| LA-1 | One host record type, `LinkedApproval {kind:'session'\|'app'}`, generalizes `DeviceLogin`. One user-code namespace and one approval page serve both kinds. | §3, §11 |
| LA-2 | The `app` kind is the Bindle profile of RFC 8628 (`device-authorization.v1`). The `session` kind stays provider-local, not interop, and reuses the same endpoints internally. | §3 |
| LA-3 | User codes are 8 characters from the RFC 8628 base-20 consonant alphabet `BCDFGHJKLMNPQRSTVWXZ` (34.6 bits), shown `XXXX-XXXX`. They replace today's 32-symbol alphabet, which includes vowels and so can spell words. | §4.1 |
| LA-4 | **Codes are resolved only for a signed-in account.** A signed-out visitor can type a code; it is kept in the tab and resolved after sign-in. Failed guesses are charged to the account, to the network prefix and to a hard global budget that scales with the number of live codes. | §4.1, §4.4, §9 |
| LA-5 | **QR codes and links carry at most a request locator, never the code.** The user always types (or pastes) the code shown on the requesting device, and the server matches it. Wrong codes count against account and prefix limits. Requests are never burned by misses. | §4.2, §4.3 |
| LA-6 | **No confirm-only path in v1.** 3sln.me does not issue `verification_uri_complete`. The same-device CLI case pastes the code from the terminal. (Revised after review finding LA-R4.) | §4.3 |
| LA-7 | Approval needs a **credential authentication within 5 minutes**: a passkey or password sign-in, or a step-up within the current session (passkey preferred). Creating a session by linked approval, email link or recovery never counts. A derived session may approve `session` kind after its own step-up; those lifetimes stay bounded through the chain. `app` kind requires a fresh sign-in in the approval flow, not step-up alone. | §7.3 |
| LA-8 | Lifetime: `session` uses `E = min(S, now + sessionTtlMs, now + user choice)`; `app` uses `E = min(now + 30 d, now + user choice)` only with fresh sign-in at approval, plus a 7 d idle limit. App default: 1 h. Session default: normal session length, clamped to `S`. | §7 |
| LA-9 | Lineage: every issued session or app client session records its approving session, and the parent session entry records its children. Ordinary sign-out, explicit revocation, security resets and eviction revoke approved descendants transitively, with a warning before voluntary sign-out. Natural owner-session expiry bounds derived owner sessions but does not shorten the separately approved app lifetime; app approval lineage is retained until those families end. This is atomic for sessions; for app sessions it uses an account-local outbox, a family reservation and a refresh-time check. | §7.4 |
| LA-10 | No approval prompts are pushed to the user. After every approval, a notification goes to the account's push devices and verified email, naming the client only by verified host or device kind, and linking to the console. | §8 |
| LA-11 | The requesting screen's label becomes a fixed device-kind choice, not free text. The approval page never shows requester-supplied free text, never badges an `identity` hint, and shows no requester location, only a country-mismatch warning. | §5.1, §6.1 |
| LA-15 | **The requesting screen confirms the account.** A `session`-kind screen shows "Continue as @handle?" before the session is installed; the SDK confirms or checks the subject before using app tokens. | §5 |
| LA-16 | User codes are stored only as HMAC-SHA-256 under a server key. The display copy stays on the requesting device. | §3, §4.1 |
| LA-12 | Polling throttles and DPoP `jti` caches live in the non-durable rate limiter. Durable writes happen only on state transitions. Live requests are capped per network prefix, and unconsumed records are deleted on expiry or cancellation. | §9 |
| LA-13 | `/approve` is the canonical page. `/device` and `/device/approve` redirect to it for one release, and old fragment codes are ignored. | §12 |
| LA-14 | New operations are engine Actions/Queries on the edge identity engine and the federation engine. HTTP mounts wait for the in-progress `packages/runtime/routes/*` refactor. | §10, §14 |

## 3. Kinds and records

| | `session` kind | `app` kind |
| --- | --- | --- |
| Requester | The provider's own console on another browser (TV, shared computer, new laptop) | A third-party or first-party client without a browser redirect |
| Start | `POST /api/auth/linked/start` from the console, with Turnstile, an exact Origin and the request binding cookie (today's `/api/auth/device/start`) | `POST /oauth/device_authorization` (`device-authorization.v1`); refuses requests carrying `Origin` or `Sec-Fetch-*` |
| Result | A provider owner session installed by the requesting browser's cookie adapter after its "Continue as" confirmation | A DPoP-bound app client session (refresh family) via `grant_type=…:device_code` |
| Consent | "Full access to your account" (owner session) | Fragment consent for the client, through the shared consent kit |
| Expiry before approval | 300 s | 600 s |
| Interop | None (host policy) | [device authorization](../spec/device-authorization.md) |

Common record (identity shard, keyed by request ID, CAS-revisioned like today's `deviceRequests`):

```
{ id, kind, revision, status: pending|approved|denied|cancelled|consumed,
  userCodeMac,                             // HMAC-SHA-256(server key, code); no plaintext copy
  deviceHash, bindingHash?, dpopJkt?,      // session: binding cookie; app: dpop_jkt
  createdAt, expiresAt, interval,
  requester: { deviceKind?, network?: { prefix, country?, region?, trusted } },
  app?: { clientId, clientSnapshot, requests, identityHint?, entryId },
  locatorMisses, owner?, approval?: { sessionId, sessionHash, authAt, approvedAt, choice, expiresAt /* E */ },
  issued?: { sessionId?, sessionHash?, familyId? }, consumedAt? }
```

`network.prefix` is the requester's IPv4 address and /24, or IPv6 /64 and /48, used for limits and the country-mismatch warning, and stored only for the request's lifetime. `trusted` is true only where the runtime's client IP is authoritative: `CF-Connecting-IP` and `request.cf.country` on Workers, or a Node adapter with configured proxy trust and a geo source. When `trusted` is false, the mismatch warning is disabled, not guessed. The requesting device keeps the code's display copy itself: the TV in its existing tab secret store, the CLI in memory.

The `app` kind also creates an **authorization entry** (`delivery:'device'`, no redirect URI, no PKCE, `dpopJkt` pinned). The approval page renders the entry's consent and account selection with the existing pre-consent privacy rules. The linked-approval record holds only the entry ID.

## 4. Codes, locators and links

### 4.1 User code

The code is 8 characters from `BCDFGHJKLMNPQRSTVWXZ`, generated by rejection sampling over random bytes (bytes ≥ 240 are discarded, then `byte % 20`). It is displayed `XXXX-XXXX`. Input is uppercased, `-` and spaces are stripped, and the comparison is constant-time. A unique-reservation index (`userCodeMac → requestId`, HMAC under a dedicated `LINKED_CODE_KEY`) shares one namespace across both kinds and lives at most as long as the request.

Code space `N = 20⁸ = 2.56 × 10¹⁰`. With `L` live codes of both kinds (capped at 20,000 globally, §9), one guess hits with probability `L/N` (7.8 × 10⁻⁷ at the cap). Per-account and per-prefix limits bound a single attacker. They do not bound a botnet with many accounts: 1,000 accounts and 500 prefixes would find about 270 codes a year at the cap (review LA-R5). The bound that matters is therefore a **hard global failed-resolve budget** `G` per day, recomputed from the live count so that `G·L/N ≤ 0.01` expected discoveries per day (`G ≈ 12,800` at the cap, much higher at realistic live counts). Once `G` is spent, each further typed-code resolve needs a fresh Turnstile pass and the per-account cap halves. If solver abuse is observed, typed resolution is refused and only locator resolution, which needs the request's own QR code or link, keeps working until the budget resets.

### 4.2 Locator

The locator is the request ID (UUID). It is not secret, but it is not guessable either. It appears only in the URL fragment of `session`-kind QR codes: `https://3sln.me/approve#r=<id>`. A locator lets the page say "enter the code shown on that screen". With the locator present, lookup is `(id, code)`, where a guess succeeds with probability `1/N`, so it needs no extra limit and does not count against the global budget. Misses count against the account and prefix limits. After 5 misses in one tab the page drops the locator and continues as plain code entry. The request itself is never burned: anyone who could see the screen could otherwise cancel other people's requests (review LA-R6).

### 4.3 What each link carries

| Entry path | URL | User action |
| --- | --- | --- |
| Typed by the user | `https://3sln.me/approve` | Type or paste the code, then review. |
| `session`-kind QR code | `/approve#r=<id>` | The page says "Type the code on the screen you're signing in" and **never shows a code before it is typed**. A mismatch is reported generically as "That code doesn't match". |
| Legacy `/device#request=<id>&code=<code>` (one release) | Redirected to `/approve` | `id` becomes the locator, `code` is **discarded**, and the user types the code. |

3sln.me v1 issues no `verification_uri_complete` and has no confirm-only path. The review (LA-R4) showed that an attacker sharing the victim's network (hotel or office NAT, carrier-grade NAT, a commercial VPN exit) passes every network-match condition, and a QR sticker over a TV app's own QR code then makes confirm-only the weak point. In the same-device CLI case, the user pastes the code from the terminal into the field, which costs one paste. If confirm-only is reconsidered later, the review's minimum conditions apply: clients registered as same-device CLIs only, an exact IPv4 /32 or IPv6 /64 match, known CGNAT, VPN and hosting ASNs excluded, and eligibility re-checked at approval.

### 4.4 Lookup

`POST /api/auth/linked/resolve {code, locator?}` requires a signed-in member (the account header and session context per [multi-account sessions](multi-account-sessions.md)), an exact Origin and CSRF. It returns a review view only for `pending`, unexpired requests. Every failure (unknown, expired, decided, wrong code for the locator) returns one generic `invalid_code` response of the same shape; rate limiting returns `rate_limited` with a retry time, which reveals nothing about any request. A successful resolve does not change the request, and the requester cannot observe it (pre-consent privacy).

## 5. Requesting side

### 5.1 `session` kind (TV or another browser)

The console's "Sign in with another device" screen keeps today's automatic Turnstile start, generation fences, spinner and cancellation. The changes:

- **Device kind instead of a label.** A segmented choice: "TV or shared screen" (default), "Computer", "Phone or tablet". The API accepts only these enum values (LA-11).
- **Display.** Large text: "On a signed-in phone or computer, go to **3sln.me/approve** and enter **BCDF-GHJK**", with the code in `translate="no"`, monospace, letter-spaced and readable at 3 m. A QR code below it encodes `https://3sln.me/approve#r=<id>`, captioned "Or scan, then type the code above". A visible countdown, plus "Get a new code" and "Cancel".
- **Account confirmation (LA-15).** When the request is approved, the poll returns `{status:'confirm', account:{handle}, expiresAt}` without consuming it. The screen asks "Continue as **@handle** until 21:40?" with "Continue" and "Not me". Continue posts `accept` (binding cookie and device secret), which runs today's consume-and-issue path. "Not me" cancels. This stops a viewer of a shared screen who types the code first from silently signing the room's TV into their own account (review LA-R7). An unanswered confirmation expires with the request.
- The binding cookie is mandatory for this kind (today's routes always set it; the design makes it required).

### 5.2 `app` kind (CLI and other clients)

There is no Turnstile, since there is no browser. Admission is by the limits in §9, without proof-of-work. Only operator-registered, reviewed clients may use the device grant; unreviewed metadata-document clients are refused before creating a linked approval. The client receives `user_code`, `verification_uri` (`https://3sln.me/approve`), `expires_in: 600` and `interval: 5`, and no `verification_uri_complete` (LA-6). The SDK helper (§14, LA6) prints:

```
To sign in, open https://3sln.me/approve and enter BCDF-GHJK
(or press Enter to open your browser)
```

On that keypress the helper opens `https://3sln.me/approve` (without the code) in the system browser, then polls with DPoP and a non-exportable key where the platform offers one. When it sent an `identity` hint, it aborts on a subject mismatch. Without a hint, it asks "Signed in as @alice@3sln.me until 21:40. Continue? [Y/n]" before storing anything, and on "n" it revokes the tokens (RFC 7009). Examples in docs use `acme.example` clients and `provider.example` hosts until publication authority is agreed.

## 6. Approval page: Approve a sign-in

### 6.1 Flow

```
code ──► [signed out?] ──► sign in inline (pending kept) ──┐
  │                                                         ▼
  └────────────────────────────────────────────► account chooser (members)
                                                             │
                                          fresh credential? ─┴─► step-up (passkey/password)
                                                             ▼
                                         review: who is asking, what, how long
                                                             │
                                                approve ◄────┴────► deny
                                                   │
                                     done: "Return to your device"
```

1. **Code.** A single field labelled "Code shown on the device", with `autocomplete="off"`, `autocapitalize="characters"`, `spellcheck="false"` and `inputmode="text"`. It accepts lowercase, spaces and the hyphen, and shows a live `XXXX-XXXX` echo. Errors are announced through an `aria-live="polite"` region. Above the field: "Only enter a code from a device that is in front of you right now. Never enter a code someone sent you."
2. **Sign-in when needed** (§6.2).
3. **Account.** Lists the browser's signed-in members, with handles bidi-isolated, plus "Use another account". There is no default selection when several members exist. If an `app` request carried an `identity` hint that matches a member, that member is preselected without any badge, since the hint is attacker-controlled (review LA-R12). A hint that matches no member is ignored.
4. **Fresh credential** (LA-7). For `app` kind, require a fresh passkey or password sign-in in this approval flow and bind approval to that new session; an existing session's recent authentication or step-up alone is insufficient. For `session` kind, if the chosen member's `authAt` (§7.3) is older than 5 minutes, which is always the case for sessions created by linked approval, email link or recovery until they step up, the page runs the existing step-up inline: passkey first, password only when the account has no passkey.
5. **Review.**
   - *Who is asking.* For the `session` kind: "A **TV or shared screen** wants to sign in to your account" (device kind, chosen by that screen). For the `app` kind: the client's verified host (`acme.example`) as the primary label. A registered client's operator-reviewed name may appear beside it. Unreviewed metadata-document clients are ineligible for the device grant and never reach this review. No logos.
   - *When*: "Request started 1 minute ago". No location is shown (review LA-R15: it leaks to code guessers and a VPN exit near the victim makes it falsely reassuring). When `network.trusted` and the approving browser's country differs from the requester's, an inline warning reads: "This request came from a different country than this browser. If you aren't signing in a device you can see right now, deny it."
   - *What.* For the `session` kind: "**Full access** to @alice: messages, files, settings and devices. It can't add passkeys, change recovery or approve other sign-ins without confirming your passkey or password." For the `app` kind: the consent kit's fragment summary (required and optional fragments, fields, methods), with optional fragments toggleable. The client can request only fragments on its device-grant allowlist (operator registration; no device grant for unreviewed metadata-document clients). Fragments the operator marks sensitive need a second explicit tick.
   - *How long.* For `session` kind, a radio group offers **1 hour**, **8 hours**, and **Until your sign-in here ends (21:40)**; options at or beyond that end collapse into the last one. The normal session length, clamped to the approving session's expiry, is preselected. When it ends within an hour, the page offers a fresh sign-in while keeping the pending approval. For `app` kind, after the required fresh sign-in, offer **1 hour** (default), **8 hours**, and **30 days**, with a 7-day idle limit and a disclosure that signing out the approving session also ends this app's access.
6. **Decide.** "Approve" and "Deny" carry equal visual weight, and Approve is armed after a 1 s delay (the existing delay-to-arm). Approve posts `{requestId, code, owner, sessionContext, choice, consent…}` with CSRF, where `code` is the value the user typed and the server re-matches it.
7. **Done.** "Approved. Return to your device. It will finish signing in within a few seconds." along with the expiry time and "You can revoke this anytime in **Devices** / **Connected apps**". On deny: "Denied. That device can't use this code."

### 6.2 Same device, and signing in first

The pending approval must survive sign-in, account addition, signup and the step-up.

- **Inline first.** Sign-in, add-account and step-up run within `/approve` with the existing adaptive sign-in components, so there is no navigation.
- **Tab-scoped draft.** Before any step that navigates (signup wizard, recovery, email-link sign-in), the page stores `{v:1, locator?, code?, savedAt}` under one `sessionStorage` key, which never reaches the server or the URL. On return to `/approve`, the draft is read, cleared and resubmitted to `resolve`. Drafts older than 10 minutes are discarded. A request that expired meanwhile shows "This code expired. Get a new one on your device."
- **Signup continuation.** The existing fixed-path device-signup continuation targets `/approve` and carries no code in the server-visible query.
- **Already on the device.** On a phone or computer that is itself the requester, the console's own "Sign in with another device" screen shows no QR code to scan. `/approve` warns "You're approving from the same browser that asked to sign in" when the requester's binding cookie is present, since this is usually a confused user.

### 6.3 Multi-account rules

- Each request carries the tab's `X-Bindle-Account` and `X-Bindle-Session-Context`, and approval re-verifies that the chosen owner and session match before reading request state, as the authorization entry does.
- The record binds `owner` and `approval.sessionId` atomically. A second approval from another tab or account gets `conflict` ("This request was already decided").
- Switching account after resolve resets review state and repeats the applicable fresh sign-in or step-up requirement for the new member.
- An `identity` hint never selects or badges anything beyond preselection, and a mismatch is never fatal.

### 6.4 Localization, accessibility and mobile

- Strings live in a new `packages/i18n/approve-catalogue.mjs` (en/es at launch) with bab interpolation. The code, handles, hosts and client names are interpolated as isolated runs (`<bdi>`, `translate="no"`). Times use `Intl.DateTimeFormat` in the user's locale, and durations are localized ("1 hora").
- The page is one column at ≥320 px with 16 px gutters, uses 44 px targets, and stays visible above the on-screen keyboard (`scrollIntoView` on focus). It works without a hover state.
- Headings mark each step, focus moves to the step heading on transition, and the radio group and toggles are native controls. Warnings use `role="alert"` only when they appear after an action, and are otherwise static text. Forced-colors and reduced-motion are respected, and the countdown is text that is not announced every second.
- The page carries no third-party scripts beyond Turnstile on the global-budget challenge. It sends `Referrer-Policy: no-referrer`, `COOP: same-origin` and frame-busting via CSP `frame-ancestors 'none'`.

## 7. Lifetimes

### 7.1 Formula

Accepted 2026-10-20: for `session`, `E = min(S, t₀ + sessionTtlMs, t₀ + U)`; for `app`, `E = min(t₀ + 30 d, t₀ + U)`, only after fresh sign-in in this approval flow. `S` is the approving session's `expiresAt`, `t₀` the approval time and `U` the user's duration choice (§6.1(5)). `E` is fixed at approval and stored on the request. App authority is not capped by `S`, but remains linked for explicit sign-out and revocation. Retaining app approval lineage after natural owner-session expiry (§7.4) is a provisional implementation consequence of allowing this longer app lifetime; that storage design still needs review.

| Kind | `cap` | Idle | Notes |
| --- | --- | --- | --- |
| `session` | `sessionTtlMs` (24 h) | None today (owner sessions have no idle limit), so effectively `E` | `expiresAt = E`; the local LA1a code already clamps device-session issuance to its parent. |
| `app` | 30 d; fresh sign-in at approval required | 7 d, bounded by `E` | Family `expiresAt = E`, initially `idleExpiresAt = min(t₀ + 7 d, E)`; successful use advances idle expiry to at most `min(now + 7 d, E)`. Access tokens ≤ 5 min and never past either family expiry. |

The default is 1 h for `app` approvals and the normal owner-session length for `session` approvals, clamped to `S`. Fresh sign-in for an app creates the approving session and records its lineage; it does not make an existing step-up qualify for the 30-day profile. These are accepted design decisions, not claims that app device authorization is implemented.

### 7.2 Issued `session` kind

`identity.session(account, {label: deviceKind, source: 'linked-approval', parentSessionId, expiresAt: E})`. `session()` gains an `expiresAt` override that is clamped to `≤ now + sessionTtlMs`. The issued session starts without `stepUpAt`; it gains one only through its own credential step-up. The poll's prepared-save, single-consume and cancellation fence from the [cancellation review](../release/device-login-cancellation-review.md) are kept unchanged.

### 7.3 Fresh credential for approval, and the `recent()` gap

`session` approval requires `authAt(session) ≥ now − 5 min`, where `authAt` is `max(createdAt if source==='credential', stepUpAt)`. Federation’s `sessionAuthTime` in `packages/runtime/federation.mjs` reports credential sign-in or explicit step-up; the signup exception below applies to owner freshness. Only passkey and password sign-ins create `source:'credential'` sessions. Email-link sign-ins get `source:'email'`, linked approvals `'linked-approval'` (legacy `'device-approval'`), and recovery and activation paths are audited and labelled the same way (review LA-R3). A derived session that steps up is allowed to approve `session` kind: its expiry stays at most its parent's, so every owner-session `E` in the chain stays at most the original credential session's expiry, and the cascade in §7.4 is transitive (review LA-R10). `app` approval instead requires a fresh credential sign-in in the approval flow; the new credential session becomes its parent.

**Baseline gaps (fixed locally by LA1a; retained as rationale).** `IdentityService.recent()` and the inline check in `emailStart` use `session.createdAt` regardless of `source`, and `DeviceLogin.poll` issues a full 24 h session whatever the approving session has left. A session created by device approval therefore passes `recent()` for its first 15 minutes. In that window it can approve another device, which gets a fresh 24 h, and the chain can repeat without limit. It can also enroll a passkey, link an attacker's email and enable email login (a lasting takeover), remove credentials, or revoke the owner's other sessions. These were review finding **LA-R1** (high). The local LA1a fixes switch freshness checks to credential evidence and clamp issuance to the parent; the generalized flow and app lifetime profile remain future work.

Local activation exception: signup records `pendingCredentialAt` only after passkey registration verification or setting and verifying the password hash in that setup flow. Rotating setup authority clears it; credential-authenticated setup resumption records new evidence. Activation carries this timestamp as `activationCredentialAt`, which `authAt` includes only for `source:'activation'` and only when it is a valid, non-future timestamp. The normal 15-minute `recent()` window starts at the credential ceremony, not activation. Existing activations without evidence stay non-fresh. Recovery stays non-fresh even after replacement credentials; device approval and email-link login remain non-fresh until their own step-up. Activation does not populate `stepUpAt` or grant privileged-console access. Owner confirmation uses `/api/auth/step-up/begin` and `/api/auth/step-up` with the current session's Origin/CSRF checks; the console resumes only the rejected request, once, after verification, bound to the same owner/session incarnation. This describes implemented local behavior; production gates and unsigned review status remain unchanged.

### 7.4 Lineage and cascade

- **Sessions.** The derived session records `parentSessionId`. Sessions live in the account record, so every path that removes a session (`revokeSession`, `revokeOtherSessions`, `logout`, credential removal, recovery, lifecycle suspension, **and eviction by the 10-session limit in `session()`**) also removes its transitive descendants in the **same CAS**. Eviction prefers sessions with no live descendants. `revokeOtherSessions` called from a derived session leaves the caller's own ancestors alone; they are listed separately, and revoking one explicitly signs the caller out too, with a warning (review LA-R9d). Device lists show "Approved from *Pixel 8* · ends 21:40".
- **App client sessions.** The family records `approval: {owner, sessionId}`. The parent session entry in the account record carries `derivedFamilies: [familyId]`. At the token endpoint the order is: (1) an account CAS checks the approving session is live and appends the reserved family ID to its `derivedFamilies`; (2) the family is written and activated in the federation store; (3) `sessionLive` is re-checked, and the family is revoked before responding if the session ended meanwhile. On explicit session termination (including ordinary sign-out, eviction, recovery's wholesale reset and lifecycle suspension), the same account CAS moves the removed sessions' `derivedFamilies` into an account-local **revocation outbox**. A drain revokes those families, retrying with backoff; revoking a reserved but never activated family ID is a harmless no-op. Approval lineage MUST survive natural owner-session expiry until the last linked family ends. As a backstop, every refresh checks that this approval lineage has not been revoked and fails closed with `invalid_grant`; `identity.sessionLive` alone is insufficient after natural expiry. Explicit sign-out, revocation, eviction, recovery and lifecycle suspension mark that lineage revoked and enqueue its families in the same account CAS. RPC is refused as soon as the family revocation commits. Until the outbox drains, a revoked family's access token can live at most 5 minutes, and it cannot refresh (review LA-R9b, c).
- **Sign-out disclosure.** Before ordinary sign-out or "Sign out of all accounts" ends a session with live descendants, warn: "This also signs out the devices and apps you approved from here." Ordinary sign-out then ends those approved sessions; this cascade is accepted (2026-10-20).

## 8. Revocation and notification

- **Devices** (existing list): derived sessions are tagged "Approved from …", with an expiry and a Revoke action. "Sign out other devices" includes them.
- **Connected apps:** each app's client sessions list "Signed in with a code · started from <approx location> · ends 21:40 · Revoke". "Sign out of all apps" (adaptive sign-in Q2) includes them.
- **After-approval notice.** On approval the service records an audit event and sends a localized push to all of the account's push devices, plus email from the `security` sender role when a verified email exists. The notice reads "You approved a sign-in for **acme.example** (or **a TV or shared screen**) at 20:41. It ends at 21:40. Not you? Review devices." It names an app only by verified host, never by `client_name`, so attacker text never appears in a security email (review LA-R12). It links to the console, never to a one-click revoke URL. Mail and push delivery are the existing gated adapters. Their delivery is not claimed by this design.
- **No pre-approval prompts** (LA-10). A pending request never notifies anyone.

## 9. Limits and budgets

| Item | Limit (provisional) |
| --- | --- |
| `session` start | Turnstile + existing `device` guard; counts toward the global live cap and the per-prefix live cap |
| `app` start | Exact `application/x-www-form-urlencoded`, no `Origin`/`Sec-Fetch-*`. Rates: 10 per IPv4 address or IPv6 /64 per 10 min, 50 per /24 or /48, 300 per client per 10 min. Live caps: ≤ 3 per IPv4 address or IPv6 /64, ≤ 1,000 per client, ≤ 20,000 globally across both kinds. Under pressure, prefixes with no live request are admitted first and per-ASN caps apply. Beyond that: `temporarily_unavailable` + `Retry-After`. No proof-of-work for starts (accepted 2026-10-20). |
| Resolve failures | 10 per account per 15 min with a 15 min cool-down (≤ 20/h), 30 per account per day; 20 per /24 or /64 per 15 min, 100 per day; global daily budget `G` with `G·L/N ≤ 0.01` (§4.1); repeated offenders flagged for review |
| Locator resolves | Count against account and prefix limits, not against `G`; no burn |
| Poll | Interval enforced per device code in the rate limiter (`slow_down` +5 s, max 60 s); 120 per /64 or IPv4 address per min; a global poll ceiling with `slow_down`, then `temporarily_unavailable`, under load. Order: format check → prefix limit → DPoP signature and nonce → request read. `jti` cache in the limiter. |
| Writes | Only on transitions (approve, deny, cancel, confirm, consume). Today's per-poll `nextPollAt` CAS write is removed. |
| Retention | Unconsumed records and their code-index entries are deleted at expiry or cancellation (the app kind's authorization entry with them). Consumed session records keep `issued` links until `E` for cancellation, then are deleted. Consumed app requests expire at their approval deadline; app lineage lives on the account until `E`. |

## 10. Engine operations and storage

The operations follow [app-engine](app-engine.md) conventions (`{actor,id,input}`, one change event per mutation, declared policy).

| Operation | Engine | Actor |
| --- | --- | --- |
| `linkedStart` (session) | Edge identity | anonymous + Turnstile + binding |
| `deviceAuthorize` (app) | Federation (request tier) → identity repository | anonymous client |
| `linkedResolve` (Query) | Edge identity | owner session |
| `linkedApprove`, `linkedDeny` | Edge identity (session); identity + federation entry approval (app) | owner session, fresh credential |
| `linkedPoll` (session), `deviceToken` (app) | Edge identity; federation token endpoint | binding / DPoP key |
| `linkedAccept` (session, after "Continue as") | Edge identity | binding cookie + device secret |
| `linkedCancel` | Edge identity | binding / DPoP key |
| `lineageRevoke` (outbox drain) | Federation | system |

Repository: today's `deviceRequests` adapter (`create`, `get`, `findByUserCode`, `compareAndSwap`) is renamed `linkedApprovals`, and the stored shape gains `kind`. Worker and Node adapters keep their files. The code index stores `userCodeHash`, not the plaintext code.

### 10.1 LA1 contract (implemented locally, 2026-10-20; provisional until LA3 mounts it)

Status: implemented and engine-tested in `packages/identity/linked-approval.mjs`, with service wrappers in `service.mjs` and engine classes in `packages/identity/index.mjs`. Nothing is routed. Every new operation answers `not_found` unless the identity config has `deviceAuthorizationEnabled: true`, which the Worker and Node adapters set from `DEVICE_AUTHORIZATION_ENABLED` (default `false`). The legacy `/api/auth/device/*` aliases keep working with the flag off. This is local behavior only; there is no production verification and no reviewer sign-off. LA4 is building its page mock-first against this contract. Changes to it are recorded here and in DEVLOG.md.

**Engine classes.**
- `LinkedApprovalAction(method, input, context)` dispatches the browser operations. The result arrives on `dispatchFeed` `result`, as with `IdentityAction`.
- `LinkedResolveQuery(input, context)` is the browser resolve.
- `LinkedSystemAction`, `LinkedLineageQuery` and `LinkedOutboxQuery` are for the federation engine only. They MUST NOT be routed.

`context` uses the usual identity shape: `origin`, `remoteIP`, `sessionToken`, `csrfToken`, `expectedOwner`, `sessionContext` and `deviceBinding`. It may also carry `country` (ISO 3166 alpha-2) and `networkTrusted: true`. Set those two only where the runtime's client IP and geo source are authoritative. Without them the country-mismatch warning is off.

**Browser operations (LA3 routes, LA4 page, LA5 screen).**

| Operation | Actor and input | Result |
| --- | --- | --- |
| `linkedStart` | anonymous with Turnstile (the `device` guard), exact Origin and a mandatory binding cookie (`deviceBinding` ≥ 32 chars). `{deviceKind:'tv'\|'computer'\|'phone', turnstileToken}` | `{kind:'session', requestId, deviceCode, userCode:'XXXX-XXXX', verificationUri:'<origin>/approve', locatorUri:'<origin>/approve#r=<requestId>', expiresAt, expiresIn:300, interval:5}` |
| `LinkedResolveQuery` | signed-in member, CSRF. `{code, locator?, turnstileToken?}` (`locator` is the request ID from `#r=`) | Review view: `{requestId, kind, createdAt, expiresAt, account:{id,handle}, requester:{deviceKind\|null}, app?:{clientId, host, reviewedName\|null, requests, preselect}, idleLimitMs? (app), warnings:{countryMismatch, sameBrowser}, freshness:{required:'step-up'\|'sign-in', satisfied}, durations:[{choice, expiresAt, idleExpiresAt?}], defaultChoice:'session'\|'1h'}` |
| `linkedApprove` | signed-in member, CSRF, fresh credential (below). `{requestId, code, approved:true, choice?, accountHandle?, consent? (app; JSON object ≤ 4 KiB)}`. `accountHandle` is optional and must match when sent; account binding otherwise rests on the tab's `expectedOwner`/`sessionContext`, which LA4 MUST send | `{approved:true, requestId, kind, expiresAt, idleExpiresAt? (app)}` |
| `linkedDeny` | signed-in member, CSRF. `{requestId, code}` | `{denied:true}` |
| `linkedPoll` | binding cookie, exact Origin. `{deviceCode}` | `{status:'authorization_pending'\|'slow_down', interval}`, `{status:'confirm', account:{handle}, expiresAt}`, `{status:'access_denied'}` or `{status:'expired_token'}`. It never consumes or writes. |
| `linkedAccept` | binding cookie (after "Continue as"). `{deviceCode}` | `{status:'authorized', account, sessionToken, csrfToken, expiresAt, sessionContext}` (installed like any sign-in), or a poll status |
| `linkedCancel` | binding cookie. `{deviceCode}` | `{cancelled:true}`, `{cancelled:false, reason:'denied'\|'session_not_linked'}` |

**Choices.**
- `session`: `'1h'`, `'8h'` or `'session'` (the default). Options that would reach `S` collapse into `session`.
- `app`: `'1h'` (the default), `'8h'` or `'30d'`.

`E` is computed by `linkedLifetime` (§7.1). Apps also get `idleExpiresAt = min(t₀ + 7 d, E)`.

**Freshness.**
- `session` kind: `authAt` within 5 minutes (credential sign-in, verified activation ceremony or step-up). Otherwise the call fails with `reauthentication_required`; run the step-up and retry.
- `app` kind: the approving session must have `source:'credential'`, be created after the request and be less than 5 minutes old. Otherwise the call fails with `fresh_sign_in_required`; run a fresh passkey or password sign-in in the flow and approve from that session. Step-up and derived sessions never qualify.

**Errors (`IdentityFault.code`).**
- `invalid_code`: one generic shape for unknown, expired, decided or mismatched codes, from resolve, approve and deny.
- `rate_limited`, with `retryAfter` in seconds.
- `challenge_required`: the global budget is spent, so retry with a Turnstile token.
- `typed_resolution_unavailable`: the operator refuses typed codes; locators still work.
- `conflict`: already decided.
- `confirmation_required`, `invalid_choice`, `invalid_consent`, `binding_required`, `invalid_device_kind`, `temporarily_unavailable`, `device_unavailable` (no code key configured), and `not_found` (flag off).
- Multi-account context errors (`account_context_conflict`, `session_context_conflict`) come from `authorized()`.

**System operations (LA2 federation engine; never routed).**

| Operation | Input | Result |
| --- | --- | --- |
| `linkedStartApp` | `{reviewed:true, clientId, host, reviewedName?, requests (≤ 8, ≤ 8 KiB), identityHint?, entryId?, dpopJkt}` plus the requester's `context` (`remoteIP`, `country`, `networkTrusted`). LA2 does client lookup, browser refusal, media type and per-client limits first. LA1 refuses `reviewed !== true` with `unauthorized_client` (Q3). | `{kind:'app', requestId, deviceCode, userCode:'XXXX-XXXX', verificationUri, expiresAt, expiresIn:600, interval:5}`, with no complete URI |
| `linkedRedeem` | `{deviceCode, clientId, dpopJkt}`, after LA2 verifies the DPoP proof and passes its thumbprint | `{status:'authorization_pending'\|'slow_down', interval}`, `access_denied`, `expired_token`, `invalid_grant` (unknown, malformed, wrong client or already redeemed), or `invalid_dpop_proof`. None of these change state. Only these statuses are returned, never other faults. On success: `{status:'approved', owner, clientId, host, requests, entryId?, consent?, familyId, lineageId, approvedAt, expiresAt:E, idleExpiresAt, idleMs}`. The device code is consumed at most once (request CAS), then the lineage is reserved in an account CAS while the approving session is live. If the session ended, the result is `access_denied` and the request stays closed. A full lineage table (100 live entries) answers `access_denied` before consuming. |
| `LinkedLineageQuery` | `{owner, lineageId, familyId}` | `true` only while the lineage is live. LA2 MUST call it after writing the family and on every refresh, and fail closed (`invalid_grant`, revoke the family) on `false`. It returns `false`, never throws, when the flag is off. |
| `LinkedOutboxQuery` / `linkedOutboxAck` | `{owner}` / `{owner, familyIds}` | Pending `[{familyId, lineageId, enqueuedAt}]` / `{acknowledged:n}`. The drain revokes each family, then acknowledges it. Not flag-gated. |
| `linkedLineageRevoke` | `{owner, lineageId}` | `{revoked}`. Explicit app revocation; the families enter the outbox. |
| `linkedCancelApp` | `{deviceCode, clientId, dpopJkt}` | `{cancelled:true}`. After redemption it revokes the lineage. |

**Storage and limits.**
- Repository: `linkedApprovals`, the renamed `deviceRequests` (both names are accepted). Records carry `version:2` and `kind`. `userCodeHash` holds `HMAC-SHA-256(K, 'user-code' ∥ code)`, where `K` is derived by HMAC from `LINKED_CODE_KEY`, falling back to `KEY_ENCRYPTION_KEY`. A missing key fails closed with `device_unavailable`. Only `linkedEphemeralKey: true` (tests) allows a per-instance key. The federation `IdentityService` in `packages/runtime/federation.mjs` passes none of the linked resources, so LA2 MUST call the main identity resources (repository, key, durable limits, flag).
- Polls and resolves write nothing. Writes happen only on start, decide, cancel and consume.
- Record `expiresAt` is set to the approval deadline for unconsumed requests, and to `E` for consumed `session` requests so cancellation can still revoke. The storage adapters index request and code-lookup expiry transactionally. Their identity alarms physically delete at most 64 due entries per sweep and schedule a continuation for any remaining batch. A stale index entry cannot delete a replacement code claim or a request whose cancellation fence was extended. Node restores the device store's persisted alarm on startup. The requester network is removed on every decision. Local regression evidence: `tests/linked-approval-cleanup.test.mjs` and `tests/worker/linked-approval.test.mjs` (integrator follow-up to LA1-S2, 2026-10-20; no independent sign-off).
- `linkedLimits` is a durable window port, `consume(key, {windowMs, limit})`, on the abuse windows under `linked-v1:`. `linkedPollLimits` is the non-durable per-isolate poll limiter.
- Budgets:
  - account: 10 per 30 min and 30 per day, charged per attempt before evaluation (resolve, approve, deny);
  - network: 20 per 15 min and 100 per day per /24 or /64, plus 200 per day per IPv6 /48. Typed codes pay before evaluation. Locator attempts (resolve with `locator`, approve, deny; each guess 1/N) pay only on a miss, so other people's guessing on a shared NAT cannot block QR/locator approvals. An unknown client address is keyed per account, never as one shared bucket;
  - global: `G = ⌊0.01·N/L⌋` per day, typed codes only;
  - after `G`: Turnstile on every typed attempt and 5 per 30 min per account.
- `L` comes from creation-slot counters: 10-minute slots, two slots summed, each slot spread over 8 shard counters so no single window is hot. The production abuse window has no read operation, so the adapters currently assume `L` = the 20,000 cap (`G` = 12,800), which is the most conservative value. A counting read is an integrator follow-up.
- Start admission: 10 per IPv4 address or /64 and 50 per /24 or /48 per 10 min (skipped for an unknown address), and a global live cap of 10,000 creations per 10-minute slot (≤ 20,000 live). Legacy QR, new session and app starts share the live cap, since `L` must count all of them (review LA1-S5, residual).

**Lineage.**
- Account fields:
  - `linkedLineage: [{id, sessions:[approving session, …ancestors], sessionExpiresAt, families, clientId, host, createdAt, expiresAt:E}]`;
  - `lineageOutbox`;
  - `derivedFamilies` on the approving session entry.
- `pruneSessions` treats removal of a still-live session (or a live descendant) as an explicit termination, whatever the caller: revoke, revoke-others, sign-out, passkey removal, cancellation and eviction. A session that had already expired ends naturally, whether or not expiry pruning ran first. It ends the lineage through any removed session or descendant and queues its families, in the same account CAS. Recovery ends all lineage.
- Natural expiry keeps lineage until `E`. `lineageLive` also fails while the approving session should still be alive but is missing, so any path that bypassed the cascade fails closed.
- The 10-session eviction prefers sessions with no derived sessions or apps and never evicts the new session's own ancestry.
- `owner()` adds `signOutImpact:{sessions, apps}` for the sign-out warning, and `approvedFrom` (the parent session ID) on derived device rows.

**Notices.**
- `approvalNotices.approved(notice)` is an injected port. It is called after each approval with `{type:'linked-approval', owner, kind, subject:{host}\|{deviceKind}, approvedAt, expiresAt, consoleUrl}`.
- It never carries client or requester text. Failures are swallowed.
- LA7 supplies the templates and the gated push/mail delivery. No adapter is wired yet, so nothing is delivered.

**Reconciliation items.**
- **Locally implemented (review LA1-S1, Medium; integrator, 2026-10-20; no independent sign-off).** Suspension calls `revokeAllLineage` in its identity CAS; tombstoning does the same and retains `lineageOutbox` on the deleted identity until drained. Families remain revoked after reactivation, including approvals whose parent sessions expired naturally. Regression evidence: `tests/boot-admin.test.mjs` (Node and Worker-style repositories) and `tests/linked-approval.test.mjs` (actual app approval and lifecycle tombstone). LA2 still owns family issuance and outbox draining.
- The legacy aliases still consume on poll, without "Continue as", until LA5 ships the confirmation screen.
- Session-kind starts are under the existing `device` guard plus the start limits above. Per-client and per-ASN caps for app starts belong to LA2.

## 11. Reusing device-login code

`packages/identity/device-login.mjs` becomes `linked-approval.mjs`. The following are kept as they are:

- the CAS consume, prepared-account save and post-save cancellation compensation (`poll`, `cancel`, `revokeIssued`);
- binding-cookie and secret checks (`secret`);
- the exact-hash cleanup.

These change:

- user-code generation (base-20, rejection sampling), the HMAC code index, and no plaintext code on the record;
- `approve` checks `authAt` instead of `recent()` for `session` kind and requires a fresh sign-in in the approval flow for `app` kind; it takes `choice`, binds `approval.sessionId` and stores `E`;
- `poll` passes `expiresAt: E` and `parentSessionId` to `session()`, and moves interval enforcement to the rate limiter;
- `lookup` requires an owner session, charges misses to account, prefix and global budgets, and uses the generic error; the unauthenticated `inspect` is removed;
- `poll` returns `confirm` for approved `session`-kind requests, and a new `accept` performs the consume;
- an `app` branch that, on approval, drives the authorization entry's owner approval and records the entry's internal code; the federation token endpoint consumes it.

`DeviceLogin` stays as a thin alias for one release so existing tests and routes keep working (§12). The alias applies the new rules: there is **no** unauthenticated inspect alias, because it would bypass LA-4 and leak `app`-kind client details across the shared namespace (review LA-R11).

## 12. Migration from the current QR flow

1. **Back end (LA1).** Fix `recent()`/`emailStart` and the email-session source first, as a standalone hunk. Then add `linked-approval.mjs` and alias `/api/auth/device/{start,approve,deny,poll,cancel}` to it; `/api/auth/device/inspect` is removed, and approve requires the typed code. Tests that relied on anonymous inspect are updated. The new alphabet applies to new requests; old 32-symbol codes live at most 5 minutes after deploy.
2. **Approval page (LA4).** Ship `/approve`. `/device` and `/device/approve` get a 302 to `/approve`, and browsers carry the fragment across the redirect. When the page reads a legacy `#request=<id>&code=<code>` fragment, it keeps `id` as the locator, **discards `code`**, and asks the user to type it. The old review screen is removed: it displayed the code from the URL beside the "type the code" field, and `ApproveDeviceLogin` sent the URL copy of the code to the server rather than the typed value, so the server never saw what the user typed (review LA-R2).
3. **Requesting screen (LA5).** It shows the `/approve` instruction, the device-kind choice, a locator-only QR code and the "Continue as" confirmation. The `/api/auth/device/qr` validator accepts only `/approve#r=<uuid>`.
4. **App kind (LA2/LA3).** Behind `DEVICE_AUTHORIZATION_ENABLED=false` (default) and `FEDERATION_ENTRY_ENABLED`. The manifest declares `device-authorization.v1` only when the flag is on and routes are mounted (lesson F8).
5. **Removal.** After one release, remove the `/device*` redirects, the `/api/auth/device/*` aliases and `DeviceLogin`.

Records in flight at deploy time are short-lived (≤ 5 min) and not migrated. Consumed legacy records keep their `cancel` semantics, including `session_not_linked`.

## 13. Threat summary

| Threat | Primary controls | Residual |
| --- | --- | --- |
| Remote device-code phishing | Fresh credential (fresh sign-in for apps), explicit account, warning copy, verified host only, country-mismatch warning, typed or pasted code, per-client fragment allowlists, 1 h app default, after-approval notice, revocation, browser refusal at the device endpoint | A user who follows an attacker's instructions still approves. This cannot be fully removed (spec §10.1). On a lookalike site a password step-up can be phished, which is credential theft beyond one approval; passkey step-up is preferred (review LA-R16). |
| QR swap (sticker) | QR carries the locator only; the code is always typed from the device display; no confirm-only path | An attacker who controls the device's own display controls the device. |
| Code brute force | 34.6-bit codes, HMAC index, resolve only when signed in, per-account and per-prefix limits, hard global budget scaled to live codes, generic errors | Solver farms during the budget's Turnstile phase until refusal; a hit gives login-CSRF, which LA-15 confirmation catches. |
| Session-lifetime escalation and laundering | `E ≤ S` for derived owner sessions, own step-up for session approval, fresh sign-in for apps, 30 d absolute / 7 d idle app limits, `recent()` fix, lineage cascade | A stolen credential (not just a cookie) can always sign in directly. |
| Cross-account approval and login-CSRF onto a device | Explicit chooser, owner + session-context binding, single CAS, "Continue as" on the requesting screen, SDK subject check | User inattention. |
| Replay | Hashed, single-use device code with no success replay; DPoP binding (app); binding cookie (session) | A lost success response requires a restart. |
| Polling and creation DoS | Rate-limiter interval, prefix and global limits, per-prefix live caps with fair admission, no per-poll writes, cheap rejection first, prompt deletion | A large residential-proxy pool can still exhaust per-client capacity; operators can raise caps or block ASNs. |

## 14. Implementation slices and file ownership

`packages/runtime/routes/*` is being refactored now (phase 0 per-domain split). **No slice edits route files until the refactor owner releases them**. Slices LA1, LA2, LA4 and LA6 work against engine operations and test harnesses first, and LA3 mounts afterwards.

| Slice | Owns (write) | Depends on |
| --- | --- | --- |
| LA1 Identity core | First a standalone fix (LA1a): `service.mjs` `recent()` and `emailStart`→`authAt`, `emailLoginConfirm` `source:'email'`, device-approval issuance clamped to the approving session. Then `packages/identity/linked-approval.mjs` (new), `device-login.mjs` (alias, inspect removed), `service.mjs` hunks (`session()` `expiresAt`/`parentSessionId`, eviction and lineage cascade in session-removal paths, `derivedFamilies`, outbox append), `packages/identity/index.mjs` exports, the Worker/Node `deviceRequests` adapters (rename), `tests/linked-approval.test.mjs`, updates to `tests/device-login-cancellation.test.mjs` and `tests/identity*.test.mjs` | none; can start now |
| LA2 Federation device grant | `packages/federation/device-authorization.mjs` (new: request validation, browser refusal, limits, token-endpoint device branch with the reserve → activate → re-check order), `app-sessions.mjs` (`E` cap, `approval` lineage, refresh live check, `lineageRevoke`, DPoP-bound access tokens; RPC must accept `token_type: DPoP`, which today it does not), `authorization-entries.mjs` (`delivery:'device'`), `client-metadata.mjs` (refuse unreviewed metadata-document device clients), `tests/device-authorization.test.mjs`, `tests/app-sessions.test.mjs` hunks | LA1 interfaces (`linkedApprovals`, approval lineage live/revoked check, retained past natural session expiry) |
| LA3 Mount (after the routes refactor) | Hunks in `packages/runtime/routes/identity.mjs` (linked routes, QR validator), `routes/federation.mjs` (device endpoint, token branch, manifest gating), `routes/site.mjs` (`/approve` shell, `/device*` redirects), worker env flags, `tests/worker/linked-approval.test.mjs` | LA1, LA2; routes refactor released |
| LA4 Approval page | `apps/web/src/bl/approve.mjs`, `apps/web/src/ui/approve.mjs` (new), removal of the device-review parts of `bl/release.mjs` and `ui/release-public.mjs`, `packages/i18n/approve-catalogue.mjs`, `tests/browser/approve.mjs`, UI-state tests | LA1 contract (mock-first) |
| LA5 Requesting screen | The device-entry parts of `bl/release.mjs` (start, QR, poll, cancel), `apps/web/src/providers/browser.mjs` device-entry hunks, `tests/e2e/*` device cases | LA1; coordinate `release.mjs` with LA4 (LA4 removes review parts, LA5 edits entry parts; one owner at a time) |
| LA6 SDK CLI helper | `packages/sdk/src/device.mjs` (new; Node: DPoP key in a file or OS key store adapter, polling with `slow_down`, system-browser open on keypress, subject check or confirmation), `packages/sdk/test/device.test.mjs`, example under `examples/` using `.example` hosts | Spec only (mock provider) |
| LA7 Revocation UI and notices | Devices and connected-apps list hunks in `apps/web`, after-approval notice templates (push payload type, mail template under `security` role), tests | LA1, LA2, LA4 |
| Coordinator | `docs/spec/protocol.md` features row, `auth.md` cross-link, `federation-implementation.md` wire text, `device-login.md` supersession note, public docs allowlist, DEVLOG.md | this design |

Evidence before completion: `npm test`; engine tests for every row of §13 (lineage cascade atomicity, outbox drain and refresh backstop, `recent()` and email-source fixes, eviction cascade, family reserve → re-check race, global resolve budget, "Continue as" confirmation, single consume, DPoP mismatch without state change, pre-consent byte equality); Worker tests; DOM/browser tests of `/approve` at 320/390/1440 px in en/es, signed-out → sign-in → approve on the same tab, signup continuation, two accounts in two tabs, and step-up; a real CLI run against a local Worker. Production stays gated.

## 15. Open questions — accepted decisions (2026-10-20)

These six questions are resolved by the user's accepted direction recorded in [DEVLOG](../../DEVLOG.md); independent sign-off above remains unsigned. They describe required design behavior, not implemented device-grant capabilities.

- **Q1 App lifetime — accepted.** At most 30 days absolute and 7 days idle, only with a fresh sign-in at approval. A step-up of an existing session is insufficient (§7).
- **Q2 Voluntary sign-out cascade — accepted.** Ordinary sign-out also ends the device and app sessions approved from that session, after a clear warning (§7.4).
- **Q3 Metadata-document clients — accepted.** No device grant for unreviewed metadata-document clients; require operator-reviewed registration initially.
- **Q4 Default duration — accepted.** App approvals default to 1 h; session approvals default to the normal session length, bounded by the approving session's expiry.
- **Q5 Same-device convenience — accepted.** Pasted codes are acceptable for CLIs; no confirm-only path is required.
- **Q6 Proof-of-work — accepted.** No proof-of-work for app starts; use the admission limits in §9.

## 16. Review reconciliation

See [linked-approval-review](../release/linked-approval-review.md). Its findings are folded into the decisions above, and the findings that remain open are listed there.
