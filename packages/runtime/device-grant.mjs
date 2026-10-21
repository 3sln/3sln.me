// LA3 composition of the device authorization grant (docs/architecture/linked-approval.md §10.2; slice LA3).
// Shared by the Worker and Node adapters. Nothing here is reachable unless DEVICE_AUTHORIZATION_ENABLED is on AND the
// adapter can mount every route the declaration names (federation on, refresh on, a DPoP nonce key): only then does
// an adapter build `DEVICE_GRANT` and report `mounts.deviceAuthorization`, the evidence the EXT-X2 declaration row
// requires. Every engine operation still answers `not_found` with the flag off (device-authorization.mjs).
//
// `DEVICE_GRANT` is the adapter port the routes call: `{mounted, authorize, token, cancel, rpc, review, approve,
// drain}`, each one engine operation (`DeviceAuthorize` … `DeviceLineageDrain`) dispatched through a short-lived app
// engine over the `deviceGrant` provider. On Node the provider reaches owner shards in process; the Worker front
// forwards owner-shard steps to the owner's FederationObject (apps/worker/index.mjs), which runs the same provider.
import {createAppEngine,perform} from '../app/engine.mjs';
import {systemClock,cryptoRandom,nullAudit} from '../app/providers.mjs';
import {DeviceAuthorize,DeviceToken,DeviceReview,DeviceApprove,DeviceRpc,DeviceCancel,DeviceLineageDrain,createDeviceGrantProvider,linkedPort,MemoryJtiCache,DEVICE_GRANT} from '../federation/device-authorization.mjs';
import {dpopNonces} from '../federation/dpop.mjs';
import {LinkedSystemAction,LinkedApprovalAction,LinkedResolveQuery,LinkedLineageQuery,LinkedOutboxQuery} from '../identity/index.mjs';
import {federationDpopSecret,federationClients} from './federation.mjs';
import {UUID_V4 as UUID} from '../core/primitives.mjs';

export {DEVICE_GRANT,MemoryJtiCache};
export const deviceAuthorizationEnabled=config=>config?.DEVICE_AUTHORIZATION_ENABLED===true||config?.DEVICE_AUTHORIZATION_ENABLED==='true';
/** Mount evidence for the app kind: the flag plus everything the declared members depend on. Session-kind linked
 * routes need only the flag (routes/identity.mjs). */
export const deviceGrantMountable=config=>deviceAuthorizationEnabled(config)&&config.FEDERATION_ENABLED==='true'&&config.FEDERATION_REFRESH_ENABLED!=='false'&&!!federationDpopSecret(config);
const LINKED_CLASSES=Object.freeze({LinkedSystemAction,LinkedApprovalAction,LinkedResolveQuery,LinkedLineageQuery,LinkedOutboxQuery});
const PORT_METHODS=['startApp','redeem','cancelApp','lineageRevoke','outboxAck','lineageLive','outbox','resolve','approve'];
/** The LA1 `linked` port over the main identity resources, one fresh identity engine per call (disposed after), so
 * long-lived owner shards can hold it for refresh-time lineage checks. */
export function engineLinkedPort(makeEngine){
 return Object.freeze(Object.fromEntries(PORT_METHODS.map(name=>[name,async(...args)=>{const engine=await makeEngine();try{return await linkedPort(engine,LINKED_CLASSES)[name](...args);}finally{await engine.dispose();}}])));
}
/** Durable creation windows under their own prefix, over the adapter's abuse `consume(key,limits)`. */
export const deviceLimits=abuse=>Object.freeze({consume:(key,window)=>abuse.consume('device-v1:'+key,window)});
/** Dispatches each device operation through a short-lived app engine over `deviceGrant`. */
export function deviceGrantRunner({config,deviceGrant}){
 const run=async(Kind,input)=>{const engine=createAppEngine({providers:{config,deviceGrant,clock:systemClock,random:cryptoRandom,audit:nullAudit}});try{return await perform(engine,new Kind({input}));}finally{await engine.dispose();}};
 return Object.freeze({mounted:true,authorize:input=>run(DeviceAuthorize,input),token:input=>run(DeviceToken,input),cancel:input=>run(DeviceCancel,input),rpc:input=>run(DeviceRpc,input),review:input=>run(DeviceReview,input),approve:input=>run(DeviceApprove,input),drain:input=>run(DeviceLineageDrain,input)});
}
/** The provider over local owner shards (Node, and the Worker's owner FederationObject). */
export function localDeviceGrant({config,linked,shard,limits,pollLimits,jti=new MemoryJtiCache()}){
 return createDeviceGrantProvider({issuer:config.APP_ORIGIN,clients:federationClients(config),linked,shard,nonces:dpopNonces({secret:federationDpopSecret(config)}),limits,pollLimits,jti});
}
const fault=(code,message)=>Object.assign(new Error(message??code),{code});
const tokenOwner=authorization=>{const match=typeof authorization==='string'&&/^DPoP ([a-f0-9-]{36})\.[A-Za-z0-9_-]{43}$/.exec(authorization);return match&&UUID.test(match[1])?match[1]:null;};
/** Worker front: device endpoint, token polling and cancellation run here; every owner-shard step goes to that
 * owner's instance through `remote(owner, method, args)`. `active(owner)` is checked before waking an instance for a
 * caller-supplied locator (RPC), exactly as the Bearer path checks the account before routing. */
export function remoteDeviceGrant({config,linked,limits,pollLimits,jti,remote,active}){
 const provider=localDeviceGrant({config,linked,limits,pollLimits,jti,shard:()=>{throw fault('temporarily_unavailable','Device sign-in is not available.');}});
 const owned=input=>{const owner=input?.owner;if(typeof owner!=='string'||!UUID.test(owner))throw fault('unauthorized','Sign in to continue.');return owner;};
 // DeviceToken calls `this.issue`, so redemption continues in the owner's instance (reserve → activate → re-check).
 return Object.freeze({...provider,
  // A lost owner-shard call after redemption ends the reserved lineage, so no live lineage is left without a family.
  issue:async(linkedRequestId,grant,proof)=>{try{return await remote(grant.owner,'issue',[linkedRequestId,grant,proof]);}catch(error){if(typeof error?.code==='string'&&error.code!=='temporarily_unavailable')throw error;try{await linked.lineageRevoke({owner:grant.owner,lineageId:grant.lineageId});}catch{}throw fault('access_denied');}},
  review:input=>remote(owned(input),'review',[input]),approve:input=>remote(owned(input),'approve',[input]),drain:input=>remote(owned(input),'drain',[input]),
  async rpc(input){const owner=tokenOwner(input?.authorization);if(!owner||!await active(owner))throw fault('unauthorized','A DPoP access token is required.');return remote(owner,'rpc',[input]);}});
}
