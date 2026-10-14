import {fail,boundedString} from './store.mjs';
export function validTagList(tags){return Array.isArray(tags)&&tags.length<=32&&tags.every(tag=>boundedString(tag,64))&&new Set(tags).size===tags.length;}
export function contactTagPolicy({requiredTags=[],optionalTags=[]}={}){
 if(!validTagList(requiredTags)||!validTagList(optionalTags)||requiredTags.length+optionalTags.length>32||requiredTags.some(tag=>optionalTags.includes(tag)))fail('invalid_contact_tags','Choose up to 32 distinct required and optional tags.');
 return {requiredTags:[...requiredTags],optionalTags:[...optionalTags]};
}
export function contactDeliveryTags(claims,senderTags=[]){
 if(!validTagList(senderTags))fail('invalid_message_metadata');
 // Historical grants carried arbitrary untrusted sender annotations; these
 // never become receiver-endorsed tags by installing this new implementation.
 if(claims.requiredTags===undefined&&claims.optionalTags===undefined)return [];
 if(claims.requiredTags===undefined||claims.optionalTags===undefined)fail('unauthorized');
 const {requiredTags,optionalTags}=contactTagPolicy(claims);
 if(senderTags.some(tag=>!requiredTags.includes(tag)&&!optionalTags.includes(tag)))fail('forbidden_tags','This contact link does not allow those tags.');
 return [...requiredTags,...senderTags.filter(tag=>optionalTags.includes(tag))];
}
