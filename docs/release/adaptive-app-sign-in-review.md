# Adaptive app sign-in: independent review

Date: 2026-10-14. Target: [adaptive-app-sign-in](../architecture/adaptive-app-sign-in.md) (provisional), plus the proposed edits in [auth](../spec/auth.md) ("Presentation, transports and key binding", "Token lifetime and client sessions"), [protocol §2](../spec/protocol.md#2-discovery-and-login) and the [security](../spec/security.md#reference-host-presentation-and-framing-3slnme-policy) reference-host section. Lens: browser security and OAuth. Cross-read: embeddable-elements §6–8 and its review, multi-account sessions (implemented section) and its review, federation-implementation, `packages/sdk/src/flows.mjs` and `identity.mjs`.

This is a design review. Nothing is implemented, so nothing here is implementation or browser evidence. Claims I checked against current documentation are marked *checked*; claims I could not check are marked *needs browser evidence*.

**No human sign-off is implied by this review.**

| Reviewer | Date | Outcome |
| --- | --- | --- |
| ___ | ___ | ___ |

## What is sound

- Every transport converges on one single-use code bound to the entry, PKCE S256, state and issuer. FedCM returns a code, not an access token, and the SDK validates the FedCM token text with the callback validator. This is the right shape for preventing injection (§7.6).
- Dropping CHIPS, SameSite=None session cookies and the Storage Access API for the frame removes the EE-01/EE-06 class of problems. Embed APIs that read no cookies are easy to reason about.
- The B2 "polling rendezvous" rejection is correct: an attacker-created entry carrying the attacker's `embedJkt` would let the attacker claim the victim's approval. Keeping the code on the redirect URI (B1) holds OAuth's browser binding.
- The COOP analysis for B2 agrees with HTML's rules (*checked in outline, needs per-engine evidence*): a popup's initial `about:blank`, created by a cross-origin iframe, has `unsafe-none`. A `same-origin` response therefore mismatches and switches browsing context group. An app top level with `COOP: same-origin` severs popups that its cross-origin frames open.
- FedCM facts *checked* against the Chrome IdP guide: the accounts endpoint gets only SameSite=None cookies, with no `client_id`, `Origin` or `Referer`. The assertion request carries `Origin` and needs credentialed CORS with an exact ACAO. `continue_on` is resolved against the assertion endpoint. `Sec-Fetch-Dest: webidentity` is mandatory on accounts, assertion and disconnect. `Set-Login` is accepted from same-site subresources (Chrome 122+).
- Refresh persistence is gated on DPoP plus rotation and reuse detection, and the app session is the unit of revocation. Both are sound directions.

## Findings

**AS-R1 (blocker): the embed frame cannot keep data confidential from the app.** The app chooses `embedJkt`: it is an entry extension the SDK fills from the frame's `ready{jkt}`. Nothing attests that the key lives in a provider frame. The §10.4 gates (`Sec-Fetch-Site`, `Origin`, `X-Bindle-Embed`) are browser CSRF defences, and a non-browser client sets them freely. Attack: the app's server creates the entry with the thumbprint of its own key, exchanges the code, then calls `/embed/api/nonce` and `/embed/api/session` with forged headers and a valid DPoP proof. It receives the "provider-verified labels the app may not have been granted" (AS-9, §10.1), such as handle, display name and badge, for every connected account. This contradicts user direction 2 ("UI the embedder must not read") as applied to data. **Fix:**
- State that the frame protects **rendering integrity and provider-controlled interaction**, not data confidentiality from the client.
- The embed session returns only fields the client's grants already disclose. Alternatively, add an explicit consent line ("app.example will see your handle and name") so that showing labels counts as disclosure.
- Name `embedJkt` as client-asserted in auth.md.
- Reword AS-9, §10.1, §10.2 and T8.

**AS-R2 (high): app XSS can mint persistent credentials bound to an exportable key, so the T5 and auth.md rationale overstates DPoP.** The server cannot verify `extractable:false`. Injected script on the app origin is not bound by the SDK's "active mode only" rule. Attack: it creates an entry with its own exportable `dpopJkt` and `embedJkt` and its own PKCE pair, then calls `navigator.credentials.get({identity:…})` in **passive mode with `mediation:'optional'`**. A returning user with one approved account is auto-reauthenticated without a click (`is_auto_selected=true`). Because a live connection exists, §7.5 mints a code at once. The attacker exchanges it and carries a 30-day refresh family off the page. The same works with one hijacked click through the popup. **Fix:**
- When `is_auto_selected=true`, issue memory-profile credentials only: no persistent refresh, no embed token.
- Require server DPoP nonces at the token endpoint and RPC, so proofs cannot be pre-computed.
- Cap live app sessions per owner and client (for example 3), and surface new app sessions in the console with their creation time.
- Rewrite T5 and the auth.md rationale: storage-only theft yields nothing, but XSS can re-mint until it is removed and the session is revoked.

**AS-R3 (high): `/fedcm/login` and `/fedcm/continue` contradict the FedCM cookie rules.** §7.4 says every `/fedcm/*` handler rejects requests without `Sec-Fetch-Dest: webidentity`, but `login_url` and `continue_on` are top-level documents (`Sec-Fetch-Dest: document`). Because they live under `Path=/fedcm/`, the SameSite=None FedCM cookie rides on **cross-site top-level navigations** to them from any site, for example `https://3sln.me/fedcm/continue?entry=…&account=…`. If either page treats that cookie as authority, any site can drive it. If neither does, the design does not say how the continuation page authenticates (Strict cookies are not sent on a browser-initiated cross-site navigation). **Fix:**
- Move document routes outside the cookie path (for example `/authorize/fedcm/login` and `/authorize/fedcm/continue`).
- Make them static entry documents that authenticate with Strict per-account cookies through same-origin fetches.
- Bind continuation to the entry's already-bound owner plus a one-time continuation secret, and mint the code only into `IdentityProvider.resolve`.
- Never read the FedCM cookie on a non-`webidentity` request.
- *Needs browser evidence:* whether `COOP: same-origin` on the continuation page breaks `IdentityProvider.resolve`.

**AS-R4 (high, gated on B2): the B2 claim bypasses redirect-URI binding.** The embed frame is provider code hosted on every registered client's site. Attack: a hostile registered client `evil` frames `/embed/v1/session?client_id=evil`. It creates an `embed-popup` entry for **victim-app's** `client_id` using its own PKCE and the frame's `jkt`, and passes it in over the port. The user sees victim-app's consent (one click for an approved client). The frame claims the code with its key and forwards it to `evil`, which redeems it with its verifier and receives victim-app tokens. §11.3 states no client check. Separately, `COOP: unsafe-none` gives the opener frame same-origin DOM access to the consent page, so any frame compromise becomes a consent click. **Fix:**
- `/embed/api/claim` requires `entry.client_id ===` the frame document's `client_id` and `presentation:'embed-popup'`.
- The code is bound to delivery `embed` and to that client.
- Serve the embed from a separate origin (AS-R5), so the opener holds only a cross-origin WindowProxy.
- Otherwise keep B1 only (Q4).

**AS-R5 (medium-high): the embed document shares the console's origin.** Every registered embedder now feeds input to a `3sln.me` document: port messages, theme tokens, opaque tokens, entry IDs, and the `#t=` fragment. Any bug there is console-origin XSS, and §16 T2 ("adds no new privilege") misses that this is new attack surface. Worse, the frame opens `about:blank`, a provider-origin **top-level** document it can script until it navigates. A compromised frame could use that document to run first-party fetches, which would carry Strict cookies, and possibly to reach first-party storage (*needs browser evidence* for the storage key of a popup's initial `about:blank` opened from a partitioned frame). **Fix:**
- Host the frame and `/embed/api/*` on a dedicated origin with no cookies (for example `https://embed.3sln.me`, or a separate site). Keep the per-client `frame-ancestors`.
- Because the entry already exists in B1, open the popup directly at the authorize URL with `window.open(url,'_blank','popup,noopener')`, without a scriptable blank document.
- Keep the key database per origin, per `(issuer, client_id)` object store.

**AS-R6 (medium): R1 fails for sessions that predate the FedCM cookie or have lost it.** The FedCM cookie is written only on install and remove paths. Users signed in before deployment, or whose FedCM cookie has expired or been cleared while Strict members live, get an empty accounts list. Login Status then makes active mode open `login_url`, which "opens the normal first-party sign-in", so the user faces a fresh login. The FedCM cookie holds at most 5 members while the vault enumerates up to 8. **Fix:**
- `/authorize/fedcm/login` detects live members through Strict fetches and offers "Continue as …". That click reinstalls the FedCM cookie, sends `Set-Login: logged-in` and calls `IdentityProvider.close()`.
- Also install the cookie lazily on first-party `GET /api/session`.
- Align the bounds.
- Add an R1 test that starts from a pre-existing session with no FedCM cookie.

**AS-R7 (medium): the phase-1 SDK's FedCM fallback can reject instead of falling back.** In `flows.mjs` `#begin`, the `{outcome:'unavailable'}` path re-enters with `skipTransports`, and the popup branch then **rejects with `NotAllowedError`** when `navigator.userActivation.isActive` is false. FedCM can fail late: the well-known, config and accounts fetches run first, and Chrome applies a dismissal cooldown. By then the activation can be consumed or expired, so a user without FedCM in practice gets an error rather than the redirect that R1 depends on. **Fix:** when the fallback runs without activation, go to redirect (or show a re-armed "Continue" button). Map cooldown errors to fallback, not `canceled`. Test with Chrome FedCM disabled, in cooldown and with a slow accounts endpoint.

**AS-R8 (medium): frame-initiated FedCM is internally contradictory.** §10.1 routes "Use another account", "Add account" and other controls to "the FedCM flow through the app (by `flow-started`)". But §4.4 refuses to rely on activation propagating from frame to parent, FedCM active mode needs activation in the app document, and `flow-started` is deliberately identical for every control, so the app cannot know which intent to run. **Fix:**
- Frame controls always use B1 popups on entries the app pre-created per intent. FedCM runs only from the app's own buttons.
- The SDK must listen on the state-derived BroadcastChannel for **every** pre-created entry. Today `#relay` accepts only flows started by `#begin`, and `BindleClient` keeps one pending record (EE-08).

**AS-R9 (medium): B1 lets the parent aim the frame's popup at any entry.** The frame navigates to `authorize?entry=<entryId>` for whatever entry ID the parent sent. The code still goes to the entry's registered callback, so no tokens leak. But a parent can make "Review access" inside the provider frame open another client's consent, or a different intent than the label shows. That is phishing that uses the frame's provider look. **Fix:** the frame appends `embed_client=<its client_id>&embed_intent=<control>`, and the provider refuses mismatches with the entry. This is the EE-06 check, restated for B1.

**AS-R10 (medium): persistent rotation turns ordinary races into revocations.** With tokens shared across tabs, a tab killed mid-refresh (close, mobile freeze, network drop) leaves an uncertain outcome. The next use of the old token then revokes the app session **and** its embed binding. A tab that refreshes from a stale in-memory copy does the same. The design states "writes the new token before releasing the lock" but not "re-read under the lock". **Fix:**
- Inside the lock, re-read IndexedDB and refresh only if the stored token equals the one in hand.
- Server side: accept the immediately previous token once, within a short window (≈30 s), with the same DPoP key and only if the successor is unused, and return the same successor. Keep reuse detection otherwise.
- Note that `identity.mjs` currently rejects `refresh_expires_in > 28800`, which must change for the 30-day profile.

**AS-R11 (low-medium): revoking on a wrong key punishes honest eviction and enables denial of service.** §6.5 revokes a binding when its token arrives with a valid proof from a different key. The fragment fallback (§6.4) presents the token before any `jkt` check, so after eviction the frame's new key revokes the user's own binding. Races (two tabs, `forget` in one tab) do the same. Anyone who sees a leaked token can also kill the binding. **Fix:** reject wrong-key uses without revoking (rate-limit them and record a security event). Either drop the fragment path, or carry `jkt` in the fragment and have the frame present the token only on a match.

**AS-R12 (low): partition edge cases and factual corrections.**
- (a) `<iframe credentialless>` gives an IndexedDB that works but is **ephemeral**, so §6.1 step 4 would report `ephemeral:false`. Detect it with `window.credentialless`.
- (b) WebKit keys storage by top origin (the doc's own §4.1), so sibling subdomains do not share a key in Safari. §15 should say restore fails there, with one-click recovery.
- (c) §4.1 says the Storage Access API "un-partitions only cookies". That is outdated for Chromium: SAA's non-cookie extension (`requestStorageAccess({indexedDB, BroadcastChannel,…})`, which returns a `StorageAccessHandle`) has shipped. MDN marks it limited availability; *checked* to exist, Chrome version *needs confirmation*. Chrome 131 also auto-grants SAA after a FedCM connection (*checked*). The decision not to use SAA can stand, because it is Chromium-only and hands an embedded frame unpartitioned state, but the premise that "no browser channel bridges partitions" must be corrected.
- (d) `ready{jkt}` is a stable per-partition identifier, sent before consent, that survives the app's own `Clear-Site-Data`. Document it, and have SDK sign-out always send `forget`.

**AS-R13 (low): UI-redress claims exceed what browsers provide.** Outside Chromium IntersectionObserver v2, a frame cannot detect opacity, overlays or being moved inside the parent, so "re-armed after any resize or move" is achievable only for resize. A transparent frame can still harvest a click on "Remove from this site" (denial of service only) or on popup launchers (the popup's own 600 ms arming then applies). **Fix:** state these limits in §10.3. Make "Remove" a two-step in-frame confirmation whose second control is placed differently. Keep consent out of the frame (already the case).

**AS-R14 (low): the embed token can outlive the app's own session.** A memory-profile app loses its tokens on reload, but a stored embed token still restores, so the frame shows "signed in as X" while the app is signed out. **Fix:** the SDK persists embed tokens only under the persistent profile, or sends `restore` only while it holds a live app session for that subject. Cap embed binding lifetime at the refresh family's absolute expiry (8 h for memory).

**AS-R15 (info): FedCM cookie authority is understated.** "Presenting it anywhere except `/fedcm/*` authenticates nothing" is true, but at `/fedcm/assert` a copied cookie plus forged `Origin` and `Sec-Fetch-Dest` (non-browser) mints codes, without a click, for every member's already-approved clients, using entries the attacker created. That authority is lower than a session cookie's, but not nil. **Fix:** classify the FedCM cookie as session-class in §7.4 and in security.md. Rotate its secret on every install, and include it in the cleanup and revocation paths.

**AS-R16 (info): R1 path check.**
- FedCM: works for returning users who have the FedCM cookie. AS-R6 covers migration and loss, AS-R7 fallback.
- Popup after the static entry document: Strict cookies on same-origin fetches from a provider top-level document that a cross-site navigation reached is consistent with RFC 6265bis (*needs browser evidence in WebKit*). Under Safari ITP and Firefox bounce-tracking protection, the provider is a redirect hop, but user clicks in the popup count as interaction (*needs evidence*).
- B1 from the frame: one frame click plus "Continue as". Its BroadcastChannel relay is valid because callback page and app tab share the app's first-party partition. It needs AS-R8's SDK listener.
- Embed restore: zero clicks, subject to AS-R11 and AS-R14.

## Recommendation

Do not sign off yet. AS-R1 changes a stated user requirement, so the user must accept the reframing: the frame guarantees rendering integrity, not data secrecy from the app. Alternatively, labels become granted data. Resolve AS-R2, AS-R3 and AS-R5 before slices A3, A5 and A6 start, and fold AS-R6 to AS-R10 into those slices' tests. Keep B2 deferred, and adopt it only with AS-R4's client check and a separate embed origin. Record the outcomes in §20 of the design and in DEVLOG.md. This review is provisional and implies no reviewer, date or outcome sign-off.

## Author response (2026-10-14)

All findings were addressed in the design; see the reconciliation table in [adaptive app sign-in §20](../architecture/adaptive-app-sign-in.md#20-review-reconciliation). AS-R1 was accepted as stated: the frame now claims provider-rendered integrity, not confidentiality from the client, and real confidentiality is an open user question (Q5). B2 stays deferred. The browser evidence items above remain open. No sign-off is implied.

### Author response, revision 2 (2026-10-14)

User decision on AS-R1: the provider frame, not the app, creates the entry and opens the sign-in window; the embed credential is delivered only to the frame by `opener.postMessage` with `targetOrigin` = the embed origin, after an opener-key handshake. Confidentiality from the app is again a requirement. The earlier response's acceptance of "integrity only" is withdrawn. See [design §7–§10 and §23](../architecture/adaptive-app-sign-in.md#23-review-reconciliation). Round 2 below re-attacks the revised binding, delivery and COOP change.

## Round 2 review (2026-10-14)

Target: [adaptive-app-sign-in](../architecture/adaptive-app-sign-in.md) revision 2 (§6.2, §7–§11.3), the "Provider-operated components" bullet in [auth](../spec/auth.md) and the 3sln "Popups" bullet in [security](../spec/security.md). Lens: browser security and OAuth. This is a fresh, independent design review. Nothing is implemented, so nothing here is implementation or browser evidence.

Browser facts *checked* against the WHATWG HTML Standard (living, fetched 2026-10-14):
- A new popup's initial `about:blank` copies the top-level opener policy only "if creator's origin is same origin with creator's relevant settings object's top-level origin". A cross-origin frame's popup therefore starts with `unsafe-none`.
- For an initial `about:blank`, the popup COOP rules apply. `unsafe-none` → `same-origin` does not match, so the browsing context group switches and the opener is lost. `unsafe-none` → `unsafe-none` keeps the opener.
- The rules for choosing a navigable set `noopener` when the opener policy is `same-origin` (or `same-origin-plus-COEP`) and the opening document's origin "is not same origin with … top-level origin". See AS-R2-2.
- `document.domain` setter: the sandboxed `document.domain` flag check throws before the origin-keyed agent cluster early return. So the §10 probe holds at spec level even under `Origin-Agent-Cluster` and Chrome's origin-keyed default.
- Form submission: step 1 is "If form cannot navigate, then return". An element other than `a` "cannot navigate" if it is not connected. See AS-R2-3.
- FedCM spec (*checked*): connected accounts are keyed by (embedder = top-level origin, rp, idp, account), so frame connections stay separate per app. The well-known skip rule compares the config host to the RP's registrable domain, which holds for `3sln.me` against `embed.3sln.me`. `mediation:"required"` excludes auto-reauthentication. `is_auto_selected` is sent to the assertion endpoint.
- *Still needs browser evidence:*
  - per-engine COOP behaviour;
  - which origin the FedCM dialog names for a framed RP;
  - FedCM embargo keying;
  - Android site-isolation coverage for a COOP-less provider document;
  - iOS opener retention.

### What is sound

- **Binding.** No app obtains an embed credential bound to its own key through the paths I tried:
  - The app opens the sign-in URL itself: the hello is dropped by `targetOrigin`.
  - The app navigates itself, or an app-origin iframe, to an embed document after opening the popup: the new document holds no popup handle.
  - The app navigates, replaces or duplicates the frame (same partition, same key): only the document that called `window.open` matches `event.source`.
  - A hostile client frames the real frame with another client's inputs: `client_id` comes from the frame URL, and `frame-ancestors` is per client.
  - Non-browser entries carrying a victim's thumbprint: the thumbprint is public data, the server trusts it only after a proof over a single-use, entry-bound challenge, and the frame signs only for its own pending entry.
  - `window.name`: unnamed popups give no name lookup.
- **COOP analysis.** §9's mechanics are correct for the frame's popup (spec-checked above), and `same-origin-allow-popups` on the app keeps the opener.
- **Credential custody.** The embed credential never transits the app or a redirect on the happy path.
- **Code and grants.** The code stays bound to PKCE, `state` and `redirect_uri`. Auto-selected FedCM yields no embed credential.

### Findings

**AS-R2-1 (medium-high): anyone can select the COOP-less authorization document.** The server picks `unsafe-none` from `entry.delivery`, and §7.1 says anybody can create an `embed-popup` entry. Attack:
- Any site (or a hostile client) creates an `embed-popup` entry from its server, using its own PKCE and any thumbprint, for its own or another client's public parameters.
- It opens `https://3sln.me/oauth/authorize?entry=E` with `window.open` and keeps the handle.
- The handshake fails, but §7.3 step 6 then "continues as an ordinary authorization" **in that same COOP-less document**. The attacker now holds a live WindowProxy to a provider chooser and consent page.
- With that handle it can do reverse tabnabbing (`popup.location = lookalike` after the user engages), observe `closed`, frame-count and navigation timing, and share a browsing context group with the provider page.

So security.md's "one exception … for popups opened by the embed frame" is not what the server enforces. **Fix:**
- In plain mode, the COOP-less document must render no account state. It calls `location.replace('/oauth/authorize?entry=E')` to a `COOP: same-origin` document, and that browsing context group switch severs any opener.
- Only an attested document may call the decision endpoint for `embed-popup` entries.
- Keep the handshake timeout constant.
- Reword the security.md bullet to "entries with `delivery: embed-popup`, which degrade to the COOP page unless attested".

**AS-R2-2 (medium): an app with top-level `COOP: same-origin` makes `window.open` return `null` while the popup still opens.** By the noopener rule above, the frame's `window.open` is forced to noopener. It returns `null`, yet a provider window opens at `authorize?entry=E` with no opener. The frame reports `popup-blocked`. The app may then start its own redirect while the user completes the plain-mode popup, which gives two concurrent flows and a code for a `state` the SDK may already have discarded. §9's "may still be severed (*needs evidence*)" is in fact spec-determined. **Fix:**
- Report `null` as `unavailable` (ambiguous), not `popup-blocked`.
- The SDK keeps the pending record for that `state` until callback or expiry, and accepts the plain-mode callback relay.
- Integration docs state that `same-origin` disables the frame and recommend `same-origin-allow-popups`. Q5 is then a product choice, not an evidence gap.

**AS-R2-3 (medium, functional): the §10.2 form probe always reports "sandboxed".** A detached form "cannot navigate", so `requestSubmit()` returns before any sandbox check and never fires `submit`. Every popup would refuse. **Fix:**
- Drop the probe. `document.domain` plus `origin === 'null'` covers every sandboxed document, because every sandbox sets the `document.domain` flag.
- If a second signal is wanted, use a **connected**, hidden form with `preventDefault` in the listener.
- Note that a Permissions-Policy `document-domain` denial, where supported, also throws. That is a fail-closed false positive the embedder can cause anyway.
- State that sandbox detection is a UX guard, not a security boundary: a sandboxed popup without `allow-same-origin` sends `Origin: null` and `Sec-Fetch-Site: cross-site`, and the server already refuses those.

**AS-R2-4 (medium): the fallback "discards" a credential that the exchange then activates.** In §7.4 the popup posts `credential` before the acknowledgement. Without an acknowledgement it redirects to the callback with the **paired** code, and §7.4/§11.4 activate the paired credential when that code is exchanged. The text's "remains inactive" is false. The credential may also already sit in an embed-origin document that did not acknowledge it (a replaced frame). That is not exfiltration, because the key is still required, but the invariant is wrong. **Fix:**
- The decision returns `{code, state, iss, claim}`, where `claim` is a single-use ≤60 s handle and never a credential.
- The frame redeems the claim at `/embed/api/claim` with a DPoP proof whose `jkt` equals `entry.embedJkt`, and only then receives the credential.
- An unredeemed claim mints nothing, so the fallback cannot activate anything.
- The credential then never transits the popup or `postMessage`.

**AS-R2-5 (low-medium): attestation scope and message checks are underspecified.**
- §7.3 marks the entry attested "for this popup document's interaction", but nothing binds a later decision POST to that document. Any first-party tab that knows `E` (from history, extensions or sync) and holds the user's cookie would receive the credential. **Fix:** `embed-verify` returns a per-document secret kept in memory, and the decision POST requires it.
- Entry IDs must be ≥128-bit random. Entry creation must not be idempotent on `state` or `challenge`, and no API may look an entry up by them.
- The frame applies the hello checks (`source` is its own handle, provider `origin`, its own pending `entry`, exact schema) to `done` as well, and acknowledges only to `event.source`.

**AS-R2-6 (low): delivery to the frame's parent is origin-level, not URI-level.** The §7.5 equivalence holds only if the `frame-ancestors` origins equal the origins of registered `redirect_uri`s. A separate "embed origins" list would send codes to origins never vetted as redirect destinations. Path-hosted multi-tenant origins weaken both mechanisms equally. **Fix:**
- Derive `frame-ancestors` from redirect-URI origins.
- The frame forwards `code` only if the init origin equals `origin(entry.redirect_uri)`.
- In auth.md, replace "Providers MUST NOT issue such credentials on authorizations the client started itself", which the server cannot know, with "… unless delivery to the component was attested by a proof of the component's key."

**AS-R2-7 (low): FedCM in the frame.**
- §11.3 uses `mediation:'optional'`, which permits auto-selection and therefore credential-less codes. Use `mediation:'required'` for frame calls.
- The `params` proof has no server nonce. Have entry creation return a single-use nonce and include it in the proof.
- `Origin` and `jkt` checks are sound. A non-browser forging `Origin` lacks the victim's FedCM cookie (session-class per round 1 AS-R15).
- Keep Q4 open: the dialog naming the embed host *needs browser evidence*.

**AS-R2-8 (low): embed-origin and popup hygiene that the attestation argument depends on.** §8 step 3 assumes only the frame's code runs on `embed.3sln.me`. **Fix:**
- Serve every other embed-origin response with `Content-Security-Policy: sandbox` and `nosniff`.
- Never serve SVG or user-influenced content there. Generated badges go to another origin or `data:` URIs.
- The frame refuses to run as a top-level document (`top === self`), which also keeps it out of first-party embed storage.
- In the popup, every link (recovery, email links, "Manage", external sign-in) opens a `noopener` tab. The entry URL never server-redirects.
- Add tests for each of these.
- If the entry has expired at click time, open an **embed-origin** `about:blank`, then navigate it. It stays an initial `about:blank`, so the COOP match still holds, and it is not a provider-origin scriptable document (round 1 AS-R5).

**AS-R2-9 (low): `prepare` inputs and abuse.**
- `prepare.intent` is app-chosen while the frame has several controls. The frame must set intent from the clicked control (round 1 AS-R9 restated).
- A hostile client can send `prepare` 10/s to drain the global entry-creation limit (D9). **Fix:** create entries lazily (visible and hovered, or on click via the blank-then-navigate pattern), and use per-client budgets that cannot exhaust the global budget.

**AS-R2-10 (info): residual signals to the app.**
- `flow` duration reveals one-click versus full sign-in, which contradicts §8.2's "never … whether the user was already signed in". Reword it.
- After `session{subject}`, a user click produces `flow started` only when the frame lacks a binding. That is a 1-bit, user-driven signal that frame storage survived.
- `select` reveals that accounts share a browser, but only on a user pick.
- Accept and document these signals.
- A COOP-less provider document has no Spectre isolation guarantee on Android Chrome (*needs evidence*). It holds codes only transiently, and after AS-R2-4 it holds no credential.

### Recommendation (round 2)

The frame-initiated binding holds against the app, its server and hostile clients. Fix AS-R2-1 before slice A3 (COOP class selection) and AS-R2-4 before slices A3 and A5 (decision response and claim API). Fix AS-R2-2 and AS-R2-3 before browser evidence work. Fold AS-R2-5 to AS-R2-9 into A3, A5 and A6 tests, and record the outcomes in design §23 and DEVLOG.md. This review is provisional.

No human sign-off is implied. Reviewer ___ Date ___ Outcome ___

### Author response, round 2 (2026-10-14)

All round-2 findings are addressed in the design; see the round-2 table in [design §23](../architecture/adaptive-app-sign-in.md#23-review-reconciliation). Notable changes: the popup releases only a key-bound single-use claim (AS-R2-4); the `unsafe-none` page shows nothing before the handshake and otherwise replaces itself with a `COOP: same-origin` plain page (AS-R2-1); the detached-form probe is dropped (AS-R2-3); auth.md now conditions component credentials on attested delivery (AS-R2-6). Browser-evidence items remain open. No sign-off is implied.
