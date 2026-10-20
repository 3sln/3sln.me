# Integrations, resource discovery and brokered resources — normative draft

Status: **provisional draft, 2026-10-20, revision 2.** Revision 1 was wargamed by two independent reviewers; revision 2 answers every finding. See the [extensibility review](../release/extensibility-review.md). Rationale and migration: [extensibility design](../architecture/extensibility-design.md). Human sign-off: reviewer ___ / date ___ / outcome ___. Track the decision in [DEVLOG](../../DEVLOG.md). Nothing here is implemented or production-verified.

This document extends [protocol](protocol.md), [auth](auth.md), [contracts](contracts.md), [resource contributions](resource-contributions.md) and [extensions](extensions.md). It defines interoperability rules only: no user interface beyond the security disclosures it lists, and no SDK behavior. Identifiers under `https://spec.bindle.example/` are placeholders. §14 lists the amendments this draft needs in existing core documents. They are proposed (approved provisionally 2026-10-20) and applied to the core drafts; runtime work remains deferred to [EXT-X1](../architecture/implementation-roadmap.md#ext-x1-deferred-code-from-wave-0).

## 1. Model

An **integration** is any party that connects to an entity's provider to do one or more of the following:

- configure itself;
- contribute resources;
- occupy or consume [slots](extensions.md);
- receive configuration changes.

Applications and integrations are one concept. There are two kinds of implementation, and the protocol treats them identically wherever the difference would be observable:

- **external**: an OAuth client operated by a third party. It may have a full front end, or nothing beyond an initiate-login endpoint, a redirect URI and server endpoints.
- **built-in**: implemented inside the provider, for example a managed Google Drive adapter. It has no network endpoints and no client credentials. The provider authors its integration manifest and applies the same setup, consent, lifecycle and severance rules. Upstream accounts a built-in connects (for example several Google accounts) are separate resources under one connection.

The owner's approval of an integration creates one **connection** per entity and integration. A connection is the existing owner-scoped app connection resource ([resource contributions](resource-contributions.md), DEVLOG D057), extended with:

- a pinned integration manifest snapshot;
- a lifecycle state;
- a **generation**.

The connection is the coupling between the entity and the integration. The provider owns it and can sever it unilaterally (§7).

| Direction | Purpose | Authenticated by |
| --- | --- | --- |
| Integration → provider | Ordinary RPC: `@preferences`, contributed resources, notifications | The integration's OAuth access token, renewable offline through its connection-bound refresh token (§3.4) |
| Provider → integration | Discovery queries, scoping `describe`, events | Provider-signed JWTs from the brokering key set (§5.3, §6) |
| Consumer → integration | Invoking a brokered resource directly | A provider-minted brokered access token (§5.3) |
| Integration → provider (hint) | "My resources changed" | An RFC 7523 client assertion (§8) |

## 2. Integration manifest

### 2.1 Location, binding and client type

The integration manifest is the `bindle_integration` member of the integration's OAuth client metadata. That is the [client ID metadata document](protocol.md#2-discovery-and-login) when the provider resolves one, and the operator registration otherwise. The manifest is therefore bound to the exact `client_id`, and it is fetched, bounded, cached and snapshotted under the existing client-metadata rules. A provider never fetches integration manifests from any other location.

An integration MUST be a **confidential client** if it declares any of:

- `events_endpoint`;
- `resources`;
- an `occupant` extension.

A confidential client declares `token_endpoint_auth_method: "private_key_jwt"` and a `jwks_uri` on the `client_id` origin ([RFC 7523](https://www.rfc-editor.org/rfc/rfc7523.html)). A public client may still declare `setup` and `consumer` extensions.

A provider that does not declare `integrations.v1` MUST refuse a confidential client document outright (AMD-C7 — proposed (approved provisionally 2026-10-20)). Today's client-metadata validation does so (§14, amendment C7). Before authorization, an integration MUST therefore check the provider's `integrations.v1` and `token_endpoint_auth_methods_supported`. If either is missing, the integration either uses a separate public-client `client_id` document without these members, or does not connect.

**Path prefix.** Every URL in the manifest MUST be HTTPS on the `client_id` origin, without userinfo, query or fragment. It MUST also share the `client_id`'s path prefix: the `client_id` path up to and including its last `/`. This applies to `jwks_uri` and `redirect_uris` too. A provider SHOULD refuse `bindle_integration` from a `client_id` origin it classifies as multi-tenant hosting, unless an operator registered the client. The issuer origin itself MUST NOT host an external integration's endpoints.

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
    "management_url": "https://inbox.example/bindle/manage",
    "events_endpoint": "https://inbox.example/bindle/events",
    "events": ["https://spec.bindle.example/events/preferences-updated/v1"],
    "resources": {
      "rpc_endpoint": "https://inbox.example/bindle/rpc",
      "discovery_endpoint": "https://inbox.example/bindle/resources",
      "contracts": ["https://spec.bindle.example/contracts/public-intake/v1"],
      "dpop": "supported"
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
| `v` | Manifest version; this draft defines `1`. A document MAY carry `bindle_integration` (v1) alongside a future, differently named member for later versions. |
| `setup.fragments` | Fragment requests the integration needs in order to be configured, in the protocol §3 request shape (at most 8). They are requested at authorization, exactly as any application requests fragments. Listing them here lets the provider start setup from its own interface (§3.2). |
| `management_url` | The integration's own management interface. The owner uses it to manage upstream accounts and to create or delete resources (§4.5). |
| `events_endpoint` | Receives provider events (§6). When absent, the integration receives no events and pulls configuration itself. |
| `events` | Event identifiers the integration subscribes to, beyond revocation events, which are always sent. Default: `preferences-updated` only. |
| `resources.rpc_endpoint` | The single endpoint at which every brokered resource of this integration is invoked (§5). |
| `resources.discovery_endpoint` | Search, filter and browse endpoint (§4). Required with `rpc_endpoint`. |
| `resources.contracts` | Nonempty list of at most 32 contract URLs that the integration may offer. A discovery result claiming any other contract is dropped. |
| `resources.dpop` | `"none"` (default), `"supported"` or `"required"` (§5.4). |
| `extensions` | [Extension declarations](extensions.md#4-extension-declarations). |

`events_endpoint`, `rpc_endpoint` and `discovery_endpoint`, when present, MUST be pairwise distinct, so that each audience value names exactly one purpose. The serialized member is at most 8 KiB, and the whole document stays within the client-metadata bound. Unknown members are ignored. An invalid member is treated as absent. If `resources` is invalid, the integration offers no brokered resources.

### 2.3 Snapshot and change

At approval the provider pins three things in the connection:

- the validated manifest;
- the client's `jwks_uri` and `token_endpoint_auth_method`;
- the JWK thumbprints of the key set fetched at that time.

Refetching follows the client-metadata cache rules. Changes are handled as follows.

| Change | Effect |
| --- | --- |
| `management_url`, `events_endpoint`, `rpc_endpoint` or `discovery_endpoint` changed within the origin and path prefix | Adopted at the next refetch after validation, and audited. Tokens minted for an old audience expire normally. |
| `resources.contracts` narrowed | Adopted immediately. Brokered records lose those contracts, and grants on them become unusable. |
| Key set rotated, with at least one pinned key still present | Adopted. The pinned thumbprints are replaced with the new set. |
| Key set replaced with no pinned key present; or `jwks_uri`, `token_endpoint_auth_method` or `redirect_uris` changed | **Staged for owner review.** Until approved, the provider sends no events, performs no discovery, mints no tokens for this integration's resources, and accepts no hints or token-endpoint authentication with the new keys. This protects against takeover of an expired domain. |
| `resources.contracts` widened; `setup.fragments`, `extensions` or `events` changed; `resources.dpop` weakened | Staged for owner review. The pinned values govern until then, and no grant expands without fresh consent (protocol §4). |
| Unknown `v` | The pinned snapshot is kept and an owner review is staged. The connection never degrades because of this. |
| `bindle_integration` removed or invalid; a client-metadata fetch failing definitively (404/410) | `manifest-invalid` (§3.1). |
| Transient fetch failure | No change; the pinned snapshot continues. |

Owner notices about manifest changes are coalesced: at most one per connection per day. Built-in integration manifests change only with provider releases, under the same rules.

## 3. Connection lifecycle

### 3.1 States

| State | Meaning |
| --- | --- |
| `authorizing` | The owner is in the authorization flow. No connection exists yet beyond the pending request. |
| `configuring` | Authorized, but at least one required setup fragment or required slot (`required: true`, [extensions §3.1](extensions.md#31-availability-and-representation)) is not configured and approved. The integration can read only approved fragments. No brokered tokens are minted for its resources. |
| `active` | Fully configured. Events are delivered, discovery is available, and brokered resources can be assigned and used. |
| `degraded` | Active, with a health problem: events failed beyond the retry window (§6.4), or discovery is failing. Minting continues, and the owner is informed. |
| `manifest-invalid` | The manifest was removed or became invalid, or a security-relevant change awaits review (§2.3). No events, discovery or minting, and refresh tokens are not honored. Leaving this state requires the problem to be cleared or the owner to approve the staged change. |
| `suspended` | The owner paused the connection. For authority it is equivalent to `disconnected`: no tokens, no RPC, and only the `connection-revoked` event with `terminal: false`. Configuration is retained. Resuming increments the generation and sends `connection-resumed`. |
| `disconnected` | Severed (§7). The record is kept as a tombstone with its final generation. Reconnecting requires a fresh authorization and creates a new generation; no old grant revives. |

Only the owner, through the provider's authenticated owner interface, suspends, resumes or disconnects a connection. Account recovery, suspension or deletion severs every connection, as part of the existing authority-epoch rules.

### 3.2 Installation

Installation starts in one of two ways.

- **Integration-initiated.** The integration runs the ordinary authorization flow (protocol §2) and requests its `setup.fragments`.
- **Provider-initiated.** From its own interface, the provider sends the owner by top-level navigation to the client's `initiate_login_uri`, with `iss` set to the issuer, following [OpenID Connect third-party-initiated login](https://openid.net/specs/openid-connect-core-1_0.html#ThirdPartyInitiatedLogin).

When the integration receives an `iss` value, it:

- treats `iss` as untrusted input;
- fetches its manifest under the protocol §2 SSRF rules;
- confirms the issuer host with the user before binding the result to an existing session;
- then starts the authorization flow.

The navigation alone is never authorization.

Built-in integrations do not use Bindle OAuth. The owner's explicit action in the provider's authenticated interface is the authorization. The provider MUST show the same consent disclosures as for an external integration (protocol §3), derived from the built-in manifest. Upstream authorization, such as Google OAuth, follows that integration's own design.

Configuration uses ordinary fragment configuration, and setup fragments are indistinguishable from other fragments after approval. An integration that needs owner interaction on its own site, such as linking an upstream account, uses its own pages after the authorization callback.

### 3.3 Connection binding at code exchange

The token response includes a `bindle_connection` member when all of the following hold:

- the provider declares `integrations.v1`;
- the client authenticated at the token endpoint with `private_key_jwt`;
- its pinned manifest is valid.

```json
"bindle_connection": {"id": "c_5c0f…", "generation": 3, "state": "configuring"}
```

`id` is an opaque, provider-assigned identifier, unique per issuer and stable across generations. It is not secret: it appears in brokered tokens that consumers can read (§5.3). It MUST NOT encode the entity locator or any other private value. The integration MUST:

- reject the exchange unless the token's subject is an HTTPS URL on the `iss` origin;
- key all connection state by (`iss`, `id`);
- bind each resource it creates to (`iss`, `id`, `sub`), and check all three on every use.

This prevents a provider from asserting another provider's subject.

### 3.4 Offline access

Integrations act when no owner is present, so a confidential client with `bindle_connection` receives a **connection-bound refresh token**. It:

- rotates on every use, with reuse detection (auth);
- requires `private_key_jwt` client authentication with a pinned key;
- has no absolute lifetime while the connection is `active`, `configuring` or `degraded`;
- is revoked by the same commit that suspends, disconnects or marks the connection `manifest-invalid` (§7.2).

The issuer's other refresh-token bounds still apply: idle expiry, family limits, and live grant checks at each renewal.

## 4. Resource discovery

Integrations do not publish static resource lists. Instead, the provider asks the integration, on the owner's behalf, which resources it can offer.

### 4.1 Discovery request

Only the provider calls the discovery endpoint, and only for an owner action in its authenticated interface or for revalidation (§4.4). Applications never query an integration's discovery endpoint through the provider. They see only resources the owner assigned and approved for them.

```http
POST /bindle/resources HTTP/1.1
Host: inbox.example
Authorization: Bearer <provider-minted JWT>
Content-Type: application/json

{"v":1,"contracts":["https://spec.bindle.example/contracts/public-intake/v1"],
 "text":"work","facets":{},"parent":null,"ids":null,"cursor":null,"limit":50}
```

The bearer token is a provider-minted token in the §5.3 format, with these values:

| Member | Value |
| --- | --- |
| `aud` | `discovery_endpoint` |
| `client_id` | the issuer |
| `bindle.purpose` | `discover` |
| `bindle.connection`, `bindle.generation` | the connection's `id` and current generation |
| `bindle.resource`, `bindle.methods` | absent |

Its lifetime is at most 60 seconds.

| Member | Meaning |
| --- | --- |
| `contracts` | Exact contract URLs, combined with AND semantics. Each MUST appear in the manifest's `resources.contracts`. |
| `text` | Optional owner-entered search text, at most 200 characters. The provider discloses that search text is sent to the integration. |
| `facets` | Optional object keyed by contract URLs present in `contracts`. Each value follows that contract's published facet schema. Core defines no facets. |
| `parent` | Optional container resource ID from an earlier result, for browsing. |
| `ids` | Optional list of at most 50 resource IDs to look up exactly, for revalidation. Mutually exclusive with `text`, `facets` and `parent`. |
| `cursor`, `limit` | `cursor` is an opaque value of at most 1 KiB from the previous page. `limit` is the page size, 0–100. |

### 4.2 Discovery response

```json
{"v":1,"items":[
  {"id":"https://inbox.example/r/7f3a","label":"Work inbox","description":"Messages for work",
   "contracts":["https://spec.bindle.example/contracts/public-intake/v1"],
   "container":false,"facets_applied":[]}
 ],"cursor":null}
```

With `limit: 0`, the response is `{"v":1,"items":[],"exists":true|false}`, saying whether any resource matches. This answers "do you provide resources satisfying contract X?".

The integration MUST apply every requested contract and facet, or fail the whole request with error code `unsupported_facet`. Items are resources bound to the authenticated (`iss`, connection, `sub`) only.

The provider validates every item and drops invalid ones:

- `id` MUST be an HTTPS URL on the `rpc_endpoint` origin, at most 512 characters;
- `label` is at most 100 characters and `description` at most 500, both inert plain text;
- `contracts` MUST include every requested contract, and only contracts in the manifest's list;
- a response holds at most 100 items and at most 64 KiB.

Container items are browsable. They are assignable only if they claim the requested contracts.

The provider uses the SSRF-safe egress rules of protocol §2: HTTPS, no redirects, private-address screening on every connection, and bounded size and time. Calls run under per-connection and global budgets. Responses are cached for at most 5 minutes per (connection, generation, query).

**Endpoint validation.** The discovery endpoint MUST validate:

- the JWS (`alg` ES256, `typ` `at+jwt`), signed by a key from the issuer's brokering key set (§5.5 step 2);
- `aud` equal to its `discovery_endpoint`;
- `bindle.purpose` equal to `discover`;
- a known (`iss`, connection);
- a generation at or above its floor;
- time claims (§5.5 step 5).

### 4.3 Registering a brokered resource

When the owner selects a discovered item for a preference field or a slot, the provider creates a **brokered resource record** in the owner's pool:

`{record_id, connection, generation, integration_resource, label, contracts, rpc_endpoint}`

- `record_id` is a fresh opaque identifier assigned by the provider, unique per (connection, `integration_resource`), and used in grants and projections. The integration's string is never a provider key.
- `contracts` is the intersection of the item's claim, the manifest list and the field's required contracts.

The record is an ordinary resource for preferences and grants, except that the provider never invokes it through its own gateway on behalf of applications. A provider bounds brokered records per connection (it SHOULD support at least 64) and per account.

### 4.4 Revalidation and change hints

The provider revalidates registered records with `ids` lookups:

- when a change hint arrives (§8);
- when the owner opens the connection;
- at least daily while the connection is `active`.

Outcomes:

| Lookup outcome | Effect on the record |
| --- | --- |
| ID missing from a successful response | Marked `unavailable`. It becomes available again only after the owner reconfirms it. Integrations MUST NOT reuse resource IDs for different resources. |
| Narrowed contract claim | Those contracts are removed from the record. |
| Widened contract claim | Ignored until the owner reassigns. |
| Network failure | Records unchanged; connection health updated. |

### 4.5 Creating and managing resources

Integrations create, rename and delete their resources in their own interface at `management_url`. The provider MAY navigate the owner there top-level. It adds `iss`, and, when the owner is choosing a resource for a field, `bindle_management=create` and `contracts` (space-separated) as hints. The integration MUST validate all of these as untrusted (§3.2), and returns the owner only to the issuer origin.

After creating a resource, the integration sends a change hint. The provider then runs discovery and the owner selects the new resource. A resource ID passed through navigation is never trusted without an authenticated discovery result.

## 5. Brokered resources

A brokered resource is invoked directly at the integration's `rpc_endpoint`. The provider brokers the introduction and owns the credential that couples consumer and integration, but it is not on the invocation path. Brokering is an explicit exception to the issuer-gateway-only rule of protocol §4, with the bounds stated in §7 (amendment C8).

### 5.1 Preferences projection

A provider declaring `brokered-resources.v1` projects brokered values only through the preferences contract named in that feature's `preferences_contract` member: a `preferences/v2` contract (amendment C9). Consumers reading through preferences/v1 never receive brokered values. A brokered occupant is omitted for them, and the field is listed in `requiresConsent`.

Under v2, every resource-field value, issuer-hosted or brokered, is a list of objects of this uniform shape, in owner order:

```json
{"id":"https://example.org/entities/e_123/resources/r-scoped-9",
 "label":"Fast model","status":"available",
 "contracts":["https://spec.bindle.example/contracts/decision-model/v1"],
 "token":"eyJ…","token_type":"Bearer","expires_at":1792500000,
 "broker":{"endpoint":"https://models.example/bindle/rpc","origin":"https://models.example",
           "resource":"https://models.example/r/abc"}}
```

| Member | Meaning |
| --- | --- |
| `id` | Always the provider's opaque scoped reference, as in v1. |
| `status` | `available` or `unavailable`. An unapproved resource is omitted (extensions §3.1). |
| `broker` | Present only for brokered resources. The consumer sends the RPC envelope to `broker.endpoint`, with `resource` set to `broker.resource`, using `token`. |
| `seq` (result level) | When the reader is an integration, v2 read results also carry the connection's current configuration `seq` (§6.2). |

Consumers treat `token` as opaque. They MUST NOT persist it beyond its expiry or log it.

### 5.2 Consent disclosure

Before a consumer is approved for a brokered resource, the provider MUST disclose the following, in addition to protocol §3:

- the integration's verified origin, as the party that receives the consumer's requests and data directly;
- that the integration learns which apps use the resource, and the entity's identifier;
- that the provider does not see, store or recall that traffic;
- that the integration's contract claims are unverified;
- the revocation delay: up to `access_ends_by` (§7.3);
- that severance cannot stop the consumer and the integration from dealing directly outside Bindle.

### 5.3 Consumer credentials

Brokered access tokens are [JWT access tokens (RFC 9068)](https://www.rfc-editor.org/rfc/rfc9068.html). They are signed with a key from the **brokering key set** published at `brokered-resources.v1.jwks_uri` (issuer origin), which is separate from any other issuer key use. The algorithm is ES256, the header `typ` is `at+jwt`, and the `kid` is distinct per purpose.

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
| `aud` | Exactly `rpc_endpoint` for `invoke` and `describe`; exactly `discovery_endpoint` for `discover`. |
| `client_id` | The consuming application, or the issuer URL when a provider feature is the consumer. |
| `exp` − `iat` | At most 300 seconds (60 for `discover` and `describe`). |
| `bindle.purpose` | `invoke`, `describe` (§5.6) or `discover` (§4.1). |
| `bindle.connection`, `bindle.generation` | The coupling. |
| `bindle.resource` | The integration's resource ID. The token authorizes this resource only. |
| `bindle.grant` | An opaque identifier for this consumer's current approval of this resource in this field binding. For a provider consumer, it identifies the feature enablement. It changes on every reassignment, scope change, reapproval, occupant change or re-enable. |
| `bindle.feature` | Present only for provider consumers: the consumer declaration `ref`. |
| `bindle.methods` | The exact approved contract → methods map: the intersection of the grant, the field assignment and the record's contracts. |
| `bindle.scope` | `null`, or a normalized scope selection (§5.6). |
| `cnf.jkt` | Present when the token is DPoP-bound (§5.4). |

The provider mints a token only if every live check passes at minting time:

- the account is active, at its current authority epoch;
- the connection is `active` or `degraded`, at the current generation;
- the grant or enablement is live;
- the assignment is current;
- the record is available;
- the consumer's own session is valid.

Minting runs in the same serialization domain as severance commits (§7.4). A preferences read MAY return a previously minted token while it has more than 60 seconds left. A consumer refreshes by reading preferences again. There is no separate refresh credential for brokered resources, so a consumer that can no longer obtain tokens from the provider loses access within one token lifetime.

The issuer's own RPC endpoint MUST reject every provider-minted JWT. An integration MUST NOT issue consumers any credential derived from a brokered token, such as its own session or refresh token. Doing so would place the access outside provider severance.

### 5.4 Sender constraint

A consumer session is **DPoP-bound** when its authorization entry carried `dpopJkt` ([auth](auth.md#token-lifetime-and-client-sessions)). The provider applies `resources.dpop` from the pinned manifest as follows:

| `resources.dpop` | DPoP-bound consumer | Consumer without a key |
| --- | --- | --- |
| `"supported"` | MUST bind (`cnf.jkt`, `token_type: "DPoP"`) | Mints a bearer token |
| `"required"` | MUST bind | Mints nothing; the projection reports the resource `unavailable` |

A consumer cannot ask for an unbound token in place of a bound one. The integration verifies every DPoP proof per [RFC 9449 §4.3](https://www.rfc-editor.org/rfc/rfc9449.html#section-4.3):

- `typ` `dpop+jwt`;
- `htm` `POST`;
- `htu` equal to `rpc_endpoint`;
- `iat` within its window;
- `ath` matching the access token;
- a proof `jti` cache covering the proof lifetime;
- `jkt` matching `cnf.jkt`.

### 5.5 Resource-server validation

An integration's `rpc_endpoint` MUST perform these checks on every request, **in this order**:

1. Parse the JWS without trusting it. Require `alg` ES256 and `typ` `at+jwt`. Read `iss` and `bindle.connection`, and look up the local connection for (`iss`, `connection`). **If it is unknown, reject without any network fetch.**
2. Verify the signature with a key from the brokering key set of the issuer recorded for that connection. The key set is fetched from that issuer's manifest only, under the protocol §2 rules, cached for at most one hour, and refetched on an unknown `kid` at most once per minute.
3. Check that `sub` equals the connection's entity.
4. Check that `aud` equals its `rpc_endpoint` exactly, and `bindle.purpose` is `invoke`, or `describe` for the scoping contract's `describe` method only. Reject every other purpose.
5. Check `iat` and `exp` with at most 30 seconds of leeway, and `exp − iat ≤ 300`. The integration's clock MUST be within 30 seconds of UTC.
6. Check that `bindle.generation` is at or above the connection's floor and not above the highest generation it learned through the code exchange or an authenticated event, and that `bindle.grant` is not in the revoked set (§7.2).
7. Check that the envelope's `resource`, `contract` and `method` match `bindle.resource` and `bindle.methods`, and that the resource is bound to (`iss`, connection, `sub`).
8. Verify the DPoP proof whenever `cnf` is present, and whenever `resources.dpop` is `"required"`.

Failures at steps 1–6 and 8 return HTTP 401. A failure at step 7 returns 403, without revealing hidden resources. The journal key is (`iss`, `sub`, `client_id`, `tx`), with the protocol §5 fingerprint and retention. Error envelopes and limits follow protocol §5.

### 5.6 Scoping

A brokered resource is whole-resource by default. If the integration implements the [resource-scoping](../architecture/resource-scoping.md) contract on a resource:

1. The provider calls its `describe` method at `rpc_endpoint` with a `describe`-purpose token, whose `client_id` is the issuer, whose `resource` is that resource, and whose `methods` contain only the scoping contract's `describe`.
2. The provider presents the controls to the owner, stores the owner's normalized selection in the field value, and places it in `bindle.scope`.
3. The integration MUST enforce `bindle.scope`, and MUST reject a token whose `scope` is non-null for a resource it cannot scope.

A provider MUST NOT present scope controls for a brokered resource that does not implement scoping.

### 5.7 Introspection

A provider MAY declare `introspection_endpoint` in `brokered-resources.v1` ([RFC 7662](https://www.rfc-editor.org/rfc/rfc7662.html), issuer origin). Integrations authenticate to it with `private_key_jwt`. The endpoint answers `active: false` unless both of these hold:

- the token's `aud` is one of the calling integration's endpoints;
- the token's connection belongs to that integration.

A contract, never a slot, MAY mark a method `"introspect": true` in its pinned `x-methods` entry. The provider then MUST declare `introspection_endpoint` before it registers a brokered record for that contract. The integration MUST introspect before executing such a method, and MAY cache results for at most 30 seconds, which reduces the revocation delay for that method to 30 seconds. **AMD-C8/C10 — proposed (approved provisionally 2026-10-20):** the 360 s bound is permitted for read-only brokered contracts. Write-capable brokered contracts MUST require live introspection before execution without cached authorization; unavailable introspection fails closed. A contract MAY instead declare `"x-bindle-brokerable": false`, and providers then MUST NOT register brokered records for it.

## 6. Events

### 6.1 Delivery

The provider delivers events to `events_endpoint` as [Security Event Tokens (RFC 8417)](https://www.rfc-editor.org/rfc/rfc8417.html), using [push delivery (RFC 8935)](https://www.rfc-editor.org/rfc/rfc8935.html): a `POST` with `Content-Type: application/secevent+jwt`. Each SET:

- is signed with a key from the brokering key set (ES256, header `typ` `secevent+jwt`);
- carries `iss`, `aud` (exactly `events_endpoint`), `iat`, `jti`, `sub` (the entity), and exactly one event in `events`.

Every event payload contains `connection`, `generation` and `seq`. `seq` is a per-connection counter that increases strictly across all events and all generations of that connection id.

Every delivery attempt is **signed afresh**, with a new `iat` and the same `jti`. Non-revocation payloads are built at send time from the current state (§6.3).

The integration MUST check, in this order:

1. `typ` is `secevent+jwt`, and `alg` is ES256.
2. The connection is known for (`iss`, `connection`); if it is unknown, reject without a fetch.
3. The signature verifies under §5.5 step 2.
4. `aud` equals its `events_endpoint`.
5. `sub` equals the connection's entity.
6. `iat` is within the last 10 minutes and not more than 30 seconds in the future.

A `jti` it has already processed is answered with 202 and not reprocessed. Otherwise it processes the event and answers 202. Under RFC 8935, a 400 with an error code is a permanent rejection. Any other response, or a network failure, is retried. Unknown event types are acknowledged with 202 and ignored.

### 6.2 Event types

| Event identifier (placeholder) | Payload beyond `connection`, `generation`, `seq` | Integration obligation |
| --- | --- | --- |
| `…/events/preferences-updated/v1` | `fragment`, `revision`, `values` | Replace its configuration for `fragment` with `values`, if `seq` is greater than the last `seq` it applied for that fragment through either channel. Otherwise ignore the event. |
| `…/events/credential-revoked/v1` | `grants` (a list of `bindle.grant` values), `until` | Reject brokered tokens carrying those grants until `until`. |
| `…/events/connection-revoked/v1` | `generation_floor`, `terminal` | Reject tokens whose generation is below the floor. If `terminal` is set, stop processing for generations **below the floor** and apply its own retention policy to them. It MUST NOT delete state of generations at or above the floor. |
| `…/events/connection-resumed/v1` | (the new `generation`) | Accept tokens up to this generation (§5.5 step 6). |
| `…/events/resource-detached/v1` | `resource` | Informational: the owner removed the record from the provider. The integration MAY clean up. |

**What `values` contains.** It equals what the integration's own preferences/v2 read of that fragment would return, but without `token`, `token_type` and `expires_at`. Resource references are therefore the provider's opaque scoped `id`s with `label`, `status`, `contracts` and, where present, `broker` metadata. `values` is `null` when the integration's grant on that fragment is revoked.

**Why the integration can apply events safely.** Each event carries a full snapshot, the provider assigns `seq`, and preferences/v2 reads carry the same `seq`. So the integration compares `seq` across push and pull, applies only newer state, and never merges diffs. Revocation events apply regardless of `seq` order, because floors only rise and revoked sets only grow during their window.

### 6.3 Preference-update webhook

The `preferences-updated` event is the webhook for configuration changes after setup. The provider emits it after every committed change to a granted field of a fragment the integration holds, after grant revocation, and after reapproval.

Every such change enqueues a marker in the same transaction (transactional outbox). Markers are coalesced per fragment, and the payload snapshot and `seq` are taken when the event is sent. An integration that misses events, or has none configured, may read `@preferences` at any time. The read is authoritative, and it carries the `seq` to compare against.

### 6.4 Retry and degradation

The provider retries with exponential backoff, starting at most 10 seconds after a failure and never waiting more than one hour between attempts, for at least 72 hours. Revocation events are retried before other events.

After the retry window:

- undelivered non-revocation events are dropped, the connection becomes `degraded`, and the owner is informed;
- undelivered revocation events are recorded as unacknowledged (§7.3). Safety does not depend on them.

Event delivery uses the provider's SSRF-safe egress. Response bodies are bounded to 4 KiB, and response time is bounded.

## 7. Severance

### 7.1 Operations

| Operation | Trigger | Provider commit | Events |
| --- | --- | --- | --- |
| Disconnect | The owner disconnects the integration; account recovery, suspension or deletion | Connection `disconnected`, generation incremented, refresh tokens revoked | `connection-revoked` with `terminal: true` |
| Suspend / manifest-invalid | The owner suspends; §2.3 | State changed, generation incremented, refresh tokens revoked | `connection-revoked` with `terminal: false` |
| Revoke a consumer | The owner revokes a consumer's grant, removes the resource from the field, changes scope, replaces an occupant, or disables a provider feature | New `bindle.grant` for any remaining approval; old grant revoked | `credential-revoked` for the old grant identifiers |
| Detach a resource | The owner removes the brokered record | Record and every assignment of it removed | `credential-revoked` for every grant on it, then `resource-detached` |
| Key compromise | Operator | Key removed from the brokering key set; generation incremented on every connection | `connection-revoked` (`terminal: false`) and `connection-resumed` for every connection |

### 7.2 Ordering

The provider MUST perform severance in this order:

1. **Commit.** In one local transaction, change the authority state (connection state and generation, grant identifiers, assignments, refresh tokens) and enqueue the events. From this commit on, the provider mints no token that the change invalidates, projects affected resources as `unavailable`, and stops provider-feature consumption.
2. **Deliver** the events (§6.4), revocation events first.
3. **Bound.** Record `access_ends_by` = commit time + 300 s (maximum token lifetime) + 30 s (leeway) + 30 s (maximum allowed clock error at the verifier) = commit time + 360 s. Contracts that require introspection have a 30-second bound for their marked methods.

The integration maintains two pieces of revocation state:

- a generation floor per connection, which only rises;
- a revoked-grant set whose entries it keeps until their `until`, which is at least `access_ends_by`. After that, every token carrying them has expired, so the entries can be discarded.

Its revocation state is therefore bounded by the number of revocations in a six-minute window.

### 7.3 Guarantees and limits

- **What the provider guarantees alone.** From the commit, it issues no credential that the change invalidates, and it stops its own use.
- **What a conforming integration adds.** It rejects every invalidated token no later than `access_ends_by`, even if it never receives the event. If it acknowledges a revocation event, it rejects those tokens from that moment.
- **What no one can guarantee.** A non-conforming integration can ignore expiry or revocation, or deal with the consumer directly outside Bindle. Severance cannot prevent this, and consent says so (§5.2).
- **No recall.** Requests admitted before revocation may complete. Data already returned, and data the integration holds, are not recalled. Disconnect does not delete the integration's data.

The provider reports `access_ends_by` and the acknowledgment status of every severance to the owner.

### 7.4 Races

| Race | Resolution |
| --- | --- |
| A token is minted concurrently with the commit | Minting checks authority inside the same serialization domain as the commit: the account's single writer. A token is either minted before the commit, and so bounded by `access_ends_by`, or refused. |
| A revocation event arrives before an earlier `preferences-updated` | Revocations apply regardless of order. The stale update is ignored because its `seq` is lower. |
| Reconnect while a `terminal` revocation is still in flight | The reconnect creates a higher generation, and the in-flight event's floor is below it. A late delivery therefore neither cuts off nor deletes the new generation. |
| A captured revocation SET is replayed | It is answered 202 and not reprocessed while its `jti` is cached. Later replays fail the `iat` window. A replay can only re-apply floors that already hold. |
| The owner removes and re-adds the same resource | Re-adding creates a new record approval and a new `bindle.grant`, and requires consumer approval again. The old grant stays revoked. |
| The integration is offline during severance | The §7.3 bound holds for a conforming integration. Events are retried for 72 hours. |
| The provider is offline after the commit | The commit is durable, and delivery resumes when the provider returns. Consumers cannot obtain new tokens while it is offline. |
| A signing key is compromised | A forged token can name any generation up to the highest the integration knows (§5.5 step 6). The §7.1 key-compromise procedure raises every floor. Integrations caching the old key set keep trusting the removed key for up to one hour; that is the stated residual risk. |

## 8. Integration-to-provider change hints

An integration tells the provider that its resources changed by POSTing to the `hint_endpoint` declared in `integrations.v1`:

```json
{"client_assertion_type":"urn:ietf:params:oauth:client-assertion-type:jwt-bearer","client_assertion":"eyJ…"}
```

The client assertion follows RFC 7523:

| Claim | Requirement |
| --- | --- |
| `iss`, `sub` | The integration's `client_id` |
| `aud` | `hint_endpoint` |
| `exp − iat` | At most 60 seconds |
| `jti` | Unique; replay-protected for the assertion's lifetime |
| `bindle_connection` | The connection id |

The provider:

1. looks up the client locally, and never fetches metadata or keys for a client that has no connection at this provider;
2. verifies the assertion against the pinned keys;
3. checks that the connection belongs to that client;
4. only then counts the request against per-client and per-connection limits. Failures count against limits per source address.

A hint carries no data and no authority. It only schedules revalidation (§4.4), so a valid hint costs at most one bounded discovery call. The provider answers 202 to every well-formed request, whether or not it was valid, so the endpoint reveals nothing about connections. Hints arriving within 60 seconds of each other are coalesced.

## 9. Availability

| Party offline | Effect |
| --- | --- |
| Provider | Consumers cannot refresh brokered tokens, so brokered access ends within one token lifetime (fail closed). Integrations cannot read preferences or send hints. Queued events resume when it returns. Provider consumers, such as an email bridge, stop with the provider. |
| Integration | Its resources fail with `temporarily_unavailable` or network errors. `ordered` slots fail over where permitted ([extensions §3.3](extensions.md#33-failover-for-ordered)). Events and revalidation are retried. Setup steps on the integration's own pages cannot complete. The connection becomes `degraded` after the retry window. |
| Consumer | No effect on others. |
| Slot or fragment publisher | Pinned copies govern ([extensions §7](extensions.md#7-versioning-change-and-disappearance)). |

## 10. Audit

The provider records the following as owner-visible metadata, without payloads:

- connection state transitions and generations;
- setup fragment approvals;
- manifest snapshot changes, key-set changes and staged reviews;
- discovery requests: time, connection and result count, but not search text;
- brokered record registration, revalidation outcomes and removal;
- token minting, aggregated per consumer, resource and hour;
- events emitted, acknowledged, permanently rejected or expired;
- hints accepted and rate-limited;
- for each severance, `access_ends_by` and acknowledgment time.

Integrations SHOULD log `jti`, `client_id`, `connection` and `tx` for every brokered invocation. Neither party logs tokens.

## 11. Security requirements

1. **Origin and path binding.** Every integration URL is on the `client_id` origin and path prefix (§2.1). Discovered resource IDs are on the `rpc_endpoint` origin (§4.2). Nothing in a discovery result, event, hint or navigation parameter can introduce another origin.
2. **Subject binding.** Integrations accept only subjects on the `iss` origin, and bind resources to (`iss`, connection, `sub`) (§3.3).
3. **Lookup before fetch.** Every verifier resolves the local connection or client before any network fetch (§5.5, §6.1, §8).
4. **Audience and purpose separation.** Discovery, invocation and event audiences are distinct URLs. `bindle.purpose` distinguishes token uses. The issuer RPC endpoint rejects all provider-minted JWTs. Access tokens (`at+jwt`) and SETs (`secevent+jwt`) are distinct `typ` values, and each verifier MUST check `typ`.
5. **Least data.** Events carry no tokens and reveal no more than the integration's own read would (§6.2). Each token names one resource and its exact methods. A consumer's issuer access token is never sent to an integration. An integration never receives another integration's credentials, or upstream credentials held by the provider.
6. **Egress.** All provider requests to integrations follow the protocol §2 SSRF rules and per-connection, per-client and global budgets. Response bodies are bounded: discovery 64 KiB, events 4 KiB. Provider-consumer RPC responses are bounded by the contract's published limits.
7. **Keys.** A dedicated brokering key set (§5.3) holds keys separated by purpose. Rotation publishes a new key before using it, and keeps the old key until every token it signed has expired. Integration key continuity is pinned (§2.3).
8. **Unverified claims.** Contract claims, labels, descriptions and purposes from integrations are untrusted plain text, and they never earn a trusted badge.
9. **No silent expansion.** Manifest changes, discovery changes and slot changes never widen a grant (§2.3, §4.4).
10. **Bounded state.** Connections, brokered records, pending events, cached `jti` values and revoked-grant sets are bounded per account and per connection. Exhausted bounds fail visibly.

## 12. Feature declarations

| Feature | Members | Meaning | When absent |
| --- | --- | --- | --- |
| `integrations.v1` | `hint_endpoint` (issuer origin) | The provider accepts confidential integration clients, processes `bindle_integration`, returns `bindle_connection`, issues connection-bound refresh tokens, delivers events, performs discovery and accepts hints. It also declares `token_endpoint_auth_methods_supported`, including `private_key_jwt` ([RFC 8414](https://www.rfc-editor.org/rfc/rfc8414.html)). | Clients are plain public applications. Confidential integration documents are refused (§2.1). |
| `brokered-resources.v1` | `jwks_uri` (issuer origin, brokering key set), `preferences_contract` (the v2 URL), optional `introspection_endpoint` (issuer origin) | The provider registers brokered records, projects them through preferences v2 with minted tokens, and performs §7 severance. Requires `integrations.v1`. | Only issuer-hosted resources exist. |

## 13. Conformance tests

Tests MUST cover:

- **Manifest and client:** origin and path-prefix violations; endpoint collisions; issuer-origin endpoints; public clients denied `bindle_connection`; confidential documents at providers without `integrations.v1`; snapshot handling for every row of §2.3, including key-set replacement and domain takeover.
- **Lifecycle:** both installation paths and `iss` validation; every lifecycle transition, including `manifest-invalid` and built-in integrations; refresh-token revocation at commit.
- **Subject binding:** cross-issuer subject assertion.
- **Discovery:** foreign-origin IDs; contracts outside the manifest; silently ignored facets; oversize responses and cursors; redirects; private addresses; `limit: 0` probes; provider-assigned record IDs with ID collisions and reuse; revalidation to `unavailable` with owner reconfirmation.
- **Projection:** preferences v1 versus v2.
- **Tokens:** every §5.5 check and its order (no fetch for unknown connections); cross-audience, cross-purpose, cross-resource, cross-connection and cross-issuer replay; generation above the known maximum; DPoP `supported`/`required` with every proof check; the issuer RPC rejecting minted JWTs.
- **Events:** SET `typ`, audience, freshness, re-signed retries and duplicate-`jti` acknowledgment; `seq` across push, pull and generations; unknown event types; `terminal` replay after reconnect.
- **Severance:** §7.2 ordering, every §7.4 race, severance with the integration offline, and the key-compromise procedure.
- **Hints:** forgery, replay, cross-client connection claims and flooding.
- **Introspection:** scope limits.
- **Audit:** records for each operation.

## 14. Core amendments — proposed (approved provisionally 2026-10-20)

| ID | Document | Amendment |
| --- | --- | --- |
| C7 | federation-implementation, client ID metadata | "When the provider declares `integrations.v1`, `token_endpoint_auth_method: private_key_jwt` with a `jwks_uri` on the `client_id` origin and path prefix is accepted. Otherwise such documents are refused." Today every `jwks_uri` and every method other than `none` is refused. |
| C8 | protocol §2, §4, §5; auth revocation; resource contributions | An explicit `brokered-resources.v1` exception: provider-declared integration endpoints on the integration's own origin may receive consumer RPC and provider events, with revocation bounded by `access_ends_by` rather than immediate. Contracts may opt out (`x-bindle-brokerable: false`) or require introspection. The "no callback URLs" rule of protocol §5 is scoped to consumer RPC. |
| C9 | contracts | Publish `preferences/v2`, with the uniform per-resource object of §5.1 (`id`, `label`, `status`, `contracts`, `token`, `token_type`, `expires_at`, optional `broker`) and an integration-only result `seq`. |
| C10 | contracts, `x-methods` | Define method `effect` values `read` and `pure`, which [extensions §3.3](extensions.md#33-failover-for-ordered) relies on, and the optional `introspect` and contract-level `x-bindle-brokerable` markers. |
| C11 | protocol §2 | Add `integrations.v1` and `brokered-resources.v1` to the feature table. |
