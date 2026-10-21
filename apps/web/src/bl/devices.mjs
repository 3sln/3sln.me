// LA7: owner-session lineage and preference grants. No token-family endpoint is invented here.
import {Query} from '../shared/stack.mjs';
import {OwnerFlow,snapshot,publish} from './owner-flow.mjs';
import {clearBrowserAccount,accountReset} from './account-context.mjs';
export const devicesEnabled=state=>state.config?.deviceAuthorizationEnabled===true;
export function deviceInventory(state){
 const devices=Array.isArray(state.data?.devices)?state.data.devices:[],grants=state.mcpGrants?.bindle??state.data?.grants??[];
 return {devices,grants:[...(state.data?.appSessions??[]).map(s=>({...s,session:true})),...Array.isArray(grants)?grants.filter(g=>g.active):[]],current:devices.find(d=>d.current)??null};
}
export function revocationImpact(state,ids){
 const {devices,grants}=deviceInventory(state),removed=new Set(ids),ancestors=new Set();let changed=true;
 while(changed){changed=false;for(const d of devices)if(d.approvedFrom&&removed.has(d.approvedFrom)&&!removed.has(d.id)){removed.add(d.id);changed=true;}}
 for(const d of devices.filter(d=>d.current)){let parent=d.approvedFrom;while(parent&&!ancestors.has(parent)){ancestors.add(parent);parent=devices.find(d=>d.id===parent)?.approvedFrom;}}
 return {devices:devices.filter(d=>removed.has(d.id)),apps:grants.filter(g=>removed.has(g.approvedFrom)),current:devices.some(d=>d.current&&removed.has(d.id)),ancestors:[...ancestors]};
}
export function otherDeviceIds(state){const {devices,current}=deviceInventory(state),ancestors=revocationImpact(state,[]).ancestors;return devices.filter(d=>!d.current&&!ancestors.includes(d.id)&&d.id!==current?.id).map(d=>d.id);}
export class DevicesView extends Query {
 static deps=['state'];
 boot({state},{notify,engineFeed}){this.feed=engineFeed;this.publish=()=>{const s=state.snapshot();notify(devicesEnabled(s)&&!s.offline&&s.session?.account?deviceInventory(s):null);};this.feed.addEventListener('browser-state-updated',this.publish);this.publish();}
 kill(){this.feed.removeEventListener('browser-state-updated',this.publish);}
}
let grantRead=0;
const savedStale='Access was revoked, but the latest information could not be loaded. Refresh before making another change.';
async function reload(r,ctx,text){publish(r,ctx,{modal:null,notice:text,error:''});r.browser.restoreFocus?.();try{const data=await r.api.get('/api/account');publish(r,ctx,{data});}catch{publish(r,ctx,{error:savedStale});}}
function confirmation(s,detail,kind){if(devicesEnabled(s)&&(s.modal?.kind!==kind||detail.confirmed!==true))throw Error('Review and confirm what will lose access.');}
export class RevokeDeviceAccess extends OwnerFlow {
 async perform(r,ctx,d){const s=snapshot(r);confirmation(s,d,'revoke-device');if(devicesEnabled(s)&&s.modal.device?.id!==d.sessionId)throw Error('Refresh devices before making this change.');const result=await r.api.request('/api/auth/devices/revoke',{sessionId:d.sessionId});
  if(result.currentSessionRevoked){clearBrowserAccount(r);publish(r,ctx,{...accountReset(snapshot(r)),accountPicker:false,notice:'Device sessions revoked. Sign in again.',error:''});return;}await reload(r,ctx,'Device session revoked.');}
}
export class RevokeOtherDeviceAccess extends OwnerFlow {
 async perform(r,ctx,d){confirmation(snapshot(r),d,'revoke-other-devices');await r.api.request('/api/auth/devices/revoke-others',{});await reload(r,ctx,'Other devices signed out.');}
}
export class RevokeAppAccess extends OwnerFlow {
 async perform(r,ctx,d){const s=snapshot(r);if(!devicesEnabled(s)){await r.api.request('/api/grants/'+encodeURIComponent(d.id),{},'DELETE');await reload(r,ctx,'App access revoked.');return;}
  confirmation(s,d,d.all?'revoke-all-apps':'revoke-app');const grants=deviceInventory(s).grants,ids=d.all?s.modal.ids:[d.id];
  if(!Array.isArray(ids)||!ids.length||ids.some(id=>!grants.some(g=>g.id===id))||!d.all&&s.modal.grant?.id!==d.id)throw Error('Refresh connected apps before making this change.');
  const ticket='devices-'+(++grantRead);if(s.mcpGrants)publish(r,ctx,{mcpGrants:{...s.mcpGrants,phase:'ready',requestId:ticket}});
  // Each grant is a separate server transaction. Publish each success immediately;
  // a later failure must not make already-revoked access look live or retry it.
  for(const id of ids){await r.api.request((grants.find(g=>g.id===id)?.session?'/api/app-sessions/':'/api/grants/')+encodeURIComponent(id),{},'DELETE');const next=snapshot(r),data=next.data?{...next.data,grants:(next.data.grants??[]).filter(g=>g.id!==id),appSessions:(next.data.appSessions??[]).filter(g=>g.id!==id)}:null,mcp=next.mcpGrants;publish(r,ctx,{data,...mcp?{mcpGrants:{...mcp,bindle:(mcp.bindle??[]).filter(g=>g.id!==id)}}:{},modal:null,notice:'App access revoked.',error:''});}
  r.browser.restoreFocus?.();try{if(grants.some(g=>g.session)){await reload(r,ctx,'App sign-in revoked.');return;}const result=await r.api.get('/api/grants'),next=snapshot(r);if(next.mcpGrants&&next.mcpGrants.requestId!==ticket)return;publish(r,ctx,{...next.mcpGrants?{mcpGrants:{...next.mcpGrants,bindle:result.grants??[]}}:{data:{...next.data,grants:result.grants??[]}}});}catch{publish(r,ctx,{error:savedStale});}
 }
}
