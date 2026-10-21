# Event buses, consent experience and incremental authorization: wargame review record

Status: provisional, 2026-10-20. Design evidence only. Nothing is implemented. Sign-off: reviewer ___ / date ___ / outcome ___ (unsigned; this record is not approval).

## Scope

Revision 1 of three documents:

- [events](../spec/events.md) (EV);
- [incremental authorization](../spec/incremental-authorization.md) (IA);
- [consent experience](../architecture/consent-experience.md) (CX).

Two independent reviewers each read the drafts, the related core specs (extensions, integrations, protocol, auth, contracts, activity, components profile) and the current consent code. Neither edited files.

- **Security and privacy** looked at bus exfiltration, producer spoofing, misleading copy, suggested-configuration attacks, suppression bypass, clickjacking, cost amplification and consistency with the existing specs.
- **UX and product** looked at fatigue, comprehension, dark patterns, accessibility, mobile, edge cases, the information architecture of the access views, and what app developers will rely on.

The coordinator fixed every finding in revision 2 except those listed under "Accepted residuals". The fixes have **not** been independently re-reviewed.

## Security and privacy findings

| ID | Sev | Finding | Disposition (revision 2) |
| --- | --- | --- | --- |
| SEC-1 | High | Every `grant-more` exchange minted a new session, even on decline, suppression or no delta. An injected script could turn a "Don't allow" into a persistent session under its own key, and no-delta requests minted codes silently. | **Fixed (IA §4.1, §4.4):** no access or refresh token unless access was added. New sessions never outlive the connection's newest session (expiry and `auth_time`). AMD-C19 updated. |
| SEC-2 | High | Brokered buses could not enforce the reader floor, so a new reader got up to 30 days of history. Cursors bound to the grant id broke on widening, and the floor reset on widening. | **Fixed (EV §3.2, §4.2, §6.3; IA §4.3):** brokered `bindle.bus {floor_at, history}` claim (AMD-C15). The floor is set only when `read` is first gained. Cursors are bound to (bus, client, floor, position). |
| SEC-3 | High | An app could be offered as bus host (occupant) inside its own flow, and replacing an occupant would revoke other readers. This contradicts extensions §9.3. | **Fixed (IA §4.2, §5.1; CX §6.2):** same-registrable-domain candidates are omitted, and no occupant replacement happens in incremental flows. |
| SEC-4 | High | "Checked by 3sln.me" could sit on app-authored bus `effects` and labels. The manifest host was not shown. | **Fixed (CX D12, §4.1, D3):** the mark applies per row to pure catalogue text only. Feed rows use a catalogue sentence plus an attributed quote. D3 covers bus manifests. Labels appear as quoted chips. Headings show "defined by ‹host›". |
| SEC-5 | Med | The blocked notice's "Back" control had no arming delay, so a fast return proved suppression. Island outcomes for decline were unspecified. | **Fixed (IA §9.3, §7.2; CX §6.6):** armed return with a minimum dwell. Every decision ends `completed` (+`code`), and `canceled` only for windows closed without a decision. |
| SEC-6 | Med | `login` with a suppressed fragment marked `required` forced "lift the block or lose the app" (protocol §3). | **Fixed (IA §9.1, AMD-C19):** delta items are optional on existing connections in every intent. |
| SEC-7 | Med | Version churn (`/v2`, `/v3`) and sibling client ids bypassed suppression and the ladder. | **Fixed (IA §9.1, §10):** app identity covers its verified registrable domain. Fragment scope follows `supersedes` chains and covers all fragments on the app's own host. |
| SEC-8 | Med | Suggestions to shared string or enum fields passed through bulk accept. The "update for all apps" checkbox implied per-app values. | **Fixed (IA §5.2; CX §6.5):** any field another app receives is sensitive, as are email and hostname formats. Shared-change acknowledgement replaces the checkbox. |
| SEC-9 | High (cost) | Uncharged reads at 10 per second, long-poll starvation degrading to tight polling, and a false "object idles" claim. | **Fixed (EV §9):** reads at 2 per second per grant; empty reads charged after 2,000 per day; fair-share waits; `Retry-After` of at least 10 s instead of `wait` 0; a daily wait-second budget; cost text corrected; Q12 added. |
| SEC-10 | Med | Publishes drained the owner's shared activity allowance, and retained bytes could fill the storage quota. Doorbell starvation. | **Fixed (EV §9):** a separate event allowance with a per-publisher share, and owner operations exempt (Q8 updated). A 16 MiB per-bus byte cap that ages out first. Per-bus doorbell fairness. |
| SEC-11 | Med | Brokered publish introspection put unmetered load on the provider. | **Fixed (EV §3.2, §3.3):** introspection rate-limited per connection and metered, failing closed. The high-volume example was removed. |
| SEC-12 | Med | Bus write ignored readers' act-as-you power. Tier 4 depends on optional categories. Missing-effect items were preselected. | **Fixed (CX §3, D3, D6, §11):** write tier lifted by current readers' tier-4 capabilities. "Not checked: could send, spend or publish as you" on unreviewed writes. Unreviewed and missing-effect items are never preselected. |
| SEC-13 | Med | The global `seq` in publish results, the per-bus limit, and pre-floor `head`, `oldest` and `gap` leaked activity. | **Fixed (EV §4.1, §4.2, §6.3):** opaque publish receipt; `head`, `oldest` and `gap` clipped to the floor; `Retry-After` from the caller's own window. |
| SEC-14 | Low | The app's reason sat above the cards. Mandatory recipients and fields were hidden in collapsed L1. | **Fixed (CX §5, §6.2, §6.3):** reason placed after the cards. Fields and recipients at L0. Spec states collapsed disclosure is insufficient (EV §10.2). |
| SEC-15 | Low | Supersession lost a stop-asking choice and could swap an armed page. | **Fixed (IA §10; CX §11):** a superseded page disarms, never loads the new entry, and records any suppression. |
| SEC-16 | Low | Whole-entry suppression contradicted per-item pre-decline and created an oracle. | **Fixed (IA §9.1):** only matching items are pre-declined, everywhere. |
| SEC-17 | Low | `subscribe` was tiered as write. A tiny journal window. In-band `attested_by`. The false "readers are never learned" claim. | **Fixed (EV §4, §4.1, §6.2, §6.3, §10.2; CX §3):** subscribe is part of read; 10-minute journal floor; consumers compare `attested_by` with the origin they called; host knowledge of readers disclosed. |

## UX and product findings

| ID | Sev | Finding | Disposition (revision 2) |
| --- | --- | --- | --- |
| UX-1 | Blocker | Expiry, supersession, blocked popups and leaving the page triggered cooldowns, which trapped interrupted owners. | **Fixed (IA §10; CX §11):** the ladder counts only seen decisions, and other cases advance only the caps. `owner_review_uri` was added to `rate_limited`. |
| UX-2 | High | No owner-started grant path. | **Fixed (CX D11, §7.1):** a "Not allowed yet" section with ⟦Allow…⟧ that resets the ladder. |
| UX-3 | High | Partial approval was invisible. | **Fixed (CX D6, §6.2):** Include switches at L0, per-row checks in L1, "Allow 2 of 3". |
| UX-4 | High | Reading private data was ranked lowest. | **Fixed (CX §3):** a tier 1+ "Can see private info" with a rule and expanded L1. |
| UX-5 | High | No copy for plain settings reads. | **Fixed (CX §4.1):** catalogue "See your ‹group› settings: ‹fields›". |
| UX-6 | High | The island popup-blocked path was undefined and charged a decline. | **Fixed (IA §7.2):** the popup opens before the entry is created, and a blocked popup creates nothing. Redirect fallback. |
| UX-7 | High | Configure Save rules were ambiguous, Keep/Use/Edit was keyboard-heavy, and the shared checkbox was misleading. | **Fixed (CX §6.5):** radio groups, undecided state, live change summary, shared acknowledgement, renamed bulk action. |
| UX-8 | High | Mandatory feed disclosures were hidden in L1, and future readers were never mentioned. | **Fixed (EV §10.2; CX §5, §6.3):** L0 reader and publisher facts, including "Apps you allow later will too". |
| UX-9 | Med | Inaccurate feed copy. | **Fixed (CX §6.3, §7.4, §8.1):** "only see changes from now on", "up to 7 days", history wording, "notified of / checks for new events", plain brokered copy. |
| UX-10 | Med | The reason was placed above the cards. | **Fixed** (same as SEC-14). |
| UX-11 | Med | "Don't ask again" was hidden behind a chevron in a split button. | **Fixed (CX D7, §6.4):** a visible "Stop Tasks asking for this…" text button, also on configure. |
| UX-12 | Med | Fragment suppression could be dodged by a version bump. | **Fixed** (same as SEC-7). |
| UX-13 | Med | The blocked notice contradicted itself and invited wear-down. | **Fixed (CX §6.6, §6.4):** new copy, "Stop all requests" option, app-wide block offered after 3 declines in 7 days. |
| UX-14 | Med | Preselection assumed user intent. | **Fixed (CX D6):** preselect only reviewed tier 1–2 items. |
| UX-15 | Med | Setup came before purpose, and created resources even on decline. | **Fixed (CX §6.2; IA §4.2):** purpose preview line; resources created only when Allow commits. |
| UX-16 | Med | Long walkthroughs. | **Fixed (CX §6.2):** inline confirmations for 1–2 high-risk items; step 3 only for 3 or more. |
| UX-17 | Med | Sticky bar at zoom, no time extension, hover tooltip, live-region collisions, DOM order. | **Fixed (CX §9, §10, §6.2).** |
| UX-18 | Med | Returning recap too brief. | **Fixed (CX §6.7):** a partial result waits for Continue; otherwise at least 2 s. |
| UX-19 | Med | Offline, double-press and half-saved setup. | **Fixed (CX §6.7, §6.2):** network-failure copy, idempotent decisions, atomic per-step saves. |
| UX-20 | Med | Naming, Pause, removal consequences, re-approval flow, old feed fate. | **Fixed (CX §7).** |
| UX-21 | Med | App developers will misuse outcomes. | **Fixed (IA §6.4):** guidance plus SDK shape `{granted, missing}`, `retryAfter`, a fresh preferences read. |
| UX-22 | Low | "Can act as you" is wrong for money and public. | **Fixed (CX §3):** tier 4 is labelled by category. |
| UX-23 | Low | "Already used by" read as social proof. | **Fixed (CX §8.1):** neutral "Also sent to", names in L1. |
| UX-24 | Low | Header wording, locale chain, verb joining. | **Fixed (CX §6.1, §4.2, §5).** |
| UX-25 | Low | Built-in self-preference. | **Fixed (CX §6.2):** "Create on 3sln.me" always last. |

## Accepted residuals (need user decision or later evidence)

- **Suppression costs the owner a click (Q6).** A suppressed request still shows a one-click notice, at most three per target in 38 days and then monthly. The alternative discloses suppression to the app.
- **Unreviewed contracts can mislabel effects.** A publisher can mark a destructive method `read`. It is shown with "Not checked by 3sln.me". Write-capable brokered methods still require live introspection. Issuer-hosted resources use reviewed adapters only.
- **Brokered hosts can fabricate records and see readers.** This is disclosed, and only the owner chooses such a host.
- **Long-poll residency.** It is bounded by the daily wait budget, but each account with a reader still keeps a Durable Object resident for part of the day (Q12).
- **Embedder overlay on the island button.** The decision always happens in the provider popup, so overlays can mislead only about what the button starts (embed islands §13.4).
- **Not re-reviewed.** Revision 2 fixes are coordinator-applied and not independently verified.

## Evidence

Documentation-only change. No code, tests or DEVLOG were edited, and no tests were run. The interop amendments AMD-C12–C20 are proposed and unsigned.

## EV-2 implementation

Status: provisional, 2026-10-20. One independent security reviewer read the EV-2 code: `packages/events/*`, `packages/app/domains/events.mjs`, `packages/runtime/{account,routes}/events.mjs` and `apps/worker/event-bus-waiter.mjs`. The reviewer looked at exfiltration, producer spoofing, consumer isolation and cost amplification, and confirmed findings with scripts. The coordinating agent applied the fixes. The fixes have not been re-reviewed. Sign-off: reviewer ___ / date ___ / outcome ___.

| ID | Sev | Finding | Disposition |
| --- | --- | --- | --- |
| EV2-S0 | High | The per-grant read rate lived on a per-operation handle, so it never limited anything. | **Fixed:** the rate state lives with the provider, with a regression test. |
| EV2-S1 | High | The reader-floor epoch was the connection generation. Revoking a grant does not change that, so after re-approval the old floor and cursor stayed valid. The reviewer's script read records published during the revocation. | **Fixed:** the epoch is the read-approval identity `context.grant.readSince`, and the handler fails closed without it. The `readerApproved` hook uses the same derivation. Tests cover it. |
| EV2-S2 | Med | After a reader's free empty reads, each further empty read drew from the shared allowance. One reader polling for about 33 minutes blocked every publisher until UTC midnight. | **Fixed (provisional deviation from §9):** charged empty reads draw a separate readers' share of 25 % of the allowance, with at most 10 % per reader. They never reduce the publish allowance. Tested. |
| EV2-S3 | Med | One app with two continuous waits spent the whole account's daily wait-seconds, and the refusals revealed other readers' activity. | **Fixed:** each app may use at most 50 % of the daily wait budget, and every refusal looks the same. Tested. |
| EV2-S4 | Med | Sweeps were never scheduled, so idle buses kept expired records, and journal, rate and meter rows grew. | **Partly fixed:** the resource handler runs a bounded sweep at most every 10 minutes. **Open integration gate:** the account alarm must call `eventBusSweep` before the flag is enabled. Reads always age out expired records first. |
| EV2-S5 | Low | A refusal below the caller's own limit shows that the shared per-bus or account limit was reached. | **Accepted residual:** Retry-After comes only from the caller's own window. The code comment is corrected, and spec §6.3 wording needs review. |
| EV2-S6 | Low | A generation bump invalidated cursors and reset the floor, which silently dropped records. | **Fixed** by the EV2-S1 epoch change. |
| EV2-H1 | Hardening | The cap age-out loop had no head guard. | **Fixed.** |
| EV2-H2 | Hardening | The response size bound counted UTF-16 characters, not bytes. | **Fixed:** it now counts UTF-8 bytes. |

**Checked with no issue found:**
- the cursor MAC binding;
- head, oldest and gap clipping to the floor;
- opaque receipts;
- write-only grants cannot read;
- host-stamped publishers;
- owner and system operations cannot be reached from app RPC;
- flag gating;
- transactions await storage only;
- journal and `tx_conflict`;
- bounded waiter memory.

**Integration hunks still unwired:**
- federation must pass `context.grant {fragment, digest, readSince, history?}`;
- bus descriptors must be added to the resource provider (`eventBusDescriptors`);
- `/bindle/rpc` must hold long-polls at the edge with `holdBusRead` and set `busWaits`/`busResume`;
- revocation and approval must call `eventBusReader`;
- the account alarm must run sweeps.

Until these land, apps cannot reach a bus even with the flag on.

## IA implementation

Status: provisional, 2026-10-20. One independent security reviewer read IA-1/IA-2 as implemented, with no edits, and confirmed findings with throwaway probes:

- `packages/federation/{incremental,suppression}.mjs`;
- the intent hunks of `authorization-entries.mjs`;
- `packages/runtime/incremental-authorization.mjs`;
- `routes/incremental.mjs`.

The implementer fixed the confirmed findings and added a regression test for each. The fixes have not been re-reviewed. Sign-off: reviewer ___ / date ___ / outcome ___.

| ID | Sev | Finding | Disposition |
| --- | --- | --- | --- |
| IA-R1 | High | The tier-4 refusal for unreviewed apps relied on CX-1 facts. A contract missing from the consent snapshot classified as tier 2 with "missing effect", so send-as-you access was accepted. | **Fixed:** for unreviewed apps, any row with a missing effect or tier 4 refuses the entry. The consent facts must be scoped to pinned contracts (integration). |
| IA-R2 | High | Spec §9.1: suppression, caps and the ladder did not apply to `login` deltas on an existing connection, and required deltas were not coerced to optional. | **Fixed (2026-10-20):** at owner selection, `loginDelta` treats the delta of any intent on an existing connection as a `grant-more`, with the same app-site caps, ladder targets, suppression and tier-4 refusal. Blocked items are narrowed to held access (a plain decline), every request becomes optional, and consent receives `incrementalLogin.additions`. `loginOutcome` steps or resets the shared ladder after arming. The reviewer re-ran the probe and confirmed the plain re-login bypass closed. |
| IA-R3 | Med | Revealing one pre-declined item deleted every matching record, including `app`/`kind` blocks. | **Fixed:** only `fragment`/`field` records are lifted. |
| IA-R4 | Med | A decision on a superseded page skipped the arming dwell and the key check, so a suppression could be stored with zero dwell. | **Fixed:** the dwell is checked first, `begin` arms superseded views, and superseded decisions accept only decline or notice. |
| IA-R5 | Med | An app could supersede the open entry in the background so that the owner's decline stepped no ladder. | **Fixed:** an explicit decline on a superseded page steps the ladder (spec §15.2 item 9). |
| IA-R6 | Med | A configure save reset the ladder for every opened field, and `partial` reset the whole fragment target. | **Fixed:** only changed fields and fully granted fragments are reset. |
| IA-R7 | Med | `grant-more` `resources` were unchecked, so an app's own-site resource could be committed and mint tokens. | **Fixed:** only filtered candidates, and only for fields that hold no resources yet. |
| IA-R8 | Med | Port writes were not atomic with completion. A cancel during Allow left the grant committed while the app saw `declined`, and a post-commit error reopened the entry. | **Fixed:** the entry is marked `committing` before port writes and is never reopened after that; `abandon` and auto-complete refuse while a decision is live or committing; a retry of the same decision can finish (the commit is idempotent per entry). |
| IA-R9 | Low | Inline setup could overwrite existing values and fields that were not being approved. | **Fixed:** setup fills only empty fields of the approved delta. |
| IA-R10 | Low | No host was displayed for multi-valued URL, email or hostname suggestions. | **Fixed:** one host per element. |

Notes, not fixed:

- **IA-S1:** own-site matching is per host, so subdomain churn or a second domain the app owns can evade fragment suppression. `schemaHosts` and the caps bound this. Consider registrable-domain matching.
- **IA-S2:** `via: bulk`/`field` is asserted by the provider page.
- **IA-S3:** whether a bearer incremental session may follow DPoP-bound sessions should be fixed in the sessions port contract.
- **IA-S4:** configure decline steps fields revoked since creation.

Checked OK:

- `configure` never touches grants;
- suggestion limits hold;
- suppression is indistinguishable at creation, dwell, outcome and counters;
- no tokens on decline, suppression or no delta;
- PKCE, client, redirect and DPoP binding hold;
- a replay burns the code and revokes its session;
- the session cap holds;
- owner routes run after CSRF.

**IA-R2 re-review (same reviewer).** The probe confirms the plain re-login, wider-method, unpinnable-fragment, bus, reauthenticate and select-account paths, and alternating login and grant-more, are now bounded. It found three new gaps, all fixed with regression tests and not re-reviewed:

- **IA-R2a (High):** a freshly minted sibling client ID counted as a first connection and bypassed everything. Now "existing" means per app site: the client's own connection, the optional port `grants.siteConnection`, or any request history from that site.
- **IA-R2b (Med):** suppressed login items never stepped the ladder, so they were distinguishable from a decline. They now step on an armed decision.
- **IA-R2c (Low):** one decision counted for every account that selected on the entry. Now only the deciding owner counts, and an ownerless cancel counts only when exactly one account selected.

Residual: a login cancel needs no owner (pre-consent privacy S1). After arming it counts as a decline for the single selecting account, whereas a `grant-more` decline requires the owner.

## Wave 3b adapter integration (local; provisional, 2026-10-20)

Reviewer ___ Date ___ Outcome ___. Production release and the default-off gates remain unchanged. DEVLOG.md is intentionally not edited in this pass.

- IA now has durable Node/Worker composition over the owner's FederationService: transactional union commits, decision journals, bounded token issuance, live connections, preference revisions, DPoP proofs/nonces, and metadata-client blocking. Incremental pre-owner records and codes live in a separate `bindle-incremental-v1` store; owner grants, preferences and sessions remain on the owner shard. This centralized pre-owner store is provisional and needs capacity review before enabling. `loginDelta`/`loginOutcome` also reach entry stores and the legacy authorization-request path; app-site connection checks include sibling clients.
- CX-2 consumes the actual select/decision contract in incremental-authorization §15.1, including completed entries, empty configure request arrays, server dwell, suppressed suggestions, explicit bulk/individual choices and staged setup. The pure CX-1 projection is shared by browser and engine wrappers. Provider facts use reviewed contract pins and owner-scoped preferences/grants; no app-provided mock facts ship in the page.
- EV-2's integration hunks are mounted: fragment/digest/read-approval identity in RPC context, resource descriptors with actual wait limits, approval/revocation hooks, edge-held Bearer/DPoP reads and account-alarm sweeps. Read approval identities persist through widening. EV2-S4's account-alarm integration gate is implemented locally; this is not production verification or reviewer sign-off.
- LH-3 carries and checks the exact connection ID through occupancy. LH-7c bounds intake tx/jti retention and pruning; LH-7d routes the B8 public-intake shell through B7 with live broker checks in its commit. Messaging-address mount evidence still requires the describe port; EXT-X7 remains deferred.
- LA7 has owner app-family inventory, approval ancestry, last use, one/all session revocation and device-page wiring. Incremental sessions derived from linked approvals have independent lineage with the same approving chain. Host notices use verified contacts, the existing email/push transports and bounded service-worker rendering; provider acceptance is not proof of delivery.

Local coverage includes real Node and workerd identity/federation integration, actual incremental browser flows, the consent adapter's exact request bodies, service-worker notice rendering, event waits and alarm maintenance. Required gate results are reported with the integration handoff; no approval is inferred from passing tests.

IA integration handoff (owned-module changes deferred to the IA-R2 agent):

1. `tests/incremental-authorization-entries.test.mjs`'s parallel-redemption assertion is nondeterministic: replaying one code can call the idempotent `sessions.revoke` port repeatedly for the same sole issued family. Repeated full runs produced both a pass and `[family-1, family-1, family-1]` versus the expected single call. Reconcile the test with idempotent final revocation, or serialize logical revocation in `incremental.mjs`; never permit a second live session.
2. Fault injection through the real Node ports: allow a `grant-more` decision with inline setup, let `preferences.save` succeed, fail `grants.commit` once with `temporarily_unavailable`, then retry the identical decision after its 30-second decision lease. `incremental.mjs` rejects its own already-saved setup with `replace_in_settings`. The committing decision needs resumable, idempotent setup (or an atomic preference/grant commit contract). Before the lease expires, `decision_in_progress` is expected. This is a separate recovery gate; ordinary happy-path gates do not cover it.

**IA handoff resolution (2026-10-20, IA agent; not re-reviewed).**

1. **Replay revocation.** Revoking a replayed code is now logical and serialized in `incremental.mjs`. The code record carries a `revoked` flag, so the sole issued family is revoked exactly once however replays interleave, and a second live session is never possible. The parallel-redemption test asserts exactly one revocation, and 15 repeated runs were stable.
2. **Resumable decisions.** A decision journals its validated plan (approvals, setup values, configure values) with its lease when it starts writing. After a partial failure, a retry of the identical decision after the 30 s lease resumes that plan:
   - setup values that are already saved are skipped instead of being re-validated, so there is no `replace_in_settings`;
   - the grant commit is idempotent per entry;
   - outcomes use the commit's own `before`/`after`.

   A different decision, or `abandon`, gets `decision_in_progress`/`invalid_request` while a decision is committing. A configure save that succeeded before a failure resumes as `configured`, never `unchanged`. Covered by engine tests with fault-injected ports; the real-Node fault path is not exercised, since its lease runs on the system clock.
3. **Consent marking.** CX consent now shows login deltas on an existing connection as "New access requested by ‹app›" notes (`role="note"`). They are separate from "Already granted to ‹app›" cards, carry a summary status line, use en/es authorize-catalogue strings, and the selection's `incrementalLogin` is validated before render. Browser tests are in `tests/browser/consent-entry.mjs`.
