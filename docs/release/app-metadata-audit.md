# Application presentation metadata security review

Status: independent source and local collector review completed, 2026-10-12. Human approval: reviewer ___ / date ___ / outcome ___. Production release remains disabled.

Application names, descriptions and icons are untrusted presentation metadata. They do not replace authenticated OAuth client identity, exact redirect registration, resource ownership, contract conformance or consent. The review covers declared Bindle metadata, linked PWA manifest discovery, bounded public fetching, icon handling and durable cache behavior.

Required boundaries:

- Only the authenticated registered app’s approved origin can initiate discovery. Caller-supplied arbitrary endpoints must not reach privileged egress.
- HTTPS, no embedded credentials, bounded ports/redirects/deadlines/body bytes, and strict content types. No account bearer, cookies, connector secrets or authentication headers are sent.
- DNS/address validation must apply at the actual outbound connection. Resolving a safe address and then ordinary fetching a hostname again is vulnerable to rebinding.
- Metadata HTML is parsed as inert data; scripts, browser execution, recursive resource loading and external entity resolution are absent. A linked manifest is metadata, not authority.
- Icons must not create a browser tracking fetch to app-provided arbitrary URLs. Active SVG, scripts and unsafe MIME types are not rendered. Any raster fetch must be independently bounded and validated.
- Cache entries are public metadata, content-pinned and time-bounded, with bounded negative caching and no global hot resource in normal authenticated tool dispatch.

The [W3C Web Application Manifest draft](https://www.w3.org/TR/appmanifest/#processing-the-manifest-without-a-document) permits a manifest on another origin when a same-app-origin document links it and the manifest server supplies the appropriate CORS agreement. A narrower same-origin-only importer can be a defensible implementation policy, but must disclose that limitation rather than claim cross-origin manifests are invalid. Public credential-free metadata discovery must not emulate `use-credentials` installation behavior by forwarding user credentials.

## Implemented boundary and findings

The collector accepts only operator-registered client origins and configured discovery pages. Bindle `application` metadata supports `name`, `short_name`, `description`, bounded raster icon references and a `web_manifest` pointer. PWA manifests are parsed as JSON; linked manifests are discovered through inert parse5 HTML trees. Template, script, noscript and foreign-namespace links do not drive discovery. No JavaScript or page assets execute. Query-bearing and fragment-bearing metadata URLs, embedded credentials, foreign unregistered origins and unsupported protocols are rejected.

Each collection attempt permits at most six metadata requests, 64 KiB JSON or 128 KiB HTML per response, and a 1.5-second deadline per request, including a stalled body. Redirected responses, non-200 status and unsupported content types fall back to the registered name. Request options explicitly omit credentials and referer and reject redirects. Discovered text is bounded, normalized, stripped of control/bidirectional override characters and treated as plain text. Operator-declared metadata takes precedence over fetched branding. Registered client ID and redirect policy remain independent.

**Actual egress is deliberately unavailable by default.** `APP_METADATA_FETCH` is an operator-injected verified port; the collector has no global `fetch` fallback. Neither the standard Worker nor Node adapter currently supplies a public DNS-pinned discovery transport. Consequently operator-declared metadata works locally, but ordinary deployment cannot yet discover arbitrary public manifests over the network. A populated pointer or mocked parser test is not evidence of public provider conformance. A future adapter must enforce resolved IP and port policy at the actual hop, forbid private/link-local/reserved address ranges, reject redirects, omit user credentials and implement an aggregate outbound request/spend bound before injection. An origin allowlist alone does not supply those guarantees.

Icons are retained only as approved-origin raster references and are not fetched by the collector. The UI must continue to use its local fallback icon until bounded verified raster retrieval/cache or operator-provided local raster assets exist. Declaring `image/png` does not prove the remote bytes are a safe image. No active SVG rendering or browser autoload of external icon references is authorized by this implementation.

Inspected request metadata is pinned to that bounded pending authorization record and copied into an app resource only on owner approval. Fetching occurs outside the authorization metadata transaction. The implementation does not yet provide a shared content-addressed public metadata/icon cache, operator-controlled refresh policy, or full installation-manifest CORS semantics. Cross-origin references are accepted only when their origin was already operator registered; this is a narrow discovery policy, not a claim of full W3C installation conformance. Repeated inspected authorization requests therefore need provider-side request/cost admission if external egress is eventually enabled.

## Independent validation

`node --test tests/app-metadata-audit.test.mjs`: **10 passed** on Node 24. Independent cases cover absent-port fail-closed behavior; origin, credential and URL escape rejection; credential-free request options; redirect refusal; MIME, byte and JSON failures; inert HTML parsing; control-character stripping and unsafe icon rejection; bounded linked discovery without fetching icons; declared-over-fetched precedence; stalled-body timeout with abort and registered fallback; and safe HTML base resolution with an excessive-tree bound.

These are collector/parser tests with an injected fixture transport. They do not verify production networking, DNS rebinding protection at a real socket, raster decoding, actual cache expiry/content hashing, independent PWA interoperability or browser presentation. Those gates remain explicit.


## Coordinator reconciliation: optional Node egress

A concrete Node adapter is now implemented and independently reviewed in `packages/apps/node-metadata-fetch.mjs`. `APP_METADATA_DISCOVERY_ENABLED=true` wires it into Node self-hosting; default-off deployments and Cloudflare still have no automatic external-discovery port. The adapter requests IPv4 DNS records only, validates every returned address and pins the actual HTTPS dial while retaining original-hostname TLS verification. IPv6-only and unsupported-port sources fall back. Concurrency/rate limits are process-local and do not cap the provider invoice.

A read-only live check used MDN's public PWA example index, discovered its `rel=manifest` link, fetched the manifest and resolved “Awesome fox pictures” with one retained raster icon reference. No credentials or icon bytes were sent/fetched. This proves that one Node network/discovery path works; it does not establish arbitrary-origin, Cloudflare, raster-cache or production conformance. Seven adapter regressions cover pinning, address policy, credentials, redirects, size/encoding, timeout and budgets.
