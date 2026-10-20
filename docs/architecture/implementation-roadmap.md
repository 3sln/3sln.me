# Integrated implementation roadmap

Status: working plan, 2026-10-20. It merges the slice plans of [extensibility](extensibility-design.md), [BindleBox extraction](messaging-extraction.md) and [app](messaging-app.md), [linked approval](linked-approval.md), [activity center](activity-center.md) and [app engine §12](app-engine.md). Decisions are recorded in [DEVLOG](../../DEVLOG.md). Where this plan and a design's own slice list differ, this plan wins.

## Conventions

- **Slice prefixes:**
  - EXT-X# (extensibility)
  - AMD-C# (spec amendments)
  - BB-C# / BB-B# (BindleBox core prep / app)
  - BB-CUT (extraction cutover)
  - BRIDGE (email bridge)
  - ENG-# (app-engine §12)
  - LA# (linked approval)
  - ACT-# (activity)
- **Gates for every workstream:**
  - `npm test`, `test:worker`, `test:ui-state`, `test:dom`, `build:assets`, `check:worker`, `test:e2e`;
  - an engine-harness suite for every registered operation;
  - for UI streams, browser checks at 320, 390 and 1440 px in en and es.
- **Engine-first:** all new logic is ngin Actions/Queries over providers. Messaging domains are built engine-first inside BindleBox, never migrated into core (ENG-2/3/4/5 are cancelled).
- **Append-only registries** (integrator-owned; slices append their own lines only):
  - `packages/runtime/routes/index.mjs`, `packages/runtime/account/index.mjs`;
  - `RESOURCE_METHOD_HANDLERS` in `packages/runtime/account/storage.mjs` (one contract handler per slice; handlers own method validation and authorization);
  - the `PROVIDERS` rows in `packages/app/providers.mjs` and `ACCOUNT_OPERATIONS` in `operations.mjs`;
  - `package.json` scripts;
  - `packages/i18n/catalogues.mjs`;
  - the flag tables in `wrangler*.jsonc` and `apps/node`;
  - after EXT-X2 lands, the declaration registry in `packages/runtime/federation.mjs`.
- **Flags, all default off:** `EXTENSIONS_ENABLED`, `INTEGRATIONS_ENABLED`, `BROKERING_ENABLED`, `DEVICE_AUTHORIZATION_ENABLED`, `ACTIVITY_V2_ENABLED`, `BINDLEBOX_ENABLED`. Core never imports BindleBox code before cutover.
- **Agent tags:** [A] suits a fully autonomous coding agent; [S] needs a security-focused agent plus cross-review.

## Waves

**Wave 0, stabilize** (integrator, [S]):
- commit LA1a and step-up;
- add the flags and the `tests/bindlebox/*.test.mjs` glob;
- add a resource-method dispatch registry seam in `account/storage.mjs`;
- apply AMD-C1–C11 to the specs;
- set the linked-approval app credential cap to 30 d / 7 d idle, with fresh sign-in only.

### EXT-X1 deferred code from Wave 0

AMD-C1–C11 are applied to the core drafts as **proposed (approved provisionally 2026-10-20)**. Wave 0 changes configuration and the account dispatch seam only; amendment runtime changes and publication artifacts are deferred. EXT-X1 must track and reconcile these gaps before claiming conformance, retaining the later slice ownership below. No independent reviewer sign-off or production verification is implied. DEVLOG.md is unchanged at the user's request.

| Amendment | Code work deferred to EXT-X1 tracking | Implementation slice |
| --- | --- | --- |
| AMD-C1 | `packages/federation/schema.mjs` currently rejects unknown fragment members. Accept unknown top-level members (including `slot`) without displaying them as fields, retain them in digest pinning, and add slot/extension validation and regression tests. | EXT-X1 |
| AMD-C2 | Accept and validate optional request `digest` in federation/entry/SDK request paths; reject mismatches with pinned/fetched canonical document digests. | EXT-X1 |
| AMD-C3 | Change preferences projection to retain approved resources in owner order while omitting unapproved additions and reporting the field in `requiresConsent`; add mixed-approval regression coverage. | EXT-X8 |
| AMD-C4 | Audit resource handlers/adapters and replay errors for no-effect codes; return `indeterminate` for uncertain effects and test failover boundaries. | EXT-X1, EXT-X9 |
| AMD-C5 | Add per-fragment `fragment_outcomes` in token responses and client grant listings, including declined/unsupported/unavailable requests; missing outcomes mean declined. | EXT-X1 |
| AMD-C6, AMD-C11 | Parse and emit bounded extension declarations and the three negotiated features only when their implementations are enabled and mounted; extend consumer capability processing. Flags alone do not advertise support. | EXT-X1, EXT-X2 |
| AMD-C7 | Accept confidential `private_key_jwt` clients only with `integrations.v1`; validate origin/path-bound JWKS, key continuity and approval snapshots. | EXT-X3 |
| AMD-C8 | Implement validated integration endpoints, separate audiences, severance/outbox and bounded read-only revocation; enforce live introspection without cached authorization for write-capable brokered contracts and contract opt-out. | EXT-X3–EXT-X9 |
| AMD-C9 | Publish the preferences v2 artifact and implement uniform resource projection, broker credentials and integration-only `seq`; keep v1 free of brokered values and retain its existing shape. | EXT-X8 |
| AMD-C10 | Validate pinned method `effect`/`introspect` and contract `x-bindle-brokerable` metadata; enforce failover and brokering eligibility, treating unknown effects conservatively. | EXT-X1, EXT-X7–EXT-X9 |

The linked-approval decisions are recorded in [§15](linked-approval.md#15-open-questions--accepted-decisions-2026-10-20). Their implementation remains LA1/LA2/LA4/LA7 work: fresh sign-in for app approval, 30 d absolute / 7 d idle app expiry, provisional lineage retention past natural owner-session expiry for app revocation, ordinary sign-out cascade with warning, reviewed-client eligibility and kind-specific defaults. No linked-approval runtime change is included in Wave 0.

**Wave 1, parallel foundations:**
- LA1 identity core [S]: `packages/identity/{service,device-login,linked-approval,index}.mjs`, the deviceRequests adapter hunks in `apps/worker/index.mjs` and `apps/node/*`.
- IDKEYS-1 (BB-C0) key registry [S]: `packages/identity/keys.mjs`, the registry half of `messaging/contact-tokens.mjs`, `account/identity.mjs`.
- EXT-X1 slot validation [A]: `federation/extensions.mjs`, the fragment validator in `schema.mjs`.
- EXT-X5 brokering keys and JWKS [S]: `federation/signing.mjs`, the JWKS route.
- EXT-X9a conformance fixture skeleton [A].
- LA6 SDK device helper [A]: `packages/sdk/src/device.mjs`.
- LA4 approval page, mock-first [A]: `apps/web/src/{bl,ui}/approve.mjs`.
- BB-C2 records and content move [A]: `packages/core/records.mjs`, `packages/content/*` with re-exports; `dispatcher.mjs` → `runtime/lifecycle-notices.mjs`.
- BB-B0 then B1, skeleton and protocol: B0 [A], B1 [S]. `packages/bindlebox-engine/*`, `packages/bindlebox-protocol/*`, `tests/bindlebox/*` with harness and network simulator, an import-boundary test, `scripts/bindlebox.mjs`.

**Wave 2:**
- LA2 federation device grant [S] (no `client-metadata.mjs` edits).
- EXT-X3 integration manifest [S] (owns `client-metadata.mjs`).
- EXT-X2 manifest declaration registry [A].
- BB-C1a core links [S] (`packages/links/*` with re-exports).
- IDKEYS-2 (BB-C3) key delegation [S] (new `routes/delegation.mjs`).
- ACT-1 activity backend [S] (`packages/activity/*`, the core halves of message records, Views, routes).
- ACT-2 push policy [S].
- BB-B2 contacts and receive [S].
- BB-B3 send queue and events [A].
- LA5 requesting screen [A].

**Wave 3:**
- LA3 mount [S] (declares `device-authorization.v1` only when the flag is on and routes are mounted).
- EXT-X4 connections domain [S].
- BB-C1b descriptor and slot handoff [S].
- BB-B4 conversations [S].
- BB-B5 views/rules/tags/classify [A].
- BB-B7 bridge receiver [S].
- BB-B8 app shell [A].
- ACT-3 activity UI [A].
- LA7 revocation UI and notices [S].

**Wave 4:**
- EXT-X6 event outbox [S].
- EXT-X7 discovery and brokered records [S].
- EXT-X10 built-in classifier and Drive manifest [A].
- BB-B6 archive and app switch [S].
- BB-B9 BindleBox web UI [A].

**Wave 5:**
- EXT-X8 preferences/v2 and severance [S]; write-capable contracts require introspection.
- EXT-X9b conformance [A].
- EXT-X11 connections console [A].

**Wave 6, BB-CUT** (one integrator, [S]): one change that removes peer messaging from core and 3sln.me per the extraction plan, with a `messaging-retired-v1` reset step. It's the only irreversible step: tag the commit before it. Prerequisites:
- every BB-B stream, C1b, IDKEYS-2 and X4;
- durable queue recovery on Node and on workerd with SQLite Durable Objects;
- simulator scenarios;
- browser checks of partial counts, Retry missing and SSE reset.

**Wave 7:**
- BRIDGE [S] in `packages/email-bridge/*`.
- Post-cutover engine work [A]: ENG-8 search, then ENG-11 beaming, then ENG-9 lifecycle. ENG-13a/b/c only after LA and EXT stop editing identity and federation files.

## Conflict resolutions

1. Prefixed IDs resolve the collisions between the plans' "X1", "X12" and "C1–C3".
2. `identity/service.mjs` and `identity/index.mjs`: W0, then LA1 as sole owner; ENG-13a deferred until after LA3.
3. `routes/identity.mjs`: W0, then LA3. Delegation status goes in a new `routes/delegation.mjs`.
4. `account/identity.mjs`: C0 and C3 run as one sequential IDKEYS stream.
5. `apps/worker/index.mjs` and `apps/node/*`: one owner per wave (LA1 in W1, BB-CUT in W6, the integrator otherwise).
6. Message records: ACT-1 owns the core halves after BB-C2's move. BindleBox copies and never edits originals. Peer records are reset (pending user confirmation). `/api/collections` is deleted at cutover.
7. `dispatcher.mjs` and `apps/worker/email.mjs` stay in core.
8. `client-metadata.mjs`: owned by X3. Metadata-document clients get no device grant.
9. App connections: X4 owns connections; ACT owns notification/push; MCP account tools come after cutover.
10. `federation/service.mjs` and `http.mjs`: X5 (W1), then ACT (W2), then X8 (W5). New federation modules are engine-first.
11. Manifest builders: X2 creates the registry, and others append to it.
12. Beaming, search and lifecycle engine migrations come after cutover; ACT hooks export/erase into lifecycle.
13. `contact-delivery*`: copied in B1, deleted at cutover.
14. App credential lifetime: 30 d / 7 d idle, only with a fresh sign-in (user decision).
15. `bl/release.mjs` edits are serialized: W0, LA4, LA5, ACT-3, BB-CUT.
16. Classifier: X10 (occupant) and B5 (consumer) share one slot manifest, settled before B8.

## Deployability

Every wave ends green with flags off, which means a deployable `check:worker` plus a local Worker run. W1–W5 add only unreferenced packages, flag-gated routes, or pure moves with re-exports. BB-CUT is the only non-reversible step.
