# Activity design adversarial review

2026-10-20. Author self-review of the [core activity draft](../spec/activity.md) and [3sln.me host design](../architecture/activity-center.md). This is a documentation wargame, not independent cross-review, human approval, runtime testing, or production evidence. Fixes below are incorporated in those two documents; their implementation remains future work. Production release stays disabled under [security](../spec/security.md).

The review uses the current app-message, notification, content/form/postback, app-connection, tag, multi-account, and scope-reduction sources cited by the host design. Earlier decision history remains in [DEVLOG](../../DEVLOG.md); this task explicitly prohibits modifying that ledger. No approval is inferred from the user's scope direction or historical tests.

## Attacks, findings, and incorporated fixes

### A1 — An installed malicious app floods the owner

Attack: obtain legitimate admission consent, send at the allowed rate forever, rotate operation IDs/tags/collapse keys, then replace the same item to evade create quotas. Reconnect or register another client to seek another allowance. Use `urgent` everywhere and make rejection itself generate more alerts.

Finding: authenticated provenance alone does not address spam, and per-connection create quotas do not bound aggregate work or push fatigue.

Fix: activity admission and push are separate, initially disabled authorities. Charge bounded creates/replacements, metadata, history, storage and attempts, intersecting per-connection lanes with owner aggregates. New IDs/keys/reconnections do not reset account limits. Bound rules, remembered tag IDs, receipt capacity, history and queue work; refuse rather than evict live replay fences. Retraction gets a finite safety reserve that cannot fund creates/replacements. Offer mute, pause, disconnect, and owner erase without alerting for every refusal. Host priority cannot be forced by app hints. Refer to spec “Limits and scope” and architecture “Admission and push are separate controls.”

Residual: a user may consent to a deceptive app; the admitted feed can still contain unwanted items within limits. Registration/Sybil abuse and shared-provider capacity need separate operator controls. No delivery or content-truth guarantee follows from a signature.

Required checks: sustained admitted/denied traffic, many connections, same-item update storms, tag cardinality exhaustion, receipt exhaustion, retract reserve starvation, and reconnect across a day boundary. Confirm rejected work creates no per-rejection push and cannot consume another app's private per-app lane through a shared key.

### A2 — Tags impersonate system classifications

Attack: supply `sys:spam`, a fullwidth/case/bidi look-alike, a familiar “Verified” label, or another app's `receipt` namespace. Abuse migration so a legacy flat tag becomes a trusted system fact or changes the meaning of an existing allow rule.

Finding: the old flat tag vocabulary cannot safely serve as the app identity facet or a global app tag namespace. Escaping a string is insufficient if later normalization/rules restore its privileged interpretation.

Fix: typed app tags pair a provider-derived authenticated principal with a strict ASCII local ID. System, owner, and app namespaces never compare equal. App association is structural and nonremovable; labels remain literal, qualified presentation. Existing signed tags retain their exact legacy identities under the source app, without lossy normalization into new IDs. Flat owner edits remain owner organization. Rule matching uses the qualified identity, and unknown tags stay silent in selected-tag mode. Refer to spec “Tags” and architecture compatibility/migration sections.

Required checks: forbidden delimiters, Unicode look-alikes, identical local IDs in two apps, forged namespace fields, owner removal of `app-message`, localized labels, label renames, and conflicting legacy IDs. Confirm no user label renders as a host/system badge or becomes a bab expression.

### A3 — Collapse keys hide or rewrite other activity

Attack: choose another app's key, reuse a key in another account, replace a prominent approval notice with a different destination, or reset read/archive state by repeatedly creating with the same key. Send a muted item last to displace an otherwise eligible notice. Reuse an old key after deleting a record to replay it.

Finding: implicit collapse-as-upsert would confuse identity, consent, and notification grouping, making safe stale-action checks ambiguous.

Fix: collapse only coalesces pending notification work within issuer/account/app/connection incarnation. It never edits retained items or merges read state. Only currently eligible revisions participate. Explicit replacement requires target ownership and exact expected revision and appends signed history; source changes invalidate approvals. Dedup identifiers and collapse keys have distinct purposes and lifetimes. Terminal/deleted IDs cannot be upserted. Refer to spec “Retries and collapse” and “Lifecycle and recipient state.”

Residual: an app can coalesce its own eligible notices and thereby reduce their visibility. The feed retains the distinct items; collapse cannot increase push entitlement or erase them. Already delivered notices may still refer to an older revision and must reopen current trusted state for review.

Required checks: equal keys across apps/accounts/incarnations, parallel updates, stale form preparations, latest-muted versus earlier-eligible items, expired collapse members, and deleted-ID/replay-fence cases.

### A4 — Cross-app impersonation and stolen credentials

Attack: submit another app's name/origin/icon, provide an attacker's public key as provenance, replay an item under another owner, or present provider admission as publisher authorship. Use a foreign SDK import or provider-origin exception to borrow an app label. Forge Origin from a nonbrowser client holding a stolen token.

Finding: browser Origin is useful isolation but cannot attest publisher code. Unsigned local result HTML can also visually impersonate a signed app update.

Fix: derive app/account/connection metadata from live authority; sign every behavior-affecting revision field, audience and lifecycle relation; verify through issuer-anchored key discovery. Reject caller overrides and absent/null/mismatched browser origins before effects, including the provider-origin bypass. Keep provider attestation distinct from an app's identity signature, and local results distinct from app replacement revisions. Put registered exact origin/source context outside author styling, use local icons, and revoke by connection generation. A built-in app needs explicit app-bound injected authority. Refer to spec authority/evidence sections and architecture compatibility/content sections.

Residual: a stolen valid bearer can be used by a nonbrowser attacker despite Origin checking; same-origin compromised code can use app authority. Mitigate through existing scoped credentials, expiry, revocation and incident handling; do not claim code attestation or silently add a publisher secret to frontend apps.

Required checks: wrong issuer/audience/client/owner/resource, forged source fields, arbitrary keysURL, stale/reconnected generations, wrong provider Origin, genuine app iframe versus parent SDK import, and forged Origin with valid versus invalid credentials demonstrating the stated limit.

### A5 — Push fatigue through priority, tags, or updates

Attack: exploit a global push opt-in as permission for every new app, continually mint tags that escape mutes, promote every update to urgent, send quiet-hour bursts, and enable push after storing a large backlog. Use digest retries or device fan-out to multiply pushes.

Finding: a global channel toggle, negative-only tag filters, and app-declared urgency allow unwanted ringing even when admission limits are working.

Fix: require per-app/incarnation push opt-in with explicit selected-tags versus all/future-tags scope. Hard mutes precede ordered routing rules; urgency bypass is an explicit owner rule that still respects all gates and budgets. Default updates do not notify or reset read/archive. Enabling/broadening applies prospectively; quiet/overflow use bounded digests rather than individual catch-up. Cap per-app and aggregate logical notices across devices, retain job identities for retries, and reevaluate digest membership and privacy before transport. Default app activity has no repeating unread reminders. Refer to architecture routing order and limits table.

Residual: transport is at-least-once; an in-flight send can race mute/read/privacy changes. Provider acceptance is not device display. A true emergency cannot be promised through this channel.

Required checks: future tags in each opt-in mode, rule ties and hard-mute precedence, user demotion of urgent, fixed-offset overnight/all-day quiet windows, digest expiry/read changes, rule changes after lease, reconnect, update cap, budget accounting across devices, and no backlog replay on enable.

### A6 — Lock-screen disclosure and background effects

Attack: put a sensitive subject/account name/form value into preview text, track the user through a remote icon, include action capabilities in notification data, or use an OS button to submit before account unlock. A digest can leak app names/counts even if individual bodies are hidden.

Finding: hiding only the message body is insufficient. Notification metadata, summary extraction, account labels, icons and buttons are disclosure/effect surfaces.

Fix: generic default notices contain no app/account names, tags, counts, content, fields or results. Optional account/device preview consent uses the stricter setting and is reapplied at dispatch. No remote icons/resources; bounded deterministic summaries exclude fields and results. Routing uses only an opaque scoped locator, never a credential or remote action URL. Every click opens authenticated foreground state; every form requires fresh exact-source review. Digests follow the same privacy policy. Refer to architecture multi-account/lock-screen section and spec content limits.

Residual: the OS/push service can observe notification timing and may retain an already delivered preview. A shared unlocked device can expose approved previews; encrypted push transport is not end-to-end encryption of server-custodied activity. Withdrawal cannot guarantee recall.

Required checks: generic/preview payload inspection, strict device override, preview withdrawal between claim and send, stale action buttons, remote icon network traps, hidden/CSS-ambiguous summary input, `_blank` refusal, and real-device lock screens before claiming delivery/privacy behavior.

### A7 — Multi-account leakage and confused destinations

Attack: reuse an app tag, item ID or collapse key from account A in B; complete A's pending search/form request after switching to B; click A's notification while B is active; tamper an account query parameter; let one subscription or digest pool several accounts. An ownerless legacy notification is especially tempting to route to the active account.

Finding: a navigation parameter and a shared browser push subscription are not account authorization. Existing ownerless payload compatibility needs an explicit safe fallback.

Fix: scope storage, indexes, receipts, rules, jobs, buckets, frames and caches to issuer/account, with connection and source revision where relevant. App requests stay bound to their original approved resource/session generation. Notification locators resolve to the exact destination after authentication; no current-account fallback or private pre-auth preview. Legacy ownerless notices open only the account chooser. Multi-account device enrollment remains separate; digests never mix accounts. Switching invalidates pending requests/frames and clears private projections; late results fail their old context. Refer to architecture “Multi-account destinations and lock screens.”

Residual: an opaque locator still exposes bounded timing/linkability metadata to delivery infrastructure; avoid logging it. Device OS permission remains shared by the origin and cannot express all account privacy choices itself.

Required checks: same app in two accounts, equal keys/IDs across partitions, stale cursors/search results, switch during prepare/dispatch, delayed service-worker events, forged locator/account parameters, signed-out/deleted targets, shared endpoint enrollment removal, and ownerless legacy clicks. Verify B's content and credentials never satisfy an A-bound operation.

### A8 — Retraction, expiry, and local results erase the audit trail

Attack: replace an approved form after review, retract after a bad external effect, extend expiry after it has elapsed, replay an unknown submission under a fresh ID, or let an old postback overwrite a newer app revision. Fill history so no terminal revision fits.

Fix: revision preconditions, immutable signed app history, recipient-local result provenance, terminal expiry/retraction/deletion, and live checks before dispatch. Reserve the final app history slot for a terminal event; refusal at a history cap cannot disable retraction. Disable actions on old/terminal content. Keep unknown-effect fences and attach late outcomes only to the original source. Owner retention/erase controls history; app retraction cannot erase evidence or undo external effects. Missing records never become upserts. See both documents' lifecycle/content/migration sections.

Required checks: clock/cleanup delays, replacement at expiry boundary, retraction at history cap, read and update races, external response after newer replacement/deletion, storage exhaustion before dispatch, and archive persistence. A result cannot reset read/archive or create another push.

## Decision record

User direction dated 2026-10-20 settles the scope: core app activity, app/tag facets, user-controlled push, and separate peer messaging. It does not approve the detailed choices below. Blank fields are intentional; all remain provisional. No independent reviewer has signed this self-review.

| Decision | Current recommendation and linked outcome | Human reviewer / date / outcome |
| --- | --- | --- |
| D-A1: provenance and tags | [Core draft](../spec/activity.md): issuer-qualified app principal, signed admission per revision, typed app-tag namespace, mandatory structural app facet. Addresses A2/A4. | ___ / ___ / ___ |
| D-A2: lifecycle and collapse | [Core draft](../spec/activity.md): notification-only collapse, explicit revision-checked replacement/retraction, terminal expiry, independent private recipient state. Addresses A3/A8. | ___ / ___ / ___ |
| D-A3: push policy | [Host design](../architecture/activity-center.md): per-app opt-in, selected/all future tag choice, mute precedence, prospective changes, optional update notices, quiet/digest routing and proposed finite budgets. Addresses A1/A5. | ___ / ___ / ___ |
| D-A4: privacy and accounts | [Host design](../architecture/activity-center.md): generic defaults, stricter account/device preview policy, opaque destination routing, foreground-only review, no cross-account fallback. Addresses A4/A6/A7. | ___ / ___ / ___ |
| D-A5: extraction and versioning | [Exact migration list](../architecture/activity-center.md#extraction-and-exact-migration-list): preserve v1 and verified app history, add a new binding, split mixed modules, transfer peers to the separate app, fence dual queues. | ___ / ___ / ___ |

Independent protocol/security cross-review: reviewer ___ / date ___ / outcome ___. Product/accessibility review: reviewer ___ / date ___ / outcome ___. Node/Worker/browser migration evidence: ___ (not run; design only). Production/provider/device evidence: ___ (not established). Reconcile approved decisions and implementation differences into DEVLOG only in a later task authorized to edit it.

## Open questions for the user

1. Are the proposed push caps (3/app/hour, 10/app/day; 6/account/hour, 20/account/day), digest choices, and explicit urgent quiet-hour exceptions acceptable starting policy? The design keeps all push opt-in per app regardless.
2. Should app replacement ever make a read item unread by default? Current recommendation preserves read/archive, with explicit owner controls for unread/update push and no automatic unarchive.
3. Are the proposed 90-day maximum explicit expiry and 32 app-revision cap appropriate? App expiry disables actions/notifications rather than forcing deletion of the owner's retained evidence.
4. Confirm the messaging app's eventual name/package and the owner-reviewed historical transfer approach. Versioned wire naming/signing fixtures, named time zones, and noninteractive workload authority still need focused follow-up design; none is silently published here.

## ACT-1 implementation

2026-10-20. Wave 2 slice ACT-1 implements the core activity model as engine operations. This section records one independent agent security review (read-only, with probes) and the fixes. It is not human sign-off. Everything is behind `ACTIVITY_V2_ENABLED` (default off). Production stays disabled.

**What was built:**
- `packages/activity/*`:
  - the input grammar and limits;
  - typed app tags qualified by issuer-qualified app principal;
  - purpose-separated signed admission evidence;
  - the transactional store;
  - the v1 read adapter.
- `packages/app/domains/activity.mjs`. Owner operations are registered: `activity.list/get/legacy/mark/archive/delete`. App operations `activity.create/replace/retract` are deliberately unregistered and built only by the resource handler from verified federation state.
- Provisional unpublished contract `…/contracts/activity/v2-draft` through the `RESOURCE_METHOD_HANDLERS` seam, with origin-bound federation prechecks.
- Flag-gated `/api/activity` owner routes.
- Tests: `tests/engine-activity.test.mjs` and `tests/activity-resource.test.mjs`.

**Review findings:**

| ID | Severity | Finding | Outcome |
| --- | --- | --- | --- |
| ACT1-S1 | medium, confirmed | Account-wide receipt cap (256 × 48 h) could be filled by one app's create+retract traffic, refusing other apps' retractions. | **Fixed.** Receipts are split into lanes: per-app create/replace share 128, account 256, and a separate retract bound of 640. That bound is above the retract lanes' two-day maximum. Expired-row counting is now exact. Regression S1. |
| ACT1-S2 | medium, confirmed | One app could fill account item/byte capacity permanently with expiring or retracted items. | **Fixed (bounded).** Per-app share is 500 items / 4 MiB of the account's 2000 / 16 MiB. Owner deletion credits both. Residual: four colluding apps, and no compaction of terminal content yet (ACT-2/lifecycle). |
| ACT1-S3 | low, confirmed | Legacy adapter promoted unverified stored v1 claims. | **Fixed.** Rows are `verified:false` unless the caller verified them with `verifyLegacyAppMessage` against the issuer's keys. |
| ACT1-S4 | low, confirmed | Subjects accepted C1, bidi override/isolate, line separators and invisible-only text. | **Fixed.** These are refused in subjects; C1 is also refused in bodies. |
| ACT1-S5 | low | `verifyEvidence` did not bind evidence to the stored record. | **Fixed.** `verifyRevision` recomputes the content digest and compares account/item/revision/kind and every signed field. |
| ACT1-S6 | low/info | Activity reuses the v1 ES256 key; separation is only the in-payload `purpose`. | **Open.** It needs the versioned binding: a separate kid set or an external domain prefix. |
| ACT1-S7 | low | `hasAdmissionMethod` enables connection admission consent even with the flag off. v1 and activity share one admission toggle and generation. | **Open.** The federation service has no flag input, and no descriptor can carry the contract today. A separate activity admission toggle is ACT-2/X4 work. |
| ACT1-S8 | info | A retry after reconnect creates a second item (dedup is per incarnation, as specified). | Documented. Spec-consistent. |
| ACT1-S9 | info | No lock-screen leak found. Pending work holds only IDs, revisions and group names, but group names embedded the app's collapse key verbatim. Audit lacks the app principal. | **Fixed** collapse groups (hashed). Audit principal is open. |
| ACT1-S10 | info | Owner operations are reachable by internal RPC with the flag off. `allowedMethods` lists `/api/activity` with the flag off (the route answers 404). | **Open, low.** Both HTTP and resource entry points are gated. |

Self-found during fixes: the app principal used for budget, tag and receipt keys omitted the issuer (`undefined#client`). The keys were consistent but wrong. Fixed and covered by the S2 regression.

**Not done in ACT-1 (reconciliation for DEVLOG):**
- An activity resource descriptor in `packages/runtime/federation.mjs` (other owner). Until it exists the contract cannot be granted end to end.
- Forms/postbacks for v2 items. They stay inert, with no revision-aware form authority yet.
- A separate `message-receipt-budget` lane. Activity has its own app/account lanes in the engine plus `admitWork`.
- An item-index partition and search.
- Lifecycle export/erase hooks. Account purge clears the rows, but export omits them.
- Terminal-content compaction.
- Push dispatch from pending groups (ACT-2).

Evidence: core suite, `test:worker`, `test:ui-state`, `build:assets`, `check:worker`. No browser or production evidence. Reviewer ___ / date ___ / outcome ___.
