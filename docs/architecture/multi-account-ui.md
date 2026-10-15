# Multiple accounts: console, consent and notification destinations

Status: provisional phase-one design; no runtime, SDK, cookie or browser behavior is implemented by this document. Coordinate with [session authority](multi-account-sessions.md). Human review records are nonblocking for authorized reversible development; implementation still needs the conformance evidence below.

Implementation note (2026-10-14): the provider-console slice is implemented locally — [chooser](../../apps/web/src/ui/release-accounts.mjs), [actions](../../apps/web/src/bl/accounts.mjs), per-tab selector, opaque `BroadcastChannel` invalidation, and notification destinations (`owner` routing hint always; handle label only when previews are enabled; click opens a fresh `/console?account=…&message=…` window and requires an explicit chooser switch). Session authority follows the per-account cookie choice in [session authority](multi-account-sessions.md#implemented-choice-independent-per-account-cookies-2026-10-14). App consent, iframes and embeddable elements remain unimplemented.

Reviewer: __________  Date: __________  Outcome: __________

## Recommendation

Support up to five independently authenticated accounts at the same provider in one browser. A provider-owned account menu switches the console's working account; “Add account” signs in another account without signing out the others. Third-party app authorization has its own provider-owned account selection and review. Selecting an account is not consent, and does not silently change an already-open console's working account.

Use a top-level provider page, optionally opened as a popup by an explicit gesture, as the first supported authorization experience. A cross-origin iframe can be an optional launcher, but must not reveal the signed-in account list or sign-in state to the embedding app. Do not weaken the existing session cookie merely to make an iframe work. Final access approval occurs at the top-level provider page, outside the app's ability to overlay or crop it. Retain the existing provider-stored authorization request, exact registered callback and PKCE exchange; do not add an account-list API for apps.

This is a provider-local account switcher. It does not combine sessions from unrelated providers, move identity keys, log into external consoles, or turn a remembered foreign handle into a local session. An app may separately choose a provider through existing discovery. Cross-provider dashboard aggregation would need another design and explicit authorization.

## Current implementation and required changes

| Area | Current source behavior | Proposed change |
| --- | --- | --- |
| Browser authentication | `packages/runtime/http.mjs` installs a single HttpOnly `__Host-bindle_session` with SameSite=Strict; session lookup resolves one account. | Bounded authenticated session collection with live owner/session validation, as specified by the session-authority design. Never put raw session tokens in UI state. |
| Console | `release-app.mjs` has a single account sidebar and sign-out action. `owner-flow.mjs` fences asynchronous owner work with owner ID and `beamGeneration`. | Account menu and explicit owner transition; extend existing fences to all owner data and cross-tab requests. |
| Authorization | `apps/web/src/authorize.mjs` reads `/api/session`, then inspects and approves one provider request. It already clears some selections when the owner changes. Federation HTTP denies framing. | Choose a session inside the provider first, then inspect that owner's resources and bind review/decision to that selection. Clear the entire review when it changes. |
| Push | Message payload/click data in `apps/web/sw.js` contains message ID and optional source/action locator; it has no destination owner. Clicking navigates the first matching console. | Add a server-bound destination and account-aware navigation. Never open a message against whichever account happens to be active. |
| Privacy | Owner JSON is private/no-store; authorizations use exact callbacks. The console is not frameable. | Preserve those boundaries. No authenticated account-list CORS, no app login-status probe, no broad console framing exception. |

The table describes source behavior, not production deployment evidence. Existing owner-generation guards are useful but do not by themselves prevent a stale tab's HTTP request from using a newly selected account cookie.

## Console interaction

The sidebar account control shows the current full handle and provider, with a menu of this browser's authenticated provider-local accounts. The provider page alone receives minimal entries: a non-secret selector, canonical account identifier/handle, active marker and session availability. Display names and local badges may decorate those entries but never replace the distinguishing handle. Avoid avatars or extra profile fetches in the first slice. No private email, subscription balance, unread counts or resource contents are needed to select an account.

Menu actions:

- **Switch account:** select a live entry, clear the old owner context, validate the target session and load its console. A failed target check leaves a blank transition/error surface or safely restores a newly revalidated prior owner; never retain old content under the target label.
- **Add account:** opens the normal sign-in flow and preserves existing sessions. New-account creation is offered only under current signup/onboarding policy. Passkey, password, device approval, contact verification and recovery requirements remain unchanged. At the five-account limit, ask which browser session to remove; never silently evict one.
- **Sign out of this account:** revokes this browser's selected session and removes its picker entry. The empty console then offers the remaining accounts. It does not automatically expose another account's messages on a shared screen.
- **Sign out of all accounts in this browser:** explicit confirmation, bounded revocation of all locally represented sessions, then an empty signed-out console. Report partial/unknown server revocation honestly and permit retry; retain narrowly scoped retry authority for unresolved revocations rather than deleting the only credentials needed to finish them. Private console content is cleared immediately. This differs from “Sign out other devices,” which remains an account-specific security action.

An expired entry can be shown as requiring sign-in only after provider validation; a remembered handle alone never authorizes switching. Add-account cancellation clears only that attempt's temporary credentials, setup capability and device flow, while keeping previously authenticated sessions intact. A late successful login response must not reinstall an account after cancellation without a deliberate user continuation; cookie/session-set races require the backend's cancellation/reconciliation behavior, not just ignoring a promise.

The converged implementation direction uses an explicitly session-bound selector per tab. The collection active pointer is an initial/default choice; existing tabs keep their validated selected member rather than follow a mutable cookie default. Each private request carries its tab's expected owner and session context, and the server validates that member against the presented authenticated snapshot plus current live authority. Selecting B in another tab or authorization request does not turn A's form into a write to B. Revocation or removed membership still invalidates A and blanks its private UI. This depends on the backend snapshot-scope/rotation review and is not implemented by this document.

## Owner transition is a security boundary

Use a transition generation in addition to owner ID: switching A→B→A must not make work from the first A valid again. Increment and blank sensitive state synchronously before starting a switch. Each request captures expected owner plus authenticated session/selection epoch. The server must check that binding before any owner read or mutation. An owner ID or epoch supplied by the browser is a consistency selector, not authority; only a live session in the authenticated collection authorizes it. A stale selection gets a typed mismatch response and no effect on either account.

Abort in-flight reads where possible, but treat abort as local cancellation, not proof a remote write did not happen. Retain only bounded owner-keyed operation identifiers needed to reconcile unknown outcomes; never replay them for the new owner or issue fresh financial/form operation IDs automatically. After every asynchronous stage, verify owner, generation, route and operation incarnation before publishing data, errors, CSRF values, credential results or navigation.

The transition teardown must cover:

- account snapshots, messages/body/history/source, list/search results, cursors, Views, drafts and selected items;
- resource grants, app connections, consent selections, private preference fragments, automation, billing quotes/checkout URLs, signed contact links and developer-contact capability;
- prepared form dispatch tokens, typed field values, result toasts/links, submission review state and outstanding action ports; close MessageChannels, destroy isolated frames and revoke owned Blob URLs;
- contact/conversation acceptance drafts, beam invitations, local device offers, device-login polling and their generation-bound approvals;
- recovery material, onboarding/bootstrap capabilities and pending setup state when abandoning that setup; any intentionally retained limited setup must be separately identified, never attached to the new owner;
- service-worker window listeners and notification continuations that expect an owner; token-free continuation references may survive only with exact destination binding and expiry.

Audit all private browser storage keys, including existing setup, billing and recovery continuation keys. A global clear-all is not a substitute for ownership: permitted recovery/setup continuations need explicit owner/attempt scope; unscoped secrets are removed. Keep ordinary UI preferences such as locale separate. Service-worker app-shell caching must never cache account responses or private HTML.

Cross-tab BroadcastChannel/storage messages may announce only a non-secret invalidation generation, not tokens, account lists or private data. They are advisory: dropped, spoofed same-origin or reordered notices cannot bypass server binding. On focus, visibility return, bfcache restoration and reconnect, revalidate before enabling owner actions. A stale 401 from A must not log out B or clear B's CSRF state.

## Provider-owned account selection for apps

1. The existing app login starts from a resolved identity and an owner-sharded bounded request, with registered client/callback, PKCE and state. Its opaque request reference/navigation URL does not disclose other browser accounts or whether that owner is signed in. The current route is not a generic provider-only chooser request.
2. User opens the provider. The provider validates the request and displays its exact app origin and provider identity. Account discovery happens only inside this provider page.
3. Choose an already-authenticated account or sign in another. The existing request is handle/owner-bound: only its exact owner can approve it. Choosing a different identity requires a new authorization request; never retarget the existing request. A private cross-owner replacement protocol is an explicit implementation gate, described below. No resources, tokens or stable subject are returned to the app merely by choosing. When only one account exists, still visibly name it and offer “Use another account”; do not auto-approve.
4. Inspect requested resources/fields/methods for that selected live session. Show “Connect as …” alongside the app origin and exact access review. Re-selecting an account discards resource selections, drafts, previous consumer-impact review, CSRF/epoch binding and pending approval.
5. Submit an explicit decision bound to authorization request, selected session/owner epoch and reviewed resource/grant revisions. Revalidate at commit. Changes require fresh review; do not silently apply the same checked field names to another owner's resources.
6. Only after approval return the usual one-use authorization code to the exact registered callback. Its subject/grants remain that chosen account even if the console later switches. Token exchange and subsequent app calls do not follow the console's current owner. Denial returns only a generic denial for this request, not whether accounts exist.

Login success, resource configuration and app consent are distinct decisions. Changing shared preference fields still needs the existing affected-consumer review for the selected account. Existing app grants remain valid until their normal expiry/revocation; signing out the console does not secretly revoke all app authorizations, and switching does not extend them. A “switch account” control inside an app starts a new explicit authorization and lets the app retire its old tokens under its existing logout policy.

## Third-party login, account switching, reauthentication and sign-out

Expose explicit provider-hosted intents through the existing authorization/request machinery, not app-side access to the browser account collection. Each intent is bound to registered client, exact allowed return URI, unpredictable client state, expiry and an operation/request nonce. A request cannot smuggle an arbitrary return URL or silently transition into a more powerful intent. GET opens a review page; sign-out or account changes require deliberate provider UI and an authenticated mutation.

| App intent | Provider behavior | What the app learns |
| --- | --- | --- |
| `login` | Select or sign in a provider-local account, then review requested access. Signing in alone grants nothing. | Normal authorized callback/code for the chosen identity, or generic cancellation. |
| `select-account` | Open the same provider-owned chooser explicitly. An already owner/handle-bound request cannot be retargeted. Selecting another identity requires a fresh authorization request through the reviewed replacement protocol; old review/code attempts become unusable as appropriate. | Only the account eventually approved, never alternatives or count. |
| `reauthenticate` | Require fresh permitted credential proof for the already bound identity. A different account is a separate login/select flow, never a successful reauthentication of the old subject. Bind freshness result to this client/request/session and any intended reviewed action. | Only the scoped completed result; no general reusable credential/session secret. |
| `end-session` | Present a provider page naming the client and exact account/session to sign out. Default scope is that account's represented browser session. Other accounts and other devices require separate explicit provider choices. | A generic completed/canceled return with state, not account-list/session-existence detail. |

A private cross-owner replacement needs its own narrow protocol: the provider may create a **new** owner-sharded request only through a one-use replacement bound to the original registered client, exact callback, PKCE challenge, state and reviewed request digest. The original request remains immutable. Original and replacement requests may live in different owner actors, so there is no assumed atomic cross-owner transaction. A future design must durably record a one-use handoff decision and recoverable replacement request ID, prevent both branches issuing access, and reconcile crashes without disclosing the chosen identity. Do not build this protocol into the first session-collection slice. A new client-generated authorization attempt instead uses fresh PKCE/state. Do not send the chosen handle to the app merely to ask it to restart. This handoff and crash/replay semantics are not implemented by the current `beginLogin(identity)` API; until reviewed, the existing flow can approve only its originally resolved identity and otherwise cancel/restart deliberately.

An app can immediately forget its own local tokens and invoke already-authorized grant/token revocation as supported. This is **app sign-out**; it must not claim the provider session ended. Conversely, signing out a provider browser session does not automatically revoke every app grant or erase data an app already obtained. Offer clear provider controls to revoke that app's access separately. Never let an app-triggered frame, logout image, callback or GET silently sign out all provider accounts.

If no provider session is available, do not reveal that fact to the app through a silent probe. Show the provider-owned continuation/sign-in UI as appropriate, with a generic final cancellation path. Returning to the app is constrained to the registered client even after add-account, lost-window, credential failure or request expiry. No raw provider session or account-list state is carried in `postMessage`, query parameters, referrers or the callback.

## Iframe privacy, cookie reality and fallback

Cross-origin browser isolation already prevents an app from reading a provider popup/page DOM. An iframe provides a compact surface, not an additional authentication guarantee. An app on the **same origin** as the provider does not have that isolation; do not host untrusted app code on the provider origin. Different paths are not a boundary. See the [HTML origin model](https://html.spec.whatwg.org/multipage/browsers.html#origins).

The Storage Access API explicitly preserves SameSite restrictions: even after access is granted, Strict/Lax cookies are not attached in third-party contexts. It also permits browser-specific grant/deny behavior and activation requirements. Therefore a partitioned cookie jar, Storage Access permission or a loaded frame cannot be treated as proof the existing provider session is available. Keep Strict cookies and use first-party navigation. On arrival from a foreign site the initial Strict-cookie navigation can be unauthenticated; serve the neutral provider shell, then let its own same-origin session request determine state. Do not make the first navigation's missing cookie an irreversible “no accounts” decision. [Storage Access draft, cookies](https://privacycg.github.io/storage-access/#cookies), [HTTP cookie SameSite semantics](https://httpwg.org/http-extensions/draft-ietf-httpbis-rfc6265bis.html#name-the-samesite-attribute).

Recommended initial embedding profile: a fixed-size, session-independent provider launcher with “Continue at your provider.” Its click opens the same bounded request in a top-level popup; if blocked or unavailable, offer an explicit full-page redirect. An iframe account picker is deferred until a separately reviewed narrowly scoped authentication mechanism and cross-browser evidence exist. Do not introduce SameSite=None on the owner session as an implicit UI fix. A future Storage Access experiment requires visible user activation, denial handling and the same top-level fallback; it cannot waive cookie or consent protections.

Only a dedicated authorization/launcher response could receive a framing exception, computed from the server-validated request's exact registered client origin. No query-controlled arbitrary ancestor, wildcard, suffix matcher, global X-Frame-Options removal or console/account/recovery framing exception. CSP checks the full ancestor chain: an app embedded in an unrelated outer host should fall back top-level rather than add that host from a client assertion. Registration does not make the app trusted against clickjacking; final consent stays top-level. [CSP frame-ancestors](https://www.w3.org/TR/CSP3/#directive-frame-ancestors).

No preconsent postMessage events containing `authenticated`, account count/list/handles, selected owner, profile, available resources or storage-access state. No parent-driven silent account selection. Prefer ordinary registered callback over a new event protocol. If a future completion signal is useful, send only after explicit decision, to the exact registered origin and expected window/channel with a request nonce; never send owner cookies/session tokens. Receiver validates origin, source window, request state and single-use completion. Do not trust a parent-supplied `origin` field. [HTML cross-document messaging security](https://html.spec.whatwg.org/multipage/web-messaging.html#security-postmsg).

Use fixed neutral launcher layout, no account-dependent resize/load-status callbacks, no third-party fonts/avatar/analytics and no authenticated CORS response to the app. This reduces intentional disclosure; it does not promise perfect timing, user-interaction, browser-extension or window-lifecycle side-channel resistance. The app will learn the identity actually approved and may observe abandonment or callback timing.

## Notifications identify the destination without authorizing it

The notification producer must derive owner and destination from the authenticated account/outbox, never message body, app-submitted subject, sender metadata or a caller-selected account label. Extend the push protocol with a bounded provider-local destination reference and account label policy. Bind notification IDs/tags to owner plus message so distinct accounts cannot replace each other's notices. The service worker receives only the minimal display and routing fields; it never receives a session token or the browser's account list.

Show the destination account label separately from verified sender-app name/origin when previews are enabled. Retain preview-off default. Provide an independent “Show account name in notifications” privacy control, default off; then notifications can say “New message · Account 2” using a local opaque label rather than expose a canonical handle on a lock screen. Any generic numbering is decoration, not identity. A visible canonical handle requires that owner's explicit choice. Do not fetch avatars/icons remotely at notification time; retain neutral or already-approved local assets.

A browser push subscription is attached to a service-worker registration, not inherently to one signed-in account. Explicitly enroll each account/subscription association; adding an account does not silently enroll it. Never implement signing out one account by `PushSubscription.unsubscribe()` if that subscription still serves other accounts. Remove only its association, close that owner's displayed notices when possible, and state that already delivered/in-flight notifications may not be retractable. An invalid/stale session must not grant notification-body access on click.

Click flow:

1. Validate bounded notification data and open/focus only an exact same-origin console route. Prefer a window already showing the destination; do not navigate the first arbitrary console and accidentally interrupt another account's private draft. Otherwise open a new window or request an explicit switch through the console controller.
2. The continuation carries an opaque server-bound destination/message reference with expiry. Keep account identifiers/handles and capabilities out of notification URLs where possible; a reference grants navigation only. The owner API still resolves and authorizes the target account. Do not forward it to other origins.
3. If that destination is already the active authenticated account, revalidate and fetch. If it has a live but inactive session, show “Switch to this account to open the message” and perform the ordinary authenticated generation-fenced mutation only after confirmation. The tab-local selection uses the authenticated selector model; GET, a forged navigation or notification payload alone never changes an account selection. Click is navigation, not form submission or app consent.
4. If absent/expired, show provider-owned sign-in for the destination, without exposing its content or claiming an account exists to a third-party app. After login verify exact destination; signing into another account must not search it for a matching message UUID. Offer retry/add-account or cancel.
5. Re-fetch the authorized message and current content digest. Advisory form/link locators only open/focus current content; changed/deleted messages show a bounded explanation. Never auto-dispatch a form or reuse a prepared submission capability from push data.

A malicious page can fabricate a navigation request; the lookup remains harmless because it conveys no access. Payload authenticity/association must be enforced by the push producer and backend continuation resolver, not a sourceDigest-present heuristic. Offline clicks show a generic reconnect screen without reusing another owner's cached message. Payload and request limits remain bounded, and unsupported OS action buttons fall back to ordinary message opening.

## Proposed UI/backend seam

Names below describe responsibilities, not committed new wire endpoints. Final endpoint/field names belong to the session-authority implementation review.

| Operation | Provider-only response/binding | UI obligation |
| --- | --- | --- |
| List browser accounts | At most five validated minimal entries; active selector and collection/selection epoch; private no-store, same-origin | No app-facing relay or persistent account-list cache. |
| Switch working account | Authenticated collection, explicit target, expected current selector/epoch, appropriate CSRF; response binds selected owner/session | Tear down first; install result only while transition incarnation still matches. |
| Add account | Existing login/setup gates; bounded collection merge preserving unrelated live sessions | Cancel/late-result fences; never persist the collection's raw credentials. |
| Remove one/all | Exact selected session set, durable revocation outcomes | Distinguish local removal from known server revocation and device-wide account revocation. |
| Select authorization owner | Request-bound selected live session; no console switch; review digest | Clear consent drafts and inspect selected owner's actual resources again. |
| Notification continuation | Server-bound destination/message, no access authority | Select or sign in correct owner, then fetch; never submit actions automatically. |

Cookie collection concurrency and stale response overwrites are backend concerns with UX consequences. A late Set-Cookie must not resurrect a revoked session; a concurrent add/switch must not silently drop another valid account without a recoverable explanation. The UI cannot solve this through localStorage locking. The authority design must explicitly cover it before the first implementation slice is called complete.

## Phases and evidence gates

1. Finish the current baseline browser gate/commit. This document authorizes no shared runtime edits during that checkpoint.
2. Implement and test bounded session authority plus provider-local picker/add/logout and server expected-owner fences. Include concurrent tabs, stale Set-Cookie, canceled add/device approval and A→B→A responses. Review basic privacy before integrating OAuth.
3. Add request-local authorization selection with exact owner/review binding. Test two accounts with identical resource labels but different grants, target expiry between review/approve, app callback confusion and no silent account selection disclosure.
4. Add destination-bound push associations and click continuation, then account-label privacy controls. Test shared subscription unlink, stale/malformed payloads, absent target login, wrong-account login, changed/deleted message, offline click and disabled previews.
5. Consider optional embedded launcher only after actual Chromium, Firefox and WebKit checks with third-party cookies blocked, storage permission denied, popup blocked, nested hostile parent and private browsing. Preserve top-level fallback. An embedded authenticated picker is a separate security/compatibility decision.

DOM tests must assert no cross-owner text/URLs/capabilities survive transitions. Browser tests must exercise real cookies, two tabs, late responses and inaccessible cross-origin DOM, not just mock a picker. Network assertions must show no preconsent account/state events and no account-dependent SDK response. Service-worker tests must verify account-targeted routing without automatic effects. Run core/Worker/Node checks appropriate to the eventual source changes; no such implementation evidence is claimed here.

Open product choices: five-account cap is proposed; notification account-name opt-in wording and opaque-label persistence need UX validation; tab-local selection depends on the reviewed authenticated snapshot model; embedded authenticated account selection remains deferred. These do not justify weakening existing session, consent or recovery requirements.
