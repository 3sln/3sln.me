# Components profile: independent review

Date: 2026-10-14. Target: [components profile v1](../profiles/components-v1.md) (`https://3sln.me/artefacts/profiles/components/v1`), its [decision note](../architecture/components-profile.md) as on disk 2026-10-14 (it says "revision 2", including §7.1 identity colour and §9.4 monogram audit, added during this review), the [descriptor](../architecture/artefacts/components-profile-v1.json), and the uncommitted edits to [protocol §2](../spec/protocol.md#2-discovery-and-login) and [auth "Presentation, transports and key binding"](../spec/auth.md#presentation-transports-and-key-binding). Lens: interop and browser security. Nothing is implemented, so nothing here is implementation evidence. I cross-read adaptive-app-sign-in, embed-islands, links §6.4, and `packages/sdk/src/*.mjs` and `elements/*.mjs`. Browser claims I could not check are marked **needs browser verification**.

| Reviewer | Date | Outcome |
| --- | --- | --- |
| | | |

## What is sound

- **The core/profile split is mostly right.** Embed origin, shell, channel, parts, sizing, theme tokens, events and `key-binding.v1` are all outside core. Core keeps two generic containers, a bounded processing model ("invalid → absent", unknown ignored, required members fail closed, no cross-issuer mixing, one snapshot per flow) and a short envelope. The `profiles` container is narrow: absolute HTTPS keys, opaque members, and "cannot change core processing". Defaults when absent are stated for every core feature.
- **The floor and the fallback rule fit together.** "Present but below the floor → unsupported, never fallback" and "only a definitive 404/410 permits fallback" close the error-to-other-provider switch. The fallback provider is no longer named in core (D10).
- **`ready.issuer` with one issuer per embed origin is a good defence against provider A pointing at honest provider B's embed origin.** B's island answers `issuer: B`, and the element tears down before sending anything but `init`. A hostile embed origin can lie only about itself. It always answers as the issuer that declared it, which the element already treats as that origin's issuer. The element also re-checks `code.iss` against the pending issuer and uses the snapshot's token endpoint. With an honest B that enforces exact origin checks, A cannot get a B code delivered to A's island: B's popup ends at the app callback or posts only to B's embed origin, and B's FedCM endpoint refuses A's embed origin. So the island path adds no new mix-up vector.
- **Downgrade by stripping is not a security downgrade.** The declaration arrives over HTTPS with no redirects. When islands are absent or degraded, the element falls back to app-started popup or redirect flows that yield only app credentials. An embedder or a third-party script on the page can force a downgrade for the document, for example by mutating the iframe (teardown) or by blocking frames with CSP (timeout). The only cost is the switcher privacy property, and the embedder could get the same result with `islands="off"`. That is acceptable.
- **Sibling islands cannot inject into each other.** The init check (`event.source === window.parent`, exact origin, nonce from `window.name`, then stop listening) defeats a hostile island that posts to `parent.frames[i]`. `window.name` cannot be read cross-origin. Frame-navigation rules stop one island from navigating a sibling. `frame-ancestors` checks every ancestor, so an attacker that frames the app cannot host the island.
- **The inbound surface is minimal.** No inbound message makes the island act, and `code` is released only to the redirect URI origin. C1–C5 are stated as provider obligations.
- **Audit accuracy.** I checked 20 file:line claims in §9.1 and §9.4 against the source (A1 `identity.mjs:313`; A2 `:33`; A3 `:74-75`, `:144-145`, `:158`; A4 `:85-88` and `session.mjs:49`; A6 `flows.mjs:111`; A7 `account.mjs:46`, `:113-119` and `flows.mjs:56-58`; A8/A9 `:312`, `:314`; A10 `:81`, `:151`, `:163`; A11 `account.mjs:117`; A12; A13 `theme-probe.mjs:7-8`; A14 `testing.mjs:22-23`, `:30`; M1–M5). All of them are accurate. Omissions are in CPR-21.
- **§7.1 contrast arithmetic checks out.** OKLCH L 0.93 against L 0.40 gives about 7.4:1, and L 0.36 against L 0.93 gives about 8.8:1. Both match the claimed minimums of 7.3 and 8.7.

## Findings

### CPR-1 (Medium): the decision note claims a review reconciliation that did not exist

The status line says "revision 2 (after independent review, §14)". §14 says "Revision 2 incorporates its findings; the table there maps each finding to the section that resolves it." This file did not exist when that was written, and no table maps findings to sections. AGENTS.md requires review outcomes to be real and unsigned decisions to stay provisional.

**Failure:** DEVLOG or a later reader treats the design as "reviewed and reconciled" with no review on record.

**Fix:**
- Set the status back to revision 1, pending review.
- Once the author has answered these findings, add a real CPR-n → section table in §14 and an "Author response" section here, as in embed-islands-review.
- Leave sign-off blank.

### CPR-2 (High): core forbids the profile's own entry, FedCM and code-delivery paths

Three core rules conflict with the profile:

1. Core auth says the FedCM assertion endpoint "MUST require the browser-set `Origin` to be a registered origin of `client_id`". Profile §9.1 requires `Origin` equal to the embed origin, which is not a registered origin of the client.
2. The core envelope says the code is "delivered only to documents whose origin is the origin of that `redirect_uri`". Yet profile §2.2, §8 and §9.1 deliver it first to the embed origin (`bindle-embed-done`, and the FedCM `token` with the embed origin as RP), which forwards it. Profile §8 step 2 also has the island create entries from the embed origin on behalf of any client, while any sane core entry endpoint checks `Origin` against the client.
3. Protocol §2 says "A profile cannot change core processing."

**Failure:** A third-party provider that follows core literally refuses every island flow. One that relaxes the rules to make islands work is non-conformant, and has no core text bounding the relaxation. The relaxation itself is dangerous: "accept `Origin` = embed origin for any `client_id`" lets any document on the embed origin mint codes for any client. Only the profile's `embedJkt` proof stands between that and abuse, and core does not require that proof.

**Fix (auth envelope, protocol §2 profiles paragraph):**
- Define a *component origin*: an origin declared by a profile in the issuer's own manifest that differs from the issuer and client origins.
- A provider MAY accept authorization-entry creation and FedCM assertions whose `Origin` is its own declared component origin, on behalf of a registered client, only under a profile-defined proof of key possession.
- Codes MAY transit component documents. They are released to client documents only on the `redirect_uri` origin.
- Component origins never receive verifier, tokens or keys.
- Then say "a profile cannot change core processing except through the component-origin rule above".

### CPR-3 (High): part versions are declared but never negotiated at runtime

`parts.<name>.versions` and §12 ("new part versions may be added to v1 declarations") assume a per-part version. But the shell URL carries only `#<part>`, the `name` grammar has no part version, and init and `ready` carry only `part` and the channel `v`. `props` has an exact key set per part.

**Failure:** A provider adds `account-switcher` v2 with a new prop and declares `versions:[1,2]`. A v1 element sends v1 `props`. The island cannot tell which version it is serving: it either rejects the init (exact key set) or renders v2 behaviour that the v1 element does not understand, such as new outbound types that the element counts as violations and then degrades. The additive-versioning promise cannot be kept.

**Fix (§3, §3.1, §5.1, §12, descriptor):**
- Put the selected part version in the shell fragment (`#account-switcher.v1`) and in init (`partVersion`), and echo it in `ready`.
- An island serves exactly that version or stays inert. The element picks the highest common version.
- Exact key sets then apply per `(part, version)`.

### CPR-4 (High): `authorization-entry.v1` has no normative wire, so neither core nor the profile can be implemented by a third party

Protocol §2 registers `authorization-entry.v1`, and its "Meaning" links to auth §Application authorization. That section defines no request body, response (`entryId`), `?entry=` authorization parameter, error shape, CORS policy, origin rule or bounds; audit A10 admits this. Core FedCM, `dpopJkt`, end-session and the capability set all depend on the entry. So do profile `prepare.requests` ("bounded as the core entry schema", a schema that does not exist) and profile §8 step 2. Floor item (3) points to the 3sln runtime wire profile for token-response members (`issuer`, `client_id`, `audience`, `granted_fragments`, `token_type:'Bearer'`), which A9 calls 3sln-only.

**Failure:** A self-hosted or third-party provider cannot build a conforming entry endpoint or token response from the specification, so "work with ANY Bindle provider" holds only for this codebase.

**Fix:**
- Before `authorization-entry.v1` leaves "proposed", write the entry wire (body keys as in `identity.mjs:81`, bounds, the `entryId` grammar `identity.mjs:82`, `?entry=`, errors, required CORS, `Origin` rule per CPR-2) and the core token response into auth.md or federation-implementation (CPS-6).
- Until then, mark the registry row "reserved, wire pending".
- Give floor (3) a core definition of the token response, not a pointer to the 3sln profile.

### CPR-5 (High): unsandboxed islands from any declaring provider can top-navigate the app and use default-allowed powerful features

Profile §3.1 forbids `sandbox`, and `allow` grants only `identity-credentials-get`. Islands mount for any provider that declares the profile once the user picks it (CP-12, Q1 default). The island's whole purpose is to receive clicks.

**Failures:**
- After any click inside a hostile island, it runs `top.location = 'https://app.example.evil/login'`. Browsers block top navigation from cross-origin frames only *without* user activation (**needs browser verification** per engine). The app page is replaced by a lookalike.
- It may also call `alert()`/`confirm()` (still allowed cross-origin in some engines) and trigger downloads.
- Features whose default allowlist is `*` are not disabled by an `allow` attribute that omits them: `storage-access`, `browsing-topics`, `attribution-reporting`, `shared-storage`, `join-ad-interest-group`, `run-ad-auction`, `private-aggregation`, `sync-xhr`. With `requestStorageAccess()`, an island escapes partitioning. Its switcher can then list accounts bound on other sites, which breaks "the app can't see this list / per-site" assumptions and enables cross-site linkage.
- The profile has no provider MUST against any of this, and E1–E6 do not cover it.

**Fix:**
- §3.1: replace "MUST NOT add `sandbox`" with `sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"` (no `allow-top-navigation*`, `allow-modals`, `allow-downloads`, `allow-forms`). This is conditional on browser evidence that FedCM in the frame, partitioned storage, Web Locks and opener-preserving popups still work.
- Adapt the adaptive §10.1 sandbox probe to accept exactly this token set.
- Have the `allow` attribute name `'none'` for every default-`*` feature above.
- Add a P8: islands never navigate any frame other than their own popup, never call `requestStorageAccess`, modal dialogs or downloads, and contain no text inputs.
- Add conformance checks for each.
- If the sandbox evidence fails, keep P8 and make the Q1 default an allowlist.

### CPR-6 (Medium): `fedcm: true` hands a hostile island a FedCM permission for any identity provider

The element delegates `identity-credentials-get` on the strength of `parts.<p>.fedcm` and the provider's own `fedcm.v1`. It cannot restrict which `configURL` the island passes.

**Failure:** A hostile provider's island calls FedCM with a large IdP's config URL. The RP is its embed origin, registered as a client with that IdP. The browser dialog appears over the app's page, and the cross-site iframe case may name the top-level site (**needs browser verification** of the exact dialog text). Users approve, believing they are signing in to the app, and the hostile provider harvests their identity from the other IdP.

**Fix (§2.1, §3.1, E-list):**
- Delegate `identity-credentials-get` only to islands of the configured default provider or an `island-issuers` entry, never to a provider the user merely typed.
- Record the dialog wording as a browser-evidence item.

### CPR-7 (Medium): islands can post arbitrary window messages to the app and its other libraries

Islands are only required to reply on the port. Nothing stops `window.parent.postMessage({...}, '*')`, or `window.top.postMessage`.

**Failure:** Many app-side libraries (OAuth popups, payment widgets, analytics, older versions of this SDK) listen for window `message` events and check only `event.data.type`. A hostile island injects messages shaped like theirs.

**Fix:**
- Add a P rule: an island sends no window messages and uses only the port.
- Add E7: the element registers no window `message` listener for island traffic.
- Have integration.md state that app listeners must check `event.origin` and `event.source` against their own windows.
- Add a conformance check: no window messages under fuzzing.

### CPR-8 (Medium): island data is scoped to the partition, not to the `client_id`

§6 avatar shows the picture "when the island holds an active component binding for" the `session` subject. Account-switcher shows "other accounts the island holds bindings for in this partition". Only `select` is client-scoped, and only `key-binding.v1` keys are per `(issuer, client_id)`. Storage partitions are keyed by top-level **site**.

**Failure:** `tenant-a.saas.example` and `tenant-b.saas.example` are different clients, same site, and not on the PSL. Tenant B's page sends `session{subject: <user's subject from tenant A>}`. Its avatar island then shows the user's real picture, an authenticity lure for a phishing prompt next to it. Its switcher shows tenant A's accounts. Bindings also survive an app's local sign-out without `revoke-on-sign-out`, so an embedder can name stale subjects.

**Fix (§6, §9):**
- Every island read (avatar, switcher rows, restore) is filtered by `(issuer, client_id)` of the shell's `client`, and requires a live component credential.
- `forget` without `subject` affects only that client.

### CPR-9 (Medium): island `prepare` collides with the SDK's single pending transaction

The SDK keeps exactly one pending record per `(client, callback)` (`identity.mjs:95`, `:100`). §8 has the element create a pending record per island `prepare`, without user action. The element also "sends a fresh `prepare` after every flow end", and both `sign-in` and `account-switcher` may be live.

**Failure:**
- The user starts a redirect flow to provider B from the handle form. The switcher island for A then ends a flow, and the automatic re-`prepare` overwrites B's verifier. The B callback fails state validation.
- Two islands overwrite each other's records.
- A hostile island can also send `code` for a state `prepare`d to a different island of the same issuer.

**Fix (§5.3, §8):**
- Pending records are keyed by `state`, with a small cap.
- Island records live in memory only, never in storage, because island codes arrive in the same document.
- A `code` is accepted only on the port that received that `prepare`, and only between `flow{started}` and `flow{ended}`.
- `prepare` is never replaced while a flow is started, and is refreshed before entry expiry.

### CPR-10 (Medium): message bounds are inconsistent, and `prepare` is underspecified

§5.2 caps every message at 2 KiB. But:
- `code` allows a 2048-character code plus `state` and `iss`.
- `session` and `select` allow a 2048-character subject.
- `prepare` carries `redirectUri` (unbounded), `requests` (unbounded, CPR-4), `loginHint` (320 characters) and `uiLocales`.

The JSON size unit (UTF-16 or UTF-8 bytes) is unspecified. `prepare.colorScheme` duplicates `scheme`. `loginHint` and `requests` purpose text are embedder free text, contradicting §5.3 "No embedder free text ever reaches an island".

**Failure:** A conforming element drops a conforming `code`. Two implementations disagree on whether a 1,900-character `prepare` is valid.

**Fix:**
- Measure UTF-8 bytes. Set the cap per type (for example 8 KiB for `prepare` and `code`) or bound each field so the sum fits.
- Bound `redirectUri` to 2048 and `requests` explicitly.
- Drop `prepare.colorScheme`.
- State that the island never renders `prepare` contents and only forwards them to the entry endpoint.

### CPR-11 (Medium): the descriptor is not machine-usable and disagrees with the text

- `channel.inbound.props` is `["…part fields"]`, optional fields are written `"outcome?"`, and no field types, enums or bounds are given for any message.
- `embed_origin`'s pattern accepts `https://1.2.3.4` (the text forbids IP literals), `https://x:443` (rejected by `new URL(v).origin === v`) and `https://a..b`.
- `manage_url` lacks the issuer-origin rule, and `format: uri` is annotation-only in 2020-12.
- The text says invalid part names are ignored, while the schema fails the whole declaration on a bad `propertyNames`.
- `requiresCoreFeature` omits "with the `login` intent".

**Fix:**
- Give real JSON Schemas per message and per `(part, version)` props.
- Align the `embed_origin` pattern with the text, or state that the text is normative and the schema is advisory.
- Make the part-key failure semantics match the text: ignore the part, keep the profile.

### CPR-12 (Medium): logic gaps in capability computation

1. `each flag = flag && !degraded(flag)` runs after derivation. If `entry` degrades (404), `identityless`, `selectAcct`, `fedcm`, `dpop`, `island.signIn` and `island.switcher` stay true unless each is degraded separately. An `issuer` mismatch degrades `profile` but not the `island.*` flags. **Fix:** apply degradation to base inputs (`entry`, `fedcm`, `profile`, each part) and then derive.
2. `dpop = … && entry` is correct only because core puts `dpopJkt` solely in the entry. A floor provider that advertises `dpop_signing_alg_values_supported` without the entry is then a contradiction that the defaults table does not state. **Fix:** either allow `dpop_jkt` on `authorization_request_endpoint` (RFC 9449 §10), or state in protocol §2 that DPoP persistence requires `authorization-entry.v1`.
3. `popup = … && UA can open popups` cannot be decided ahead of time. **Fix:** define it as declared plus `presentation="popup"`; the blocked outcome falls back at runtime (as `flows.mjs:106` already does).
4. Island "Use another account" has an unspecified intent. §2.1 gates the switcher on `login`, while the built-in path uses `select-account`. **Fix:** map each island control to an intent in §6: `select-account` if declared, else `login`. Gate accordingly.

### CPR-13 (Medium): default-provider islands send the provider a request for every page view

E6 exempts the configured default provider. `<bindle-sign-in>` mounts its `#sign-in` island on every signed-out page view. The shell is `Cache-Control: no-cache`, so every view revalidates at the provider with the `client` name and the user's IP. After `ready`, the island may open partitioned storage and make credentialed requests, which yields a stable per-site identifier.

**Failure:** The default provider (3sln.me, or a hostile provider an app picked) learns every visit to every app using it, for users who never sign in. This is not disclosed anywhere.

**Fix (§3, §4, §6, integration.md):**
- A `sign-in` island makes no storage access or network request until a trusted activation.
- Serve the shell from a versioned, `immutable` path, or allow `max-age`, so views do not revalidate.
- Disclose the remaining request in integration.md.
- Revisit the Q1 default with this cost stated.

### CPR-14 (Medium): initials algorithm defects (decision note §7)

1. **The emoji rule is unreachable.** Emoji word segments have `isWordLike: false`, and the fallback splits on `\p{S}`, which contains emoji and regional indicators. So "🦊" and "🇯🇵 Taro" never reach step 4. **Fix:** collect emoji clusters before word filtering, or keep non-word-like segments that match `\p{Extended_Pictographic}` or an RI pair.
2. **The fallback grapheme regex mis-splits.** It splits emoji modifiers (`\p{EMod}` is not `\p{M}`: "👋🏽" becomes "👋"), tag sequences (subdivision flags), and Indic conjuncts ("क्ष" becomes "क्"). Engines on Unicode before and after 15.1 also disagree on conjunct clusters, so the "Devanagari conjuncts" vectors are engine-dependent. The regex contains a literal invisible U+200D. **Fix:** write `\u{200D}`, add `\p{EMod}`, `\p{Emoji_Component}` tags and `\u{FE0F}`, and state the minimum Unicode version or accept either cluster in tests.
3. **Joining scripts render joined.** Arabic two-letter initials ("محمد علي" gives "مع") display as one joined word. **Fix:** for Arabic, Syriac, N'Ko and Mongolian, take one cluster or insert U+200C between clusters.
4. **Georgian `toUpperCase()` yields Mtavruli**, which is unusual for initials. **Fix:** upper-case only Latin, Greek, Cyrillic and Armenian.
5. **Invisible and unbounded clusters.** Default-ignorable or blank letters such as U+3164 (Hangul filler, `\p{Lo}`) or U+115F produce a blank avatar, and a "Zalgo" cluster carries hundreds of marks that overflow the tile. **Fix:** strip `\p{Default_Ignorable_Code_Point}` and known blank letters, cap marks per cluster (base plus 3), and set `overflow: hidden`.
6. **Handle and compatibility forms.** For handles, text after `+` is a tag and should be dropped, not used as a word ("alice+news" gives "AN"). Compatibility ligatures ("ﬁona") survive NFC. **Fix:** drop the plus-tag, and apply NFKC to the extracted clusters only.
7. **Hash input encoding.** §7.1 `fnv1a32(subject)` does not name an encoding, while Appendix A says UTF-16 code units. **Fix:** cite Appendix A.

### CPR-15 (Medium): the island avatar does not match the standard avatar, and the shared hue correlates with the pattern

1. Profile §6 says the avatar island renders the monogram "so its appearance is identical to the element's own fallback". But the element's chain is picture → **initials** → monogram (note §6.2, user direction 5). With `island.avatar`, a user with a granted name and no binding sees a monogram where the standard composition shows initials. That is a visible regression caused by enabling the enhancement. **Fix:** the element always renders its standard avatar, and the island paints transparently (root `color-scheme` per embed-islands §4.1) unless it shows a picture. The app cannot read cross-origin pixels, so nothing leaks (**needs browser verification** of transparent cross-origin frames in each engine).
2. Appendix A uses `index = fnv(s) mod 24`, which is `a mod 24`. `a mod 8` is bits 0–2 of `a`, which are exactly the top-row cells k=0..2. Hue and top row are therefore correlated, which cuts distinct pattern-plus-colour combinations about 8×. **Fix:** use `b mod 24`.
3. Appendix A's "bit `k-16` of `b`" is dead text, because `k ≤ 14`. **Fix:** state that 15 bits of `a` are used.
4. §7.1 step 4 resolves the scheme partly from the `--bindle-surface` luminance, which needs script and is not "live without script". The profile does not require the element to resend `scheme` when `prefers-color-scheme` or the embedder `color-scheme` changes. **Fix:** E-rule: send `scheme` on every change of the resolved scheme, including media-query changes.

### CPR-16 (Medium): `client-id-metadata.v1` is right about pre-registration but underspecified for safety

The claim "no per-provider pre-registration only with `client-id-metadata.v1`" is correct. Without it, the same ID must be registered, or the `clientId(issuer)` mapping used. The safety conditions, however, sit in the decision note, not in core.

1. **Precedence.** A URL `client_id` that is also operator-registered must use the registration, never the fetched document.
2. **Document validation.** Core should state `client_id` equality inside the document, a non-root path, no fragment or query, a size cap, `application/json`, no redirects, and a ≤24 h cache with negative caching.
3. **Request reflection.** `GET <embed_origin>/embed?client=<any https URL>` is unauthenticated and forces the provider to fetch attacker-chosen URLs on public hosts, an amplification and reflection vector. **Fix:** rate-limit per client host, negative-cache failures, and never block the shell on a fetch (serve the inert document and resolve in the background).
4. **Consent labelling.** "Labels the app as unreviewed" is only in the note; core says "labelling still apply". **Fix:** core MUST: for unreviewed metadata clients, show the verified origin as the primary label, and show `client_name` only as unverified text. Profile: a provider MAY serve the inert shell to unreviewed clients, because the sign-in island otherwise lends provider branding to any phishing page.
5. `frame-ancestors` derived from `redirect_uris` reduces to the `client_id` origin, given the same-origin rule. Say so explicitly.

### CPR-17 (Low): core still contains UI and SDK content

- Protocol §2 opens with "This specification defines no user interface", and the same paragraph then says a client "MUST … display the resolved host before continuing". Auth requires consent displays.
- Both core files name "the `@3sln/bindle` default is 3sln.me".

**Fix:**
- Reword to "defines no client presentation beyond the security disclosures it lists" and keep those disclosures.
- Move the SDK default to integration.md.

### CPR-18 (Low): flat OAuth defaults deviate from RFC 8414

Protocol §2 says absent `grant_types_supported` means "`authorization_code` only, no refresh". RFC 8414's default is `["authorization_code","implicit"]`, so generic tooling, the stated reason for keeping names flat, reads it differently. `login_presentation` is listed among "OAuth-registered capabilities" but is not one.

**Fix:**
- Require `grant_types_supported` whenever refresh is offered, and state the deviation explicitly.
- Move `login_presentation` out of that sentence.

### CPR-19 (Low): before verification, the `embed-origin` hint path is unconstrained, and manifest caching bypasses the cap

Profile §11 verifies the hint only "when discovery completes". It does not forbid sending `session`, `prepare` or `forget`, or acting on `code` or `select`, while the hint is unverified. A stale or tampered hint could then receive a subject or PKCE inputs. Separately, `fetch()` uses the browser HTTP cache by default, so a provider `max-age` beyond one hour, or a stale CDN copy, outlives the "capped at one hour" rule.

**Fix:**
- Until the hint is verified, send only init and ignore every outbound message except `ready`.
- Fetch manifests with `cache: 'no-cache'`, or honour the cap explicitly.

### CPR-20 (Low): residual hostile-island UI risks the element cannot see

- A hostile switcher island can trap Tab inside its document and never send `escape`. Key events do not reach the parent, so keyboard users are stuck in the dialog (a WCAG 2.1.2 failure).
- Embedder CSS overlays (opacity, transforms) are invisible to the `MutationObserver`.
- An island can draw app-looking prompts inside its box.

**Fix:**
- P rule: no keyboard traps (Tab past the last control moves focus out with `parent` focus semantics), and no app-imitating or free-form content.
- Islands SHOULD gate activations on IntersectionObserver v2 `trackVisibility` where available.
- The element closes the container when focus leaves it, and offers a close control outside the island.

### CPR-21 (Low): handshake heuristics and audit omissions

- **Handshake timing.** A main-thread long task on the embedder can delay both the 3 s timer and the queued `ready`, and the timer may run first, which sticks a spurious degradation for the document. **Fix:** on timeout, drain one macrotask and accept a `ready` whose `event.timeStamp` is within the window. Also, some engines fire `load` for the initial `about:blank`, which interacts with "first load posts init / second load tears down" (**needs browser verification**). Set `src` before insertion and test.
- **Audit omissions:**
  - `identity.mjs:35` hard-codes `presentation: 'redirect'`.
  - `theme-probe.mjs:14` checks 9 contrast pairs, while profile §7 lists 13 (no `text-muted`/`surface-raised`, `danger`/`surface-raised`, `accent`/`surface-raised` or `border`/`surface-raised`), so element and island revert different token sets. A13 should cover this.
  - The single pending key at `identity.mjs:95` (CPR-9) is not listed.

## Author response (2026-10-14)

All 21 findings were addressed in revision 2 of the [decision note](../architecture/components-profile.md#14-review-reconciliation), the [profile](../profiles/components-v1.md), the [descriptor](../architecture/artefacts/components-profile-v1.json) and targeted edits to protocol §2 and auth. The finding-to-section map is in the decision note §14. Browser-evidence items stay open. This response is the designer's, not a reviewer's re-check, and implies no sign-off.

## Implementation review (SDK slices CPS-1/CPS-2, 2026-10-14)

Independent read-only review (interoperability and browser security) of the uncommitted `packages/sdk` change, its tests, `docs/integration.md` and the SDK build entries. No Blocker; 4 Medium, 7 Low. The implementer fixed the confirmed findings as listed. No human sign-off is implied. Reviewer ___ / date ___ / outcome ___.

| # | Sev | Finding | Resolution |
| --- | --- | --- | --- |
| IR-1 | Medium | `<bindle-sign-in default-host>` validated and announced its own host, but passed the raw text, which the controller re-completed with the session's default host; its "Continue with {host}" button and sign-in island read the session's capabilities, not the named provider's. | **Fixed.** The element passes the complete handle (or `{host}` for identity-optional sign-in) and composes from `capabilitiesFor(<its host>)`, discovering it if needed; `islandPart`/`mountIsland` take that capability set. DOM test with a different element host. |
| IR-2 | Medium | A popup can inherit a copy of the opener's sessionStorage; any unrelated pending record made `handleCallback` report "expired" instead of relaying. | **Fixed.** Only an expired record for the *same* state stops the relay; the waiting tab's single-use check decides. Unit test with a copied stale record. |
| IR-3 | Medium | FedCM treated only `AbortError` as a dismissal; browsers report dismissal as a generic `NetworkError`, which caused a redirect and, twice, a degradation. | **Fixed.** Any rejection after the dialog may have shown is `canceled`; only pre-UI errors fall back; `NotAllowedError` (expired activation) never counts toward degradation. Tests updated (dismissal as `NetworkError`). Real-browser FedCM evidence remains open. |
| IR-4 | Medium | The long refresh lifetime was accepted on the client's own key alone. | **Fixed.** Needs the proven key **and** `refresh_idle_expires_in`; otherwise the 8 h memory limit. Open spec item: auth.md still says bound sessions use `token_type:"DPoP"`, while the coordinator decision is Bearer access + DPoP-bound refresh; reconcile in auth.md and DEVLOG. |
| IR-5 | Low | Parked IndexedDB keys could be orphaned (no sweep; evicted records kept keys). | **Fixed.** Eviction releases keys; the key holder sweeps entries older than 10 minutes when it opens. |
| IR-6 | Low | The transport binding of island/FedCM codes was optional; URL callbacks accepted in-memory records. | **Fixed.** `completeCode` requires `presentation` (`island`/`fedcm`) matching the record; URL callbacks refuse island/FedCM records. Tests added. |
| IR-7 | Low | DPoP nonces cached per issuer, though providers scope them per endpoint purpose. | **Fixed.** Cached per endpoint URL. |
| IR-8 | Low | Interop notes: the reference entry accepts only `redirect|popup` presentations (a `fedcm.v1` declaration would always fall back); a manifest advertising ES256 with entries at `dpop:false` fails every entry; the SDK requires an HTTPS `embed_origin` while local development allows http. | **Recorded** for the server slice (CPS-3) and DEVLOG; no SDK change. |
| IR-9 | Low | Some tests wait with short real-time sleeps. | **Partly addressed.** DOM tests wait on conditions (`until`); the flaky element test now waits on the session event (24/24 green at 8-way parallel load). A few headless waits remain short sleeps on in-process mocks. |
| IR-10 | Low | The package imports `vendor/dodo` and `packages/i18n` from outside `packages/sdk`. | **Recorded** as a publication gate (package stays private). |
| IR-11 | Low | The granted picture loads without `crossorigin`, so it carries the user's issuer cookies (no referrer). | **Recorded**; `crossorigin="anonymous"` needs the provider to send CORS for pictures (profile §6.2 follow-up). |

Also fixed during browser verification, before this review: a DPoP-bound redirect sign-in could not find its parked key on the callback document (key holder not opened there); a transport fallback announced a second `bindle-flow-start`; embedder `color-scheme` changes on root/body/host attributes now re-render (`refreshTheme()` for other changes).
