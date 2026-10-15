# Configure a Bindle provider

The Worker and Node adapters share the same authorization implementation. Enable the operator-reviewed v0 profile with `FEDERATION_ENABLED=true`; keep public signup controlled separately by `RELEASE_READY`. Never enable public account creation merely to test federation. On Workers the `FEDERATION` binding uses `FederationObject` (migration v4). Node creates per-account SQLite files under its private data directory.

Register an app only after verifying its HTTPS origin and exact callback control. `FEDERATION_CLIENTS` is a JSON array:

```json
[{"id":"https://sync.example/client","name":"My sync app","origin":"https://sync.example","redirectUris":["https://sync.example/callback"]}]
```

App IDs are at most 200 characters and names at most 100. Maximum 100 reviewed apps. Redirect query parameters, if present, are part of exact registration; OAuth response parameter names must be reserved. Client names/icons are presentation, not an endorsement. Browser public clients have no shared secret. Origins receive only their own request/token/RPC CORS permission.

**Unregistered apps (`client-id-metadata.v1`).** `CLIENT_METADATA_ENABLED=true` (default `false`) lets apps use an HTTPS URL `client_id` whose metadata document this provider fetches and validates, with no registration ([wire profile](../spec/federation-implementation.md#client-id-metadata-documents-client-id-metadatav1)). Node uses its DNS-pinned egress automatically (or an injected `CLIENT_METADATA_FETCH` with equivalent guarantees); Workers require the `global_fetch_strictly_public` compatibility flag already in `wrangler.jsonc`. Such apps are labelled by their verified host and marked unreviewed; registered apps keep precedence. Administrators can block a client host from the console's *Client hosts* screen. The flag stays `false` in checked-in production configuration until the SSRF and consent verification gates pass.

Publish each immutable preference fragment at its identifier and register the same JSON document in `FEDERATION_SCHEMAS`, an object keyed by the exact URL. This registry is an intentional trust boundary, not an ambient URL-fetch facility. For example:

```json
{"https://sync.example/preferences/v1":{"id":"https://sync.example/preferences/v1","title":"Sync storage","description":"Choose storage for your sync files.","publisher":"https://sync.example","fields":{"files":{"title":"Storage","type":"resource","contracts":["https://3sln.me/artefacts/contracts/object-storage/v1"],"cardinality":{"min":1,"max":4}}}}}
```

Use a new URL for changed fragment semantics or fields. The provider pins a validated canonical JSON digest and rejects changed bytes under a previously used URL. A future safe egress/registration implementation can replace this local registry through injected resources without changing the app's grant/RPC model. Arbitrary network metadata fetch or open dynamic registration is not enabled by setting an environment flag; the only metadata fetch is the bounded client-document resolution above, behind its own flag and egress port.

For Node, provide these variables through the environment or `createNodeServer({config})`, along with the existing encryption/recovery authority configuration. Only explicit local development supports `http://localhost:<port>`; keep `allowInsecureLocalhost` out of production clients. Public discovery works without cookies. Login/consent stays in the provider's top-level page and real session.

See [SDK integration](../integration.md) and [exact wire profile](../spec/federation-implementation.md). Test the real app origin → provider → registered callback → approved preference read → resource-token RPC sequence before claiming a provider/client interoperable. Revoke a grant, disconnect the app, change a shared scope and recover/suspend the account; all old capabilities must stop working under their documented admission rules. Store encryption/signing secrets and durable namespace/state backups privately; no app configuration includes them.

Current checked-in production federation is disabled and registries are empty. Local browser checks inject a reserved `.example` fixture app and public fragment documents, while authentication/OAuth/RPC run against actual local Wrangler. Those fixtures are never copied into production variables. Current production readiness remains tracked in release-status.json.
