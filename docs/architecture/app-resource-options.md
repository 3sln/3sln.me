# Application resources and MCP adapters — decision comparison

Status: independent architecture recommendation, 2026-10-12. Prepared by the contribution audit agent against the current local source and official MCP specification. This is a proposal, not an implemented feature or human approval. Human reviewer: ___ / date: ___ / outcome: ___. Coordinator reconciliation belongs in [DEVLOG](../../DEVLOG.md).

## Recommendation

Use one ordinary owner-scoped Bindle resource for an application connection, with separately granted contract methods. Allow an existing MCP endpoint to implement those methods through a trusted provider adapter. Automatically translate a reviewed, pinned tool catalog into an immutable Bindle contract manifest and the exact preference metadata needed to select it. Keep native contract adapters and installed provider modules equally valid. An app does not need an MCP server to participate.

This combines the simpler connection lifecycle of **B** with the integration reuse of **C**. **A** remains useful when an app contributes independently owned or selectable domain resources, such as several calendars. A new resource for every function is unnecessary when existing method permissions already distinguish functions.

An automatically recognized MCP endpoint establishes only transport/adapter compatibility. It does not establish a calendar, object-store or other domain contract's semantics, approve the producer, grant consumer access, verify advertised effects, or create permission to use underlying Bindle resources.

## Three alternatives

| Option | Existing mechanisms reused | Additional work and limits | Assessment |
| --- | --- | --- | --- |
| A. App contributes individual resources | Owner pool, preference assignments, exact resource/contract/method grants; individual resource lifetime | Excellent for distinct calendars, stores or other domain objects. One resource per tool multiplies records, consent assignments and lifecycle work for a single connection. App contribution rights still need a safe staging adapter. | Retain for independent domain resources; do not require for every function. |
| B. App connection itself is a resource implementing contracts | One owner/producer binding and revocation point; several contracts/methods on the same resource | Functions require immutable contract definitions. Reusing a generic `invoke` method with an arbitrary action argument loses existing per-method permission granularity. An executable adapter still must exist. | Best default resource model. The resource is the owner's connection to the app, not the app's global client identity. |
| C. App supplies an existing MCP endpoint | Existing tool discovery, schemas and invocation transport can supply an adapter implementation | MCP does not supply Bindle preferences, exact grants, domain contract conformance, immutable semantics or durable effect journals. Remote authentication, tool pinning, safe network discovery and protocol version handling remain work. A remote endpoint requires running compute. | Best optional integration path when an endpoint exists, combined with B. It is not an authorization shortcut or a mandatory app backend. |

## Fit with the actual Bindle implementation

[The protocol](../spec/protocol.md) already makes a resource implement multiple immutable contracts; grants select exact methods. [FederationService](../../packages/federation/service.mjs) enforces those tuples and permanently narrows access after assignment removal. Its current consent methods accept at most 32 method identifiers per contract, each matching `[A-Za-z][A-Za-z0-9_-]{0,63}`. Preference fields require exact contract URLs and combine declared contracts with AND semantics. These are real integration constraints, not unspecified future wildcards.

The smallest compatible projection is a bounded immutable contract manifest containing one safe Bindle method ID per selected upstream tool. A private adapter table maps each ID to an exact upstream name and pinned input/output definition. Generate IDs using collision-checked trusted identifiers; never derive authority from a display label. Do not expose a public `call({toolName,...})` escape hatch. The existing method grant checker remains the only method authorization rule.

For example, an app connection can implement a reviewed contract whose methods are `summarize` and `send_report`. A consumer approved only for `summarize` cannot dispatch `send_report`, even though both eventually become upstream `tools/call` requests. Upstream JSON-RPC method granularity is not the grant boundary.

The importer also needs exact immutable preference metadata for the generated contract URL. This is generated ordinary metadata, not a new app-state fragment or a wildcard contract matcher. A fixed MCP interoperability descriptor alone cannot make arbitrary generated tool methods selectable under the current exact-contract preference rules. Catalogs exceeding existing bounds must fail with an explained limit or be explicitly divided into bounded contracts; do not silently truncate consent or broaden those bounds.

Pin the approved tool schema, method mapping, endpoint authority, effect/trust disclosure and dependency policy. A catalog change stages a new immutable contract version. The simplest first implementation requires review of that version before granting its methods; existing unaffected methods can continue only when their previous implementation binding remains demonstrably valid. More selective per-method migration can compare exact approved digests, but must not copy approval to changed definitions. Mutable upstream code can change behavior without changing metadata: pinning protects the approved interface and route, not the truthfulness of external implementation. Keep that external-service trust explicit.

This recommendation follows the locally reviewed stack ethos (`../stack/deck/ethos.md`, a sibling checkout): one authority rule, narrow acquired capabilities, explicit platform ports and no parallel registry/lifecycle engine. The dispatch port belongs to existing provider/module composition. It must carry a restricted authorized handle into execution rather than hand trusted code an unrestricted account service after a one-time check.

## What MCP provides, and what must remain local policy

The current stable MCP release is 2026-07-28; the local service also has explicit 2025-11-25 compatibility verification. Supporting an imported endpoint requires an explicit compatible profile, not assuming the newest wire shape matches every server. [Official release announcement](https://blog.modelcontextprotocol.io/posts/2026-07-28/)

MCP provides tool names, schemas, listing and `tools/call`. Tool lists can depend on request authorization and can change. Annotations are untrusted hints; names are unique only within their server. Therefore imports need identity-qualified mappings, filtered discovery, catalog pinning and live dispatch checks. The initial adapter should accept only its supported bounded schema/result profile and report unsupported tools; MCP compatibility does not promise every remote schema or extension is supported. [MCP tools specification](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)

HTTP MCP authorization supplies resource-server authentication and scope negotiation. Tokens are audience-bound and sent per request. When 3sln calls an upstream app, it is a separate MCP client using an explicitly connected upstream credential for that audience. The consumer's 3sln token cannot be forwarded. Bindle method consent and the upstream connection must both remain live. The upstream OAuth scopes may be broader than one imported tool; the gateway narrows what it dispatches but cannot revoke an independent service's preexisting credentials. [MCP authorization specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)

Discovery does not authorize fetching arbitrary advertised addresses. Endpoint, authorization metadata, redirect and any optional icon/schema fetches share explicit SSRF, credential isolation, redirect and response-size policy. Existing fixed-client/endpoint configuration is a valid constrained first rollout; automatic import can stage metadata without automatically fetching every linked URL or connecting a new account. [MCP security guidance](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices)

An upstream JSON-RPC request ID or advertised idempotency hint is not durable mutation deduplication. Bindle reserves its own invocation journal before dispatch; unknown external outcomes remain `indeterminate`. Automatic retry is permitted only when the particular upstream operation has verified durable idempotency. Model-facing descriptions and results cannot change tool mappings, acquire permission, choose a new server, follow returned links automatically or approve effects.

## State placement and execution remain independent

App data may be in any already granted resource implementing an existing contract, or entirely in the app's own service. Files are one example. This design introduces no app-state datastore, mandatory storage contract, hosted workflow language or new permission namespace.

A static browser app can use selected resources interactively. Unattended functions require an existing resource method, a reviewed installed provider module, or configured compute; a closed browser cannot host a persistent remote endpoint. Compute may be stateless or stateful and may expose MCP or an ordinary reviewed callback. No remote transport requirement should exclude the native provider-module path.

If compute accesses Bindle resources while running, use an optional narrowly scoped invocation credential. Its authority is the intersection of the owner's approved dependency policy, the consumer's live resource/method grants, the producer connection's permitted delegation and the underlying implemented contracts. Derive scope from the fixed approved binding. The callback must not choose its own resources or mint broader credentials. App-owned state remains governed by the disclosed app connection and operation; it does not need fictional grants to resources that are not hosted by Bindle.

Cross-provider dependencies require an adapter with valid authority at the actual resource issuer. A 3sln invocation credential is not automatically accepted by another provider, and its audience cannot be expanded by routing. Keep unsupported cross-provider delegation unavailable while retaining ordinary independently authorized resource connections.

Invocation completion must atomically close unused delegated slots, account for already reserved dependent operations and prevent post-completion token use. A parent cannot report a known successful write if the corresponding slot is still in flight or indeterminate. Expiry ends future authority; it does not undo an external effect or justify refunding uncertain costs. Bound aggregate calls, output and spend across the invocation, including its child operations and retries. This is capability lifetime enforcement, not a workflow engine.

## Minimal reversible next step

The contribution specification now provisionally uses B+C while retaining separate contributed domain resources where useful. The former generic automation artifact is explicitly superseded/deprecated and has no canonical `$id`; it is not the mandatory function abstraction. Next specify one trusted dispatch/import port and a source-backed authorization bridge between existing MCP OAuth and Bindle method grants. First verify a native module and an independent MCP fixture with two separately granted functions, changed metadata, revocation, same-transaction replay and an uncertain write. Registry staging and optional invocation-token redemption stay disabled until their separate adapters are implemented and tested.

No runtime implementation, deployed adapter or production conformance is claimed by this comparison. Human sign-off remains blank.
