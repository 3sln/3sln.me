# CX-3 access views (Wave 5)

Provisional local implementation; no production verification or sign-off.
`DEVLOG.md` and shell files are intentionally untouched under CX-3 ownership.

Mount `accessView(model,{dispatch,onNavigate?,onEdit?,onReview?})`, or its
`appAccessView`, `fragmentAccessView`, `resourceAccessView`, `busAccessView`
exports. `model` is the value of the live ngin `AccessView` query. The UI uses
the existing 3sln dodo/ngin stack and CX-1's exact pin/risk/attribution model;
it shares CX-2 card styling and wording, without changing CX-2's private renderer.

Compose the portal engine's existing `state`, `api`, `browser` providers plus
`accessCatalog: Provider.fromSingleton(createAccessCatalog({registrableDomain,
review?,transition?}))` (`bl/access-provider.mjs`). The resolver must use an
accurate public suffix implementation including private suffixes. No heuristic
resolver is shipped. Missing consent contract metadata falls back conservatively;
unknown or invalid fragment metadata leaves the full grant revocable.

Dispatch `new AccessAction(kind,detail)`. Kinds: `open`, `refresh`, `navigate`,
`confirm`, `cancel`, `apply`, `review`. `open` accepts `{route:{kind,id?}}`;
route kinds: `apps`, `fragments`, `resources`, `buses`, `app`, `fragment`,
`resource`, `bus`. `confirm`/`apply` accept `{operation,id,feature?}`;
`apply` additionally requires `confirmed:true`. Operations: `revoke`,
`disconnect`, `purge`, `delete`, `feature`, `unblock`, optional `suspend`/`resume`.
Each confirmation is bound to the loaded target and invalidated on refresh.
Unknown outcomes and refresh failures require a new read before further writes.

EXT-X11: pass an `accessHref` callback to the console:

```js
({connection,fragment}) => fragment ? accessLink('fragment',fragment)
 : accessLink('app',connections.find(c=>c.id===connection).clientId)
```

`accessLink(kind,id)` and `accessRoute(hash)` round-trip `/#access/<kind>/<id>`.
The shell must parse these links and dispatch `open`; this stream does not own
shell mounting. After `open`, route controls dispatch `navigate`; `onNavigate`
is an optional host history callback. `onEdit({fragment})` opens the existing
settings editor. `onReview`/catalog `review({clientId,fragment?,owner,api})`
must open an authenticated owner-started review, never an app-initiated request.
The optional `transition({operation,connection,expectedGeneration,owner,api})` port can
reuse EXT-X11's `connectionsConsole.owner({operation:'connections.'+operation,
input:{connection,expectedGeneration}},{api,owner})`. Until composed, pause/resume
and review controls are absent. Supply `browser.focusAccessConfirmation()`
(focus `#access-confirm-title` after render) and `browser.restoreFocus()`. The existing browser clock (`now`, `delay`) removes
ending-access rows at their server-supplied deadlines; no deadline is guessed.

All reads, actions and UI are behind `INTEGRATIONS_ENABLED` (browser config
`integrationsEnabled`); buses also require `EVENT_BUSES_ENABLED`
(`eventBusesEnabled`). Suppressions require `INCREMENTAL_AUTH_ENABLED`
(`incrementalAuthEnabled`). Missing flags are off. Owner/member/generation checks
hide state after account changes, sign-out and offline transitions. The host
must bump its normal `beamGeneration` when crossing an offline/session boundary.

## Current service boundaries / deviations

- Existing grant HTTP API supports **whole fragment DELETE only**, not narrowing.
  Remove explicitly names and displays every capability that will end, including
  capabilities outside the resource being inspected. No per-method DELETE is
  fabricated. Remove-and-block is not bundled into a non-atomic write.
- Existing owner APIs do not list declined/removed requests or request history.
  The app view states those absences; owner review is an optional composition
  port, not an unimplemented HTTP call. Suppression removal uses the existing
  per-client endpoint and does not replay requests.
- The event API lists provider-hosted feeds only. Integration-hosted feed
  inventory/host replacement/per-consumer review require an owner service
  projection/port before those controls can be offered. No integration-hosted
  inventory or provider-feature last use is inferred from app metadata.
- No exact revocation deadline or receipt is fabricated. Server-supplied
  `access_ends_by`/`accessEndsBy` and acknowledgement remain visible when supplied;
  missing timestamps, last use and history are labelled unavailable. App
  disconnect explains the six-minute integration bound and retained copies.
- Feed history uses an explicit NumericDate `floor_at` only; the opaque `readSince` reader
  epoch is never displayed as a date. Local feed storage is the configured
  provider origin, not the manifest publisher's host.

Local tests: `node --experimental-loader ./tests/browser/loader.mjs --test
 tests/browser/access-engine.mjs`; `node --test tests/browser/access-browser.mjs`.
Browser fixture routes bind only to loopback and are never shipped.

## Local verification (2026-10-21)

- `npm run test:access`: 14 engine-harness tests and 14 Chromium checks pass.
  Browser matrix: en/es × light/dark × 320/390/1440 px, plus flag isolation and
  untrusted-text checks. Keyboard confirmation, cancellation and focus after
  removal are exercised. Screenshots: `artifacts/browser/access/`.
- `npm run test:worker`: 65 pass; `test:ui-state`: 258 pass; `test:dom`: pass.
- `npm run build:assets` and `npm run check:worker`: pass (dry run only).
- `npm run test:e2e`: 180 pass, 4 WebKit skips (WebKit newPage hangs locally).
- Latest `npm test` after concurrent EXT-X8 changes: 1,955 pass, 6 TODO,
  1 failure outside CX-3 ownership: `tests/brokered-severance.test.mjs:120`.
  Its owner-status query reaches the system-only `brokeredResources.severance`
  operation via `packages/federation/introspection.mjs:189` and receives 403.
  Not changed by CX-3. Full output: `/tmp/cx3-core.log`.

These are local fixture/adapter results, not publication authority, independent
review, external-provider conformance or production verification.
