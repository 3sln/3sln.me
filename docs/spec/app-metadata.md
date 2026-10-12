# Application presentation metadata

Status: optional Bindle presentation extension and implemented local MCP integration, 2026-10-12. Human review: reviewer ___ / date ___ / outcome ___. See [app-resource model](resource-contributions.md), [metadata audit](../release/app-metadata-audit.md) and [DEVLOG](../../DEVLOG.md).

An application's Bindle manifest may describe its presentation through an optional `application` member. This member does not establish identity-provider endpoints, contract compliance, trusted implementation, ownership or permissions. An application-only manifest is not an identity-provider manifest; existing identity discovery still requires its own valid endpoints.

```json
{
  "version": "0",
  "application": {
    "name": "Example notebook",
    "short_name": "Notebook",
    "description": "A notebook using resources you choose.",
    "icons": [
      {"src": "https://notebook.example/icon.png", "type": "image/png", "sizes": "128x128"}
    ],
    "web_manifest": "https://notebook.example/app.webmanifest"
  }
}
```

`name`, `short_name`, `description` and `icons` reuse web app manifest presentation concepts. `web_manifest` is this Bindle extension's optional pointer to a web app manifest, resolved relative to the fetched Bindle manifest. The identity/login portion of a manifest remains independently specified. No new app-state storage, grants or token format is introduced.

The implementation bounds names to 100 characters, descriptions to 500, and icon references to eight. Display text is inert and excludes control and directional override characters. Registered OAuth client identity and callback remain visible; branding never replaces them. Icons are retained as restricted raster references, not automatically fetched by the browser. Until a verified bounded raster cache exists, the portal displays initials. Remote SVG, active content and credential-bearing links are excluded from this import profile.

## Discovery and review

The initial service only discovers sources configured for an operator-reviewed OAuth client. `MCP_CLIENTS` supports optional `application` metadata and `metadataSources` containing `bindleManifest`, `webAppManifest`, `indexPage` and `authorizationPage`. These are public URLs on registered app origins, without embedded credentials, queries or fragments. A login callback URL is not a metadata-fetch authorization credential.

Precedence is explicit registered presentation overrides, then the app's Bindle `application`, then its linked/configured web app manifest. If no valid web app manifest is available, the collector may parse configured index or authorization pages for an HTML `link` whose `rel` includes `manifest`. Parsing runs no scripts, styles, navigation or active DOM. Discovery never fetches OAuth flow parameters or user-authenticated pages. Missing, malformed, slow or unsupported metadata falls back to the registered client name and does not prevent consent or disconnect.

JSON responses are bounded to 64 KiB; HTML to 128 KiB with explicit tree/depth limits. Requests have deadlines, a six-fetch ceiling and no credentials, redirects or active-content execution. Inspection uses short durable transactions around collection; network work occurs outside them. Concurrent inspection shares a bounded in-flight operation, and the reviewed snapshot is pinned on the request before approval and copied to the app connection. A changed manifest does not silently change permissions or existing approved connection metadata.

A web app manifest can legitimately be cross-origin under the web standard. This implementation supports only configured registered origins and does not claim complete browser manifest/CORS conformance. The narrower profile must be surfaced as a discovery limitation, rather than a claim that all cross-origin manifests are invalid. [Web App Manifest specification](https://www.w3.org/TR/appmanifest/)

## Deployment boundaries

Node self-hosting can enable `APP_METADATA_DISCOVERY_ENABLED=true`. Its adapter resolves IPv4 addresses, rejects non-public addresses, pins the selected address to the actual HTTPS request, retains original-hostname TLS verification, and enforces HTTPS/443, bounded bodies/time, no compression/redirects, and per-process concurrency/rate limits. IPv6-only sites fall back. Process-local limits reset on restart and are not a provider invoice cap.

Cloudflare has no equivalent verified metadata egress port configured. It uses declared registered metadata and safe fallback; automatic external discovery remains unavailable there. An injected `APP_METADATA_FETCH` port must verify the actual network destination and enforce equivalent credentials, response and spend policy. A hostname allowlist followed by unconstrained ordinary fetch is insufficient to prove protection against DNS rebinding.

General upstream MCP import, automatic dynamic registration, raster caching and production external-discovery conformance remain release work. Presentation collection does not enable any of those surfaces.
