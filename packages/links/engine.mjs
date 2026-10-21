// Core links: links-contract engine operations (docs/spec/bindlebox.md §4.2; extraction plan slice C1a).
//
// Engine-first: LinkService is the provider resource; the Actions/Queries below are the operations a messaging app
// reaches through an app actor (wired in C1b through the links contract resource) and the owner through
// account/links.mjs. Everything is refused with `not_found` unless BINDLEBOX_ENABLED is on.
//
// Actors (built by trusted adapters only, never from a request body):
//   {kind:'owner', owner, handle?}       list, changes and revoke on every app-declared link of the owner. Owners do
//                                        not issue app types: a type is issued only for the app that handles it.
//   {kind:'app', owner, clientId, handle} every operation, limited to link types whose binding slot (./types.mjs)
//                                        the app currently occupies, as reported by the `occupant({owner, slot})`
//                                        port -> {clientId, generation} | null. No port, no occupant, or another
//                                        occupant means `forbidden`; occupancy is re-read on every operation.
import { Provider } from '../../vendor/ngin/index.js';
import { AppAction, AppQuery } from '../app/engine.mjs';
import { AppFault } from '../app/faults.mjs';
import { LINK_TYPE_BINDINGS, linkBinding } from './types.mjs';
import { UUID } from '../core/primitives.mjs';

const forbidden = () => { throw new AppFault('forbidden', 'This app cannot manage these links.', 403); };
const unauthorized = () => { throw new AppFault('unauthorized', 'Sign in to continue.', 401); };
const CLIENT = value => typeof value === 'string' && value.length > 0 && value.length <= 2048 && !/[\u0000-\u001f\u007f]/.test(value);
const INPUT = (input, names) => input === undefined || (input !== null && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).every(name => names.includes(name)));

/** The `links` provider class for createAppEngine (ngin constructs provider classes itself).
 * `service`: a LinkService. `enabled`: BINDLEBOX_ENABLED, decided from configuration. `occupant`: see above. */
export function linksProvider({ service, enabled = false, occupant } = {}) {
  return class extends LinksProvider { static deps = []; constructor() { super(); Object.assign(this, { service, enabled: enabled === true, occupant }); } };
}
export class LinksProvider extends Provider {
  async obtain({ actor } = {}) {
    if (!this.enabled || !this.service) throw new AppFault('not_found', 'Not found.', 404);
    if (!UUID.test(actor?.owner ?? '')) unauthorized();
    if (actor.kind === 'owner') return Object.freeze(scope(this.service, actor, { owner: true }));
    if (actor.kind !== 'app' || !CLIENT(actor.clientId)) unauthorized();
    const occupant = this.occupant, slots = async () => {
      // Slots this app occupies now; a failing or missing port fails closed.
      if (typeof occupant !== 'function') return [];
      const held = [];
      for (const slot of new Set(Object.values(LINK_TYPE_BINDINGS).map(binding => binding.slot))) { let found = null; try { found = await occupant({ owner: actor.owner, slot }); } catch { found = null; } if (found?.clientId === actor.clientId) held.push({ slot, generation: found.generation ?? null }); }
      return held;
    };
    return Object.freeze(scope(this.service, actor, { slots }));
  }
  release() {}
}
// The owner-scoped handle: methods take no owner argument, so an operation never holds an ID it could swap.
function scope(service, actor, { owner = false, slots }) {
  const allowed = async () => owner ? undefined : (await slots()).map(held => held.slot);
  const occupying = async type => { const binding = linkBinding(type); if (!binding) throw new AppFault('unsupported_link_type', 'This link type is not supported.', 400); const held = (await slots()).find(entry => entry.slot === binding.slot); if (!held) forbidden(); return held; };
  return {
    async issue(input) {
      if (owner) forbidden();
      // A caller occupying no bound slot learns nothing about the request: forbidden before any validation.
      if (!(await allowed()).length) forbidden();
      if (!INPUT(input, ['type', 'claims', 'expiresAt', 'audience'])) throw new AppFault('invalid_request', 'Unsupported link request.', 400);
      const held = await occupying(input?.type);
      return service.issue(actor.owner, { type: input.type, claims: input.claims, expiresAt: input.expiresAt, audience: input.audience, handle: actor.handle }, { kind: 'app', clientId: actor.clientId, generation: held.generation });
    },
    async revoke(jti) { const permitted = await allowed(); if (permitted && !permitted.length) forbidden(); return service.revoke(actor.owner, jti, { slots: permitted }); },
    async rotate(jti) { if (owner) forbidden(); const permitted = await allowed(); if (!permitted.length) forbidden(); return service.rotateChallenge(actor.owner, jti, { slots: permitted }); },
    async evaluate(input) {
      if (owner) forbidden();
      if (!INPUT(input, ['jti', 'principal'])) throw new AppFault('invalid_request', 'Unsupported link request.', 400);
      const permitted = await allowed(); if (!permitted.length) forbidden();
      return service.evaluate(actor.owner, input ?? {}, { slots: permitted });
    },
    async list(input) {
      if (!INPUT(input, ['type', 'cursor', 'limit'])) throw new AppFault('invalid_request', 'Unsupported link request.', 400);
      const permitted = await allowed(); if (permitted && !permitted.length) forbidden();
      return service.list(actor.owner, input ?? {}, { slots: permitted });
    },
    async changes(input) {
      if (!INPUT(input, ['since'])) throw new AppFault('invalid_request', 'Unsupported link request.', 400);
      const permitted = await allowed(); if (permitted && !permitted.length) forbidden();
      return service.changes(actor.owner, input ?? {}, { slots: permitted });
    },
  };
}

/** `input`: {type, claims, expiresAt, audience?}. Returns {link, jti}. */
export class IssueLink extends AppAction { static operation = 'links.issue'; static deps = ['links']; static changes = 'links-changed'; run({ links }) { return links.issue(this.input); } }
/** `id`: the jti. Idempotent. */
export class RevokeLink extends AppAction { static operation = 'links.revoke'; static deps = ['links']; static changes = 'links-changed'; run({ links }) { return links.revoke(this.id); } }
/** `id`: the jti of a conditional link; a fresh challenge signed with the current key. */
export class RotateLinkChallenge extends AppAction { static operation = 'links.rotate'; static deps = ['links']; static changes = 'links-changed'; run({ links }) { return links.rotate(this.id); } }
/** `input`: {jti, principal:{issuer, subject}}. Not a pure read: it may record a bounded decision. */
export class EvaluateLink extends AppAction { static operation = 'links.evaluate'; static deps = ['links']; run({ links }) { return links.evaluate(this.input); } }
/** `input`: {type?, cursor?, limit?}. */
export class LinkList extends AppQuery { static operation = 'links.list'; static deps = ['links']; static refreshOn = ['links-changed']; fetch({ links }) { return links.list(this.input); } }
/** `input`: {since}. */
export class LinkChanges extends AppQuery { static operation = 'links.changes'; static deps = ['links']; static refreshOn = ['links-changed']; fetch({ links }) { return links.changes(this.input); } }

export const LINK_OPERATIONS = Object.freeze([IssueLink, RevokeLink, RotateLinkChallenge, EvaluateLink, LinkList, LinkChanges]);
