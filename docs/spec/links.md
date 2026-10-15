# Bindle links — normative draft

Status: **design candidate**. Same-host HTTP routing is implemented locally on the Worker and Node adapters (2026-10-14 links integration; see Implementation status and [integration review](../release/links-integration-review.md)); no SDK, published contract, discovery member or production deployment exists, and nothing is production-verified. Existing signed contact endpoints remain as documented in [contact endpoints](contact-tokens.md). Conditional contact delivery depends on the unimplemented [contact-delivery candidate](contact-delivery.md) author proofs; cross-host audience verification depends on its unimplemented `directory_url` / identity-document profile. Example identifiers under `https://spec.bindle.example/` and hosts under `.example` are placeholders. **User decision (2026-10-14, recorded by the coordinator): no anonymous message is delivered through any link** (§6.1). This supersedes the explicit unverified one-off mode of the contact-delivery candidate, reconciled as superseded/proposed in contact-delivery, its wire note and contact endpoints on 2026-10-14. Developer contact on one conditional link is user-directed; implementation pending. Decision record: [architecture note](../architecture/bindle-links.md); [independent review](../release/bindle-links-review.md). Protocol/security/interop sign-off: reviewer ___ / date ___ / outcome ___.

This document defines observable link syntax, signature profiles, processing rules and HTTP results. It does not define an SDK, rendering, storage layout or condition language. MUST/SHOULD/MAY express draft requirements.

## 1. Terms

- **Link**: an absolute HTTPS URL whose query carries a `bindle_meta` parameter defined here.
- **Owner host**: the origin serving the link path. It issued `bindle_meta` and is its only verifier in this version.
- **Meta**: the `bindle_meta` value, a compact JWS signed by the link owner's locally registered key. It is the capability.
- **Data**: the optional `bindle_data` value, a compact JWS outside the owner's signature, signed by a party the link type defines.
- **Tooling**: any software that reads a link without verifying it (scanners, apps, opener providers, previews).
- **Audience**: for a conditional contact link, the identity that opens the link and attaches a response.

## 2. Recognizing and parsing link parameters

A verifier MUST operate on the raw query string: the bytes after the first `?` and before any `#`. It splits that string on `&` only (`;` is not a separator) into components. A component's name is the text before its first `=`, or the whole component when it has no `=`. Empty components are ignored. Name percent-decoding means WHATWG percent-decode, which leaves invalid sequences such as `%zz` literal. Every route decision is taken only from this one parser: the legacy-versus-new form choice, any routing read of `sub`, and parameter validation. Implementations MUST share one parser module between edge and storage tiers rather than mixing it with `URLSearchParams`.

1. A component is a **Bindle parameter** if its name, after percent-decoding and ASCII lowercasing, begins with `bindle_`.
2. Every Bindle parameter name MUST be literally `bindle_meta` or `bindle_data`: lowercase and unencoded. Any other Bindle parameter (for example `bindle_x`, `Bindle_meta`, `bindle%5Fmeta`) MUST be rejected. Names are reserved for future versions; a verifier never ignores one it does not understand.
3. Each of the two names MUST appear at most once, and each MUST have `=` and a nonempty value. `bindle_data` without `bindle_meta` MUST be rejected.
4. Each value MUST match `^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$` as raw bytes. Percent-encoding, `+`, padding and whitespace are rejected, not decoded. A raw byte value is therefore identical to its decoded value.
5. Length limits for new-form links: `bindle_meta` at most 4,096 characters; `bindle_data` at most 2,048; the complete request target at most 8,192 (a verifier handed an absolute URL MAY apply the limit to the whole URL, which is stricter). Hosts may apply smaller limits. Legacy `sig` links keep their existing bound (§10).
6. A **legacy marker** is any component whose percent-decoded, ASCII-lowercased name is `sig`. A request with both a legacy marker and any Bindle parameter MUST be rejected (see §10).
7. All other components (for example `utm_source`) are **unrelated parameters**. They are never signed, never interpreted, and never reflected into representations, redirects or delivered records. Their presence does not invalidate the link. A host MAY drop them when it scrubs the address bar.
8. Fragments are never Bindle parameters. Bindle values placed only in a fragment are not a link.

Failures in this section are `link_malformed` (§8).

## 3. `bindle_meta`

### 3.1 JWS profile (shared with `bindle_data`)

Both parameters use [JWS](https://www.rfc-editor.org/rfc/rfc7515) compact serialization with three segments in canonical unpadded base64url. Segments with noncanonical trailing bits are rejected. Decoded header and payload MUST be strict UTF-8 [I-JSON](https://www.rfc-editor.org/rfc/rfc7493) objects. Duplicate member names at any depth, unknown members, non-safe integers, non-finite numbers, `-0` and lone surrogates MUST be rejected. Nesting deeper than 8 levels MUST be rejected. `kid` is 1–200 characters without control characters. Both signature algorithms produce exactly 64 signature bytes; any other length is rejected. Headers contain exactly the members given below; `jku`, `jwk`, `x5u`, `x5c`, `crit`, `b64`, `zip` and `cty` are not permitted.

The signature input is the ASCII bytes of the **received** `segment1 "." segment2`. Verifiers MUST NOT re-serialize, canonicalize or reorder JSON before verifying, and MUST NOT accept a different encoding of the same JSON. ES256 signatures are the raw 64-byte `r||s` form ([RFC 7518](https://www.rfc-editor.org/rfc/rfc7518) §3.4); EdDSA follows [RFC 8037](https://www.rfc-editor.org/rfc/rfc8037). `none`, HMAC and embedded or remotely fetched keys are unavailable.

### 3.2 Header and common claims

The meta protected header is exactly `{"alg","kid","typ"}` with `alg` `ES256` or `EdDSA` and `typ` exactly `"bindle-link-meta+jwt"`. `kid` MUST identify an active key that the owner host registered for the link subject. The owner host never resolves a meta key through a remote document, header or the link itself.

Every meta payload contains these common members, plus the exact type-specific set its `type` defines:

| Member | Definition |
| --- | --- |
| `bindle` | Exactly the string `"link-meta"`. Its only purpose is confirming that the parameter is intended for Bindle. |
| `v` | Integer `1`, the envelope version. |
| `type` | Absolute HTTPS URI of at most 256 characters, identifying the link type and its version. |
| `iss` | The owner host's exact origin (`https://host[:port]`). |
| `aud` | The link's **canonical audience**: the exact origin plus path, without query, fragment or userinfo. |
| `jti` | The owner host's identifier for the underlying authority, such as a contact parent grant. |
| `iat`, `exp` | Safe-integer Unix seconds, `iat < exp`. |

`aud` is an HTTPS URL; a host configured for local development MAY issue `http://localhost` origins, which tooling MUST NOT present as verified (§5). `iss` MUST equal the owner host's **configured canonical origin**, never a value derived from a `Host` or forwarded header. The request's own origin MUST equal that origin; otherwise the request fails closed. `aud` MUST equal that origin concatenated with the request path exactly as the WHATWG URL parser serializes it. That parser removes dot segments, including `%2e%2e`. Beyond the parser there is no case folding, trailing-slash or percent-encoding normalization. A host whose proxy rewrites paths fails closed. Because unrelated parameters are excluded from `aud`, adding them never moves or breaks the link. Changing host or path does.

### 3.3 Owner-side validity

A valid meta has: correct grammar and profile; `typ`, `bindle`, `v`, `type` supported at this route; `iss`/`aud` matching; `exp` in the future; a live underlying authority whose **exact stored header and claims** equal the received ones; an active key; and a valid signature. A cryptographically valid signature over claims the host did not issue and store is not valid. An unknown `type` at a route is invalid. It is never downgraded to another type.

## 4. `bindle_data`

The data protected header is exactly `{"alg","kid","typ"}`, with `typ` exactly `"bindle-link-data+jwt"`. The link type defines the permitted algorithms and the key authority. Data is never covered by the owner's meta signature and never expands meta authority.

Every data payload contains:

| Member | Definition |
| --- | --- |
| `bindle` | Exactly `"link-data"`. A meta payload in the data position, or the reverse, fails on `typ` and on `bindle`. |
| `v` | Integer `1`. |
| `type` | Exactly the meta's `type`. |
| `md` | Meta digest: canonical unpadded base64url of SHA-256 over the ASCII bytes of the received meta **signing input** `segment1 "." segment2`. It is 43 characters. The signature segment is excluded, so an ECDSA-malleated signature over the same issued claims yields the same `md`. |
| `aud` | Exactly the meta's `aud`. |
| `iat`, `exp` | Safe-integer Unix seconds. |

`md` binds the response to one exact issued meta header and payload, including `kid`, `jti`, challenge and every claim. A response cannot be moved to another link, another route, a reissued meta or a different key. Link types define any further members. A link type that defines no data MUST reject any `bindle_data` value.

## 5. Tooling (non-verifying readers)

Tooling MAY decode the second segment of either parameter to recognize a link, without verifying it. It MUST treat decoded content as **unverified**. The only identity it may present as the party involved is the origin in `aud`, after checking that `aud` is HTTPS and equals the URL's own origin and path. It MUST NOT present any meta member as attested by anyone other than that origin. It SHOULD NOT automatically dereference URIs found in meta. It MUST NOT treat an unknown `type` as a known one. In this version, tooling cannot verify the owner's signature: link-signing keys have no public discovery profile.

## 6. Contact link type

`type` = `https://spec.bindle.example/links/contact/v1`.

The exact meta payload member set is the common members plus `sub, resource, kinds, collections, mimeTypes, maxMessages, maxBytes, maxMessageBytes`, and optionally `audience` (§7). Most of these carry the definitions, bounds and immutability of the corresponding [signed endpoint](contact-tokens.md) claims: `sub` is the recipient's stable account UUID; `jti` is the parent grant ID; and `aud` is the endpoint URL. Collection and MIME semantics are unchanged. **Delivery tags are not meta members** (user decision, 2026-10-14): automatic and sender-selectable tags are the parent's mutable intake configuration (§6.2), so a meta carrying `requiredTags`, `optionalTags` or any other tag member fails the exact member set. Quota semantics are unchanged except as §7.1 states for conditional links. The new members bind what [contact-delivery](contact-delivery.md#contact-bearer-rpc) requires the signed URL to bind:

- `resource` is the parent-bound contact resource.
- `kinds` is a nonempty, unique, ascending subset of `["conversation-init","one-off"]`.

Authorship is not a member: it is always identity-only (§6.1). The contact-delivery profile/version is implied by `type`. The signed limits, `kinds` and `resource` stay in meta because they bound what a capability holder may do; tags confer no authority on senders and therefore need no signature.

Without `audience`, a contact link offers the GET representations of [contact endpoints](contact-tokens.md): the HTML composer, inspection, and machine bearer minting restricted as in §6.1. It also accepts POST delivery restricted as in §6.1. Beyond those restrictions and the new members, the differences are the parameter name, the unrelated-parameter rule (§2) and the `typ`/magic/type members. An unconditional contact link MUST reject `bindle_data`.

### 6.1 Authored delivery on every link

Every message delivered through any contact link, conditional or not and in either URL form (§10), MUST carry a contact-delivery v1 author proof. The proof's `author` must be an identity whose principal the owner host can resolve and verify as in §7.3. Therefore:

- `author:null`, a missing or invalid proof, or an author the owner host cannot verify is refused (§8). A parent setting cannot re-enable an unverified mode.
- Legacy multipart delivery (`message` plus `collection`/`mimeType`/… fields, with no author proof) is not a link delivery profile. A legacy inbox-bearer request returns 406. A contact-delivery bearer MAY be minted only with `authorship:["identity"]`.
- App messages travel over owner-approved app-connection grants and are admitted by the provider ([app messages](app-messages.md)). They are not link deliveries, so this rule does not govern them and does not change them.

Bearer RPC admission is a link delivery. A message admitted with a contact-delivery bearer minted from a link obeys this section. On a conditional parent, it also obeys §7.5, exactly as URL POST does. Minting a bearer is not gated by data or eligibility. A capability holder can still deliver only as an identity they control. The link authorizes reaching the recipient; the author proof says who is speaking. Until the directory/identity-document profile exists, only authors on the owner's own host are verifiable, so cross-host authors are refused with `author_unverifiable`.

### 6.2 Intake configuration

Every contact parent, in either URL form, has an **intake configuration** stored by the owner host on the parent record (keyed by `jti`). It is not part of any link, signature or `md`:

- `revision`: a nonnegative safe integer, incremented by every update.
- `autoTags`: tag IDs applied to every delivery through the parent (formerly the signed `requiredTags`).
- `optionalTags`: the sender-selectable allowlist (formerly the signed `optionalTags`), each with optional display labels keyed by language tag. Labels are presentation only.

The two lists are disjoint and together hold at most 32 IDs. Both accept user tag IDs and registered final `sys:*` IDs; suspected and unknown or look-alike `sys:` IDs are rejected ([tags](../architecture/tags.md)). Updates are owner-authenticated mutations carrying the expected `revision` (compare-and-swap; a stale revision is `intake_conflict`). An update takes effect for subsequent deliveries. It MUST NOT re-sign the link, change the stored exact header, claims or signing input, change `md`, invalidate outstanding responses, or alter quota and receipt state. Every accepted delivery records the intake revision applied, for provenance and history.

A delivery naming an optional tag that is not in the **current** allowlist is refused with `forbidden_tags` (400), so a client can re-fetch the metadata representation (§6.3) and retry. Auto tags and policy-derived tags (§7.5) are added by the host and are never sender-selected.

**Legacy parents.** A `?sig=` parent's signed `requiredTags`/`optionalTags` seed its intake as revision 0 (`autoTags` and `optionalTags` respectively, with pre-registry `sys:` strings escaped to user tags). The conversion MAY be lazy (computed on read, persisted on first delivery or update); reads never write. From then on intake is authoritative and the signed tag claims are ignored for delivery. A pre-tag-policy parent whose claims carry neither member has no intake until the owner sets one; until then sender tags remain untrusted annotations and add no delivery tags.

**Security note.** Signed tag claims previously proved the owner's intent at creation; the owner's live configuration now does. This is acceptable because tags grant senders nothing: they only feed the owner's own rules. The owner can already change those rules at any time, so an owner-side mutation adds no authority to anyone else. Legacy URLs still carry their original signed tag values, visible to anyone holding the link; only new-form links stop disclosing auto tags.

### 6.3 Sender metadata representation

A consumer learns what a contact link accepts by requesting its metadata representation. It is a `GET` (or `HEAD`) on the link URL with `Accept: application/vnd.bindle.contact-intake+json` and the URL in either form: new form with `bindle_meta` only, or legacy `?sig=`. Unrelated parameters are ignored as in §2. Content negotiation follows the existing contact-endpoint rules ([contact endpoints](contact-tokens.md)): normal Accept specificity and quality, 406 for unsupported representations. `Accept-Language` selects labels. The body is JSON:

| Member | Meaning |
| --- | --- |
| `version` | Integer `1`. |
| `form` | `"link"` or `"legacy"`. |
| `type` | The meta `type` (new form only). |
| `intakeRevision` | The current intake revision, or `null` for a parent with no intake. |
| `optionalTags` | Array of `{id}` or `{id,label}`, in intake order. `label` is the best `Accept-Language` match (exact tag, then primary language, then `en`) and is omitted when none exists. |
| `kinds`, `mimeTypes`, `maxMessageBytes`, `maxMessages`, `maxBytes` | The signed values; a legacy parent reports `kinds:["one-off"]` (§10). |
| `quotaScope` | `"principal-day"` for a conditional link (§7.1), otherwise `"parent"`. |
| `expiresAt` | Parent expiry, in Unix milliseconds. |
| `conditional` | Whether `audience` is present. |
| `policy` | The `audience.policy` URI, when present. |

The representation verifies the link exactly as §8 steps 1–2 do (`link_malformed` / `link_invalid`). It is side-effect free: it consumes no quota and no nonce, creates no row, and never evaluates eligibility. `bindle_data` on this request is `link_malformed` (§7.2). It MUST NOT disclose `autoTags`, policy-derived tags, collection IDs or names, quota usage, or anything about the opener (coordinator decision, 2026-10-14: auto tags are owner-internal organization). Responses are `Cache-Control: no-store` and `Referrer-Policy: no-referrer` with the credentialless CORS of the other public representations (§8). The beaming contact-profile representation (`application/vnd.bindle.contact-profile+json`) is a different, owner-disclosed profile and does not carry intake.

### 6.4 Contact intents and link previews

**Intent URIs (user decision, 2026-10-14).** A contact link MAY be handed to any Bindle-capable handler through an intent URI of the form

`web+bindle://<intent>?contact-url=<contact link>`

- The scheme is `web+bindle`, so both browser-registered web handlers (which accept only `web+` schemes) and native apps can claim it.
- `<intent>` is one of `send-message` (compose and send to that contact without storing it) or `add-contact` (store the link among the user's contacts). Every other intent name is reserved for future versions; a handler MUST refuse an intent it does not understand rather than fall back to another one.
- `contact-url` appears exactly once. Its value is the **canonical** contact link, percent-encoded as a URI component: the link's origin and path plus either `?bindle_meta=<meta>` (new form) or `?sig=<value>` (legacy). It never carries `bindle_data` or unrelated parameters, and a handler MUST reject a value that does.
- Other intent parameters are reserved and MUST be ignored by this version.
- The intent conveys no authority beyond the contact link itself. A handler verifies the link with its owner host exactly as §8 describes before showing anything as verified, and sending still requires an author proof (§6.1).

**Handing an intent to the opener's own provider.** A page that offers these intents MAY also let the viewer name their own provider by handle. The page discovers that provider's manifest exactly as [protocol §2](protocol.md#2-discovery-and-login) specifies (HTTPS, bounded size and time, no cookies, no cross-origin redirects; a server-side fetch additionally obeys the SSRF rules). Only when discovery succeeds **and** the manifest declares the core feature `intents.v1` ([protocol §2](protocol.md#2-discovery-and-login)) listing the intent, with its `login_endpoint` on the issuer origin, may the page navigate top-level to that `login_endpoint` with exactly one added query parameter `bindle_intent` whose value is the percent-encoded intent URI. Otherwise it falls back to the intent links. A discovery failure (network, TLS, CORS, malformed or unsupported manifest, absent declaration) never causes a redirect. Before navigating, the page tells the viewer that the contact link will be sent to that provider.

The receiving provider treats `bindle_intent` as untrusted input. It accepts only a well-formed `web+bindle` intent listed in its `intents.v1` feature, with exactly one HTTPS `contact-url` that is itself a canonical contact link; the whole value is at most 8,192 characters, and nested or recursive intents are rejected. It never acts automatically: after authentication (immediately when already signed in) it shows the matching send-message or add-contact prompt, with explicit account choice where several accounts are signed in. Because the contact capability now reaches that provider's server, the provider applies the same query redaction, `no-store` and `no-referrer` requirements as the owner host ([contact endpoints](contact-tokens.md#url-secrecy-and-browser-handling)). The viewer chose that provider as their handler, which is why this disclosure is acceptable.

**Previews of the default HTML representation.** An owner host MAY decorate the HTML representation of a contact link with machine-readable previews (for example Open Graph tags, a Twitter card and an [oEmbed](https://oembed.com) discovery link). When it does:

- Previews contain only what the link owner chose to disclose for that link (for example a display name and an avatar under the parent's profile permission). A platform that already holds the link may see that disclosure. They never describe an audience or opener, never carry eligibility, and never echo `bindle_data` or unrelated parameters.
- A link that does not verify (malformed, invalid, revoked, expired, quarantined) yields only a generic, non-identifying card.
- Generating a preview is subject to the same guarantees as every GET in §7.4 and §8: it delivers nothing, consumes no quota, nonce or replay row, and creates no state. The HTML and its previews are `noindex, nofollow`, `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.
- An oEmbed response uses type `link` (or `photo` for an owner-disclosed image) only, never `rich` or `video` with HTML.
- Image URLs in previews are derived from the same capability and scoped to it; the host bounds and rate-limits them and never fetches an owner-supplied URL on a crawler's behalf.

Rendering, wording and the host's own handler registration are host matters outside this specification (the reference host documents them in its own [preview note](../architecture/contact-link-previews.md)).

## 7. Audience requirement (conditional contact links)

### 7.1 Meta member

`audience` is exactly `{"challenge"}` or `{"challenge","policy"}`:

- `challenge`: 16 bytes from a CSPRNG, as 22-character canonical base64url. Its presence makes the link **conditional**. The owner host MAY rotate it by issuing a new meta for the same parent. The rotation sets a fresh `iat` and keeps every other claim. It preserves the parent's quota, receipt and intake state and invalidates every outstanding response, because `md` changes and the stored exact claims change. The previous meta stops verifying.
- `policy`: optional HTTPS URI of at most 256 characters. It identifies an eligibility policy that the **owner host operator** registered. The host MUST check at issuance that the URI is in its operator policy registry. A tenant on a shared host MUST NOT define, parameterize or name arbitrary policies, because a policy such as "eligible only if the principal is X" would act as an identity oracle. The URI is for display and audit only and conveys no authority. This spec defines no condition language, and no party other than the owner host evaluates the policy. Whether tenants may issue conditional links at all, using registered policies, is host policy.

**Quota scope.** On a conditional link, the signed `maxMessages` and `maxBytes` apply **per verified author principal per UTC day**, not to the parent's lifetime. `maxMessageBytes` keeps its per-message meaning. Aggregate protection for the parent comes from the host's existing receipt, work and storage budgets, which are unsigned operational guards. Without this rule, one popular parent would exhaust lifetime caps within days, and rotating the challenge would not help, because rotation keeps quotas.

Meta carries no free-text title, description, badge or display-name member. Human-readable explanations come from the owner host's own page and are attributed to its origin.

### 7.2 Response (`bindle_data` for contact v1)

The response proves that the audience identity, through its provider, chose to identify itself to this exact link. Header `alg` is exactly `ES256`, and `kid` is a signing-purpose key of the audience identity. The exact payload members are the common data members (§4) plus:

| Member | Definition |
| --- | --- |
| `iss` | The audience provider's exact issuer origin. |
| `sub` | The audience's stable account UUID at `iss`. The principal is the pair `(iss, sub)`. |
| `handle` | The full public handle `local@host`, with `host` equal to the host of `iss`. It is a routing alias, verified against the principal (§7.3), and never identity on its own. |
| `nonce` | Fresh random value: 16 bytes from a CSPRNG, as 22-character canonical unpadded base64url. A new value is generated for every response, including a re-signature for the same link. |

`kid` is the audience's signing-key identifier exactly as its identity record or document publishes it. It is the same value contact-delivery author descriptors carry as `keyId`. The key found MUST belong to the principal `(iss, sub)`, have signing purpose, be registered as ES256 on P-256, and be currently active.

The data members `iss` and `sub` name the **audience** principal. They are not the meta's `iss`/`sub`, and implementations MUST NOT apply a shared JWT claim validator to both.

**Validity.** `iat` is the mint time and `exp` the expiry; the audience signature covers both, together with `nonce`. The rules are:

- `iat < exp`.
- `exp - iat` MUST be at most **300 seconds**.
- `iat >= meta.iat - 60`.
- With a clock-skew tolerance of **60 seconds**, the owner host accepts only when `iat - 60 <= now < exp + 60`. The maximum acceptance span of a response is therefore 420 seconds.

Responses violating any of these are `audience_stale` (§8). A typed or claimed handle without a valid signature proves nothing.

**Replay record.** The owner host MUST treat each response as single-use for evaluation:

- **What is stored.** Validity (including `now < exp + 60`) is checked before any lookup, so purge timing cannot reopen replay. Only after steps 1–7 of §8 succeed does the host atomically insert `H` into a set scoped to the parent, with an expiry of `exp + 60`. `H` is SHA-256 over: the UTF-8 bytes of `meta.jti`, a `0x00` byte, the UTF-8 bytes of the data `iss`, `0x00`, the UTF-8 bytes of `sub`, `0x00`, and the 16 decoded `nonce` bytes. No row is created before step 7, and none for unverifiable responses. The insert happens before policy evaluation. A response whose `H` is already present is `audience_stale`. A response consumed by an evaluation that then returns `audience_unavailable` stays consumed; the opener obtains a new one.
- **How much.** State is bounded. Rows expire at most 420 seconds after insertion, and expired rows MAY be purged lazily. A host MUST NOT shorten a row's expiry below `exp + 60`; a response whose `exp + 60` exceeds insertion plus 420 seconds is `audience_stale`. Expired-but-unpurged rows MAY count toward the per-parent cap (conservative), but each insertion attempt SHOULD purge more expired rows than it can add, and purging MUST commit even when the attempt is refused. The host enforces limits in this order: per-IP and per-principal rate limits, then a **per-principal live-row cap** (for example 3), then a per-parent live-row cap. The per-parent cap is sized to at least the global evaluation rate limit multiplied by 420 seconds. A principal over its own cap gets `audience_unavailable` for itself only. When the parent cap is reached, the host returns `audience_unavailable` rather than evicting an unexpired row, because eviction would re-enable replay. A provider's response-signing operation (§9) is itself rate-limited per user.
- **Who consumes.** Only a GET of the JSON inspection representation evaluates and consumes a response. `bindle_data` on any other representation or method is `link_malformed` and is never evaluated. That covers HTML, HEAD, bearer minting, the contact-profile representation, OPTIONS and POST. Previews and prefetches therefore cannot burn the nonce. A legitimate opener who loses the race to a replayer sees `audience_stale` and obtains a new response.

The record limits GET pre-check replay only. Delivery never relies on it, and author proofs (§6.1) remain required regardless. Those proofs keep their own operation-ID replay namespace.

**Identity-key signature domains.** In the reference host, one per-account P-256 signing key signs several kinds of object. The audience key signs only responses that its provider constructs from a parsed meta (§9); the provider never signs caller-supplied bytes. Every profile this key signs MUST be separable:

| Signed object | Input form | Separation |
| --- | --- | --- |
| Legacy `contact+jwt`, `bindle-contact-endpoint+jwt`, `bindle-inbox+jwt` (implemented) | JWS input (`eyJ…`) | `typ`, exact stored claims |
| `bindle-link-meta+jwt`, `bindle-link-data+jwt` (this draft) | JWS input | `typ`, `bindle` magic, exact stored claims or `md` |
| Conversation v1 payloads (implemented) | Raw canonical JSON (`{…`), **no domain prefix** | First byte `{` versus `e` |
| Contact-delivery and conversation-v2 proofs (candidates) | `bindle-…-v1\n` / `-v2\n` domain prefix plus JCS | Prefix |

Every JWS profile verified against this key MUST check its exact `typ` before using any claim. Every future non-JWS profile MUST carry a distinct domain prefix. Adding a profile requires updating this table. The unprefixed conversation-v1 form is a legacy exception: new profiles MUST NOT copy it.

### 7.3 Verifying the audience identity

- **Same host** (`iss` equals the owner host's origin): the owner host verifies against its own identity records. `sub` is an active account, `handle` is currently assigned to `sub`, and `kid` is that account's active identity signing key. No directory is needed.
- **Other host**: the owner host MUST resolve the principal through the proposed [directory/identity-document profile](contact-delivery.md#authorship-and-signatures). That means the `iss` manifest, then its same-origin `directory_url?handle=`, then a binding of handle, UUID and issuer, then a signing-purpose key with `kid`, under pinned continuity. **That profile is not implemented.** Until it is, an owner host MUST return `audience_unverifiable` for foreign responses. A verifier MUST NOT accept a key from the response, a JWS header, the opener, or any unauthenticated fetch. Once implemented, foreign resolution is triggered by unauthenticated GETs. It therefore sits behind the [SSRF boundary](security.md#network-and-connector-safety), cached discovery results, and per-issuer and global fetch rate limits applied before any network fetch.

### 7.4 Evaluation at GET

Eligibility is **host policy** of the owner host. It is evaluated on the verified principal and on nothing the audience supplies beyond the principal. Processing order is §8. A GET with a valid response renders or returns an eligible or ineligible state. GET, HEAD, previews and prefetches never deliver, consume quota or record the audience as a contact.

The response is an **eligibility pre-check, not authority**. A completed link URL is replayable within its window by anyone who sees it (logs, history, QR photographs, shoulder-surfing). Possessing one never authorizes delivery as, or on behalf of, the audience.

### 7.5 Delivery

Delivery follows §6.1, like every link. In addition, the owner host evaluates the condition again at admission, on the **author principal** verified as in §7.3, in the same admission step as parent quota checks. The delivery need not be preceded by a GET response and is not linked to one. A delivery request URL MUST NOT contain `bindle_data` (`link_malformed`); clients strip it before POST.

Host policy MAY reuse a bounded, previously recorded decision for the same principal and parent instead of re-deriving it for each message. A positive decision MAY be reused until the end of its UTC day. A negative or lower-tier decision SHOULD be reused for at most 15 minutes, behind per-principal rate limits, so that someone who becomes eligible is not locked out until midnight. The host MAY also enforce per-principal admission limits stricter than the signed per-principal limits (§7.1).

The host MAY attach owner-local organization tags derived from the evaluation, with provenance `policy`. Those tags are part of the message's **authorized delivery tags**: they are valid owner-rule inputs (for example `tagsAll`), alongside the signed required tags and the sender's validated optional tags. They never appear as sender-selected tags, never widen authority and never alter the signed sender document.

## 8. Processing order and results

The owner host evaluates in this order and stops at the first failure.

| Step | Failure result |
| --- | --- |
| 1. §2 grammar, lengths, duplicates, legacy/new conflict | `link_malformed` — 400 |
| 2. Meta profile, `typ`, magic, `v`, `type`, `iss`/`aud`, stored exact claims, key, signature, expiry, revocation | `link_invalid` — 401, uniform for all causes and disclosing no account, parent or collection existence |
| 3. `bindle_data` on a type or link that defines none | `link_malformed` — 400 |
| 4. Conditional link without data | state `audience_required` |
| 5. Data profile, `typ`, magic, `v`, `type`, schema (including `nonce` format), `aud` | `audience_malformed` — 400 |
| 6. `md` mismatch, or validity failure (§7.2) | `audience_stale` |
| 7. Identity resolution, handle binding, key status, signature | `audience_unverifiable` |
| 7a. Replay record (§7.2): duplicate `H` / cap reached | `audience_stale` / `audience_unavailable` |
| 8. Host policy cannot currently decide | `audience_unavailable` — 503 (with `Retry-After` only when a bound is known) |
| 9. Host policy refuses | `audience_ineligible` |
| 10. Host policy admits | `audience_eligible` |

**GET.** Steps 1–3 and 5 use the statuses shown. For a live conditional link, the JSON inspection representation returns HTTP 200 with `{"audience":{"state":S}}`, where `S` is one of `required`, `stale`, `unverifiable`, `unavailable`, `ineligible` or `eligible`. An `ineligible` state MAY add `reason`, drawn only from the host's fixed set of **policy-level** statements (for example `"paid-required"`), never a statement about the person beyond the binary result. The HTML representation does not depend on data. Its page obtains states through its own JSON inspection call. The contact-profile representation, if offered for a conditional link, does not accept data and reveals nothing about eligibility. No representation echoes the principal, handle, key or response back.

The JSON inspection is a public, credentialless CORS (`*`) representation. Any site that holds a completed URL can therefore query it once within the window. The nonce record limits this to a single evaluation.

**Delivery (all links).** `author_required` is 403: the author is null or missing, or the proof is missing, or the profile is legacy. `author_unverifiable` is 401: the author's principal, key or proof does not verify. **Conditional links** add `audience_ineligible` (403) for an author refused by host policy. `audience_unavailable` is 503. Data in the URL and malformed envelopes are 400. Other codes follow contact-delivery. Error bodies carry only the code and a fixed safe message.

Responses are `Cache-Control: no-store` and `Referrer-Policy: no-referrer`, and never vary on cookies. Steps 6–7 are distinct codes so that a legitimate opener can retry (re-sign versus switch provider). They carry no further detail. For local principals, policy paths with different costs can differ in timing; an example is a billing refresh versus a population check. That timing is visible only to the holder of a single-use response, and hosts SHOULD equalize it where practical.

The [contact endpoint](contact-tokens.md#url-secrecy-and-browser-handling) query-redaction requirements apply to both `bindle_meta` and `bindle_data`. Neither value appears in access logs, traces, analytics, crash reports or notifications, and neither is placed in service-worker caches.

## 9. Obtaining a response (opener flow)

1. Opening a conditional link without data shows the owner host's page. It explains that continuing reveals the opener's handle and identity to **the `aud` origin** (named as that origin, not by meta-supplied names) and that the owner host may decide eligibility.
2. **Same host.** A signed-in opener may choose "Continue as …" after explicit account selection. The host's own authenticated, CSRF-protected, rate-limited owner operation constructs and signs the response from the verified meta. It is invoked from a page served with `frame-ancestors 'none'`. It is then verified exactly like any other response. The host MUST NOT attach an identity on page load, from a remembered choice without a click, or for an unselected account.
3. **Other host** (proposed, not implemented). The opener names their provider. The page discovers its manifest and the optional versioned feature `link-response.v1` (`features["link-response.v1"] = {endpoint}`, issuer origin; proposed, defined by this specification), then performs a **top-level form POST** (`application/x-www-form-urlencoded`, exactly one field `link`) of the link URL. That URL is the canonical audience plus `bindle_meta` only, with no data and no unrelated parameters. The incoming cross-site POST MUST NOT sign anything. It may carry no provider cookies under SameSite rules, and the provider MUST NOT relax SameSite to make it do so. It only renders a confirmation page. Before rendering, the provider authenticates its user (re-authenticating if necessary) and parses the meta without verifying it. It then checks that:

- `link` has exactly one query component, `bindle_meta`;
- `aud` is HTTPS and equals `link`'s origin and path;
- `type` is supported;
- `audience` is present.

The confirmation page is served with `frame-ancestors 'none'`. It prominently names the `aud` origin, highlighting its registrable domain, and states that the link and the user's identity will be sent there, and that the host may learn the user's eligibility. Signing happens only on a same-origin, CSRF-protected, per-user rate-limited confirmation POST. The provider then navigates top-level with 303 and `Referrer-Policy: no-referrer` to exactly `aud + "?bindle_meta=" + meta + "&bindle_data=" + data`. The provider constructs the return target only from the meta. There is no caller-supplied return URL. Cancellation returns no data. Sending the link to a chosen provider shares its contact capability with that provider, and the page MUST say so.
4. **Bindle app.** The same rules as the provider apply. The app may return or open the completed link.
5. The owner page captures the completed URL in memory and replaces the address-bar URL with the data-free link via `history.replaceState`. It keeps the response only for the eligibility display. Delivery uses author proofs (§7.5).

## 10. Compatibility with signed contact endpoints

Existing `?sig=` links keep their exact current verification behavior: header `typ:"bindle-contact-endpoint+jwt"`, exactly one query parameter, the existing request bound (currently 18,000 characters), and no envelope magic. They remain valid until expiry or revocation. New contact links are issued as `bindle_meta`. One parent grant is issued in exactly one form, and the host stores the exact header and claims of that form. A parent is not re-signed into the other form. `typ` and `bindle` make cross-form substitution fail in both directions. A request with both `sig` and any Bindle parameter is `link_malformed`. Hosts that predate this spec reject `bindle_meta` links because `sig` is absent, so they fail closed. Conditional links exist only in the new form.

Legacy signed tag claims seed the parent's intake configuration (§6.2); intake is authoritative afterwards.

§6.1 applies to legacy `sig` links as well. Their verification and GET behavior are unchanged, but their delivery accepts only the authored contact-delivery v1 profile. For that purpose a legacy parent is treated as `kinds:["one-off"]` with identity-only authorship, plus a host-assigned parent-bound `resource` recorded on the parent at cutover. This is a narrow carve-out from contact-delivery's rule that the signed URL binds those fields. It never grants `conversation-init`. Their current anonymous multipart delivery and anonymous inbox-bearer `/api/messages` submission are **implemented behavior that conflicts with the user decision**, and must be retired at an explicit cutover. Retirement does not invalidate the links themselves. Existing received messages keep their recorded provenance.

## 11. Conformance vectors

Fixed vectors with disposable test keys are in [bindle-links.vectors.json](../architecture/artefacts/bindle-links.vectors.json) (items 1–5, 7, 12, 13); the remaining items are executable tests (`tests/bindle-links.test.mjs`, `tests/contact-endpoints-links.test.mjs`, `tests/link-response.test.mjs`, `tests/link-replay.test.mjs`). Items 10, 11 and the representation-level parts of 14 await the HTTP adapter and authored delivery. The vectors cover:

1. A valid unconditional meta.
2. A valid conditional meta, with a valid same-host response and expected `md`.
3. Exact-bytes verification: a semantically equal re-serialized payload fails.
4. Meta/data swap and `typ`/`bindle` mismatch.
5. A `sig`+`bindle_meta` conflict, duplicates, case and percent-encoded names, unknown `bindle_*`, `+`/`%` in values, padding and noncanonical base64url.
6. Unrelated parameters ignored, and path changes rejected.
7. `md` from another or a rotated meta.
8. Validity boundaries at ±60 s skew; `exp - iat = 300` accepted and `301` rejected; missing or malformed `nonce`; and a second evaluation of the same response (replay) yielding `audience_stale`, while a fresh nonce on the same link is accepted.
9. A wrong `handle` or `sub` binding, and a foreign `iss` before the directory exists.
10. `audience` present with data absent at POST (accepted, given an eligible author proof); data in the POST URL.
11. On both conditional and unconditional links, and on a legacy `sig` link once migrated: `author:null`, legacy multipart, a legacy inbox-bearer request (406), and an unverifiable foreign author.
12. Length limits, a `bindle_meta` component without `=`, a percent-encoded `%73ig` legacy marker next to `bindle_meta`, `;` separators, and dot segments in the path.
13. ECDSA high-s versus low-s re-encodings of the same meta yield the same `md`.
14. Data on HTML, HEAD, bearer-mint, profile and POST requests (`link_malformed`, nonce not consumed); per-principal and per-parent replay caps.

Vectors are tests of this candidate, not evidence of deployment.

## Implementation status

| Surface | Today | This draft |
| --- | --- | --- |
| Contact capability URL | `?sig=` endpoint JWS (verification unchanged) and `bindle_meta` links, both routed locally through the shared raw-query parser (edge and account); owners issue new-form links with `POST /api/contact-links` | `bindle_meta` envelope; legacy form retained |
| Delivery tags | Revisioned intake on the parent, seeded from legacy signed tags; owner `GET`/`PUT /api/contacts/:id/intake` and the metadata representation (§6.3) are routed locally | Intake (§6.2) and metadata representation (§6.3) |
| Conditional links | Routed locally: same-host response signing (`POST /api/links/respond`), JSON-inspection evaluation with the bounded replay record, delivery-time host policy with bounded decision reuse and per-author UTC-day quotas, challenge rotation (`POST /api/contacts/:id/rotate`); developer contact is one conditional link (`GET /api/developer-contact`) | `audience` requirement, signed response, delivery-time evaluation |
| Author proofs | Required for every link delivery on both URL forms (local Worker and Node adapters): strict multipart URL POST and contact-delivery bearer RPC; anonymous multipart and inbox-bearer `/api/messages` submission are refused with `author_required` | Required for every link delivery; no unverified mode |
| Cross-host identity | Conversation-only key route; no general directory; foreign audiences and authors are unverifiable | Required for foreign audiences; until then `audience_unverifiable` |
| `link-response.v1` feature | Not advertised | Proposed optional core feature `{endpoint}` on the issuer origin; clients ignore unknown features and treat an invalid one as absent |
