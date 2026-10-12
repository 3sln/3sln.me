# Browser automation adapter

Status: provisional implementation contract, 2026-10-12. Human reviewer: ___ / date: ___ / outcome: ___. See [architecture and primary sources](../architecture/browser-automation.md) and [DEVLOG](../../DEVLOG.md) for scope, reconciliation and verification evidence.

## Shared tool contract

The signed-in portal exposes the same built-in operations as [HTTP MCP](mcp-service.md): `collections_list`, `items_list`, `item_read`, `item_write` and `item_delete`. Their names, descriptions, schemas and input validation come from one shared server-side catalog. Browser registration obtains serializable descriptors from the owner API. It must not maintain an independently handwritten schema or introduce a generic resource dispatch tool.

Both transports ultimately invoke the existing account operation implementations. Current inbox writes edit message metadata; hosted storage writes retain conditional creation/replacement behavior. External provider writes remain unavailable. Existing result bounds, ownership/capability checks, quotas, work admission, request IDs and durable mutation receipts continue to apply. A browser wrapper must not report success from a UI state change before receiving the actual operation result.

HTTP MCP remains authenticated by its bearer and exact collection/function grant. Owner browser requests remain authenticated by the current account session, with exact Origin and CSRF checks on mutations. Do not route cookie-only requests into the public bearer endpoint or forward an owner credential to an external app.

## Implemented owner API and portal composition

| Endpoint | Contract |
| --- | --- |
| GET `/api/automation/tools` | Full owner consent choices: shared tool descriptors, current collections and the session's current grant |
| PUT `/api/automation/grant` | `{permissions:[{collectionId,tools}]}` stores exact session access and returns `{grant}` |
| DELETE `/api/automation/grant` | Revokes session browser access |
| POST `/api/automation/prepare` | `{name,args}` creates one bounded pending receipt and returns `{nonce,review:{name,args},expiresAt}` |
| POST `/api/automation/confirm` | `{nonce}` acknowledges that exact receipt and returns `{confirmation}` |
| POST `/api/automation/invoke` | `{name,args,confirmation?}` executes the existing operation; mutations require the confirmed matching receipt |

The durable access record uses the existing owner app-connection resource model, with browser transport and owner-browser consent provenance. It does not identify an individual assistant. The prepare/confirm receipt binds the session, grant generation and exact arguments and expires after two minutes. Its acknowledgment endpoint is an owner-session action, not proof that a human rather than trusted same-origin code clicked a button.

The 3sln portal module provides Automation hub navigation, command-palette access and the contextual `g h` shortcut. The browser provider holds pending callback promises privately; ngin actions prepare and execute requests without holding a state lease while awaiting review. The read-only Query reacts to session changes and clears stale registrations. Bab catalogues supply English and Spanish interface text. Normal unsupported browsers retain access to HTTP assistant connection management.

The mutation review form requires both trusted activating input and a trusted submit event. A scripted `button.click()` can produce a browser-generated trusted submit, so checking the latter alone is insufficient. This guard blocks accidental script-driven submission through this UI; it is not a same-origin script sandbox or remote human-attestation mechanism. Review displays the exact arguments while invocation uses the privately captured immutable input, never editable DOM text.

## Registration lifecycle

The platform adapter detects the current `document.modelContext.registerTool` capability first. An explicitly supported older `navigator.modelContext` implementation can use a separate compatibility branch. Absence means unavailable, without installing a global polyfill that falsely suggests native browser support.

For the current API, await registration and use a registration-scoped `AbortController` for cleanup. Track each installed tool so partial registration fails visibly and is cleaned up. A legacy implementation using `unregisterTool` removes only this adapter's own names; do not clear unrelated document tools. Returned callback functions must independently check the current enabled/session generation, including after cleanup, so retaining a function reference does not revive access.

The initial adapter omits cross-origin `exposedTo`. The shell can explicitly apply `Permissions-Policy: tools=(self)`. Broader embedding and app discovery belong to the later adapter in the architecture document. Browser hints describe read-only behavior, consequential effects and untrusted contents where supported; they are not grants or a security boundary.

Registration and execution cancellation have different lifetimes. Forward execution cancellation where the underlying transport supports it and stop undispatched work. Report cancellation honestly if the server might already have committed. Never automatically retry an uncertain write with a new request ID.

## Session access and consent

The user enables the browser surface explicitly while signed in. Selection must identify exact current collections and supported functions, with no implicit authority over newly created collections. The server binds that selection to the current session and enforces it on every browser dispatch, alongside source ownership and operation semantics. A caller-supplied list of permissions on an execution request cannot establish the approved selection. `collections_list` filters both collection rows and their advertised functions. Browser registration is a projection of this authority and may further narrow it.

Session-bound selection is not a separately authenticated assistant grant. An ordinary script with full same-origin owner-session access already occupies the account's trusted frontend boundary; these checks do not isolate hostile code executing inside that boundary. The native callback does not identify a registered OAuth assistant client. Product language must distinguish this browser-session access from durable assistant connections displayed in Connected apps.

Writes and deletions need trusted visible review of the actual collection, item and effects before dispatch. Bind acceptance to an immutable copy/digest of exact arguments and the current owner/session generation. Cancel on input replacement, logout, changed selection or teardown. Avoid consent controls implemented as callable tools, automatic approval based on a model-supplied field, or assumptions that a platform confirmation helper exists.

Disabling unregisters tools and invalidates retained callbacks. Account logout/replacement, offline state and page teardown revoke the local execution context. Fresh login requires renewed enablement. Late registration/consent/network results cannot restore the old context or disclose the previous owner's result into the new session. A mutation accepted before revocation can complete under the same limitation documented for HTTP MCP.

## Data and failure handling

Private descriptors and operation responses use no-store owner requests and stay out of the public service-worker cache. The registered catalog must contain no session token, CSRF token, provider credential, recovery material or capability URL. Tool output is untrusted data and cannot alter routing, selection or consent.

Unknown tools, unsupported input, unselected collections, unavailable functions, stale sessions and revoked sources fail explicitly. Results preserve the same bounded structured operation data as the MCP adapter; external descriptions cannot become error HTML. Availability UI distinguishes unsupported browser, supported but disabled, registered, offline, expired session and failure. It must not imply that enabling portal tools imports other apps or connects a remote assistant.

## Verification and excluded claims

Required checks cover shared schema parity; malformed inputs; owner/session/Origin/CSRF boundaries; read and conditional-write outcomes through actual account adapters; request replay and changed-input collision; source disconnect; retained callbacks after disable/logout; partial registration; exact confirmation binding; no selected-collection growth; canceled and late responses; and private cache exclusions.

DOM tests and a deterministic injected ModelContext fixture establish adapter behavior only. Native registration/discovery/execution must be reported separately with the actual browser version, enabled experimental feature and result. If the installed browser lacks the API, record that limitation rather than claiming native conformance. Run the project's required runtime and browser suites when their respective code changes.

General upstream MCP import, arbitrary browser-app contribution, cross-origin frame routing, extension/native-host transports, remote assistant-to-browser relay and invocation-scoped delegated credentials remain separate implementation work. The browser adapter does not complete those capabilities. Production remains disabled pending existing release gates and independent review.
