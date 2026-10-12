# Browser automation hub

Status: architecture recommendation and implementation contract, 2026-10-12. Human reviewer: ___ / date: ___ / outcome: ___. Local verification and final implementation reconciliation belong in [DEVLOG](../../DEVLOG.md). This document does not establish browser interoperability or production approval.

## Direction

Use one connected-app and resource model, with small transport adapters around the same tools. A person signs into the hub to choose resources, connect assistant clients, inspect access and disconnect apps. Apps may use any existing resource contracts they are granted, their own backend, browser-local state, or a combination. A backend is optional for a live browser app. No new app-state store or parallel browser permission registry is needed.

The immediate implementation projects the existing five collection/item MCP tools into the signed-in portal's browser context. One shared definition and validation module supplies both HTTP MCP and WebMCP. This establishes an actual local tool path while preserving the existing limits on inbox operations, hosted storage writes, conditional updates, work admission and durable mutation receipts.

General app import remains a distinct integration task. Reuse the approved [app-connection resource direction](app-resource-options.md) and [contribution specification](../spec/resource-contributions.md): one connection can implement multiple separately granted methods. A tool discovered in a page is a candidate descriptor, not an owner-approved function or proof of its effects.

## Current browser evidence

The 9 October 2026 WebMCP draft is a Community Group report, not a W3C Standard. It defines `document.modelContext`, asynchronous tool registration, discovery and invocation. Registration accepts an abort signal for removal; execution has its own cancellation signal. The policy feature is `tools`, defaulting to the same origin. [WebMCP draft](https://webmachinelearning.github.io/webmcp/)

Chrome documents an origin trial beginning with Chrome 149 and a local `enable-webmcp-testing` flag. Availability must be detected in the actual browser; a supported name in source is not evidence of native support. [Chrome WebMCP documentation](https://developer.chrome.com/docs/ai/webmcp)

The current imperative surface supports cooperating cross-origin frames: the host delegates `allow="tools"`, the app registers with an exact `exposedTo` origin, and the host requests that app in `getTools({fromOrigins:[...]})`. Discovery is confined to the document tree. The older `navigator.modelContext` shape is a compatibility adapter, not the current target. [Chrome imperative API](https://developer.chrome.com/docs/ai/webmcp/imperative-api)

Chrome also proposes declarative form tooling through `toolname` and `tooldescription`; `toolautosubmit` permits automatic submission. This is useful for an app's ordinary form flow. It does not import that app into the hub or replace server authorization. The first portal adapter uses imperative tools to reuse the existing schema and dispatcher. [Chrome declarative API](https://developer.chrome.com/docs/ai/webmcp/declarative-api)

## Execution and availability

| Integration | Where work executes | How the hub connects | Availability boundary |
| --- | --- | --- | --- |
| Portal WebMCP tools | Portal document plus existing account adapters | Explicit session enablement and shared tool catalog | Portal must remain open, signed in and online; browser API may be unavailable |
| Existing HTTP MCP service | Account adapters behind `/mcp` | Registered assistant OAuth client and exact collection/function consent | Does not depend on an open browser; supported clients and source adapters still required |
| Cooperative browser app | App document, with its own state or authorized resource calls | Future reviewed app-method binding and native frame adapter | Live document required; embedding, browser support and app consent may prevent connection |
| Upstream MCP app | App's own server | Future reviewed importer and separate upstream credential | Upstream availability and pinned adapter required |
| Installed provider module | Operator-installed compute | Existing resource contract and a reviewed dispatch binding | Module capability and provider lifetime govern execution |

The first two rows are the immediate runtime scope. The remaining rows describe compatible extensions, not implemented connection types. A hub cannot retrieve another site's tools merely from its URL, enumerate unrelated tabs through page JavaScript, or execute a closed app's JavaScript. External assistant-to-live-browser routing requires an actual bridge; `/mcp` cannot make that bridge appear automatically.

## Smallest subsequent browser-app adapter

Prefer a cooperating, owner-opened embedded app where browser support and app framing policy permit it. Keep its real origin visible. Discover bounded candidate descriptors, map each reviewed tool to a safe exact method on the existing app connection, and pin the schema, effects disclosure, producer identity and descriptor revision. Only activated methods enter the outward tool catalog. Native origin gating supplies a transport boundary; it does not authenticate the assistant's OAuth principal or authorize the app's resource dependencies.

Before each dispatch resolve the live owner, consumer, connection generation, exact granted method and actual current document. Recheck the current descriptor against the pinned binding. A navigation, removed frame, changed schema or disconnected producer makes that binding unavailable until validated again. The provider must intersect consumer rights with approved app dependencies; it cannot lend an app its ambient owner session or broad provider bearer. Apps keeping independent state need their own honest trust/effect disclosure, without fictional Bindle storage resources.

If a remote MCP assistant must drive that document, add a bounded owner-authorized live-session transport to the existing dispatch port. Bind each request to the assistant grant, app connection generation, descriptor revision, exact arguments, expiry and journal transaction. The transport carries the approved invocation, never a generic route or bearer that can select other resources. A native callback alone cannot establish those identities. Reuse existing issuer and journal mechanisms where needed; design and independently verify this bridge before enabling it.

Do not begin by implementing an extension, relay service, new workflow language and app storage layer together. First verify one independent static app with two separately granted methods, its own browser state, and one selected existing resource dependency. That fixture should establish the missing authorization bridge without depending on production services.

## Other browser integration surfaces

`postMessage` and `MessageChannel` are possible explicit app transports, not automation discovery or authorization standards. Any later adapter must validate exact sender origin and window, bind a fresh connection instance, constrain message types and sizes, and close access on navigation/disconnect. Avoid wildcard destinations for private messages. [HTML messaging specification](https://html.spec.whatwg.org/multipage/web-messaging.html)

Browser extensions offer content-script and runtime messaging that can support a user-installed bridge. A native messaging host adds separately installed local software. Neither is supplied by ordinary page JavaScript or by this hub today. Extension identity, host permissions and the native-host allowlist require their own adapter and review. [Chrome extension messaging](https://developer.chrome.com/docs/extensions/develop/concepts/messaging), [native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)

A service worker is event-driven and may be terminated when idle. It has no page DOM and does not turn document-scoped WebMCP tools into always-running compute. Existing PWA caching must continue to exclude private account data. [Service Worker specification](https://w3c.github.io/ServiceWorker/)

## Authority and user control

HTTP MCP preserves its current registered-client grants. Portal WebMCP executes in the owner's already authenticated browser session. The latter must be presented as browser-session access: the callback does not supply a verified assistant identity, so the UI must not invent a named assistant connection from browser tool execution. One account login can manage both experiences without conflating their authorization records.

The initial browser adapter requires explicit enablement and local selection of collection/function access. Sensitive writes require a trusted confirmation bound to the actual operation and inputs. Disabling, logout, owner replacement, offline transition and document teardown must stop new calls and invalidate retained callbacks. Already accepted effects may finish; abort is not an undo guarantee.

Tool hints, returned text, app branding and browser-origin exposure cannot expand rights. Keep private tool results outside logs, caches and third-party presentation fetches. Reuse origin/CSRF checks for owner requests. The [browser adapter specification](../spec/browser-automation.md) defines the immediate contract; [security gates](../spec/security.md) still control production release.

| Decision | Review place |
| --- | --- |
| Shared definitions and dispatch for HTTP MCP and portal WebMCP | Reviewer ___ / date ___ / outcome ___ |
| Explicit browser-session access; no inferred assistant identity | Reviewer ___ / date ___ / outcome ___ |
| Future native embedded-app adapter over existing exact method grants | Reviewer ___ / date ___ / outcome ___ |
| No closed-browser or arbitrary-tab availability claim | Reviewer ___ / date ___ / outcome ___ |
