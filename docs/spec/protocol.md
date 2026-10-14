# Bindle protocol v0 — normative draft

Bindle v0 is an open specification draft, not a deployed interoperability standard. Example canonical URLs under `https://spec.bindle.example/` are placeholders, not live authorities. MUST/SHOULD/MAY express draft requirements. The [OAuth and RPC wire profile](federation-implementation.md) describes the current runtime. The [contract registry](/artefacts/contracts/) links the published draft JSON definitions and a [machine-readable index](/artefacts/contracts/index.json). Canonical contract identifiers return those JSON definitions directly; publication does not imply external-provider compatibility.

## 1. Model and custody

An **entity** is an individual or, later, an organization/team with its own authority and policy. A **provider** operates authentication, preferences, resource adapters and grants for entities. An **application** requests grants. A **fragment** is a public, versioned description of preference fields. A **resource** is an entity-owned capability implementing named contracts. A **contract** defines method names, argument/result schemas, semantics and required authorization.

Entity, application, resource, fragment and contract identifiers are absolute HTTPS URLs. Opaque identifiers are allowed in URL paths. Display handles and emails are aliases, never durable entity identifiers or proof of ownership. Changing aliases MUST NOT change entity identity. Named resource aliases such as `@profile` resolve only within the authenticated entity and MUST NOT override authorization.

Self-hosting means implementing the public protocol without depending on 3sln.me. Hosted custody is delegated custody: a provider can see unencrypted stored preferences and connector credentials. Neither TLS nor OAuth provides end-to-end encryption. Export MUST include preferences, resource metadata and grant history in documented formats; connector secrets require an explicit encrypted export or reauthorization, and grants/tokens MUST NOT migrate automatically. Domain/key continuity and cross-provider identity migration remain a future specification; a v0 export MUST NOT imply portable identity.

## 2. Discovery and login

The framework login custom element defaults an unqualified handle to `@3sln.me`, rendering the suffix as a suggestion until `@` is typed. Other hosts receive identical protocol treatment. The SDK MUST parse a single nonempty local part and DNS host, reject URI userinfo, paths, ports and control characters, and display the resolved host before continuing. Domain names use platform IDNA normalization; local parts are preserved and interpreted by the provider. Email case folding MUST NOT be generalized to arbitrary providers.

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
  "login_presentation": ["redirect"],
  "contracts": ["https://3sln.me/artefacts/contracts/profile/v1"]
}
```

V0 requires endpoint URLs on the issuer origin and issuer equality with the requested HTTPS origin. Third-party endpoint delegation needs a later trust specification. Providers SHOULD also publish standard OAuth authorization server and protected resource metadata. Clients MUST reject unsupported manifest versions and inconsistent issuer/endpoint metadata.

Successful discovery proceeds with OAuth authorization code plus PKCE S256, exact preregistered redirect URI, cryptographically random state, issuer binding and short-lived single-use codes. Public clients have no embedded secret. The app POSTs the complete handle as `identity` together with PKCE, registered client/redirect and fragment requests to `authorization_request_endpoint`, then redirects with only the returned `request_id`; [exact wire sequence](federation-implementation.md). The provider-stored request identifier references fragment grants; large grant descriptions MUST NOT be encoded unbounded in URLs. App registration requires verified control of its HTTPS origin and redirect URI. Dynamic registration/client metadata interoperability is a later extension, not assumed by v0.

Redirect is mandatory in v0. `iframe` may be advertised as a future capability but MUST NOT carry credentials in the initial implementation: embedding invites clickjacking and depends on browser cookie behavior. A future iframe profile needs explicit frame-ancestor allowlisting and a strictly origin-checked postMessage handshake; provider hints never force embedding.

Fallback to 3sln.me email login is permitted only on an explicit 404/410 absence response, and only after showing the user that the entered address will be sent to 3sln.me. Network, TLS, CORS, malformed-manifest, unsupported-version and HTTP 5xx failures MUST produce a retry/provider error, not silent fallback. Providers with manifests but unknown local users handle that condition themselves. A browser discovery CORS failure is not proof of absence; self-hosted providers MUST allow public manifest reads. Existing 3sln sessions never silently attach the email: email verification and an explicit account-link confirmation are required. Login/account association edge cases are specified in the security document.

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

A stored grant binds entity, client identity, fragment URL and pinned digest, field set, approved resource URLs and per-resource contract/method set. An access token binds issuer, subject/entity, audience/RPC endpoint, client and grant IDs with expiry. Tokens are opaque to SDK consumers. V0 token lifetime is at most five minutes; public-client refresh tokens, if provided, rotate with reuse detection. Provider cookies are not application RPC credentials.

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
