import {snapshot,publish} from './owner-flow.mjs';
import {activityDocument} from './activity-content.mjs';
// Keep every activity projection inside incoming: the existing account/offline teardown clears it.
// The integrator must project ACTIVITY_V2_ENABLED as activityV2Enabled in /api/config.
// Never probe new owner routes from a flag-off session: existing UI and authentication stay unchanged.
export const activityModel=s=>s.config?.activityV2Enabled===true&&s.incoming?.activityV2&&s.incoming.owner===s.session?.account?.id&&s.incoming.generation===(s.beamGeneration??0)?s.incoming:null;
export const activityEnabled=s=>s.config?.activityV2Enabled===true;
export const ACTIVITY_PAGE_SIZE=50;
const tags=value=>String(value??'').split(',').map(x=>x.trim()).filter(Boolean);
const checked=value=>value===true||value==='on';
const base=s=>activityModel(s)??{activityV2:true,owner:s.session?.account?.id,generation:s.beamGeneration??0,items:[],filters:{},facets:{apps:[],tags:[]},pages:[]};
const put=(r,ctx,patch)=>publish(r,ctx,{incoming:{...base(snapshot(r)),...patch}});
const policyInput=p=>{const {enabledAt,...input}=p;return {...input,rules:(p.rules??[]).map(({since,priority,...rule})=>({...rule,...priority?{priority}:{}}))};};
export async function loadActivity(r,ctx,{cursor=null,pages=[],filters}={}){
 const s=snapshot(r);if(!activityEnabled(s)||!s.session?.account?.id||s.offline)return false;
 const owner=s.session.account.id,generation=s.beamGeneration??0,ticket=r.browser.id(),before=activityModel(s),f=filters??before?.filters??{},q=new URLSearchParams({limit:String(ACTIVITY_PAGE_SIZE),archived:String(f.archived==='true')});
 for(const name of ['app','unread','state'])if(f[name])q.set(name,f[name]);if(f.app&&f.tag){q.set('tagApp',f.app);q.set('tag',f.tag);}if(cursor)q.set('cursor',cursor);
 const live=()=>snapshot(r).session?.account?.id===owner&&(snapshot(r).beamGeneration??0)===generation&&!snapshot(r).offline&&snapshot(r).incomingTicket===ticket;
 if(before)put(r,ctx,{detail:null,render:null,detailTicket:null,detailLoading:false,searchTicket:null,searchLoading:false});
 publish(r,ctx,{incomingTicket:ticket,incomingLoading:true,incomingError:''});
 try{const feed=await r.api.get('/api/activity?'+q);if(!live())return true;
  // Never accumulate pages: DOM, memory and per-page text work remain bounded.
  put(r,ctx,{items:(feed.items??[]).slice(0,ACTIVITY_PAGE_SIZE),facets:feed.facets??{apps:[],tags:[]},cursor:feed.cursor??null,pageCursor:cursor,pages,filters:f,tagsPage:0,detail:null,render:null,explanation:null,searchText:{},searchReady:false});publish(r,ctx,{incomingLoading:false});return true;
 }catch(error){if(!live())return true;if(error.status===401)throw error;put(r,ctx,{error:true});publish(r,ctx,{incomingLoading:false,incomingError:'Activity could not be loaded. Please try again.'});return true;}
}
async function loadPush(r,ctx){const ticket=r.browser.id();put(r,ctx,{pushTicket:ticket});const [push,apps]=await Promise.all([r.api.get('/api/notifications/activity'),r.api.get('/api/apps')]);if(activityModel(snapshot(r))?.pushTicket!==ticket)return;put(r,ctx,{push,pushStale:false,apps:(apps.apps??[]).filter(a=>a.transport==='bindle').slice(0,200)});}
export async function activityIntent(r,ctx,d){
 if(!activityEnabled(snapshot(r)))return;publish(r,ctx,{error:''});const feedTicket=snapshot(r).incomingTicket,m=activityModel(snapshot(r))??base(snapshot(r)),v=d.values??{},a=d.activityAction;
 if(a==='filter'){const filters={...m.filters,[d.field]:d.value};if(d.field==='app')delete filters.tag;await loadActivity(r,ctx,{filters});return;}
 if(a==='reload'||a==='next'||a==='previous'){if(a==='next'&&!m.cursor||a==='previous'&&!m.pages?.length)return;const pages=a==='next'?[...(m.pages??[]),m.pageCursor??null].slice(-100):a==='previous'?m.pages.slice(0,-1):[];await loadActivity(r,ctx,{cursor:a==='next'?m.cursor:a==='previous'?m.pages.at(-1):null,pages});return;}
 if(a==='facet-page'){put(r,ctx,{tagsPage:Math.max(0,Math.min(9,Number(d.page)||0))});return;}
 if(a==='local-filter'){if(['after','before','organization'].includes(d.field))put(r,ctx,{filters:{...m.filters,[d.field]:String(d.value??'').slice(0,256)}});return;}
 if(a==='close'){put(r,ctx,{detail:null,render:null,detailTicket:null,detailLoading:false,explanation:null});return;}
 if(a==='open'||a==='revision'){
  const id=d.id,ticket=r.browser.id(),view=snapshot(r).view;put(r,ctx,{detail:null,render:null,detailTicket:ticket,detailLoading:true,explanation:null});
  try{const detail=await r.api.get('/api/activity/'+encodeURIComponent(id)+(a==='revision'?'?revision='+encodeURIComponent(d.revision):''));if(activityModel(snapshot(r))?.detailTicket!==ticket||snapshot(r).view!==view)return;
   const content=detail.content,render=content?activityDocument(content):null;
   put(r,ctx,{detail,render,detailLoading:false});
   // Only the deliberately opened current content is acknowledged. History, search and refresh never mark read.
   if(a==='open'&&content?.revision===detail.revision&&!detail.read){try{const item=await r.api.request('/api/activity/'+encodeURIComponent(id),{revision:content.revision,read:true},'PATCH');if(activityModel(snapshot(r))?.detailTicket===ticket)put(r,ctx,{detail:{...detail,...item},items:base(snapshot(r)).items.map(i=>i.id===id?{...i,...item}:i)});}catch(error){if(error.code==='stale_revision'){if(activityModel(snapshot(r))?.detailTicket===ticket)put(r,ctx,{detail:{...detail,changed:true},render:null});}else throw error;}}
  }finally{if(activityModel(snapshot(r))?.detailTicket===ticket)put(r,ctx,{detailLoading:false});}return;
 }
 if(a==='mark'||a==='archive'){
  const item=m.items.find(i=>i.id===d.id)??(m.detail?.id===d.id?m.detail:null);if(!item)return;
  const changed=await r.api.request('/api/activity/'+encodeURIComponent(item.id),a==='mark'?{revision:item.revision,read:!item.read}:{archived:!item.archived},'PATCH');
  if(snapshot(r).incomingTicket!==feedTicket)return;
  put(r,ctx,{items:m.items.map(i=>i.id===item.id?{...i,...changed}:i).filter(i=>i.archived===(m.filters.archived==='true')),detail:m.detail?.id===item.id?{...m.detail,...changed}:m.detail});return;
 }
 if(a==='search'){
  const query=String(v.q??'').trim().slice(0,512),ticket=r.browser.id();put(r,ctx,{query,searchTicket:ticket,searchLoading:true});
  try{const text={};for(let offset=0;offset<m.items.length;offset+=5){const results=await Promise.all(m.items.slice(offset,offset+5).map(async item=>{const detail=await r.api.get('/api/activity/'+encodeURIComponent(item.id));const c=detail.content;return [item.id,{revision:detail.revision,subject:detail.subject,text:c?.mimeType==='text/plain'&&c.revision===detail.revision?c.body:''}];}));if(activityModel(snapshot(r))?.searchTicket!==ticket)return;Object.assign(text,Object.fromEntries(results));}put(r,ctx,{searchText:text,searchReady:true});}finally{if(activityModel(snapshot(r))?.searchTicket===ticket)put(r,ctx,{searchLoading:false});}return;
 }
 if(a==='push-load'){await loadPush(r,ctx);return;}
 if(!m.push||m.pushStale)return;
 const write=async(path,input)=>{try{await r.api.request(path,input,'PUT');}catch(error){put(r,ctx,{pushStale:true});throw error;}publish(r,ctx,{notice:'Push settings saved.'});try{await loadPush(r,ctx);}catch{put(r,ctx,{pushStale:true});throw Error('Your push choice was saved, but settings could not be reloaded. Reload push settings before editing again.');}};
 const input=policyInput(m.push.policy),save=policy=>write('/api/notifications/activity',policy);
 if(a==='pause'){await save({...input,paused:!input.paused});return;}
 if(a==='push-save'){await save({...input,enabled:checked(v.enabled),preview:checked(v.preview),quiet:{enabled:checked(v.quiet),startHour:Number(v.startHour),endHour:Number(v.endHour),timeZone:String(v.timeZone??'').trim()||null,utcOffsetMinutes:Number(v.utcOffsetMinutes)},digest:{cadence:v.cadence,hour:Number(v.hour)}});return;}
 if(a==='push-app'){const app=m.apps?.find(app=>app.id===d.id&&app.status==='active');if(!app)return;await write('/api/notifications/activity/apps/'+encodeURIComponent(d.id),{mode:v.mode,tags:v.mode==='selected'?tags(v.tags):[],route:v.route});return;}
 if(a==='push-device'){await write('/api/notifications/activity/devices/'+encodeURIComponent(d.id),{enrolled:checked(v.enrolled),preview:checked(v.preview)});return;}
 if(a==='rule-save'){const rule={id:d.ruleId??r.browser.id().replaceAll('-','').slice(0,32),app:v.app,route:v.route,tags:tags(v.tags),excludeTags:tags(v.excludeTags),minPriority:v.minPriority,...v.priority?{priority:v.priority}:{},quietBypass:checked(v.quietBypass)},rules=[...input.rules],at=rules.findIndex(x=>x.id===rule.id);if(at<0)rules.push(rule);else rules[at]=rule;await save({...input,rules});return;}
 if(a==='rule-delete'||a==='rule-up'){const rules=[...input.rules],at=rules.findIndex(x=>x.id===d.ruleId);if(at<0)return;if(a==='rule-delete')rules.splice(at,1);else if(at>0)[rules[at-1],rules[at]]=[rules[at],rules[at-1]];await save({...input,rules});return;}
 if(a==='mute-save'){const mute={app:v.app,...v.tag?.trim()?{tag:v.tag.trim()}:{}};await save({...input,mutes:[...input.mutes.filter(x=>x.app!==mute.app||x.tag!==mute.tag),mute]});return;}
 if(a==='mute-delete'){await save({...input,mutes:input.mutes.filter((_,i)=>i!==d.index)});return;}
 if(a==='explain'){if(m.detail?.id!==d.id)return;const ticket=m.detailTicket,explanation=await r.api.get('/api/notifications/activity/explain/'+encodeURIComponent(d.id));if(activityModel(snapshot(r))?.detailTicket===ticket&&activityModel(snapshot(r))?.detail?.id===d.id)put(r,ctx,{explanation});}
}
