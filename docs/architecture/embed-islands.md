# Embed islands: provider iframes for avatar, account switcher and sign-in

Status: **provisional design, 2026-10-14, revision 2** (all 18 review findings addressed; see §23). Nothing here is implemented, routed or production-verified. It is a 3sln reference-host and `@3sln/bindle` SDK design. It is not Bindle interop: islands are provider-operated components under the "Provider-operated components" rule in [auth](../spec/auth.md), and their framing rules belong to the reference-host section of [security](../spec/security.md#reference-host-presentation-and-framing-3slnme-policy). The coordinator records decisions in DEVLOG.md. Independent review: [embed-islands-review](../release/embed-islands-review.md).

Architecture/security/frontend sign-off: reviewer ___ / date ___ / outcome ___.

Builds on: [adaptive app sign-in](adaptive-app-sign-in.md) revision 2 (embed origin, frame key, embed credential and session, frame-initiated popup, FedCM in frame), [embeddable elements](embeddable-elements.md) and its [review](../release/embeddable-elements-review.md), the phase-1 elements in `packages/sdk/src/elements/*`, and the vendored stack in `vendor/dodo` and `vendor/ngin`.

**Supersedes:** embeddable-elements §2 (phase-2 panel row), §3.3 `show-provider-accounts`, §7 (whole), §8.2 (iframe markup), §8.3 step 6 (60 s teardown), §8.4 (message table), §9.1 (panel document sentence), D5 and slice S5. It refines adaptive-app-sign-in §6.1–6.3 and §13 by splitting "the frame" into islands (§20 lists the changes that document needs).

## 1. User direction (followed exactly)

From DEVLOG.md, 2026-10-14:

1. **Islands.** Small provider iframes share one cached shell, `/embed?client=<id>#<part>`. The fragment selects an allowlisted part. A nonce-bound `MessageChannel` carries theme, locale and props inbound and events outbound. The embedder never commands actions.
2. **Leader.** Within the embed partition, one leader island (Web Locks) holds the key-bound embed session and fans state out over `BroadcastChannel`. No `SharedWorker` (unsupported on Chrome Android).
3. **Sizes.** Islands use fixed or embedder-chosen sizes, never content-derived ones. Dropdown overflow and size-based leakage need explicit design.
4. **Snapshot privacy.** DOM-reconstruction snapshotting cannot read cross-origin iframes, and canvas tainting prevents pixel reads. Screen capture is user-permissioned with no content opt-out, and counts as user consent, not a silent leak. `#avatar` bytes go only to the embed-session bearer, with `Cross-Origin-Resource-Policy: same-origin`, no CORS and `no-store`, rendered from an in-memory blob, with no observable load, error or timing signals.
5. **`#avatar`** scales to its iframe, centered and as large as fits. The embedder sets the avatar size by sizing the iframe. Elements supply good defaults.
6. **Composed profile button.** Avatar, a dropdown with account switching, and slots for embedder content. The dropdown container belongs to the custom element in the embedder's DOM. The switcher island is embedded inside it, with slotted content around it.
7. **Popover:** viewport containment (Popover API top layer, CSS anchor positioning with `position-try` fallbacks, a measured JS fallback), RTL and safe areas, reposition rather than close on scroll and resize. Close on outside pointer, Escape, focus leaving, account switch or sign-out, and navigation, with window-blur and `activeElement` checks for cross-origin iframe clicks, but focus moving into our own switcher island does not count as outside. On small screens, a modal bottom sheet (side sheet for side rails or by attribute) with focus trap, scroll lock, swipe dismiss, visible close control, visualViewport awareness and reduced motion.
8. **Events (user correction).** Each island emits only the messages that fit its part. Each wrapper element decides how to compose, debounce or dedupe the events it exposes, as a self-contained unit. There is no global single-event guarantee. Validation, translation and entitlement limits on event detail still apply per element. Account change fires only after the app credential for the new account is ready, with a distinct failure event (coordinator constraint, not superseded).

## 2. Decisions

| ID | Decision | Section |
| --- | --- | --- |
| EI-1 | One static shell document per `client_id` at `https://embed.3sln.me/embed?client=<id>`. The fragment is exactly the part name (`#avatar`), so CSS `:target` paints the skeleton before any script runs. | §3 |
| EI-2 | Part allowlist v1: `avatar`, `account-switcher`, `sign-in`. Each client registration may restrict its parts further. Unknown part: inert blank document, no messages. | §3.2 |
| EI-3 | The nonce, locale and color scheme for pre-handshake rendering travel in the iframe `name` attribute (`window.name`), which the shell reads and clears on boot. They never travel in the URL. This replaces adaptive §6.1's `#n=<nonce>`. | §3.4, §4.1 |
| EI-4 | Caching: shell `no-cache` + ETag (per-client `frame-ancestors`); hashed immutable assets; an optional partitioned service worker that serves assets cache-first and the shell network-first. Account data and avatar bytes are never cached. | §3.3 |
| EI-5 | One `MessageChannel` per island. Inbound messages are an allowlist of validated presentation inputs (theme tokens, locale, color scheme, part props) plus the public flow inputs and the current subject inherited from adaptive §6.2. Nothing inbound starts an action. | §4 |
| EI-6 | Outbound messages are part-specific (table in §4.4). `#avatar` emits only `ready`. | §4.4 |
| EI-7 | Leader election with Web Locks (`bindle-embed:<client_id>`), fan-out over a partitioned `BroadcastChannel`, monotonic leadership terms stored in IndexedDB, heartbeats, and a visible-follower `steal` for frozen leaders. Any part can lead. Key *use* is not exclusive; only the embed session and data stream are. | §5 |
| EI-8 | `#avatar` fills `min(100vw,100vh)`, centered. Bytes come from `/embed/api/avatar` on the embed origin, fetch-only, re-encoded raster, rendered from a blob URL after `decode()`. Without a binding for the app's current subject, the island renders that subject's monogram, which is visually the same as the element fallback, so its appearance is not an availability oracle. | §6 |
| EI-9 | `<bindle-account>` becomes the composed profile button. Its container is one `<dialog>` in the element's shadow root, shown as an anchored `popover="auto"` on wide viewports and with `showModal()` as a sheet on small ones. The switcher iframe is never re-parented. | §8, §9 |
| EI-10 | Each element translates validated island messages into its own events (`bubbles:true`, `composed:true`), dispatched in a microtask after the source message or event. Late listeners read a frozen `state` snapshot that is updated before dispatch. There is no replay and no cross-element guarantee. | §10 |
| EI-11 | Degradation splits two ways. Conditions the element can see (no profile, handshake timeout, sandbox or credentialless attribute, flow `unavailable`) replace the island with element-rendered app-granted UI. Conditions only the island can see (no credential, evicted or blocked storage) are rendered neutrally *inside* the island and never reported. | §11 |
| EI-12 | Inbound `forget` (app sign-out) is kept as the single *state-reducing* inbound message, optionally scoped to one subject. It can only remove this client's local bindings in this partition, which the app's own revocation would kill anyway. Open question Q2. | §4.3 |
| EI-13 | All state-dependent island work (IndexedDB, key use, restores, stream, avatar fetch and decode) runs in a dedicated module `Worker` per island. The island DOM is constant in shape for every state, and `ready` precedes any storage access (review EIR-3). | §3.4, §5, §13.2 |
| EI-14 | Islands are **opt-in** in the current SDK major (`islands="off"` default), because island mode changes phase-1 ARIA, keyboard and slot behaviour. They become `auto` only in a semver-major release with a migration note (EIR-11). | §12.1 |

## 3. Island shell

### 3.1 URL, document and headers

```text
https://embed.3sln.me/embed?client=<percent-encoded client_id>#<part>
```

- `client` is the exact registered `client_id`. The server derives `frame-ancestors` from the client's **redirect-URI origins** (adaptive §7.5, AS-R2-6). An unknown or missing client gets `frame-ancestors 'none'` and a constant inert body.
- The document is byte-identical for every user of a client and depends on no cookies (none are sent: the origin is cookieless) and no part. It contains the client's allowed parent origins and allowed parts as a non-executable `<script type="application/json" id="config">` block, a hashed stylesheet and one hashed module script. It is at most 2 KiB when compressed.
- Headers: `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src blob:; connect-src 'self'; worker-src 'self'; frame-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors <origins>; require-trusted-types-for 'script'; trusted-types bindle-embed`, where `connect-src` is `'self' <issuer origin>` (FedCM in frame fetches with destination `webidentity`, which CSP may map to `connect-src`; *needs browser evidence*). The single Trusted Types policy `bindle-embed` defines only `createScriptURL`, which returns exact allowlisted same-origin paths (`/embed/sw.js`, the hashed island worker) and throws otherwise. `createHTML` and `createScript` stay undefined, so HTML and script sinks still throw. Vendored dodo writes the DOM only through attributes, properties, `classList`, `dataset` and `style.setProperty`, and constructed sheets are outside `style-src` (verified in review); `Cache-Control: no-cache`, strong `ETag`; `Referrer-Policy: no-referrer`; `X-Content-Type-Options: nosniff`; `Origin-Agent-Cluster: ?1`; `Cross-Origin-Opener-Policy` is not sent, because it has no effect on a framed document and the popup rules live in adaptive §9. The shell is static, so it **always** sends `Cross-Origin-Embedder-Policy: require-corp` and `Cross-Origin-Resource-Policy: cross-origin`. It loads only same-origin subresources, so this is safe and lets COEP embedders frame it (*needs browser evidence*). Cross-origin-isolated embedders also send `COOP: same-origin`, which severs the island's popup (adaptive §9), so for them islands render but flows run in plain mode.
- `Permissions-Policy`: the element's iframe carries `allow="identity-credentials-get"` only on `account-switcher` and `sign-in` (FedCM in frame, adaptive §11.3). `avatar` gets `allow=""`.
- **Versioning.** The shell path is unversioned, as the user directed. Protocol versions are negotiated in the handshake (`protocol:[1]`). Asset URLs carry content hashes. A future incompatible shell would use `?client=<id>&v=2`, and v1 stays served for at least 12 months (embeddable-elements §9.4).

### 3.2 Parts

| Part | Purpose | Interactive | Default size (set by the element) | Flows |
| --- | --- | --- | --- | --- |
| `avatar` | The app's current account picture | No (`pointer-events:none`, `tabindex=-1`, `aria-hidden`) | 32 px in the profile button; 40 px for `<bindle-avatar>` | None |
| `account-switcher` | Current account card, other connected accounts in this partition, "Use another account", "Show my account at example.org", "Manage", "Remove from this site" | Yes | 320 × 320 CSS px (`compact`: 320 × 248); sheet: full width × `min(320px, 50dvh)` | Frame-initiated (adaptive §7, §11.3) |
| `sign-in` | One "Continue with Bindle" control | Yes | 44 px tall (48 px with a coarse pointer); inline size from a static per-locale table (≥ 200 px) | Frame-initiated |

Part grammar: `^[a-z][a-z-]{0,31}$`, and the part must be in both the global allowlist and the client's registered list. Any other fragment renders a blank document that sends nothing, so it looks the same as an unknown client. Changing `location.hash` after boot is ignored: an island is one part for its whole life.

No `account-name` island in v1. Text inside a fixed-width frame truncates, which fails WCAG 1.4.4 and 1.4.10 for long names, and the name is often app-granted anyway. The trigger label stays in the embedder's DOM and uses app-granted data (§8.1).

### 3.3 Caching

| Resource | Path | Cache policy |
| --- | --- | --- |
| Shell | `/embed?client=…` | `no-cache` + ETag. A 304 costs one round trip. Registry changes (removed origins or parts) take effect on the next load. |
| Runtime and part modules, CSS, locale catalogues | `/embed/assets/<name>.<hash>.{js,css}` | `public, max-age=31536000, immutable`; `Cross-Origin-Resource-Policy: same-origin` |
| Service worker | `/embed/sw.js` (scope `/embed`, served with `Service-Worker-Allowed: /embed`) | `no-cache` |
| Embed API, including the avatar and the event stream | `/embed/api/*` | `no-store`; never handled by the service worker |

**Service worker (optional enhancement).** The shell registers `/embed/sw.js` through the `bindle-embed` Trusted Types policy after `ready`, unconditionally, whatever the account state. Registration is partitioned by top-level site, like all frame storage (adaptive §4.1). Chromium 115+ partitions third-party service workers; Firefox and WebKit behaviour in third-party frames *needs browser evidence*. It follows the existing `apps/web/sw.js` model: one cache per build generation, installed atomically, with no `skipWaiting` or `clients.claim` across generations. It:

- serves `/embed/assets/*` cache-first (hash-verified at install);
- serves the shell network-first with navigation preload. It falls back to the cached shell only on a network error while `navigator.onLine === false`, and only if the cached copy is less than 24 hours old, which bounds staleness of `frame-ancestors` and the parts list after a registry removal. A fallback shell renders only the offline skeleton, because no data can load without the network;
- returns without `respondWith` for `/embed/api/*`, so DPoP `htu`, streaming and headers are untouched, and never stores it.

It never caches a response that carries `Set-Cookie`, `no-store` or `private`. Everything works without it; it only removes revalidation latency and survives HTTP-cache eviction.

**What the cache can reveal.** A warm cache or service worker shows only that this browser framed this client on this top-level site before. That is identical for every account state and already known to the app.

### 3.4 Boot and first render before the handshake

1. **CSS-only skeleton (first paint).** `:target` matches the element whose `id` equals the fragment (`#avatar`, `#account-switcher`, `#sign-in`), so the hashed stylesheet paints a neutral skeleton (circle, card outline, button outline) before JavaScript runs. Colors use `prefers-color-scheme`. In the frame, that follows the iframe element's used `color-scheme`, which the element sets (*needs browser evidence in all three engines*; otherwise the scheme from `name` applies at step 2).
2. **Script start (before the handshake).** The runtime reads `window.name`, which must match `^bindle-island;v=1;n=[A-Za-z0-9_-]{22};l=<BCP47 ≤35>;cs=(light|dark)$`, then immediately sets `window.name = ''`. It applies the locale (falling back to `en`) and the scheme, and renders the part's **static** UI from the provider defaults: the localized "Continue with Bindle" label, the neutral avatar placeholder, the switcher card with its constant set of 8 empty row nodes and the always-present "More at example.org" row. It runs the sandbox probe (adaptive §10.1), which does not touch storage. **It does not open storage yet** (EIR-3).
3. **Handshake (§4.1).** On a valid init, it applies the validated theme and props, then posts `ready`.
4. **Worker and data.** Only after `ready` does the island start its dedicated module worker (`/embed/assets/island-worker.<hash>.js`, created through the Trusted Types policy). The worker opens IndexedDB, reads or creates the frame key (adaptive §6.1), joins leader election (§5) and delivers snapshots. The document applies each snapshot to the constant row nodes as text and blob-URL updates of identical shape for 0–8 bindings.

No account data renders before step 4, and steps 1–3 do the same work in every account state. The parent sees exactly one `load` event. Account fetches start after `load` and never delay it.

## 4. Channel

### 4.1 Handshake (refines embeddable-elements §8.3)

1. The element generates a 128-bit nonce and creates `<iframe src="https://embed.3sln.me/embed?client=…#<part>" name="bindle-island;v=1;n=<nonce>;l=<lang>;cs=<scheme>" title="<localized part title>" referrerpolicy="no-referrer" loading="eager" allow="…">`. It never sets `sandbox` or `credentialless`. The iframe's `color-scheme` CSS property equals `cs`, and the island sets the same root `color-scheme`, so the browser does not paint an opaque backdrop behind a transparent frame (*needs browser evidence*).
2. On the iframe's first `load`, the element posts once: `iframe.contentWindow.postMessage({v:1, type:'bindle-island-init', nonce, part, theme:{seq, tokens}, locale, colorScheme, props}, embedOrigin, [port2])`. `embedOrigin` comes from the issuer's verified manifest (§12.3), never `'*'`.
3. The island accepts only the first message where `event.source === window.parent`, `event.origin` is in the config block's origin list, the key set is exact, `part` equals its fragment, the nonce matches the one from `name` (constant-time compare), `event.ports.length === 1`, and every field validates (§4.2). It then removes the window listener. All later traffic uses the port.
4. The island replies on the port `{v:1, type:'ready', part, protocol:[1]}`. `ready` is constant and is sent before leader election and before any credentialed request.
5. If no `ready` arrives within 3 s of `load`, the element closes the port, removes the iframe and renders its fallback (§11). A second `load` event (an unexpected navigation), a disconnect, or a change by the embedder to the iframe's `src`, `name`, `sandbox`, `credentialless` or `allow` (seen by a `MutationObserver`) tears the island down. A reconnect mounts a fresh island with a new nonce.

The nonce binds the instance and is defence in depth (EE-07). The port is authenticated by the exact `targetOrigin`.

### 4.2 Message rules (all directions)

Plain structured-clone data only. The receiver rejects `Blob`, `ArrayBuffer`, `MessagePort`, typed arrays and anything else whose prototype is not `Object.prototype` or `Array.prototype` at any depth. Each message has an exact key set, is at most 2 KiB as JSON, and strings are bounded. State messages (`session`, `theme`, `scheme`, `locale`, `props`, `prepare`) are **last-value-wins**: the receiver keeps the latest of each type and applies it on the next task, so none is ever lost, and `session` and `forget` are never rate-limited (EIR-8). Other types are limited to 10 per second per port, and excess messages are dropped. There are no error replies, because a reply could be an oracle. In development builds, drops are logged locally. After 3 schema violations in a minute, the element tears the island down to its fallback, and the island stops reading the port.

### 4.3 Inbound (element → island)

| `type` | Parts | Fields | Validation |
| --- | --- | --- | --- |
| `bindle-island-init` | all | `v`, `nonce`, `part`, `theme`, `locale`, `colorScheme`, `props` | As below. Window message, with the port. |
| `theme` | all | `v`, `seq` (uint32, increasing), `tokens` (≤16) | `validateThemeTokens` (embeddable-elements §8.5) run again in the island, restricted to color tokens and `radius` (§13.3), with the island contrast matrix; canonical `#rrggbb`. Applied by `replaceSync` on an adopted constructed sheet built only from canonical values, with `style.setProperty` per token as the fallback. Trust elements (host line, "can't see" note, warnings) use a fixed palette. `forced-colors: active` ignores tokens. Tokens never affect size, visibility, opacity, position or z-index. |
| `locale` | all | `v`, `lang` | BCP 47 ≤35 characters, resolved against the island's supported locales, falling back to `en`. `dir` follows the locale. |
| `scheme` | all | `v`, `colorScheme` (`light`/`dark`) | Enum. |
| `props` | per part | `v`, `seq`, part fields | `avatar`: `{}` (nothing). `account-switcher`: `{density: 'compact'\|'regular', actions: subset of ['use-another','manage','remove']}`. `sign-in`: `{label: 'continue'\|'sign-in'\|'sign-up', variant: 'filled'\|'outline'}`. Labels are keys into the provider catalogue. No embedder free text ever reaches an island. |
| `session` | all | `v`, `subject` (URL ≤2048) or `null` | The app's current subject (adaptive §6.2). No reply. `null` hides all account data immediately. A change causes **no network or crypto work**: the leader restores every held binding whatever the current subject, and the island only filters the snapshot it already has (EIR-3). |
| `prepare` | `account-switcher`, `sign-in` | as adaptive §6.2 | Public flow inputs only. The intent comes from the clicked control, never from the app (AS-R2-9). The element sends a fresh `prepare` after every flow end. |
| `forget` | all | `v`, `subject?` | **State-reducing only (EI-12).** The receiving island's worker deletes this client's credentials in this partition (only the binding for `subject` if given) directly in IndexedDB, bumps the credentials generation (§5.2), and the leader ends the matching embed sessions. It cannot add, approve, select, switch, open a window or reveal anything. |

The island never takes any action because of an inbound message: no flow, popup, selection, focus move, navigation or network write. A `prepare` only stores inputs. The one network effect is that `forget` ends sessions. Every action requires a trusted activation inside the island (`event.isTrusted`, with the control armed per §13.4).

### 4.4 Outbound (island → element), part-specific

| Part | `type` | Fields | Meaning |
| --- | --- | --- | --- |
| all | `ready` | `v`, `part`, `protocol` | Constant (§4.1). |
| `account-switcher` | `select` | `v`, `subject` | The user picked another connected account (adaptive §6.2). Sent only for a subject the island holds a binding for. |
| `account-switcher`, `sign-in` | `flow` | `v`, `phase` (`started`/`ended`), `outcome?` (`completed`/`canceled`/`popup-blocked`/`unavailable`) | As adaptive §6.2. Generic outcomes only. |
| `account-switcher`, `sign-in` | `code` | `v`, `code`, `state`, `iss` | Only after a completed frame-initiated flow, and only if the parent origin verified at init equals the entry's redirect origin (AS-R2-6). |
| `account-switcher` | `escape` | `v` | Escape was pressed in the island, or a `CloseWatcher` that the island created during an activation fired (Android back; *needs browser evidence*). |
| `account-switcher` | `dismiss` | `v` | The user activated the island's own close affordance (sheet mode only), or a noopener provider tab was opened from the island. |

**Island-side entitlement invariant (EIR-14).** App script can read the raw port (it lives in the embedder's realm and prototypes can be patched), so element filtering is UX, not a boundary. Every outbound field must be app-entitled *before* it leaves the island. `select` is sent only for a subject whose binding was created by a flow that delivered a code to this `client_id`.

Never sent, by any part: size, row count, which bindings exist, labels, avatar status, load or error results, focus position or arrow-key edges, leader status, restore results, or error reasons. The element drops a message type that does not belong to the part (for example `select` from `avatar`) and counts it as a violation.

Arrow-key navigation **wraps inside** the island and never reports reaching an edge, because pressing ArrowDown until an edge message arrived would count rows. Tab crosses the frame boundary natively (§14.1).

## 5. Leader election within the partition

### 5.1 Scope and resources

All islands of one `client_id` on one top-level site, across tabs and windows, share a storage partition (embed origin + top-level site; WebKit also keys by top origin). Within it:

- **Lock:** `navigator.locks.request('bindle-embed:' + clientId, …)`. Web Locks are scoped to the origin's storage partition, so the embedder cannot query or contend for them.
- **Bus:** `new BroadcastChannel('bindle-embed:' + clientId)`. This is partitioned in all three engines (adaptive §4.1), so the embedder and first-party provider tabs cannot join.
- **Term counter:** an IndexedDB record `leader-term:<clientId>`, incremented in a `readwrite` transaction by each new leader while it holds the lock.
- **Credentials generation:** an IndexedDB record `credentials-gen:<clientId>`, bumped in the same transaction as any credential write or delete. The bus is only a hint; the generation is the source of truth (EIR-9).
- **Where it runs:** lock, bus, IndexedDB, fetch, WebCrypto and avatar decoding all live in the island's dedicated module worker (EI-13). The document only renders.

The leader holds the embed sessions (one per stored binding; adaptive §6.3), renews them by key proof, owns the single **data stream** `GET /embed/api/events` (fetch streaming with `Authorization: BindleEmbedSession` plus DPoP, gated as in adaptive §13.4), fetches avatar bytes, and broadcasts snapshots. Followers hold no session.

Key **use** is not exclusive. Any island can sign with the non-extractable key from IndexedDB, so a follower that the user clicks opens its own popup, answers the opener handshake, redeems the claim and stores the credential (adaptive §7). It bumps the credentials generation and broadcasts `credentials-changed`. The leader re-reads the generation on acquisition, on every heartbeat and on that hint, and restores whatever changed, so a hint lost during failover only delays the update by one heartbeat.

### 5.2 Bus messages (same-origin, provider code only; still schema-checked)

| `type` | From | Fields |
| --- | --- | --- |
| `term` | leader | `term`, `instance` (random 128-bit) |
| `snapshot` | leader | `term`, `seq`, `views` (array ≤8 of `{subject, handle, name?, avatar?: Blob, avatarBucket}`), `issuedAt` |
| `heartbeat` | leader | `term`, `seq` |
| `hello` | follower | `instance`, `avatarBucket`. Asks for a snapshot and registers the size bucket it needs; the leader fetches each bucket requested by a live instance. |
| `credentials-changed` | any island | `instance` |
| `forget` | any island | `instance`, `subject?`. Sent after the receiver has already deleted the credentials itself. |
| `resign` | leader | `term`. Sent before the lock is released. |

Followers accept `snapshot` and `heartbeat` only with `term` ≥ the highest term they have seen, and adopt the higher term. Within a term, they accept `seq` only in increasing order. The avatar `Blob` is structured-cloned over the bus. Each island makes its own object URL and revokes the previous one.

### 5.3 Lifecycle

1. After `ready`, each island calls `locks.request(name, {mode:'exclusive'}, callback)`. The holder runs `callback`: it increments the term in IndexedDB, broadcasts `term`, restores bindings serially (padded to ≥300 ms each, adaptive §6.3), opens the stream and broadcasts `snapshot`. The leader keeps leading even with zero bindings (so lock, bus and connections look the same in every state). The callback's promise resolves only on `pagehide` or teardown. Before resolving it broadcasts `resign` and calls `POST /embed/api/session/end` with `fetch(…, {keepalive:true})`.
2. Followers broadcast `hello` and render the last snapshot they receive. Until one arrives, they show the static UI (the monogram for `avatar`).
3. **Failover.** When the leader's document unloads or crashes, the browser releases the lock and the next queued island becomes leader. It restores with its own key proof (sessions are never transferred over the bus) and broadcasts a new term. Followers keep displaying the previous snapshot until it expires (`issuedAt` + 600 s), then fall back to the static UI.
4. **bfcache (EIR-4).** On every `pagehide`, in every state and for leaders and followers alike, the worker runs the same teardown: abort the stream with its `AbortController`, close the bus, release or abandon the lock request, close IndexedDB, and send `session/end` with `keepalive`. On `pageshow` with `persisted`, it resumes from step 1. bfcache eligibility, and `notRestoredReasons`, are then identical for 0 and 8 bindings (verified in I7).
5. **Frozen or throttled leader.** The leader sends a heartbeat every 15 s. A follower whose document is visible and which has missed 3 heartbeats requests the lock with `{steal: true}`. The old holder's lock promise rejects with `AbortError`. When it thaws, it stops streaming and posting at once, and its messages carry a stale term that followers drop. Only visible followers steal, so two hidden tabs never fight. A steal is rate-limited to once per 60 s per instance.
6. **Session caps (EIR-9).** The server keys embed sessions by `(credential, instance)`. When a credential reaches its cap (4 sessions, 2 streams), a new session **evicts the oldest** rather than being refused, so orphans left by a steal, a thawed tab or a bfcache restore can never lock the user out.
7. **Renewal.** The leader renews each embed session 120 s before expiry. Background-tab timer throttling (≥1 minute in Chromium's intensive throttling) fits inside that margin.

### 5.4 Without Web Locks or BroadcastChannel

Web Locks are available in Chrome 69+, Firefox 96+ and Safari 15.4+; BroadcastChannel in Safari 15.4+. If either is missing, or the document is opaque (sandboxed), **each island is its own leader**. That costs one restore per island, bounded by the server's per-credential limits (at most 4 concurrent sessions and 2 streams per credential). No `SharedWorker` is used anywhere.

### 5.5 What the embedder can observe

Nothing designed. Islands never report leadership. `ready` precedes election. Render timing inside a cross-origin frame is not observable except through browser-wide side channels (out of scope, embeddable-elements §4).

## 6. `#avatar`

### 6.1 Rendering

```css
html,body{margin:0;block-size:100%;background:transparent;overflow:hidden}
body{display:grid;place-items:center}
.avatar{inline-size:min(100vw,100vh);block-size:min(100vw,100vh);display:block}
img.avatar{object-fit:cover}
```

Inside the frame, `vw`/`vh` are the iframe's size, so the picture is centered and as large as fits. The island has no size inputs and never measures or reports anything. The element clips shape with `border-radius` on the iframe (the default is a circle in the profile button), so no shape prop exists.

The image resolution bucket is chosen inside the island as the smallest of 64, 128, 256 or 512 px that is ≥ `min(innerWidth, innerHeight) × devicePixelRatio`. That depends only on the embedder-set size.

### 6.2 Bytes

```text
GET https://embed.3sln.me/embed/api/avatar?b=<binding>&s=<bucket>
    Authorization: BindleEmbedSession <session>     (leader only)
    X-Bindle-Embed: 1
→ 200 image/webp (or image/png)
  Cross-Origin-Resource-Policy: same-origin
  Cache-Control: no-store
  X-Content-Type-Options: nosniff
  Content-Security-Policy: sandbox; default-src 'none'
  (no Access-Control-* headers)
→ 401/404 constant body
```

- Gated like every embed API: `Sec-Fetch-Site: same-origin`, `Sec-Fetch-Mode: cors|same-origin`, `Sec-Fetch-Dest: empty`, `X-Bindle-Embed: 1`, and `Origin` equal to the embed origin **when present or when the method is not GET/HEAD**. Same-origin GETs carry no `Origin` header under Fetch, so requiring it would reject every avatar and stream request (EIR-1; the same fix applies to adaptive §13.4). An I4 test sends a real same-origin GET without `Origin` and expects 200. So `<img src>`, navigation, `no-cors` fetch and other sites all get a constant 403. With CORP same-origin, even a `no-cors` response is blocked cross-origin.
- **Raster only, re-encoded server-side** to WebP or PNG at fixed bucket sizes. Workers have no canvas and the repository has no image codec, so I4 must add a vendored WASM codec with provenance, a CPU and size budget, and tests (EIR-18). No SVG, no passthrough of uploaded bytes, and no user-influenced content type. This narrows adaptive T2 ("no user-influenced content served on the embed origin"): the avatar is a fetch-only API response that cannot render as a document (§20).
- Only the leader fetches. It sends a `Blob` over the bus.

### 6.3 No observable signals

- The bytes arrive by `fetch()` after `load` and after `ready`, so the parent's single `load` event is never delayed or changed.
- Each island creates `URL.createObjectURL(blob)` and assigns it to an `<img>` off-screen. It awaits `img.decode()` (decoded off the main thread in Chromium; *needs evidence elsewhere*), then swaps the decoded image in during one animation frame. Every state performs one such swap (the monogram is also rendered as a constant-size raster from the worker), so the main-thread cost is identical. On any failure (fetch, decode, empty `Blob`), it silently keeps the current picture (the monogram). Nothing is posted, sized, focused or navigated.
- Generated badges and uploaded pictures use the same bucket sizes, so the visual box never changes.

### 6.4 Without a binding

When the island holds no binding for the app's current `subject` (never signed in through an island in this browser, evicted storage, revoked binding, `subject` null, or no snapshot yet), it renders the deterministic monogram of `subject` (`monogramPattern` from `packages/sdk/src/elements/monogram.mjs`, shared through the embed protocol module). It uses the same palette as the element's `<bindle-monogram>`. The embedder therefore cannot tell from appearance alone, through user-permissioned capture, whether the island holds a binding, and the user still sees a consistent picture. With `subject` null, it renders a neutral placeholder.

### 6.5 Sizes

Fixed or embedder-set only. Element defaults: 32 px in the `<bindle-account>` trigger (inside a 44 px target), and 40 px for `<bindle-avatar>`. `<bindle-avatar size="24|32|40|48|64|96">` or the `--bindle-avatar-size` CSS length on the host sets it. The element sizes the iframe to the host box. No element or island ever derives a size from island content.

## 7. Snapshot privacy statement

What we claim, exactly:

1. **DOM snapshotting cannot read islands.** Session-replay and screenshot libraries that serialize or re-render the embedder's DOM (rrweb, html2canvas, `XMLSerializer`, `outerHTML`) see only the `<iframe>` element and its attributes (`src` with client and part, `name` with nonce and locale, `title`). The same-origin policy denies access to a cross-origin frame's document.
2. **No canvas path exists.** There is no API that draws a cross-origin frame into a canvas. Images an embedder loads cross-origin taint the canvas, and the avatar bytes are not loadable by the embedder at all (§6.2).
3. **Screen capture is user-permissioned and is not prevented.** `getDisplayMedia` (including tab self-capture with `preferCurrentTab`), Region Capture and Element Capture (`restrictTo`) need a user permission grant, after which everything visible on screen, islands included, is captured. There is no content opt-out for these APIs, and we do not claim one. If a future viewport-capture API offers an embedded-content opt-in, the embed origin will not opt in (*track; needs evidence*).
4. **Not covered:** browser extensions with access to the embed origin; assistive technology and OS-level screenshots or screen recording; printing (`window.print()` or the user's print command renders cross-origin frames into the print preview, which the user then sees and saves, a user-mediated action); "Save page as"; the user's own photography; and browser-wide pixel or timing side channels (rendering-timing attacks are browser bugs, out of scope).
5. **What an embedder can always do:** overlay, crop, hide or reposition an island; read its own DOM, including everything users type into embedder-DOM elements; and observe the facts of §8.2 of adaptive-app-sign-in (flows, outcomes, the approved identity).

## 8. Composed `<bindle-account>` profile button

### 8.1 Structure

```html
<!-- shadow root of <bindle-account>, island mode -->
<div class="wrap" part="wrap">
  <button part="trigger badge" aria-haspopup="dialog" aria-expanded="false" aria-controls="panel"
          aria-label="Account: Ada · example.org">         <!-- app-granted label -->
    <span class="avatar-box" part="avatar"></span>           <!-- reserved box, 32×32 -->
    <bdi part="label" dir="auto">Ada</bdi>                   <!-- trigger="avatar-label" only -->
  </button>
  <iframe class="avatar-frame" part="avatar-frame" aria-hidden="true" tabindex="-1" …#avatar></iframe>
  <dialog id="panel" part="panel" popover="auto" aria-label="Account">
    <div part="sheet-handle"></div>                          <!-- sheet mode only -->
    <button part="close" aria-label="Close">…</button>       <!-- sheet mode only -->
    <div part="menu-header"><slot name="menu-header"></slot></div>
    <iframe part="switcher-frame" title="Your accounts at example.org" …#account-switcher></iframe>
    <div role="list" part="menu" aria-label="Account actions">   <!-- island mode: no role=menu -->
      <slot name="menu-start"></slot>
      <!-- built-in embedder-DOM actions: sign-out (default); reauth, provider-sign-out by attribute -->
      <slot name="menu-end"></slot>
    </div>
    <slot name="panel-footer"></slot>
  </dialog>
</div>
```

- **Interactive content cannot sit inside a `<button>`**, so the avatar iframe is a sibling, absolutely positioned over the trigger's reserved `.avatar-box`. It has `pointer-events:none`, so clicks reach the button. It is `aria-hidden` with `tabindex=-1`, because the button carries the accessible name.
- **Trigger.** `trigger="avatar-label"` (default, compatible with phase 1) or `trigger="avatar"` (avatar only; the label becomes visually hidden but stays in the accessible name). The label uses only app-granted data (`profile.displayName`/`handle`), otherwise "Signed in · example.org", exactly as in phase 1.
- **Slots.** `menu-header`, `menu-start`, `menu-end`, plus new `panel-footer`. In island mode the panel uses the **disclosure pattern**: a dialog holding the island and a list of plain buttons and links in normal Tab order, with **no `role=menu`**, because mixing menu application mode with an iframe of plain buttons conflicts for screen readers (EIR-11). Slotted children keep their own markup; the element cannot rewrite it, so development builds warn when a slotted child has `role="menuitem"` in island mode, and docs tell embedders to use plain links and buttons. Fallback mode keeps phase-1 `role=menu` behaviour exactly. `badge` still replaces the avatar island with embedder content (the island is then not mounted). `signed-out` is unchanged, and its default is the `<bindle-sign-in>` island button (§12.2).
- **Built-in actions** stay in the embedder DOM: `sign-out` (default), `reauth`, `provider-sign-out`. `switch` and `manage` move into the switcher island ("Use another account", "Manage at example.org") when it is live. In fallback mode they render as in phase 1.
- **Parts.** Existing: `badge` (now also `trigger`), `label`, `menu`, `menu-header`, `item`, `item-danger`, `separator`, `status`, `notice`, `sign-in`. New: `wrap`, `trigger`, `avatar`, `avatar-frame`, `panel`, `switcher-frame`, `sheet-handle`, `close`, `backdrop` (styled through `::backdrop` on `panel`). `monogram` stays in fallback mode. Islands themselves are token-only.

### 8.2 Island lifecycle in the button

- The avatar island mounts when the element shows a signed-in session and the provider advertises the islands profile.
- The switcher island mounts on first **intent**: pointerenter or focus of the trigger, or the first open. It then stays mounted while the element is connected. The phase-1 design's 60 s teardown is dropped, because the leader pushes updates. It lives inside the closed `<dialog>` (`display:none`), which does not unload it. It is **never re-parented**, since moving an iframe reloads it in every engine without `moveBefore`. Mode changes (§9.4) toggle the same `<dialog>`.
- The panel's island height is fixed by `density` (320 or 248 px), or in sheet mode by `min(320px, 50dvh)`. Those are embedder-side inputs, never island content.

## 9. Popover and sheet

### 9.1 Mode selection

- **Anchored popover** when `sheet="never"`, or `sheet="auto"` (default) and the viewport inline size ≥ `sheet-breakpoint` (default 600 CSS px) and the visual viewport height is ≥ 480 px.
- **Sheet** otherwise, or with `sheet="always"`. `placement="auto"` (default) picks a **side sheet** if the trigger sits in a side rail: the nearest ancestor (crossing shadow roots) whose box is ≥70% of the viewport height, ≤40% of its width, and touches the inline-start or inline-end edge. That edge becomes the sheet edge. Otherwise it picks a **bottom sheet**. `placement="bottom-sheet|start-sheet|end-sheet"` forces one, and `start`/`end` are logical (RTL-aware).

### 9.2 Anchored placement

Preferred (CSS anchor positioning, Baseline 2026: Chrome 125+, Safari 26, Firefox 147+; detected with `CSS.supports('position-try-fallbacks: flip-block')`):

```css
.trigger{anchor-name:--bindle-trigger}          /* tree-scoped to this shadow root */
dialog[popover]{
  position:fixed; position-anchor:--bindle-trigger; inset:auto;
  position-area:block-end span-inline-end;      /* logical: follows dir */
  position-try-fallbacks:flip-block, flip-inline, flip-block flip-inline;
  position-try-order:most-block-size;
  margin-block:4px;
  margin-inline:max(8px, env(safe-area-inset-left)) max(8px, env(safe-area-inset-right));
  max-block-size:calc(100dvh - 16px - env(safe-area-inset-top) - env(safe-area-inset-bottom));
  max-inline-size:min(24rem, calc(100vw - 16px - env(safe-area-inset-left) - env(safe-area-inset-right)));
  overflow:auto; overscroll-behavior:contain;
  position-visibility:anchors-visible;
}
```

**JS fallback** (no anchor positioning; also used when no Popover API exists). The element measures `trigger.getBoundingClientRect()`, the panel's border box, and the visual viewport (`visualViewport.offsetLeft/Top`, `width/height`). It reads safe-area insets from a hidden probe with `padding: env(safe-area-inset-*)`. Then:

1. **Placement.** Block-end, aligned to the inline-start edge of the trigger (physical right in RTL).
2. **Flip** to block-start if block-end space < panel height and block-start space is larger.
3. **Shift** along the inline axis to keep 8 px plus the safe-area inset from both edges.
4. **Size.** Set `max-block-size` to the chosen side's available space. The panel scrolls; the island never shrinks below its fixed height. If even that does not fit, the panel scrolls with the island inside it.
5. Apply with `transform: translate()` on a `position:fixed` panel in the top layer.

Recompute (rAF-throttled) on `scroll` (capture, passive, any ancestor), `resize`, `visualViewport` `resize`/`scroll`, `ResizeObserver` on the trigger and panel, and `dir` or `lang` changes. **Reposition, never close, on scroll or resize.** If the trigger is fully clipped out of view and focus is outside the panel, the panel **closes** (`reason:'anchor-hidden'`), because there is nothing left to reposition against and a visually hidden panel would stay armed (EIR-10). If focus is inside, it clamps to the nearest viewport edge. In CSS anchor mode, `position-visibility: always` is used instead of `anchors-visible`, and the element's `IntersectionObserver` on the trigger applies the same rule.

Without the Popover API, the panel is `position:fixed` with a high `z-index`, appended in the element's shadow root. Transformed or `contain`ed ancestors can trap it; that is documented as an embedder limitation, with `sheet="always"` as the escape hatch.

### 9.3 Close semantics (anchored and sheet)

| Trigger | Mechanism | Focus after close |
| --- | --- | --- |
| Pointer outside (embedder DOM) | `popover="auto"` light dismiss; in the fallback, `pointerdown` + `pointerup` both outside the composed path of host and panel | Not moved |
| Tap on a non-focusable spot in another iframe (iOS, coarse pointer) | No focus change or blur occurs there, so with a coarse pointer the anchored popover adds a transparent full-viewport catcher behind it in the top layer; the first outside tap closes and is consumed (EIR-10) | Not moved |
| Click inside **another** cross-origin iframe | Parent `window` `blur` → in a task, `document.activeElement` is an `<iframe>` that is not inside our panel → close | Not moved |
| Focus moves into **our** switcher island | `focusout`/`blur` → deferred check finds `activeElement` is our `switcher-frame` → **stay open** | — |
| Focus leaves the panel to an embedder element | `focusout` on the panel with deferred check: `activeElement` is outside host and panel (composed) → close | Not moved |
| Focus moves from our island into another iframe | The parent gets `focusout` on our iframe and `focusin` on the other (focus update steps) → the deferred check closes. Also rechecked on parent `window` `focus`/`blur` (*needs browser evidence*) | Not moved |
| Window loses focus to another app, tab or the popup the island opened | `window` `blur` with `activeElement` = our island or an embedder node inside the panel, or unchanged → **stay open** | — |
| Escape in embedder DOM | Popover light dismiss / dialog `cancel` | Trigger |
| Escape in the island | `escape` message (only accepted while open) | Trigger |
| Android back / close request | Modal dialog close watcher (sheet); island `CloseWatcher` → `escape` | Trigger |
| Account selected in the island | `select` → close immediately; the element's `role=status` region announces "Switching account…" until the change completes or fails | Trigger |
| Built-in action (sign-out, reauth…) | Close before running, so popups open inside the activation | Trigger |
| Session change (sign-in, switch, sign-out, expiry) | `bindle-session-change` | Trigger if focus was inside |
| Navigation | `popstate`, `hashchange`, Navigation API `navigate` (when available), `pagehide` | — |
| Another auto popover or modal dialog opens | Top-layer rules | — |
| Element disconnect or `hidden` | Close without events beyond `bindle-menu-toggle` | — |
| Trigger activated while open | The trigger is the panel's invoker (`popovertarget`, or `commandfor`/`command="toggle-popover"`) in the same shadow root, so light dismiss treats it as inside and the click toggles closed instead of close-then-reopen (EIR-10) | Trigger |
| Mode change while open | Close + reopen in the new mode, preserving focus target (§9.4) | Kept |

"Inside" means the host, the panel or `switcher-frame` only. Another Bindle element's islands, and the avatar frame, count as outside. Close checks run in a task after the event (`setTimeout(0)`), because `activeElement` updates after `blur`. Each close emits `bindle-menu-toggle {open:false, reason}`.

### 9.4 Small screens: sheet

- The same `<dialog>`. Mode changes follow a fixed order, because `showModal()` throws while the popover is showing and `showPopover()` throws on an `open` dialog: to sheet, `hidePopover()` → remove `popover` → `showModal()`; to anchored, `close()` → set `popover="auto"` → `showPopover()` (EIR-10). This gives modal semantics (`aria-modal` implied), top layer, `inert` on the rest of the document, native focus containment (Tab from the island's last control goes to the next focusable in the dialog or out to the browser chrome, which modal dialogs allow), `::backdrop`, `cancel` on Escape and the Android back gesture. (*Needs browser evidence for re-adding the attribute while closed.*)
- **Bottom sheet.** `inset-block-end:0`, full width up to 40rem and centered, top corners rounded. `max-block-size: calc(100dvh - max(24px, env(safe-area-inset-top)))`. Padding includes `env(safe-area-inset-bottom)`. A visible `close` button sits in the header. A drag handle is centered.
- **Side sheet.** Pinned to the chosen logical edge, `inline-size: min(22rem, 88vw)`, full block size, padding with that edge's safe-area insets.
- **Scroll lock.** On open, the element records and sets `overflow:hidden` on `document.documentElement` and compensates the scrollbar with `scrollbar-gutter: stable` or the measured width. The panel has `overscroll-behavior:contain`, and the backdrop and handle have `touch-action:none`. Everything is restored exactly on close. iOS Safari ignores `overflow:hidden` for some gestures, so the element also prevents `touchmove` on the backdrop (non-passive listener scoped to the dialog only).
- **Swipe dismiss.** Pointer events on embedder-owned regions only (handle, header, footer): events inside the island never reach the parent. The sheet follows the finger along its dismiss axis (down for bottom; toward its edge for side, mirrored in RTL). It closes if the drag passes 30% of the sheet's extent or the release velocity exceeds 0.5 px/ms; otherwise it snaps back. A drag that starts on a scrollable panel area only begins once that area is scrolled to its start.
- **visualViewport / keyboard.** While open, the element listens to `visualViewport` `resize`/`scroll` and sets `--_vv-bottom` (layout viewport height − (`offsetTop` + `height`)) and `--_vv-height`. The bottom sheet translates up by `--_vv-bottom` and limits its height to `--_vv-height`, so an on-screen keyboard (opened by embedder slot inputs; islands have no text inputs) never covers it. If the embedder opted into `navigator.virtualKeyboard.overlaysContent`, `env(keyboard-inset-height)` is honored. The element never sets that page-global itself.
- **Reduced motion.** Under `prefers-reduced-motion: reduce`, there are no slide or fade transitions. The sheet appears and disappears instantly, and drag follows the finger but snaps without animation. Otherwise transitions are ≤200 ms (`transform`/`opacity` only), using `@starting-style` where available and dodo `withPresence` for exit timing.
- **Initial focus.** If opened by keyboard, the island: `switcherFrame.focus()`. On its window `focus` event, the island moves focus to its first control (the current-account card or "Show my account", which exists in every state) **only if `document.activeElement === document.body`**, meaning a programmatic frame focus with no inner target. Shift+Tab entry, pointer clicks and returning from another app keep their own focus target (EIR-6). All island `focus()` calls use `preventScroll:true`. If opened by pointer, the panel itself (`tabindex=-1`). In sheet mode, the close button first in tab order.
- **Mode switch while open** (rotation, resize): close and reopen in the other mode. The island stays mounted because the element is not re-parented. Focus returns to the embedder element it was on, or to the island's first control if it was inside the island (the exact inner control is not restored).
- **Island close watcher (EIR-7).** The island creates a `CloseWatcher` only during an activation, and destroys it when its `IntersectionObserver` reports not intersecting (the closed dialog is `display:none`) or on window `blur`. If browser evidence shows the parent modal dialog receives close requests while focus is in the frame, the island watcher is dropped.
- **Moves.** Elements implement `connectedMoveCallback`, so `moveBefore` relocations by frameworks keep islands mounted. Ordinary remove-and-insert still remounts (EIR-10).

## 10. Events

### 10.1 Rules

- **Self-contained elements (user correction).** Each element listens to its own islands' ports (validated per §4) and to the controller (`<bindle-session>`) events, and exposes its own events. It composes, debounces and dedupes for itself. Two elements may each fire an event for the same underlying transition, under different names. There is no global single-event guarantee and no `<bindle-session>` fan-out of island messages.
- **Translation, not forwarding.** Elements never re-dispatch raw port data. They build new detail objects (frozen) from validated fields and controller state.
- **Entitlement.** Detail contains only app-entitled data: `{issuer, subject, grantedFragments, profile?}` of sessions the app holds through its own exchange, generic outcomes and codes from `flowCodes`, and UI facts of the element itself (open/closed, reason). Never labels, avatars, account counts, binding presence, island errors, leader status or other islands' data. An island `select{subject}` is surfaced only if the controller's app-session store holds a live session for that subject. Otherwise the element emits a failure without the subject.
- **Shape.** `CustomEvent`, `bubbles:true`, `composed:true` (phase-1 rule), not cancelable.
- **Ordering.** Per element, events dispatch in transition order (`-start` before `-end`, `-select` before `-change`/`-change-failed`). An element's derived event is dispatched in a **microtask after** the source controller event finishes dispatching. A document listener therefore sees `bindle-session-change` before `bindle-account-change` for the same transition, and nested dispatch cannot reorder them. No ordering is promised between different elements beyond that.
- **Late listeners.** Every element has a read-only `state` that is updated **before** the corresponding event is dispatched, so a listener added later reads the latest value. Events are not replayed. `<bindle-session>` keeps its phase-1 initial `bindle-session-change` on connect and its `ready` promise.

### 10.2 Catalogue

| Element | Event | Detail | When / composition |
| --- | --- | --- | --- |
| `<bindle-session>` | `bindle-session-change` (unchanged) | `session \| null` | Fires on connect, then after the app credential for the new current session is ready (any source: island `code` or `select`, app popup, redirect), on sign-out, on expiry. Deduped by `(issuer, subject, credential generation)`. |
| | `bindle-flow-start`, `bindle-flow-end`, `bindle-flow-state`, `bindle-error` (unchanged) | as phase 1, plus `source: 'island'\|'app'` (additive) | Island-started flows register with the controller via the island's `flow{started}`. `flow-end` for a failed island selection: `{intent:'select-account', outcome:'canceled', code:'no-session'\|'network-error'}`. |
| `<bindle-account>` | `bindle-menu-toggle` (extended) | `{open, reason}` where `reason` is `trigger\|escape\|outside\|focus\|select\|action\|session\|navigation\|mode\|disconnect` | Deduped by `open`. |
| | `bindle-account-select` (new) | `{subject}` | The user picked a connected account in this element's switcher island, and the controller holds that subject. Fired once per `select` message; repeats within 500 ms for the same subject are deduped. |
| | `bindle-account-change` (new) | `{previous: subject\|null, session: session\|null, cause: 'sign-in'\|'switch'\|'sign-out'\|'expired'}` | After the controller's `bindle-session-change` when the current `(issuer, subject)` differs from the last value this element reported. The controller never publishes an intermediate `null` during a switch: it keeps the previous session current until the new credential is ready or failure is declared (EIR-17, with a test). |
| | `bindle-account-change-failed` (new) | `{code: 'no-session'\|'exchange-failed'\|'network-error'\|'canceled'}` | A selection or switch started from this element ended without a new ready credential. The current session is unchanged. |
| `<bindle-sign-in>` | `bindle-sign-in-start` (new) | `{source: 'island'\|'form'}` | Island `flow{started}` or form submission from this element. |
| | `bindle-sign-in-end` (new) | `{outcome, code?, session?}` | `completed` only after the app credential is ready (`session` included); otherwise `canceled\|unavailable\|popup-blocked\|discovery-error\|network-error`. One per start. |
| | `bindle-login-request`, `bindle-email-fallback` (unchanged) | as phase 1 | |
| `<bindle-avatar>` (new) | none | — | Purely presentational. |

### 10.3 `state` snapshots

| Element | `state` |
| --- | --- |
| `<bindle-session>` | Unchanged string `signed-out\|pending\|signed-in` (phase-1 compatible), plus `session`. |
| `<bindle-account>` | `{status: 'signed-out'\|'signed-in'\|'changing', session, open, mode: 'popover'\|'sheet'\|null, islands: 'off'\|'mounting'\|'live'\|'fallback'}` |
| `<bindle-sign-in>` | `{status: 'idle'\|'pending', islands: 'off'\|'mounting'\|'live'\|'fallback', last: {outcome, code?}\|null}` |
| `<bindle-avatar>` | `{islands: 'off'\|'mounting'\|'live'\|'fallback'}` |

`islands` reflects only what the element itself observed (handshake success or fallback), never anything the island knows.

## 11. Degradation

| Condition | Detected by | Behaviour | Reported to the app |
| --- | --- | --- | --- |
| Provider does not advertise the islands profile, non-3sln provider, or `islands="off"` | Element | Phase-1 rendering (monogram, granted label, `role=menu` popup, built-in `switch`/`manage`) | `state.islands = 'off'` |
| Handshake timeout (blocked by embedder CSP `frame-src`, `frame-ancestors` refusal, offline, very old engine) | Element (3 s) | Remove the iframe; render the element fallback in the same box | `'fallback'` |
| Embedder adds `sandbox` or `credentialless`, or changes `src`/`name`/`allow` | Element (`MutationObserver`) | Tear down; fallback | `'fallback'` |
| Sandboxed anyway (for example, the whole app runs in a sandboxed frame) | Island (adaptive §10.1) | Island renders the static UI plus "Open example.org" (noopener tab). Flow controls post `flow{ended, unavailable}` | generic `unavailable` on use only |
| Opener unavailable (popup blocked, app `COOP: same-origin`) | Island | `flow{ended, popup-blocked\|unavailable}`; the element shows its notice with **Continue at example.org** (app-opened popup, app credentials only) and **Continue in this tab** | `bindle-sign-in-end` / `bindle-flow-end` outcome |
| No embed credential for the current subject, evicted storage (ITP 7-day, cleared site data), revoked binding | Island only | `avatar`: subject monogram (§6.4). `account-switcher`: "Show my account at example.org" in the card, plus any other bindings it holds. Nothing reported. | Nothing |
| Storage blocked or ephemeral (`credentialless`, private mode) | Island | In-memory key; bindings last for the page life (adaptive §6.1) | Nothing |
| Web Locks or BroadcastChannel missing | Island | Each island is its own leader (§5.4) | Nothing |
| JavaScript disabled or element undefined | — | Light-DOM fallback content (phase 1 §9.2) | — |

**Clear UI rule.** The element fallback shows only app-granted data (subject monogram, granted handle or name, or "Signed in · example.org") and a "Manage at example.org" link. Island-side neutral states show a short, plain message and a single provider action, never a spinner that waits forever. Neither side shows an error that depends on account state.

## 12. Element API changes

### 12.1 New and changed attributes and properties

| Element | Addition | Notes |
| --- | --- | --- |
| `<bindle-session>` | `islands="auto\|off"` (default **`off`** in the current major, EI-14) | `auto` mounts islands only when the issuer's manifest advertises the 3sln islands profile. |
| | `embed-origin="https://embed.3sln.me"` | Optional early-mount hint that skips discovery latency. It is verified against the manifest when discovery completes, and on mismatch every island is torn down. The embedder already controls its own page, so the hint grants nothing it could not do itself. |
| `<bindle-account>` | `trigger="avatar-label\|avatar"`, `sheet="auto\|always\|never"`, `sheet-breakpoint`, `placement="auto\|bottom-sheet\|start-sheet\|end-sheet"`, `density="regular\|compact"`; `state` | `actions` is unchanged (`switch`/`manage` map into the island when live) |
| `<bindle-sign-in>` | `island="auto\|off"`; `state` | When the default provider advertises the profile, the island button is the primary control and the handle form moves behind "Use a different provider". After discovery of another provider that advertises the profile, a provider-specific sign-in island appears, which needs a second click inside it. |
| `<bindle-avatar>` (new) | `size`, `--bindle-avatar-size` | Shows the app's current subject: island when live, otherwise `<bindle-monogram>` |

### 12.2 Signed-out state

The `signed-out` slot default becomes the `#sign-in` island when live, otherwise the phase-1 button. Every island sign-in yields the app's own code over the port (adaptive §7.4–7.5). The controller validates it with the callback validator against its pending record (`prepare` state).

### 12.3 Discovery and the embed origin

The embed origin comes only from the issuer's manifest, as data of the 3sln islands profile (§20 lists the needed manifest member). Without it, no island mounts.

### 12.4 Packaging

The island glue (`elements/islands.mjs`: mount, handshake, port validation) and the popover/sheet code (`elements/panel.mjs`) are **dynamically imported** only when the profile is advertised, so `define.mjs` does not grow (it is already over its 18 KiB budget at about 24 KiB). The shared schema and validators (`packages/sdk/src/embed-protocol.mjs`) are imported by both the SDK and the island bundle. `theme-probe.mjs` re-exports `validateThemeTokens` from there, which keeps its API compatible.

## 13. Security analysis

### 13.1 Size and layout leaks

- No island ever posts its size, and no element measures island content. Iframe sizes come from element attributes, CSS custom properties, the viewport, or the sheet mode: embedder-side facts only.
- Switcher: fixed row height; the list region always has the scroll height of 8 rows (padded with inert, invisible rows), `overscroll-behavior: contain` on the list and the root, and a constant scrollbar. More than 8 bindings shows "More at example.org" in the last row. Scroll chaining, wheel latching and scrollbar presence are therefore identical for 0–8 bindings (*needs browser evidence*, EE-05).
- Labels wrap to at most two lines within fixed rows, then truncate, with the full text in the accessible name.
- **Focus scrolling (EIR-5).** The island root is `overflow:hidden`, only its internal list scrolls, and every island `focus()` uses `preventScroll:true`. The element never makes the panel scroll the iframe. The panel is a grid whose island row is `min(fixed height, available block size − the minimum of the other rows)`, an embedder-side computation, and only the embedder-slot region scrolls. So no focus inside the island can scroll an embedder-owned scroller.
- **Text scaling (EIR-15).** The element multiplies island sizes by the embedder's root font-size ratio (`parseFloat(getComputedStyle(documentElement).fontSize) / 16`), an embedder-side fact. That keeps the WCAG 1.4.4 behaviour of the surrounding page without any content-derived size.
- `contentWindow.length` is always 0 (no nested frames), with one document load and no `location.hash` writes or reloads.

### 13.2 Timing leaks

- `ready` comes before any storage access, leader election or credentialed request, with constant work.
- **Shared event loop (EIR-3).** Same-origin islands in one tab share an agent and event loop, and on Android Chrome (and Firefox without Fission) cross-site frames often share the embedder's renderer main thread. So all state-dependent work runs in each island's dedicated worker (EI-13). The document applies snapshots to a constant DOM with constant work, and `session` changes cause no work. Residual: worker CPU and memory contention remain browser-wide side channels. I7 adds main-thread contention probes on Android Chrome (probe island `load`→`ready` latency, `requestAnimationFrame` jitter) for 0 and 8 bindings.
- Avatar and data arrive after `load` and are not observable cross-origin.
- Island focus moves only in response to user activation inside the island, or to a programmatic parent focus with no inner target (§9.4). In that case it always goes to a control that exists in every state.
- Restores are serial and padded (adaptive §6.3). A follower renders the leader's snapshot. Neither is observable by the embedder.
- Accepted residuals: flow duration and outcomes (adaptive §8.2); network or CPU contention from avatar fetches (browser-wide, out of scope).

### 13.3 Theme and prop injection

There is no free text. Tokens are canonical hex, enums or small integers, validated twice (element and island). CSS text is built only from canonical values. Trust elements use a fixed palette. `forced-colors` ignores tokens.

Islands accept **only the color tokens and `radius`** (radius is clamped and cannot change row count or control visibility). They ignore `font`, `font-scale`, `density` (the `density` prop replaces it) and `color-scheme` (the `scheme` message, `cs` in `name` and the iframe's `color-scheme` all carry the element's single resolved scheme, and `scheme` wins), so no token affects layout (EIR-12). The island contrast matrix is derived from every foreground/background pair used in `parts.css`, including `text-muted`, `danger`, `accent` and `border` on `surface-raised`, and a test enforces it. This prevents invisible-text attacks such as a faint "Remove".

### 13.4 Clickjacking on interactive islands

- `frame-ancestors` is limited to the client's redirect-URI origins and checks the whole ancestor chain.
- **Pointer** activation arms 400 ms after the island becomes visible (an `IntersectionObserver` with an implicit root observes the top-level viewport from a cross-origin frame), and re-arms after any visibility change, `resize` of the island window, or (where IntersectionObserver v2 `trackVisibility` exists, Chromium only, ≥100 ms delay) occlusion or opacity changes. It needs `pointerdown` and `click` on the same armed control. Disarmed controls look visibly inactive, so quick clicks are not silently swallowed. **Keyboard activation is not gated**, because an embedder cannot synthesize trusted key events (EIR-13).
- IntersectionObserver v1 cannot see `opacity:0`, filters or overlays applied through `::part()` in Firefox and WebKit. That is acceptable only because no island click grants new authority (next point).
- No island click grants authority on its own: flows end in a top-level provider popup or the FedCM dialog, each with its own activation delay. `select` switches among sessions the app already holds, which the app could do itself. "Remove from this site" needs a second confirmation control. Its position is fixed and therefore predictable, so a two-click lure can work; the residual impact is limited to the user losing their own local binding (recoverable with one sign-in click).
- Accepted residual: an embedder can hide or overlay islands and spoof their appearance. Users verify identity only in top-level provider pages (EE-20).

### 13.5 Leader-election attacks and races

Only provider code on the embed origin can reach the lock, bus or IndexedDB. Races and their handling are in §5.3: term fencing, `resign` before release, heartbeat-driven steal by visible followers only, no session transfer over the bus, and per-credential server caps.

### 13.6 Threats

| ID | Threat | Mitigation |
| --- | --- | --- |
| EI-T1 | Embedder reads island content | Same-origin policy; no data messages; §7 |
| EI-T2 | Embedder infers account state from size, timing, focus or messages | §13.1–13.2; part-specific constant messages |
| EI-T3 | Embedder drives actions | No inbound action messages; activation inside the island required; §4.3 |
| EI-T4 | Clickjacking | §13.4 |
| EI-T5 | Theme or prop injection | §13.3 |
| EI-T6 | Avatar hotlinking or exfiltration | Bearer-only, Fetch Metadata gates, CORP same-origin, no CORS, `no-store`; leader-only fetch |
| EI-T7 | Two leaders or stale data after failover | Web Locks exclusivity, terms, `resign`, steal fencing |
| EI-T8 | Script injection on the embed origin | Adaptive T2: `script-src 'self'`, Trusted Types, no embedder markup, raster-only re-encoded avatars as fetch-only API responses |
| EI-T9 | Spoofed island messages | Port authenticated by `targetOrigin`; nonce; exact schemas; part-type allowlist; violation teardown |
| EI-T10 | Focus trap escape | Modal dialog containment; Tab from the island lands back in the dialog; browser-chrome escape is allowed by modal semantics |

## 14. Accessibility

### 14.1 Focus across the iframe boundary

- Sequential focus navigation crosses iframes natively: Tab from the last control in the island moves to the next focusable after the iframe in the parent, and Shift+Tab mirrors that. The panel order is close (sheet) → `menu-header` slot → switcher island → actions list → `panel-footer`.
- Inside the switcher island, the account list is a **single Tab stop** with a roving `tabindex` and wrapping arrow keys, followed by the fixed action buttons. So the number of Tab presses through the island is constant for 0–8 bindings (EIR-5). In fallback mode, the `role=menu` group keeps phase-1 arrow, Home/End and type-ahead behaviour. Arrows never cross the boundary (§4.4).
- Escape anywhere closes and returns focus to the trigger (`escape` message from the island).
- The avatar iframe is `aria-hidden` and `tabindex=-1`. The switcher and sign-in iframes have a localized `title` (the frame's accessible name), and the island document sets `lang` and `dir`.

### 14.2 Labels and semantics

- Trigger: `button`, `aria-haspopup="dialog"`, `aria-expanded`, `aria-controls="panel"`, and accessible name "Account: <app-granted label>". The panel is a `dialog` labelled "Account", non-modal in popover mode and modal in sheet mode. In island mode the actions are a `role=list` of buttons and links in Tab order (disclosure pattern); `role=menu` is kept only in fallback mode.
- `<bindle-avatar>`: the host has `role="img"` with an app-granted label ("Account picture: <granted name>", or "Account picture"), or `aria-hidden` when `decorative` is set. The iframe is always `aria-hidden`.
- Inside the switcher island: a list of buttons, the current account with `aria-current="true"`, the provider host announced in the card, and "app.example can't see this list" as fixed text.
- Flow announcements use the element's `role=status` region (phase-1 strings).
- 44 px targets, visible focus with the `focus` token at ≥3:1, `forced-colors` support, and no loss of the distinguishing handle at 200% zoom. The switcher card wraps two lines within fixed rows, and the sign-in island width comes from the per-locale table.
- Release evidence: keyboard, VoiceOver/Safari (macOS and iOS), NVDA/Firefox and TalkBack/Chrome passes over popover, sheet and fallback modes.

## 15. Localization, light/dark and theming

- Locale: element `lang` → ancestor `lang` → `navigator.languages`, resolved by `createSdkLocalization`. It travels in `name` (`l=`) for pre-handshake text and in the `locale` message. Islands load `/embed/assets/i18n/<locale>.<hash>.js` (a new `packages/i18n/embed-catalogue.mjs`), en/es first.
- Light/dark: the `theme` attribute (inherits from `<bindle-session>`) gives the scheme. `cs=` in `name`, the iframe's `color-scheme`, and the `scheme` message carry it. On a `prefers-color-scheme` change, elements resend `scheme` and `theme` (incremented `seq`).
- Tokens: the same public `--bindle-*` names as phase 1, so one declaration themes the element and its islands.

## 16. Performance

- **Preconnect.** Integration docs recommend `<link rel="preconnect" href="https://embed.3sln.me">`. Elements never modify `<head>`. The `embed-origin` hint (§12.1) lets the avatar mount in parallel with manifest discovery.
- **Budgets (compressed):** shell ≤2 KiB; document runtime (dodo core, the ngin `Engine`, channel, validation, arming) ≤12 KiB; island worker (leader, bus, stream, key use, avatar) ≤8 KiB; part modules lazily imported: `avatar` ≤3 KiB, `sign-in` ≤4 KiB, `account-switcher` ≤8 KiB; locale catalogue ≤3 KiB. Embedder side: `islands.mjs` ≤4 KiB and `panel.mjs` ≤5 KiB, both lazy.
- **Boot cost per island** (targets for evidence, warm cache): one shell revalidation (or zero with the service worker), zero asset fetches, script start to `ready` ≤50 ms on a mid-range phone, and JS heap ≤3 MB per island. Same-site islands in one tab share a renderer process in Chromium site isolation.
- **Island count.** A typical page has 2–3 (avatar, switcher, optionally sign-in). The switcher mounts on intent. Only the leader holds a stream.
- **Stack in islands.** dodo `reconcile` renders parts. An ngin `Engine` provides `port` (MessagePort channel), `worker` (a proxy to the island worker, which owns the leader, BroadcastChannel, IndexedDB keys and the DPoP embed client; flows that need a popup open it synchronously in the document's click handler and then hand the window to the bridge) and `theme`. Queries: `IslandView` (snapshot filtered by `subject`), `Theme`, `Locale`. Actions: `StartFlow` (opens the popup synchronously in the click, then continues), `SelectAccount`, `RemoveBinding`, `Forget`. `withPresence` from `@3sln/dodo/animate` handles island-internal transitions with reduced-motion handling. Embedder bundles do not include ngin.

## 17. Future: portal modules as islands (sketch only)

Provider portal modules such as **Publications** could become parts (`#publications`) with the same shell, channel and leader:

- The client registers the parts it may frame. The user grants a module through ordinary consent (a fragment grant), never inside the island.
- Data comes from the leader's embed session, limited to that module's grant. Content is display-only with fixed or embedder-set sizes and padded lists.
- Outbound messages are module-specific and entitlement-checked (for example `open{ref}` only for references the app already holds through its grants). Actions escalate to top-level provider pages.
- User-authored content in modules needs a separate content-safety review (sanitization, no active content on the embed origin, possibly a separate sandboxed origin) before any design.

This needs its own design and review. Nothing here commits to it.

## 18. Browser evidence required

`:target` skeleton and `color-scheme` propagation into frames; transparent iframe backdrop with matching `color-scheme`; `window.name` readability and clearing; partitioned service worker registration in Firefox and WebKit third-party frames; Web Locks `steal` and lock release on bfcache entry and on freeze; BroadcastChannel `Blob` transfer; focus events in the parent when focus moves between two cross-origin iframes; `CloseWatcher` in frames; popover light dismiss with iframes inside and outside the popover; `<dialog popover>` toggled to `showModal()`; scroll chaining with padded lists; iOS scroll lock and visualViewport behaviour; IntersectionObserver visibility from cross-origin frames; avatar `decode()` behaviour; COEP embedder compatibility.

## 19. Implementation breakdown (non-overlapping ownership)

| Slice | Owns (write) | Depends on |
| --- | --- | --- |
| I1 Embed protocol | `packages/sdk/src/embed-protocol.mjs` (part allowlist, `name` grammar, message schemas, plain-data check, last-value-wins rules, theme validator and `monogramPattern` moved here), re-export edits in `packages/sdk/src/elements/theme-probe.mjs` and `elements/monogram.mjs`, `packages/sdk/test/embed-protocol.test.mjs` | none; first, because it fixes the interface |
| I2 Island runtime | `apps/embed/shell.html`, `apps/embed/src/{boot,channel,arming,trusted-types}.mjs`, `apps/embed/src/worker/{index,leader,bus,stream,avatar}.mjs`, `apps/embed/sw.js`, `apps/embed/styles/shell.css` | I1; A5's key store and restore (`apps/embed/src/{keys,restore,bridge,sandbox}.mjs` stay with A5) |
| I3 Parts | `apps/embed/src/parts/{avatar,account-switcher,sign-in}.mjs`, `apps/embed/styles/parts.css`, `packages/i18n/embed-catalogue.mjs` | I1, I2; A5 bridge for flows |
| I4 Server routes | `packages/federation/embed-islands.mjs` (shell with per-client CSP and ETag, parts registry, avatar re-encode and serve, event stream, session end with oldest-eviction caps), the vendored WASM image codec with provenance, `apps/embed/testing/mock-api.mjs` (test-only, never routed by the Worker or Node apps, per AGENTS.md), `tests/embed-islands.test.mjs`; one route hunk each in `packages/runtime/http.mjs`, `apps/worker`, `apps/node` (coordinator-assigned) | **A2** (app sessions, embed bindings), **A3** (entry `delivery`/`embedJkt`, claim), A5 `embed-api.mjs` session checks; the authorization-entry/app-session slice now being built |
| I5 SDK elements | `packages/sdk/src/elements/{account,sign-in,session,index}.mjs` (changes; `index.mjs` registers `<bindle-avatar>`), `packages/sdk/src/define.mjs`, new `elements/{avatar,islands,panel}.mjs`, `packages/sdk/test/elements-islands.test.mjs` | I1; A6 `embed-controller.mjs` (multi-session store, `prepare`, code validation) |
| I6 Catalogues | additions to `packages/i18n/sdk-catalogue.mjs`; any `packages/i18n/catalogues.mjs` index hunk for `embed-catalogue.mjs` (coordinator-assigned, since that file is shared) | none |
| I7 Browser evidence | `tests/browser/embed-islands.mjs` (size, load, focus and timing probes; close matrix; sheet; leader failover across tabs; spoofed messages) | I2–I5 |
| I8 Build and docs | `jstools.config.mjs` embed entries (coordinator), `docs/integration.md` islands section | I2, I5 |

Ownership changes needed from adaptive §21: A6 gives `elements/account.mjs` to I5 and renames its `embed-frame.mjs` to `embed-controller.mjs` (no DOM). A5 keeps keys, restore, popup bridge and sandbox under `apps/embed/src/`, and I2/I3 own the rest of `apps/embed/`. Mock-first: I2, I3 and I5 run against `apps/embed/testing/mock-api.mjs` (owned by I4) until A2/A3 land.

Evidence before completion: `npm test`; DOM tests showing no state-dependent messages, attributes or sizes; real Chromium, Firefox and WebKit (desktop and mobile emulation plus one real iOS and one real Android device) with third-party cookies blocked, cleared storage, private windows, sandboxed or credentialless frames, embedder `COEP`, RTL, 200% zoom, reduced motion, forced colors, and a multi-tab leader kill/freeze test.

## 20. Changes needed in other documents (coordinator)

- **adaptive-app-sign-in.md:** §13.4 Origin gate fix (require `Origin` only when present or for non-GET; EIR-1); §6.1 "ready after storage access" becomes "ready before storage access" and key/storage work moves to the island worker (EIR-3); §6.3 the 4-session cap evicts the oldest; §6.1 URL becomes `/embed?client=<id>#<part>` with the nonce in `name`, and "the frame" becomes islands; §6.2 messages are split per part (§4.3–4.4 here), and `ready` gains `part`; §6.3 restore is leader-only with bus fan-out; §13.1 frame scope is split across `avatar` and `account-switcher`; T2 allows fetch-only, re-encoded raster avatar responses on the embed origin (or the avatar moves to another host and loses the CORP same-origin property); §21 ownership as in §19; §14 confirms the manifest member naming (`embed_profiles_supported` in the doc vs `embed_binding_profiles_supported` in DEVLOG).
- **security.md (reference-host section):** "`/embed/v1/*`" becomes the `/embed` shell plus `/embed/assets/*`, `/embed/api/*` and `/embed/sw.js`; add island rules (part allowlist, fixed or embedder-set sizes, no state-dependent messages, avatar CORP same-origin / no CORS / `no-store`, partitioned service worker never caching API responses); add verification items (size/timing/focus probes, popover close matrix, leader failover, avatar hotlinking refusal).
- **spec (auth/protocol):** no UI rules. The 3sln islands profile needs a manifest location for its embed origin (for example `embed_profiles: {"<profile URI>": {"origin": "https://embed.3sln.me"}}`), or the profile document defines it.
- **embeddable-elements.md:** mark the superseded sections listed at the top of this document.
- **DEVLOG.md:** an entry for this design and review, with an unsigned sign-off line.

## 21. Open questions for the user

- **Q1** Should the `<bindle-account>` trigger default stay avatar + label (phase-1 compatible) or become avatar-only?
- **Q2** Is inbound `forget` acceptable as the one state-reducing exception to "the embedder never commands", or should app sign-out rely only on server revocation plus `session{null}`?
- **Q3** Islands ship opt-in (`islands="off"` default) until a semver-major release, because island mode replaces phase-1 `role=menu` with a disclosure dialog and moves `switch`/`manage` into the island. Accept, or switch the default now while still pre-1.0?
- **Q4** Is a default sheet breakpoint of 600 px acceptable?

## 22. Breaking changes to phase-1 elements (island mode only)

Fallback and `islands="off"` keep phase-1 behaviour exactly. In island mode:

1. `<bindle-account>`: `aria-haspopup` changes from `menu` to `dialog`, `aria-controls` from `menu` to `panel`, and `role=menu` with roving menuitems becomes a list of buttons and links in Tab order. Tab no longer closes the panel; focus leaving it does.
2. `::part(menu)` names the actions list inside a top-layer `<dialog>`; embedder CSS that positioned the old absolutely positioned menu no longer applies (use `::part(panel)`).
3. The `switch` and `manage` actions render inside the switcher island, and embedder CSS cannot reach them.
4. `<bindle-sign-in>` shows the island button first and moves the handle form behind "Use a different provider" (`island="off"` opts out).
5. The 60 s teardown of embeddable-elements §8.3 is dropped, and `show-provider-accounts` (designed, never implemented) is replaced by `islands`.
6. Additive only: new events (§10.2), `reason` on `bindle-menu-toggle`, `source` on flow events, `state` on non-session elements, `<bindle-avatar>`, and new parts and attributes. `<bindle-session>.state` stays a string.

## 23. Review reconciliation

Independent review: [embed-islands-review](../release/embed-islands-review.md), 18 findings (3 High, 8 Medium, 7 Low, no Blocker). No human sign-off is implied.

| Finding | Resolution |
| --- | --- |
| EIR-1 (H) embed API `Origin` gate rejects same-origin GETs | `Origin` required only when present or for non-GET; test; adaptive §13.4 change listed (§6.2, §20) |
| EIR-2 (H) CSP breaks the service worker and likely FedCM | `trusted-types bindle-embed` with a script-URL-only policy; `Service-Worker-Allowed: /embed`; no `respondWith` for the API; `connect-src` includes the issuer (§3.1, §3.3) |
| EIR-3 (H) shared event loop and main thread leak inventory | Dedicated worker for all state work; constant DOM; `ready` before storage; `session` changes cause no work; Android contention probes (EI-13, §3.4, §4.3, §13.2) |
| EIR-4 (M) bfcache as a binding oracle | Same `pagehide` teardown in every state; leader persists with zero bindings; `notRestoredReasons` test (§5.3) |
| EIR-5 (M) focus scrolling and Tab-stop count | Single Tab stop list, always-present "More" row, `preventScroll`, root `overflow:hidden`, panel never scrolls the iframe (§13.1, §14.1) |
| EIR-6 (M) initial-focus heuristic | Redirect only when `activeElement === body` (§9.4) |
| EIR-7 (M) stale island `CloseWatcher` | Destroyed on not-intersecting and on blur; dropped if the parent watcher suffices (§9.4) |
| EIR-8 (M) rate-limit drops `session{null}` | Last-value-wins state messages; `session`/`forget` never limited (§4.2) |
| EIR-9 (M) lost bus messages, cap exhaustion, `forget` scope | Credentials generation in IndexedDB; receiver deletes directly; oldest-eviction caps; `forget{subject?}` (§4.3, §5) |
| EIR-10 (M) popover edge cases | Trigger as invoker; fixed mode-switch order; coarse-pointer catcher; close when anchor hidden and focus outside; `connectedMoveCallback` (§9) |
| EIR-11 (M) ARIA mixing and automatic breaking changes | Disclosure pattern without `role=menu` in island mode; status announcement instead of `aria-busy`; `<bindle-avatar>` role; islands opt-in until major (EI-14, §8.1, §14, §22) |
| EIR-12 (L) layout-affecting tokens, missing contrast pairs, scheme sources | Islands accept only colors and `radius`; contrast matrix from `parts.css`; `scheme` wins (§13.3) |
| EIR-13 (L) arming scope | Pointer-only arming at 400 ms with a visible disarmed state; residuals stated (§13.4) |
| EIR-14 (L) element filtering is not a boundary | Island-side entitlement invariant (§4.4) |
| EIR-15 (L) text scaling | Sizes scaled by the embedder's root font-size ratio; two-line wrap (§13.1) |
| EIR-16 (L) COEP/CORP and cache staleness | Headers always sent; isolated embedders get plain-mode flows; offline-only 24 h fallback (§3.1, §3.3) |
| EIR-17 (L) transient `null` | Controller never publishes an intermediate `null` (§10.2) |
| EIR-18 (L) ownership and interface gaps | Owners assigned; WASM codec in I4; `hello` carries the bucket; mock API test-only (§5.2, §19) |

Still open: everything in §18 needs real-browser evidence, plus Android main-thread contention measurements, `CloseWatcher` routing in frames and FedCM `connect-src` behaviour.
