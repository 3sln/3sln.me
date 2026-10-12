import {Query} from '../shared/stack.mjs';
import {OwnerFlow,snapshot,publish} from './owner-flow.mjs';
export function googleAuthorizationURL(value){
 let url;try{url=new URL(value);}catch{throw Error('Google authorization could not be opened. Please try again.');}
 if(url.protocol!=='https:'||url.hostname!=='accounts.google.com'||url.port||url.username||url.password||url.pathname!=='/o/oauth2/v2/auth'||url.hash)throw Error('Google authorization could not be opened. Please try again.');
 return url.href;
}
export class StartGoogleDrive extends OwnerFlow {
 async perform(r,ctx,d){
  if(snapshot(r).config.providers?.google?.enabled!==true&&snapshot(r).data?.providerCapabilities?.['google-drive']?.enabled!==true)throw Error('Google Drive is not configured on this service yet.');
  const name=String(d.values?.name??'').trim();if(!name||name.length>80)throw Error('Choose a connection name.');
  const resource=snapshot(r).modal?.resource;
  if(resource&&(resource.provider!=='google-drive'||!snapshot(r).data?.resources?.some(item=>item.id===resource.id&&item.provider==='google-drive')))throw Error('Refresh your resources before reconnecting Google Drive.');
  const result=await r.api.request('/api/integrations/google/start',{name,...resource?{resourceId:resource.id}:{}});
  const url=googleAuthorizationURL(result.authorizationUrl);
  if(r.current())r.browser.navigate(url);
 }
}
export class CompleteGoogleDrive extends OwnerFlow {
 async perform(r,ctx){
  const callback=r.browser.secret('googleDriveCallback');if(!callback)return;
  // Authorization material stays outside the Query model and is consumed once.
  r.browser.storeSecret('googleDriveCallback',null);
  publish(r,ctx,{view:'resources',modal:null,notice:'',error:''});
  try{
   if(typeof callback.state!=='string'||!callback.state.trim()||(!callback.code?.trim()&&!callback.error?.trim())||(callback.code&&callback.error))throw Error('This Google authorization return is incomplete. Connect Google Drive again.');
   const result=await r.api.request('/api/integrations/google/complete',callback);
   const data=await r.api.get('/api/account');
   publish(r,ctx,{data,notice:result.reconnected?'Google Drive reconnected. Your existing resource and file mappings are preserved.':'Google Drive connected. Apps can use files they create in this dedicated folder.',error:''});
  }catch(error){
   if(error.status===401)throw error;
   throw Error(callback.error==='access_denied'?'Google authorization was cancelled. Your other connections are unchanged.':'Google Drive could not be connected. Return to Resources and authorize a new connection.');
  }finally{for(const key of Object.keys(callback))callback[key]=null;}
 }
}
export class GoogleDriveReturn extends Query {
 static deps=['state','browser'];
 boot({state,browser},{engineFeed,notify}){
  this.feed=engineFeed;this.scheduled=false;
  this.publish=()=>{const s=state.snapshot();notify(!!browser.secret('googleDriveCallback'));if(this.scheduled||s.loading||s.busy||s.offline||!s.session?.account||!browser.secret('googleDriveCallback'))return;this.scheduled=true;queueMicrotask(()=>engineFeed.dispatchEvent(new Event('google-drive-returned')));};
  engineFeed.addEventListener('browser-state-updated',this.publish);this.publish();
 }
 kill(){this.feed.removeEventListener('browser-state-updated',this.publish);}
}
