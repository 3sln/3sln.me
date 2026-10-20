# Extensibility: slots, unified integrations and brokered resources — design note

Status: **provisional design, 2026-10-20, revision 1** (under independent review: [extensibility review](../release/extensibility-review.md)). Documentation only: no code, runtime, build or production change. Human sign-off: reviewer ___ / date ___ / outcome ___. The coordinator records the decision in [DEVLOG](../../DEVLOG.md).

Normative drafts: [extensions](../spec/extensions.md) (slots and the `extensions` array) and [integrations](../spec/integrations.md) (unified integrations, the preference-update webhook, discovery, brokered credentials and severance). This note holds rationale, rejected alternatives, 3sln.me implications, migration and implementation slices.

## 1. User direction (followed)

From DEVLOG "2026-10-20 — Scope reduction" and NOTES.md:

- **A.** An `extensions` array of objects, not a URL-keyed map, so several apps can participate in one extension. Each entry pairs a URL with options. The URL may point to a role/slot manifest that any spec can use. Open: does the slot or the consumer decide selection when only one occupant makes sense? Reconcile with `profiles` and `features`.
- **B.** One umbrella for built-in integrations (Google Drive) and third-party apps, some with no front end beyond an auth/connector endpoint. The same setup, driven by config fragments. A manifest-declared webhook for preference updates.
- **C.** Discovery through a search/filter/browse endpoint, not a static list. The provider introduces, then consumer and resource provider talk directly. A preference value yields credentials, resource ID and RPC endpoint. The provider owns the coupling credential and can sever it by sending an invalidation request. It must be robust.
- **D.** Support, as worked examples, the messaging app accepting public messages (the email-bridge handoff) and the host classifier as a preferences slot. The messaging app itself is designed in `docs/architecture/messaging-app.md` by another agent.

## 2. Decisions

| ID | Decision | Where |
| --- | --- | --- |
| EX-1 | A **slot** is a resource-bearing role defined by a **slot manifest**. A slot manifest *is* a preference fragment with one extra `slot` member and exactly one resource field. Occupancy is that field's preference value, and consumption is an ordinary fragment grant. No new authorization primitive, registry or state store. | extensions §1–§2 |
| EX-2 | **Selection policy is fixed by the slot manifest** from a closed set (`exclusive`, `ordered`, `broadcast`, `consumer-choice`). The owner chooses occupants and order, and the consumer applies the policy. The consumer chooses only under `consumer-choice`. `ordered` failover is restricted to outcomes that prove no effect, unless the slot declares duplicates harmless. | extensions §3 |
| EX-3 | `extensions` is an **array of `{slot, role, ref, purpose?, required?, options?}`** in both provider manifests and integration manifests. Roles are `occupant` and `consumer`. Declarations are claims about the declaring party only, and never assign or authorize. | extensions §4 |
| EX-4 | **`profiles` stay distinct** from slots, and `features` stay Bindle-only. All three share the protocol §2 declaration processing rules. | §4 below |
| EX-5 | **Apps and integrations are one concept**, the *integration*, with kinds `external` and `built-in`. The owner's approval creates a **connection**: the existing app-connection resource, extended with a pinned manifest snapshot, a lifecycle state and a generation. | integrations §1, §3 |
| EX-6 | The **integration manifest** is the `bindle_integration` member of the OAuth client metadata (client ID metadata document or registration), bound to the exact `client_id` and on its origin. | integrations §2 |
| EX-7 | Provider-to-integration calls (events, discovery) are **provider-signed JWTs**: RFC 8417 SETs pushed per RFC 8935, and RFC 9068 access tokens for discovery. Integration-to-provider calls are ordinary OAuth RPC, plus data-free **change hints** authenticated by an RFC 7523 client assertion. | integrations §4, §6, §8 |
| EX-8 | The **preference-update webhook** is the `preferences-updated` SET: a full approved snapshot with a per-connection `seq`, enqueued transactionally and coalesced. A snapshot plus `seq` is idempotent and order-insensitive. | integrations §6 |
| EX-9 | **Discovery** is a provider-only POST with contracts (AND), text, contract-defined facets, browse parent, exact `ids` and a `limit: 0` probe. Integrations must apply every constraint or fail. | integrations §4 |
| EX-10 | **Brokered credentials are provider-minted RFC 9068 JWT access tokens**, at most 300 s, one resource and its exact methods, optionally DPoP-bound, minted on each preferences read. The integration validates offline against the issuer JWKS. The provider owns the coupling because only it can mint. | integrations §5 |
| EX-11 | **Severance = commit, then invalidate, with a bound.** The provider commits authority changes and enqueues invalidation events in one transaction. Invalidation makes revocation immediate at a cooperating integration. Expiry guarantees `access_ends_by` = commit + 360 s without cooperation. Optional introspection serves contracts that need instant revocation. | integrations §7 |

## 3. Slots: the shape and the selection answer

### 3.1 Why a slot is a fragment

The user floated "a pointer to a role/slot manifest that any spec extension can use if it knows about it". Each property the user wants already exists in fragments:

- **Shared, owner-held configuration**: fragments are configured per entity, and every consumer of a field sees the same value.
- **Typed resource selection by contract**: resource fields match exact contracts with AND semantics.
- **Immutable, digest-pinned public documents**: fragment rules.
- **Consent, scoping, reapproval on replacement, immediate removal, no revival on reconnect**: protocol §3–§4 and resource scoping.

What the slot adds is small: occupancy semantics (`selection`, `failover`), the two consumer kinds (`application`, `provider`), and public declarations of who can occupy or consume. Building on fragments has one decisive interop property. **A provider that has never heard of slots still works**: it sees an ordinary fragment with a resource field, the owner picks a resource implementing the contract, and the app applies the policy itself. A self-hosted provider without support degrades to "no built-in occupants, no provider consumers, no declaration-driven candidates". It does not degrade to "broken".

### 3.2 Who decides selection

**The slot decides the policy, the owner decides membership and order, the consumer executes.** Rationale:

1. *The policy is part of the role's meaning.* "Receives public messages" with fan-out is a different role from the same with a single handler. Occupants must know whether they are the sole handler (for example to send a receipt). Consumers must agree, or one owner configuration yields duplicates at one consumer and loss at another.
2. *Consumers cannot coordinate.* The provider's email bridge and a third-party app consuming the same slot never talk to each other. Only a fact in the slot document gives them the same behavior.
3. *The owner already orders field values.* Preference values are ordered lists, so "first available" needs no new configuration surface.
4. *Consumer freedom remains where it is safe.* `consumer-choice` exists for pools (several AI models), where choosing among equivalent occupants harms no one.

**Rejected alternatives.**

| Alternative | Why rejected |
| --- | --- |
| Consumer decides | Same owner configuration, different effects per consumer. Duplicate deliveries to `exclusive`-style roles. Occupants cannot reason about their role. |
| Owner chooses the policy per slot | Moves interop semantics into private configuration. Consumers would need to read the policy and handle all four for every slot. Occupant contracts cannot rely on it. |
| Provider decides | Different providers would give different semantics for one slot. That breaks portability between providers. |
| Open-ended policy vocabulary | Unknown policies would need fail-closed handling everywhere. Four cover every case we found (single handler, failover, fan-out, pool). |

### 3.3 Why an array

Every user reason holds: several entries per slot (two built-in models, or occupant plus consumer), independent declarations by different parties, and per-entry options. A map keyed by slot URL forces one entry per slot per manifest. The `ref` member gives each entry a stable key without a map, and duplicates fail closed.

### 3.4 Why declarations exist at all, given fragment grants

Consumer declarations duplicate information an app sends at authorization. They exist so that a provider can show which integrations will use a slot before authorization, and so that an optional slot with no possible occupant is skipped (extensions §5.2) rather than prompting. Occupant declarations are new information: which integrations to query when the owner fills a slot. Provider declarations tell integrations what this host offers (built-in occupants) and what occupying a slot does here (provider consumers). None is authority.

### 3.5 Rejected slot designs

| Alternative | Why rejected |
| --- | --- |
| Slot as a new top-level registry with its own assignment API and grants | A parallel authorization plane. Duplicates fragments, consent and revocation, and fails on providers without support. |
| Resource-less slots ("pure capability") | That is a profile or feature. Allowing them would blur three containers into one without processing benefit. |
| Slots declaring endpoints | Endpoints belong to integrations, bound to their origin. A slot endpoint would be a third-party endpoint without an origin principal. |
| Intents for the email-bridge handoff | Link intents (`intents.v1`) are page-to-provider navigation. Server-to-server delivery needs a configured, consented recipient, which is a slot. |
| Auto-assigning the first or only capable occupant | Turns installation into routing of private data. Slot hijacking by installation. |

## 4. Profile and feature reconciliation

**Decision: keep three containers with one processing rule set.**

| Container | Who defines identifiers | What it states | Multiplicity | May touch core |
| --- | --- | --- | --- | --- |
| `features` | Bindle only (`name.vN`) | What the provider implements of the Bindle spec | One per identifier and version | It *is* core |
| `profiles` | Third parties (HTTPS URI keys) | What the provider implements of a third-party spec (for example the components profile: embed origin, islands, theme tokens) | One per profile | Only the component-origin envelope |
| `extensions` | Third parties (slot URLs) | Which roles the declaring party can occupy or consume for entities | Many per slot | Never |

**Why not make profiles a kind of extension?**

1. *Different subject.* A profile describes the **provider**: a property of the host, with no resource, no occupant, no owner choice and no consent. A slot describes **roles for entity resources**, which only mean something through preferences and grants. Expressing the components profile as a slot would invent an empty resource field and an occupancy policy it cannot use.
2. *Different multiplicity.* A provider implements a profile or not, so a map keyed by URI is correct. A duplicate key is an error that I-JSON already rejects. Slot participation is many-to-one, so an array is correct.
3. *Different security boundary.* Profiles may use the component-origin envelope in auth, the single place a third party can affect authorization-code delivery. Folding profiles into `extensions` would either extend that hook to any slot entry (a much larger attack surface: any slot publisher could define code delivery) or need a per-entry exception that recreates the distinction anyway.
4. *Stability.* The components profile is implemented, reviewed (21 findings closed) and relied on by the SDK's capability computation. Moving it buys nothing observable.

**What unifies them.** All three use the protocol §2 processing rules: bounded size, I-JSON, unknown entries ignored, invalid entries treated as absent without invalidating the manifest, runtime-observed non-implementation downgrades for the session only, no cross-issuer mixing, caching capped at one hour. A profile MAY define slots for its own purposes (for example a future components part that renders a slot's occupants), and MAY reference them. That is the only coupling.

**Why not make slots a feature?** Features are reserved for the Bindle spec, so third-party roles cannot be features. The *mechanism* is a feature (`extensions.v1`); individual slots are not.

## 5. Unified integrations: the shape

### 5.1 One concept, two implementations

The existing app connection (DEVLOG D057: an owner resource with transport `bindle`, generation-bound, listed at `/api/apps`) is already the right umbrella. An integration is a connection with a pinned `bindle_integration` snapshot. A legacy app is a connection without one. A built-in integration is a connection whose manifest is provider-authored and whose events are in-process. The owner sees one list, one setup flow (fragment configuration) and one disconnect, with consistent semantics.

### 5.2 Why the client metadata document

| Option | Assessment |
| --- | --- |
| **Member of client metadata** (chosen) | Already fetched, bounded, SSRF-screened, cached and snapshotted at approval by `client-id-metadata.v1`. Bound to the exact `client_id`. Static registrations carry it too. One origin can host several clients. |
| App origin `/.well-known/bindle/manifest.json` (`application` member, app-metadata) | Per origin, not per client. Conflates an app manifest with a provider manifest. A second fetch with its own consistency problems. |
| Separate `bindle_integration_uri` | Another fetch and another cache, with no benefit while manifests stay small (URLs reference fragments and slots). Revisit if 8 KiB proves too small. |

`application` presentation metadata (app-metadata.md) remains valid and is unaffected.

### 5.3 Why the webhook is a SET

A custom HMAC webhook would need a shared secret per connection, distributed somehow and rotated, and every integration would hand-roll verification. SETs signed by the issuer key reuse the issuer's `jwks_uri`, which integrations already need for brokered tokens. They give replay protection (`jti`), freshness (`iat`) and audience binding (`aud`). RFC 8935 defines acknowledgment and permanent rejection. Integrations can use off-the-shelf JOSE libraries.

**Snapshot, not diff.** The revision in the preferences contract is opaque and unordered, so diffs cannot be ordered safely. A full approved snapshot with a provider-assigned monotonically increasing `seq` makes events idempotent and order-insensitive, and lets the provider coalesce.

### 5.4 Built-in integrations

Google Drive becomes a built-in integration with a provider-authored manifest whose setup is fragment configuration, plus its existing Google OAuth connect step. Its resources remain issuer-hosted (gateway), not brokered. Disconnect keeps its documented local-only semantics (`providerRevoked:false`), now expressed as the generic `disconnected` transition. Nothing in the Drive adapter's mapping authority changes.

## 6. Brokering: the model

### 6.1 Credential options considered

| Option | Severance | Availability | Verdict |
| --- | --- | --- | --- |
| Proxy every call through the provider gateway | Instant | Provider on every call. Contradicts "communicate directly". | Kept for issuer-hosted and built-in resources only. |
| Introspection on every call (RFC 7662) | Instant | Provider on every call, plus a round trip. | Optional (`introspection_endpoint`) for contracts that need instant revocation. |
| Integration mints long-lived consumer credentials at the provider's request; provider sends invalidations | Only as reliable as invalidation delivery. A lost or ignored invalidation means indefinite access. | Good | Rejected: severance must not depend on the remote party. |
| **Provider mints short-lived JWTs; integration verifies offline; invalidation accelerates** (chosen) | At a cooperating integration, immediate on acknowledgment. Otherwise bounded at 360 s. | No provider round trip per call. Fail-closed within 300 s if the provider is down. | Chosen. |
| Long-lived provider-minted JWT plus revocation list | Revocation-list delivery has the same problem as invalidation | Good | Rejected. |

The chosen design meets the user's words exactly. The provider **owns the coupling credential**: its signing key and the connection generation. It **severs on demand**: it stops minting and sends `connection-revoked` or `credential-revoked`, the invalidation request that cancels the consumer's credentials at the integration. It is **robust**: correctness never depends on the invalidation arriving.

### 6.2 Why the token is a JWT here when Bindle tokens are otherwise opaque

The issuer's own RPC tokens stay opaque, because the issuer is the only verifier. A brokered resource is verified by a third party, which needs either a round trip (introspection) or a self-contained signed token. RFC 9068 is the standard self-contained profile. It adds no new token format. The issuer RPC rejects these tokens (integrations §5.3), so the two never mix.

### 6.3 Scoping, refresh, revocation ordering, audit

- **Scoping**: the token carries one resource, its exact methods and an optional normalized scope that the integration must enforce, and only if it implements resource scoping.
- **Refresh**: re-read preferences. There is no brokered refresh token, because one would outlive provider-side revocation.
- **Revocation ordering**: commit, then deliver, then bound (integrations §7.2). Integration revocation state is bounded by the token lifetime.
- **Audit**: metadata only, owner-visible, including `access_ends_by` and acknowledgment per severance.

### 6.4 Creation and management of resources (NOTES "Later")

Integrations own creation in their own interface (`management_url`), signal change with data-free hints, and the provider pulls authoritative state through discovery. This serves the later AI-model and subscription-registry work without new mechanisms:

- **AI model resources.** An "OpenAI" or "Workers AI" integration exposes each configured model as a brokered resource implementing model contracts (for example a `decision-model/v1` and a `chat-model/v1`), with contract-defined facets (context window, structured output) for discovery. "Intelligence profiles" are slots: `item-classifier/v1` (`ordered`, `any-error` failover), or a hypothetical `general-assistant/v1` (`consumer-choice`). A preference field pointing at a model is an ordinary resource field with the model contract. Smart and basic variants of one interface are different contract URLs with the same methods, as NOTES suggests.
- **Subscription and invoice registry.** The registry is a provider-hosted resource. Vendors are integrations that contribute entries through the existing contribution path (resource-contributions.md), with `management_url` as the vendor's cancellation and management link. The registry might be modeled as a slot later, if more than one registry implementation should be pluggable.

## 7. Worked examples (messaging extraction)

These examples exercise the mechanism. They do not design the messaging app ([messaging app](messaging-app.md), another agent). Slot and contract identifiers are placeholders the messaging spec would own.

### 7.1 Email bridge hands off to the owner's messaging app

The messaging interop spec publishes slot `…/slots/public-message-intake/v1`: one field `occupant`, contracts `[…/contracts/public-intake/v1]` (method `deliver({message, provenance})`, idempotent per `tx`), `selection: "exclusive"`, `consumers: ["provider", "application"]`.

1. **3sln.me manifest** declares `features: {"extensions.v1":{}, "integrations.v1":{…}, "brokered-resources.v1":{}}` and `extensions: [{"slot": "…/public-message-intake/v1", "role": "consumer", "ref": "email-bridge", "purpose": "Delivers email sent to your public address."}]`.
2. **Messaging app's client metadata** declares `bindle_integration.resources` (its `rpc_endpoint`, `discovery_endpoint`, contracts including `public-intake/v1`) and `extensions: [{"slot": "…/public-message-intake/v1", "role": "occupant", "ref": "inbox"}]`.
3. **Setup.** After the owner connects the app, the provider sees the occupant declaration plus its own consumer declaration, and offers to route bridged email to it. The owner fills the slot: the provider runs discovery with `contracts: [public-intake/v1]`, and the owner picks the app's intake resource. The provider registers a brokered record and assigns it (extensions §5.1, disclosing that the email bridge will deliver email for the owner's public address to `inbox.example`). Separately, the owner enables the email-bridge provider feature (extensions §5.3).
4. **Delivery.** On durable acceptance of an email (public-email-bridge design), the bridge reads the slot value, mints itself a brokered token (`client_id` is the issuer), and calls `deliver` at the app's `rpc_endpoint` with `tx` derived from the ingress fingerprint. A retry after an unknown outcome reuses that `tx`. Under `exclusive`, no other occupant is ever tried.
5. **Change and failure.** If the owner replaces the occupant, undispatched items go to the new occupant at dispatch time. Items with an indeterminate outcome stay with the old occupant's `tx` until resolved, never duplicated. If the slot is empty or the feature is disabled, the bridge applies its own refusal or holding policy (bridge design). If the app is offline, items queue within the bridge's budgets. If the owner disconnects the app, the slot is projected unavailable from the commit and no further deliveries occur.

### 7.2 Host classifier consumed by the messaging app

Slot `…/slots/item-classifier/v1` as in extensions §2: contract `decision-model/v1`, `selection: "ordered"`, `failover: "any-error"` (classification is pure computation), `consumers: ["application", "provider"]`.

1. **3sln.me manifest** declares `{"slot": "…/item-classifier/v1", "role": "occupant", "ref": "classifier", "options": {"label": "3sln.me classifier"}}`, a built-in occupant backed by Workers AI and metered against the owner's plan.
2. **Messaging app's manifest** declares `{"slot": "…/item-classifier/v1", "role": "consumer", "ref": "triage", "purpose": "Sort incoming messages."}` and requests the slot fragment as **optional** at authorization, with method `decide`.
3. **Available.** The consent presentation offers the built-in classifier (and any connected AI integration's models) as candidates, with cost and data-processing disclosure. The owner assigns one or more, in order. The app reads `@preferences` for the slot and calls `decide` on the first occupant: through the issuer gateway for the built-in, or directly at the integration's endpoint for a brokered model. On any error it fails over to the next occupant.
4. **Unavailable.** On a provider without the slot, with no built-in occupant and no capable integration, the optional request is reported `unavailable` without a prompt (extensions §5.2), and the app omits AI classification, as the DEVLOG direction requires. On a provider without `extensions.v1`, the app may still request the fragment as an ordinary optional fragment.

### 7.3 Activity stays in core

App-originated alerts use the existing app-notification path (owner-local resource method, app-notifications.md). They are not a slot: the provider is the only presenter, and no owner choice of handler is involved. A future "push destination" could be a `broadcast` slot if third-party presenters are wanted.

## 8. 3sln.me host implications

| Area | Implication |
| --- | --- |
| Signing key | `/oauth/jwks` currently serves an empty key set (`packages/federation/http.mjs`). `integrations.v1` needs a provisioned ES256 key used only for minted tokens and SETs, with rotation. This is a secret-provisioning step and a production gate. |
| Egress | Events and discovery are provider-originated fetches to integration origins. Node uses the DNS-pinned adapter. Workers use strictly-public fetch plus a DoH screen without connection pinning, the same residual risk recorded for `client-id-metadata.v1`. Production declaration needs that verified. |
| Durable outbox | Events are per-account transactional outbox rows in the account's single writer (DO storage, Node SQLite), drained by account alarms with bounded batches and budgets. |
| Minting path | Preferences reads that project brokered resources mint per call. Mint counts join the existing per-account work budget. |
| Built-in classifier | A built-in `item-classifier` occupant over the `ai` engine provider (Workers AI), with per-owner metering. It is available to the messaging app and to the email bridge (provider consumer) alike. |
| Email bridge | A provider consumer of `public-message-intake`. It replaces any design in which the bridge writes into core message resources (messaging leaves core). |
| Google Drive | A built-in integration manifest. The existing routes stay; the console groups it under Connections. |
| Connections console | One list for apps, external integrations and built-ins, driven by connection state, plus slot views. Browser verification is required when built. |
| Cost | Every slot invocation by a provider consumer, discovery query and event delivery is metered against existing work budgets. Hints are rate-limited per client. |

## 9. Migration plan

| Step | From | To | Compatibility |
| --- | --- | --- | --- |
| M1 | `features`/`profiles` processing in protocol §2 | Add `extensions` to the shared rules. Add `extensions.v1`, `integrations.v1`, `brokered-resources.v1` to the feature table (proposed). | No change for existing clients: unknown members are ignored. |
| M2 | App connections (D057) | Add `kind`, the manifest snapshot, `state` and the generation already present. Legacy apps are `external` with no snapshot and state `active`. | `/api/apps` responses gain fields. Disconnect semantics are unchanged. |
| M3 | Client metadata (`ClientDirectory`) | Parse and validate `bindle_integration`. Snapshot it with the existing approval snapshot. | Clients without the member are unaffected. |
| M4 | Google Drive connector | Built-in integration manifest. Existing resources, mappings and generations untouched. | Owner-visible regrouping only. |
| M5 | Components profile | No change. Optionally reference the shared processing rules. | None. |
| M6 | Email bridge design | Provider consumer of `public-message-intake`, gated on the messaging app spec. | The bridge is unimplemented, so nothing breaks. |
| M7 | `contracts.md` preferences v1 | Brokered projection member (`broker`, `token_type`, `expires_at`) inside field values. `docs/artefacts/preferences-v1.json` leaves `values` an unconstrained object, so the schema permits it. A consumer unaware of `broker` that calls the issuer RPC with the foreign resource ID and minted token fails closed (the issuer rejects minted JWTs and does not own the resource). | Issuer-hosted projection unchanged. |

## 10. Implementation slices (non-overlapping ownership)

Each slice runs `npm test`. UI slices add DOM and browser verification. Proposed owners are roles, not named agents. The coordinator assigns them after sign-off.

| Slice | Scope | Files (new unless noted) | Depends on |
| --- | --- | --- | --- |
| X1 | Slot manifest and `extensions` validation, pure functions | `packages/federation/extensions.mjs`, `tests/extensions.test.mjs` | — |
| X2 | Manifest declaration (`features`, `extensions`) from config | `packages/federation/runtime.mjs`, `packages/runtime/federation.mjs` (manifest builders only) | X1 |
| X3 | Integration manifest parsing and snapshot | `packages/federation/client-metadata.mjs` (extend), `packages/federation/integrations.mjs`, `tests/integrations-manifest.test.mjs` | X1 |
| X4 | Connections domain (state machine, generations, kinds) on the engine | `packages/app/domains/connections.mjs`, `packages/runtime/account/connections.mjs`, `tests/engine-connections.test.mjs` | X3 |
| X5 | Signing key, JWKS, token and SET minting | `packages/federation/signing.mjs`, `packages/federation/http.mjs` (JWKS route only), `tests/federation-signing.test.mjs` | — |
| X6 | Event outbox and delivery (RFC 8935 client, retries, coalescing) | `packages/runtime/integration-events.mjs`, `tests/integration-events.test.mjs` | X4, X5 |
| X7 | Discovery client, brokered records, revalidation and hints | `packages/federation/resource-discovery.mjs`, `packages/federation/brokered.mjs`, hint route in `packages/runtime/routes/integrations.mjs`, tests | X4, X5 |
| X8 | Preferences projection for brokered resources, minting and severance | `packages/federation/service.mjs` (projection and mint path; coordinate with the federation owner), `tests/brokered-severance.test.mjs` | X7 |
| X9 | Reference resource-server verifier and fixture integration (conformance) | `tests/fixtures/integration-server.mjs`, `tests/integrations-conformance.test.mjs` | X5–X8 |
| X10 | Built-in classifier occupant and Drive built-in manifest | `packages/runtime/account/classifier.mjs`, `packages/storage/google-drive-integration.mjs` | X1, X4 |
| X11 | Connections and slots console | `apps/web/src/ui/connections/*`, browser tests under `tests/browser/` | X4, X7 |
| X12 | Email bridge as provider consumer | Owned with the messaging-app agent, after its spec lands | X8, messaging spec |

X5 and X9 can start immediately. X1 → X3 → X4 is the critical path.

## 11. Open questions for the user

1. **Public slot resolution.** Should a slot be able to opt into public per-entity resolution, so a sender's app can find a recipient's messaging endpoint from a handle, with owner opt-in and rate limits? It is deliberately excluded here to keep core narrow and avoid an enumeration surface. The messaging-app design may need it.
2. **Brokered token lifetime.** 300 s matches the core access-token cap. Should contracts be allowed to request less, or (with DPoP) more?
3. **Integration manifest location.** A client metadata member keeps one source of truth but shares the 16 KiB client-metadata bound. Is a separate document worth a second fetch?
4. **Built-in occupants as candidates.** May the provider *preselect* its built-in occupant in the consent presentation, with the owner still confirming? The spec forbids assignment without an owner action, but presentation defaults are provider policy.
5. **Who publishes slot manifests?** Messaging-related slots belong to the messaging spec, and the classifier slot to a generic 3sln.me artefact. Where should the registry live (`/artefacts/slots/`)?

## 12. Review reconciliation

Pending: [extensibility review](../release/extensibility-review.md).
