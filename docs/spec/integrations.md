# Integrations, resource discovery and brokered resources — normative draft

Status: **provisional draft, 2026-10-20, revision 1** (under independent review; see [extensibility review](../release/extensibility-review.md)). Rationale and migration: [extensibility design](../architecture/extensibility-design.md). Human sign-off: reviewer ___ / date ___ / outcome ___. Track the decision in [DEVLOG](../../DEVLOG.md). Nothing here is implemented or production-verified.

This document extends [protocol](protocol.md), [auth](auth.md), [contracts](contracts.md), [resource contributions](resource-contributions.md) and [extensions](extensions.md). It defines interoperability rules only: no user interface beyond the security disclosures it lists, and no SDK behavior. Identifiers under `https://spec.bindle.example/` are placeholders.

## 1. Model

An **integration** is any party that connects to an entity's provider to configure itself, contribute resources, occupy or consume [slots](extensions.md), or receive configuration changes. Applications and integrations are one concept. There are two kinds of implementation, which the protocol treats identically wherever it is observable:

- **external**: an OAuth client operated by a third party. It may have a full front end, or nothing beyond an initiate-login endpoint, a redirect URI and server endpoints;
- **built-in**: implemented inside the provider (for example a managed Google Drive adapter). It has no network endpoints and no client credentials. The provider authors its integration manifest and applies the same setup, consent, lifecycle and severance rules.

The owner's approval of an integration creates one **connection**: the existing owner-scoped app connection resource ([resource contributions](resource-contributions.md), DEVLOG D057), extended with a pinned integration manifest snapshot, a lifecycle state and a **generation**. The connection is the coupling between the entity and the integration. It is owned by the provider, which can sever it unilaterally (§7).

Three relationships use the connection, and each has exactly one authentication method:

| Direction | Purpose | Authenticated by |
| --- | --- | --- |
| Integration → provider | Ordinary RPC: `@preferences`, contributed resources, notifications | The integration's OAuth access token (protocol §4) |
| Provider → integration | Discovery queries, events (including preference updates and invalidations) | Provider-signed JWTs from the issuer `jwks_uri` (§4.1, §6) |
| Consumer → integration | Invoking a brokered resource directly | A provider-minted brokered access token (§5.3) |

## 2. Integration manifest

### 2.1 Location and binding

The integration manifest is the `bindle_integration` member of the integration's OAuth client metadata: the [client ID metadata document](protocol.md#2-discovery-and-login) when the provider resolves one, otherwise the operator registration. It is therefore bound to the exact `client_id` and fetched, bounded, cached and snapshotted under the existing client-metadata rules. A provider does not fetch integration manifests from any other location.

An integration that declares `events_endpoint`, `resources`, or an `occupant` extension MUST be a confidential client: its client metadata declares `token_endpoint_auth_method: "private_key_jwt"` and a `jwks_uri` on the `client_id` origin ([RFC 7523](https://www.rfc-editor.org/rfc/rfc7523.html)). A public client may still declare `setup` and `consumer` extensions.

```json
{
  "client_id": "https://inbox.example/bindle/client.json",
  "client_name": "Example Inbox",
  "redirect_uris": ["https://inbox.example/bindle/callback"],
  "initiate_login_uri": "https://inbox.example/bindle/start",
  "token_endpoint_auth_method": "private_key_jwt",
  "jwks_uri": "https://inbox.example/bindle/jwks.json",
  "bindle_integration": {
    "v": 1,
    "setup": {
      "fragments": [
        {"id": "https://inbox.example/preferences/inbox-settings/v1", "required": true,
         "purpose": "Where to store your messages.", "fields": ["store", "retention"]}
      ]
    },
    "management_url": "https://inbox.example/manage",
    "events_endpoint": "https://inbox.example/bindle/events",
    "resources": {
      "rpc_endpoint": "https://inbox.example/bindle/rpc",
      "discovery_endpoint": "https://inbox.example/bindle/resources",
      "contracts": ["https://spec.bindle.example/contracts/public-intake/v1"],
      "dpop": true
    },
    "extensions": [
      {"slot": "https://spec.bindle.example/slots/public-message-intake/v1", "role": "occupant", "ref": "inbox"},
      {"slot": "https://spec.bindle.example/slots/item-classifier/v1", "role": "consumer", "ref": "triage",
       "purpose": "Sort incoming messages."}
    ]
  }
}
```

### 2.2 Members

| Member | Meaning |
| --- | --- |
| `v` | Manifest version; this draft defines `1`. Unknown versions: the member is ignored and the client is treated as a plain application. |
| `setup.fragments` | Fragment requests the integration needs to be configured, in the protocol §3 request shape. They are requested at authorization exactly as an application requests fragments. Listing them here lets the provider start setup from its own interface (§3.2). At most 8. |
| `management_url` | The integration's own management interface, where the owner manages its upstream accounts and creates or deletes its resources (§4.5). |
| `events_endpoint` | Receives provider events (§6). Absent: the integration receives no events and MUST pull configuration itself. |
| `resources.rpc_endpoint` | The single endpoint where every brokered resource of this integration is invoked (§5). |
| `resources.discovery_endpoint` | Search, filter and browse endpoint (§4). Required with `rpc_endpoint`. |
| `resources.contracts` | Nonempty list of at most 32 contract URLs the integration may offer. A discovery result claiming a contract outside this list is dropped. |
| `resources.dpop` | Boolean: whether `rpc_endpoint` verifies DPoP-bound brokered tokens (§5.4). Default `false`. |
| `extensions` | [Extension declarations](extensions.md#4-extension-declarations). |

Every URL MUST be HTTPS on the `client_id` origin, without userinfo, query or fragment. `events_endpoint`, `rpc_endpoint` and `discovery_endpoint`, when present, MUST be pairwise distinct, so that an audience value identifies exactly one purpose. The serialized member is at most 8 KiB and the whole document stays within the client-metadata bound. Unknown members are ignored. An invalid member is treated as absent. If `resources` is invalid, the integration offers no brokered resources.

### 2.3 Snapshot and change

The provider pins the validated manifest in the connection at approval. Refetching follows the client-metadata cache rules. A changed manifest is handled as follows:

| Change | Effect |
| --- | --- |
| `management_url`, `events_endpoint`, `rpc_endpoint`, `discovery_endpoint` changed within the `client_id` origin | Adopted at the next refetch after validation and recorded in the audit log. The origin is the trust principal, and it is unchanged. Tokens already minted for the old `rpc_endpoint` audience expire normally; new tokens use the new audience. |
| `resources.contracts` narrowed | Adopted immediately. Brokered resources lose those contracts; grants on them become unusable. |
| `resources.contracts` widened, `setup.fragments` changed, `extensions` changed, `resources.dpop` changed from `true` to `false` | Staged for owner review. Until approved, the pinned values govern. A grant never expands without fresh consent (protocol §4). |
| `bindle_integration` removed or invalid | The connection enters `degraded` (§3.1). Events stop and new brokered tokens are not minted until the owner reviews. |

Built-in integration manifests change only with provider releases, under the same rules.

## 3. Connection lifecycle

### 3.1 States

| State | Meaning |
| --- | --- |
| `authorizing` | The owner is in the authorization flow. No connection exists yet beyond the pending request. |
| `configuring` | Authorized; at least one required setup fragment or required slot (`required: true` consumer extension) is not yet configured and approved. The integration can read only approved fragments. No brokered tokens are minted for its resources. |
| `active` | Fully configured. Events are delivered, discovery is available and brokered resources can be assigned and used. |
| `degraded` | Active, but events have failed beyond the retry window (§6.4), the manifest became invalid, or discovery is failing. Brokered tokens continue to be minted unless the owner suspends; the owner is informed. |
| `suspended` | The owner paused the connection. Equivalent to disconnected for authority (no tokens, no events except `connection-revoked` with `terminal:false`, no RPC), but configuration is retained. Resuming increments the generation. |
| `disconnected` | Severed (§7). The record is retained as a tombstone with its final generation. Reconnecting requires a fresh authorization and creates a new generation; no old grant revives. |

Only the owner, through the provider's authenticated owner interface, moves a connection to `suspended` or `disconnected`, or resumes it. Account recovery, suspension or deletion severs every connection as part of the existing authority-epoch rules.

### 3.2 Installation

Installation starts either way:

- **Integration-initiated.** The integration runs the ordinary authorization flow (protocol §2) and requests its `setup.fragments`.
- **Provider-initiated.** From its own interface, the provider sends the owner by top-level navigation to the client's `initiate_login_uri` with `iss` set to the issuer, following [OpenID Connect third-party-initiated login](https://openid.net/specs/openid-connect-core-1_0.html#ThirdPartyInitiatedLogin). The integration MUST verify that `iss` is a Bindle provider through ordinary discovery, then start the same authorization flow. The provider MUST NOT treat the navigation as authorization.

Built-in integrations skip OAuth. The owner's explicit action in the provider's authenticated interface is the authorization, and the provider MUST show the same consent disclosures as for an external integration (protocol §3) derived from the built-in manifest.

Configuration uses ordinary fragment configuration. Setup fragments and other fragments use the same configuration interface. The protocol does not distinguish them after approval. An integration that needs owner interaction on its own site (for example linking an upstream account) uses its own pages after the authorization callback. Returning the owner to the provider is presentation.

### 3.3 Connection binding at code exchange

When the provider declares `integrations.v1`, and the client authenticated at the token endpoint with `private_key_jwt`, and its pinned manifest is valid, the token response includes:

```json
"bindle_connection": {"id": "c_5c0f…", "generation": 3, "state": "configuring"}
```

`id` is an opaque, provider-assigned identifier for this entity–integration connection, unique per issuer and stable across generations. It never reveals the entity locator. The integration keys all connection state by (`iss`, `id`) and checks that the token's subject is the entity it expects. The member is never returned to a public client, and never in any response other than the authenticated token response.

## 4. Resource discovery

Integrations do not publish static resource lists. The provider asks the integration, on the owner's behalf, which resources it can offer.

### 4.1 Discovery request

Only the provider calls the discovery endpoint, and only for an owner action in its authenticated interface or for revalidation (§4.4). Applications never query an integration's discovery endpoint through the provider; they see only resources the owner assigned and approved.

```http
POST /bindle/resources HTTP/1.1
Host: inbox.example
Authorization: Bearer <provider-minted JWT>
Content-Type: application/json

{"v":1,"contracts":["https://spec.bindle.example/contracts/public-intake/v1"],
 "text":"work","facets":{},"parent":null,"ids":null,"cursor":null,"limit":50}
```

The bearer is a provider-minted token in the §5.3 format with `aud` equal to `discovery_endpoint`, `client_id` equal to the issuer, `bindle.purpose` equal to `discover`, and the connection's `id` and current `generation`. It has no `resource` or `methods`. Lifetime is at most 60 seconds.

| Member | Meaning |
| --- | --- |
| `contracts` | Exact contract URLs, AND semantics. Each MUST appear in the manifest's `resources.contracts`. |
| `text` | Optional owner-entered search text, at most 200 characters. The provider discloses that search text is sent to the integration. |
| `facets` | Optional object keyed by contract URLs present in `contracts`. Each value follows that contract's published facet schema. Core defines no facets. |
| `parent` | Optional container resource ID from an earlier result, for browsing. |
| `ids` | Optional list of at most 50 resource IDs to look up exactly (revalidation). Mutually exclusive with `text`, `facets` and `parent`. |
| `cursor`, `limit` | Opaque cursor from the previous page; page size 0–100. |

### 4.2 Discovery response

```json
{"v":1,"items":[
  {"id":"https://inbox.example/r/7f3a","label":"Work inbox","description":"Messages for work",
   "contracts":["https://spec.bindle.example/contracts/public-intake/v1"],
   "container":false,"facets_applied":[]}
 ],"cursor":null}
```

With `limit: 0` the response is `{"v":1,"items":[],"exists":true|false}`: whether any resource matches. This answers "do you provide resources satisfying contract X".

The integration MUST apply every requested contract and facet, or fail the whole request with error code `unsupported_facet`. It MUST NOT silently ignore a constraint. Items are resources of the authenticated connection's entity only.

The provider validates every item and drops invalid ones: `id` MUST be an HTTPS URL on the `rpc_endpoint` origin, at most 512 characters; `label` at most 100 and `description` at most 500 characters of inert plain text; `contracts` MUST include every requested contract and only contracts in the manifest's list; at most 100 items and 64 KiB per response. Container items are browsable. They are assignable only if they claim the requested contracts. The provider uses the SSRF-safe egress rules of protocol §2 (HTTPS, no redirects, private-address screening on every connection, bounded size and time) under per-connection and global budgets, and caches responses for at most 5 minutes per (connection, generation, query).

### 4.3 Registering a brokered resource

When the owner selects a discovered item, for a preference field or a slot, the provider creates a **brokered resource record** in the owner's pool: `{id, connection, generation, label, contracts, rpc_endpoint}`. `contracts` is the intersection of the item's claim, the manifest list and the field's required contracts. The record is an ordinary resource for preferences and grants, except that the provider never invokes it through its own gateway on behalf of applications. A provider bounds brokered records per connection (at least 64 SHOULD be supported) and per account.

The resource ID is the integration's ID. It is not secret and not a credential. Consumers use it in the RPC envelope at `rpc_endpoint`.

### 4.4 Revalidation and change hints

The provider revalidates registered records with `ids` lookups: when a change hint arrives (§8), when the owner opens the connection, and at least daily while the connection is `active`. An ID missing from a successful response marks the record `unavailable` (not deleted). A narrowed contract claim removes those contracts from the record, making methods on them unusable. A widened claim is ignored until the owner reassigns. A network failure leaves records unchanged and the connection health is updated.

### 4.5 Creating and managing resources

Integrations create, rename and delete their resources in their own interface at `management_url`. The provider MAY navigate the owner there top-level, adding `iss` and, when the owner is choosing a resource for a field, `bindle_intent=create` and `contracts` (space-separated) as hints. The integration MUST validate these as untrusted hints. When it returns the owner to the provider, it navigates only to the issuer origin. After creation the integration sends a change hint. The provider then runs discovery and the owner selects the new resource. No resource ID passed through navigation is ever trusted without an authenticated discovery result.

## 5. Brokered resources

A brokered resource is invoked directly at the integration's `rpc_endpoint`. The provider brokers the introduction and owns the credential that couples consumer and integration, but it is not on the invocation path.

### 5.1 Preferences projection

For a brokered resource, the [preferences](contracts.md#preferences-v1) projection of an approved field value carries:

```json
{"resource":{"id":"https://models.example/r/abc","label":"Fast model",
  "contracts":["https://spec.bindle.example/contracts/decision-model/v1"]},
 "broker":{"endpoint":"https://models.example/bindle/rpc","origin":"https://models.example"},
 "token":"eyJ…","token_type":"Bearer","expires_at":1792500000}
```

`broker` identifies the projection as brokered. A consumer invokes the resource only at `broker.endpoint`, with the protocol §5 envelope and `token`. Consumers treat `token` as opaque. Issuer-hosted resources have no `broker` member and keep the existing projection.

### 5.2 Consent disclosure

Before a consumer is approved for a brokered resource, the provider MUST disclose, in addition to protocol §3: the integration's verified origin as the party that receives the consumer's requests and data directly; that the provider does not see, store or recall that traffic; that the integration's contract claims are unverified; and the severance bound (§7.3).

### 5.3 Consumer credentials

Brokered access tokens are [JWT access tokens (RFC 9068)](https://www.rfc-editor.org/rfc/rfc9068.html) signed by the provider with a key published at the issuer's `jwks_uri`. ES256 is required. The header `typ` is `at+jwt`.

```json
{"iss":"https://example.org","sub":"https://example.org/entities/e_123",
 "aud":"https://models.example/bindle/rpc","client_id":"https://notes.example/client.json",
 "iat":1792499700,"exp":1792500000,"jti":"0b6f…",
 "bindle":{"v":1,"purpose":"invoke","connection":"c_5c0f…","generation":3,
   "resource":"https://models.example/r/abc","grant":"g_81d2…",
   "methods":{"https://spec.bindle.example/contracts/decision-model/v1":["decide"]},
   "scope":null},
 "cnf":{"jkt":"…"}}
```

| Claim | Meaning |
| --- | --- |
| `aud` | Exactly the integration's `rpc_endpoint` (or `discovery_endpoint` for `purpose: discover`). |
| `client_id` | The consumer application, or the issuer URL itself when a provider feature is the consumer ([extensions §5.3](extensions.md#53-provider-consumers)). |
| `exp` − `iat` | At most 300 seconds. |
| `bindle.connection`, `bindle.generation` | The coupling. |
| `bindle.resource` | The single resource this token authorizes. |
| `bindle.grant` | An opaque identifier for the consumer's current approval of this resource in this field binding. It changes on every reassignment, scope change or reapproval. |
| `bindle.methods` | The exact approved contract → methods map, the intersection of the grant, the field assignment and the record's contracts. |
| `bindle.scope` | `null`, or a normalized scope selection the integration has declared it enforces (§5.6). |
| `cnf.jkt` | Present when DPoP-bound (§5.4). |

The provider mints a token only when every live check passes at minting time: account active and current authority epoch; connection `active` or `degraded` at the current generation; grant live; assignment current; brokered record available; and the consumer's own session valid. Tokens are minted on each preferences read that projects the resource. A consumer refreshes by reading preferences again. There is no separate refresh credential for brokered resources, so a consumer that can no longer obtain tokens from the provider loses access within one token lifetime.

The issuer's own RPC endpoint MUST reject any brokered access token or discovery token. Brokered tokens and the issuer's opaque RPC tokens are never interchangeable.

### 5.4 Sender constraint

When the consumer's session with the provider is DPoP-bound ([auth](auth.md#token-lifetime-and-client-sessions)) and the pinned manifest declares `resources.dpop: true`, the provider MUST bind the token to the consumer's key (`cnf.jkt`) and return `token_type: "DPoP"`. The integration then requires a DPoP proof whose `htu` is `rpc_endpoint`. The decision uses only the pinned manifest and the consumer's session; a consumer cannot request an unbound token instead.

### 5.5 Resource-server validation

An integration's `rpc_endpoint` MUST, for every request, verify:

1. a JWS with `alg` ES256 and `typ` `at+jwt`, signed by a key from the `jwks_uri` of the issuer's manifest, fetched under the protocol §2 manifest rules and cached for at most one hour (refetch on an unknown `kid` at most once per minute);
2. `iss` equals the issuer recorded for (`iss`, `bindle.connection`), and `sub` equals that connection's entity;
3. `aud` equals its `rpc_endpoint` exactly, and `bindle.purpose` is `invoke`;
4. `iat` and `exp` within 60 seconds of clock skew, and `exp − iat ≤ 300`;
5. `bindle.generation` is at least the connection's revocation floor, and `bindle.grant` is not in the revoked set (§7.2);
6. the envelope's `resource`, `contract` and `method` match `bindle.resource` and `bindle.methods`, and the resource belongs to that entity;
7. the DPoP proof, when `cnf` is present.

Failures 1–5 return HTTP 401; failure 6 returns 403 without revealing hidden resources. The journal key is (`iss`, `sub`, `client_id`, `tx`) with the protocol §5 fingerprint and retention. Error envelopes follow protocol §5.

### 5.6 Scoping

A brokered resource is whole-resource by default. If the integration implements the [resource-scoping](../architecture/resource-scoping.md) contract on a resource, the provider calls its `describe` method with a discovery-purpose token to present controls, stores the owner's normalized selection in the field value, and places it in `bindle.scope`. The integration MUST enforce `bindle.scope` and MUST reject a token with a non-null `scope` for a resource it cannot scope. A provider MUST NOT present scope controls for a brokered resource that does not implement scoping.

### 5.7 Optional introspection

A provider MAY declare `introspection_endpoint` in `brokered-resources.v1` ([RFC 7662](https://www.rfc-editor.org/rfc/rfc7662.html), issuer origin). Integrations authenticate to it with `private_key_jwt`. A contract or slot MAY require introspection before methods it marks sensitive, giving revocation without the token-lifetime delay at the cost of depending on the provider's availability. Introspection results MAY be cached for at most 30 seconds.

## 6. Events

### 6.1 Delivery

The provider delivers events to `events_endpoint` as [Security Event Tokens (RFC 8417)](https://www.rfc-editor.org/rfc/rfc8417.html) using [push delivery (RFC 8935)](https://www.rfc-editor.org/rfc/rfc8935.html): `POST` with `Content-Type: application/secevent+jwt`. Each SET is signed with an issuer key (ES256, header `typ` `secevent+jwt`) and carries `iss`, `aud` (exactly `events_endpoint`), `iat`, `jti`, `sub` (the entity), and one event in `events`. Every event payload contains `connection`, `generation` and `seq`, a per-connection counter that increases strictly with each event the provider emits.

The integration verifies the signature and claims as in §5.5 steps 1, 2 and 4, rejects `jti` values seen within the last 10 minutes, and rejects `iat` older than 10 minutes unless the event is a revocation (revocations are always applied). It answers 202 to acknowledge. Per RFC 8935, a 400 with an error code is a permanent rejection. Any other response or network failure is retried.

### 6.2 Event types

| Event identifier (placeholder) | Payload beyond `connection`, `generation`, `seq` | Integration obligation |
| --- | --- | --- |
| `…/events/preferences-updated/v1` | `fragment`, `revision`, `values` | Replace its configuration for `fragment` with `values` if `seq` is greater than the last applied `seq` for that fragment. Otherwise ignore. |
| `…/events/credential-revoked/v1` | `grants` (list of `bindle.grant` values), `until` | Reject brokered tokens carrying those grants until `until`. |
| `…/events/connection-revoked/v1` | `generation_floor`, `terminal` | Reject tokens with `bindle.generation` below the floor. If `terminal`, stop all processing for the connection's older generations and apply its own retention policy. |
| `…/events/resource-detached/v1` | `resource` | Informational: the owner removed the record from the provider. The integration MAY clean up. |

`values` is the full current approved projection of the fragment's granted fields: atomic values, and resource references as `{id, label, contracts}` with no token and no broker credential. It is `null` when the integration's grant on that fragment is revoked. A full snapshot plus `seq` makes delivery idempotent and order-insensitive: no diffs are merged. Revocation events apply regardless of `seq` order, because floors only rise and revoked sets only grow during their window.

### 6.3 Preference-update webhook

The `preferences-updated` event is the webhook for configuration changes after setup. The provider emits it after every committed change to a granted field of a fragment the integration holds, after grant revocation, and after reapproval. It is enqueued in the same transaction as the change (transactional outbox) and coalesced: when several changes are pending for one fragment, only the latest snapshot needs delivery. An integration that misses events, or has none configured, reads `@preferences` at any time and treats the read as authoritative.

### 6.4 Retry and degradation

The provider retries with exponential backoff (initial at most 10 seconds, maximum interval at most one hour) for at least 72 hours. Revocation events are retried before other events. After the retry window, undelivered non-revocation events are dropped, the connection becomes `degraded`, and the owner is informed. Undelivered revocation events are recorded as unacknowledged (§7.3); safety does not depend on them. Event delivery uses the provider's SSRF-safe egress with bounded response size and time.

## 7. Severance

### 7.1 Operations

| Operation | Trigger | Provider commit | Event |
| --- | --- | --- | --- |
| Disconnect | Owner disconnects the integration; account recovery, suspension or deletion | Connection `disconnected`, generation incremented | `connection-revoked` with `terminal: true` |
| Suspend | Owner suspends | Connection `suspended`, generation incremented | `connection-revoked` with `terminal: false` |
| Revoke a consumer | Owner revokes a consumer's grant, removes the resource from the field, changes scope, or replaces the occupant of a slot | New `bindle.grant` for any remaining approval; old one revoked | `credential-revoked` for the old grant identifiers |
| Detach a resource | Owner removes the brokered record from the pool | Record removed; every assignment of it removed | `credential-revoked` for every grant on it, then `resource-detached` |

### 7.2 Ordering

The provider MUST perform severance in this order:

1. **Commit.** In one local transaction: change the authority state (connection state and generation, grant identifiers, assignments) and enqueue the events. From this commit, the provider mints no token that the change invalidates, projects affected resources as `unavailable`, and stops provider-feature consumption.
2. **Deliver.** Send the events (§6.4). Revocation events take priority.
3. **Bound.** Record `access_ends_by = commit time + 300 s + 60 s` (maximum token lifetime plus allowed skew).

The integration maintains: a generation floor per connection (only rises); a revoked-grant set whose entries it keeps until their `until` (at least `access_ends_by`), after which they can be discarded because every token carrying them has expired. Its revocation state is therefore bounded by the number of revocations in a six-minute window.

### 7.3 Guarantees and limits

- **Bound without cooperation.** Whether or not the integration receives or honors the event, no consumer obtains a valid new token after the commit, so every consumer credential expires by `access_ends_by`. The provider reports `access_ends_by` and acknowledgment status to the owner.
- **Immediate with cooperation.** A conforming integration that acknowledges a revocation rejects old tokens from that moment.
- **Not recall.** Requests admitted before revocation may complete. Data already returned, and data the integration holds, are not recalled. The integration remains independently responsible for the data it stores; disconnect does not delete it.
- **Introspection** (§5.7) removes the token-lifetime delay for contracts that require it.

### 7.4 Races

| Race | Resolution |
| --- | --- |
| Token minted concurrently with the commit | Minting checks authority inside the same serialization domain as the commit (the account's single writer). A token is either minted before the commit (and bounded by `access_ends_by`) or refused. |
| Revocation event arrives before an earlier `preferences-updated` | Revocations apply regardless of order; the stale update is ignored when its `seq` is lower. |
| Reconnect while a `terminal` revocation is still in flight | The reconnect creates a higher generation. The floor in the in-flight event is below it, so delivering it late cannot cut off the new generation. |
| Owner removes and re-adds the same resource | Re-adding creates a new `bindle.grant` and requires consumer approval. The old grant stays revoked. |
| Integration offline during severance | The bound in §7.3 holds. Events are retried for 72 hours. |
| Provider offline after commit | Commit is durable; delivery resumes when the provider returns. Consumers cannot obtain new tokens while it is offline. |
| Integration rotates `rpc_endpoint` during severance | Tokens are rejected by the old audience check at the new endpoint and expire anyway. |

## 8. Integration-to-provider change hints

An integration tells the provider that its resources changed by POSTing to the `hint_endpoint` declared in `integrations.v1`:

```json
{"v":1,"connection":"c_5c0f…","client_assertion_type":"urn:ietf:params:oauth:client-assertion-type:jwt-bearer","client_assertion":"eyJ…"}
```

The client assertion follows RFC 7523, signed by a key from the integration's `jwks_uri`, with `iss` and `sub` equal to its `client_id` and `aud` equal to `hint_endpoint`. A hint carries no data and no authority. It only schedules revalidation (§4.4) for that connection, so a forged or replayed hint costs at most one bounded discovery call. The provider answers 202 for every well-formed request, whether or not the connection exists, so the endpoint does not reveal connections. It rate-limits per client and connection, and coalesces hints arriving within 60 seconds.

## 9. Availability

| Party offline | Effect |
| --- | --- |
| Provider | Consumers cannot refresh brokered tokens. Brokered access ends within one token lifetime (fail closed). Integrations cannot read preferences or send hints. Queued events resume on return. Provider consumers (for example an email bridge) stop with the provider. |
| Integration | Its resources fail with `temporarily_unavailable` or network errors. `ordered` slots fail over where permitted ([extensions §3.2](extensions.md#32-failover-for-ordered)). Events and revalidation are retried. Setup cannot complete steps on the integration's own pages. The connection becomes `degraded` after the retry window. |
| Consumer | No effect on others. |
| Slot or fragment publisher | Pinned copies govern ([extensions §7](extensions.md#7-versioning-change-and-disappearance)). |

## 10. Audit

The provider records, as owner-visible metadata without payloads: connection state transitions and generations; setup fragment approvals; manifest snapshot changes and staged reviews; discovery requests (time, connection, result count; not search text); brokered record registration, revalidation outcomes and removal; token minting aggregated per consumer, resource and hour; events emitted, acknowledged, permanently rejected or expired; hints accepted and rate-limited; and, for each severance, `access_ends_by` and acknowledgment time. Integrations SHOULD log `jti`, `client_id`, `connection` and `tx` for every brokered invocation.

## 11. Security requirements

1. **Origin binding.** Every integration URL is on the `client_id` origin (§2.2). Discovered resource IDs are on the `rpc_endpoint` origin (§4.2). Nothing in a discovery result, event, hint or navigation parameter can introduce another origin.
2. **Audience separation.** Discovery, invocation and event audiences are distinct URLs, and `bindle.purpose` distinguishes token purposes. The issuer RPC endpoint rejects all provider-minted JWTs. SETs (`secevent+jwt`) and access tokens (`at+jwt`) are distinct `typ` values, and each verifier MUST check `typ`.
3. **Least data.** Events carry no tokens or credentials. Tokens carry one resource and its exact methods. The consumer's own issuer access token is never sent to an integration. An integration never receives another integration's credentials or upstream credentials held by the provider.
4. **Egress.** All provider requests to integrations follow protocol §2 SSRF rules and per-connection, per-client and global budgets. Response bodies are bounded (discovery 64 KiB, event responses 4 KiB).
5. **Keys.** The provider signs with a dedicated key used only for brokered tokens, discovery tokens and SETs. Rotation publishes the new key before use and keeps the old key until every token it signed has expired. Integrations follow §5.5 caching.
6. **Unverified claims.** Contract claims, labels, descriptions and purposes from integrations are untrusted plain text and claims. They never earn a trusted badge.
7. **No silent expansion.** Manifest changes, discovery changes and slot changes never widen a grant (§2.3, §4.4).
8. **Bounded state.** Connections, brokered records, pending events and revoked-grant sets are bounded per account. Exhausted bounds fail visibly.

## 12. Feature declarations

| Feature | Members | Meaning | When absent |
| --- | --- | --- | --- |
| `integrations.v1` | `hint_endpoint` (issuer origin) | The provider processes `bindle_integration`, returns `bindle_connection`, delivers events, performs discovery and accepts hints. Requires a non-empty `jwks_uri` key set. | Clients are plain applications. Integrations pull configuration, and the provider has no discovery or events. |
| `brokered-resources.v1` | optional `introspection_endpoint` (issuer origin) | The provider registers brokered records, projects them with minted tokens and performs §7 severance. Requires `integrations.v1`. | Only issuer-hosted resources exist. |

## 13. Conformance tests

Tests MUST cover: manifest origin violations and endpoint collisions; public clients denied `bindle_connection`; snapshot change handling for each row of §2.3; both installation paths; each lifecycle transition, including built-in integrations; discovery validation (foreign-origin IDs, contracts outside the manifest, silently ignored facets, oversize responses, redirects, private addresses); `limit: 0` probes; revalidation marking `unavailable` and narrowing; token claims and every §5.5 check, including cross-audience, cross-resource, cross-connection and cross-issuer replay; DPoP binding and downgrade attempts; issuer RPC rejecting minted JWTs; SET signature, audience, `typ`, `jti` replay and `seq` ordering; out-of-order revocation; the §7.2 ordering and every §7.4 race; severance with the integration offline; hint forgery, enumeration and flooding; and audit records for each operation.
