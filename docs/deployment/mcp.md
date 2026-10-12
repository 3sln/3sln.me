# Configure the 3sln.me MCP endpoint

MCP is a separate 3sln.me application service. It is not a Bindle protocol extension. Configuration and local tests do not enable the account production release gate.

Set `MCP_ENABLED=true`, keep `MCP_LAYOUT=mcp-auth-v1-64`, and configure `MCP_CLIENTS` with operator-reviewed public clients. The checked-in empty client list intentionally permits no authorization flow. A JSON example using reserved domains is:

```json
[
  {
    "id": "agent.example",
    "name": "Example agent",
    "redirectUris": ["https://agent.example/callback"],
    "origins": ["https://agent.example"]
  }
]
```

The client ID is the exact configured string. Supply `origins` only when a browser client requires cross-origin requests. Native/server clients without an Origin header do not need an origin entry. Production redirects require HTTPS. Loopback HTTP redirects are accepted only when the service explicitly runs with `LOCAL_DEVELOPMENT=true`. No wildcard redirects, unregistered clients or auto-fetched client metadata are supported. Obtain the callback URL from the actual client and review it before configuration.

Connect the client to `${APP_ORIGIN}/mcp` and supply its configured client ID when its setup flow asks for one. It discovers the authorization server through `/.well-known/oauth-protected-resource/mcp`. A client must support authorization-code S256 PKCE, exact resource indicators, bearer headers, rotating refresh tokens and MCP Streamable HTTP. It must serialize refresh requests; reuse of a consumed token revokes the connection. The owner signs in using the existing account flow, chooses collections and functions, and approves the connection. Connections expire after thirty days or immediately when revoked in the account interface.

Cloudflare uses the `MCP_AUTH` binding to the SQLite `McpAuthorizationObject` class. Its checked-in migration declares the class. Each authority is named `mcp-auth-v1-64-<two-digit shard>`. Preserve that binding and layout when deploying an updated Worker. Node stores authorities under `.data/mcp/mcp-auth-v1-64-<shard>.sqlite`, with the existing transactional SQLite adapter. Preserve the data directory across restarts and protect it with the same filesystem policy as account databases. Do not reset or rename the layout to solve a migration problem.

Account identity, collections, configured storage adapters, quotas and work budgets remain the authoritative backend. MCP storage does not replace account storage or ship provider credentials to a client. Hosted storage mutations and message metadata/deletion are implemented locally. External provider read operations require a connected source whose current adapter supports the requested function. Adding a key alone does not prove an external provider integration.

Validation commands:

```sh
npm test
node --test tests/worker/mcp.test.mjs
npm run check:worker
```

The Worker test runs real local workerd/SQLite Durable Objects and requires loopback socket permission. Frontend consent changes additionally require DOM/browser checks. Production publication requires the existing security and release gates, independent MCP client interoperability, provider checks and recorded reviewer sign-off in `DEVLOG.md` and [the service specification](../spec/mcp-service.md).
