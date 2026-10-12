# Callable methods and user commands

Status: provisional architecture recommendation, 2026-10-12. Human reviewer: ___ / date: ___ / outcome: ___. This extends the approved app-connection resource direction; it does not claim approval of the presentation contract or implementation of external app commands. Track reconciliation in [DEVLOG](../../DEVLOG.md).

## Recommendation

Applications should contribute callable contract methods with optional user-command presentation. A host can present a method in a command palette, menu, toolbar, form or other suitable interface. MCP and WebMCP are adapters to the same operation. The underlying identity remains the existing resource, immutable contract and method; presentation introduces neither a second action registry nor a permission namespace.

An MCP tool can already be exposed as a human command: MCP explicitly permits different interface patterns. Its schema and title provide useful starting metadata, but tool suitability and granted authority still need host decisions. Imported annotations are untrusted unless their source is trusted; discovery must not automatically promote every tool to a user command. [Official MCP tools specification](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)

This means keeping the common foundation below either human UI or assistant transport. Do not require apps to implement MCP to contribute methods, or require a host to implement a 3sln command palette. Retain the [app resource and adapter model](app-resource-options.md), [contribution lifecycle](../spec/resource-contributions.md) and [browser availability boundaries](browser-automation.md).

## Existing mechanisms and the missing piece

| Existing mechanism | Reuse | Current limit |
| --- | --- | --- |
| Bindle resource/contract/method grants | Exact operation identity and consumer authorization | General app dispatch/import remains proposed; current MCP grants require an explicit bridge to Bindle grants. |
| [Shared automation catalog](../../packages/automation/catalog.mjs) | Five collection/item definitions and input validation shared by HTTP MCP and browser automation | This is a concrete local seam, not an implemented arbitrary app callable registry. |
| [Portal command contributions](../../packages/portal/index.mjs) | Trusted host command execution through declared dependencies and capability acquisition | Modules are selected application code. External metadata cannot supply `execute`, dependency providers, Action classes or UI factories. |
| [Portal module composition](../../apps/web/src/shared/portal-modules.mjs) | Existing navigation, palette commands, shortcuts and custom views | Opening a view is a legitimate host command and need not become an externally callable resource method. |

The missing piece is a reviewed adapter from an activated callable binding to a host command. It resolves the binding, obtains the proper authority and invokes the existing business operation. It does not install third-party JavaScript into the trusted module registry. Rich native commands can keep their existing custom UI and dependencies; a host may also supply a trusted custom form for a particular contract.

## Minimal portable description

The callable's authoritative description already consists of its exact resource/contract/method binding, pinned revision, input/output schemas, reviewed effects and adapter/dependency policy. Bind these through existing contract and contribution metadata. A display label is never its identifier.

Add only optional declarative `userCommand` presentation to a method's approved descriptor. The proposed shape is intentionally small; exact field limits and a versioned schema remain implementation work:

| Presentation field | Meaning |
| --- | --- |
| `label` | Short localized action name; the host also shows independently established app identity. |
| `description` | Bounded plain-text explanation for a person. |
| `argumentHints` | Labels/help for named fields already present in the authoritative input schema. These cannot change types, constraints or authority. |
| `icon` | Optional reviewed presentation reference subject to existing safe asset policy; hosts can ignore it and use initials. |

Presence requests eligibility for human presentation. Absence means no ordinary user-command entry by default; it neither forbids a trusted host's deliberate mapping nor grants agent access. A separate `userCommand: true` flag adds little when the metadata object itself expresses this intent. Avoid universal keybindings, palette categories, expression evaluators, arbitrary widgets, HTML/JS, executable argument transforms, remotely fetched schemas and app-supplied confirmation controls in this first profile. Hosts choose placement, ordering, localization fallback and keyboard bindings.

Presentation is part of the reviewed descriptor snapshot. Keep its revision/digest distinguishable from the pinned callable definition and implementation binding; cosmetic changes must not bypass or invalidate semantic pin checks. Updating a label does not widen a method grant, and presentation-only changes need not demand fresh authority consent. Revalidate the new presentation and preserve the reviewed callable identity; changes to input semantics, effects, dependencies or routing follow the existing immutable revision/reconsent rules. A renamed or recreated command cannot silently retarget a cached binding.

An imported MCP tool can supply candidate labels and schemas through its adapter, but `userCommand` is proposed Bindle metadata, not an existing standard MCP field. Unsupported upstream schema features or extensions cannot silently become weaker host forms. Metadata pinning detects approved interface changes; it cannot prove that a remote implementation honors its advertised behavior.

## Arguments and results

Offer generic typed forms only for an explicitly supported schema subset: ordinary scalar fields, enumerations and bounded structures. Validate arguments against the authoritative schema at execution even after form validation. A host may offer a selected resource or item as an input only through a reviewed typed binding; arguments do not confer authority. Show the effective target and values before any sensitive effect. Argument hints cannot introduce defaults or silently generate hidden inputs. Never infer a resource, destination or hidden privileged argument merely from a label or natural-language description.

Some tools are useful to software and awkward for people. The existing `item_write` exposes `dataBase64`, conditional versions and request IDs; a raw form is a poor universal file editor. A trusted host can expose a file picker/editor that maps into that exact operation, supply transaction IDs through its invocation context and show overwrite conditions. It must retain the same schema, preconditions and replay semantics. Alternatively omit that command from generic presentation and direct the person to the app's existing UI. Specialized presentation does not justify another business implementation or arbitrary app-authored mapping expressions.

Render bounded structured results with the host's trusted components. Tool output cannot provide executable UI, approve a subsequent effect, change the route or fetch a returned link automatically. App UI remains a separately opened, visibly identified application with its own authorized resource access. Supporting a rich remote UI later requires an explicit integration and review, not an extension of plain presentation hints.

## One operation, distinct authority

| Caller path | Authority retained by the adapter |
| --- | --- |
| Person using the host command | Authenticated owner session and its current allowed operation; origin/CSRF protections and applicable effect confirmation. |
| HTTP MCP assistant | Its own live OAuth client grant, exact resource/method binding, connection generation and approved dependencies. |
| Portal WebMCP callback | Explicitly enabled browser-session collection/function access and its confirmation rules; no fabricated assistant identity. |
| Future cooperative browser app | Reviewed app binding, actual live document and caller/dependency intersection; the host's ambient owner session is never lent to the app. |

Share validation, business dispatch, effect policy, transaction identity and outcome handling. Keep caller authentication at each adapter and carry its constrained invocation context into the dispatcher. A person clicking a command does not authorize a connected agent, widen an agent grant or create a persistent automation permission. Conversely, a user confirming an agent-requested effect does not change that request into an owner-privileged call. Its original caller grant and argument digest remain bound throughout review and execution.

For verified read-only operations, direct execution after argument selection may be appropriate under the host's disclosure policy. Writes, deletion, external communication and spending receive the applicable trusted review with actual targets and arguments. Sensitive disclosures can also require review. Missing or unverified effect metadata must not take the read-only fast path; imported methods retain the contribution specification's journal and review requirements. A click on a command label alone is not approval of later unseen inputs.

Reuse the existing durable invocation journal and method-specific preconditions. Confirmation is bound to the owner, original caller, connection generation, pinned operation, input digest and expiry. Resolve live authority again at dispatch and before returning cached private results. Revocation stops future work; cancellation does not undo an accepted external effect. An uncertain outcome remains indeterminate and must not be retried with a fresh transaction merely because another UI initiated it.

## Scope and reversible next step

Application state remains in any resources it already has permission to access, its own backend or browser state. No new app-state store, hosted workflow language, app marketplace, mandatory backend or parallel permission plane is needed. Human UI and assistant transport do not alter where the underlying operation can execute; a closed browser cannot supply a live document method.

First implement one native provider fixture with a separately granted read method and write method. Give the read method generic user-command presentation and the write method a supported typed form or trusted custom mapping. Project the same methods through one human host and the existing assistant adapter. Then exercise one independent imported MCP fixture through the same reviewed binding. This verifies the abstraction before building a generalized UI renderer.

Required evidence includes identical business outcomes across adapters, a host without a palette, unsupported-schema omission, hostile labels/hints, exact input confirmation, caller privilege separation, grant/disconnection changes between display and invoke, changed revisions, identical-transaction replay and uncertain writes. Source-level metadata alone does not establish any of those behaviors. The existing five tools and native commands are implemented local mechanisms; arbitrary contributed user commands and the general grant bridge remain proposal work.

| Provisional decision | Human review |
| --- | --- |
| Existing callable contract methods are the foundation; optional user-command presentation is independent of host UI and transport. | Reviewer ___ / date ___ / outcome ___ |
| Trusted native commands retain custom UI; external contributions use bounded declarative presentation through reviewed adapters. | Reviewer ___ / date ___ / outcome ___ |
| Share business dispatch while preserving owner, assistant and browser-session authority separately. | Reviewer ___ / date ___ / outcome ___ |


## Implemented first host adapter

The user approved the direction on 2026-10-12. [Callable bindings and command projection](../../packages/portal/callable-commands.mjs) now provide an opt-in trusted-host foundation: exact pinned resource/contract/method identity, bounded strict scalar/enumeration input schemas, immutable arguments and original caller context, reviewed effects, post-review live binding resolution and optional inert labels/argument hints. The existing portal contribution interface can wrap this binding through explicitly injected trusted authority ports; a host without a palette can invoke the same binding directly. No descriptor can supply executable host code or obtain an owner credential. Icon support and generic nested-schema forms are intentionally outside this implemented subset.

[Native integration fixtures](../../tests/callable-commands.test.mjs) use actual FederationService grants and FederationController dispatch/journaling. They verify separate owner/assistant authority, shared outcomes, revocation/disconnection, exact-transaction replay, collisions and indeterminate writes. [Independent regressions](../../tests/callable-commands-audit.test.mjs) cover hostile descriptors/results, exact arguments and caller substitution during asynchronous review. This is a trusted injectable adapter, not an activated third-party app registry, generic command-form renderer, upstream MCP importer or production OAuth-to-Bindle grant bridge. Those remain integration work.
