// BB-B5 metadata-only projection. Writers call projectIncoming/removeIncoming in their custody transaction;
// neither a View nor a query owns content, grants, receipts, shared read state or a conversation transcript.
import {canonical} from '../../core/primitives.mjs';
import {fault} from '../faults.mjs';
import {classificationOf} from '../domains/tags.mjs';
const ROW='bb:incoming:row/',OVERLAY='bb:incoming:organization/',REV='bb:incoming:revision',CURSORS='bb:incoming:cursors';
export const validItemId=id=>typeof id==='string'&&id.length>0&&id.length<=1024&&!/[\u0000-\u001f\u007f]/.test(id);
export const organizationFields=['tags','tagProvenance','tagHistory','tagSuppressed','automated','classificationResult','firedRules','classification','deliveryTags','deliveryCollection','quarantineReleased','quarantined','readAt','seenActivityRevision','organizationRevision','organizationOverrides','collection'];
const select=(item,fields)=>Object.fromEntries(fields.filter(k=>Object.hasOwn(item,k)).map(k=>[k,structuredClone(item[k])]));
export function organizationOf(item){
 const tags=[...new Set((item.tags??[]).map(t=>typeof t==='string'?t:t.id))],tagProvenance={...item.tagProvenance};
 for(const t of item.tags??[])if(typeof t==='object'&&t){const {id,...evidence}=t;tagProvenance[id]??=evidence;}
 const deliveryTags=item.deliveryTags??tags.filter(t=>['intake','sender','grant'].includes(tagProvenance[t]?.source));
 const out={...item,tags,tagProvenance,deliveryTags:[...deliveryTags],deliveryCollection:Object.hasOwn(item,'deliveryCollection')?item.deliveryCollection:item.collection??null,tagHistory:item.tagHistory??[],tagModel:1,organizationRevision:item.organizationRevision??1};
 out.classification=classificationOf(tags,tagProvenance);return out;
}
export async function mailboxTransaction(store,owner,enabled,work){
 if(enabled!==true)fault('not_found','BindleBox is disabled.',404);
 return store.transaction(async tx=>{if(await tx.get('owner')!==owner)fault('forbidden','Mailbox owner mismatch.',403);return work(tx);});
}
const failCursor=()=>fault('cursor_stale','Incoming changed. Refresh before continuing.',409);
const bump=async tx=>{const next=(await tx.get(REV)??0)+1;await tx.put(REV,next);return next;};
// Stable conversation IDs come from the conversation domain; each summary is projected once, never per event.
export async function projectIncoming(tx,item){
 if(!validItemId(item?.id)||!Number.isSafeInteger(item.receivedAt)||item.receivedAt<0)fault('invalid_input','Choose valid incoming metadata.',400);
 const prior=await tx.get(ROW+item.id),overlay=await tx.get(OVERLAY+item.id),m=organizationOf({...item,...overlay});
 const row={id:item.id,type:item.type??(item.kind==='conversation'?'conversation':'message'),subject:String(item.subject??'').slice(0,1000),origin:item.origin??'native',kind:item.kind??'one-off',receivedAt:item.receivedAt,activityAt:item.activityAt??item.receivedAt,activityRevision:item.activityRevision??prior?.activityRevision??0,state:item.state??'inbox',priority:item.priority??'normal',...select(m,organizationFields)};
 if(!['message','conversation'].includes(row.type)||!Number.isSafeInteger(row.activityAt)||row.activityAt<0||!Number.isSafeInteger(row.activityRevision)||row.activityRevision<0)fault('invalid_input','Choose valid incoming metadata.',400);
 // A read watermark never marks a later activity as seen. The conversation writer supplies a monotonic revision.
 if(m.seenActivityRevision!==undefined&&row.activityRevision>m.seenActivityRevision)row.readAt=null;
 if(canonical(prior)!==canonical(row)){await tx.put(ROW+item.id,row);await bump(tx);}return row;
}
export async function removeIncoming(tx,id){if(await tx.get(ROW+id)){await tx.delete(ROW+id);await bump(tx);}}
export async function saveOrganization(tx,item,m){
 const overlay={...select(m,organizationFields),...m.seenActivityRevision!==undefined?{seenActivityRevision:m.seenActivityRevision}:{}};
 if(item.type==='conversation'||item.kind==='conversation')await tx.put(OVERLAY+item.id,overlay);
 else await tx.put(`item/${item.id}`,{...item,...overlay,tags:m.tags.map(id=>({id,...m.tagProvenance?.[id]})),tagModel:1});
 return projectIncoming(tx,{...item,...overlay});
}
export async function incomingItem(tx,id){
 if(!validItemId(id))fault('invalid_input','Choose an incoming item.',400);
 const item=await tx.get(`item/${id}`)??await tx.get(ROW+id);if(!item)fault('not_found','That incoming item does not exist.',404);return item;
}
// Server-owned opaque continuations: random handles address a bounded mailbox-local cursor ledger. No caller
// supplied boundary, offset or predicate is executable. Any metadata change invalidates all older pages.
export async function incomingPage(tx,owner,query,random){
 const revision=await tx.get(REV)??0,signature=canonical({owner,filter:query.filter,sort:query.sort,view:query.view??null,viewRevision:query.viewRevision??null}),ledger=await tx.get(CURSORS)??[];
 let after=null;
 if(query.cursor!==undefined){const cursor=ledger.find(c=>c.token===query.cursor);if(!cursor||cursor.signature!==signature||cursor.revision!==revision)failCursor();after=cursor.after;}
 const f=query.filter,rows=[...(await tx.list({prefix:ROW})).values()],time=row=>query.sort==='received-desc'?row.receivedAt:row.activityAt;
 const compare=(a,b)=>time(b)-time(a)||(a.id<b.id?-1:a.id>b.id?1:0);
 const matches=row=>(!f.tagsAll||f.tagsAll.every(t=>row.tags.includes(t)))&&(f.read===undefined||Boolean(row.readAt!==null&&row.readAt!==undefined)===f.read)&&(!f.types||f.types.includes(row.type))&&(!f.classifications||f.classifications.includes(row.classification))&&(f.receivedAfter===undefined||row.receivedAt>=f.receivedAfter)&&(f.receivedBefore===undefined||row.receivedAt<f.receivedBefore);
 const matching=rows.filter(matches).sort(compare),page=matching.filter(row=>!after||compare(row,after)>0).slice(0,query.limit+1),more=page.length>query.limit;
 if(more)page.pop();let cursor=null;
 if(more){cursor=`${random.uuid()}.${random.uuid()}`;await tx.put(CURSORS,[...ledger,{token:cursor,signature,revision,after:{id:page.at(-1).id,receivedAt:page.at(-1).receivedAt,activityAt:page.at(-1).activityAt}}].slice(-128));}
 return {items:page,indexRevision:revision,cursor,total:matching.length};
}
