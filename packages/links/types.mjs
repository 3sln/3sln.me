// Core links: the link-type table (docs/architecture/messaging-extraction.md C1; docs/spec/bindlebox.md §4.2).
// Core may not import BindleBox, so app link types are named here by URI. Each binding maps one link type to
// the slot whose current occupant may issue, list, evaluate and revoke it through the links contract, plus the
// exact type-specific meta member set the provider validates before signing. The legacy core contact type is
// issued only by ContactEndpointService on `contact-grant` parents and has no app binding: no app may mint it.
import { boundedString, mimeValid } from '../core/records.mjs';

export const CONTACT_LINK_TYPE = 'https://spec.bindle.example/links/contact/v1';
// Placeholder identifiers under spec.bindle.example until publication authority is agreed (bindlebox-protocol/constants.mjs).
export const MESSAGING_INGRESS_SLOT = 'https://spec.bindle.example/slots/messaging-ingress/v1';
export const MESSAGING_CONTACT_LINK_TYPE = 'https://spec.bindle.example/bindlebox/v1/links/contact';
export const LINKS_CONTRACT = 'https://spec.bindle.example/contracts/links/v1';

const KINDS = ['conversation-init', 'one-off'];
const kindsValid = kinds => Array.isArray(kinds) && kinds.length > 0 && kinds.length <= KINDS.length && kinds.every((kind, i) => KINDS.includes(kind) && (i === 0 || kinds[i - 1] < kind));
const intIn = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
// bindlebox.md §4.1: the common members plus sub/resource/kinds/mime/quota members; `audience` is provider-built.
const messagingContact = Object.freeze({
  slot: MESSAGING_INGRESS_SLOT,
  // Links stay on the provider origin under the contact path, so the landing route and an app switch keep them.
  path: (handle, jti) => `/users/${encodeURIComponent(handle)}/contact/${encodeURIComponent(jti)}`,
  members: Object.freeze(['resource', 'kinds', 'mimeTypes', 'maxMessages', 'maxBytes', 'maxMessageBytes']),
  conditional: true,
  valid: claims => boundedString(claims.resource, 128) && kindsValid(claims.kinds) && Array.isArray(claims.mimeTypes) && claims.mimeTypes.length > 0 && claims.mimeTypes.length <= 32 && claims.mimeTypes.every(mimeValid) && new Set(claims.mimeTypes).size === claims.mimeTypes.length && intIn(claims.maxMessages, 1, 100000) && intIn(claims.maxBytes, 1, 1073741824) && intIn(claims.maxMessageBytes, 1, 10485760) && claims.maxMessageBytes <= claims.maxBytes,
});

/** Link type URI -> {slot, path(handle, jti), members, conditional, valid(claims)}. Append-only; a binding is a reviewed change. */
export const LINK_TYPE_BINDINGS = Object.freeze(Object.assign(Object.create(null), { [MESSAGING_CONTACT_LINK_TYPE]: messagingContact }));
export const linkBinding = type => (typeof type === 'string' && Object.hasOwn(LINK_TYPE_BINDINGS, type) ? LINK_TYPE_BINDINGS[type] : null);
