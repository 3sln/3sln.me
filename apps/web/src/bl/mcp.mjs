import {Query} from '../shared/stack.mjs';
import {OwnerFlow,snapshot,publish} from './owner-flow.mjs';
export class MCPState extends Query {
 static deps=['state'];
 boot({state},{notify,engineFeed}){this.feed=engineFeed;this.update=()=>{const s=state.snapshot();notify(s.mcpRequest);if(s.route.kind==='mcp-consent'&&s.session?.account&&!s.offline&&!s.busy&&!s.mcpRequest)engineFeed.dispatchEvent(new Event('mcp-request-opened'));};engineFeed.addEventListener('browser-state-updated',this.update);this.update();}
 kill(){this.feed.removeEventListener('browser-state-updated',this.update);}
}
export class LoadMCPRequest extends OwnerFlow {
 mutation=false;
 async perform(r,ctx){const requestId=r.browser.secret('requestId');publish(r,ctx,{mcpRequest:{phase:'loading'},error:''});if(!requestId){publish(r,ctx,{mcpRequest:{phase:'error'},error:'This connection request is missing. Return to the requesting app and try again.'});return;}try{const request=await r.api.get('/api/mcp/requests/'+encodeURIComponent(requestId));publish(r,ctx,{mcpRequest:{phase:'ready',request}});}catch{publish(r,ctx,{mcpRequest:{phase:'error'},error:'This connection request expired or could not be loaded. Return to the requesting app to start again.'});}}
}
export class DecideMCP extends OwnerFlow {
 async perform(r,ctx,d){const request=snapshot(r).mcpRequest?.request;if(!request||request.expiresAt<=Date.now())throw Error('This connection request expired. Return to the requesting app.');const permissions=[];if(!d.denied){const allowed=new Set(request.tools.map(t=>t.name));for(const c of request.collections){const tools=c.tools.filter(name=>allowed.has(name)&&d.values?.[`permission:${c.id}:${name}`]==='on');if(tools.length)permissions.push({collectionId:c.id,tools});}if(!permissions.length)throw Error('Select at least one collection permission, or deny the connection.');}
  const result=await r.api.request('/api/mcp/approve',{requestId:request.requestId,...d.denied?{denied:true}:{permissions}});
  // The response can append OAuth parameters only to the exact reviewed URI.
  const expected=new URL(request.client.redirectUri),target=new URL(result.redirectUri),oauthKeys=new Set(['code','state','iss','error']);if(!['https:','http:'].includes(target.protocol)||target.origin!==expected.origin||target.pathname!==expected.pathname||target.username||target.password||target.hash)throw Error('The app callback could not be verified.');for(const key of new Set(expected.searchParams.keys()))if(JSON.stringify(target.searchParams.getAll(key))!==JSON.stringify(expected.searchParams.getAll(key)))throw Error('The app callback could not be verified.');for(const key of new Set(target.searchParams.keys()))if(!expected.searchParams.has(key)&&(!oauthKeys.has(key)||target.searchParams.getAll(key).length!==1))throw Error('The app callback could not be verified.');if(target.searchParams.has('code')&&target.searchParams.has('error'))throw Error('The app callback could not be verified.');
  r.browser.storeSecret('requestId',null);publish(r,ctx,{mcpRequest:{phase:'complete'},notice:d.denied?'Connection denied.':'Connection approved.',error:''});r.browser.navigate(target.href);
 }
}
export class LoadMCPGrants extends OwnerFlow {mutation=false;async perform(r,ctx){publish(r,ctx,{mcpGrants:{phase:'loading'},error:''});try{const result=await r.api.get('/api/mcp/grants');publish(r,ctx,{mcpGrants:{phase:'ready',items:result.grants??[]}});}catch{publish(r,ctx,{mcpGrants:{phase:'error'},error:'Connected apps could not be loaded. Please try again.'});}}}
export class RevokeMCPGrant extends OwnerFlow {async perform(r,ctx,d){if(d.values?.confirmed!=='on')throw Error('Confirm that this app should lose access.');await r.api.request('/api/mcp/grants/'+encodeURIComponent(d.id),{},'DELETE');const result=await r.api.get('/api/mcp/grants');publish(r,ctx,{mcpGrants:{phase:'ready',items:result.grants??[]},notice:'App access revoked.',error:''});}}
