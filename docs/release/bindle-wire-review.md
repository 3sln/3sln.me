# Bindle runtime interoperability review

Review date: 2026-10-12. Reviewer: independent Codex interoperability agent. Outcome: findings supplied to the integration coordinator; this is implementation review, not human or production approval. Human reviewer: ___ / Date: ___ / Outcome: ___. Decisions and reconciliation belong in [DEVLOG](../../DEVLOG.md).

Scope: read-only source review of `packages/federation`, the native runtime composition, SDK, consent interface and runtime specification. The selected initial profile uses operator-reviewed clients and immutable fragment registries without ambient network fetching. No full suite, build, browser session or external service was run by this reviewer.

## Findings at review time

1. **Discovery metadata and SDK behavior differ.** The runtime advertises `preferences_contract`, but the reviewed SDK neither validates nor retains that value and `readPreferences` hardcodes the hosted contract identifier. It also invents `/api/oauth/requests` when `authorization_request_endpoint` is absent. Require the endpoint declared by the runtime profile and use the discovered preferences contract, or explicitly specify a single fixed supported contract and reject incompatible metadata. Otherwise an independent conforming provider can discover successfully and fail only during use.

2. **Initial partial resource consent succeeds but yields no usable reference.** The consent interface permits selecting a subset of a multi-resource field, and `approve` accepts that subset when minimum cardinality allows it. `readPreferences` nevertheless omits the whole field if any currently assigned resource is unapproved. An isolated in-memory reproduction configured `[A,B]`, approved `[A]`, exchanged the code successfully, and read `{values:{},requiresConsent:['stores']}`. Existing addition-after-consent tests establish intentional fail-closed behavior for newly assigned resources, but do not resolve this initial subset case. Either distinguish assignments reviewed and declined from later additions, or make whole-field resource approval explicit and reject misleading subset selection before issuing the code.

3. **Implemented scope restrictions are narrower than the proposed private scoped-reference model.** The reviewed implementation returns the underlying resource ID and raw scope in preference references; callers address the underlying key namespace. The [resource-scoping proposal](../architecture/resource-scoping.md) instead describes private assignment configuration, an opaque scoped reference, child-relative outputs, and one reviewed shared save that updates the displayed affected consumers. Current configuration invalidates changed assignments and requires fresh app consent. The implemented restrictions and independently attenuated tokens are useful, but these two follow-on capabilities must remain explicitly deferred unless implemented and verified. Updating protocol prose alone must not imply they exist.

## Positive boundaries found in source

- Empty fragment requests support identity-only login. Profile reads remain dependent on an approved resource field and method.
- Tokens are opaque, short-lived and checked against account authority and app connection generations. Resource tokens bind fragment, field, resource, scope and resource generation; they cannot read scalar preferences or sibling resources.
- Removed or changed assignments permanently narrow historical grants. Restoring a preference or reconnecting a provider cannot silently restore those grants.
- Curated schema resolution has no ambient fetch and pins immutable declarative documents. Operator verification of client origin control is a separate responsibility, accurately described by the runtime profile.
- The five-minute access lifetime and absence of refresh tokens are stated. The empty JWKS is consistent with opaque bearer tokens and does not establish OIDC support.

The native adapter and browser owners supply integration evidence separately. This review does not establish independent external-provider conformance, upstream-service conformance, production readiness or human sign-off.
