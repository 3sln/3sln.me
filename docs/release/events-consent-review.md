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
