> Current wire profile: [runtime implementation](federation-implementation.md). The capability-negotiated [object storage contract](storage.md) supersedes any older mandatory-list/write examples below; listing is not part of object storage. Profile/preferences/descriptor/scoping identifiers use the canonical 3sln.me artefact URLs.

Browse the [contract registry](/artefacts/contracts/) or its [machine-readable index](/artefacts/contracts/index.json). Each JSON Schema link opens the published definition directly. Canonical contract identifiers also return JSON; usage prose remains in this document.

# Baseline contracts v0 — normative draft

Read [the protocol](protocol.md) first. The identifiers below are canonical 3sln.me artefact candidates. Immutable publication and external-provider conformance require their own recorded evidence. All contract arguments reject unknown fields and enforce documented bounds. Required methods have explicit grant permissions; implementing a contract never grants access automatically.

## Profile v1

ID: [`https://3sln.me/artefacts/contracts/profile/v1`](https://3sln.me/artefacts/contracts/profile/v1). [JSON Schema](/artefacts/contracts/profile/v1.json). An explicitly assigned profile resource offers `read({})` and returns `{entity,handle,name,avatar}`. `entity` is the canonical identity URL; handle is a display alias; name is plain text; avatar is an HTTPS URL or null. The current hosted implementation falls back to the handle when no display name is set and has no avatar. Login grants no profile access: the app requests the exact resource contract/method through a preference field. `@profile` resolves only within already approved authority. Email, phone and legal name are outside this baseline. Avatar rendering must not automatically reveal the user's network address to an arbitrary third party.

## Preferences v1

ID: [`https://3sln.me/artefacts/contracts/preferences/v1`](https://3sln.me/artefacts/contracts/preferences/v1). [JSON Schema](/artefacts/contracts/preferences/v1.json). `@preferences` offers `read({fragment})` for one granted immutable fragment URL. `{fragment,revision,values,requiresConsent?}` contains only approved fields. Resource fields project an opaque scoped resource reference, approved contract identifiers and an independently attenuated token, rather than a parent reference, upstream credential or private scope configuration. Consumer calls use ordinary RPC and relative logical keys; the provider resolves their binding privately. Scalar fields use their configured JSON values. An initially deliberate subset projects the approved resources; later unapproved additions are reported through `requiresConsent`. **AMD-C3 — proposed (approved provisionally 2026-10-20):** resource-field projections MUST list approved resources in owner order, omit unapproved resources and add the field name to `requiresConsent` when any are omitted. An unapproved addition MUST NOT withhold already approved resources. Revision is opaque, not ordered. There is no app write or list-all method. See [resource scoping](../architecture/resource-scoping.md) and [actual wire profile](federation-implementation.md).

## Preferences v2

**AMD-C9 — proposed (approved provisionally 2026-10-20).** ID: `https://3sln.me/artefacts/contracts/preferences/v2` (proposed identifier; artifact and runtime deferred). `@preferences` offers the same `read({fragment})` operation and result members as v1, plus `seq` only when the reader is an integration; `seq` is that connection's current configuration sequence, as defined in [integrations §6.2](integrations.md#62-event-types).

Every resource-field value MUST be a list, in owner order, of `{id,label,status,contracts,token,token_type,expires_at,broker?}`. `id` remains the provider's opaque scoped reference; `status` is `available` or `unavailable`; `contracts` lists approved exact contract URLs; `token` is an opaque independently attenuated credential; `token_type` is `Bearer` or `DPoP`; `expires_at` is Unix time in seconds. `broker`, present only for brokered resources, is `{endpoint,origin,resource}`: the validated integration RPC endpoint, its origin and its resource ID. The consumer MUST call that endpoint with `resource` set to `broker.resource` and the projected token; issuer-hosted resources use the issuer RPC endpoint. Consumers MUST NOT log tokens or persist them beyond expiry. Unapproved resources are omitted under AMD-C3. See [integrations §5.1](integrations.md#51-preferences-projection) for the full projection.

The immutable v1 contract and its object shape are unchanged. A v1 read MUST omit brokered resources and list the field in `requiresConsent`; it MUST NOT hide approved issuer-hosted resources in the same field.

## Contract method metadata

**AMD-C10 — proposed (approved provisionally 2026-10-20).** Pinned contract definitions MAY annotate each method in `x-methods` with `effect: "read"` (reads state without changing it or causing external effects) or `effect: "pure"` (computes from its inputs without state access or external effects). Missing or unknown effects MUST NOT be treated as read-only or pure, and MUST NOT qualify a slot for `any-error` failover. Classification does not waive authorization, privacy or work budgets.

An `x-methods` entry MAY set `introspect: true`, requiring the brokered resource server to check live authority through the provider's declared introspection endpoint before executing the method; read-only authorization may be cached for at most 30 s. Write-capable brokered contracts MUST require live introspection without cached authorization. If the required endpoint or verification is unavailable, execution MUST fail closed. Contract-level `x-bindle-brokerable: false` forbids registration as a brokered resource. Slots MUST NOT override these markers. See [integrations §5.7](integrations.md#57-introspection).

## Resource descriptor v1

ID: [`https://3sln.me/artefacts/contracts/resource-descriptor/v1`](https://3sln.me/artefacts/contracts/resource-descriptor/v1). [JSON Schema](/artefacts/contracts/resource-descriptor/v1.json). `describe({})` returns `{id, label, contracts, limits}` for the addressed, approved resource. `limits` includes `maxRequestBytes`, `maxResultBytes` and `txRetentionSeconds`, plus contract-specific limits. Descriptor permission is derived only for an already approved resource and exposes only approved implemented contracts/methods. It is not a resource discovery/list-all API. Connection health can be surfaced as `available`, `reauthorization_required` or `temporarily_unavailable`, with no upstream identifiers exposed by default.

## Object store v1

ID: [`https://3sln.me/artefacts/contracts/object-storage/v1`](https://3sln.me/artefacts/contracts/object-storage/v1). [JSON Schema](/artefacts/contracts/object-storage/v1.json). This is a bucket-like collection of opaque byte objects keyed by Unicode strings. It is a minimal sync primitive, not POSIX storage. Object keys are UTF-8 strings of 1–1024 bytes, case-sensitive, no NUL; prefix matching compares exact code point sequences with no normalization. Slashes have no intrinsic directory semantics. Adapters MUST prevent traversal and escape across the authorized root. Distinct logical keys must remain distinct; a provider unable to represent them uses opaque internal mappings or rejects resource creation rather than silently aliasing objects.

Every object has `{key, version, size, contentType?, modifiedAt}`. Version is an opaque provider change token supporting equality comparisons; it MUST change whenever bytes change. modifiedAt is an informational timestamp (milliseconds since Unix epoch in the current wire profile), not a conflict token. Quota/accounting size is decoded bytes. Resource limits MUST publish `maxObjectBytes` (v0 default cap 1 MiB), and storage quota if known. Base64 in JSON is the initial bounded-byte transport; large signed-URL upload/download protocols are later contracts and MUST NOT be invented implicitly by adapters.

| Method | Arguments | Result | Permission and semantics |
| --- | --- | --- | --- |
| `get` | `{key, ifVersion?: string}` | `{object: ObjectMetadata, dataBase64: string}` | `read`; ifVersion mismatch is conflict, absence is not_found. |
| `put` | `{key, dataBase64, contentType?: string, condition}` | `{object: ObjectMetadata}` | `write`; condition is `{absent:true}` or `{version:string}`. Strict canonical base64; contentType bounded. No unconditional overwrite in v1. |
| `delete` | `{key, version}` | `{deleted:true}` | `delete`; requires matching version, missing object not_found. |

`put` and `delete` preconditions MUST be atomic relative to this resource's writes. The gateway serializes writes per key where needed, but a gateway lock alone does not protect against external Drive/WebDAV edits. Adapters without reliable upstream conditional writes MUST NOT advertise writable object-store/v1 capabilities for externally mutable objects. A dedicated provider-managed namespace with all writes mediated by the gateway may satisfy this contract if the upstream guarantees needed for durable read/write reconciliation are documented. Silent last-write-wins is forbidden. App sync logic reads versions and resolves conflicts itself; this contract supplies no CRDT or global transaction.

Object enumeration is deliberately absent. Applications keep a known root directory/index object and use exact-key reads plus atomic conditional index updates. See [application-managed directories](storage.md#application-managed-directories) for bootstrap, conflicts, orphan recovery and deletion limits. Resource adapters need conformance tests for Unicode keys, atomic condition failure, concurrent writes, deletion, quota exhaustion and unknown outcomes after upstream timeout.

### Adapter rollout

1. **3sln hosted object store:** first production target; offers scoped per-entity namespaces and provider-controlled versions. Encryption at rest is provider custody, not user-only encryption.
2. **S3-compatible bucket/prefix:** use upstream conditional requests, validate endpoint/region, prevent SSRF, and scope credentials/root. Publish an explicit capability check and deny connectors whose implementation lacks required conditional semantics.
3. **WebDAV:** use ETags/conditional requests only after conformance validation. Weak ETags, unreliable If-Match and traversal behavior block write conformance; read-only implementations must advertise writes unavailable.
4. **Google Drive:** use a dedicated managed namespace and integration-specific verified version/precondition behavior. Do not equate Drive revision metadata with atomic object-store conditions. Read-only support can ship first; object-store write compliance is a release gate.

Apps MUST NOT infer an adapter's capabilities from its brand. Conformance depends on the actual resource and exact contract URL. This capability-negotiated draft permits read-only resources; they MUST advertise writes/deletes unavailable and reject those calls. Atomic-write requirements apply only to advertised writable capabilities.

## Useful follow-ons, outside initial release

An encrypted application-state fragment can assign object stores to support device sync, but encryption keys/recovery/rotation require a separate custody spec. A structured key/value contract with compare-and-swap and a change cursor can later simplify sync. Calendar, contacts, notifications, secrets/signing, payments and delegated compute all warrant separate contracts and narrower permissions; none should be bundled into a broad “account access” grant. Organizations use entity-owned resources with membership/role grants and separate audit policy; v0 does not make individual grants implicitly inheritable.

## Baseline release gate

The first usable ecosystem release requires profile + preferences + descriptor + hosted object store implementations, explicit app registration, self-host discovery/PKCE interoperability, revoke/edit handling and two independent client/provider conformance fixtures. Third-party connector badges and write support require adapter-specific tests. A prototype may use seeded example resources but MUST label them as demonstrations and MUST NOT claim working storage, passkey authentication or federation.
