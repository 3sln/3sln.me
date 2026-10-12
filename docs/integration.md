# Integrating with 3sln.me and Bindle

Bindle is an open implementation draft for identity, preference fragments and resource contracts. The current repository contains a working local identity/messaging application; federated OAuth login and general fragment consent are not yet a released interoperability service. Production publication is gated by release-status.json.

Start with [the protocol](spec/protocol.md), [authentication](spec/auth.md), [baseline contracts](spec/contracts.md), [object storage](spec/storage.md), [contact endpoints](spec/contact-tokens.md), [messaging](spec/messaging.md), and [device login](spec/device-login.md).

## App login

The SDK login custom element parses a handle and proposes @3sln.me only before an @ is typed. It preserves other provider hosts and performs host-level well-known discovery without cookies or userinfo. Import packages/sdk/src/login-element.mjs, register the element, and listen for its Bindle login-request event. The element currently emits intent; it does not complete OAuth or imply a profile/resource grant. A conforming provider requires the draft OAuth code/PKCE and explicit preference permissions.

Failed discovery must not downgrade identity. Only definitive absent manifests (404/410) may offer explicit email fallback. 3sln.me returns service-unavailable for its not-yet-enabled federation endpoint, so clients do not incorrectly interpret the unfinished service as an absent identity provider.

## Resources and contracts

Resources have identifiers and exact contract URLs; a display name is not conformance. Apps request field and resource-method scopes, users explicitly approve, and every operation checks live grants/current assignments. Adding a resource does not silently extend an app's access. The proposed object storage contract lives at `/artefacts/contracts/object-storage/v1` with JSON and human representations. It remains a versioned draft until the release gates are complete.

Storage capabilities describe read/write/list/range/presigning support. Do not assume every Google Drive, WebDAV or S3-compatible connection supports safe conditional writes. Presigned URLs are bearer capabilities and can remain valid until expiry even after grant revocation; users must approve that scope explicitly.

## Contact endpoints

The primary shared contact capability is a signed endpoint URL. HTML GET opens the host's composer, a token MIME Accept header yields a short-lived API bearer, and intentional multipart POST to the signed URL delivers a message. Signed URLs and returned bearers need safe handling and log redaction. Collection and MIME/size/count limits are live, revocable and separate from permission to read messages. Subject/tags from a sender are untrusted annotations, distinct from owner classification.

## Self-hosting and extension

[Self-hosting instructions](self-hosting.md) explain the same portable application behind Workers and Node, unbranded by default. Integration credentials, branding and runtime resources belong to the operator. The specifications are open drafts; contact MIME registration, complete machine grant schemas, portability conformance and external storage credentials are still release work. Read the independent interoperability and security reviews before implementing against an assumed stable protocol.
