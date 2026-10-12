# Independent browser automation audit

Date: 2026-10-12. Automated reviewer: independent browser automation security agent. Human reviewer: ___ Date: ___ Outcome: ___. This records independent local review, not release approval. Final integrated verification remains the coordinator's responsibility.

The browser adapter must project the existing five MCP tools, with the same strict schemas and account dispatch, rather than create a second privileged automation API. Native browser registration is a discoverability mechanism. It does not identify an OAuth client or grant access to everything visible in the signed-in portal.

## Authority and lifecycle

- Require explicit owner-approved browser-session access with exact collection/action permissions. Keep this authority separate from external HTTP MCP OAuth tokens; the Connected apps browser entry represents this transport, not a verified assistant identity.
- Recheck the live account, session, app connection generation, grant and collection capabilities before every operation. Filtering tool discovery is insufficient: invocation must enforce the same rules.
- Disconnect, revocation, owner change and logout prevent new dispatch. Unregister tools and discard pending browser state on lifecycle changes. Already admitted effects may finish; never promise rollback through an AbortSignal.
- Constrain browser registration to the document's own origin. Do not publish permissive exposed-origin lists or introduce a postMessage-based privileged RPC bridge.
- Browser tools are available while an eligible document exists. Backendless apps do not become durable background servers merely by registering browser callbacks.

## Intent and untrusted content

Mutations require portal-controlled confirmation with a concrete collection, operation and item. Tool arguments, descriptions, annotations, claimed caller names and caller-generated DOM events cannot stand in for owner intent. Confirmation cancellation, logout or changed authority must stop dispatch. Read-only tools still disclose sensitive data and require exact consent.

Treat names, metadata and returned message/file contents as untrusted text. Never turn their instructions into authority, HTML or code. Tool schemas must reject arbitrary URLs, owner IDs, bearer credentials and unknown fields. Bounded request/result sizes, existing work admission and durable write replay protections apply equally to browser and HTTP adapters.

## Standards evidence and limits

The [WebMCP community draft dated 9 October 2026](https://webmachinelearning.github.io/webmcp/) describes `document.modelContext`, callback cancellation, origin exposure and security risks. It explicitly is not a W3C Standard. Its callback does not provide an authenticated agent identity that can be substituted for OAuth. Browser-specific annotations and confirmation features remain hints or evolving APIs; host authorization cannot depend on them. [Chrome's tool security guidance](https://developer.chrome.com/docs/ai/webmcp/secure-tools) discusses prompt injection and consent concerns.

Fake model-context tests establish adapter behavior only. Native experimental API registration, actual agent invocation, cross-origin isolation and browser permissions-policy enforcement need separate evidence. Normal-browser graceful fallback must not claim native availability.

## Independent implementation findings

The [independently authored regressions](../../tests/browser-automation-audit.test.mjs) reproduced and led to fixes for overlapping registration removing a newer tool, logout failing to propagate cancellation to a pending invocation, absent native consequential/untrusted annotations, and inherited prototype names reaching schema validation as tools. Mutation denial and logout during confirmation already prevented dispatch. A subsequent argument-substitution regression identified a caller modifying an item key while trusted confirmation waited; the implementation now clones and recursively freezes the reviewed arguments before dispatch. All seven independent adapter regressions passed locally.

The [thirteen independent session regressions](../../tests/browser-automation-session-audit.test.mjs) use actual Node account controllers and durable SQLite metadata. They verify exact selected collection/function filtering, refusal of another device/session, new collections remaining unauthorized, unavailable sources, grant revocation and generation changes, exact confirmation fingerprints, one-use consumption, concurrent dispatch through the account gate, session expiry, work refusal, strict caller fields and UTF-8 result limits. Corrupted confirmation records originally admitted writes when expiry was missing or `confirmed` contained a truthy nonboolean. Strict finite expiry, session binding and boolean checks now reject those records before effects. The internal browser client identifier is reserved from public MCP client configuration so ordinary OAuth clients cannot overwrite its transport/provenance. All thirteen session regressions passed locally; combined independent coverage is 20/20.

The session tests supply trusted session descriptors directly. Two subsequent [actual Worker HTTP regressions](../../tests/worker/automation.test.mjs) passed using real password signup, recovery activation, account cookies, a second password login and OwnerQuery. They verify anonymous denial, exact mutation Origin and CSRF, selected source/action filtering, unavailable confirmation and substituted-input refusal, one-use writes and byte readback, another device's refusal, app disconnect/reconnect, and old-cookie denial after logout. Miniflare required authorized loopback sockets after the sandbox returned EPERM; the escalated local run passed 2/2. This verifies the HTTP authentication boundary locally, not production deployment or a native browser agent.

Pending frontend API operations now receive their cancellation signal. A server operation admitted before logout can still finish; native activation checks are a frontend consent defense, not server-side proof of a human gesture or isolation from a compromised same-origin script.

Independent cross-review of [callable methods and user commands](../architecture/callables-and-user-commands.md) found no blocker in its proposed constraints: preserve original caller authority throughout human review, retain exact callable identity and immutable schemas, conservatively handle unknown effects, and treat presentation as inert metadata. General upstream app-command import and a published versioned presentation contract remain unimplemented; the trusted host foundation below is a separate opt-in subset.

## Callable command foundation review

The subsequently implemented opt-in host adapter is independently exercised in [callable command audit regressions](../../tests/callable-commands-audit.test.mjs). It treats remote descriptors and results as bounded inert JSON; rejects accessor properties without running getters; requires strict bounded scalar schemas; captures immutable arguments; and obtains portal authority from the trusted host port rather than caller-supplied command details. Binding resolution runs again after asynchronous review, and disappearance prevents dispatch. The dispatcher remains responsible for authenticating the original caller, live source/grant checks, durable replay semantics and reauthorizing private cached results. This trusted port is not an implemented upstream importer or production grant bridge.

The audit reproduced a principal-substitution defect: freezing the outer invocation context did not freeze its nested caller credential record. A caller token could change during asynchronous review before dispatch. The repaired adapter requires deeply immutable inert caller records or immutable primitive identities, preserves the original caller/context object, and checks caller/context properties through own data descriptors before reading them. Mutable nested records and accessors fail without executing getters. All seven independent callable audit regressions and ten implementation/native-fixture tests passed, 17/17 combined. The native fixture verifies existing FederationController journal/authorization behavior with injected trusted ports; it does not establish upstream app import or a production OAuth-to-Bindle grant bridge.


A subsequent [native Chrome integration check](../../tests/e2e/browser-automation-native.test.mjs) passed against the actual local Wrangler app and durable authentication/automation endpoints. Chrome 155.0.8059.40 was launched with experimental WebMCP flags on secure localhost. The test used the real `document.modelContext`, registered and discovered selected tools, executed filtered collection listing, waited for trusted UI confirmation of a hosted-file write, read its bytes back and disabled registration/access. No browser API or owner HTTP responses were mocked in this check. Current Chrome returns serialized results from `executeTool`; the test decodes that boundary explicitly. This is local experimental API evidence, not a production origin-trial rollout or third-party-app interoperability claim.
