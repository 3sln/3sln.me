// Core links: the operator link-policy registry (links §7.1; moved from packages/runtime/developer-contact.mjs,
// slice C1a). Only the host operator names policies. Tenants and apps can choose a registered policy URI for a
// conditional link but can never define, parameterize or add one, because a policy such as "eligible only if the
// principal is X" would be an identity oracle. Evaluators are supplied by the runtime per registered URI.
import { UUID } from '../core/primitives.mjs';

export const DEVELOPER_CONTACT_POLICY = 'https://3sln.example/policies/developer-contact/v1';
export const developerPolicy = config => config?.DEVELOPER_CONTACT_POLICY ?? DEVELOPER_CONTACT_POLICY;
/** The registered policy URIs of this deployment, in registry order. */
export const linkPolicyRegistry = config => [developerPolicy(config)];
export const policyRegistered = (config, policy) => linkPolicyRegistry(config).includes(policy);

/** Same-host principals only; no policy means eligible; an unregistered or unevaluable policy is unavailable.
 * `evaluators` maps registered URIs to `(principal) => result`; nothing the audience supplies beyond the
 * principal reaches an evaluator. Results: {eligible, reason?, tier?, tags?, final?} or {state:'unavailable'}. */
export async function evaluateRegisteredPolicy({ origin, config, policy, principal, evaluators = {} }) {
  if (principal?.issuer !== origin || !UUID.test(principal?.subject ?? '')) return { eligible: false, reason: 'local-only', final: false };
  if (policy === undefined) return { eligible: true, final: true };
  if (!policyRegistered(config, policy) || typeof evaluators[policy] !== 'function') return { state: 'unavailable' };
  return evaluators[policy](principal);
}
