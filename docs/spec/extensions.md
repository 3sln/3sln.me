# Manifest extensions and slots — normative draft

Status: **provisional draft, 2026-10-20, revision 2.** Revision 1 was wargamed by two independent reviewers (24 security and 22 interop findings). Revision 2 answers every finding; see the [extensibility review](../release/extensibility-review.md). Rationale, rejected alternatives and migration: [extensibility design](../architecture/extensibility-design.md). Human sign-off: reviewer ___ / date ___ / outcome ___. Track the decision in [DEVLOG](../../DEVLOG.md). Nothing here is implemented or production-verified.

This document extends [protocol §2–§4](protocol.md). It defines interoperability rules only: no user interface beyond the security disclosures it lists, and no SDK behavior. Identifiers under `https://spec.bindle.example/` are placeholders, not live authorities. MUST/SHOULD/MAY express draft requirements. §12 lists the amendments this draft needs in existing core documents. Those amendments are proposed and are not yet applied there.

## 1. Model

A **slot** is a named, typed role that resources can play for an entity, defined by a public, immutable **slot manifest**. Examples: "receives public messages", "classifies incoming items", "provides a language model". A slot is resource-bearing by definition: it holds zero or more **occupants**, each an entity-owned resource implementing the slot's required contracts.

A slot is consumed by **consumers**:

- applications holding an ordinary grant; or
- the provider itself, acting through a provider feature the owner enabled.

An occupant can be hosted in three ways:

- by the provider, as a **built-in** occupant;
- by the provider's adapter gateway;
- by a third-party integration, as a [brokered resource](integrations.md#5-brokered-resources).

Three things stay separate:

| Concern | Where it lives | Who decides |
| --- | --- | --- |
| What the role means, which contracts an occupant must implement, how many occupants are allowed, and how a consumer selects among them | The slot manifest (public, immutable) | The slot publisher |
| Which parties *can* occupy or consume a slot | `extensions` declarations in provider manifests and integration manifests (public) | Each declaring party, about itself only |
| Which resources *do* occupy a slot for an entity, in what order, and which consumers may use them | The entity's preference value for the slot, plus grants (private) | The owner, through the provider |

A declaration never confers authority. Occupancy is a preference value and consumption is a grant, both governed by [protocol §3–§4](protocol.md). A slot adds no new authorization primitive.

## 2. Slot manifests

A slot manifest is a [preference fragment](protocol.md#3-fragments-and-preference-values) with one additional top-level member, `slot`. Its `id` is the slot identifier. Every fragment rule applies unchanged:

- an HTTPS identifier and immutable content at that URL;
- a canonical JSON SHA-256 digest, pinned at first approval;
- a bounded declarative schema;
- no values or secrets;
- untrusted plain-text metadata.

```json
{
  "id": "https://spec.bindle.example/slots/item-classifier/v1",
  "title": "Item classifier",
  "description": "Answers typed questions about an incoming item.",
  "publisher": "https://spec.bindle.example",
  "fields": {
    "occupants": {
      "title": "Classifiers",
      "type": "resource",
      "cardinality": {"min": 0, "max": 4},
      "contracts": ["https://spec.bindle.example/contracts/decision-model/v1"]
    }
  },
  "slot": {
    "v": 1,
    "field": "occupants",
    "selection": "ordered",
    "failover": "any-error",
    "consumers": ["application", "provider"],
    "options": {
      "occupant": {"label": {"type": "string", "maxLength": 64}},
      "consumer": {}
    }
  }
}
```

### 2.1 The `slot` member

| Member | Required | Meaning |
| --- | --- | --- |
| `v` | yes | Slot member version. This draft defines `1`. |
| `crit` | no | Names of `slot` members that a processor MUST understand. A processor that does not understand a listed member treats the slot as unrecognized (§2.2). Unlisted unknown members are ignored. |
| `field` | yes | Name of the single `resource`-typed field in `fields` that holds occupants. Its `contracts` (AND, exact URLs) are the occupant requirement, and its `cardinality.max` is the occupancy bound. `cardinality.min` MUST be `0`. |
| `selection` | yes | One of the four policies in §3. |
| `failover` | only for `ordered` | `pre-dispatch` (default) or `any-error` (§3.3). |
| `consumers` | yes | Nonempty subset of `application` (apps may request grants on this slot) and `provider` (provider features may consume it). |
| `options` | no | Declarative schemas, in the fragment field subset and possibly empty, for the `options` object of `occupant` and `consumer` declarations (§4). Absent: declarations carry no options. |
| `supersedes` | no | Absent or `null`, or the identifier of an earlier slot on the **same origin** that this one replaces. Informational only (§7). |

A slot manifest MUST contain exactly one `resource` field, the one named by `field`. It MAY contain additional atomic fields. These are slot-wide owner settings shared by every consumer under ordinary fragment rules, and SHOULD relate to the role. The serialized document is at most 16 KiB.

A slot carries no endpoint, credential, executable content or authorization rule. A role that needs no resource describes what a *provider implements*, so it is not a slot. Define it instead as a [`features`](protocol.md#2-discovery-and-login) entry (Bindle-defined) or a [`profiles`](protocol.md#2-discovery-and-login) entry (third-party).

### 2.2 Validation and unrecognized slots

A slot member is **valid** only if all of the following hold:

- `field` names a `resource` field with `cardinality.min` 0 and `cardinality.max` between 1 and 8;
- `selection` is known;
- `exclusive` has `max` 1, and every other policy has `max` of at least 2;
- `failover` appears only with `ordered`;
- `any-error` satisfies §3.3;
- `consumers` is a nonempty subset of the two known values;
- the `options` schemas are valid;
- `supersedes`, if non-null, is an HTTPS URL on the origin of `id` and differs from `id`.

A slot member is **unrecognized** when `v` is unknown or a `crit` member is not understood.

A provider declaring `extensions.v1` handles an unrecognized or invalid slot member by processing the document as an **ordinary fragment without slot semantics**:

- no built-in occupants;
- no provider consumers;
- no declaration-driven candidates;
- an "unrecognized role" disclosure next to the fragment.

A provider *not* declaring `extensions.v1` processes every slot fragment as an ordinary fragment, ignoring `slot` (this depends on core amendment C1, §12). In both cases the requesting application still applies the slot policy itself, so its behavior does not depend on the provider's support. A provider MUST NOT apply part of the slot semantics.

A provider declaring `extensions.v1` MUST refuse an application's request for a recognized slot whose `consumers` excludes `application`. Providers without support cannot enforce this. The residual risk is noted in §8.

An invalid or unsupported **optional** slot request is reported `unsupported` for that fragment only, and the rest of the authorization continues. A required one fails authorization with `unsupported_fragment`.

## 3. Selection policy

**The slot manifest fixes the selection policy. The owner chooses which resources occupy the slot and their order. The consumer applies the policy mechanically.** A consumer chooses among occupants only when the policy is `consumer-choice`.

The slot decides because the policy is part of what the role means. If one consumer delivered a public message to every occupant while another delivered it to one, the same owner configuration would produce duplicated or lost effects depending on the consumer, and occupants could not know whether they are the sole handler. The owner decides membership and order because only the owner knows which installed apps they trust for the role.

The preference value of the slot field is an ordered list of occupants. The order is the owner's priority. It is significant for `ordered`, and presentation only for the other policies.

| Policy | Cardinality | Consumer behavior |
| --- | --- | --- |
| `exclusive` | max 1 | Invoke the single occupant. With no occupant, the role is unfilled. |
| `ordered` | max 2–8 | Invoke the first available occupant in owner order. Advance to the next only as `failover` permits (§3.3). |
| `broadcast` | max 2–8 | Invoke every available occupant independently. Report outcomes per occupant (succeeded, failed, unknown) to whoever initiated the operation. Partial success is never reported as complete. |
| `consumer-choice` | max 2–8 | Invoke one available occupant chosen by the consumer's own criteria, for example capability or cost. The slot manifest SHOULD document the intended criteria. Invoking more than one occupant for the same operation, or switching after an ambiguous outcome, is allowed only under the harmlessness condition of §3.3. |

### 3.1 Availability and representation

An occupant is **available** to a consumer only under all of these conditions:

- it appears in that consumer's current preferences projection with `status: "available"`, as specified in the [integrations §5.1](integrations.md#51-preferences-projection) projection rule, which applies to all resource fields;
- its credential is current;
- for provider consumers, the feature enablement is live.

The projection lists approved occupants in owner order and omits occupants the consumer has not been approved for. Their presence is signalled only by the field name in `requiresConsent`. Adding an unapproved occupant MUST NOT withhold already approved occupants (core amendment C3). A consumer MUST NOT invoke a resource obtained from any other source as if it were an occupant.

A slot field is **configured** when it holds at least one approved occupant. An empty `exclusive` slot is represented by the field's absence. An empty multi-occupant slot is `[]`.

### 3.2 Operation snapshot

A consumer reads the occupant set and order once per operation. Later additions and reorders apply to later operations. A removal stops dispatch to that occupant for pending operations from the moment the consumer observes it. Every switch to a different occupant uses a fresh `tx`. Journals are per resource server, and two issuer-hosted occupants would otherwise collide on (`entity`, `client_id`, `tx`).

### 3.3 Failover for `ordered`

With `failover: "pre-dispatch"`, a consumer advances to the next occupant only after a failure that proves no effect occurred:

- the occupant was unavailable before dispatch (§3.1);
- the connection failed before any request bytes were sent;
- the response was HTTP 401, 403, 404 or 429, or an error envelope with `unsupported_contract`, `unsupported_method`, `forbidden`, `not_found`, `rate_limited` or `temporarily_unavailable`. Core amendment C4 makes these codes no-effect guarantees.

Status codes are claims by the occupant. A dishonest occupant can act and then report a no-effect status. Roles that need at-most-once effects across occupants MUST use `exclusive`.

After a timeout following the send, a 5xx response, `indeterminate`, or any other ambiguous outcome, the consumer MUST NOT invoke a different occupant for that operation. It either retries the same occupant with the same `tx` (protocol §5) or reports the outcome as unknown.

If an occupant with an outstanding ambiguous outcome is removed or replaced, the consumer MUST report that outcome as unknown to the owner. It MUST NOT dispatch the operation to another occupant.

`failover: "any-error"` permits advancing after any failure. A slot is valid with `any-error` only if every method of every required contract is declared `"effect": "read"` or `"effect": "pure"` in that contract's pinned `x-methods` definition. Validators MUST check this against the pinned contracts. A slot publisher's assertion alone is insufficient.

### 3.4 Policy is not authority

Selection never widens a grant. A consumer approved for occupant A gains nothing when the owner adds occupant B. B is omitted from that consumer's projection, and the field appears in `requiresConsent`, until the owner approves that consumer for B.

When the owner adds or replaces an occupant, the provider MUST present each affected consumer separately, with no consumer preselected. It shows the current occupant's origin next to the new one. One save may record the owner's per-consumer choices. Unchecked consumers stay unapproved for the new occupant. This refines the [shared-field review](../architecture/resource-scoping.md#shared-field-configuration-and-consumer-tokens): it approves only the consumers the owner explicitly selected.

Replacing the occupant of an `exclusive` slot that has an enabled provider consumer requires recent owner authentication. It MUST NOT be offered inside an authorization flow initiated by an integration.

## 4. Extension declarations

### 4.1 The `extensions` array

A provider manifest ([protocol §2](protocol.md#2-discovery-and-login)) and an [integration manifest](integrations.md#2-integration-manifest) MAY contain an `extensions` array. Each entry is an object:

```json
"extensions": [
  {"slot": "https://spec.bindle.example/slots/item-classifier/v1", "digest": "sha256-…", "role": "occupant", "ref": "classifier", "options": {"label": "Host classifier"}},
  {"slot": "https://spec.bindle.example/slots/public-message-intake/v1", "role": "consumer", "ref": "email-bridge", "purpose": "Delivers email sent to your public address."}
]
```

| Member | Required | Meaning |
| --- | --- | --- |
| `slot` | yes | Slot identifier: an absolute HTTPS URL of at most 256 characters, with no userinfo, query or fragment. |
| `digest` | no | `sha256-` followed by the base64url canonical JSON digest of the slot manifest the declaring party implements. A fetched document with a different digest makes the entry invalid. |
| `role` | yes | `occupant` (the declaring party can supply occupants) or `consumer` (it can use occupants). |
| `ref` | yes | A key local to the declaring party, matching `^[a-z][a-z0-9-]{0,31}$` and unique per (`slot`, `role`) within the array. It distinguishes several entries for one slot. |
| `purpose` | consumer only | Plain-text purpose of at most 200 characters, shown as unverified text. |
| `required` | consumer only, integration manifests only | Boolean, default `false`. Whether the integration requires this slot to function (§6). |
| `options` | no | Object validated against the slot manifest's `options.occupant` or `options.consumer` schema once that manifest is known. Invalid options make the entry invalid. |

An array is used, rather than a map keyed by slot URL, for two reasons. One manifest may hold several entries for one slot: two built-in occupants, or an occupant and a consumer. And different parties declare the same slot independently. No entry from one party is ever merged with an entry from another.

### 4.2 What declarations mean

| Declared in | `occupant` means | `consumer` means |
| --- | --- | --- |
| Provider manifest | The provider offers a **built-in occupant** for every eligible entity. `ref` identifies it to the provider. Its resource lives in the owner's pool like the default storage resource. It is assigned only when the owner assigns it. | A **provider feature** consumes this slot when the owner has enabled that feature. `ref` names the feature. This lets integrations tell the owner that occupying the slot has an effect at this provider. |
| Integration manifest | The integration can supply occupants. Candidates are found through its [discovery endpoint](integrations.md#4-resource-discovery), filtered by the slot's contracts. | The integration will request a grant on this slot at authorization or setup. The declaration does not replace that request. |

A provider MUST NOT declare a `consumer` entry for a slot whose `consumers` excludes `provider`. Integration `consumer` entries for slots whose `consumers` excludes `application` are ignored.

When a provider removes a declaration, existing state degrades visibly and never disappears silently:

- **Removing a built-in occupant declaration** makes that resource `unavailable`. It stays assigned until the owner removes it.
- **Removing a provider consumer declaration** disables the feature, notifies the owner, and revokes the feature's credentials ([integrations §7.1](integrations.md#71-operations)).

### 4.3 Processing and bounds

`extensions` holds at most 32 entries, each at most 2 KiB serialized, with at most 4 entries per `slot` value. The containing document's own bound also applies: 64 KiB for a provider manifest and 8 KiB for the integration member. Processing follows the protocol §2 declaration rules:

- unknown members are ignored;
- an invalid entry is ignored without invalidating the manifest;
- duplicate (`slot`, `role`, `ref`) triples invalidate every entry in that duplicate set;
- values from one issuer's manifest apply only to that issuer;
- a declaration is a claim, not proof;
- a declaration observed to be unimplemented is treated as absent for the session, and that downgrade is never persisted.

Declaration syntax is validated locally. A slot manifest is fetched lazily, only when a party acts on a declaration (presenting candidates, enabling a feature, validating a request). An entry whose slot manifest has not been fetched is **unknown**, not invalid. Fetches use the fragment rules: HTTPS, bounded size and time, no cookies or redirects, server-side SSRF screening. They run under per-issuer and global budgets. Slot publishers MUST allow public CORS reads.

A provider pins a slot manifest **once per URL for the whole provider**, at the first approval or enablement that uses it. Later approvals, enablements and fragment requests carrying a `digest` (core amendment C2) MUST match the pin. A changed document at a pinned URL is a publication fault, handled under §7.

## 5. Occupancy, consumption and consent

### 5.1 Assigning occupants

Only the owner, through the provider's authenticated owner interface, assigns occupants. This is ordinary preference configuration of the slot field. An integration's `occupant` declaration, a discovery result or an application suggestion is a candidate, never an assignment. A provider:

- MUST NOT assign a built-in occupant without an owner action;
- MUST NOT preselect any candidate;
- MUST order candidates neutrally, for example by name, without favoring built-ins;
- MUST NOT let an application or integration assign, reorder or remove occupants.

Before saving, the provider MUST disclose for the slot:

- its title and the host of its `id`. `publisher` is shown only when it is same-origin with `id`, and always as unverified;
- its selection policy, in plain language;
- each occupant's verified origin. For a brokered occupant, this is the integration origin that will receive invocations directly;
- a built-in marker on built-in occupants, which integrations cannot set or imitate. Integration-supplied labels are always shown together with the integration origin;
- every current consumer: each approved application by verified origin, and each enabled provider feature declared as a `consumer`.

Replacing or reordering occupants MUST show the affected consumers (§3.4).

### 5.2 Application consumers

An application consumes a slot by requesting the slot manifest as a fragment, SHOULD include its `digest` (core amendment C2), and requests explicit methods per occupant contract (protocol §3). Every consent, scoping and revocation rule applies. It reads occupants with `@preferences.read({fragment: <slot id>})` and invokes them under §3.

A provider MAY report an *optional* slot request as `unavailable` without presenting it, but only when that follows from public facts:

- the provider does not recognize the slot, or blocks it; or
- the slot has no possible occupant at this provider for anyone: no built-in occupant is declared, and no integration declaring an occupant for it is permitted at this provider.

Otherwise the request is presented normally. The response MUST NOT reveal whether this owner has connected integrations, or has any occupants. The wire representation is core amendment C5. Clients treat a missing status as `declined`.

### 5.3 Provider consumers

A provider feature that consumes a slot:

- MUST be declared in the provider manifest;
- MUST be enabled by an explicit owner action that discloses the slot and its current occupants;
- acts with no authority beyond the owner's current assignment.

The provider appears in the slot's consumer list (§5.1). For a brokered occupant, it obtains credentials under the ordinary minting rules, with its issuer URL as `client_id` and the declaration `ref` as `bindle.feature` ([integrations §5.3](integrations.md#53-consumer-credentials)). Each enablement has its own grant identifier. Disabling the feature, or removing the occupant, stops new invocations immediately and revokes those credentials.

A provider feature's `tx` values MUST be UUIDs. A feature that derives them deterministically (for example from an ingress fingerprint) uses UUIDv5 over (feature `ref`, contract, entity, fingerprint). That keeps features from colliding in a shared journal.

### 5.4 Built-in occupants

A built-in occupant is an ordinary resource, and its consumers are authorized like any other. Cost, data-processing location and, where relevant, model provenance are disclosed under the protocol §3 consent rules. A provider MUST NOT prefer its own built-in occupant over an owner-assigned occupant, and MUST NOT reorder occupants.

## 6. Conflict resolution

| Conflict | Resolution |
| --- | --- |
| Two integrations can occupy an `exclusive` slot | The owner chooses. A newly connected integration's declaration never displaces the current occupant. Replacement is an explicit owner action under §3.4, never offered inside an integration-initiated authorization. |
| Owner adds a ninth occupant, or a second under `exclusive` | Rejected by cardinality validation. |
| An integration declares `required: true` for a slot the owner leaves unconfigured | The integration's connection stays in `configuring` ([integrations §3](integrations.md#3-connection-lifecycle)). It is never forced into the slot. |
| Built-in and third-party occupants | Treated identically; the order is the owner's. |
| The same purpose under v1 and v2 slot identifiers | Two distinct slots (§7). No automatic merge or copy. |
| Competing slots for one role from different publishers | Distinct slots. Occupants SHOULD declare every slot they fill. There is no equivalence mechanism, because one would invite hijacking. |
| Duplicate entries in one manifest | Every duplicate is ignored (§4.3). |
| A declared `digest` disagrees with the fetched document | The declaration is invalid. The provider's pin governs its own processing. |
| Options in two parties' declarations disagree | Not a conflict: options describe only the declaring party. |
| A consumer's assumptions differ from the slot policy | The slot policy governs. A consumer that cannot implement it MUST NOT request the slot. |
| An occupant fails conformance in practice | The owner removes it. A consumer MAY report repeated contract violations to the owner. It MUST NOT remove or reorder occupants. |
| The slot field and an unrelated fragment field assign the same resource | Independent assignments. Each grant is checked separately (protocol §4). |

## 7. Versioning, change and disappearance

Slot manifests are immutable per URL. Any change to `fields` or required contracts requires a new URL. So does any change to `slot` that a v1 processor would misread. Additive `slot` members that older processors may safely ignore can stay unlisted. Members they must not ignore are listed in `crit`. A new version is a new slot: consumers request exact versions, and existing values, grants and provider-consumer enablements stay bound to the version they were approved under.

`supersedes` is a hint for discovery and migration only. A provider MAY offer the owner a one-step migration that copies occupants from the superseded slot to the new one, but only when both slots are on the same origin and an existing consumer of the old slot requests the new one. The provider MUST validate each occupant against the new slot's contracts and MUST NOT copy any grant. The result is new configuration and requires each consumer's consent.

If a slot manifest URL starts failing (404, 410, network or TLS failure), or serves changed content, the provider:

- keeps serving existing values under the pinned copy;
- keeps existing grants valid;
- MAY refuse new requests for that slot until the pinned copy validates by digest;
- MUST NOT drop existing occupancy because the publisher is unavailable.

A publisher cannot revoke or alter a slot after publication. It can only publish a successor.

A provider MAY mark a slot version deprecated or blocked under its own policy, for example after a published security issue. Blocking stops new grants and provider-consumer enablements, and reports the slot's occupants as `unavailable` to current consumers. It MUST be visible to the owner.

## 8. Interoperability without support

Providers implementing only the [conformance floor](protocol.md#2-discovery-and-login) remain fully supported. Clients MUST NOT require `extensions.v1`.

| Situation | Behavior |
| --- | --- |
| The provider lacks `extensions.v1`, and an app requests a slot fragment | With core amendment C1, the provider processes it as an ordinary fragment. The app gets an ordinary resource field, with no built-in occupants, no provider consumers and no declaration-driven candidates. The app still applies the slot policy. Without C1, a strict provider may reject the fragment; the app then treats the optional slot as unavailable. |
| The provider lacks `extensions.v1`, and an app requests a provider-only slot | Not enforceable. The app gets an ordinary field. Slot publishers SHOULD keep provider-only slots on contracts whose occupants authenticate the provider consumer (`client_id` equal to the issuer). |
| The provider lacks `brokered-resources.v1` | Only issuer-hosted occupants exist. |
| An app ignores `extensions` in a provider manifest | Nothing breaks. Declarations are informational. |
| A declaration names an unknown or unrecognized slot | Ignored (§4.3), or processed without slot semantics (§2.2). |

## 9. Trust and security requirements

1. **Declarations are claims.** Occupant declarations do not prove contract conformance. A provider displays occupant contract claims as claims by the integration's verified origin, and MUST NOT attach a trusted badge to them.
2. **Exact identifiers.** Slots, contracts and consumers match by exact URL. A look-alike slot URL is a different slot. Wherever a provider displays a slot title, it MUST display the host of the slot's `id`. A self-asserted `publisher` never substitutes for that host.
3. **No hijacking by declaration.** Declaring `occupant`, being connected, or being the most recently connected integration never places a resource in a slot (§5.1). Claim-like requests ("make me the default handler") are candidates presented to the owner, and are never offered inside the claimant's own authorization flow.
4. **Provider consumers are disclosed.** A provider feature consuming a slot is listed among the slot's consumers. Enabling it is an owner decision bound to the current occupants. Changing occupants while it is enabled requires the §3.4 review, which names the provider feature.
5. **Data flows are disclosed.** For each occupant, the provider discloses which origin receives invocations and what the slot's contracts send there.
6. **No core change by slots.** A slot cannot alter discovery, issuer rules, consent, tokens, grants or RPC semantics. A slot MUST NOT declare endpoints or require introspection. Only contracts can mark methods for introspection ([integrations §5.7](integrations.md#57-introspection)). The [component-origin envelope](auth.md#presentation-transports-and-key-binding) is available only to profiles, never to slots.
7. **Bounded processing.** All bounds in §2 and §4.3 apply before fetching. Slot manifests are fetched lazily under budgets.
8. **No occupancy oracle.** Responses visible to applications or to external parties MUST NOT vary with whether an owner's slot is occupied, except through grants the owner approved (§5.2).

## 10. Feature declaration

A provider that implements this document declares `"extensions.v1": {}` in `features`. When it is absent, clients apply §8. The provider manifest's `extensions` array is meaningful only when `extensions.v1` is declared. Otherwise clients ignore it.

## 11. Conformance tests

Tests MUST cover:

- **Validation:** each slot validation rule; unknown `v` and `crit` handled as unrecognized, without slot semantics; `any-error` rejected for contracts with non-`read`/`pure` methods; exact-URL matching, look-alike slots and spoofed `publisher`; duplicate entries; `digest` mismatch.
- **Selection:** all four policies, including the operation snapshot; fresh `tx` per occupant; `ordered` failover for each error class; no occupant switch after an ambiguous outcome or after removal of the ambiguous occupant; `consumer-choice` multi-invoke gating; per-occupant `broadcast` reporting.
- **Consent:** approved occupants still projected while another occupant awaits consent; per-consumer, non-preselected approval for occupant addition and replacement; recent-authentication gating of `exclusive` replacement with provider consumers.
- **Provider roles:** provider-consumer enablement, disclosure, disable and revocation; built-in occupants never auto-assigned or preselected; provider declaration removal.
- **Lifecycle:** slot manifest disappearance and digest change; same-origin superseded-slot migration without grant copying; blocked slots.
- **Requests and support:** `unavailable` reported only from public facts; optional versus required unsupported slot requests; provider-only slots refused for applications; a provider without `extensions.v1` processing a slot fragment as an ordinary fragment.

## 12. Required core amendments (proposed, not yet applied)

| ID | Document | Amendment |
| --- | --- | --- |
| C1 | protocol §3 | "Fragment documents MAY contain additional top-level members defined by other specifications. Providers MUST ignore unknown top-level members, which remain covered by the pinned digest, and MUST NOT display them as fields." The 3sln.me validator (`packages/federation/schema.mjs`) currently rejects them. |
| C2 | protocol §3 and wire profile | Fragment requests MAY carry `digest`. A provider rejects a request whose digest differs from its pin or fetched document. |
| C3 | contracts, preferences | Resource-field projections list approved resources in owner order, omit unapproved ones and add the field name to `requiresConsent`. An unapproved addition never withholds approved resources. The current read path withholds the whole field and must change. |
| C4 | protocol §5 | "`rate_limited`, `temporarily_unavailable`, `forbidden`, `not_found` and `unsupported_*` MUST be returned only when no effect occurred." |
| C5 | wire profile | Per-fragment request outcome in the token response and grant listing: `granted`, `declined`, `unsupported` or `unavailable`. A missing value means `declined`. |
| C6 | protocol §2 | Add `extensions` to the declaration containers and their processing rules, and `extensions.v1` to the feature table. |
