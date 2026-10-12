# Baseline contracts v0 — normative draft

Read [the protocol](protocol.md) first. The names below use placeholder publication authority `https://spec.bindle.example`; publication URLs require owner sign-off. All contract arguments reject unknown fields and enforce documented bounds. Required methods have explicit grant permissions; implementing a contract never grants access automatically.

## Profile v1

ID: `https://spec.bindle.example/contracts/profile/v1`. Named resource `@profile` resolves to the authenticated entity's profile. `get({})` returns `{entity, displayName, avatarUrl?}`. `entity` is the canonical entity URL; displayName is plain text, at most 200 characters; avatarUrl is HTTPS or absent. Avatar fetching needs an independent privacy policy and MUST NOT automatically disclose the user's IP to an arbitrary upstream avatar host in the consent UI. Email, phone, real/legal name and organization memberships are not baseline profile attributes. They require separate fragments. `get` needs an explicitly approved profile resource field and method permission; login alone does not grant profile access. No public-profile lookup or app writes in v0.

## Preferences v1

ID: `https://spec.bindle.example/contracts/preferences/v1`. Named resource `@preferences` offers `read({fragment})`, where fragment is an approved immutable schema URL. Return `{fragment, revision, values}` includes only approved fields and only approved resource references. The proposed scoped resource projection is `{id, label, contracts, token}` with a scoped resource reference and consumer-specific capability token. The provider stores the selected resource and shared scope configuration privately; consumers never receive that configuration or a parent credential. This extends the currently implemented `{id, label, contracts}` projection and is not yet wired into the general preference runtime; see [resource scoping](../architecture/resource-scoping.md). It contains no upstream credentials or arbitrary connection configuration. Fields with assignments lacking current resource approval return a missing value and `requiresConsent: [fieldName]`, allowing the app to request updated access. Atomic fields use their configured JSON values. `revision` is an opaque change token; no lexical ordering is implied. The fragment grant permits only reading that fragment; a generic @preferences read permission cannot enumerate all fragments. No app write/list-all methods in v0.

## Resource descriptor v1

ID: `https://spec.bindle.example/contracts/resource-descriptor/v1`. `describe({})` returns `{id, label, contracts, limits}` for the addressed, approved resource. `limits` includes `maxRequestBytes`, `maxResultBytes` and `txRetentionSeconds`, plus contract-specific limits. Descriptor permission is derived only for an already approved resource and exposes only approved implemented contracts/methods. It is not a resource discovery/list-all API. Connection health can be surfaced as `available`, `reauthorization_required` or `temporarily_unavailable`, with no upstream identifiers exposed by default.

## Object store v1

ID: `https://spec.bindle.example/contracts/object-store/v1`. This is a bucket-like collection of opaque byte objects keyed by Unicode strings. It is a minimal sync primitive, not POSIX storage. Object keys are UTF-8 strings of 1–1024 bytes, case-sensitive, no NUL; prefix matching compares exact code point sequences with no normalization. Slashes have no intrinsic directory semantics. Adapters MUST prevent traversal and escape across the authorized root. Distinct logical keys must remain distinct; a provider unable to represent them uses opaque internal mappings or rejects resource creation rather than silently aliasing objects.

Every object has `{key, version, size, contentType?, modifiedAt}`. Version is an opaque provider change token supporting equality comparisons; it MUST change whenever bytes change. modifiedAt is RFC 3339 UTC informational data, not a conflict token. Quota/accounting size is decoded bytes. Resource limits MUST publish `maxObjectBytes` (v0 default cap 1 MiB), `maxListLimit` (at most 1000), and storage quota if known. Base64 in JSON is the initial bounded-byte transport; large signed-URL upload/download protocols are later contracts and MUST NOT be invented implicitly by adapters.

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
