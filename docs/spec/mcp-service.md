# 3sln.me MCP service

This is an application service for 3sln.me, independent of the Bindle protocol specification. The MCP audience, authorization-server issuer, grant records and consent screens do not extend the Bindle protocol or reuse its grant namespace. Storage operations reuse the application's existing account storage adapters and durable mutation journal.

## HTTP and discovery

The single MCP resource endpoint is `/mcp`. The official `@modelcontextprotocol/server` SDK 2.3.1 handles requests, JSON-RPC validation, protocol negotiation and response framing. The service uses per-request server instances and stateless Streamable HTTP compatibility, so it does not retain sessions or idle SSE connections. GET and DELETE session operations return the SDK's 405 response. Tools, resources and prompts are implemented. Local integration coverage verifies the 2025-11-25 compatibility transport; current-version interoperability with independent production clients remains a release gate.

Protected resource metadata is `/.well-known/oauth-protected-resource/mcp`. The authorization-server issuer is `${APP_ORIGIN}/mcp/oauth`; RFC 8414 discovery is `/.well-known/oauth-authorization-server/mcp/oauth`. Authorization responses include `iss`, and metadata advertises this. Both authorization and token requests require `resource` equal to the canonical `/mcp` resource. Bearer tokens must be sent in the Authorization header on every request. Query parameters on `/mcp` are rejected. Missing, malformed, expired or revoked bearer tokens return 401 with a discovery challenge. Collection/function scope failures return 403 with an `insufficient_scope` challenge.

## Authorization and consent

Only operator-registered public clients are supported. Redirects must exactly match configured, canonical HTTPS URLs; explicit local development also allows loopback HTTP. No remote client metadata, redirects, icons or client URLs are fetched. Open Dynamic Client Registration and Client ID Metadata Documents are not advertised. This avoids a client-discovery SSRF surface while providing the MCP pre-registration mechanism.

Authorization uses authorization-code flow, mandatory S256 PKCE and state, a ten-minute pending request and a one-minute single-use authorization code. Existing account identity authentication protects consent. Owner mutation APIs require the account session, exact Origin and its CSRF token. Approving without explicit collection/function selections is rejected. The owner may narrow requested functions and choose exact current collection IDs. Changing client configuration does not silently register a redirect.

The consent API is:

| Endpoint | Behavior |
| --- | --- |
| GET `/api/mcp/requests/:id` | Owner-authenticated request, client name/redirect, requested functions and current collections |
| POST `/api/mcp/approve` | `{requestId, permissions:[{collectionId, tools:[names]}]}` or `{requestId, denied:true}`; returns the validated client redirect |
| GET `/api/mcp/grants` | Current owner's bounded active connections |
| DELETE `/api/mcp/grants/:id` | Revoke the exact owner's connection |

Access tokens last at most five minutes. Refresh tokens rotate on every use and expire with the original thirty-day grant. Codes, access tokens and refresh tokens are persisted only as domain-separated SHA-256 hashes. A consumed refresh token is retained until expiry; reuse commits revocation of the entire grant before returning `invalid_grant`. Concurrent use of the same refresh token consequently revokes the connection, including the winning request's access token. Clients must serialize refreshes and replace their stored token after successful rotation. Revocation immediately invalidates access and refresh tokens for subsequent admission; an operation authorized before revocation may finish.

## Capability surface

Scopes are `mcp:collections_list`, `mcp:items_list`, `mcp:item_read`, `mcp:item_write` and `mcp:item_delete`. Every dispatch intersects function scope with exact current collection consent, account status and current resource ownership/capabilities. Inbox collections are `inbox:<UUID>`, and connected storage sources are `resource:<UUID>`. Listings expose only explicitly selected collection names. Credentials, encrypted provider configuration, passkeys, recovery material and contact capability URLs are outside the MCP surface.

| Function | Inbox | Storage |
| --- | --- | --- |
| `collections_list` | Selected descriptor | Selected descriptor |
| `items_list` | Bounded collection page | Bounded object page |
| `item_read` | Item contents | Object contents |
| `item_write` | Message metadata only, no moving to another collection | Conditional hosted object creation/replacement |
| `item_delete` | Delete selected collection's message | Version-conditional hosted object deletion |

External source adapters currently provide verified configured read capabilities; writes/deletes are available only for hosted storage. All mutation paths use the existing free/paid account work budget, storage quotas and durable journals. MCP itself is not gated on a paid plan. Request UUIDs bind mutation retries to exact arguments. Account storage conditions and uncertainty handling remain authoritative. Inbox mutation journals reserve before effects and fail closed with `indeterminate` after an interrupted operation.

Inbox collection resources expose a bounded item listing using the same `items_list` authorization check. Object-storage sources do not offer `items_list`, listing resources, or listing prompts: apps read their own known directory/index objects with `item_read`. Tool discovery intersects exact grants with the current source capabilities, so stale storage listing grants cannot revive enumeration. The `review_collection` prompt loads only permitted collection metadata and describes item content as untrusted data. Prompt generation does not expose account identity credentials or grant secrets.

Input bodies are capped at 128 KiB, OAuth token forms at 8 KiB, pages at 50 items and generated tool results at 100,000 encoded bytes. Hosted/inbox content over 64 KiB is rejected before blob download; configured external adapters retain their own bounded download policy and the MCP output limit. Large file handling belongs in the account interface. No tool runs a fleet-wide search or unbounded inbox snapshot.

## Durable routing and operational limits

The fixed authorization layout is `mcp-auth-v1-64`. Request, code, grant and token identifiers start with a validated shard number from `00` to `63`, followed by random 256-bit material. All authorization records for a connection are colocated in one shard. Normal calls access one authorization shard plus the owner account and identity adapters. Authorization transactions close before account/provider dispatch; a slow upstream request does not hold the shard transaction.

Owner connection listing is a control-plane operation: at most eight concurrent calls read the 64 exact owner indexes. Each shard allows at most two active grants per owner, for an absolute maximum of 128. A busy randomly selected shard may require retrying a new authorization request or revoking an unused connection. There is no claim of a centralized 32-connection cap. Expiry indexes support bounded batches of 100 cleanup records through Durable Object/Node alarms. Layout changes require an explicit migration; changing the environment variable alone fails closed.

Unauthenticated authorization/token ingress additionally requires independent IP (30/minute), subnet (100/minute) and service-partition admission. Sixteen fixed service partitions allow 32 ingress requests/minute each, for an aggregate ceiling of 512/minute. These shared guards apply only to OAuth ingress; ordinary bearer tool calls use one authority shard and account-local budgets. Expiry maintenance uses exponential backoff and pauses after eight failures while retaining ownership of cleanup records; a paused shard requires operator repair rather than an endless alarm loop. Stored token/grant/code/refresh expiry and grant permission structures are validated before authorization, so missing or malformed expiry fails closed.

## Local verification history

Implemented and tested locally: Node SQLite restart persistence, official SDK HTTP tools/resources/prompts, exact audience and collection checks, S256 rejection, code replay, refresh rotation/reuse/concurrency, revocation, conditional write retry behavior and actual Worker Durable Object authorization. Production external-provider conformance and independent client/security review are unverified. Account production release remains disabled.

| Decision | Reviewer | Date | Outcome |
| --- | --- | --- | --- |
| Independent MCP namespace and fixed 64-shard layout | Unassigned | — | Provisional |
| Operator pre-registration and refresh-family revocation | Unassigned | — | Provisional |
| Bounded storage/inbox tool capability surface | Unassigned | — | Provisional |

## References

Primary references checked on 2026-10-12: [MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization), [Streamable HTTP compatibility transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), and [official TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk). These references establish the protocol requirements; they do not constitute independent service approval.
