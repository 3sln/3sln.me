# Bindle protocol v0 — normative draft

Bindle v0 is an open specification draft, not a deployed interoperability standard. Example canonical URLs under `https://spec.bindle.example/` are placeholders, not live authorities. MUST/SHOULD/MAY express draft requirements. The [OAuth and RPC wire profile](federation-implementation.md) describes the current runtime. The [contract registry](/artefacts/contracts/) links the published draft JSON definitions and a [machine-readable index](/artefacts/contracts/index.json). Canonical contract identifiers return those JSON definitions directly; publication does not imply external-provider compatibility.

## 1. Model and custody

An **entity** is an individual or, later, an organization/team with its own authority and policy. A **provider** operates authentication, preferences, resource adapters and grants for entities. An **application** requests grants. A **fragment** is a public, versioned description of preference fields. A **resource** is an entity-owned capability implementing named contracts. A **contract** defines method names, argument/result schemas, semantics and required authorization.

Entity, application, resource, fragment and contract identifiers are absolute HTTPS URLs. Opaque identifiers are allowed in URL paths. Display handles and emails are aliases, never durable entity identifiers or proof of ownership. Changing aliases MUST NOT change entity identity. Named resource aliases such as `@profile` resolve only within the authenticated entity and MUST NOT override authorization.

Self-hosting means implementing the public protocol without depending on 3sln.me. Hosted custody is delegated custody: a provider can see unencrypted stored preferences and connector credentials. Neither TLS nor OAuth provides end-to-end encryption. Export MUST include preferences, resource metadata and grant history in documented formats; connector secrets require an explicit encrypted export or reauthorization, and grants/tokens MUST NOT migrate automatically. Domain/key continuity and cross-provider identity migration remain a future specification; a v0 export MUST NOT imply portable identity.

## 2. Discovery and login

This specification defines no presentation beyond the security disclosures it lists (such as showing the resolved host and the consent details in §3); how a client collects a handle (for example a default host for unqualified input) is presentation. Every host receives identical protocol treatment. A client MUST parse a single nonempty local part and DNS host, reject URI userinfo, paths, ports and control characters, and display the resolved host before continuing. Domain names use platform IDNA normalization; local parts are preserved and interpreted by the provider. Email case folding MUST NOT be generalized to arbitrary providers.

For `alice@example.org`, fetch `https://example.org/.well-known/bindle/manifest.json`; send `alice@example.org` later as `identity` in the bounded authorization-request POST. **Do not fetch `https://alice@example.org/...`: this is URL userinfo, not a user-scoped host.** Discovery is host-level and MUST NOT enumerate individual existence. Manifest fetches use no cookies or bearer tokens, require HTTPS and JSON, enforce bounded size/time, and reject cross-origin redirects. Server-side fetching additionally blocks private, loopback and link-local targets and revalidates every DNS resolution and redirect. Development localhost is an explicit development-only exception.

```json
{
  "version": "0",
  "issuer": "https://example.org",
  "authorization_request_endpoint": "https://example.org/api/oauth/requests",
  "preferences_contract": "https://3sln.me/artefacts/contracts/preferences/v1",
  "authorization_endpoint": "https://example.org/oauth/authorize",
  "token_endpoint": "https://example.org/oauth/token",
  "rpc_endpoint": "https://example.org/bindle/rpc",
  "jwks_uri": "https://example.org/oauth/jwks",
  "login_presentation": ["redirect", "popup"],
  "revocation_endpoint": "https://example.org/oauth/revoke",
  "dpop_signing_alg_values_supported": ["ES256"],
  "contracts": ["https://3sln.me/artefacts/contracts/profile/v1"],
  "features": {
    "authorization-entry.v1": {
      "endpoint": "https://example.org/api/oauth/entries",
      "intents": ["login", "select-account", "reauthenticate", "end-session"]
    },
    "fedcm.v1": {"config_url": "https://example.org/fedcm/config.json"},
    "intents.v1": {"intents": ["send-message", "add-contact"], "login_endpoint": "https://example.org/console"}
  },
  "profiles": {
    "https://publisher.example/profiles/widgets/v1": {"note": "members defined by that profile, not by Bindle"}
  }
}
```

V0 requires endpoint URLs on the issuer origin and issuer equality with the requested HTTPS origin; this includes every endpoint a core feature declares. Third-party endpoint delegation needs a later trust specification. Providers SHOULD also publish standard OAuth authorization server and protected resource metadata. Clients MUST reject unsupported manifest versions and inconsistent issuer/endpoint metadata.

**Feature declarations (proposed).** Beyond the required members above, a provider declares which optional parts of this specification it implements, so clients never have to probe. There are two kinds of declaration, and the absence of either means the documented default:

- OAuth-registered capabilities stay flat, under their registered names, so generic OAuth tooling reads them: `revocation_endpoint` ([RFC 7009](https://www.rfc-editor.org/rfc/rfc7009.html); absent: the client can only clear its own state on sign-out), `dpop_signing_alg_values_supported` ([RFC 9449](https://www.rfc-editor.org/rfc/rfc9449.html); absent: no sender-constrained tokens, so a browser client keeps refresh tokens in memory only, [auth](auth.md#token-lifetime-and-client-sessions)), and `grant_types_supported` (a provider that issues refresh tokens MUST list `refresh_token`; Bindle clients assume no refresh when it is absent). Persistent DPoP binding of a browser refresh token also needs `authorization-entry.v1`, whose entry carries the client's `dpopJkt`. The Bindle member `login_presentation` is required and lists `redirect` and optionally `popup`.
- Bindle features are members of the `features` object. Each key is a stable, versioned feature identifier defined only by this specification, matching `^[a-z][a-z0-9-]{0,31}\.v[1-9][0-9]{0,2}$`; each value is an object of that feature's members (possibly empty). A provider MAY declare several versions of one feature; a client uses the highest version it implements.

| Feature | Members | Meaning | When absent |
| --- | --- | --- | --- |
| `authorization-entry.v1` | `endpoint` (issuer origin), `intents` (nonempty subset of `login`, `select-account`, `reauthenticate`, `end-session`) | The identity-optional, provider-owned authorization entry and the listed intents ([auth](auth.md#application-authorization)). **Reserved:** its entry body, `?entry=` parameter and responses are not yet published in the [wire profile](federation-implementation.md); until they are, the identifier is reserved and no provider can claim it interoperably. | Only the identity-pinned `authorization_request_endpoint` flow: sign-in requires a complete handle; no account selection, reauthentication or provider sign-out request. An intent missing from `intents` is unsupported. |
| `fedcm.v1` | `config_url` (issuer origin) | The provider is a FedCM identity provider for the exchange in [auth](auth.md#presentation-transports-and-key-binding). Requires `authorization-entry.v1`. | No FedCM; clients use `popup` or `redirect`. |
| `intents.v1` | `intents` (nonempty subset of the [link intents](links.md#64-contact-intents-and-link-previews)), `login_endpoint` (issuer origin) | The provider accepts `bindle_intent` on `login_endpoint` as specified in links. | Pages fall back to plain intent links. |
| `client-id-metadata.v1` | none | The provider accepts an HTTPS URL as `client_id` and resolves it to an [OAuth client ID metadata document](https://datatracker.ietf.org/doc/draft-ietf-oauth-client-id-metadata-document/) under the SSRF rules above. An operator registration for the same `client_id` always takes precedence over the document. The URL has a non-root path and no query, fragment or userinfo; the document is `application/json`, at most 16 KiB, fetched without cookies or redirects, contains a `client_id` equal to the URL, and lists `redirect_uris` on the `client_id` origin only; successes are cached at most 24 hours and failures are negatively cached. For a client not reviewed by the provider, consent shows the verified origin as the primary label and `client_name` only as unverified text; the provider MAY still refuse it. | Clients must be registered with this provider before use. |

**Profiles (proposed).** The `profiles` object lets a third party define provider capabilities outside this specification (for example the [3sln.me components profile](../profiles/components-v1.md) for provider-operated page components). Each key is the profile's absolute HTTPS identifier (at most 256 characters, no userinfo, query or fragment); each value is an object whose members only that profile defines. This specification assigns no meaning to profile members. A profile cannot change core processing: it cannot relax the issuer-origin rule for core endpoints, alter consent, grant, token or RPC semantics, or authorize anything by itself. The single exception is the component-origin envelope in [auth](auth.md#presentation-transports-and-key-binding), which a profile may use for an origin it declares. A profile MAY define members naming other origins; clients use those only as the profile specifies, and such origins never receive the client's PKCE verifier, tokens or keys. Profile-defined code delivery and component credentials follow the envelope in [auth](auth.md#presentation-transports-and-key-binding).

**Processing rules.** The manifest MUST be [I-JSON](https://www.rfc-editor.org/rfc/rfc7493.html) (no duplicate member names) within the 64 KiB manifest bound; `features` has at most 32 members of at most 4 KiB each when serialized, and `profiles` at most 8 members of at most 8 KiB each. Clients ignore unknown feature identifiers, unknown versions, unknown profile identifiers and unknown members. A known feature or profile whose members fail validation is treated as absent; it does not invalidate the manifest, and the required members above still fail closed. A declaration is a claim, not proof: a client that sees a declared feature fail in a way that shows it is not implemented (for example HTTP 404, 405 or 501 from its endpoint) treats it as absent for that issuer until the page or process restarts, never persists that downgrade, and treats network and 5xx failures as retryable errors, not absence. Values from one issuer's manifest apply only to operations bound to that issuer and are never combined with another issuer's declarations. A client MAY cache a validated manifest for at most its HTTP freshness lifetime, capped at one hour, and uses one manifest snapshot from the start of an authorization to its code exchange.

**Conformance floor.** A host is a supported Bindle provider when, and only when, it meets this minimum: (1) a valid manifest as above (supported `version`, exact issuer equality, every required endpoint on the issuer origin, `login_presentation` containing `redirect`, a `preferences_contract`); (2) the authorization code flow with PKCE S256 through `authorization_request_endpoint` and a top-level redirect, to exact registered redirect URIs, with `state` and `iss` on every callback; (3) single-use, short-lived codes and token responses that bind issuer, subject, client and audience ([wire profile](federation-implementation.md)). Every feature, profile, `popup`, revocation and DPoP declaration is optional, and clients MUST fully support providers that implement only the floor. A host whose manifest is present but below the floor is reported as an unsupported provider; it never triggers a fallback to another provider. Only a definitive 404/410 absence permits the fallback below, and errors never silently switch providers.

Successful discovery proceeds with OAuth authorization code plus PKCE S256, exact preregistered redirect URI, cryptographically random state, issuer binding and short-lived single-use codes. Public clients have no embedded secret. The app POSTs the complete handle as `identity` together with PKCE, registered client/redirect and fragment requests to `authorization_request_endpoint`, then redirects with only the returned `request_id`; [exact wire sequence](federation-implementation.md). The provider-stored request identifier references fragment grants; large grant descriptions MUST NOT be encoded unbounded in URLs. App registration requires verified control of its HTTPS origin and redirect URI. Registration is per provider unless the provider declares `client-id-metadata.v1`; open dynamic registration is not assumed by v0.

`redirect` MUST be supported by every provider and client. `popup` (in `login_presentation`) and FedCM (proposed, `fedcm.v1`) are optional; clients fall back to `popup` or `redirect` when a capability is absent or unsupported by the user agent, and use a FedCM config URL only from that issuer's manifest. Every transport ends in the same single-use authorization code bound to the authorization entry, PKCE challenge, state and issuer; exact FedCM, profile-defined delivery and DPoP exchange shapes are in [auth](auth.md#presentation-transports-and-key-binding). How a provider renders, frames or protects its pages is provider policy, not protocol.

A client MAY offer email login through a fallback provider it names only on an explicit 404/410 absence response, and only after showing the user that the entered address will be sent to that provider. Network, TLS, CORS, malformed-manifest, unsupported-version and HTTP 5xx failures MUST produce a retry/provider error, not silent fallback. Providers with manifests but unknown local users handle that condition themselves. A browser discovery CORS failure is not proof of absence; self-hosted providers MUST allow public manifest reads. Existing 3sln sessions never silently attach the email: email verification and an explicit account-link confirmation are required. Login/account association edge cases are specified in the security document.

## 3. Fragments and preference values

A fragment URL identifies an immutable schema version. Public metadata includes `id`, `title`, `description`, `publisher`, `fields` and a machine-readable schema. Fragment documents MUST contain no entity values or secrets. Updates require a new URL; the provider pins the fetched canonical JSON SHA-256 digest at approval. A changed document at an existing URL is rejected pending review. V0 schemas accept a bounded declarative subset, never arbitrary HTML, JavaScript, remote schema references or executable UI. Metadata is untrusted plain text.

```json
{
  "id": "https://drive.example/preferences/sync/v1",
  "title": "Sync storage",
  "description": "Choose where this application's files are stored.",
  "publisher": "https://drive.example",
  "fields": {
    "stores": {
      "title": "Storage locations",
      "type": "resource",
      "cardinality": {"min": 1, "max": 8},
      "contracts": ["https://3sln.me/artefacts/contracts/object-storage/v1"]
    },
    "theme": {"title": "Theme", "type": "enum", "values": ["system", "light", "dark"]}
  }
}
```

Atomic field types are string, boolean, integer, number, enum and HTTPS URL, with explicit length/range validation. Number precision is restricted to JSON-safe values; integers fit the safe integer range. Resource fields carry references, never adapter credentials. The optional scoping contract allows a shared `{resource,scope}` assignment; resource reads return independently attenuated tokens. See the [runtime scope rules](federation-implementation.md#authority-scoping-and-revocation). Resource constraints are an AND of required contracts; multiple alternative contract sets require a future explicit `anyOf`, not ambiguous interpretation. Cardinality applies equally to atomic/resource values; default is exactly one. Missing optional fields and an empty list are distinct. Fragments are configured per entity and immutable fragment version. Applications cannot write preference values in v0; only the user's authenticated provider UI can.

Apps request each fragment with `required`, a plain-text purpose, an explicit field set, and per-resource-field contract/method permissions. Fragment configuration does not imply application permission. A required grant is an application prerequisite, not forced user consent: declining cancels that application's connection with a clear explanation. Optional grants can be declined before configuration. Unconfigured required fragments show the request before the setup UI and receive final approval after values are chosen.

The final consent screen MUST show verified application origin (display name is not identity), each field/value shared, resource labels and providers, precise allowed methods including destructive/write operations, why the app requests them, fragment publisher metadata, and the apps already approved for those fields. Shared fragment edits MUST show affected apps. Unverified metadata claims MUST NOT acquire a trusted badge. Users can review/revoke access later and cancel at every preapproval step. Only approved fields are returned to an app; schema metadata cannot expand the grant.

## 4. Grants and live authorization

A stored grant binds entity, client identity, fragment URL and pinned digest, field set, approved resource URLs and per-resource contract/method set. An access token binds issuer, subject/entity, audience/RPC endpoint, client and grant IDs with expiry. Tokens are opaque to SDK consumers. V0 access-token lifetime is at most five minutes; public-client refresh tokens, if provided, rotate with reuse detection, and a browser client may persist one only when it is DPoP-bound ([auth](auth.md#token-lifetime-and-client-sessions)). Component credentials a profile defines are never client or RPC credentials ([auth](auth.md#presentation-transports-and-key-binding)). Provider cookies are not application RPC credentials.

For every RPC, authority is the intersection of token grants, current nonrevoked grant records, current resource-field assignments, resource ownership, implemented contracts and requested method. Authorization is checked immediately before executing the operation. Removing an assignment or revoking a grant immediately blocks new operations, including operations using unexpired tokens. A process already streaming data may have disclosed bytes; revocation cannot recall them. Remote resource servers need token introspection or an equivalent revocation channel with a documented bound; v0 uses the issuer's adapter gateway only.

Replacing or adding assigned resources never silently adds app access. Existing apps retain access only to the previously approved resources still assigned. The edit screen offers explicit reapproval per affected app; an app can later request a grant update. Removing resource assignments is immediate. Changing atomic values within already approved fields propagates to approved apps; the editor MUST explain this before saving. Adding fields, broadening methods, changing schema versions or restoring removed resources requires new approval. Assigning the same resource in another fragment does not bypass grant checks.

Provider and third-party integration credentials remain in server-side encrypted storage and MUST NOT be returned in preferences, RPC errors or logs. Adapter tokens authorize only the smallest available upstream scope; if an upstream provider offers broader scopes, consent discloses this limitation. Apps get approved resource capabilities, never upstream OAuth tokens.

## 5. RPC transport

POST the issuer RPC endpoint with `Authorization: Bearer …` and JSON. Transport is HTTPS. V0 is synchronous request/response; there are no callback URLs, batch calls or fire-and-forget operations.

```json
{
  "version": "0",
  "tx": "2f17cceb-7cae-49cd-ae13-1aad1ceab264",
  "resource": "https://example.org/entities/e_123/resources/r_456",
  "contract": "https://3sln.me/artefacts/contracts/object-storage/v1",
  "method": "get",
  "args": {"key": "app/directory.json"}
}
```

Response: `{"version":"0","tx":"…","result":{…}}` or `{"version":"0","tx":"…","error":{"code":"conflict","message":"Object changed"}}`. Exactly one of result/error exists. Transactions are UUIDs generated by the app. Resource aliases are resolved before authorization and MUST be included in the canonical request fingerprint. Invalid envelopes return HTTP 400; missing/invalid bearer tokens 401; authorized, valid contract errors use HTTP 200 and the error envelope. Authorized requests denied by grant policy use 403 without revealing hidden resource existence. Servers enforce request/result byte limits and quotas and return 429 with Retry-After for rate limits.

The journal key is `(entity, client_id, tx)`, and the fingerprint covers resolved resource, contract, method and canonical args. Repeating the same request returns the recorded outcome; reusing a tx for different content yields `tx_conflict`. Mutations require durable deduplication for at least 24 hours and advertised retention. Retried reads may use the same tx for the original snapshot or a new tx for fresh data. Clients MUST NOT retry a mutation outside the journal retention window as though guaranteed safe.

Exactly-once execution across external adapters cannot be guaranteed. Adapters MUST reserve the transaction durably before the upstream write and use upstream idempotency support where available. A crash/timeout with an unknowable outcome produces `indeterminate`, never an automatic second write; users/apps reconcile through a subsequent read. Validation, authorization and revocation checks precede cached response delivery: a revoked app does not recover a previously cached payload. V0 does not expose journal status through a separate anonymous endpoint.

Common codes: `invalid_args`, `unsupported_contract`, `unsupported_method`, `not_found`, `forbidden`, `conflict`, `quota_exceeded`, `rate_limited`, `tx_conflict`, `indeterminate`, `temporarily_unavailable`. Error messages are safe for user display and omit upstream credentials and internal traces. Providers log audit metadata and transaction status but SHOULD NOT log argument/result payloads.

## 6. Compatibility and conformance

Contract method requirements and schemas are immutable at each URL. A resource lists the exact contracts it implements; matching by title, hostname or compatible-looking method names is forbidden. Compatible new methods use a new contract version unless a defined optional-method mechanism exists. Existing clients keep their approved version until migration/reconsent. Contracts may link human-readable documentation alongside JSON schemas with content negotiation, but identifiers and pinned semantic definitions remain stable.

Conformance tests MUST cover discovery/issuer confusion, manifest failures and fallback privacy; grant expansion/removal/revocation; schema substitution; alias authorization; cross-entity and cross-client calls; duplicate transactions and ambiguous upstream writes; malformed arguments; adapter credential nonexposure; pagination/concurrency; and accessible consent flows. Public resource descriptors reveal no private existence before authorization. Organization membership, delegation, public profile discovery, end-to-end encrypted storage, notifications and provider migration are deliberately outside v0.

## Standards references

The draft builds on [HTTP Semantics, RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html), particularly the prohibition on HTTP URI userinfo; [OAuth security best current practice, RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html); [OAuth authorization server metadata, RFC 8414](https://www.rfc-editor.org/rfc/rfc8414.html); and [OAuth protected resource metadata, RFC 9728](https://www.rfc-editor.org/rfc/rfc9728.html). Bindle-specific fragment/grant/RPC semantics are proposals, not claims that OAuth defines them.
