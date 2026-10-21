// v1 compatibility adapter (activity-center "Existing local behavior and compatibility"): an app message admitted
// through `app-messages/v1.createOwn` projects into an activity row. The original signed `tags` array is qualified
// under the verified app principal; values outside the new grammar stay typed legacy app tags with their exact
// value, never normalized into a colliding new ID. Records without verifiable provenance are inert history and are
// not promoted to verified app activity. Nothing here writes, re-signs or migrates the original record.
import {canonical} from '../core/primitives.mjs';
import {fromBase64url} from '../core/records.mjs';
import {APP_TAG,principalOf} from './model.mjs';

export const LEGACY_PURPOSE='bindle-app-notification-admission-v1';
/** Verifies a v1 admission attestation against the issuer's own published key set. */
export async function verifyLegacyAppMessage(message,{issuer,keys}){
 try{
  const {attestation,...provenance}=message?.appNotification??{};
  if(provenance.purpose!==LEGACY_PURPOSE||provenance.issuer!==issuer||provenance.owner!==message.owner||provenance.id!==message.id||attestation?.alg!=='ES256')return false;
  const jwk=keys?.keys?.find(k=>k.kid===attestation.kid);if(!jwk)return false;
  const key=await crypto.subtle.importKey('jwk',{kty:jwk.kty,crv:jwk.crv,x:jwk.x,y:jwk.y},{name:'ECDSA',namedCurve:'P-256'},false,['verify']);
  return await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},key,fromBase64url(attestation.signature),new TextEncoder().encode(canonical(provenance)));
 }catch{return false;}
}
/** The activity projection of one stored v1 app message, or null when it is not an app message at all. Unless the
 * caller passes `verified: true` (after verifyLegacyAppMessage against the issuer's keys), the row is marked
 * `verified: false`: its attribution is a stored claim, to be shown as unverified history, never as app activity. */
export function activityFromAppMessage(message,{verified=false}={}){
 const p=message?.appNotification;
 if(!p||typeof p!=='object'||p.purpose!==LEGACY_PURPOSE||!p.attestation||typeof p.clientId!=='string'||typeof p.issuer!=='string'||!Array.isArray(p.tags))return null;
 const app={issuer:p.issuer,clientId:p.clientId,origin:p.origin,name:p.name},principal=principalOf(app);
 return {
  id:message.id,legacy:true,app:{principal,clientId:app.clientId,origin:app.origin,name:app.name},subject:p.subject,revision:1,receivedAt:p.receivedAt,updatedAt:p.receivedAt,
  tags:p.tags.map(value=>typeof value==='string'&&APP_TAG.test(value)?{namespace:'app',app:principal,id:value}:{namespace:'app-legacy',app:principal,value:String(value)}),
  priority:'normal',expiresAt:null,state:'active',read:message.readAt!=null,archived:false,verified:verified===true,
 };
}
