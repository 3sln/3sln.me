# Integrating with 3sln.me and Bindle

Bindle is an open implementation draft for identity, preference fragments and resource contracts. The current repository contains a working local identity/messaging application; federated OAuth login and general fragment consent are not yet a released interoperability service. Production publication is gated by release-status.json.

Start with [the protocol](spec/protocol.md), [authentication](spec/auth.md), [baseline contracts](spec/contracts.md), [object storage](spec/storage.md), [contact endpoints](spec/contact-tokens.md), [messaging](spec/messaging.md), and [device login](spec/device-login.md).

## App login

The SDK login custom element parses a handle and proposes @3sln.me only before an @ is typed. It preserves other provider hosts and performs host-level well-known discovery without cookies or userinfo. Import `BindleClient` from `packages/sdk/src/identity.mjs`, construct it with your registered `clientId` and exact `redirectUri`, and attach it as the login element’s `client` property. Assign fragment requests to its `requests` property. Without a client, the element emits a `bindle-login-request` intent for applications managing their own flow.

`client.beginLogin(identity, {requests})` discovers the provider, creates a provider-stored authorization request with PKCE S256, and returns `authorizationUrl`; navigate there to review consent. On the registered callback page, call `client.completeLogin()` before loading unrelated application code. It verifies the state, issuer, exact callback and expiry, consumes the pending verifier once, removes callback credentials from current history, and exchanges the code without cookies. Access and rotating refresh credentials live only in memory; reload requires a fresh login. Where the provider advertises refresh, access renews before its five-minute expiry without repeating consent, within an absolute eight-hour application session. Parallel calls share one rotation, and the SDK obtains fresh field tokens for the same opaque assignment. An assignment change never silently substitutes a different resource. A failed or uncertain rotation requires a fresh login; writes are not automatically retried. `client.readPreferences(fragment)` returns approved values and scoped resource references; `client.callResource(reference, {contract, method, args})` uses the resource’s attenuated token. `client.signOut()` clears local credentials and pending login; revoke provider grants in Connected apps to stop previously issued access. Omitting requests performs identity-only login and grants no resource access.

Shared preferences can be reviewed and edited in the provider at `/preferences`; a single deliberate save updates the exact listed subscriptions while preserving each app’s method ceiling.

Provider operators explicitly register reviewed client origins/callbacks and immutable fragment schemas. Runtime federation is enabled separately from public-signup release gates. `allowInsecureLocalhost:true` is only for explicit local development; production discovery requires HTTPS DNS origins.

Failed discovery must not downgrade identity. Only definitive absent manifests (404/410) may offer explicit email fallback. 3sln.me returns service-unavailable while its production federation endpoint is disabled, so clients do not incorrectly interpret the unfinished service as an absent identity provider.

## Resources and contracts

Resources have identifiers and exact contract URLs; a display name is not conformance. Apps request field and resource-method scopes, users explicitly approve, and every operation checks live grants/current assignments. Adding a resource does not silently extend an app's access. Browse the [contract registry](/artefacts/contracts/) for direct JSON definitions. The object storage contract identifier `/artefacts/contracts/object-storage/v1` returns its [JSON Schema](/artefacts/contracts/object-storage/v1.json); usage documentation remains separate. It remains a versioned draft until the release gates are complete.

Storage capabilities describe read/write/range/presigning support. Object listing is absent; apps maintain directory/index objects. Do not assume every Google Drive, WebDAV or S3-compatible connection supports safe conditional writes. Object URLs are bearer capabilities for one object and operation. The result reports mode and revocation: native provider URLs can remain valid until expiry after grant revocation, while provider-proxy URLs perform live grant checks. Users approve temporary-link powers explicitly; callers must send the returned requiredHeaders and must not infer revocation behavior from the storage provider name.

## Contact endpoints

The primary shared contact capability is a signed endpoint URL. HTML GET opens the host's composer, a token MIME Accept header yields a short-lived API bearer, and intentional multipart POST to the signed URL delivers a message. Signed URLs and returned bearers need safe handling and log redaction. MIME/size/count limits are live, revocable and separate from permission to read messages. New endpoints automatically add their signed required tags and allow only their signed optional tag choices. Raw sender annotations grant no authority. Legacy collection restrictions remain enforced for compatibility; they are not configurable Views.

## Messages, conversations and Views

The user-facing model is one logical store of messages and conversations. Saved Views filter that store by metadata; an item can appear in multiple Views without duplicate storage. Renaming or deleting a View does not modify retained messages. Views never determine app permissions, and changing their filters cannot expand a resource grant. The owner-facing `/api/views` and `/api/incoming` implementation is separate from the existing scoped app/MCP APIs; it is not yet a new published Bindle RPC contract. See [messaging](spec/messaging.md) for the implemented boundary.

## Self-hosting and extension

[Self-hosting instructions](self-hosting.md) explain the same portable application behind Workers and Node, unbranded by default. Integration credentials, branding and runtime resources belong to the operator. The specifications are open drafts; contact MIME registration, complete machine grant schemas, portability conformance and external storage credentials are still release work. Read the independent interoperability and security reviews before implementing against an assumed stable protocol.

## Hosted SDK artifacts

The documented `/packages/sdk/src/login-element.mjs` and `/packages/sdk/src/identity.mjs` URLs are revalidating public loaders to standalone content-addressed ESM. An embedding app needs no portal import map; anonymous CORS applies to these loaders and their hashed targets. The portal's build manifest also exposes SDK targets for explicit version pinning. The built SDK includes the complete redirect/PKCE/callback and resource-call client. It grants no access without actual provider authentication and explicit consent. Runtime registration and production activation remain separate operator steps.
