# Consent experience, incremental requests and access views (3sln.me host design)

Status: **provisional design, 2026-10-20, revision 2.** Revision 1 was wargamed by a security/privacy reviewer and a UX/product reviewer, and revision 2 incorporates their fixes ([events and consent review](../release/events-consent-review.md)). The fixes have not been independently re-reviewed. Human sign-off: reviewer ___ / date ___ / outcome ___. Nothing here is implemented or production-verified. Decisions are provisional until signed in [DEVLOG](../../DEVLOG.md).

This is **host UX**, which the Bindle specs deliberately leave out. It relies on these interop drafts:

- [events](../spec/events.md): buses, access modes and disclosures;
- [incremental authorization](../spec/incremental-authorization.md): the `grant-more` and `configure` intents, outcomes, suppression, limits and effect metadata;
- the existing [protocol §3–§4](../spec/protocol.md) consent rules, [extensions §5](../spec/extensions.md#5-occupancy-consumption-and-consent), and [integrations §5.2](../spec/integrations.md#52-consent-disclosure).

It replaces the review layout of the current consent kit (`apps/web/src/ui/authorize-entry-consent.mjs`), and keeps the entry page's framing, member and arming protections ([authorize-entry UI review](../release/authorize-entry-ui-review.md)).

## 1. What changes from today

The current kit is correct but reads like a form dump. It shows one card per fragment with the publisher, the unverified purpose, the schema URL, a checkbox per field, raw contract URLs, and a hard-coded table of seven method labels (`methodNames`). That has four problems:

- it does not say what the app will be able to *do*;
- every method looks equally risky;
- the app's purpose sits beside provider text with almost equal weight;
- unknown methods show their raw names.

The new experience:

1. leads with **what the app can do**, written as plain sentences grouped by the thing it applies to;
2. separates the text by **who wrote it**: the provider (reviewed), the publisher (attributed) or the app (a claim);
3. ranks every capability into a **risk tier** that has both a visual and a text form;
4. reveals detail **progressively**, in three levels;
5. becomes a **short guided walkthrough** only when the request needs setup or carries high-risk items;
6. adds a matching persistent **"What this app can do"** view, and **"Who has access"** views per settings group, resource and event feed.

## 2. Decisions

| # | Decision | Why |
| --- | --- | --- |
| D1 | Effect text comes from the provider's reviewed catalogue first, then publisher metadata (`x-methods.summary`, bus `effects`), never from the app. The app's `purpose` and `reason` appear only as a quoted claim, after the effect text. | The party asking for access must not describe what the access does. |
| D2 | There are four risk tiers, derived by the provider from method `effect` and sensitivity `categories`. Categories can only raise a tier, and a missing `effect` counts as Change. | A publisher cannot talk a tier down, and the provider never needs to trust a "harmless" claim. |
| D3 | Publisher text for an **unreviewed** contract **or a bus manifest** carries "Described by ‹host›". When the publisher's registrable domain equals the app's, the line reads "Described by the app's own site". An unreviewed contract whose method claims `read` is shown at its claimed tier with a "Not checked by 3sln.me" line. If that contract or manifest is also published by the app's own site, it is raised to at least Change. Unreviewed write methods add "Not checked: could send, spend or publish as you". | Self-description by the requester is the main route to misleading copy. Raising every third-party read would cause fatigue. |
| D4 | The walkthrough has 1–3 steps: Set up (only when needed), Review (always), Confirm (only when an item is Delete or Act-as-you). A request without setup and without high-risk items is one screen. | Proportionate friction keeps attention for the requests that matter. |
| D5 | Incremental requests show only the delta. What the app already has is one collapsed line. | Repeating the full list is the main cause of consent fatigue. |
| D6 | Requested items are preselected only when their tier is 1–2 **and** comes entirely from reviewed catalogue metadata. Items in tier 3–4, items whose tier comes from a missing effect or unreviewed metadata, and "Can see private info" items start unchecked. Every card has a visible Include switch, and Allow counts what's included ("Allow 2 of 3"). | Apps can fire requests without user action, so preselection must be limited to items whose description the provider can stand behind. Visible switches make partial approval a first-class choice. |
| D7 | Decline is as large as Allow and sits beside it, and declines in one tap. A visible text button below the bar, "Stop Tasks asking for this…", opens the suppression choices. | Equal prominence avoids pushing the owner toward Allow. The user asked for an easy "never again", but it must not be a mis-tap away. |
| D8 | Suppressed requests show a short blocked notice, rather than returning silently (spec §9.3). | This keeps suppression invisible to the app. It also tells the owner why the feature they just tapped does nothing, and offers a way back. |
| D9 | The access views reuse the consent card component. | The owner learns one vocabulary and sees the same sentences before and after approval. |
| D10 | In the UI, a "bus" is called an **event feed**, a preference fragment **shared settings**, and a resource is called by its own label. | Bindle terms are jargon for owners. |
| D11 | The owner can always grant from the access views ("Not allowed yet", §7.1), and `rate_limited` responses point there. | Cooldowns and suppressions bind apps, never the owner, so an owner who changes their mind is never stuck. |
| D12 | "Checked by 3sln.me" attaches only to a row whose text is entirely catalogue text, never to a whole card. | A reviewed contract (event-bus) can carry unreviewed publisher text (bus `effects`) and app-chosen labels. |

## 3. Risk tiers

| Tier | Label (en) | Derived from | Icon | Visual treatment |
| --- | --- | --- | --- | --- |
| 1 | **Can see** | `effect` `read` or `pure` | eye outline | Neutral text, no fill |
| 1+ | **Can see private info** | tier 1 with category `personal-data` or `location` | eye with a dot | Medium-weight left rule, L1 expanded by default, chip kept |
| 2 | **Can change** | `effect` `write`, or a missing or unknown effect | pencil | Neutral text, medium-weight left rule |
| 3 | **Can delete** | `effect` `destructive` | trash can | `danger` text colour, bold left rule, row label prefixed "Can't be undone" |
| 4 | Named by its category: **Can send as you**, **Can spend money**, **Can change sign-in**, **Can make public** (generic: **Can act as you**) | any method with category `send-as-you`, `money`, `identity` or `public` | shield with an exclamation mark | `danger` fill band, white text, explicit checkbox |

- **Chips.** `personal-data` gives a "Personal info" chip, and `location` a "Location" chip. Both use a neutral outline, and both lift tier 1 to 1+.
- **Never colour alone.** The tier is always carried by text label, icon and rule weight. Icons are `aria-hidden`, and the label is read aloud. In forced-colours mode, rules use `CanvasText` and the danger band becomes a 3 px border with the label kept.
- **The palette is fixed provider tokens.** The app cannot theme the consent page.
- **Card tier.** A card takes the highest tier among its items. Cards are ordered tier 4 → 1, then by the app's request order. Inside a card, rows are ordered by tier.
- **Bus modes.** Read access is tier 1 plus the manifest's categories. `subscribe` and `unsubscribe` add nothing; they are part of read. Write access is tier 2, since others will read what this app writes. Write is raised to the highest tier-4 capability held by any **current reader** of that feed, with the line "Apps that read this feed may act on it, for example ‹reader› can send as you". A bus whose categories include `send-as-you` or `public` is tier 4 for write.
- **Brokered resources** get an extra line: "Your requests go directly to ‹origin›" ([integrations §5.2](../spec/integrations.md#52-consent-disclosure)). This does not change the tier.

## 4. Where the words come from

### 4.1 Assembly order for one capability row

1. **Provider catalogue** (`packages/consent/reviewed-contracts.mjs`, localized through `packages/i18n/consent-catalogue.mjs`). Used for reviewed contracts: profile, preferences, object storage, resource descriptor, event-bus, activity, and later others after review. It is shown without an attribution line, and each such row carries a small "Checked by 3sln.me" mark (D12). Reviewing means 3sln.me has read the contract and agrees the text describes what the contract **allows**. It is not a claim about how the app will behave, and the help text says so.
2. **Publisher `summary`** from pinned `x-methods` ([incremental authorization §8.1](../spec/incremental-authorization.md#81-contract-method-metadata-amd-c16)), or the bus `effects`. It carries an attribution line, "Described by ‹publisher host›", or "Described by the app's own site" (D3). For event feeds, the row text is the **catalogue sentence** ("See events in ‹feed title›", "Add events to ‹feed title›"), and the manifest's `effects` text follows it as an attributed quote. The bus contract being reviewed never lends its mark to publisher text.
3. **Settings reads.** Plain atomic fields have no methods. Their row is the catalogue sentence "See your ‹group› settings: ‹field titles›" (tier 1), with the group's publisher attribution, and, for shared fields, "Also sent to ‹apps›".
4. **Fallback**, when neither exists: the provider's generic tier sentence plus the method name in code style, for example "Can change something in Work calendar (`setColor`)", with "No description provided". The fallback never shows a blank row.

Every card heading shows "defined by ‹id host›" for the settings group or feed (extensions §9.2), alongside the resource host. Labels chosen by apps or integrations (resource labels, feed titles) appear in L0 only as quoted, bidi-isolated chips clamped to 40 characters, never spliced into a sentence.

The **app's claim** follows the rows, in a quote block with its own label: **"Tasks says why:"** “To add due dates to your calendar.” It is bidi-isolated, limited to 200 code points, and plain text. It is never a heading. It never appears above the effect rows, and it is never shown without the app's verified host somewhere on screen.

### 4.2 Localization

The interface language comes from the account preference, then the entry `uiLocales`, then the browser, then `en`. A locale is skipped at any step if 3sln.me does not ship it, so an unsupported account locale (say, `fr`) falls through to the next choice. This closes U-15 for the new screens.

- **Provider catalogue text** exists in every shipped locale (en and es at launch).
- **Publisher maps** are negotiated by BCP 47 lookup and fall back to `en`. Fallback text gets `lang="en"` and a small "(in English)" suffix in a non-English UI, so screen readers switch voice and owners know the text is not translated.
- **The app's `reason` and `purpose`** are shown as given, with `dir="auto"` and `lang` unset. The app's language is unknown, so the provider never machine-translates it.
- **Tier labels and chips** are provider text, always localized.

### 4.3 Defences against misleading copy

| Attack | Defence |
| --- | --- |
| An app writes "harmless, read-only" in its purpose | The purpose is a quoted claim placed after provider- or publisher-derived rows, and the tier comes from `effect`. |
| An app publishes its own contract with a soothing summary | "Described by the app's own site", plus the D3 tier floor for unreviewed self-published contracts |
| A publisher marks a destructive method `read` | It stays possible for unreviewed contracts, but is shown with "Not checked by 3sln.me". Issuer-hosted resources only use reviewed adapters. Brokered write-capable contracts need live introspection anyway. Residual risk is recorded in the review. |
| A bidi or homoglyph trick in titles | Bidi isolation everywhere. Hosts are shown in punycode when mixed-script. Titles are never used as the identity line. |
| Long text pushing the effect rows below the fold | Every untrusted string is clamped: two lines for titles, three for the purpose, with "Show more". The rows always render first. |
| A purpose that impersonates provider UI ("3sln.me recommends…") | It is in a quote block with the "‹App› says why:" label. The provider fixes the styling, and the text cannot be bold or a heading. |

## 5. Progressive disclosure

| Level | Shown | How |
| --- | --- | --- |
| L0, the card summary | One generated sentence ("See and add events in Work calendar"), the tier label and icon, chips, the Include switch, the field titles shared, and the **mandatory facts** that the specs require on the final screen: existing recipients by name ("Also sent to Mail, Notes"), and for event feeds the reader and publisher facts of [events §10.2](../spec/events.md#102-required-disclosures-before-approval) ("Notes and 1 other app will see what Tasks adds. Apps you allow later will too." / "Sent by: Tasks") | Always visible |
| L1, details | One row per capability with its tier; the host and data location ("Stored on 3sln.me" or "Requests go to cal.example"); for event feeds, retention and history; the attribution line; the app's claim; every app and provider feature that already has this access | "Details" disclosure per card. It is expanded by default for tier 3–4 cards, and collapsed for tier 1–2. |
| L2, technical | Fragment URL, contract URLs, digest, scope settings, the `client_id` URL | "Technical details" link inside L1, opening a sheet |

The L0 sentence is generated from **per-locale catalogue templates**, not by joining strings, so grammar holds in every language: "See, add and delete files in Photos". It uses the reviewed catalogue's verb forms where they exist. For publisher summaries, L0 falls back to "‹N› things in ‹resource›: see details", because concatenating free text is unsafe.

## 6. Screens

The wireframes describe structure, not pixels. ⟦…⟧ marks a control. Every screen sits inside the existing entry frame: COOP, `frame-ancestors 'none'`, member-scoped requests and delay-to-arm on every decision control.

### 6.1 Persistent header (every consent screen)

```
┌──────────────────────────────────────────────┐
│ [app monogram]  Tasks                         │  name = verified host for unreviewed apps
│ tasks.example · Reviewed app  | Not reviewed  │  fixed provider palette
│ Account: @ray (3sln.me)        ⟦Not you?⟧     │  ⟦Not you?⟧ only for login; incremental
│                                              │  intents are bound to subjectConstraint
│ Step 2 of 3 · Review                          │  only when there are several steps
└──────────────────────────────────────────────┘
```

An unreviewed app shows "Name the app gives itself (not verified): ‹claimedName›" on a second line (federation-implementation presentation rule).

### 6.2 Initial connection

**Short path (one screen).** It applies when there is no setup, every item is tier 1–2, and there are at most 4 cards.

```
Tasks wants to connect to your account
─────────────────────────────────────────
[card] Work calendar · on cal.example · defined by cal.example     Can change   ⟦Include ●⟧
  See and add events in Work calendar
  Also sent to: Mail
  ⟦Details ▾⟧
[card] Your profile                                                Can see      ⟦Include ●⟧
  See your name, handle and picture
  ⟦Details ▾⟧
"Tasks says why: Plan your week with your calendar."     ← the app's claim, after the cards
─────────────────────────────────────────
You can remove this access at any time in Access › Apps.
⟦Don't allow⟧                 ⟦Allow 2 of 2⟧
Stop Tasks asking for this…                               ← text button (incremental only)
```

- The Include switch appears only when there are 2 or more cards. Per-row checkboxes sit in L1. Allow's label counts what is included. With nothing included, Allow is disabled with the hint "Include at least one item, or choose Don't allow".
- In the DOM, the action bar comes after the content.

**Walkthrough (when needed).**

- **Step 1, Set up** (only if a requested fragment or field is unconfigured). It opens with a one-line preview of the purpose of the access: "Tasks wants to add events to a calendar. First choose which one." There is one compact form per unconfigured item.
  - Resource and event-feed fields show candidates as radio cards, none preselected and ordered by name, each with its host ("On 3sln.me", "On cal.example").
  - When a host can be created, a "Create on 3sln.me" card is always placed **last**, unselected. Creation happens only when Allow commits; declining leaves nothing behind.
  - Candidates on the requesting app's own domain are never offered here (incremental authorization §4.2). They are available from Settings.
  - Each atomic field shows its own editor. Shared fields show "Also used by: Notes, Mail" and need the shared-edit confirmation.
  - ⟦Save and continue⟧ commits atomic values (spec: configuration is not consent) and shows "Saved. Tasks can't see these until you allow it on the next step." Saving is atomic per step. ⟦Skip this⟧ appears for optional items and marks the item declined.
- **Step 2, Review.** These are the §6.2 cards. When 1–2 items are tier 3–4, their confirmation checkboxes sit **inline on their cards**, and there is no step 3.
- **Step 3, Confirm** (only when there are 3 or more tier 3–4 items). Heading: "Before you allow this". Each tier 3–4 capability gets its own checkbox, unchecked, written as a full sentence: "☐ Let Tasks **delete** files in Photos. This can't be undone." Allow stays disabled until every *required* tier 3–4 item is checked; optional ones may stay unchecked. If a required item is left unchecked, the only path is Don't allow, with the note "Tasks needs this to connect." Host policy may require an inline "Confirm it's you" step-up before Allow arms.

The back control returns to the previous step and keeps selections. Leaving the page counts as cancel, which starts no cooldown (spec §10).

### 6.3 Incremental `grant-more`

```
Tasks is asking for more access
─────────────────────────────────────────
NEW
[card] Work calendar · on cal.example · defined by cal.example     Can change
  Add events to Work calendar
  Currently: none   →   Asking for: add events
  ⟦Details ▾⟧
"Tasks says why: To add due dates to your calendar."     ← the entry reason, after the cards
─────────────────────────────────────────
Tasks can already: see your profile; see and change files in Tasks folder   ⟦Show⟧
─────────────────────────────────────────
⟦Don't allow⟧                  ⟦Allow⟧
Stop Tasks asking for this…
```

- A **widening** of an existing grant shows "Currently: see events → Asking for: see and **add** events", with the new verbs emphasized in text, not only in colour.
- An event feed card shows at L0 "Kept for up to 7 days. Tasks will only see changes from now on." When the manifest allows history, it adds a checkbox, unchecked: "☐ Also let Tasks see the last 7 days of task changes (1,204)" (events §6.3). For a write card, L0 shows who reads: "Notes and 1 other app will see what Tasks adds. Apps you allow later will too."
- An integration-hosted feed shows at L0: "Stored by dev.example. It sees every event and which apps read them, and says which app sent each one; 3sln.me can't check that. Removing access can take up to 6 minutes."
- Setup and confirmation apply exactly as in §6.2.
- When nothing is new, the page does not render and completes at once with no tokens (spec §4.1).

### 6.4 Stopping requests

⟦Don't allow⟧ declines in one tap. The text button "Stop Tasks asking for this…" (D7) opens a sheet:

```
Stop Tasks asking
( ) Don't ask again for calendar access
( ) Don't let Tasks ask for more access
You can undo this in Access › Apps › Tasks.
⟦Don't allow and stop asking⟧      ⟦Back⟧
```

- No option is preselected. The confirm control is disabled until one is chosen.
- Scopes map to the spec: "calendar access" is the `fragment` scope for the named settings group, matching its later versions too (spec §9.1), and "more access" is `kind: grant-more`. For `configure`, the options are "Don't ask again to change Weekly summary" (fragment) and "Don't let Tasks ask to change settings" (kind).
- After 3 declines from one app within 7 days, the sheet adds "Don't let Tasks ask for anything" (`app` scope).
- The sheet uses the screen-reader name "Stop asking options". The bar's only decline control is named "Don't allow".

### 6.5 `configure` with a suggestion

```
Tasks suggests changes to "Weekly summary" · defined by tasks.example
─────────────────────────────────────────
Send day         ( ) Keep Friday   ( ) Use Monday (suggested)   ( ) Choose…
                 Not decided — stays Friday
Send summaries   ( ) Keep Off      ( ) Use On (suggested)       ( ) Choose…
Forward to  ⚠    ( ) Keep empty    ( ) Use hooks.tasks.example/… (suggested)
                 Sends data to hooks.tasks.example · Also changes it for Mail
─────────────────────────────────────────
⟦Use suggested values (not the marked ⚠ ones)⟧   (only with 2 or more unmarked rows)
"Tasks says why: Weekly summaries need a send day."
You're changing: Send day Friday → Monday                 ← live summary of decided changes
☐ I understand Mail will see this change                  ← only when a shared row changes
⟦Cancel⟧                       ⟦Save⟧
Stop Tasks asking to change settings…
```

- Each row is a **radio group**: Keep current, Use suggested, or Choose…. Arrow keys move inside a group, and the group announces its state. Rows start undecided, showing "Not decided — stays ‹current›". Nothing is ever pre-applied.
- "Choose…" opens the field editor in place, prefilled with the **current** value.
- Save is enabled once at least one row is decided with a value that differs from the current one, and any required shared-change acknowledgement is checked. The live summary lists exactly what Save will change.
- ⚠ rows are sensitive (spec §5.2): URL, email and hostname fields, fields marked `sensitive`, and **any field another app receives**. They need their own choice and are never covered by the bulk button. The row names the host and the other receivers.
- Opening a field with no suggestion shows only the editor: "Tasks asks you to set: Send day".
- An empty slot or event-feed field shows the occupant chooser of §6.2 step 1, never a suggestion. An existing occupant shows "Change this in Settings" (spec §4.2).

### 6.6 Blocked-request notice (spec §9.3)

```
Tasks tried to ask again for calendar access
You told us not to show this request, so we didn't.
⟦Back to Tasks⟧                                    (primary; armed like decision controls)
Stop all requests from Tasks                        (text button)
Show the request                                    (text button; opens §6.3 and removes the block if you allow)
```

"Back to Tasks" uses the same arming delay as decision controls, so a fast return does not reveal the block (spec §9.3).

### 6.7 Returning

After a decision, the page states the outcome in words. Example: "You allowed: add events in Work calendar. You didn't allow: see events in Personal calendar."

- When the result is **partial**, the recap stays until the owner presses ⟦Continue to Tasks⟧.
- Otherwise it stays at least 2 s after the live region announces it, then redirects.
- Popup delivery closes on acknowledgement, as today.

**Network failure.** If the decision request fails, the page says "Couldn't reach 3sln.me. Nothing was decided." with ⟦Try again⟧. Decisions are idempotent per entry, so a repeated press or retry never double-commits.

## 7. Persistent access views

Route: Settings › **Access**, with three tabs, **Apps**, **Shared settings** and **Event feeds**. It replaces the "Apps with access" panel in Security (`release-security.mjs`), and has deep links from the resource pages, the activity center and `owner_review_uri`. The UI uses one name everywhere: **Access › Apps**.

### 7.1 "What Tasks can do" (Apps › Tasks)

```
Tasks · tasks.example · Reviewed app
Connected since 3 Oct · Status: Working | Needs setup | Paused | Problem
─────────────────────────────────────────
What Tasks can do
[cards, as in consent, each row with ⟦Remove⟧ and "Last used: today" (hourly aggregate)]
─────────────────────────────────────────
Not allowed yet
  See events in Personal calendar · asked 20 Oct       ⟦Allow…⟧
Requests from Tasks
  20 Oct · Asked for calendar access · You allowed part
  12 Oct · Asked to change Weekly summary · No change
Blocked requests
  Calendar access · since 12 Oct            ⟦Allow asking again⟧
  [after two blocks] ⟦Block all requests from Tasks⟧ (suggestion)
─────────────────────────────────────────
Notifications from Tasks  ›   (activity center controls; not duplicated here)
⟦Pause Tasks⟧   ⟦Disconnect Tasks⟧
```

- **Not allowed yet** lists items the app requested that the owner declined, or removed later. ⟦Allow…⟧ opens the §6.3 review as an owner-started flow: no cooldown or suppression applies, and allowing resets the decline ladder for that target.
- ⟦Remove⟧ on a row narrows the grant to the remaining methods. Removing the last row of a card removes the fragment grant. Before committing, a confirmation names what stops working: "Tasks will no longer be able to add events. Tasks may stop working or ask again. It may keep data it already has." It offers "☐ Don't let Tasks ask for this again", unchecked.
- **Pause** suspends the connection (integrations §3.1): the app keeps its settings and grants on record, but gets no tokens, events or RPC until resumed. Resuming needs no new consent.
- Disconnect shows the integration severance facts: for brokered resources, "access to cal.example resources ends within 6 minutes", and "Tasks keeps data it already received".

### 7.2 Per shared-settings group (Shared settings › Weekly summary)

The values with ⟦Edit⟧, then **Who has access**: one row per app or provider feature, listing the fields it receives and a tier chip, the "since" date and "last used", with ⟦Remove access⟧. Editing shows the affected apps, as today.

### 7.3 Per resource (for example, Work calendar)

Header: the label, the host ("Stored on 3sln.me" or "On cal.example; requests go directly there"), and the scope summary. **Who has access** is grouped by app, then by which shared-settings group grants it, with the capability rows and tiers. ⟦Remove⟧ appears per app and per row. A brokered resource adds "Connection: cal.example · Working | Problem" and a link to that integration's page.

### 7.4 Per event feed (Event feeds › Task changes)

```
Task changes · event feed defined by tasks.example
Hosted on 3sln.me · Keeps 7 days · 1,204 events · 0.6 MB
⟦Change host…⟧  ⟦Clear all events⟧  ⟦Delete feed⟧
─────────────────────────────────────────
Who can add events (write)
  Tasks       · since 3 Oct · last added 2 min ago      ⟦Remove⟧
Who can see events (read)
  Calendar Bridge · since 5 Oct · notified of new events   ⟦Remove⟧
  Notes           · since 9 Oct · checks for new events    ⟦Remove⟧
  3sln.me Digest (built-in feature) · on                ⟦Turn off⟧
Waiting for your approval
  Notes can't see events from the new host yet           ⟦Review⟧
```

- "Notified of new events" means a push subscription; "checks for new events" means pull. Owners see this; readers never see each other (events §6.3).
- ⟦Change host…⟧ explains that a new feed starts empty, that the old feed's events are deleted with it (provider-hosted) or stay with the old host until that host deletes them (integration-hosted), and that each app must be approved again with none preselected (extensions §3.4).
- ⟦Review⟧ under "Waiting for your approval" opens a per-app review of the new host, with each app unchecked. It is the extensions §3.4 per-consumer review.
- ⟦Clear all events⟧ and ⟦Delete feed⟧ are destructive and require confirmation. Delete names every app that will lose access.

### 7.5 Revoked or changed while in use

- **Provider-hosted:** the row disappears at once, and a toast says "Notes can no longer see Task changes." The app's next read fails.
- **Integration-hosted:** the row shows "Ending: access stops by 10:48" until `access_ends_by`, then disappears. Acknowledgement status shows on hover or press, as integrations §7.3 requires.
- If an app is in the middle of a consent page when its access is revoked elsewhere, the entry fails with `consent_stale` and re-reviews ("Your shared settings changed. Review them again.").

## 8. Copy guidelines (en)

1. **Second person, present tense, about the owner's things.** "See your calendar events", not "Read access to calendar resource".
2. **Lead with the verb of the tier:** see, add, change, delete, send as you, spend, make public. Use one verb per idea. Never use "manage" or "access" alone.
3. **Name the thing by its label** (Work calendar), not its type (resource).
4. **Say limits when they exist:** "only Work calendar", "only files in Tasks folder", "kept for 7 days", "can't see events from before today".
5. **Say who receives data when it's not 3sln.me:** "Requests go directly to cal.example."
6. **No "may" for capabilities.** Write "Tasks can delete files", not "Tasks may be able to". Use "may" only for uncertain facts ("may keep data it already received").
7. **Never praise or reassure:** no "safe", "secure", "recommended" or "trusted" for third-party items. Only "Checked by 3sln.me" for reviewed text, with its tooltip ("We checked what this allows, not how the app uses it").
8. **Keep lines short:** card summaries ≤ 60 characters, rows ≤ 90.
9. **Avoid jargon in the UI:** fragment, contract, scope, grant, bus, token, slot, occupant. These words appear only on the L2 technical sheet.
10. **Make declines non-judgmental:** "Don't allow" and "Not now", never "No thanks, I don't want calendar features".

### 8.1 Example strings

Strings are owned by the catalogue (CX-1). Generated sentences use per-locale templates, never concatenation.

| Situation | en |
| --- | --- |
| Initial heading | Tasks wants to connect to your account |
| Incremental heading | Tasks is asking for more access |
| Configure heading | Tasks suggests changes to "Weekly summary" / Tasks asks you to set up "Weekly summary" |
| Tier labels | Can see · Can see private info · Can change · Can delete · Can send as you · Can spend money · Can change sign-in · Can make public |
| Chips | Personal info · Location · Spends money · Sends as you · Changes sign-in · Makes public |
| Attribution | Described by cal.example · Described by the app's own site · Checked by 3sln.me · Not checked by 3sln.me · Not checked: could send, spend or publish as you |
| App claim label | Tasks says why: |
| Storage row | See files in Tasks folder |
| Storage write | Add and replace files in Tasks folder |
| Storage destructive | Delete files in Tasks folder. This can't be undone. |
| Profile | See your name, handle and picture |
| Activity | Send you notifications in Activity (you choose what pings your phone) |
| Event feed read | See events in "Task changes" (feed defined by tasks.example) |
| Settings read | See your Weekly summary settings: send day, send summaries |
| Event feed write | Add events to "Task changes" · Notes and 1 other app will see what Tasks adds. Apps you allow later will too. |
| Feed facts | Kept for up to 7 days · Tasks will only see changes from now on · Also let Tasks see the last 7 days of task changes (1,204) |
| Brokered | Your requests go directly to cal.example. 3sln.me doesn't see them. |
| Already | Tasks can already: see your profile ⟦Show⟧ |
| Shared | Also sent to Mail and Notes (L1 for the app list; never phrased as endorsement) |
| Footer | You can remove this access at any time in Access › Apps. |
| Confirm checkbox | Let Tasks delete files in Photos. This can't be undone. |
| Stop asking | Stop Tasks asking for this… · Don't ask again for calendar access · Don't let Tasks ask for more access |
| Blocked notice | Tasks tried to ask again for calendar access. You told us not to show this request, so we didn't. |
| Returning | You allowed: add events in Work calendar. You didn't allow: see events in Personal calendar. |
| Remove confirmation | Tasks will no longer be able to add events. Tasks may stop working or ask again. It may keep data it already has. |
| Network failure | Couldn't reach 3sln.me. Nothing was decided. |
| Interrupted | This request expired. Nothing was decided. Start again from Tasks. |

## 9. Accessibility

- **Structure.** One `h1` per screen. Each card is a `section` with an `h2` naming the thing. Capability rows form a list, and each row's tier label is the first text read: "Can delete: delete files in Photos. This can't be undone."
- **Disclosure.** Native `details` and `summary`, or `button` with `aria-expanded` and `aria-controls`. Tier 3–4 cards start expanded.
- **Focus.** Focus moves to the step heading on step change, but only after a user interaction (U-5). It never lands on Allow by default. There is one polite live region. Announcements are queued by priority (outcome, then expiry, then errors, then arming hints) so they never overwrite each other.
- **Arming.** Decision controls are `aria-disabled="true"` with `aria-describedby` "Available in a moment" until armed. Early activation gives the existing "Ready in a moment" notice (U-2). Keyboard and screen-reader activation follow the same arming as pointer activation.
- **Checkboxes** carry full-sentence labels. A group of tier 3–4 confirmations is a `fieldset` with a `legend`.
- **Contrast and colour.** Fixed tokens meet 4.5:1 for text and 3:1 for rules and icons. Tiers are never conveyed by colour alone. Forced-colours handling is in §3.
- **Language.** `lang` is set on publisher fallback text. Untrusted text gets `dir="auto"` and bidi isolation.
- **Reflow.** No horizontal scroll at 320 CSS px and 400 % zoom. Long hosts wrap at dots. Touch targets are at least 44 × 44 px.
- **Motion.** None, apart from an optional 150 ms disclosure transition, which is disabled under `prefers-reduced-motion`.
- **Toggletips.** "Checked by 3sln.me" and other explanations are toggletips (a button revealing inline text), usable by touch and screen readers, never hover-only tooltips.
- **Time.** Entries expire on the server (entry `expiresAt`). With 60 s remaining, the page warns "This request expires in 1 minute" in the live region and offers ⟦More time⟧, which extends the entry once, by up to 10 minutes and within the policy cap (WCAG 2.2.1). Expiry never auto-declines silently while the owner is typing in setup: the page says it expired and offers "Start again from Tasks".

## 10. Mobile

- Single column. The header compacts to the monogram, host and step on one line, and the account goes to a second line.
- A sticky bottom action bar holds ⟦Don't allow⟧ and ⟦Allow⟧ at equal width. Below 480 CSS px of viewport height, including landscape phones and 400 % zoom, the bar is **not** sticky and follows the content, and the page sets `scroll-padding-bottom` so focused elements are never hidden (WCAG 2.4.11). A safe-area inset applies. The bar never covers the last card, because the page adds bottom padding equal to the bar's height. Arming resets only on width changes, so URL-bar height changes during scroll do not disarm it (U-1).
- The decline options and the technical sheet open as bottom sheets with focus containment.
- Setup forms are full-width. Resource candidates are stacked radio cards.
- Cards default to L0. A tier 3–4 card shows L1 expanded but clamped to 5 rows, with "Show all".

## 11. Edge cases

| Case | Behaviour |
| --- | --- |
| The owner approves part of the request | The returning screen lists what was and wasn't allowed. The app receives `partial` with the full current grant. The access view shows exactly the approved rows. |
| Setup is abandoned partway | Saved atomic values stay, because configuration is independent. Resources chosen for creation are not created. The request returns `declined` for the unfinished items, with no ladder step if no decision was made. Saved fields are visible to no app until approved. |
| The owner is interrupted and the entry expires | "This request expired. Nothing was decided." No cooldown starts (spec §10), so the app can ask again when the owner retries. |
| The island popup is blocked | No entry is created. The element falls back to the redirect path, and the owner sees the ordinary consent page in the tab. |
| An event feed's host is replaced while apps read it | Old grants are revoked (events §8). The feed page lists each reader under "Waiting for your approval", none preselected. Apps see the field in `requiresConsent`. |
| A read grant is revoked during a long-poll | Provider-hosted: the app's held read returns `forbidden` within 5 s. Integration-hosted: it ends by `access_ends_by`, and the access view shows "Ending…". |
| The request names a different account than the one signed in | Incremental entries are bound to `subjectConstraint`. The page says "Tasks is connected to @ray. Sign in as @ray to continue", using the reauthenticate path, and never offers another account. |
| A second request arrives while one is open | The older one is superseded (spec §10). Its page disarms, shows "This request was replaced by a newer one from Tasks", never loads the new entry in place, keeps any stop-asking choice already made, and returns `declined` with no ladder step. |
| A request repeats one that was just declined | `rate_limited` at creation, with `owner_review_uri`. The app can offer "Review in 3sln.me", which opens Access › Apps › Tasks › Not allowed yet. |
| Everything requested is already allowed | Completes immediately with no page. |
| The fragment document is unavailable or its digest changed | The pinned copy governs existing grants. New requests for it show "This settings group can't be checked right now" and are `unavailable` only when that follows from public facts. Otherwise `declined`. |
| A publisher text locale is missing | English with "(in English)" (§4.2). |
| The app is unreviewed | Islands are unavailable. The header shows "Not reviewed". Unreviewed apps cannot request tier-4 items in v1: the provider refuses the entry with `invalid_request` (open question Q7). Because the tier depends on publisher-declared categories, unreviewed write methods also carry the "Not checked: could send, spend or publish as you" line and are never preselected. |
| The owner has many apps on one feed | The access view groups readers and writers and paginates at 20 rows. |
| An identity or money item while the session isn't fresh | An inline "Confirm it's you" step-up before Allow arms. A step-up failure keeps the page, with nothing decided. |

## 12. Implementation slices (proposal; the roadmap is not edited)

Prefixes: **EV-#** (events), **IA-#** (incremental authorization), **CX-#** (consent experience). Every slice is engine-first, default-off behind new flags `EVENT_BUSES_ENABLED` and `INCREMENTAL_AUTH_ENABLED` (appended to the flag tables), and gated by the roadmap's standard checks plus browser checks at 320, 390 and 1440 px in en and es for UI slices.

| Slice | Wave | Tag | Owns (write) | Depends on |
| --- | --- | --- | --- | --- |
| AMD-C12–C20 spec application | after sign-off (W2 integrator) | [S] | the listed core spec sections only | user sign-off |
| CX-1 effect model | W2 | [A] | `packages/consent/effects.mjs` (tier derivation, row assembly, locale choice), `packages/consent/reviewed-contracts.mjs`, `packages/i18n/consent-catalogue.mjs` (+ one line in `catalogues.mjs`), `tests/consent-effects.test.mjs` | EXT-X1 (pinned contract access, read-only) |
| EV-1 bus manifest validation | W2 | [A] | `packages/federation/buses.mjs`, `tests/buses-manifest.test.mjs` | EXT-X1 (`extensions.mjs` read-only) |
| IA-1 entry intents backend | W3 | [S] | `packages/federation/incremental.mjs` (delta, outcomes, suggestion validation, token-less no-delta exchange, session-lifetime cap, same-domain candidate filter); `grant-more`/`configure` hunks in `packages/federation/authorization-entries.mjs` and `packages/runtime/federation-entry-http.mjs`; `tests/incremental-authorization.test.mjs` | EXT-X1 (AMD-C5 outcomes), IA-2 interface |
| IA-2 suppression and limits | W3 | [S] | `packages/app/domains/request-suppression.mjs`, `packages/runtime/account/request-suppression.mjs`, appended `PROVIDERS` and `ACCOUNT_OPERATIONS` rows, `tests/engine-request-suppression.test.mjs` | none (interface agreed with IA-1 first) |
| EV-2 hosted bus engine | W3 | [S] | `packages/events/*` (store, cursor MAC, reader floors, retention, quotas through the existing activity meter port), an appended `RESOURCE_METHOD_HANDLERS` line for `event-bus/v1`, `tests/events-*.test.mjs` | EV-1, EXT-X1 |
| CX-2 consent walkthrough UI | W3 | [A] | `apps/web/src/ui/consent/*`, `apps/web/src/bl/consent-flow.mjs`; `authorize-entry-consent.mjs` becomes a thin adapter; the intents hunk in `apps/web/src/bl/authorize-entry.mjs` (`INTENTS`, `validEntryView`); `tests/browser/consent-*.mjs` | CX-1; the IA-1 view shape agreed first |
| IA-3 SDK helpers | W3 | [A] | `packages/sdk/src/incremental.mjs`, `packages/sdk/test/incremental.test.mjs` | IA-1 wire |
| EV-3 push doorbells | W4 (after EXT-X6) | [S] | `bus-advanced` emission appended to `packages/runtime/integration-events.mjs` (handed off by X6), subscriptions in `packages/events/subscriptions.mjs`, `tests/events-doorbell.test.mjs` | EXT-X6, EV-2 |
| IA-4 island `request` part | W4 | [S] | `apps/embed/src/parts/request.mjs`, the `request` element in `packages/sdk/src/elements/`, `prepare-request` in `packages/sdk/src/islands-protocol.mjs`, `tests/browser/islands-request.mjs` | IA-1, AMD-C20 |
| EV-4 brokered bus conformance | W5 (after EXT-X8/X9b) | [A] | `tests/fixtures/bus-host.mjs`, `tests/events-brokered.test.mjs` | EXT-X8, EXT-X9b |
| CX-3 access views | W5 (with EXT-X11) | [A] | `apps/web/src/ui/access/*`, `apps/web/src/bl/access.mjs`, removal of the "Apps with access" panel hunk in `apps/web/src/ui/release-security.mjs`, `packages/runtime/routes/access.mjs` (appended to the routes index), `tests/browser/access-*.mjs`. X11 links to these views and does not duplicate them. | IA-2, EV-2, EXT-X4 |

Conflict notes:

- `authorization-entries.mjs` and `federation-entry-http.mjs` gain a single W3 owner (IA-1). LA2 and LA3 must finish their hunks first, or rebase on IA-1.
- `bl/release.mjs` (the Access route) joins the serialized list after ACT-3, as CX-3.
- `integration-events.mjs` passes from X6 to EV-3 in W4.
- CX-2 and LA4's approval page share no files.

## 13. Open questions for the user

1. **Q1 Bus as a slot.** Is it acceptable that a bus is an `exclusive` slot with a critical `bus` member (one bus per entity per manifest)? The alternative is a new primitive, at the cost of duplicating grants and access views.
2. **Q2 Name.** "Event feed" in the UI and "event bus" in the specs?
3. **Q3 Doorbell-only push.** Doorbells carry no records, so latency is one extra round trip. Should records ride inline in push later, which costs data minimization?
4. **Q4 SSE deferred.** Long-poll only in v1, given Durable Object cost?
5. **Q5 History default.** New readers never see past events unless the owner opts in at consent, and only if the manifest allows it. Agreed?
6. **Q6 Suppression secrecy.** The design keeps suppression secret at the cost of a one-click blocked notice, bounded by the decline ladder. The alternative tells apps `suppressed` and shows nothing, which is zero friction but discloses the owner's choice.
7. **Q7 Unreviewed apps and tier 4.** Refuse act-as-you, money and identity items for unreviewed (metadata-document) apps in v1?
8. **Q8 Publish cost.** Revision 2 gives publishes a **separate event allowance** (2,000 per day Free, 20,000 paid, at most half per publisher), so a feed cannot block the owner's own writes. This replaces sharing the general activity meter, after SEC-10. Accept?
9. **Q9 Limits.** Accept the reference values: buses 8 Free / 32 paid, retention 7 / 30 days, 10,000 records or 16 MiB per feed, the decline ladder 24 h / 7 d / 30 d, and the per-app caps 3/h, 6/day, 20/30 days?
10. **Q10 "Checked by 3sln.me".** Who reviews contracts for the provider catalogue, and is that label acceptable legally?
11. **Q11 Push opt-in.** May an app *ask* (through `configure`-style UX) for the owner to turn on push for its activity, or does that stay purely owner-initiated, as the activity center now specifies?
12. **Q12 Long-poll hosting.** Should held waits move out of the account Durable Object into a per-feed notifier if residency costs prove material?

## 14. Review reconciliation

See [events and consent review](../release/events-consent-review.md) for the findings and dispositions that produced revision 2.
