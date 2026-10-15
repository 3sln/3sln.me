# Label-agnostic tags and suspected classification

Provisional architecture, 2026-10-14. User direction (2026-10-14): automated tagging produces “Suspected <X>” tags (Suspected Spam, Suspected Social, Suspected Promotional, Suspected Recruitment, …); the owner's rules finalize them, with default rules such as Suspected Spam → Spam; tags are label agnostic so labels can be localized. Clarifications the same day: the suspected convention applies only to AI-model and other automated/heuristic tagging, never to tags a contact link applies; contact-link auto tags and sender-selectable optional tags are mutable per-link intake configuration (not signed grant claims). Human product reviewer: __________  Date: __________  Outcome: __________.

## Identifiers, not labels

A tag is a stable identifier. Its display label is presentation, resolved at render time; stored messages, rules, Views, intake configuration and MCP calls only ever carry IDs.

| Class | ID grammar | Label source | Who may apply |
| --- | --- | --- | --- |
| System final | `sys:<name>` from the host registry, e.g. `sys:spam`, `sys:personal` | Host bab catalogue (source text such as “Spam”) | Owner action, owner rules, owner-authored intake configuration, host-structural facts (app message → `sys:automation`) |
| System suspected | `sys:suspected.<category>` | Host catalogue (“Suspected Spam”) | Only automated provenance: `classifier` or `heuristic` |
| User | any other bounded string (1–64 chars, no controls, not starting `sys:`) | Owner label registry, otherwise the ID itself | Owner, owner rules, owner-authored intake configuration, sender selection from the owner's optional allowlist |

The `sys:` prefix is reserved, including look-alikes after NFKC, case folding and removal of whitespace/zero-width/bidi characters (`SYS:spam`, fullwidth `ｓｙｓ：spam`). Unknown or look-alike `sys:` IDs are rejected everywhere new data enters (rules, Views, owner edits, intake configuration, classifier results). Legacy free-text tags keep working as user tag IDs; the word an owner typed (`work`, `priority:paid`) is the ID, and the owner may later attach a different label to it without retagging any message. New user tags created through a label editor receive opaque IDs (`t.<random>`). Renaming changes only the owner label registry (`tag-labels`, revisioned, at most 500 entries, labels at most 64 literal characters); it never touches messages, rules, Views or intake configuration. User labels are literal text and are never evaluated as bab templates; only registry system labels are catalogue keys.

Initial system registry (fixed set; additions are versioned host changes, removals are not allowed once shipped):

- Categories with both suspected and final IDs: `spam`, `social`, `promotional`, `recruitment`, `conversation`, `outreach`, `transactional`, `receipt`, `automation`, `verification`, `code` (authentication/one-time codes). This folds the bridge design's independent labels (spam, conversation, outreach, promotion, transactional, receipt, automation, email verification, authentication code) together with the user's social and recruitment categories. Urgency/priority stays separate, as the bridge design requires.
- Final-only IDs: `personal`, `work` (targets of the legacy classification enum).

English labels live in `packages/i18n/catalogues.mjs` as whole source strings (“Suspected Spam”, never composed) with a Spanish translation; the registry in `packages/messaging/tags.mjs` maps ID → source text. They use the default `""` context because the UI localizer translates that context; the existing “Spam”, “Work”, “Personal” and “Automation” keys already carry the same classification meaning. A dedicated `tag` context is preferable if the localizer gains scoped InterfaceText. Clients render system labels through the catalogue with a distinct `system-tag` style (so a user tag literally named “Spam” is distinguishable), and user labels and unknown IDs literally with `translate="no"` inside `<bdi dir="auto">`. The sender-facing composer shows only the per-link intake labels the owner wrote for optional tags, never the private `tag-labels` registry.

## Provenance

Every current tag on a message may carry provenance `{source, at, …}`:

- `grant` — legacy signed contact claims (required tags plus validated sender selection).
- `intake` — mutable per-link intake configuration, with `intakeRevision`. Intake configuration stores tag IDs only; renaming a user label never requires an intake edit. The links agent owns that storage and calls `validIntakeTagIds` (this module) to validate it.
- `app` — host-structural app-message facts (`app-message`, `sys:automation`). App-supplied tags are escaped like legacy text, so an app can never deliver a `sys:` ID. A legacy `classification` write does not remove an `app`-provenance family tag, and derived classification prefers owner/rule family tags over it.
- `mcp` — owner-delegated MCP `item_write`, with `clientId`, so agent edits remain distinguishable from direct owner action. (Open question: whether MCP should be limited to removals or suspected tags.)
- `classifier` — AI model output, with `model`, `version` and `probability` evidence. `heuristic` — deterministic header/structure hints, with a rule `version`.
- `rule` — an owner rule (`ruleId`, `ruleRevision`, `from` when the rule promoted a suspected tag).
- `owner` — explicit owner action through UI/API/MCP. `migration` — derived from the legacy classification enum.

Evidence for automated tags is retained in `automated[tagId]` even after a promotion removes the suspected tag; a bounded `tagHistory` (16 newest add/remove/skip events) records what changed and why. Owner removals are recorded in `tagSuppressed`; neither automation nor a later rule re-adds a tag the owner removed, until the owner adds it again.

## Who can apply what

Security invariants (each has a test):

1. `applyAutomatedTags` is an internal service boundary for the bridge/classifier worker only; no owner HTTP, app or MCP route reaches it. Classifier and heuristic results can only apply registered `sys:suspected.*` IDs. They cannot apply final system tags, user tags, quarantine, collections, deletion or any other action. Malformed results (unknown tag, probability outside [0,1], oversize model strings) are rejected whole.
2. Nothing else can apply a suspected tag: owner rules cannot add one, owner edits may keep or remove existing suspected tags but not add them, and intake configuration (required or optional lists) cannot reference them. Contact-link tags are therefore always applied as-is — a link's `spam` user tag or `sys:spam` system tag is never rewritten to `sys:suspected.*` and never participates in promotion.
3. A contact sender can select only IDs from the owner's optional list. Because the owner authors that list, a sender can carry a system final tag only if the owner put it there; sender text cannot introduce a `sys:` ID otherwise. Legacy signed claims and legacy stored tags predate the registry, so any `sys:`-prefixed string in them is escaped to `sys_…` (a user tag) rather than gaining system meaning.
4. Final category tags come only from owner rules (`rule`), owner action (`owner`), owner-authored intake configuration (`grant`/`intake`) or a documented host-structural fact (`app`). The model itself never authorizes a final tag, quarantine or deletion.

## Rules: finalizing suspected tags

Owner rules keep the existing shape and gain two actions: `addTags` and `removeTags`. `tags` (replace) and `classification` remain for compatibility. Semantics:

- **Match snapshot.** A rule matches the immutable snapshot `deliveryTags ∪ automated tag IDs`, plus original delivery collection, MIME type and grant. Tags added by rules or owners are never inputs, so one rule cannot trigger another and no chain can oscillate.
- **Snapshot exclusions.** Automated evidence for a tag the owner removed (suppressed) leaves the snapshot, so removal also stops later promotion.
- **Phases.** At intake every enabled rule is evaluated once, in order. When automation later applies new suspected tags (`applyAutomatedTags`), only rules whose `tagsAll` contains at least one newly applied suspected ID — and that otherwise fully match — run. Each rule fires at most once per message (`firedRules`), and a result repeating evidence already recorded for that source changes nothing (idempotent). A rule may add `match.source` (`classifier` or `heuristic`), requiring every suspected tag in `tagsAll` to have evidence from that source. Rules never run because an owner edited tags.
- **Actions, in order.** `tags` replaces the user-tag partition only (system IDs listed are added; system tags are never silently wiped by a replace); `classification` sets the legacy family (below); then `removeTags`, then `addTags`. Quarantine is sticky. Suppressed tags are not re-added. Promotion records `from:<suspected id>`.
- **Limits.** At most 32 user tags per message; system tags are bounded by the registry. An intake rule exceeding the user limit fails the delivery (existing `invalid_actions` behavior, no truncation). A post-intake rule that would exceed it skips its tag changes (recorded in `tagHistory` as `op:"skip"`) but still applies quarantine/collection, so a classifier result is never lost.
- **Quarantine.** An explicit owner release (`quarantined:false`) is recorded; automated-phase rules never re-quarantine a released item. If an automated-phase rule quarantines an item, its pending notification event is removed and dispatch rechecks quarantine. A notification may already have been sent before asynchronous classification completes; holding notifications while classification is pending belongs to the bridge design's pending category, not this boundary.

### Default rules

Defaults are ordinary owner rules with reserved IDs `default:promote.<category>` and a server-maintained `default:{version, base}` marker (`base` is the canonical shipped match/actions). They are seeded per account (lazily on first rules read, intake or automated application), visible, editable, disable-able and deletable. A per-owner `rule-defaults` record stores the seeded version of each default:

- A deleted default is never re-added.
- On a later shipped version, an unmodified default (body equals `base`; `enabled` and `name` are ignored) is upgraded in place, keeping its enabled state; an edited one is left unchanged and marked `updateAvailable:<version>`.
- Clients cannot forge `default` markers or revisions: the server recomputes them by rule ID. Rule `revision` increments whenever a rule body changes, and appears in `rule` provenance.
- If the first rules write arrives before any seeding, the owner's list is stored first and defaults are appended after it.

Version 1 defaults, all enabled: each category promotes `sys:suspected.X` → `sys:X` with `match:{tagsAll:[sys:suspected.X], source:"classifier"}`, `addTags:[sys:X]`, `removeTags:[sys:suspected.X]`. Heuristic hints come from sender-controlled headers, so defaults never finalize them; a sender adding `List-Unsubscribe` gets at most “Suspected Promotional”. Owners may write their own rules for heuristic evidence. A default ID cannot be claimed by a client rule: `default:` IDs are accepted only when the server's stored rule already carries the marker, and `restoreDefaultRule` re-adds a deleted default explicitly. Only Spam also sets `quarantined:true`, which is recoverable (no deletion or retention timer is implied). The bridge design's proposed 30-day quarantine → seven-day trash retention remains a separate owner-approved setting when the bridge or classifier is enabled. Because classification itself requires an explicit paid opt-in per ingress, seeding defaults has no effect for an owner who never enables automation or heuristics.

## Classifier and heuristic boundary

`MessagingService.applyAutomatedTags(owner, messageId, {source, status, model?, version, labels:[{tag, probability?}]})` is the only entry point. It validates the result, records it as `classificationResult[source]` (status `complete`, `skipped` or `failed`; unknown/skipped is not evidence of safety), applies the listed suspected tags not previously applied and not owner-suppressed, then runs the automated-phase rules — all in one serializable transaction. Threshold selection belongs to the caller under the bridge design's pinned model/schema version; the boundary does not invoke any model. The Workers AI `@cf/cloudflare/clef-flash` call remains design-only and gated by [the public email bridge](public-email-bridge.md).

`heuristicSuspectedTags(headers)` is a pure function over sender-controlled headers: `Auto-Submitted` (other than `no`) → suspected automation; `List-Unsubscribe`/`List-Id` or `Precedence: bulk|list` → suspected promotional. These are hints only; they never yield final tags.

## Legacy classification enum: fold into tags

One model: the `classification` enum (`unclassified`, `personal`, `work`, `spam`, `automation`) becomes the system tags `sys:personal`, `sys:work`, `sys:spam`, `sys:automation`. Compatibility:

- **Writes.** `classification` remains accepted on owner updates, rule actions, conversation overlays and MCP `item_write`; it removes the four family tags and adds the chosen one (`unclassified` removes them).
- **Reads.** Every write also persists a derived `classification` field (precedence spam > automation > work > personal), so search documents, the incoming index column, View `classifications` filters and old clients continue to work. New clients filter with `tagsAll:["sys:spam"]`.
- **Lazy data migration.** Records without `tagModel:1` are normalized on read: legacy `sys:` strings escape to `sys_…` (not injective: it may merge with an existing `sys_…` tag, which is accepted), the stored classification becomes its family tag with `migration` provenance, and the normalized form is persisted on the next write. The owner index re-projects legacy rows in bounded 200-row batches under the existing alarm (`tag-model` state); conversation overlays normalize on read. Stored rules escape legacy `sys:` strings once when defaults are first seeded. Signed contact claims (legacy) accept user tags only and are escaped when lazily converted to revision-0 intake configuration. Message IDs, receipts, read state and bytes are untouched. A saved View whose stored filter fails the new grammar is resolved with unregistered `sys:` strings escaped; a pre-change View naming a now-registered ID (for example `sys:spam`) would match the system tag — an accepted, negligible edge.

## Bindle specification surface

Only a short rule is added to [the messaging specification](../spec/messaging.md): tags are opaque identifiers and labels are presentation; a host may reserve a namespace prefix for host-defined tags whose meaning and localized labels it documents; senders cannot introduce host-reserved tags except IDs the recipient explicitly allowed; automated suggestions must stay distinguishable from recipient-final tags. The specific `sys:` registry, defaults and provenance values are 3sln.me service behavior, not Bindle wire requirements. No SDK API is specified.

## Review record

Agent design review (2026-10-14, independent subagent, not human signoff) raised three blockers — app-supplied `sys:` tags, an unstated caller boundary for `applyAutomatedTags`, and header heuristics reaching final tags through defaults — plus owner quarantine release, notification timing, MCP provenance, suspected tags in replaces, forged default IDs, removed-suspected matching, skip semantics, app classification precedence, i18n context/look-alikes/bidi and intake-versus-registry labels. All are incorporated above; the MCP scope limit and the notification hold remain open product decisions. Human reviewer: __________  Date: __________  Outcome: __________.

## Remaining work

Frontend label editor and rule UI for `addTags`/`removeTags`; HTTP routes for the label registry and wiring the intake configuration to `validIntakeTagIds`; bridge/classifier enablement, thresholds and benchmark evidence; retention timers. Production release remains gated by [security](../spec/security.md) and DEVLOG.
