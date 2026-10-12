# Reference implementation boundaries

The spec documents describe the proposed production system. This first slice demonstrates consent and authorization, with deliberate differences listed here so downstream developers do not mistake fixture code for protocol conformance.

| Area | Present | Required for production |
| --- | --- | --- |
| Authentication | Demo owner supplied internally | Authenticated owner session, OAuth code/PKCE, WebAuthn, verified email lifecycle |
| Discovery | SDK validates fetched manifests; server advertises none | Published issuer manifest, CORS, registered endpoints and secure code exchange |
| Consent | Explicit resource selection, method acknowledgment, grant ledger and revoke | General declarative fragment UI, field-scoped atomic preferences, schema pinning, multi-fragment consent |
| Grants | Opaque random bearer fixture, five-minute expiry, live grant/assignment intersection | Issuer/audience/client binding, durable storage, quotas and audit |
| Storage | In-memory string objects, 64 KiB cap, `ifMatch`/etag preconditions | Spec byte/base64 object contract, metadata, pagination, durable hosted namespace |
| RPC | Demo `tx/resource/contract/method/args` request | Versioned envelope, spec error schema/status mapping, UUID validation and limits |
| Transactions | Journal keyed by grant + tx; canonical args, successful outcomes cached | Entity/client-scoped durable journal for 24h, error outcome recording, indeterminate upstream recovery |
| Contracts | Demo `.example` constants and simplified fragment shape | Published immutable schema definitions and exact spec contract IDs |
| Integrations | No credentials or upstream calls | Credential vault, SSRF controls, adapter-specific concurrency conformance |

The demo resource grants cover the selected storage as a whole. Apps must clearly understand this scope. Whether shared resources should additionally support user-approved app namespaces is an outstanding design question, not an implicit isolation guarantee.

Production sequence: durable identity/session store → complete owner authentication → registered OAuth client flow → general fragment/consent service → spec-conforming hosted storage → independently hosted interoperability fixture → provider adapters. Security and conformance tests are release gates. User testing is required before calling the consent experience intuitive or accessible.
