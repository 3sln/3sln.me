# Linked approval: approving sign-ins from another device

Status: **provisional design, 2026-10-20.** Nothing here is implemented, routed or production-verified. This is a 3sln.me host design. The only Bindle interop it relies on is [device authorization](../spec/device-authorization.md) (`device-authorization.v1`, proposed). Everything about pages, wording, account choice and provider-session extension is host policy. Decisions are provisional until signed off in DEVLOG.md. Independent security review: [linked-approval-review](../release/linked-approval-review.md).

Architecture/security/product sign-off: reviewer ___ / date ___ / outcome ___.

Builds on: [device login spec](../spec/device-login.md) and its [cancellation review](../release/device-login-cancellation-review.md), [auth](../spec/auth.md), [adaptive app sign-in](adaptive-app-sign-in.md) (app sessions, §12), [multi-account sessions](multi-account-sessions.md) and [multi-account UI](multi-account-ui.md), [client ID metadata](../spec/federation-implementation.md#client-id-metadata-documents-client-id-metadatav1), and the [application engine](app-engine.md).

## 1. Direction and summary

User direction (2026-10-20): extend the QR device sign-in, which extends a login from one device to another, to other uses such as console or CLI applications signing in. It need not be a QR code; a link plus a correlation code is enough. The user opens the link in a signed-in browser (or opens it and then signs in) and approves. The resulting login or token has its own lifetime, the same as or shorter than the approving session's.

Design in one paragraph. One **linked approval** mechanism serves two kinds of request:

- **`session` kind.** Provider-session extension: a TV or another browser gets a provider owner session. This is the existing device sign-in, generalized.
- **`app` kind.** A client without a browser redirect (CLI, console tool, TV app) gets app credentials through the Bindle device authorization grant.

Both kinds issue a short **user code** from one namespace. Both are approved on one host page, **Approve a sign-in** (`/approve`): enter the code, choose the account, confirm with a fresh passkey or password, review what is being granted and for how long, then approve or deny. The issued credential expires no later than the approving session, and it is revoked if that session ends early. Approvals cannot be chained from derived sessions, and a QR code or link identifies a request without ever substituting for the code shown on the device.

## 2. Decisions

| ID | Decision | Section |
| --- | --- | --- |
| LA-1 | One host record type, `LinkedApproval {kind:'session'\|'app'}`, generalizes `DeviceLogin`. One user-code namespace and one approval page serve both kinds. | §3, §11 |
| LA-2 | The `app` kind is the Bindle profile of RFC 8628 (`device-authorization.v1`). The `session` kind stays provider-local, not interop, and reuses the same endpoints internally. | §3 |
| LA-3 | User codes are 8 characters from the RFC 8628 base-20 consonant alphabet `BCDFGHJKLMNPQRSTVWXZ` (34.6 bits), shown `XXXX-XXXX`. They replace today's 32-symbol alphabet, which includes vowels and so can spell words. | §4.1 |
| LA-4 | **Codes are resolved only for a signed-in account.** A signed-out visitor can type a code; it is kept in the tab and resolved after sign-in. Guesses are charged to an account as well as an IP. | §4.4, §6.2 |
| LA-5 | **QR codes and `session`-kind links carry a request locator, never the code.** The user always types the code shown on the requesting screen, and the server matches it. A locator plus a wrong code counts against that request, which is burned after 5 misses. | §4.2, §4.3 |
| LA-6 | `app`-kind `verification_uri_complete` carries the code in the fragment. Confirm-only (no typing) is allowed only when the client is operator-registered, and the device-authorization request and the approving browser share a trusted network prefix. Otherwise the user types the code. | §4.3 |
| LA-7 | Approval needs a **credential authentication within 5 minutes**: a sign-in or step-up with a passkey or password. A session created by any linked approval never satisfies it, including in its first 15 minutes. | §7.3 |
| LA-8 | Lifetime: `E = min(approving session expiry, now + kind cap, now + user choice)`. The user picks a duration at approval from a short list, with the shortest offered option preselected. | §7 |
| LA-9 | Lineage: every issued session or app client session records its approving session. Ending the approving session for any reason revokes its descendants. This is atomic for sessions, and for app sessions it uses an outbox plus a refresh-time check. | §7.4 |
| LA-10 | No approval prompts are pushed to the user. After every approval, a notification goes to the account's push devices and verified email, with a link to revoke. | §8 |
| LA-11 | The requesting screen's label becomes a fixed device-kind choice, not free text. The approval page never shows requester-supplied free text. | §5.1, §6.4 |
| LA-12 | Polling throttles live in the non-durable rate limiter. Durable writes happen only on state transitions. | §9 |
| LA-13 | `/approve` is the canonical page. `/device` and `/device/approve` redirect to it for one release, and old fragment codes are ignored. | §12 |
| LA-14 | New operations are engine Actions/Queries on the edge identity engine and the federation engine. HTTP mounts wait for the in-progress `packages/runtime/routes/*` refactor. | §10, §14 |

## 3. Kinds and records

| | `session` kind | `app` kind |
| --- | --- | --- |
| Requester | The provider's own console on another browser (TV, shared computer, new laptop) | A third-party or first-party client without a browser redirect |
| Start | `POST /api/auth/linked/start` from the console, with Turnstile, an exact Origin and the request binding cookie (today's `/api/auth/device/start`) | `POST /oauth/device_authorization` (`device-authorization.v1`); refuses requests carrying `Origin` or `Sec-Fetch-*` |
| Result | A provider owner session installed by the requesting browser's cookie adapter, as now | A DPoP-bound app client session (refresh family) via `grant_type=…:device_code` |
| Consent | "Full access to your account" (owner session) | Fragment consent for the client, through the shared consent kit |
| Expiry before approval | 300 s | 600 s |
| Interop | None (host policy) | [device authorization](../spec/device-authorization.md) |

Common record (identity shard, keyed by request ID, CAS-revisioned like today's `deviceRequests`):

```
{ id, kind, revision, status: pending|approved|denied|cancelled|consumed,
  userCodeHash, userCodeDisplay?,          // display copy kept only on the record, never logged
  deviceHash, bindingHash?, dpopJkt?,      // session: binding cookie; app: dpop_jkt
  createdAt, expiresAt, interval,
  requester: { deviceKind?, network?: { prefix, country?, region?, trusted } },
  app?: { clientId, clientSnapshot, requests, identityHint?, entryId },
  locatorMisses, owner?, approval?: { sessionId, sessionHash, authAt, approvedAt, choice, cap },
  issued?: { sessionId?, sessionHash?, familyId? }, consumedAt? }
```

`network.prefix` is the requester's IPv4 /24 or IPv6 /56, stored only for the request's lifetime. `trusted` is true only where the runtime's client IP is authoritative: `CF-Connecting-IP` on Workers, or a Node adapter with configured proxy trust. When `trusted` is false, network matching and location display are disabled, not guessed.

The `app` kind also creates an **authorization entry** (`delivery:'device'`, no redirect URI, no PKCE, `dpopJkt` pinned). The approval page renders the entry's consent and account selection with the existing pre-consent privacy rules. The linked-approval record holds only the entry ID.

## 4. Codes, locators and links

### 4.1 User code

The code is 8 characters from `BCDFGHJKLMNPQRSTVWXZ`, generated by rejection sampling over random bytes (bytes ≥ 240 are discarded, then `byte % 20`). It is displayed `XXXX-XXXX`. Input is uppercased, `-` and spaces are stripped, and the comparison is constant-time. A unique-reservation index (`userCodeHash → requestId`) shares one namespace across both kinds and lives at most as long as the request. The display copy stays on the record so the requesting side can redisplay it after a reload.

With at most 20,000 live requests globally (§9), one guess hits a live code with probability below 1.2 × 10⁻⁶. The limits in §9 hold an attacker to at most 40 failed guesses per account and 80 per IP per hour, with a global failed-lookup budget that adds a Turnstile challenge. Resolving requires a signed-in account (LA-4), and accounts cost signup admission. The [review](../release/linked-approval-review.md) records the arithmetic and the resulting bounds.

### 4.2 Locator

The locator is the request ID (UUID). It is not secret, but it is not guessable either. It appears only in the URL fragment of links and QR codes: `https://3sln.me/approve#r=<id>`. A locator lets the page say "enter the code shown on that screen". With the locator present, lookup is `(id, code)`. Five wrong codes against one locator set the request to `cancelled` (reason `locator_misses`). The requesting screen then shows "This request was closed after too many wrong codes. Start again." This stops someone who photographs the QR code from guessing the code.

### 4.3 What each link carries, and when typing is required

| Entry path | URL | Code on the page | User action |
| --- | --- | --- | --- |
| Typed by the user | `https://3sln.me/approve` | Typed | Type the code, then review. |
| `session`-kind QR code or link | `/approve#r=<id>` | **Never shown before typing.** The page says "Type the code on the screen you're signing in." | Type the code. A mismatch is reported generically as "That code doesn't match", and counts as a locator miss. |
| `app`-kind `verification_uri_complete`, confirm-only eligible | `/approve#c=<code>` | Shown large, `translate="no"`, as "Code from Acme CLI" | Tick "This code matches the one shown in my terminal or app" (a distinct control that repeats the code), then review. |
| `app`-kind `verification_uri_complete`, not eligible | `/approve#c=<code>` | **Not shown.** The fragment is discarded once read. | Type the code. |

Confirm-only eligibility (LA-6) requires all of:

1. the request is `app` kind;
2. the client is operator-registered (not resolved from a metadata document);
3. `requester.network.trusted` and the approving request's network prefix equals `requester.network.prefix`;
4. the request has seen no locator misses and no other failed confirmation;
5. no `identity` hint mismatch with the chosen account (§6.3).

The usual same-device CLI case (`acme login` opens the system browser on the same machine) is therefore one tick plus approval. A TV or console tool approved from a phone on mobile data, and any link that reaches a victim from elsewhere, requires typing. Network matching is a friction signal, not a security boundary: users behind one carrier-grade NAT share a prefix (see the review, finding LA-R4).

### 4.4 Lookup

`POST /api/auth/linked/resolve {code, locator?}` requires a signed-in member (the account header and session context per [multi-account sessions](multi-account-sessions.md)), an exact Origin and CSRF. It returns a review view only for `pending`, unexpired requests. Every failure (unknown, expired, decided, wrong code for the locator, rate-limited) returns one generic `invalid_code` response of the same shape. A successful resolve does not change the request, and the requester cannot observe it (pre-consent privacy).

## 5. Requesting side

### 5.1 `session` kind (TV or another browser)

The console's "Sign in with another device" screen keeps today's automatic Turnstile start, generation fences, spinner and cancellation. The changes:

- **Device kind instead of a label.** A segmented choice: "TV or shared screen" (default), "Computer", "Phone or tablet". The API accepts only these enum values (LA-11).
- **Display.** Large text: "On a signed-in phone or computer, go to **3sln.me/approve** and enter **BCDF-GHJK**", with the code in `translate="no"`, monospace, letter-spaced and readable at 3 m. A QR code below it encodes `https://3sln.me/approve#r=<id>`, captioned "Or scan, then type the code above". A visible countdown, plus "Get a new code" and "Cancel".
- After approval, the screen shows "Signed in as **@handle** until 21:40", where the time is the issued expiry (§7). This is how a user notices an approval from the wrong account.

### 5.2 `app` kind (CLI and other clients)

There is no Turnstile, since there is no browser. Admission is by the limits in §9. The client receives `user_code`, `verification_uri` (`https://3sln.me/approve`), `verification_uri_complete` (`https://3sln.me/approve#c=BCDFGHJK`), `expires_in: 600` and `interval: 5`. The SDK helper (§14, LA6) prints:

```
To sign in, open https://3sln.me/approve and enter BCDF-GHJK
(or press Enter to open your browser)
```

The helper opens the complete URI in the system browser only on that keypress, and polls with DPoP. It then prints "Signed in as @alice@3sln.me until 21:40". Examples in docs use `acme.example` clients and `provider.example` hosts until publication authority is agreed.

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
3. **Account.** Lists the browser's signed-in members, with handles bidi-isolated, plus "Use another account". There is no default selection when several members exist. If an `app` request carried an `identity` hint, that member is marked "Requested by the app" but still needs a click. A hint that matches no member shows a neutral "The app suggested a different account" (§6.3).
4. **Fresh credential** (LA-7). If the chosen member's last credential authentication is older than 5 minutes, or the session was itself created by a linked approval, the page runs the existing step-up (passkey first, password fallback) inline.
5. **Review.**
   - *Who is asking.* For the `session` kind: "A **TV or shared screen** wants to sign in to your account" (device kind, chosen by that screen). For the `app` kind: the client's verified host (`acme.example`) as the primary label. A registered client's operator-reviewed name may appear beside it. For a metadata-document client, `client_name` appears only as isolated text marked "name not verified", with a "not reviewed by 3sln.me" notice. No logos.
   - *Where and when*, only when `network.trusted`: "Request started 1 minute ago, from a network near **Lisbon, PT** (approximate)". When the approving browser's network is in a different country, an inline warning reads: "This request came from a different country than this browser. If you aren't signing in a device you can see right now, deny it." When untrusted, the location line is omitted.
   - *What.* For the `session` kind: "**Full access** to @alice: messages, files, settings and devices. It can't add passkeys, change recovery or approve other sign-ins without confirming your passkey or password." For the `app` kind: the consent kit's fragment summary (required and optional fragments, fields, methods), with optional fragments toggleable.
   - *How long.* A radio group "Stay signed in for": **1 hour**, **8 hours**, and **Until your sign-in here ends (21:40)**. Options at or beyond the approving session's end collapse into the last one, and the shortest offered option is preselected. When the approving session ends within an hour, the page says "This sign-in ends at 21:40. Sign in again here for longer." and offers a fresh sign-in, which keeps the pending approval.
6. **Decide.** "Approve" and "Deny" carry equal visual weight, and Approve is armed after a 1 s delay (the existing delay-to-arm). Approve posts `{requestId, code or confirmed:true, owner, sessionContext, choice, consent…}` with CSRF.
7. **Done.** "Approved. Return to your device. It will finish signing in within a few seconds." along with the expiry time and "You can revoke this anytime in **Devices** / **Connected apps**". On deny: "Denied. That device can't use this code."

### 6.2 Same device, and signing in first

The pending approval must survive sign-in, account addition, signup and the step-up.

- **Inline first.** Sign-in, add-account and step-up run within `/approve` with the existing adaptive sign-in components, so there is no navigation.
- **Tab-scoped draft.** Before any step that navigates (signup wizard, recovery, email-link sign-in), the page stores `{v:1, locator?, code?, kind?, savedAt}` under one `sessionStorage` key, which never reaches the server or the URL. On return to `/approve`, the draft is read, cleared and resubmitted to `resolve`. Drafts older than 10 minutes are discarded. A request that expired meanwhile shows "This code expired. Get a new one on your device."
- **Signup continuation.** The existing fixed-path device-signup continuation targets `/approve` and carries no code in the server-visible query.
- **Already on the device.** On a phone or computer that is itself the requester, the console's own "Sign in with another device" screen shows no QR code to scan. `/approve` warns "You're approving from the same browser that asked to sign in" when the requester's binding cookie is present, since this is usually a confused user.

### 6.3 Multi-account rules

- Each request carries the tab's `X-Bindle-Account` and `X-Bindle-Session-Context`, and approval re-verifies that the chosen owner and session match before reading request state, as the authorization entry does.
- The record binds `owner` and `approval.sessionId` atomically. A second approval from another tab or account gets `conflict` ("This request was already decided").
- Switching account after resolve resets review state and repeats the step-up check for the new member.
- An `identity` hint mismatch is never fatal. It disables confirm-only and shows the neutral notice.

### 6.4 Localization, accessibility and mobile

- Strings live in a new `packages/i18n/approve-catalogue.mjs` (en/es at launch) with bab interpolation. The code, handles, hosts and client names are interpolated as isolated runs (`<bdi>`, `translate="no"`). Times use `Intl.DateTimeFormat` in the user's locale, and durations are localized ("1 hora").
- The page is one column at ≥320 px with 16 px gutters, uses 44 px targets, and stays visible above the on-screen keyboard (`scrollIntoView` on focus). It works without a hover state.
- Headings mark each step, focus moves to the step heading on transition, and the radio group and toggles are native controls. Warnings use `role="alert"` only when they appear after an action, and are otherwise static text. Forced-colors and reduced-motion are respected, and the countdown is text that is not announced every second.
- The page carries no third-party scripts beyond Turnstile on the global-budget challenge. It sends `Referrer-Policy: no-referrer`, `COOP: same-origin` and frame-busting via CSP `frame-ancestors 'none'`.

## 7. Lifetimes

### 7.1 Formula

`E = min(S, t₀ + cap(kind), t₀ + U)`, where `S` is the approving session's `expiresAt`, `t₀` is the approval time and `U` is the user's choice (§6.1(5)). It is fixed at approval and stored on the request.

| Kind | `cap` | Idle | Notes |
| --- | --- | --- | --- |
| `session` | `sessionTtlMs` (24 h) | None today (owner sessions have no idle limit), so effectively `E` | `expiresAt = E`. Today's code always issues a full 24 h, which this replaces. |
| `app` | 24 h (provisional; open question Q1) | `min(7 d, E)` | Family `expiresAt = E`, `idleExpiresAt = min(t₀ + 7 d, E)`. Access tokens ≤ 5 min and never past `E`. |

Because owner sessions last at most 24 h, a CLI approved from an old session can get little time. The page offers a fresh sign-in to reset `S` (§6.1(5)). Whether `app` credentials should instead reach the ordinary 30-day persistent profile, when approved with a fresh credential, is open question Q1.

### 7.2 Issued `session` kind

`identity.session(account, {label: deviceKind, source: 'linked-approval', parentSessionId, expiresAt: E})`. `session()` gains an `expiresAt` override that is clamped to `≤ now + sessionTtlMs`. The issued session never gains `stepUpAt`. The poll's prepared-save, single-consume and cancellation fence from the [cancellation review](../release/device-login-cancellation-review.md) are kept unchanged.

### 7.3 Fresh credential for approval, and the `recent()` gap

Approval requires `authAt(session) ≥ now − 5 min`, where `authAt` is `max(createdAt if source==='credential', stepUpAt)`. This matches `sessionAuthTime` in `packages/runtime/federation.mjs`.

Separately, the current `IdentityService.recent()` uses `session.createdAt` regardless of `source`. A session created by device approval therefore passes `recent()` for its first 15 minutes. In that window it can approve another device, enroll a passkey, remove credentials or revoke the owner's other sessions. This is review finding **LA-R1** (high, existing code), and slice LA1 fixes it: `recent()` uses `authAt`.

### 7.4 Lineage and cascade

- **Sessions.** The derived session records `parentSessionId`. Sessions live in the account record, so every path that removes a session (`revokeSession`, `revokeOtherSessions`, `logout`, credential removal, recovery, lifecycle suspension) also removes its transitive descendants in the **same CAS**. Device lists show "Approved from *Pixel 8* · ends 21:40".
- **App client sessions.** The family records `approval: {owner, sessionId}`. On session removal the identity service appends `{familyIds}` to an account-local **revocation outbox** in the same CAS (the request record lists issued family IDs per approving session). A drain revokes those families in the federation store, retrying with backoff. As a backstop, every refresh checks `identity.sessionLive(owner, sessionId)` and fails closed with `invalid_grant`. RPC is refused as soon as the family revocation commits. Until the outbox drains, a revoked family's access token can live at most 5 minutes, and it cannot refresh.
- **Sign-out disclosure.** When the current session has live descendants, sign-out and "Sign out of all accounts" say "This also signs out 2 devices you approved from here." (open question Q2 covers whether voluntary sign-out should cascade at all).

## 8. Revocation and notification

- **Devices** (existing list): derived sessions are tagged "Approved from …", with an expiry and a Revoke action. "Sign out other devices" includes them.
- **Connected apps:** each app's client sessions list "Signed in with a code · started from <approx location> · ends 21:40 · Revoke". "Sign out of all apps" (adaptive sign-in Q2) includes them.
- **After-approval notice.** On approval the service records an audit event and sends a localized push to all of the account's push devices, plus email from the `security` sender role when a verified email exists. The notice reads "You approved a sign-in for **Acme CLI** (or **a TV or shared screen**) at 20:41. It ends at 21:40. Not you? Review devices." It links to the console, never to a one-click revoke URL. Mail and push delivery are the existing gated adapters. Their delivery is not claimed by this design.
- **No pre-approval prompts** (LA-10). A pending request never notifies anyone.

## 9. Limits and budgets

| Item | Limit (provisional) |
| --- | --- |
| `session` start | Turnstile + existing `device` guard (per IP) |
| `app` start | 10 per IP per 10 min, 300 per client per 10 min, ≤ 1,000 live per client, ≤ 20,000 live globally, then `temporarily_unavailable` + `Retry-After` |
| Resolve failures | 10 per account per 15 min (then 15 min cool-down), 20 per IP per 15 min; a global failure budget above baseline turns on Turnstile for resolve |
| Locator misses | 5 per request, then the request is cancelled |
| Poll | Interval enforced per device code in the rate limiter (`slow_down` +5 s, max 60 s); 120 per IP per min; malformed codes are rejected before storage reads; DPoP verification happens after the IP limit and before the request read |
| Writes | Only on transitions (approve, deny, cancel, consume, locator miss). Today's per-poll `nextPollAt` CAS write is removed. |
| Retention | Records are deleted at `expiresAt + 24 h`. Consumed records keep `issued` links until `E` for cancellation and lineage. |

## 10. Engine operations and storage

The operations follow [app-engine](app-engine.md) conventions (`{actor,id,input}`, one change event per mutation, declared policy).

| Operation | Engine | Actor |
| --- | --- | --- |
| `linkedStart` (session) | Edge identity | anonymous + Turnstile + binding |
| `deviceAuthorize` (app) | Federation (request tier) → identity repository | anonymous client |
| `linkedResolve` (Query) | Edge identity | owner session |
| `linkedApprove`, `linkedDeny` | Edge identity (session); identity + federation entry approval (app) | owner session, fresh credential |
| `linkedPoll` (session), `deviceToken` (app) | Edge identity; federation token endpoint | binding / DPoP key |
| `linkedCancel` | Edge identity | binding / DPoP key |
| `lineageRevoke` (outbox drain) | Federation | system |

Repository: today's `deviceRequests` adapter (`create`, `get`, `findByUserCode`, `compareAndSwap`) is renamed `linkedApprovals`, and the stored shape gains `kind`. Worker and Node adapters keep their files. The code index stores `userCodeHash`, not the plaintext code.

## 11. Reusing device-login code

`packages/identity/device-login.mjs` becomes `linked-approval.mjs`. The following are kept as they are:

- the CAS consume, prepared-account save and post-save cancellation compensation (`poll`, `cancel`, `revokeIssued`);
- binding-cookie and secret checks (`secret`);
- the exact-hash cleanup.

These change:

- user-code generation (base-20, rejection sampling) and the hashed code index;
- `approve` checks `authAt` instead of `recent()`, takes `choice`, binds `approval.sessionId` and stores `E`;
- `poll` passes `expiresAt: E` and `parentSessionId` to `session()`, and moves interval enforcement to the rate limiter;
- `lookup` requires an owner session, counts locator misses and uses the generic error;
- an `app` branch that, on approval, drives the authorization entry's owner approval and records the entry's internal code; the federation token endpoint consumes it.

`DeviceLogin` stays as a thin alias for one release so existing tests and routes keep working (§12).

## 12. Migration from the current QR flow

1. **Back end, compatible (LA1).** Add `linked-approval.mjs`, alias the `/api/auth/device/*` methods to it, and fix `recent()`. Existing tests pass. The new alphabet applies to new requests; old 32-symbol codes live at most 5 minutes after deploy.
2. **Approval page (LA4).** Ship `/approve`. `/device` and `/device/approve` get a 302 to `/approve`, and browsers carry the fragment across the redirect. When the page reads a legacy `#request=<id>&code=<code>` fragment, it keeps `id` as the locator, **discards `code`**, and asks the user to type it. The old review screen, which displayed the code from the URL so users could copy it from the same page (review finding LA-R2), is removed.
3. **Requesting screen (LA5).** It shows the `/approve` instruction, the device-kind choice and a locator-only QR code. The `/api/auth/device/qr` validator accepts only `/approve#r=<uuid>`.
4. **App kind (LA2/LA3).** Behind `DEVICE_AUTHORIZATION_ENABLED=false` (default) and `FEDERATION_ENTRY_ENABLED`. The manifest declares `device-authorization.v1` only when the flag is on and routes are mounted (lesson F8).
5. **Removal.** After one release, remove the `/device*` redirects, the `/api/auth/device/*` aliases and `DeviceLogin`.

Records in flight at deploy time are short-lived (≤ 5 min) and not migrated. Consumed legacy records keep their `cancel` semantics, including `session_not_linked`.

## 13. Threat summary

| Threat | Primary controls | Residual |
| --- | --- | --- |
| Remote device-code phishing | Fresh credential, explicit account, warning copy, trustworthy context and country-mismatch warning, typing unless same-network and registered client, 1 h default, after-approval notice, revocation, browser refusal at the device endpoint | A user who follows an attacker's instructions still approves. This cannot be fully removed (spec §10.1). |
| QR swap (sticker) | QR carries the locator only; the code is typed from the device display; locator misses burn the request | An attacker who controls the device's own display controls the device. |
| Code brute force | 34.6-bit codes, resolve only when signed in, per-account, IP, global and locator limits, generic errors | Large botnets with many accounts; see the review arithmetic. |
| Session-lifetime escalation and laundering | `E ≤ S`, no approval from derived sessions, `recent()` fix, lineage cascade | A stolen credential (not just a cookie) can always sign in directly. |
| Cross-account approval | Explicit chooser, owner + session-context binding, single CAS, signed-in-as display on the device | User inattention. |
| Replay | Hashed, single-use device code with no success replay; DPoP binding (app); binding cookie (session) | A lost success response requires a restart. |
| Polling DoS | Rate-limiter interval, IP and global limits, no per-poll writes, cheap rejection first | Global caps can deny service during an attack (`temporarily_unavailable`). |

## 14. Implementation slices and file ownership

`packages/runtime/routes/*` is being refactored now (phase 0 per-domain split). **No slice edits route files until the refactor owner releases them**. Slices LA1, LA2, LA4 and LA6 work against engine operations and test harnesses first, and LA3 mounts afterwards.

| Slice | Owns (write) | Depends on |
| --- | --- | --- |
| LA1 Identity core | `packages/identity/linked-approval.mjs` (new), `device-login.mjs` (alias), `service.mjs` hunks (`recent()`→`authAt`, `session()` `expiresAt`/`parentSessionId`, lineage cascade in session-removal paths, outbox append), `packages/identity/index.mjs` exports, the Worker/Node `deviceRequests` adapters (rename), `tests/linked-approval.test.mjs`, updates to `tests/device-login-cancellation.test.mjs` and `tests/identity*.test.mjs` | none; can start now |
| LA2 Federation device grant | `packages/federation/device-authorization.mjs` (new: request validation, browser refusal, limits, token-endpoint device branch), `app-sessions.mjs` (`E` cap, `approval` lineage, refresh live check, `lineageRevoke`), `authorization-entries.mjs` (`delivery:'device'`), `client-metadata.mjs` (device-only documents), `tests/device-authorization.test.mjs`, `tests/app-sessions.test.mjs` hunks | LA1 interfaces (`linkedApprovals`, `sessionLive`) |
| LA3 Mount (after the routes refactor) | Hunks in `packages/runtime/routes/identity.mjs` (linked routes, QR validator), `routes/federation.mjs` (device endpoint, token branch, manifest gating), `routes/site.mjs` (`/approve` shell, `/device*` redirects), worker env flags, `tests/worker/linked-approval.test.mjs` | LA1, LA2; routes refactor released |
| LA4 Approval page | `apps/web/src/bl/approve.mjs`, `apps/web/src/ui/approve.mjs` (new), removal of the device-review parts of `bl/release.mjs` and `ui/release-public.mjs`, `packages/i18n/approve-catalogue.mjs`, `tests/browser/approve.mjs`, UI-state tests | LA1 contract (mock-first) |
| LA5 Requesting screen | The device-entry parts of `bl/release.mjs` (start, QR, poll, cancel), `apps/web/src/providers/browser.mjs` device-entry hunks, `tests/e2e/*` device cases | LA1; coordinate `release.mjs` with LA4 (LA4 removes review parts, LA5 edits entry parts; one owner at a time) |
| LA6 SDK CLI helper | `packages/sdk/src/device.mjs` (new; Node: DPoP key in a file or OS key store adapter, polling with `slow_down`, system-browser open on keypress), `packages/sdk/test/device.test.mjs`, example under `examples/` using `.example` hosts | Spec only (mock provider) |
| LA7 Revocation UI and notices | Devices and connected-apps list hunks in `apps/web`, after-approval notice templates (push payload type, mail template under `security` role), tests | LA1, LA2, LA4 |
| Coordinator | `docs/spec/protocol.md` features row, `auth.md` cross-link, `federation-implementation.md` wire text, `device-login.md` supersession note, public docs allowlist, DEVLOG.md | this design |

Evidence before completion: `npm test`; engine tests for every row of §13 (lineage cascade atomicity, outbox drain and refresh backstop, `recent()` fix, locator burn, single consume, DPoP mismatch without state change, pre-consent byte equality); Worker tests; DOM/browser tests of `/approve` at 320/390/1440 px in en/es, signed-out → sign-in → approve on the same tab, signup continuation, two accounts in two tabs, and step-up; a real CLI run against a local Worker. Production stays gated.

## 15. Open questions

- **Q1 App lifetime.** Should `app` credentials be capped by the approving owner session (≤ 24 h, the literal reading of the direction and the current design), or may a fresh-credential approval grant the ordinary persistent app profile (30 d absolute, 7 d idle), still bounded by lineage revocation? Recommendation: keep ≤ 24 h now and revisit after CLI feedback.
- **Q2 Voluntary sign-out cascade.** Should ordinary sign-out of the approving session also sign out the devices and apps it approved (current design, with disclosure), or should only security revocations cascade? Cascading on every exit is simplest and best matches "same or shorter". Not cascading would let users sign out of a borrowed phone without killing the TV.
- **Q3 Metadata-document clients.** Allow unreviewed `client-id-metadata.v1` clients to use the device grant (always typed code, "not reviewed" notice), or require operator registration for device clients at first?
- **Q4 Default duration.** The shortest offered option (1 h) is preselected. Is "Until your sign-in here ends" a better default for personal devices?
- **Q5 Location display.** Show a coarse network location (Cloudflare geo) on the approval page, which helps detect phishing but can mislead behind VPNs, or omit it and show only the country-mismatch warning?

## 16. Review reconciliation

See [linked-approval-review](../release/linked-approval-review.md). Its findings are folded into the decisions above, and the findings that remain open are listed there.
