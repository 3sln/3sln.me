import {fail,boundedString} from './store.mjs';
import {validTagIds,isSystemTag,escapeLegacyTag,validIntakeTagIds} from './tags.mjs';
// Tag lists carry stable IDs (docs/architecture/tags.md); unknown `sys:` IDs are invalid.
export function validTagList(tags){return validTagIds(tags);}
// Signed (legacy) claims hold user tag IDs only; system IDs belong to mutable intake configuration (validIntakeTagIds).
const userTags=tags=>validTagIds(tags)&&!tags.some(isSystemTag);
export function contactTagPolicy({requiredTags=[],optionalTags=[]}={}){
 if(!userTags(requiredTags)||!userTags(optionalTags)||requiredTags.length+optionalTags.length>32||requiredTags.some(tag=>optionalTags.includes(tag)))fail('invalid_contact_tags','Choose up to 32 distinct required and optional tags.');
 return {requiredTags:[...requiredTags],optionalTags:[...optionalTags]};
}
export function contactDeliveryTags(claims,senderTags=[]){
 if(!Array.isArray(senderTags)||!validTagIds(senderTags.map(escapeLegacyTag)))fail('invalid_message_metadata');
 // Historical grants carried arbitrary untrusted sender annotations; these
 // never become receiver-endorsed tags by installing this new implementation.
 if(claims.requiredTags===undefined&&claims.optionalTags===undefined)return [];
 if(claims.requiredTags===undefined||claims.optionalTags===undefined)fail('unauthorized');
 // Signed claims predate the system registry: reserved-looking strings stay user tags.
 const escape=tags=>[...new Set(tags.map(escapeLegacyTag))],{requiredTags,optionalTags}=contactTagPolicy({requiredTags:escape(claims.requiredTags),optionalTags:escape(claims.optionalTags)}),selected=escape(senderTags);
 if(selected.some(tag=>!requiredTags.includes(tag)&&!optionalTags.includes(tag)))fail('forbidden_tags','This contact link does not allow those tags.');
 return [...requiredTags,...selected.filter(tag=>optionalTags.includes(tag)&&!requiredTags.includes(tag))];
}
// Contact intake (links §6.2): owner-mutable, revisioned delivery tag
// configuration on the parent. Legacy signed tags seed revision 0 lazily.
const LOCALE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/, plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export function validateIntake({ autoTags = [], optionalTags = [], labels = {} } = {}, revision, updatedAt) {
  if (!validIntakeTagIds(autoTags) || !validIntakeTagIds(optionalTags) || autoTags.length + optionalTags.length > 32 || autoTags.some(tag => optionalTags.includes(tag))) fail('invalid_contact_tags', 'Choose up to 32 distinct automatic and optional tags.');
  if (!plain(labels) || Object.keys(labels).some(id => !optionalTags.includes(id) || !plain(labels[id]) || Object.keys(labels[id]).length > 8 || Object.entries(labels[id]).some(([locale, label]) => !LOCALE.test(locale) || !boundedString(label, 80)))) fail('invalid_contact_tags', 'Tag labels must name accepted optional tags.');
  if (!Number.isSafeInteger(revision) || revision < 0 || !Number.isSafeInteger(updatedAt)) fail('invalid_contact_tags');
  return { version: 1, revision, autoTags: [...autoTags], optionalTags: [...optionalTags], labels: Object.fromEntries(Object.keys(labels).sort().map(id => [id, Object.fromEntries(Object.keys(labels[id]).sort().map(locale => [locale, labels[id][locale]]))])), updatedAt };
}
export function contactIntake(grant) {
  if (grant?.intake) return grant.intake;
  const claims = grant?.claims;
  if (claims?.requiredTags === undefined && claims?.optionalTags === undefined) return null;
  if (claims.requiredTags === undefined || claims.optionalTags === undefined) fail('unauthorized');
  // Signed claims predate the system registry: reserved-looking strings stay user tags.
  const escape = tags => [...new Set(tags.map(escapeLegacyTag))];
  return validateIntake({ autoTags: escape(claims.requiredTags), optionalTags: escape(claims.optionalTags) }, 0, grant.createdAt ?? 0);
}
// Null intake is a pre-tag-policy grant: sender tags stay untrusted annotations.
export function intakeDeliveryTags(intake, senderTags = []) {
  if (!intake) return contactDeliveryTags({}, senderTags);
  // Exact intake IDs (including registered sys:* optional tags) match first; other text is escaped.
  const map = tag => intake.optionalTags.includes(tag) || intake.autoTags.includes(tag) ? tag : escapeLegacyTag(tag);
  if (!Array.isArray(senderTags) || !senderTags.every(tag => boundedString(tag, 64)) || !validTagIds(senderTags.map(map))) fail('invalid_message_metadata');
  const selected = [...new Set(senderTags.map(map))];
  if (selected.some(tag => !intake.autoTags.includes(tag) && !intake.optionalTags.includes(tag))) fail('forbidden_tags', 'This contact link does not accept those tags.');
  return [...intake.autoTags, ...selected.filter(tag => intake.optionalTags.includes(tag) && !intake.autoTags.includes(tag))];
}
