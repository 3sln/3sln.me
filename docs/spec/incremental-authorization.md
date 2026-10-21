# Incremental authorization and configuration requests — normative draft

Status: **provisional draft, 2026-10-20, revision 2.** Revision 1 was wargamed by two independent reviewers, and revision 2 answers their findings ([events and consent review](../release/events-consent-review.md)). The revision 2 fixes have not been independently re-reviewed. Host UX: [consent experience](../architecture/consent-experience.md). User direction: [DEVLOG, "Event buses, rich consent and incremental authorization"](../../DEVLOG.md#2026-10-20--event-buses-rich-consent-and-incremental-authorization-user-direction). Human sign-off: reviewer ___ / date ___ / outcome ___. Nothing here is implemented or production-verified.

This document extends [protocol §2–§4](protocol.md), [auth](auth.md#application-authorization), the `authorization-entry.v1` feature, [contracts](contracts.md), [extensions](extensions.md) and the [components profile](../profiles/components-v1.md). It defines interoperability rules: wire members, outcomes, and the provider obligations that apps can observe or rely on. It defines no layout or copy; those belong to the [host design](../architecture/consent-experience.md). §13 lists the amendments, which are **proposed and unsigned**.

## 1. Model

An app that is already connected can ask, at the moment it needs something, for one of two things:

- **`grant-more`:** new or wider access, such as another fragment, more fields, more methods, or bus access. The answer changes grants only.
- **`configure`:** the owner opens one fragment, or some of its fields, to edit, optionally starting from a configuration the app suggests. The answer changes preference values only, and **never grants**.

Both use the provider's authorization entry, the same mechanism as `login`, `reauthenticate` and `end-session`. Both put the owner in a provider-rendered document. Neither lets the app write a grant or a preference value; the app can only ask.

Three rules govern every request:

1. **Incremental requests are always optional.** Declining never disconnects the app, never revokes existing access, and never removes configuration.
2. **Requests only add.** `grant-more` never narrows or replaces existing access. Narrowing is an owner action.
3. **The owner can stop a request from recurring** (§9), and the app cannot tell that apart from an ordinary decline.

## 2. Feature and intents

The `authorization-entry.v1` feature's `intents` set gains `grant-more` and `configure` (AMD-C18). A provider lists them only when it implements this document. A client MUST NOT send an intent that is not listed. Without support, the client uses the fallbacks of §11.

The entry body, the `?entry=` page parameter and the entry responses are still **reserved** in the wire profile (protocol §2). This document fixes the members the two intents add or constrain, so they can be published together with the entry body.

## 3. Entry members

All entry members keep their existing meaning: `client`, `redirectUri`, PKCE `challenge`, `state`, `presentation`, `delivery`, `nonce`, `uiLocales`, `colorScheme` and `dpopJkt`. The new intents constrain or add these members:

| Member | `grant-more` | `configure` | Meaning |
| --- | --- | --- | --- |
| `subjectConstraint` | required | required | The app's current subject at this issuer. The provider lets the owner continue only as this subject. Another signed-in account cannot be chosen. |
| `requests` | required: 1–4 fragment requests | forbidden | Fragment requests in the protocol §3 shape. `required` MUST be absent or `false` (rule 1). Each request SHOULD carry `digest` (AMD-C2). |
| `reason` | optional | optional | The app's plain-text reason for asking now, at most 200 code points. It is shown only as the app's own claim. It is never shown as provider text, never as a heading, and never without the app's verified host. |
| `target` | forbidden | required | `{fragment, digest?, fields?}`. `fields` is 1–8 field names of that fragment. Absent means every field the app holds a grant on. |
| `suggestion` | forbidden | optional | `{values}`: proposed values for atomic fields in `target` (§5.2), at most 2 KiB serialized. |
| `maxAge` | forbidden | forbidden | Freshness is governed by host policy (§10). |

The provider validates every member when the entry is created and rejects malformed entries with `invalid_request`. These conditions are checked against the app's own state and therefore leak nothing:

- `subjectConstraint` is not a subject this client has a live connection with;
- `target.fragment` is not covered by the app's current grant;
- a `target.fields` entry is outside the granted field set;
- a `suggestion` value fails the schema or names a field outside `target`.

**Example (`grant-more`).**

```json
{"intent":"grant-more","subjectConstraint":"https://example.org/entities/e_123",
 "redirectUri":"https://tasks.example/bindle/callback","challenge":"…","state":"…","dpopJkt":"…",
 "reason":"To add due dates to your calendar.",
 "requests":[{"fragment":"https://cal.example/preferences/calendars/v1","digest":"sha256-…",
              "purpose":"Add task due dates as events.","fields":["calendar"],
              "methods":{"calendar":{"https://spec.bindle.example/contracts/calendar/v1":["createEvent"]}}}]}
```

**Example (`configure` with a suggestion).**

```json
{"intent":"configure","subjectConstraint":"https://example.org/entities/e_123",
 "redirectUri":"https://tasks.example/bindle/callback","state":"…",
 "reason":"Weekly summaries need a send day.",
 "target":{"fragment":"https://tasks.example/preferences/summary/v1","fields":["day","enabled"]},
 "suggestion":{"values":{"day":"monday","enabled":true}}}
```

`configure` entries carry no PKCE `challenge`, because they produce no code (§6.2).

## 4. `grant-more`

### 4.1 Delta computation

For each request, the provider compares the requested fields, resources and methods with the app's current grant on that fragment:

- items already held are **already allowed**: they are shown as such and not asked again;
- the rest is the **delta**, and only the delta is the decision.

If no request has a delta, the provider completes without asking, with every outcome `granted` (§6.1). This reveals nothing the app could not compute from its own grants, and the exchange issues **no tokens** (§4.4), so a silent completion cannot mint a session.

A request for a fragment URL that differs from the one granted, for example a new version, is a new fragment. The old grant is unaffected, and the provider presents the request as new access.

### 4.2 Inline setup

If a requested fragment, or a field the delta needs, is unconfigured, the owner configures it inline before deciding. This is the existing rule of protocol §3 ("unconfigured required fragments show the request before the setup UI"), now applied to optional incremental requests. For a bus manifest, setup is the occupant choice ([events §3](events.md#3-hosting)), with no candidate preselected.

Setup inside a `grant-more` flow MUST NOT:

- replace the occupant of an `exclusive` slot that has an enabled provider consumer ([extensions §3.4](extensions.md#34-policy-is-not-authority)). The provider sends the owner to settings instead;
- change values that other apps currently receive unless the shared-edit disclosure is shown and confirmed (protocol §4). Choosing a resource for an empty field is not such a change;
- offer, as an occupant candidate (a bus host, or any slot occupant), any resource whose origin shares a registrable domain with the requesting client. This follows [extensions §9.3](extensions.md#9-trust-and-security-requirements): a claim is never offered inside the claimant's own flow. The owner can still choose such a host from Settings;
- offer replacement of an existing occupant of any slot or bus. Replacement starts a new, empty bus and revokes other consumers, so it belongs in Settings;
- create a provider resource, such as a built-in bus, before the owner approves. The provider creates resources chosen during setup only when Allow commits. On decline or cancel, nothing is created.

### 4.3 Decision and grant update

The owner may approve all of the delta, part of it (per field, per resource and per method), or none of it. The provider then commits these changes atomically:

- for each request with approved delta items, the grant becomes `previous ∪ approved`, bound to the pinned digest. A new grant identifier is issued where the grant model requires one (integrations §5.3);
- requests with nothing approved leave the grant untouched;
- for bus grants that gain `read` for the first time at this commit, the reader floor ([events §6.3](events.md#63-visibility-and-history)) is set at this commit, unless the owner explicitly chose earlier history. An existing floor never moves.

Existing approved access is never reduced, even if the owner unchecks an "already allowed" item. The decision page does not offer that control; narrowing happens in the access views.

### 4.4 Code exchange

Every decision, including decline, "not now" and the suppression notice's return, ends in an ordinary authorization code for the redirect, popup or island delivery, because the code carries outcomes. The exchange follows the wire profile, with PKCE, `state`, `iss` and DPoP when `dpopJkt` was given.

**Tokens are issued only when access was added.**

- If no delta item was approved, the token response carries `fragment_outcomes` only, with **no access token and no refresh token**. A decline, a suppressed request or a no-delta request can therefore never mint or extend a session. This also stops an injected script from turning the owner's "Don't allow" into a persistent session under the script's own `dpopJkt`.
- If any delta item was approved, the response is the ordinary one for a new client session (auth), bound to the same connection, whose grants are the union. That session MUST NOT outlive the connection's newest existing session: its absolute expiry and `auth_time` are at most those of that session. Incremental authorization never extends a session's lifetime.
- Grants belong to the connection, not to the session, so the app's existing sessions also see the union at their next live check. An app that does not need the new session SHOULD revoke it (RFC 7009).

A window closed without any decision produces no callback. The island path reports it as `canceled` (§7.2).

## 5. `configure`

### 5.1 Scope

`configure` opens only fields the app already holds a grant on (§3). It cannot open a field the app cannot see, so a suggestion can never target data the app is not entitled to read. The owner may edit any opened field, accept or reject each suggested value, or leave without saving.

If an opened field is shared with other apps, the provider shows those apps and requires the shared-edit confirmation before saving (protocol §4). If an opened field is a slot or bus field and it is empty, the owner may choose an occupant under the slot rules, with no preselection, no suggestion and none of the candidates excluded by §4.2. Replacing an existing occupant is not offered (§4.2).

### 5.2 Suggestions

A suggestion is a starting point that the owner must actively take. The app never writes it. Rules:

1. **Atomic fields only.** A suggestion MUST NOT contain resource-field values, scope selections, slot occupants or bus choices. Those would let an app nominate where data goes. The provider rejects such suggestions at entry creation.
2. **Within target.** Every suggested field is in `target.fields` (or the granted field set when `fields` is absent) and validates against the pinned schema.
3. **No grant effects.** A suggestion cannot add fields to a grant, widen methods, approve consumers or change who receives a field. Saving a configuration is a values change only. Grant consequences, if any, follow the ordinary rules: changes to atomic values propagate to apps already approved for those fields, as protocol §4 already discloses.
4. **Active acceptance.** No suggested value is applied unless the owner affirmatively takes it. The provider MUST show the current value beside each suggested one. It MUST NOT pre-apply suggestions to form inputs in a way that saving would commit without a per-field or explicit bulk acceptance.
5. **Sensitive fields.** These fields need an individual acceptance per field, and bulk acceptance never covers them:
   - fields marked `sensitive` (§8.2);
   - every `url`-typed field, and every string field whose `format` is `email` or `hostname`;
   - **every field that another app or provider feature currently receives.** Its row names those receivers, and saving needs the protocol §4 shared-edit confirmation. An app's suggestion would otherwise change what other apps receive.

   The provider MUST display the host of any suggested URL, email domain or hostname.
6. **Inert text.** Suggested strings are untrusted plain text: bidi-isolated, never interpreted as markup, and bounded by the schema.

### 5.3 Result

Saving changes the fragment revision. The app sees the new values through its ordinary `@preferences` read, and integrations also through `preferences-updated` (integrations §6.3). **The preferences read is authoritative.** The front-channel result of §6.2 is only a hint.

## 6. Outcomes

### 6.1 `grant-more`: per-fragment outcomes

The token response carries `fragment_outcomes` (AMD-C5), extended with `partial` and a `granted` member (AMD-C19):

```json
"fragment_outcomes": [
  {"fragment": "https://cal.example/preferences/calendars/v1", "outcome": "partial",
   "granted": {"fields": ["calendar"],
               "methods": {"calendar": {"https://spec.bindle.example/contracts/calendar/v1": ["readEvents"]}}}},
  {"fragment": "https://tasks.example/buses/task-changes/v1", "outcome": "declined"}
]
```

| `outcome` | Meaning | What the app may rely on |
| --- | --- | --- |
| `granted` | Everything requested is now held, whether newly approved or already allowed. | `granted` lists the complete current grant on that fragment. |
| `partial` | Some requested delta items were approved, and some were not. | `granted` lists the complete current grant. The app compares it with its request. |
| `declined` | No delta item was approved: the owner declined or cancelled, the request was suppressed, or setup was abandoned. | Its grant on that fragment is exactly what it was before. |
| `unsupported` | The provider cannot process this request at all, for example an unrecognized bus or slot. This follows only from public facts (extensions §5.2). | Do not retry without a change. |
| `unavailable` | It cannot be satisfied at this provider for anyone (extensions §5.2). | Do not retry without a change. |

- A missing entry means `declined`.
- `granted` always describes the **current complete grant** on that fragment, not just the delta, so the app needs no merge logic.
- The resource identifiers inside are the provider's opaque scoped ids from the preferences projection. The app still reads values through `@preferences`.

### 6.2 `configure`: result

`configure` produces no code. The provider redirects, or delivers to the island, with exactly `result`, `state` and `iss`, the same way `end-session` returns:

| `result` | Meaning |
| --- | --- |
| `configured` | The owner saved a change to at least one opened field. |
| `unchanged` | No opened field changed: the owner left, saved identical values, declined every suggestion, or the request was suppressed. |

There is no `declined` value for `configure`. Because the result is unauthenticated front-channel data, an app MUST read `@preferences` and compare `revision` before acting. It MUST NOT treat `configured` as proof that a particular value was chosen.

### 6.3 Summary of app-visible results

| Request | Possible results |
| --- | --- |
| `grant-more` | Per fragment: `granted`, `partial`, `declined`, `unsupported`, `unavailable`. Entry creation may fail with `invalid_request` or `rate_limited`. |
| `configure` | `configured` or `unchanged`. Entry creation may fail with `invalid_request` or `rate_limited`. |

### 6.4 App obligations (non-normative guidance for SDKs)

- Treat `partial` as "you have exactly `granted`", and degrade the feature gracefully.
- Never retry automatically after `declined` or `rate_limited`. Honour `Retry-After`, and offer the owner the `owner_review_uri` if one is present.
- Explain in the app's own UI before asking, and offer an in-app "Not now" that sends no request. Never ask on page load without a user action.
- After `configure`, read `@preferences` before acting.
- On `forbidden` for a resource or bus read, show a reconnect or "ask again" control. Do not loop.

SDK helpers (IA-3) return a per-method `{granted, missing}` view, `retryAfter` and, after `configure`, a fresh preferences read.

## 7. Presentation paths

### 7.1 Redirect and popup

These are the existing presentations. The app creates the entry with its own credentials (the authorization-entry wire), then navigates top-level, or opens a popup, to `authorization_endpoint?entry=<id>`. The decision always happens in a top-level provider document that cannot be framed (auth, 3sln.me policy).

### 7.2 Islands: the `request` part (components profile)

The components profile gains an interactive part, `request` (version 1; AMD-C20). It is a provider-labelled control that starts a `grant-more` or `configure` flow from inside the app's page. It does not navigate the app away, and the app never sees the provider's UI.

| Aspect | Rule |
| --- | --- |
| `props` | `{kind: 'grant-more'\|'configure', label: 'review-access'\|'review-settings', variant: 'filled'\|'outline'}`. These are enums only, rendered from the provider catalogue. The visible text never comes from the embedder. |
| Inbound | `prepare-request`: `v`, `intent` (MUST equal `props.kind`), `redirectUri`, `state`, `challenge` (`grant-more` only), `requests` or `target` with `suggestion`, optional `reason`, `uiLocales`, `colorScheme`, `dpopJkt`. The bounds are those of §3, within the profile's 8 KiB message cap. Stored and never rendered in the island. Last value wins. |
| Activation | Only a trusted activation of the island's own control, armed under [embed islands §13.4](../architecture/embed-islands.md#134-clickjacking-on-interactive-islands), starts a flow. No inbound message starts a flow. The island opens the popup within the activation and then creates the entry, with `subjectConstraint` set to the subject from the latest `session` message. If the popup is blocked, no entry is created, and the island reports `flow ended popup-blocked`. The element MAY then fall back to the redirect path (§7.1) with the app's own entry. Without a `session` subject, the control renders a disabled state identical for every account state. |
| Approval | Always in the provider's top-level popup under `key-binding.v1` popup attestation, with its own arming (profile §8). It never happens inside the island. |
| Outbound | `flow` (`started`, then `ended` with `completed`, `canceled`, `popup-blocked` or `unavailable`), and for `grant-more` a `code` message. These are the same types and rules as the `sign-in` part. `completed` means the owner made a decision, possibly a decline. For `configure`, `completed` carries no result, and the app MUST read `@preferences` to learn whether anything changed. `canceled` means the window closed without a decision. |
| Entitlement invariant | The island MUST render identically, size identically, and send identical messages whether or not the request is suppressed, cooling down or already granted. Every such state is resolved only in the provider popup (§9.3). |
| Unreviewed clients | Not available, because the embed shell serves reviewed clients only (federation-implementation). Such apps use §7.1. |

## 8. Describable effects and risk interop

Consent describes in human terms what each grant lets an app do. Effect descriptions come from three sources, each with a different trust level. The host design renders them; this section fixes the machine-readable inputs.

| Source | Carries | Trust |
| --- | --- | --- |
| The provider's own catalogue | Text for contracts and methods the provider has **reviewed**, for example its built-in storage, profile and event-bus contracts | Provider text. The only source that may be shown as reviewed by the provider. |
| The contract or bus manifest publisher | `x-methods` `summary` and categories (§8.1), bus `effects` ([events §2.1](events.md#21-the-slotbus-member)), fragment and field `title` and `description` | Attributed to the publisher's host. Never shown as provider-verified. |
| The app | `purpose` per request and `reason` per entry | The app's claim, always labelled as such and placed after the effect text |

**The app never writes effect text.** An app that is also the publisher of the contract it requests is still shown as the publisher, and the host flags that the description was written by the requesting app's own site (same registrable domain).

### 8.1 Contract method metadata (AMD-C16)

Extending AMD-C10, each `x-methods` entry MAY carry:

- `effect`: `read`, `pure`, `write` (creates or changes state, or causes external effects that can be undone) or `destructive` (deletes, or causes effects that cannot be undone). A missing or unknown `effect` MUST be treated as `write` for risk purposes, never as `read` or `pure`.
- `summary`: a map from BCP 47 tag to plain text of at most 160 code points, at most 8 tags, MUST include `en`. It is a one-line description of what the method lets a caller do, written in the second person about the owner's data ("See your calendar events").
- `categories`: a subset of the §8.3 categories.

These members are pinned with the contract digest. They only **add** information. They never relax authorization, failover rules or introspection.

### 8.2 Fragment field metadata (AMD-C17)

A fragment field MAY carry `sensitive: true`. Such a field requires individual acceptance of suggestions (§5.2) and is displayed with its exact value before saving. Every `url`-typed field is sensitive whether marked or not. Field `title` and `description` remain untrusted plain text.

### 8.3 Sensitivity categories

| Category | Meaning |
| --- | --- |
| `personal-data` | Exposes personal information about the owner or other people |
| `send-as-you` | Sends or publishes content that others will see as coming from the owner |
| `money` | Spends, moves or commits money or paid resources |
| `identity` | Affects sign-in, credentials, keys, recovery or account identity |
| `public` | Makes something publicly visible |
| `location` | Exposes physical location |

Categories can only **raise** the presented risk tier. A publisher cannot lower a tier by omitting a category, because the host also derives a tier from `effect`, and its own review can assign categories to reviewed contracts. Unknown category values are ignored for display but MUST NOT lower risk.

## 9. Suppression

### 9.1 Scopes

When declining, or later from the access views, the owner may stop future requests. A suppression record is keyed by entity, app principal (the issuer-qualified client id, not the connection incarnation, so reconnecting does not clear it), and a scope:

| Scope | Suppresses |
| --- | --- |
| `app` | Every `grant-more` and `configure` from this app |
| `kind` | Every `grant-more`, or every `configure`, from this app |
| `fragment` | Requests of either kind, or one chosen kind, naming this fragment or bus manifest (matching below) |
| `field` | `configure` requests whose `target` includes this field of this fragment |

**App identity.** "This app" means the client id **and** every client id on the same verified registrable domain, for example a developer's web and mobile clients. Sibling clients cannot escape `app` or `kind` scope.

**Fragment matching.** A `fragment` suppression matches the exact URL, any manifest reachable through a `supersedes` chain from it, and, when the fragment's host shares a registrable domain with the app, **every fragment on that host**. An app therefore cannot reset a suppression by publishing `/v2`, `/v3` and so on of its own fragments. Third-party fragments match by exact URL and `supersedes` only, because their versions are not under the app's control.

**Matching items only.** Suppression pre-declines only the matching request items, in every intent. Unrelated items in the same entry are presented normally. If every item matches, the entry shows the blocked notice (§9.3). Pre-declined items are shown collapsed, with a reveal control.

**Login on an existing connection.** Suppression also applies to the delta of any authorization by the same app on an existing connection, so re-running `login` with extra fragments does not bypass it. On an existing connection, **delta items in any intent are treated as optional**: `required` applies only to an app's first connection. An app therefore cannot use protocol §3's "declining a required fragment cancels the connection" to force the owner to lift a block.

Suppression never blocks the owner from granting or configuring from the provider's own interface.

### 9.2 Undo

Suppressions are owner data. Every one is listed, with its scope and date, in the provider's view of that app. The owner can remove any of them at any time. Removing a suppression does not re-send or replay any earlier request. Suppressions are exported with the account and deleted with it.

### 9.3 What the app learns

**Decision: the app learns only `declined` (or `unchanged`), never "suppressed".** Telling the app would disclose an owner preference that apps could use to pressure owners or route around the block through other channels. The provider makes suppression indistinguishable from an ordinary decline:

1. Entry creation behaves identically for suppressed and unsuppressed targets. No error, timing or response member differs.
2. A suppressed entry still opens a provider page, a short "you blocked this request" notice, which returns to the app only after a user action. That return control uses the **same arming delay** as decision controls, and the page enforces the same minimum dwell as a consent page, so return timing cannot be distinguished by speed. Return timing is therefore human, as it is for a decline. The owner can also reveal and answer the request from that notice, which removes the suppression.
3. A suppressed `grant-more` returns a code whose outcomes are all `declined`. A suppressed `configure` returns `unchanged`.
4. Suppressed requests advance the decline counters of §10 exactly as declines do, so the rate limits the app observes do not depend on suppression.
5. The island `request` part behaves identically (§7.2). Every decision, including a decline or a return from the notice, ends `flow` with `completed`, followed by `code` for `grant-more`. `canceled` is used only when a window closed without any decision.

This tradeoff has a residual. A suppressed request costs the owner one click each time the app is allowed to ask again. The §10 ladder bounds that to at most three notices per target in the first 38 days and one a month after that, and the per-app caps bound the total. A host MAY offer to escalate repeated fragment-scope suppressions to `app` scope.

## 10. Rate limits

Providers MUST bound incremental requests per (entity, app), where the app is identified as in §9.1. Two kinds of counter apply:

- **Caps** count every entry created with these intents, and every delta-bearing authorization on an existing connection, whatever happens to it.
- **The decline ladder** counts only decisions the owner saw and made: a decline, a suppression-notice return, or a "Just this time" choice. Expiry, supersession, an entry whose page never rendered (for example a blocked popup), and a window closed before the decision controls armed advance **only the caps**. An owner who was interrupted is never put into a cooldown.

Reference values (3sln.me policy, provisional):

| Limit | Value |
| --- | --- |
| Per app, both kinds | 3 per hour, 6 per day, 20 per 30 days |
| Cooldown after a decline, for the same (app, kind, fragment), or the same (app, configure, field) for field targets | 24 hours after the 1st decline, 7 days after the 2nd, 30 days after the 3rd and each later one. The counter resets after 90 days without a decline, or when the owner grants or configures that target themselves. |
| Requests per entry | `grant-more` at most 4 fragments. `configure` exactly 1 fragment and at most 8 fields. |
| Open entries | At most 1 open incremental entry per app and account. Creating a new one supersedes the old, which then returns `declined` or `unchanged` (no ladder step). |

Requests over a limit fail at entry creation with `rate_limited`, `Retry-After`, and an optional `owner_review_uri`. That is the provider's page for this app in its access views, where the owner can review and allow the request themselves. It is the same link for every app and state, so it reveals nothing. Every input to these limits is an outcome the app itself observed, so `rate_limited` reveals nothing new. Approved requests do not start a cooldown.

**Superseded entries.** When a newer entry supersedes an open one, the old page disarms its controls and never loads the newer entry in place, which closes off bait-and-switch. A suppression the owner chose on the old page is still recorded.

**Freshness.** Host policy MAY require a recent step-up before approving delta items in the higher risk tiers (identity, money, destructive). If it does, the step-up happens inline in the provider page ([linked approval](../architecture/linked-approval.md) step-up). It never changes the outcome vocabulary.

## 11. Fallbacks without support

| Provider declares | App behaviour |
| --- | --- |
| No `grant-more` intent but `authorization-entry.v1` | Run `login` (or `select-account`) with the full request set, existing plus new. The provider shows existing grants as already approved, and the outcomes are AMD-C5. Suppression and limits apply to the delta on providers that implement §9 and §10. |
| No `authorization-entry.v1` | Run the floor authorization request flow with the full set. |
| No `configure` intent | Link the owner to the provider's settings, if the app knows the URL, or tell the owner in the app's own words. There is no wire fallback. |

## 12. Security requirements

1. **Provider-rendered.** Every incremental decision, setup, suggestion review and suppression notice is rendered by the provider in a top-level document with `frame-ancestors 'none'` and delay-to-arm controls. Apps and embedders can style nothing in it.
2. **No authority from requests.** Entry members, `reason`, `purpose` and `suggestion` confer nothing. Grants change only through the owner's decision, and values only through the owner's save.
3. **Subject binding.** `subjectConstraint` is required, so an app cannot obtain a grant for an account other than the one it is connected as.
4. **Delta honesty.** The provider computes the delta itself. A request cannot present new access as already allowed.
5. **No suggestion-to-grant path.** §5.2 rules 1–3. `configure` never changes grants, and `grant-more` takes no suggestions.
6. **No self-nomination.** §4.2: an app's own origin is never offered as an occupant inside its own flow.
7. **No token without added access.** §4.4.
8. **Uniform failure.** Suppression, cooldown and grant state do not change the response shape, timing class or island rendering, beyond what §9.3 and §10 define.
9. **Bounded inputs.** Every member is bounded before storage. Text members are inert plain text.
10. **Audit.** The provider records, as owner-visible metadata without values, each incremental entry: time, app, kind, fragments, outcome, and whether it was suppressed.

## 13. Amendments — proposed (unsigned)

| ID | Document | Amendment |
| --- | --- | --- |
| AMD-C16 | contracts `x-methods` | `effect` gains `write` and `destructive`. Add `summary` and `categories` (§8.1). Missing effect means `write` for risk display. |
| AMD-C17 | protocol §3 | Optional field member `sensitive` (§8.2). |
| AMD-C18 | protocol §2 feature table | `authorization-entry.v1` `intents` may include `grant-more` and `configure`, with the §3 entry members. |
| AMD-C19 | wire profile (AMD-C5); auth | `fragment_outcomes` gains `partial` and a `granted` member holding the complete current grant (§6.1). An incremental exchange that adds no access returns outcomes without tokens, and new sessions never outlive the newest existing session (§4.4). On an existing connection, delta items are optional in every intent (§9.1). |
| AMD-C20 | components profile v1 | Add part `request` (version 1) (§7.2) and inbound type `prepare-request`. |

## 14. Conformance tests

- **Entry validation:** every §3 member rule; `required: true` refused in `grant-more`; a `target` outside the grant refused; suggestions with resource values, foreign fields or schema violations refused.
- **Delta:** already-allowed items not asked; a no-delta request completing with every outcome `granted`; a new fragment version treated as new access; existing access never reduced.
- **Inline setup:** an unconfigured fragment configured before the decision; the exclusive-occupant replacement prohibition; shared-edit confirmation.
- **Outcomes:** each `fragment_outcomes` value; `granted` always the full current grant; a missing entry meaning `declined`; decline identical to a suppression return; no tokens when no access is added; new sessions bounded by the newest existing session.
- **`configure`:** `configured` and `unchanged`; no grant change in any path; per-field acceptance for sensitive and URL fields; bulk acceptance never covering them.
- **Suppression:** every scope; sibling client ids; own-host version churn and `supersedes` chains; required-delta coercion closed; matching-items-only pre-decline; login-delta bypass closed; indistinguishability (entry creation, outcome, timing class, island rendering and messages); undo; export and deletion.
- **Limits:** every §10 value; suppressed requests advancing counters identically; expiry, supersession and blocked popups advancing caps only; superseded pages disarming.
- **Self-nomination:** same-domain occupant candidates omitted; no occupant replacement in incremental flows; no resource created before Allow.
- **Islands:** no flow without trusted activation; `prepare-request` never rendered; identical behaviour across suppressed, cooling and granted states; popup attestation.

## 15. Implementation notes and deviations (IA-1/IA-2, provisional, 2026-10-20)

Status: implemented locally behind the default-off `INCREMENTAL_AUTH_ENABLED` flag (the name the consent experience and CX-1 already use). **Unmounted in every deployment** until the integration pass below lands, and not production-verified. Human sign-off: reviewer ___ / date ___ / outcome ___.

Code: `packages/federation/incremental.mjs` (IA-1 engine operations over the `incremental` provider), `packages/federation/suppression.mjs` (IA-2 records, caps and ladder), the intent hunks of `packages/federation/authorization-entries.mjs`, `packages/runtime/incremental-authorization.mjs` (runner and token-endpoint branch) and `packages/runtime/routes/incremental.mjs` (owner suppression routes). Tests: `tests/incremental-authorization*.test.mjs`. Security review: [events and consent review, "IA implementation"](../release/events-consent-review.md#ia-implementation).

### 15.1 Provider-page contract (3sln.me host; CX-2 builds against this)

The entry routes are unchanged. For the new intents:

- **`POST …/select`** answers `{requestId, incremental: view}`, or `{requestId, completed: {redirectUri}}` when nothing is new (§4.1) or no opened field is still granted. A superseded entry answers `{requestId, incremental: {superseded: true}}`.
- **`grant-more` view:** `{intent, client, reason?, blocked, armAt, offerAppScope, requests: [{fragment, digest, purpose, alreadyAllowed: {fields, methods, resources?}, delta: {fields, methods}, suppressed, setup: [{field, type, candidates?}], ownSite} | {fragment, purpose, status: 'unsupported'|'unavailable'}]}`. `blocked` means every delta-bearing request is suppressed (show the §9.3 notice). `armAt` is the server's earliest decision time. `offerAppScope` is the CX §6.4 "3 declines in 7 days" signal. `candidates` are already filtered under §4.2.
- **`configure` view:** `{intent, client, reason?, blocked, armAt, offerAppScope, fragment, digest, ownSite, revision, fields: [{name, type, current, suggested?, suggestedHost?, sensitive, sensitivity: ['marked'|'url'|'email'|'hostname'|'shared'], receivers, suppressed, occupant?: {candidates} | 'settings'}]}`. A suppressed field carries no suggestion.
- **`POST …/decision`** takes `nonce` and exactly one of the following:
  - `grant-more` Allow: `{approved: [{fragment, fields?, methods?, resources?}], setup?: [{fragment, values, sharedAcknowledged?}], reveal?: true}`;
  - `configure` Save: `{changes: [{field, take: 'suggested', via: 'field'|'bulk'} | {field, value}], sharedAcknowledged?, reveal?: true}`;
  - Decline: `{denied: true, suppress?}`;
  - Blocked-notice return: `{notice: 'return', suppress?}`.

  `suppress` is `{scope: 'app'} | {scope: 'kind', kind} | {scope: 'fragment', fragment, kind?} | {scope: 'field', fragment, field}`, limited to this entry's intent, fragments and fields. Every decision answers `{redirectUri}`: `code`, `state` and `iss` for `grant-more`, or exactly `result`, `state` and `iss` for `configure`. An identical retry after completion returns the stored answer; a different one is refused.
- **Provider-page-only errors:**
  - `decision_not_armed`: a decision before `armAt`, including the notice's return;
  - `decision_in_progress`;
  - `individual_acceptance_required`: bulk acceptance of a sensitive field;
  - `shared_confirmation_required`;
  - `replace_in_settings`: an occupant is already set;
  - `account_mismatch`;
  - `invalid_args`: approvals outside the request, a suppressed item without `reveal`, or `approved` on `configure`.

### 15.2 Deviations from §1–§14 (provisional; need sign-off)

1. **Inline setup is part of the Allow decision.** Setup values are saved only when Allow commits, so abandoned setup saves nothing. This is stricter than CX §11, where saved atomic values stay. Setup never creates a resource: an empty slot field takes an existing, filtered candidate.
2. **Server-enforced dwell.** Every incremental decision, including the notice's return, is refused until 1.5 s after the page first rendered (`begin`). This adds to the page's own arming (ARM_MS 600 ms) and keeps return timing in the same class as a decline.
3. **Ladder targets.** `configure` always steps one target per opened field, and an absent `fields` means every granted field. `grant-more` targets on the app's own host share one target per host, extending the §9.1 churn rule to the ladder (SEC-7). Third-party fragments use the root of their `supersedes` chain.
4. **Sessions without a live session.** When access was added but the connection has no live session to bound the new one, the exchange returns `fragment_outcomes` only. The grant still applies at the connection level.
5. **Code replay.** A replayed incremental code revokes the session family it issued (RFC 6749 §4.1.2). Under concurrent redemption, every attempt can therefore fail.
6. **Member constraints.** `configure` also forbids `dpopJkt`. Incremental entries forbid `loginHint` and embedded delivery until IA-4 adds the island `request` part. The tier-4 refusal of unreviewed apps covers every requested method, not only the delta, and fails closed when the consent facts lack the contract.
7. **"Just this time"** (§10) has no control in this slice. The ladder counts declines and notice returns.
9. **Superseded pages (IA-R4, IA-R5).** Supersession alone steps no ladder, as §10 says. But an explicit decline or notice return made on a superseded page passes the same dwell and **does** step the ladder: the owner saw the request and decided, and an app must not erase decisions by superseding on purpose. Revealing and answering an item lifts only `fragment`/`field` suppressions for it, never `app`/`kind` ones (IA-R3). Ladder resets apply only to fully granted fragments and to configure fields whose value changed (IA-R6). Unreviewed apps are refused any method that the consent facts cannot classify (IA-R1). Approved `resources` must come from the filtered candidates, for fields that hold none yet (IA-R7). Setup fills only empty fields being approved (IA-R9).
8. **No separate flag.** The roadmap's "two new default-off flags" resolve to `EVENT_BUSES_ENABLED` and the existing `INCREMENTAL_AUTH_ENABLED`.

### 15.3 Integration status and production gates (provisional)

- **Adapter ports: implemented locally.** Node and Worker mount `INCREMENTAL_AUTHORIZATION` and pass it to the local/remote entry composition only with the flag. Grants use a live owner-shard connection, union-only commits, an idempotent decision journal and a transactional `before` snapshot; preferences retain revision checks; new sessions retain proof binding, approval ancestry and the newest session's expiry bound. Pre-owner incremental state/codes live in a separate durable `bindle-incremental-v1` store. Capacity review of that centralized store remains a production gate.
- **Token branch: implemented locally.** The runtime calls `handleIncrementalToken` before the generic exchange, with durable DPoP replay checks, browser-readable nonce challenges and metadata-client blocking.
- **`owner_review_uri`: implemented locally.** Entry 429 bodies preserve `ownerReviewUri` as `owner_review_uri` alongside `Retry-After`.
- **Login on an existing connection (§9.1): implemented locally.** The entry store's `loginDelta`/`loginOutcome` operations (IA-R2) reach the remote adapters; `grants.siteConnection({subject,site})` checks sibling clients. The legacy authorization-request path also uses the gate. The selection's `incrementalLogin: {additions, predeclined}` is provider-only data.
- **Setup recovery: open.** If a setup preference save succeeds but the grant commit fails, retrying the same decision after its decision lease currently fails with `replace_in_settings`. The committing decision needs resumable setup or a shared atomic commit contract; see the [integration handoff](../release/events-consent-review.md#wave-3b-adapter-integration-local-provisional-2026-10-20).
- **Audit.** The owner-visible audit (§12 item 10) is not implemented. Neither are account export and erasure wiring (the engine operations exist), access-view routes (CX-3) or islands (IA-4).

Flags remain off by default. Local tests and configured transports imply neither production verification nor independent approval. Reviewer ___ Date ___ Outcome ___.
