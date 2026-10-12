# Independent specification and interoperability review

Review date: 2026-10-11. Reviewer: Codex independent specification/interoperability review agent. Scope: `docs/spec/**`, `docs/artefacts/**`, SDK discovery, runtime HTTP/account boundaries, storage adapters, asset assembly, and the local 3sln stack ethos/service documentation. This is a technical finding record, not human approval. Human reviewer: ___ Date: ___ Outcome: ___.

Verdict: **not ready to publish as an interoperable specification or claim provider conformance**. Reversible implementation and draft reconciliation can proceed. The repository and proposed domain names exist in the development work; this review establishes neither public deployment nor publication. A proposed `$id` is not evidence that immutable bytes have been published. The existing owner API and storage drivers are useful implementation evidence, but are not a completed OAuth/resource gateway.

## Prioritized requests

### I01 — P0 before spec publication: choose one active storage contract

Evidence: `protocol.md` and `contracts.md` require `https://spec.bindle.example/contracts/object-store/v1`, mandatory list/get/put/delete, and a separate contract for read-only resources. `storage.md`, the JSON artefact and real adapters instead use `https://3sln.me/artefacts/contracts/object-storage/v1` with optional capabilities. The local engine uses a third URL, `https://bindle.example/contracts/object-storage/v1`. Exact URL matching is itself a normative requirement, so these cannot be casually equated.

Fix now: identify the capability-negotiated contract as the active **unpublished candidate**, explicitly supersede the earlier mandatory-write draft, and update normative examples consistently. Keep the demo identifier marked fixture-only; never alias it to the new URL to bypass contract/grant checks. Since no publication is established, reconciliation can edit the draft in place. After actual publication, semantic changes require a new URL and reconsent. Add one small status/identifier table shared by the protocol, implementation boundary document and ledger.

Acceptance: a reader can select exactly one candidate storage contract and determine which code is merely an internal adapter or demo fixture. An old fixture grant cannot authorize the new contract.

### I02 — P0 before interoperability claims: define the OAuth-to-grant wire bridge

The OAuth draft names a “provider-stored request identifier” but defines no endpoint, request schema, client authentication/binding, lifetime, lookup authority, token response extension, or grant-update protocol for creating/using it. Fragment requests have prose requirements but no exact JSON representation. Browser manifest CORS is required; token/RPC preflight behavior and allowed request/response headers are not a complete profile. `jwks_uri` is mandatory despite opaque application tokens and optional OIDC. This can work, but its purpose and required key profile need definition.

The SDK only parses/discovers and returns an authorization URL; the login element dispatches a request event. It does not generate PKCE/state, redeem codes, authenticate a callback, or bind a returned subject. Worker HTTP deliberately has no OAuth token/authorize/RPC endpoints and returns an empty app-grant list. These are implementation gaps, not vulnerabilities in a claimed implemented OAuth server.

Fix now: explicitly label SDK discovery-only and owner HTTP issuer-local; publish a bounded, coherent proposed registration → fragment request → authorization → code exchange → approved-grants result → RPC sequence with exact parameter names and schemas. Specify issuer callback binding, expiry units, errors and CORS. Leave absent endpoints release-gated. Do not improvise a query parameter protocol in the UI. Two independently implemented providers/clients must exercise this sequence before declaring federation.

### I03 — P0 before schema publication: separate contract envelope and method schemas

`object-storage-v1.json` is parseable JSON containing a request `oneOf` and `$defs`; that alone does not establish validated JSON Schema 2020-12 conformance or a complete contract. Its root validates `{method,args}`, not the protocol RPC envelope. Result definitions exist but no machine mapping connects a method to its result schema. `x-permissions.presign` is the human string `presign:read or presign:write`, not an enforceable branch mapping. The schema admits `operation:write` while forbidding the size/type/precondition fields needed to make upload signing safe.

Fix now: document the projection to which the root schema applies; give a machine-readable method → request/result/permission map. Model read and write presigning as discriminated branches with independently checked permissions. Until upload policy exists, specify write presigning as unavailable and never advertise it. Specify whether read-presign requires read **and** presign:read (recommended), rather than letting implementations disagree. Describe capabilities access as bound to an already approved resource.

Also make `delete` an explicit required boolean; the two adapter capability factories currently differ on its presence. Define capability implications and constraints (range implies read; write needs the declared conditional semantics; no grant expansion on capability changes). Add actual schema validation of request/result fixtures using a 2020-12 validator; do not mistake JSON parsing or adapter tests for schema conformance.

### I04 — P1, fix now: discovery accepts forbidden IP/control forms

Read-only reproduction against `packages/sdk/src/identity.mjs` accepted `a@127.0.0.1`, `a@2130706433`, `a@0x7f000001` (the latter two normalize to loopback), and a local part containing U+0001. `auth.md` explicitly rejects IP literals and controls. The SDK's DNS-label check runs after URL normalization and therefore accepts dotted numeric output; its whitespace regex misses non-whitespace controls.

Fix: reject C0/DEL controls in the original input, then reject normalized IP hosts including unusual numeric input forms. Add focused parser tests preserving legitimate IDNA/local-part handling. This does not supply server-side DNS/connection-time SSRF defenses; that separate release gate remains.

Worker manifest absence also needs deliberate semantics: it returns 404 `not_yet_conformant`, and SDK 404 triggers email fallback. If this means “provider intentionally unavailable”, use a non-absence result (such as 503) so callers cannot infer email fallback from temporary federation unavailability. If it truly means “no provider exists”, document the fallback even when the default provider has no enabled mail delivery. Missing cross-origin CORS can currently turn this into a browser discovery error instead; test the actual wire behavior.

### I05 — P1, fix now: proposed identifier does not match assembled asset route

`scripts/build-assets.mjs` copies `docs/artefacts/object-storage-v1.json` to `/artefacts/object-storage-v1.json`; `$id` claims `/artefacts/contracts/object-storage/v1`. Worker `/artefacts/*` routes simply forward to the assets binding. No explicit mapping establishes the declared URL. A single-page fallback could even return HTML at a presumed schema URL.

Fix: assemble or explicitly route the chosen candidate path to the exact JSON artefact, preserve JSON media type and correct missing-artefact status, and test the local response. Mark this local candidate route unpublished. Before real publication decide content negotiation, canonicalization, digest algorithm/encoding and redirect policy. “Canonical JSON SHA-256” alone is ambiguous; define exact canonicalization rather than assuming implementations serialize identically. Immutable URL + pinned digest needs a publication/change procedure, not merely an identifier constant.

### I06 — P1 before storage conformance: resolve key and metadata semantics

Baseline text allows every 1–1024 UTF-8-byte Unicode key except NUL, says slashes have no directory semantics and forbids aliasing. `objectKey` rejects empty path components, trailing slash, dot segments, percent sequences, backslash and all C0/DEL controls. Drive uses stable file IDs, Dropbox emits lowercase path keys while `get` accepts mixed case, OneDrive lists direct children yet can get nested paths, and WebDAV lists only Depth-1 children. One contract currently suggests interchangeable namespaces where these adapters have materially different traversal, identity, renaming and enumeration behavior.

Fix now: distinguish the abstract desired contract from the implemented safe key profile and provider-native namespace profiles. Either map arbitrary logical keys through opaque storage mappings, or narrow the candidate grammar and expose native file resources under an explicitly distinct contract. A lowercase provider cannot silently satisfy a case-sensitive injective mapping. Define whether list enumerates every object get can address; “namespace” as an unconstrained optional string is insufficient.

Metadata also differs: baseline requires `modifiedAt`, schema makes it optional, WebDAV emits an upstream HTTP-date string, ranges use returned byte count as `size`, and adapter get/put results use `{bytes,version,...}` rather than wire `{object,dataBase64}`. State that adapters are internal interfaces; implement one normalization boundary before claiming wire conformance. Decide whether range results carry whole-object size plus returned range, and define empty/truncated/out-of-range behavior. Define versions as opaque **nonempty** strings and size/range integers within the safe JSON integer domain.

Schema bounds presently allow empty metadata versions, unconstrained strings/prefixes, unbounded integers and syntactically shaped but not necessarily canonical base64. UTF-8 byte length, no-NUL, canonical pad bits and range ordering require explicit runtime checks even with schemas. Record which layer owns each check and test adversarial fixtures there.

### I07 — P1 before gateway: internal IDs and permission vocabularies need an explicit boundary

Protocol identifiers are HTTPS URLs; runtime accounts/resources/contact subjects use UUIDs. Contact invitations explicitly describe their `sub` as internal stable account ID. Demo fragment `fields` is an array with `multiple`, while normative fragments use a keyed object and cardinality. These can coexist as internal representations, but currently a developer must infer the serialization boundary. `get/read`, `put/write`, contract method names and scope labels are also mixed without a complete grant schema.

Fix now: specify canonical entity/resource URL construction from immutable internal identifiers, never from mutable handles; keep contact routing subjects local and distinct from future OAuth subjects. Define owner API versus public RPC/fragment schema boundaries. Clarify methods versus permission labels, exact effective-method calculation, and argument constraints. Atomic preferences need exact scalar/list encoding for cardinality, missing/empty/null semantics and `requiresConsent` placement. The current example omits the separately required machine-readable fragment schema; provide a validating complete example.

### I08 — P1 before cache or replay interoperability: specify cursors, journal and errors

Baseline promises cursor expiry and client/resource binding. Adapters encode unsigned JSON with upstream namespace/query but no client, logical resource ID or expiry. Two connections to the same upstream root may share the same scope. Current docs correctly say cursors are not authority, but this does not satisfy the stronger baseline promises.

Fix now: identify these as internal continuation tokens, with a future gateway wrapper bound to issuer/entity/client/resource/contract/query, expiry and configuration revision; every page still checks the live grant. Define null/absent cursors and stale errors. Document whether `maxObjectBytes` means readable object size, writable size or maximum response chunk; current listings can reveal larger objects whose full get fails.

The demo transaction key is grant+tx; proposed key is entity+client+tx. Persistent mutation reservations, retention, error replay and indeterminate reconciliation remain unimplemented. Freeze UUID acceptance, canonical fingerprinting and size/retention rules before the gateway. Define a single mapping from internal errors (`unsupported`, `size_limit`, `upstream_error`, `invalid_cursor`, etc.) to public protocol codes, HTTP statuses and safe details. Internal provider errors should not silently become a competing public standard.

### I09 — P1 documentation coherence: auth and current implementation profiles disagree

`auth.md` specifies SameSite=Lax sessions, cross-device mailbox proof and optional email materialization; `account-lifecycle.md`/runtime use Strict cookies, same-session linking, passkey/password setup and recovery confirmation, and no arbitrary-email account materialization. `implementation.md` still describes only the earlier in-memory demonstration even though `npm run dev` now selects the local Worker. A developer cannot reliably identify the implemented profile from these introductions.

Fix now: put a current capability matrix and precedence/status note at the start of these docs. Mark earlier email materialization as a proposed future profile if retained, and keep disabled delivery explicit. Explain how a future cross-site OAuth authorization GET resumes an owner session when cookies are Strict; do not relax owner CSRF policy merely to make a draft flow appear complete. Verify that flow as a separate browser gate.

## Extension, organization and portability findings

Messaging makes the correct separation: bearer invitation possession permits narrowly scoped inbound delivery, not sender identity or execution. Preserve it in every new contact, app, automation and realtime example. An exact automation/WebRTC MIME type is transport classification only. Define authenticated peer identities, replay/session lifetimes, explicit execution grants, network/IP privacy, quota/abuse and cancellation before activating behavior. Contact JWS subjects/grants and OAuth app grants must remain distinct authorization families; no automatic token conversion or permission inheritance.

The existing contact API represents invitation capabilities, not an address book or authenticated social graph. Make that product distinction explicit before adding a contacts contract. Public share URL handles are mutable routing hints; stable account/collection references remain the authority. Multiple individual and organizational entities need explicit selected subject, actor, role/delegation revision, app consent and separate resource namespaces. Never infer an organization from an email suffix or reuse an individual's grant when switching entities. Implementing organizations is future scope; naming these required boundaries now avoids accidental protocol commitment.

The stack ethos requires explicit injected capabilities and platform adapters. Identity/messaging services already expose useful seams, but `packages/runtime/accounts.mjs` and HTTP/environment interfaces still reflect Worker stub invocation, rate resources, alarms and R2 assumptions. A generic `Request → Response` signature alone does not demonstrate Node/Workers portability. Document the minimal runtime-provider interfaces and absent-capability behavior; run the same domain conformance fixtures through both runtime adapters before claiming parity. No demand to complete an entire Node deployment is implied by this review.

Self-hosting must not require 3sln publication or login infrastructure after configuration. The SDK's default host, fallback provider, component text and suggested suffix are hardcoded in different places; expose one coherent explicit configuration while preserving the agreed default. Distinguish product display branding from stable protocol names and issuer identity. A later rename should not silently change discovery paths or invalidate identifiers. Operator-approved private connector access, if supported, needs a deliberately separate self-host policy; do not weaken public hosted egress controls.

## Concrete coordinator execution order

1. Fix parser rejection and local canonical artefact routing with focused tests; keep public deployment disabled.
2. Reconcile document status, storage contract identity, owner/internal versus wire IDs and active authentication profile in the ledger and drafts.
3. Complete method/result/permission mappings, freeze presign-write unavailable, and normalize capability booleans. Add actual request/result schema fixtures.
4. Specify the missing OAuth/grant exchange and fragment value shapes as proposals, then implement and independently test the gateway before federation claims.
5. Treat full storage namespace/metadata normalization, durable journal/cursor authority, live provider races, multi-runtime parity and organization/automation behavior as explicit gates rather than inferred implementation.

Verification performed here: source inspection, JSON reading, direct read-only SDK/key parser probes. No remote accounts were connected, no APIs deployed, no credentials used, and no whole-suite or browser run was performed by this reviewer. The parser examples above are reproduced evidence. Adapter/schema/wire differences are source-derived findings, not claims of demonstrated production exploits. This file is the review agent's only owned edit; the coordinator records reconciliation outcomes and actual tests in `DEVLOG.md`.
