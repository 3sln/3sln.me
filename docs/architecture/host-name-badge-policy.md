# Host name policy and local badge sprites

Status: pure policy, safe sprite compiler and local UI implemented; integrated resolver/adapters and final validation are separate checkpoints. Reviewer ___ / date ___ / outcome ___. Human sign-off records do not prevent authorized reversible work.

Badge presentation belongs to the app instance. The embedder supplies badge definitions `{id,name,description,svg}`; the host compiles them into one frontend SVG sprite. An injected trusted resolver maps an identity to badge IDs. Its default reads the identity's editable `badgeIds`. Badges confer no administrator permissions, paid entitlement, system identity, signing authority, verified authorship or cross-provider trust. There is no badge federation or public contract registry.

This current interface supersedes earlier name-to-badge mappings, required special assignment markers, and host-prebuilt sprite manifests. No badge admin UI is added here.

## Separate operator inputs

Name policy is only `HOST_NAME_POLICY`:

```json
{"version":1,"reserved":["admin","staff"],"onboarding":["alice","staff"]}
```

Reserved and token-onboardable names are unavailable to public paid claims, even with invitation issuance disabled or missing its key. The lists may overlap. An absent/empty-string policy preserves the current default reserved names and legacy `ONBOARDING_NAMES`. An explicit policy replaces those defaults. Names use canonical lowercase 3–32-character alias syntax; numeric `n.` identities cannot be configured. Normalize public claim inputs before checking, so uppercase cannot bypass reservations. Configured formerly reserved names may be operator-onboarded as ordinary identities; they acquire no system role by their spelling.

Name policy is limited to32KiB and256 entries per set. Existing permanent assignments and tombstones remain authoritative after configuration removal. Immutable alias validation is independent of today's policy so removal cannot break recovery.

Local artwork is a separate `BADGE_DEFINITIONS` array (JSON environment value or code-injected configuration):

```json
[
  {"id":"team","name":"Host team","description":"An account designated as part of this host's team.","svg":"<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\"><circle cx=\"12\" cy=\"12\" r=\"9\"/></svg>"}
]
```

The default is a neutral `system` shield definition. Definitions come only from trusted host/integrator code or configuration, never a profile, account request, message, badge resolver result or remote SVG URL. There are at most32 definitions and262,144 input bytes. IDs are lowercase slugs of at most48 characters; names are bounded literal text of48 Unicode code points and descriptions240. Invalid Unicode, controls and bidi override/isolation characters are rejected. Unknown definition fields and duplicate IDs reject the definition set.

## Safe compiler and asset

Each SVG block is at most16KiB and contains one `<svg>` with a finite positive `viewBox`. The current profile permits groups, paths, circles, ellipses, rectangles, lines, polylines and polygons; bounded numeric geometry, transforms, opacity, simple colors and strokes. It rejects unsupported features rather than silently claiming they were preserved. Gradients, references, embedded IDs, CSS/style attributes, foreignObject, author scripts/events, images, links, animation, external resources, doctypes/entities and malformed/duplicate attributes are unsupported. No unreviewed ID rewriting is needed because authored references are disallowed.

Parsing is bounded to512 nodes and depth12 per definition, with path/attribute/numeric limits. The compiler emits fresh allowlisted markup, generates each symbol ID from the trusted definition slug, and adds escaped `<title>`/`<desc>` from its name and description. The author block cannot substitute accessible labels or execute its own code.

`compileBadgeSprite(config)` returns `{svg,digest,ids,definitions}`, where digest is SHA-256 hex of exact UTF-8 output and public definitions contain only `{id,name,description}`. `configuredBadgeDefinitions` and `configuredBadgeIDs` validate strictly. `publicBadgePolicy` returns a safe metadata projection with `/api/badges/sprite.svg`, or an empty disabled projection when optional definitions are malformed. It exposes no reserved/token-name list.

The root HTTP adapter owns the public GET/HEAD sprite resource and optional `?v=<digest>` addressing/ETag. A versioned URL must never serve different bytes under the same digest; mismatched versions fail rather than silently change content. A single process-local content-keyed cache retains one validated definition set and its immutable sprite/digest promise: at most256KiB input and512KiB generated SVG. Unchanged input avoids parsing/hashing; mutating a code-injected object changes its serialized key. Returned cached values are frozen, and replaced configs cannot overwrite an in-flight older result. No account reads, identity cookies or private grants are needed to compile or serve this host-authored asset. Browser use selects only known symbol IDs under the exact first-party sprite route. Name and description remain literal accessible text; an identity cannot select a URL or provide SVG.

## Resolver and identity state

`defaultBadgeResolver(identity)` copies `identity.badgeIds`. Trusted integrator code may replace it through an injected ngin resource and derive IDs from locally defined roles or other intended identity attributes. Resolved IDs need not be persisted. `projectAccountBadges(identity,config,resolvedIds)` is the pure final boundary: at most four unique valid IDs, intersected with current compiled definitions, for a valid local UUID/canonical handle and supported identity state. Unknown IDs disappear; malformed or unawaited results produce no decoration. `accountBadges` remains the default composition.

The backend owns asynchronous invocation, a bounded deadline and exception isolation. Hook failure/timeout gives no badges, does not block authentication/read/recovery, and does not silently substitute a different stored badge set. Pass a minimal read-only identity view and explicitly intended role fields, excluding credentials, sessions, private keys, email/setup/recovery secrets and capabilities. The hook is trusted installed code, never a JSON function, module URL or user-controlled script.

An operator invitation may select initial per-name `badgeIds`. The claim body cannot override the authenticated selection. Stored badge IDs are ordinary mutable presentation state, separate from immutable onboarding ownership; future authorized operator tooling may change them without rewriting name provenance. The specialized system setup can explicitly initialize `['system']`. Projection never infers badges from a reserved name or old role alone. Legacy identities need an explicit assignment/migration if old decoration is to be retained.

## Evidence and remaining integration gates

Focused tests cover default/override/overlap name policy, disabled-issuance protection, known-ID resolution, mutable stored selections, safe deterministic sprite output/digest, accessible escaping, executable/external SVG rejection, XML/attribute ambiguity, node/depth/size/numeric bounds and optional failure isolation. DOM tests verify exact sprite routing, literal names/descriptions and rejection of identity-provided URLs/objects. A source-only Chromium fixture additionally fetches and visibly paints the external symbol under the endpoint's sandbox/default-none CSP and same-origin resource policy; it checks accessible labeling and one sprite fetch. This is native asset/render evidence with intercepted requests, not a production or full built-application test. Unsupported gradients and CSS are deliberate profile limits.

Source-intercepted walkthrough artifacts (reserved example hosts, synthetic identities, no real account or service): [badge in the console account panel](../../artifacts/browser/host-badges-console.png) and [invitation-scoped account-name selection](../../artifacts/browser/private-onboarding-names.png). Both render current source with the app stylesheet. The invitation image is captured after token scrubbing and before credential entry; the fixture verifies only invited available names are selectable. The console image uses a synthetic `n.1@badges.example` handle. Chromium checks actual symbol geometry and nonoverlapping badge text. These are component/application source fixtures, not deployment or backend delivery evidence.

Backend-owner checkpoints are authenticated per-name badge initialization, no public override, configurable claims and permanent namespace enforcement, minimal asynchronous resolver context/deadline, and safe public asset routing. Root owns the final combined core/Worker/build and actual browser asset validation. No cross-provider badge authority or privileged role assignment is claimed.
