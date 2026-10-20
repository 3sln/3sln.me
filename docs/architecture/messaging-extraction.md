# Messaging extraction plan

Status: **provisional plan**, 2026-10-20. Documentation only: nothing has moved yet. This plan implements the [BindleBox architecture](messaging-app.md) and the [BindleBox interop draft](../spec/bindlebox.md). It is coordinated with:

- the activity owner's [activity center](activity-center.md) extraction table, which owns every "core: activity" row below;
- [extensions](../spec/extensions.md);
- the [app engine](app-engine.md).

Paths reflect the completed Phase 0 split into `packages/runtime/routes/*.mjs` and `packages/runtime/account/*.mjs`. Sign-off: reviewer ___ / date ___ / outcome ___.

Disposition labels used in every table:

- **Core: links** goes to the new core package `packages/links/`.
- **Core: content** goes to the shared `packages/content/`, as the activity center also proposes.
- **Core: activity** stays in core and is owned by the activity slice; this plan only removes peer behaviour from it.
- **Core** stays in core with minor edits.
- **BindleBox** moves into `packages/bindlebox-*` or `apps/bindlebox/`. "Copy" means BindleBox takes a copy, core keeps its own, and the two diverge.
- **Delete** means the code is removed with no successor.

## 1. Principles

1. **The extraction is real.** BindleBox code may import only:
   - `packages/bindlebox-*` and `apps/bindlebox/**`;
   - `packages/core/primitives.mjs` and `packages/content/*`;
   - `packages/sdk/*` (as an ordinary Bindle client);
   - `/vendor/{ngin,dodo}`;
   - npm dependencies.

   Core may not import BindleBox at all. `tests/bindlebox/import-boundary.test.mjs` enforces both directions by static import scan, so a later split into its own repository is a directory move.
2. **Copy, then diverge, where both sides need a mechanism.** Views, item index, receipt budget, tag rules and the record store are used by both activity and BindleBox. Sharing a mixed module would recreate the coupling being removed. The exceptions are code that is genuinely generic and stable: `packages/core/primitives.mjs`, `packages/content/`, `packages/links/` (core only).
3. **No dual paths.** At cutover, core stops accepting peer deliveries in the same change that enables the BindleBox occupant. There is no period where both accept.
4. **Engine-first** (§7). BindleBox ships with its engine, harness and simulator before any UI.

## 2. Module classification

### 2.1 `packages/messaging/`

| File | Disposition | Notes |
| --- | --- | --- |
| `bindle-links.mjs` | **Core: links** → `packages/links/envelope.mjs` | Generic parser, JWS, `md`, replay digest. `CONTACT_LINK_TYPE` moves to the BindleBox protocol (as the new type URI). `packages/identity/link-response.mjs` re-points to it. |
| `link-replay.mjs` | **Core: links** → `packages/links/replay.mjs` | Audience-response replay record. |
| `contact-endpoints.mjs` | **Split** | Link issuance, stored exact-claims verification and challenge rotation become **Core: links** (`packages/links/issuance.mjs`, the links contract). Contact parent semantics (kinds, quotas, intake) go to **BindleBox** `domains/contacts.mjs`. Legacy `?sig=` endpoints, inbox bearers and contact-delivery bearer minting are **Deleted**. |
| `contact-tokens.mjs` | **Delete**, after moving the key registry | `ContactTokenService` currently holds the identity public-key registry (`registerKey`, `contact-key` records) used by `account/identity.mjs`. Slice C0 moves that registry to `packages/identity/keys.mjs` first. |
| `contact-delivery.mjs` | **BindleBox** → `packages/bindlebox-protocol/envelope.mjs` | Starting point: add `profile`, `delegate`, `proof.delegation`, record kinds and the new prefixes. Remove bearer and genesis-v2 code that the spec trims. |
| `contact-delivery-wire.mjs` | **BindleBox** → `packages/bindlebox-protocol/wire.mjs` | Keep multipart. Delete the RPC transport. Add multicast. |
| `contact-delivery-service.mjs` | **BindleBox** → `packages/bindlebox-engine/domains/receive.mjs` | Admission transaction, author-scoped receipts, intake tags. |
| `messages.mjs` | **Split** (activity owner leads) | Core activity forks the generic record and rule primitives. BindleBox copies `MessagingService` as the base of its mailbox store (`store/mailbox.mjs`). Collections and legacy partitions are **Deleted** on the BindleBox side; it has no collections. |
| `store.mjs` | **Core** → `packages/core/records.mjs` (rename), with a compatibility re-export until importers move | Imported by more than 30 core modules (`key`, `MessagingFault`, digests). BindleBox copies the few helpers it needs. |
| `content.mjs` | **Split** | Inert renderer, CSP and web-archive validator become **Core: content** (`packages/content/render.mjs`). Conversation MIME and text helpers go to **BindleBox**. |
| `form-parser.mjs`, `form-policy.mjs`, `presentation-summary.mjs`, `submission-status.mjs` | **Core: content** | App-message forms belong to activity. BindleBox does not submit forms in v1. |
| `message-metadata.mjs` | **Core: activity**; **BindleBox** copy | |
| `notifications.mjs`, `web-push.mjs` | **Core: activity** | BindleBox notifies through activity (architecture §14). |
| `dispatcher.mjs` | **Core** (move to `packages/runtime/lifecycle-notices.mjs`) | It is `dispatchLifecycleNotice`, used only by `lifecycle-runner.mjs`. The activity center's table lists it as moving to the messaging app, which is a misclassification ([review](../release/messaging-app-review.md) R-1). |
| `tags.mjs` | **Split** | Core keeps the ID grammar, `sys:` reservation and look-alikes, label display and the registry used by activity. **BindleBox** copies the suspected categories, provenance, promotion defaults and `applyAutomatedTags`. |
| `tag-policy.mjs` | **BindleBox** | Contact intake tags. |
| `index.mjs` | **Delete** | Barrel file. Importers re-point. |

### 2.2 `packages/conversations/`

| File | Disposition | Notes |
| --- | --- | --- |
| `index.mjs`, `runtime.mjs`, `http.mjs` | **Delete** | Conversation v1 (central authority, `actor:"bearer"`) is withdrawn. Regression lessons carry over as BindleBox simulator scenarios: the blob-cleanup 409 defect, lost ACKs and peer retries. |

### 2.3 `packages/runtime/`

| File | Disposition |
| --- | --- |
| `contact-links.mjs` | **Split.** `linkAudienceDecide`, `admitLinkAudience`, `inspectContactLink`, `signOwnLinkResponse` and `collectLinkState` become **Core: links** (`packages/links/audience.mjs`). `authorLinkEnvelope` becomes **BindleBox** (`domains/send.mjs`, signing with the delegate key). |
| `contact-preview.mjs` | **Core: links** → `packages/links/preview.mjs`. Landing page and oEmbed become type-generic. |
| `developer-contact.mjs` | **Core.** The policy registry moves to `packages/links/policies.mjs`. Developer link issuance goes through the developer account's BindleBox occupant and the links contract. Cleanup of daily grants is **Deleted** (legacy). |
| `message-receipt-budget.mjs` | **Core: activity** (activity lane); **BindleBox** copy (`domains/receive-budget.mjs`). |
| `message-views.mjs`, `item-index.mjs` | **Core: activity**; **BindleBox** copy, including the conversation overlays and read watermark (activity center row). |
| `message-postbacks.mjs`, `message-presentations.mjs`, `app-notifications.mjs` | **Core: activity**. |
| `accounts.mjs` | **Core.** Remove construction of `ContactEndpointService`, `ContactDeliveryService` and conversations. Construct the links services and the identity key registry. |
| `lifecycle-runner.mjs`, `lifecycle-storage.mjs`, `storage-quota.mjs`, `federation.mjs` | **Core.** Remove messaging references (store import becomes records). Lifecycle erase and export stop enumerating peer messaging state after the reset (§4). |

### 2.4 `packages/runtime/account/` (AccountController slices)

| File | Disposition |
| --- | --- |
| `contacts.mjs` | **Split.** `developerContactTier`, `developerContactLink`, `linkAudienceDecide`, `inspectContactLink`, `signLinkResponse` and `rotateContactChallenge` go to a new **core** `account/links.mjs` (also `issueLink`, `revokeLink`, `evaluateLink`). `createContact`, `createContactLink`, `contactIntake`, `updateContactIntake`, `revokeContact`, `quarantineContact` and `contactURL` go to **BindleBox** (`domains/contacts.mjs`). `authorLinkEnvelope`, `mintContact`, `mintDeliveryToken`, `mintInvitationBearer`, `createSystemContactLink`, `finishContact` and `contactMetadata` are **Deleted** in core; the intake representation moves to the BindleBox ingress. |
| `delivery.mjs` | **Delete** (`verifyLinkCredential`, `deliverLink`, `receive`). BindleBox `domains/receive.mjs` replaces it. |
| `conversations.mjs` | **Delete.** |
| `messages.mjs` | **Core: activity.** The activity slice splits it, and collection and peer methods are deleted. |
| `views.mjs` | **Core: activity.** The conversation-card projection is removed. |
| `identity.mjs` | **Core.** Re-point `signingKey` to `packages/identity/keys.mjs`. Add `delegationCertificate(owner, {jkt, purposes, client, cnx})`, `revokeDelegation` and status for `key-delegation.v1`. |
| `notifications.mjs`, `search.mjs`, `storage.mjs`, `billing.mjs`, `lifecycle.mjs`, `beams.mjs`, `automation.mjs` | **Core.** Search drops the peer sources. |
| `index.mjs` | **Core.** Remove the `contacts`, `delivery` and `conversations` entries. Add `links`. |

### 2.5 `packages/runtime/routes/`

| File / route | Disposition |
| --- | --- |
| `contacts.mjs` | **Split.** |
| `/oembed`, `/users/:h/contact/:id/avatar` | Core: links (`routes/links.mjs`). |
| `GET /users/:h/contact/:id` (HTML landing, JSON inspection, contact profile) | Core: links. |
| `GET …` with `Accept: application/vnd.bindlebox.ingress+json` | New core route (descriptor through the messaging-ingress occupant's `describe`). |
| `GET {identityURI}/delegations/{jkt}` | New core route (`key-delegation.v1` status, slice C3). |
| Links contract RPC (`issue`, `revoke`, `evaluate`, `list`, `changes`) | New core resource methods (slice C1). |
| `POST /api/links/respond` | Core: links. |
| `GET /api/developer-contact` | Core. |
| `POST /api/contact-links`, `/api/contacts*` (intake, rotate, QR, quarantine, URL) | **BindleBox** app API (`apps/bindlebox/worker`). Rotation is also exposed via the links contract. |
| `POST /api/links/envelope` | **Delete** (BindleBox signs locally). |
| Token-mint GETs and the contact-intake representation | **Delete** in core. Intake moves to the BindleBox `/intake`. |
| `delivery.mjs` (`/bindle/rpc` contact-delivery dispatcher, signed-link POST, anonymous refusal stubs) | **Delete.** POST to a link URL then returns 405 `Allow: GET, HEAD`. |
| `conversations.mjs` (`/api/conversations*`) | **Delete.** |
| `messages.mjs` (`/api/messages*`, `/api/collections`) | **Core: activity** splits it. `/api/collections` is **Deleted**. |
| `views.mjs` (`/api/views`, `/api/incoming`, `/api/rules`, `/api/tags/labels`) | **Core: activity.** |
| `shared.mjs` | **Core.** `signedContactPath` is kept for the landing route. |
| `federation.mjs`, `notifications.mjs`, `search.mjs`, `site.mjs` (`/users/`), `index.mjs` | **Core.** `index.mjs` removes the `delivery` and `conversations` route modules and adds `links`. |

### 2.6 Other packages, apps and scripts

| Path | Disposition |
| --- | --- |
| `packages/app/domains/views.mjs`, `tags.mjs` | **Core: activity**. **BindleBox** copies into `packages/bindlebox-engine/domains/{views,rules}.mjs`. |
| `packages/app/{engine,providers,operations,faults,account,memory-providers}.mjs` | **Core.** Remove the `messaging`, `contacts`, `delivery` and `conversations` catalogue rows. BindleBox has its own catalogue (§7). |
| `packages/beaming/contacts.mjs` | **Split.** In-person contact-card exchange becomes a handoff to the user's messaging occupant (`web+bindle://add-contact`). It stops calling `ContactEndpointService`. Device file beaming is unchanged. |
| `packages/beaming/profile.mjs` | **Core: links.** Contact-profile representation and Accept selection. Remove `CONTACT_INTAKE_MIME` and the delivery-token profile. |
| `packages/identity/link-response.mjs` | **Core.** Imports `packages/links/envelope.mjs`. |
| `packages/search/content.mjs` (`messageSearchDocument`, conversation text) | **Core: activity**; **BindleBox** copy for its own local search. |
| `packages/mcp/account.mjs`, `service.mjs` (`item_read`, `item_write`, `item_delete` over messages) | **Core: activity** (items become activity items). BindleBox MAY later expose its own MCP tools under its own grant. |
| `packages/federation/*` | **Core** (store import re-point only). |
| `apps/worker/index.mjs`, `objects.mjs`, `apps/node/server.mjs`, `resources.mjs` | **Core.** Remove messaging wiring and the conversation-drain alarm. |
| `apps/worker/email.mjs` | **Core** (system mail). The activity center lists it as moving; that is incorrect (R-1). The SMTP *ingress* adapter for the bridge, when built, is also core (architecture §13). |
| `scripts/message-frame-controller.mjs`, `message-sanitizer.mjs`, `spikes/message-forms.mjs` | **Core: activity.** |
| `scripts/engine.mjs` | **Core.** BindleBox gets `scripts/bindlebox.mjs`. |

### 2.7 Web UI (`apps/web/src`)

| File | Disposition |
| --- | --- |
| `bl/contact-link.mjs` | **Split.** The public landing, opener audience-response flow and provider handoff (links §9, §6.4) become **core**. Compose and send become **BindleBox** `apps/bindlebox/web/src/bl/compose.mjs`. |
| `bl/contact-links.mjs`, `ui/release-intake.mjs`, `ui/release-contact.mjs` | **BindleBox.** The core landing page keeps a slim generic version of the `release-contact.mjs` header and audience states. |
| `bl/conversations.mjs`, `ui/release-conversations.mjs` | **BindleBox** (rewrite for the mesh model, status sheet and resend). |
| `bl/incoming.mjs`, `ui/release-incoming.mjs`, `ui/release-inbox.mjs`, `ui/release-views.mjs`, `ui/release-search.mjs` | **Core: activity** (activity owner) for the activity feed. **BindleBox** copies the feed, View and detail patterns. |
| `ui/release-developer-contact.mjs` | **Core.** Its button hands off a `send-message` intent to the user's occupant. |
| `bl/message-actions.mjs`, `ui/message-actions.mjs`, `providers/message-actions.mjs`, `providers/message-frame.mjs` | **Core: activity.** |
| `ui/tag-pill.mjs` | **Core**. **BindleBox** copy. |
| `ui/release-dialogs.mjs`, `ui/release-app.mjs`, `bl/release.mjs`, `release.mjs`, `providers/{api,browser,browser-state}.mjs` | **Core.** Remove peer-messaging navigation, dialogs and state after cutover. |
| `bl/beaming.mjs`, `ui/release-beaming.mjs` | **Core.** Contact-card results hand off to the occupant. |

### 2.8 Tests

| Disposition | Files |
| --- | --- |
| **Core: links** (keep; drop contact-type delivery cases) | `tests/bindle-links.test.mjs`, `link-replay.test.mjs`, `link-response.test.mjs`, `contact-preview.test.mjs`, `links-http.test.mjs` (landing, inspection and descriptor; delivery cases removed), `developer-contact.test.mjs` (policy and issuance), `tests/link-helpers.mjs` |
| **Core: activity** (activity owner) | `message-postbacks.test.mjs`, `message-postbacks-http-audit.test.mjs`, `message-presentations.test.mjs`, `message-presentation-summary.test.mjs`, `message-push-preview.test.mjs`, `submission-status.test.mjs`, `app-notifications.test.mjs`, `app-notifications-audit.test.mjs`, `web-push-transport.test.mjs`, `form-fetch*.test.mjs`, `e2e/message-frame.test.mjs`, `e2e/message-submissions.test.mjs`, `browser/message-actions.mjs`, `browser/message-outcomes-audit.mjs`, `browser/message-motion-audit.mjs` |
| **Split** (core keeps the activity half; BindleBox copies the peer half into `tests/bindlebox/`) | `messaging.test.mjs`, `message-views.test.mjs`, `message-receipt-budget.test.mjs`, `tags.test.mjs`, `engine-views.test.mjs`, `engine-tags.test.mjs`, `engine-tag-rules.test.mjs`, `engine-item-index.test.mjs`, `worker/message-budget.test.mjs`, `tests/helpers/messaging-fixture.mjs`, `browser/contact-links.mjs` (opener flow core, compose BindleBox), `e2e/links-worker.test.mjs`, `e2e/links-conditional.test.mjs` |
| **BindleBox** (rewritten against the new protocol; current cases become the behavioural checklist) | `contact-delivery.test.mjs`, `contact-delivery-spec.test.mjs` (vectors re-cut for the new prefixes), `contact-endpoints-links.test.mjs` (parent semantics), `contact-tags.test.mjs`, `conversation-content.test.mjs`, `engine-delivery.test.mjs`, `engine-links.test.mjs` (delivery half), `node-contact.test.mjs`, `worker/contact.test.mjs` |
| **Delete** | `contact-endpoints.test.mjs` (legacy `?sig=` and inbox bearers), `conversations.test.mjs`, `conversations-http.test.mjs`, `conversations-audit.test.mjs`, `conversations-portable.test.mjs`, `worker/conversations.test.mjs`, `e2e/mcp-conversations.test.mjs`, `browser/mcp-conversations.mjs` |
| **Core, edit references only** | `account-sessions`, `app-metadata`, `app-connections-audit`, `beaming-runtime`, `beaming-security`, `builtin-storage`, `lifecycle-runner`, `mcp`, `mcp-audit`, `search`, `search-runtime`, `work-budget`, `work-spend-audit`, `engine-storage-chaos`, `node-runtime`, `recovery-identity-runtime`, `scaling-audit` (`.test.mjs`); `worker/{accounts,lifecycle,security,mcp,app-engine}.test.mjs`, `worker/harness.mjs`; `e2e/{chaos,ui-chaos,ui-chaos-scale,ui-chaos-contention,ui-adversarial,signup-views,plans-search,worker-flow,beaming}`; `browser/{beaming,multi-account,owner-flow-audit,ui-chaos,signup-views}.mjs` |

`package.json` gains `test:bindlebox` and adds `tests/bindlebox/*.test.mjs` to `npm test`. Slice B0 owns that edit.

### 2.9 Specs, architecture docs and artefacts

| Document | Disposition |
| --- | --- |
| `docs/spec/links.md` | **Core.** Keep §1–§5, §6.4 (intents, now naming the messaging-ingress occupant as handler), §7.1–§7.4, the GET half of §8, §9, §11 generic vectors. Move §6, §6.1–§6.3, the delivery half of §7.5 and §10 to `bindlebox.md`. Add the BindleBox prefixes and the delegation `typ` to the §7.2 table. Add the descriptor representation. |
| `docs/spec/contact-delivery.md`, `docs/spec/contact-tokens.md`, `docs/spec/conversations.md` | **Superseded.** Replace each body with a stub pointing at `bindlebox.md`. History stays in git. Key-custody text from contact-tokens moves to an identity spec section. |
| `docs/spec/messaging.md` | **Split.** Safe rendering and archives go to `message-content.md` (core). Views, rules and receipt limits go to BindleBox architecture. Collections are **Deleted**. The file becomes a stub. |
| `docs/spec/message-content.md`, `app-messages.md`, `notifications.md`, `activity.md` | **Core.** |
| `docs/spec/protocol.md` | **Core.** Add the `key-delegation.v1` feature row, plus the links contract once agreed. |
| `docs/architecture/conversation-contact-design.md`, `conversations.md`, `contact-delivery-wire.md` | **BindleBox** rationale (historical). Add a superseded banner pointing to `messaging-app.md`. |
| `docs/architecture/message-views.md`, `tags.md` | **Split**, as in §2.1 and §2.4. |
| `docs/architecture/public-email-bridge.md` | **Core.** Add the handoff section reference (architecture §13). |
| `docs/architecture/message-sender-identities.md` | **Core** (identity). Delegation is now `key-delegation.v1`. |
| `docs/architecture/message-actions.md`, `app-notifications.md` | **Core: activity.** |
| `docs/architecture/bindle-links.md`, `system-identities-contact.md`, `contact-link-previews.md` | **Core** with BindleBox cross-references. |
| `docs/artefacts/conversation-v1.json` | **Retained immutable.** Mark withdrawn in the registry. Published JSON never changes. |
| `docs/architecture/artefacts/contact-delivery-v1.{schema,vectors}.json` | **Historical.** BindleBox vectors go to `packages/bindlebox-protocol/vectors/`. |
| `docs/architecture/artefacts/bindle-links.vectors.json` | **Core** (generic items). Contact-type items are re-cut in the BindleBox vectors. |
| `docs/release/*` messaging reviews and audits | Historical record. Unchanged. |

## 3. Monorepo layout

```
packages/
  links/                       core: envelope, replay, audience, issuance, preview, policies
  content/                     shared: render, archive, forms, presentation summary, submission status
  core/records.mjs             core: formerly messaging/store.mjs
  identity/keys.mjs            core: identity key registry (formerly in ContactTokenService)
  bindlebox-protocol/          pure wire, no I/O
    envelope.mjs delegation.mjs link-contact.mjs records.mjs receipts.mjs
    wire.mjs multicast.mjs descriptor.mjs archive.mjs errors.mjs vectors/
  bindlebox-engine/            engine-first app logic
    engine.mjs providers.mjs operations.mjs faults.mjs
    store/{mailbox.mjs,item-index.mjs,archive-writer.mjs}
    domains/{contacts,intake,receive,receive-budget,send,outbox,conversations,
             views,rules,tags,bridge,classify,delegation,archive,events}.mjs
apps/bindlebox/
  integration.json             integration manifest: slot occupant entries, webhook (assumed members)
  slots/messaging-ingress-v1.json
  worker/{index.mjs,mailbox-object.mjs}  wrangler.jsonc
  node/server.mjs
  web/src/{bl,ui,providers}/   3sln stack, vendored ngin/dodo
tests/bindlebox/               unit, engine, simulator, worker, browser
scripts/bindlebox.mjs          engine CLI
```

Splitting out later means moving `packages/bindlebox-*`, `apps/bindlebox`, `tests/bindlebox` and `scripts/bindlebox.mjs`, and vendoring `packages/core/primitives.mjs` and `packages/content/` (or depending on them as published packages). The import-boundary test proves nothing else is needed.

## 4. Data: reset, not migration

Production is disabled and nobody uses it (AGENTS.md, DEVLOG). Messaging state is discarded at cutover rather than migrated. Justification:

- Every stored contact parent is either a legacy `?sig=` grant, whose delivery is already retired, or a `bindle_meta` parent whose meta becomes a different link type, so the old metas would not verify for BindleBox.
- Conversation v1 rooms cannot be represented in the mesh model.
- Message records live in account Durable Object keys under a schema with collections, which BindleBox does not have.
- Migration code would be throwaway, could never be tested against real user data, and would carry the old schema's coupling into the new app.
- The [activity center](activity-center.md) cutover proposes "transfer remaining peer records … through an explicit owner-reviewed migration". For peer records this plan supersedes that sentence with a reset, which needs the user's sign-off (architecture §19, question 7). App-message records still migrate into activity as the activity owner designed.

**Reset procedure (slice C4).** A versioned, idempotent account step, `messaging-retired-v1`, runs inside the account gate on warm and from the lifecycle sweep.

It deletes:

- keys `contact-grant/*`, `contact-delivery-receipt/*`, `contact-author-day/*`, `contact-name/*`, `collection/*`;
- `message/*`, `message-usage/*` and `message-receipt/*` for peer messages, i.e. records without verified app-message provenance;
- `conversation/{room,history,outbox}/*`;
- `link-audience/*`, `link-gc-cursor/*`;
- incoming-index and search rows of peer types;
- conversation overlays;
- peer blob objects, through the existing bounded cleanup-retry queue.

It keeps:

- `contact-key/*` (identity public keys, moved to the identity registry in slice C0);
- the signing and encryption keys;
- `tag-labels`;
- app-message records, which the activity cutover handles;
- notification, billing and lifecycle state.

Storage-usage counters are recomputed. The step writes its marker last, so a crash resumes. Lifecycle erase and export switch from the old enumeration to the new one **per account**, keyed on this marker, so an account not yet reset never escapes erase (review S-19). Blocks and erase tombstones are deleted with everything else, which is acceptable only because no production users exist. Dev and test databases are simply recreated. The developer contact link is reissued through the developer's BindleBox occupant.

## 5. What 3sln.me keeps

- **Address and links:** handles, the directory, link issuance, verification, landing pages, previews, intents, audience responses, conditional-link policy (`packages/links/`) and the ingress-descriptor route.
- **Identity:** keys plus the new `key-delegation.v1` issuance, renewal and status.
- **Slots:** `extensions.v1`, with `messaging-address` and `email-bridge` declared as provider consumers.
- **Email bridge entry point:** the SMTP adapter, MIME bounds, provenance signing, reply gates, the single invariant auto-reply, the holding queue and the `deliver` handoff to the public-message-intake occupant. None of it is built yet; it is a separate slice after the BindleBox receive path exists.
- **Activity**, which also renders BindleBox notifications.
- **Bundled default instance:** BindleBox deployed as a separate Worker on its own origin (for example `box.3sln.example`), listed as an available integration. At signup it is offered as an opt-in default occupant of messaging-ingress and public-message-intake, never auto-assigned (extensions §5.1). It runs the same code and boundary as any third-party instance.

## 6. Order of operations and parallel slices

**Phase C (core preparation).** Runs first, in parallel with Phase B.

| Slice | Owns (exclusive) | Depends on |
| --- | --- | --- |
| C0 Key registry | `packages/identity/keys.mjs` (new); the key-registry part of `packages/messaging/contact-tokens.mjs`; `packages/runtime/account/identity.mjs` | — |
| C1 Core links | `packages/links/*` (new), the issuance and verification half of `packages/messaging/contact-endpoints.mjs`, `packages/runtime/contact-links.mjs`, `contact-preview.mjs`, `developer-contact.mjs`, `packages/messaging/{bindle-links,link-replay}.mjs`, the links contract (`issue`, `revoke`, `evaluate`, `list`, `changes`), the link-type → slot registration table, the `messaging-address` provider consumer feature with the descriptor route, and the intent handoff to the occupant (links §6.4), `packages/identity/link-response.mjs`, `packages/beaming/profile.mjs`, new `packages/runtime/{account,routes}/links.mjs`, the core-links tests of §2.8 | C0 |
| C2 Records and content | `packages/core/records.mjs` (new; `store.mjs` becomes a re-export), `packages/content/*` (new), `packages/messaging/{content,form-*,presentation-summary,submission-status,dispatcher}.mjs` (dispatcher moves to `packages/runtime/lifecycle-notices.mjs`) | coordinate with the activity owner. The activity slice owns the core halves of `messages.mjs`, `tags.mjs`, `message-views.mjs`, `item-index.mjs` and `message-receipt-budget.mjs`. BindleBox takes copies in B2 and B5, without editing the originals. |
| C3 Key delegation | `key-delegation.v1` in `account/identity.mjs` after C0 (sequential with C0): issuance only to the current messaging-ingress occupant, revoke-on-new-key, revocation by `client_id`, the status route, and the app-facing request method. Also the `docs/spec/protocol.md` feature row (through the coordinator) and `tests/key-delegation.test.mjs` (new). | C0 |
| Extensions prerequisites (owned by the extensions slices of [extensibility design](extensibility-design.md)) | `extensions.v1`, `integrations.v1`, `brokered-resources.v1`, the brokering key set, integration SET events | — |
| X12 Email bridge consumer (shared with the extensions owner) | SMTP adapter, holding queue, invariant reply, `public-message-intake` provider consumer | B7, extensions prerequisites |
| Directory profile (prerequisite owned elsewhere) | Core directory/identity-document profile | — |

**Phase B (BindleBox).** Parallel with Phase C, against fakes of the core interfaces.

| Slice | Owns (exclusive) | Depends on |
| --- | --- | --- |
| B0 Skeleton | `packages/bindlebox-engine/{engine,providers,operations,faults}.mjs`, `tests/bindlebox/helpers/*` (harness and network simulator), `tests/bindlebox/import-boundary.test.mjs`, `scripts/bindlebox.mjs`, `package.json` test scripts | — |
| B1 Protocol | `packages/bindlebox-protocol/*` and its tests (moving `contact-delivery*.mjs` in) | B0 |
| B2 Contacts and receive | `domains/{contacts,intake,receive,receive-budget,delegation}.mjs`, `store/mailbox.mjs`, `store/edge-index.mjs` (spec §7.4) | B1 |
| B3 Send queue and events | `domains/{send,outbox,events}.mjs` | B1 |
| B4 Conversations | `domains/conversations.mjs` | B2, B3 |
| B5 Views, rules, tags, classify | `domains/{views,rules,tags,classify}.mjs`, `store/item-index.mjs` | B2 |
| B6 Archive and switch | `domains/archive.mjs`, `store/archive-writer.mjs` (signed manifest, writer lease, rejoin) | B2, B3, B4 |
| B7 Bridge receiver | `domains/bridge.mjs` | B2 |
| B8 App shell | `apps/bindlebox/{worker,node}/*`, `integration.json`, `slots/*`, `wrangler.jsonc` | B2, B3 |
| B9 Web UI | `apps/bindlebox/web/**`, `tests/bindlebox/browser/*` | B4, B5, B6, B8 |

**Phase X (cutover).** One integrator. X1 is a **single change**, keeping principle 3 (no window without a receive path and no dual path). In X1:

- the §2.4 and §2.5 core routes and account slices are deleted or split;
- `account/index.mjs` and `routes/index.mjs` are edited;
- the reset step (C4) is added;
- the `apps/worker` and `apps/node` messaging wiring is removed;
- the contact handoff in `packages/beaming/contacts.mjs` is split;
- core UI navigation is removed;
- the §2.8 deletions are made;
- the bundled instance is deployed locally, both slots are wired, and the descriptor route is enabled.

X12, the email bridge, follows as its own reviewed change after B7.

**Gates before X1** (spike P1):

- B3's durable queue recovery and fairness pass on real Node and on workerd with SQLite Durable Objects, including exhausted-alarm sweeps;
- browser verification of partial counts, "Retry missing" and SSE reset;
- the simulator's failure scenarios pass;
- `npm test`, `test:worker`, `test:ui-state`, `test:dom`, `build:assets`, `check:worker` and `test:e2e` are green.

**Gates before any cross-host claim:** two independently implemented occupants on separate origins, and the directory profile implemented.

## 7. Engine-first for BindleBox

BindleBox applies [app engine](app-engine.md) §2–§11 inside its own package. It is not composed into 3sln.me's engine.

**Factory.** `createMailboxEngine({providers, interceptors})` builds on vendored ngin with the same rules:

- required `clock`, `random` and `audit`;
- an outermost audit interceptor;
- payloads exactly `{actor, id?, input?}`;
- `static operation`, `changes` and `refreshOn`;
- `AppFault`-style coded errors;
- `operationId` receipts written in the same transaction.

**Placements:**

| Placement | Runs in |
| --- | --- |
| `mailbox` | Per-user MailboxObject or Node controller, one engine per instance |
| `edge` | Ingress verification, descriptor cache, multicast fan-in |
| `test` | Harness |
| `cli` | `scripts/bindlebox.mjs` |

**Catalogue** (`packages/bindlebox-engine/providers.mjs`):

| Kind | Providers |
| --- | --- |
| Platform | `mailboxStore` (DO SQLite / Node SQLite / `:memory:`) with `itemIndex` on the same handle, `userStorage` (object-storage resource client), `delegateKeys` |
| Effect | `clock`, `random`, `audit`, `egress` (SSRF-guarded fetch; the simulator in tests), `providerLink` (links contract, slot binding, delegation renewal; a fake in tests), `directory`, `classifier` (optional slot; absent means no AI), `activity` |
| Domain | `contacts`, `receive`, `outbox`, `conversations`, `views`, `rules`, `tags`, `bridge`, `archive` (owner-scoped where they hold owner state) |

**Operations** (examples):

- `contacts.create`, `contacts.revoke`, `intake.update`;
- `send.submit`, `send.retry-missing`, `send.cancel`;
- `outbox.drain` (system actor);
- `receive.deliver`, `receive.batch` (edge to mailbox);
- `conversations.propose`, `conversations.respond`, `conversations.leave`, `conversations.block`, `conversations.rotate`;
- `views.*`, `rules.*`;
- `bridge.receive`, `classify.apply`;
- `archive.checkpoint`, `archive.import`;
- `delegation.renew`.

**Facts:** `outbox-changed`, `incoming-changed`, `conversation-changed`. The SSE route is a live query over these facts plus the durable event log.

**Alarms** are `{kind:'system', reason}` dispatches of `outbox.drain`, `archive.checkpoint` and `delegation.renew`, scheduled by one mailbox scheduler that always sets the earliest due time.

**Network I/O never runs inside a transaction.** `outbox.drain` is adapter orchestration (app engine §4, shape 3): a lease transaction, then egress outside any transaction, then a result transaction that rechecks generation and consent.

**Multi-party simulator** (`tests/bindlebox/helpers/network.mjs`):

- N engines, each with its own store, delegate key and fake provider (links, directory, slots);
- a seeded network that drops, delays, duplicates, trickles, returns 429 with `Retry-After`, 5xx, partial multicast, or loses the response after commit;
- clock skew and jumps;
- host death and recovery.

It runs the spike's scenario table as `tests/bindlebox/engine-*.test.mjs`, reproducible with `CHAOS_SEED`.

**CLI.** `node scripts/bindlebox.mjs --peers 3 --seed 7` scripts multi-party exchanges as JSON lines, with `{"as":"alice","op":"send.submit",…}`, `{"net":{"drop":"bob"}}` and `{"advance":60000}` steps. It runs only in memory and never reaches a deployment.

**Client.** `apps/bindlebox/web/src/bl/*` Actions are tested with a client engine like `tests/helpers/client-engine.mjs`, using a fake API and a fake SSE stream that can gap and reset.
