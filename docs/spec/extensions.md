# Manifest extensions and slots — normative draft

Status: **provisional draft, 2026-10-20, revision 1** (under independent review; see [extensibility review](../release/extensibility-review.md)). Rationale, rejected alternatives and migration: [extensibility design](../architecture/extensibility-design.md). Human sign-off: reviewer ___ / date ___ / outcome ___. Track the decision in [DEVLOG](../../DEVLOG.md). Nothing here is implemented or production-verified.

This document extends [protocol §2–§4](protocol.md). It defines interoperability rules only: no user interface beyond the security disclosures it lists, and no SDK behavior. Identifiers under `https://spec.bindle.example/` are placeholders, not live authorities. MUST/SHOULD/MAY express draft requirements.

## 1. Model

A **slot** is a named, typed role that resources can play for an entity, defined by a public, immutable **slot manifest**. Examples: "receives public messages", "classifies incoming items", "provides a language model". A slot is resource-bearing by definition: it holds zero or more **occupants**, each an entity-owned resource implementing the slot's required contracts.

A slot is consumed by **consumers**: applications holding an ordinary grant, or the provider itself acting through a provider feature the owner enabled. An occupant can be hosted by the provider (a **built-in** occupant), by the provider's adapter gateway, or by a third-party integration as a [brokered resource](integrations.md#5-brokered-resources).

Three things stay separate:

| Concern | Where it lives | Who decides |
| --- | --- | --- |
| What the role means, which contracts an occupant must implement, how many occupants are allowed and how a consumer selects among them | The slot manifest (public, immutable) | The slot publisher |
| Which parties *can* occupy or consume a slot | `extensions` declarations in provider manifests and integration manifests (public) | Each declaring party, about itself only |
| Which resources *do* occupy a slot for an entity, in what order, and which consumers may use them | The entity's preference value for the slot, plus grants (private) | The owner, through the provider |

A declaration never confers authority. Occupancy is a preference value and consumption is a grant, both governed by [protocol §3–§4](protocol.md). A slot adds no new authorization primitive.

## 2. Slot manifests

A slot manifest is a [preference fragment](protocol.md#3-fragments-and-preference-values) with one additional member, `slot`. Its `id` is the slot identifier. Every fragment rule applies unchanged: HTTPS identifier, immutable content at that URL, a canonical JSON SHA-256 digest pinned at first approval, a bounded declarative schema, no values or secrets, and untrusted plain-text metadata.

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
    },
    "supersedes": null
  }
}
```

### 2.1 The `slot` member

| Member | Required | Meaning |
| --- | --- | --- |
| `v` | yes | Slot member version. This draft defines `1`. |
| `field` | yes | Name of the single `resource`-typed field in `fields` that holds occupants. Its `contracts` (AND, exact URLs) are the occupant requirement; its `cardinality.max` is the occupancy bound. `cardinality.min` MUST be `0`. |
| `selection` | yes | One of the four policies in §3. |
| `failover` | only for `ordered` | `pre-dispatch` (default) or `any-error` (§3.2). |
| `consumers` | yes | Nonempty subset of `application` (apps may request grants on this slot) and `provider` (provider features may consume it). |
| `options` | no | Declarative schemas (the fragment field subset) for the `options` object of `occupant` and `consumer` declarations (§4). Absent: declarations carry no options. |
| `supersedes` | no | The identifier of an earlier slot this one replaces, or `null`. Informational only (§7). |

A slot manifest MUST contain exactly one `resource` field, the one named by `field`. It MAY contain additional atomic fields; they are slot-wide owner settings shared by every consumer under ordinary fragment rules. A slot manifest MUST NOT be both a slot and a carrier for unrelated fields; additional atomic fields MUST relate to the role. The serialized document is at most 16 KiB.

A slot carries no endpoint, credential, executable content or authorization rule. If a role needs no resource (it describes what a *provider implements*), it is not a slot: define a [`features`](protocol.md#2-discovery-and-login) entry (Bindle-defined) or a [`profiles`](protocol.md#2-discovery-and-login) entry (third-party) instead.

### 2.2 Validation

A slot member is valid only if: `v` is `1`; `field` names a `resource` field with `cardinality.min` 0 and `cardinality.max` between 1 and 8; `selection` is known; `exclusive` has `max` 1 and every other policy has `max` at least 2; `failover` appears only with `ordered`; `consumers` is a nonempty subset of the two known values; `options` schemas are valid fragment field schemas; and `supersedes`, if present, is an HTTPS URL other than `id`.

A provider declaring `extensions.v1` that receives a fragment whose `slot` member is invalid, or whose `v` is unknown, MUST reject a request for that fragment as unsupported. It MUST NOT process it as a slot with guessed semantics. A provider *not* declaring `extensions.v1` either processes the document as an ordinary fragment, ignoring `slot`, or rejects the request as unsupported. It MUST NOT apply part of the slot semantics. Ordinary-fragment processing is safe because the slot member grants nothing; §8 describes what degrades.

## 3. Selection policy

**The slot manifest fixes the selection policy. The owner chooses which resources occupy the slot and their order. The consumer applies the policy mechanically.** A consumer chooses among occupants only when the policy is `consumer-choice`.

The slot decides because the policy is part of what the role means. If one consumer delivered a public message to every occupant while another delivered it to one, the same owner configuration would produce duplicated or lost effects depending on the consumer. Occupants could not know whether they are the sole handler. The owner decides membership and order because only the owner knows which installed apps they trust for the role.

The preference value of the slot field is an ordered list of occupants. The order is the owner's priority and is significant for `ordered`. For other policies it is presentation only.

| Policy | Cardinality | Consumer behavior |
| --- | --- | --- |
| `exclusive` | max 1 | Invoke the single occupant. No occupant means the role is unfilled. |
| `ordered` | max 2–8 | Invoke the first available occupant in owner order. Advance to the next only as `failover` permits (§3.2). |
| `broadcast` | max 2–8 | Invoke every occupant independently. Each outcome is separate; partial success is reported as partial, never as complete. |
| `consumer-choice` | max 2–8 | Invoke any one or more occupants by the consumer's own criteria, for example capability or cost. The slot manifest SHOULD document the intended criteria. |

### 3.1 Availability

An occupant is **available** to a consumer when it appears in that consumer's current [preferences projection](contracts.md#preferences-v1) without `requiresConsent`, its resource is not reported `unavailable`, and its credential (if brokered) is current. A consumer MUST NOT invoke a resource it obtained from any other source as if it were an occupant.

### 3.2 Failover for `ordered`

With `failover: "pre-dispatch"`, a consumer advances to the next occupant only when the failure proves no effect occurred:

- the occupant was unavailable before dispatch (§3.1);
- the connection failed before any request bytes were sent;
- the response was HTTP 401, 403, 404 or 429, or an error envelope with `unsupported_contract`, `unsupported_method`, `forbidden`, `not_found`, `rate_limited` or `temporarily_unavailable`.

On a timeout after sending, a 5xx response, `indeterminate`, or any other ambiguous outcome, the consumer MUST NOT invoke a different occupant for that operation. It retries the same occupant with the same `tx` (protocol §5), or reports the outcome as unknown. Changing occupants would create a second effect under a new journal.

`failover: "any-error"` permits advancing after any failure. A slot manifest MAY declare it only when duplicate invocation of every occupant method is harmless by the occupant contracts' own definitions (for example pure computation). Consumers MUST still use a fresh `tx` per occupant; journals are per resource server.

### 3.3 Policy is not authority

Selection never widens a grant. A consumer approved for occupant A gains nothing when the owner adds occupant B. B appears with `requiresConsent` until the owner approves that consumer for B, which follows the existing [shared-field review](../architecture/resource-scoping.md#shared-field-configuration-and-consumer-tokens) (one reviewed owner save may approve the disclosed consumers). Under `exclusive`, replacing the occupant is a replacement under protocol §4: the consumer receives the new occupant only after that review.

## 4. Extension declarations

### 4.1 The `extensions` array

A provider manifest ([protocol §2](protocol.md#2-discovery-and-login)) and an [integration manifest](integrations.md#2-integration-manifest) MAY contain an `extensions` array. Each entry is an object:

```json
"extensions": [
  {"slot": "https://spec.bindle.example/slots/item-classifier/v1", "role": "occupant", "ref": "classifier", "options": {"label": "Host classifier"}},
  {"slot": "https://spec.bindle.example/slots/public-message-intake/v1", "role": "consumer", "ref": "email-bridge", "purpose": "Delivers email sent to your public address."}
]
```

| Member | Required | Meaning |
| --- | --- | --- |
| `slot` | yes | Slot identifier: an absolute HTTPS URL, at most 256 characters, with no userinfo, query or fragment. |
| `role` | yes | `occupant` (the declaring party can supply occupants) or `consumer` (it can use occupants). |
| `ref` | yes | Declaring-party-local key matching `^[a-z][a-z0-9-]{0,31}$`, unique per (`slot`, `role`) within the array. It distinguishes several entries for one slot. |
| `purpose` | consumer only | Plain-text purpose, at most 200 characters, shown as unverified text. |
| `required` | consumer only, integration manifests only | Boolean, default `false`. Whether the integration requires this slot to function (§6). |
| `options` | no | Object validated against the slot manifest's `options.occupant` or `options.consumer` schema. Unknown or invalid options make the entry invalid. |

An array is used, not a map keyed by slot URL, because one manifest may hold several entries for one slot (two built-in occupants, or an occupant and a consumer), and because different parties declare the same slot independently. No entry from one party is ever merged with an entry from another.

### 4.2 What declarations mean

| Declared in | `occupant` means | `consumer` means |
| --- | --- | --- |
| Provider manifest | The provider offers a **built-in occupant** for every eligible entity. `ref` identifies it to the provider. Its resource lives in the owner's pool like the default storage resource, but it is not assigned to the slot until the owner assigns it. | A **provider feature** consumes this slot when the owner has enabled that feature. `ref` names the feature. This lets integrations show the owner that occupying the slot has an effect at this provider. |
| Integration manifest | The integration can supply occupants. Candidates are found through its [discovery endpoint](integrations.md#4-resource-discovery) filtered by the slot's contracts. | The integration will request a grant on this slot at authorization or setup. The declaration does not substitute for that request. |

A provider MUST NOT declare a `consumer` entry for a slot whose `consumers` excludes `provider`. A provider MUST ignore integration `consumer` entries for slots whose `consumers` excludes `application`.

### 4.3 Processing and bounds

`extensions` holds at most 32 entries, each at most 2 KiB serialized, with at most 4 entries per `slot` value. Processing follows the protocol §2 declaration rules: unknown members are ignored; an invalid entry, or one whose slot manifest cannot be fetched, validated or recognized, is ignored without invalidating the manifest; duplicate (`slot`, `role`, `ref`) triples invalidate every entry in that duplicate set; values from one issuer's manifest apply only to that issuer; and a declaration is a claim, not proof.

A party fetching a slot manifest to process a declaration uses the fragment fetch rules (HTTPS, bounded size and time, no cookies or redirects, server-side SSRF screening) and caches the validated document by URL and digest. A digest change at a known URL is a publication fault: the new content is rejected and the previously pinned content keeps governing existing values (§7).

## 5. Occupancy, consumption and consent

### 5.1 Assigning occupants

Only the owner, through the provider's authenticated owner interface, assigns occupants. This is ordinary preference configuration of the slot field. An integration's `occupant` declaration, a discovery result or an application suggestion is a candidate, never an assignment. A provider MUST NOT assign a built-in occupant without an owner action, and MUST NOT let an application or integration assign, reorder or remove occupants.

Before saving, the provider MUST disclose, for the slot: its title and publisher (as unverified metadata), its selection policy in plain language, each occupant's verified origin (for a brokered occupant, the integration origin that will receive invocations directly), and every current consumer: each approved application by verified origin, and each enabled provider feature declared as a `consumer`. Replacing or reordering occupants MUST show the consumers affected.

### 5.2 Application consumers

An application consumes a slot by requesting the slot manifest as a fragment, with explicit methods per occupant contract (protocol §3). Every consent, scoping and revocation rule applies. It reads occupants with `@preferences.read({fragment: <slot id>})` and invokes each occupant under §3.

A provider MAY skip an *optional* slot request in the consent presentation when the entity has no occupant, no built-in occupant is declared, and no connected integration declares an `occupant` entry for that slot. It then reports the request as `unavailable`, distinct from `declined`. This prevents prompts for roles nothing can fill.

### 5.3 Provider consumers

A provider feature that consumes a slot MUST be declared in the provider manifest, MUST be enabled by an explicit owner action that discloses the slot and its current occupants, and acts with no authority beyond the owner's current assignment. The provider appears in the slot's consumer list (§5.1). For a brokered occupant it obtains its credential through the same minting rules as any consumer, with its issuer URL as `client_id` ([integrations §5.3](integrations.md#53-consumer-credentials)). Disabling the feature or removing the occupant stops new invocations immediately.

### 5.4 Built-in occupants

A built-in occupant is an ordinary resource. Its consumers are authorized like any other. Cost, data processing location and model provenance (where relevant) are disclosed under protocol §3 consent rules. A provider MUST NOT prefer its own built-in occupant over an owner-assigned occupant, nor reorder occupants.

## 6. Conflict resolution

| Conflict | Resolution |
| --- | --- |
| Two integrations can occupy an `exclusive` slot | The owner chooses. A newly connected integration's declaration never displaces the current occupant. The provider MAY offer an explicit replacement, which is an owner save (§3.3). |
| Owner adds a ninth occupant, or a second under `exclusive` | Rejected by cardinality validation. |
| An integration declares `required: true` for a slot the owner leaves empty | The integration's connection stays in the setup state ([integrations §3](integrations.md#3-connection-lifecycle)); it is never forced into the slot. |
| Built-in and third-party occupants | Treated identically; order is the owner's. |
| The same purpose under v1 and v2 slot identifiers | Two distinct slots (§7). No automatic merge or copy. |
| Duplicate entries in one manifest | Every duplicate is ignored (§4.3). |
| Options in two parties' declarations disagree | Not a conflict: options describe only the declaring party. |
| A consumer's assumptions differ from the slot policy | The slot policy governs; a consumer that cannot implement it MUST NOT request the slot. |
| An occupant fails conformance in practice | The owner removes it. A consumer MAY report repeated contract violations to the owner; it MUST NOT remove or reorder occupants itself. |
| Slot field and an unrelated fragment field assign the same resource | Independent assignments; each grant is checked separately (protocol §4). |

## 7. Versioning, change and disappearance

Slot manifests are immutable per URL. Any change to `slot`, `fields` or required contracts requires a new URL. A new version is a new slot: consumers request exact versions, and existing values, grants and provider-consumer enablements stay bound to the version they were approved under.

`supersedes` is a hint for discovery and migration only. A provider MAY offer the owner a one-step migration that copies occupants from the superseded slot to the new one. It MUST validate each occupant against the new slot's contracts, MUST NOT copy any grant, and treats the result as new configuration requiring consent from each consumer of the new slot.

If a slot manifest URL starts failing (404, 410, network or TLS failure) or serves changed content, a provider keeps serving existing values under the pinned copy, keeps existing grants valid, and MAY refuse new requests for that slot until the pinned copy can be validated by digest. A provider MUST NOT drop existing occupancy because the publisher is unavailable. A publisher cannot revoke or alter a slot after publication; it can only publish a successor.

A provider MAY mark a slot version deprecated or blocked by its own policy (for example after a published security issue). Blocking stops new grants and provider-consumer enablements, reports the slot `unavailable` to current consumers, and MUST be visible to the owner.

## 8. Interoperability without support

Providers implementing only the [conformance floor](protocol.md#2-discovery-and-login) remain fully supported. Clients MUST NOT require `extensions.v1`.

| Situation | Behavior |
| --- | --- |
| Provider lacks `extensions.v1`; app requests a slot fragment | The provider treats it as an ordinary fragment or rejects it as unsupported (§2.2). The app gets an ordinary resource field: no selection guarantees from the provider, no built-in occupants, no provider consumers, no candidate filtering by declaration. The app still applies the slot policy itself. |
| Provider lacks `brokered-resources.v1` | Only issuer-hosted occupants exist. |
| App ignores `extensions` in a provider manifest | Nothing breaks; declarations are informational. |
| Unknown slot in a declaration | Ignored (§4.3). |
| Integration declares an occupant for a slot the provider does not recognize | Ignored for presentation. If the owner assigns a discovered resource to that slot through an app's fragment request, the ordinary fragment rules still apply. |

## 9. Trust and security requirements

1. **Declarations are claims.** Occupant declarations do not prove contract conformance. A provider displays occupant contract claims as claims by the integration's verified origin, and MUST NOT attach a trusted badge to them.
2. **Exact identifiers.** Slots, contracts and consumers match by exact URL. A look-alike slot URL is a different slot; providers MUST display the slot publisher's host wherever they display a slot title.
3. **No hijacking by declaration.** Declaring `occupant`, being connected, or being the most recently connected integration never places a resource in a slot (§5.1). Claim-like requests ("make me the default handler") are candidates presented to the owner.
4. **Provider consumers are disclosed.** A provider feature consuming a slot is listed with the slot's consumers. Enabling it is an owner decision bound to the current occupants. Changing occupants while the feature is enabled requires the §5.1 review, which names the provider feature.
5. **Data flows are disclosed.** For each occupant the provider discloses which origin receives invocations and, for consumers, what data the slot's contracts send there.
6. **No core change.** A slot cannot alter discovery, issuer rules, consent, tokens, grants or RPC semantics. It MUST NOT declare endpoints. The [component-origin envelope](auth.md#presentation-transports-and-key-binding) is available only to profiles, never to slots.
7. **Bounded processing.** All bounds in §2 and §4.3 apply before fetching. A provider fetches slot manifests only for declarations it is processing, under a per-issuer and global fetch budget.

## 10. Feature declaration

A provider that implements this document declares `"extensions.v1": {}` in `features`. Absent, clients apply §8. The provider manifest `extensions` array is meaningful only when `extensions.v1` is declared; otherwise clients ignore it.

## 11. Conformance tests

Tests MUST cover: invalid slot members (each validation rule); unknown `v`; exact-URL matching and look-alike slots; duplicate entries; all four policies, including `ordered` failover for each error class and the prohibition on changing occupants after an ambiguous outcome; occupant addition without consumer grant expansion; `exclusive` replacement review; provider-consumer enablement, disclosure and disable; built-in occupants never auto-assigned; slot manifest disappearance and digest change; superseded-slot migration without grant copying; blocked slots; and a provider without `extensions.v1` processing a slot fragment as an ordinary fragment.
