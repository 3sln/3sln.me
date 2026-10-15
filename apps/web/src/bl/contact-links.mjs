import {SYSTEM_TAGS,systemTag,reservedTag} from '../../../../packages/messaging/tags.mjs';
import {OwnerFlow,snapshot,publish} from './owner-flow.mjs';
// Owner intake editing (links §6.2): tags are mutable server-side configuration,
// so edits apply to future deliveries without reissuing the link.
const split=v=>String(v??'').split(',').map(x=>x.trim()).filter(Boolean);
const tagId=id=>typeof id==='string'&&id.length>0&&id.length<=64&&!/[\u0000-\u001f\u007f]/.test(id)&&(systemTag(id)?.kind==='final'||!reservedTag(id));
// One candidate list for rendering and parsing: configured tags in intake order, the owner's labelled tags, then final system tags.
export function tagCandidates(state,intake){const labels=state.data?.tagLabels?.labels??{},ids=[...intake?.autoTags??[],...intake?.optionalTags??[],...Object.keys(labels),...Object.values(SYSTEM_TAGS).filter(t=>t.kind==='final').map(t=>t.id)];return [...new Set(ids)].filter(tagId);}
// Sender-facing labels are per-link presentation: system tags use their localized label (never stored);
// user tags default to empty, never to the owner's private registry label.
export function senderLabel(state,intake,id){return systemTag(id)?'':intake?.labels?.[id]?.en??'';}
export function intakeFrom(values,candidates,prior={}){
 const autoTags=[],optionalTags=[],labels={};
 for(const id of candidates){const use=values['tag:'+id];if(use==='auto')autoTags.push(id);else if(use==='optional')optionalTags.push(id);}
 for(const id of split(values.autoTagsExtra))if(!autoTags.includes(id))autoTags.push(id);for(const id of split(values.optionalTagsExtra))if(!optionalTags.includes(id))optionalTags.push(id);
 if([...autoTags,...optionalTags].some(id=>!tagId(id)))throw new Error('Use tag names of up to 64 characters. Names starting with “sys:” are reserved.');
 if(autoTags.some(id=>optionalTags.includes(id)))throw new Error('A tag can be automatic or sender-selectable, not both.');
 if(autoTags.length+optionalTags.length>32)throw new Error('Use up to 32 tags in total.');
 // Other locales' labels are preserved; only the English label is edited here.
 for(const id of optionalTags){if(systemTag(id))continue;const {en,...others}=prior[id]??{},label=String(values['label:'+id]??en??'').trim();if(label.length>80)throw new Error('Keep sender-facing labels to 80 characters.');const next={...others,...label&&label!==id?{en:label}:{}};if(Object.keys(next).length)labels[id]=next;}
 return {autoTags,optionalTags,labels};
}
const contactURL=(r,url)=>{let u;try{u=new URL(url);}catch{throw Error('The new contact link could not be loaded.');}if(u.origin!==snapshot(r).config.origin||!/^\/users\/[^/]+\/contact\/[a-f0-9-]{36}$/.test(u.pathname))throw Error('The new contact link could not be loaded.');return u.href;};
async function reload(r,ctx){const data=await r.api.get('/api/account');publish(r,ctx,{data});}
export class CreateContactLink extends OwnerFlow{async perform(r,ctx,d){const v=d.values,s=snapshot(r),legacy=v.conversationInvites==='on',days=Number(v.days),maxMessages=Number(v.maxMessages),maxMessageBytes=Number(v.maxMessageBytes),{autoTags,optionalTags,labels}=intakeFrom(v,tagCandidates(s,null)),limits={expiresAt:r.browser.now()+days*86400000,maxMessages,maxMessageBytes,maxBytes:maxMessages*maxMessageBytes};
 // Conversation-v1 invitations still need a legacy ?sig= parent; every other new link is bindle_meta.
 const result=legacy?await r.api.request('/api/contacts',{name:v.name,requiredTags:autoTags,optionalTags,collections:[s.data?.collections?.find(c=>c.active!==false)?.id],mimeTypes:[v.mimeType,'application/vnd.3sln.conversation-invite+json'],...limits}):await r.api.request('/api/contact-links',{name:v.name,mimeTypes:[v.mimeType],autoTags,optionalTags,labels,...limits});
 await reload(r,ctx);publish(r,ctx,{modal:{kind:'share',contact:result.contact??result},notice:'Contact link created.'});}}
export class OpenIntake extends OwnerFlow{mutation=false;async perform(r,ctx,d){const contact=(snapshot(r).data?.contacts??[]).find(c=>c.id===d.id);if(!contact)return;const intake=await r.api.get(`/api/contacts/${encodeURIComponent(d.id)}/intake`);publish(r,ctx,{modal:{kind:'intake',contact,intake:intake??{revision:0,autoTags:[],optionalTags:[],labels:{}}},error:''});}}
export class SaveIntake extends OwnerFlow{async perform(r,ctx,d){const m=snapshot(r).modal;if(m?.kind!=='intake')return;const next=intakeFrom(d.values,tagCandidates(snapshot(r),m.intake),m.intake?.labels);
 try{await r.api.request(`/api/contacts/${encodeURIComponent(m.contact.id)}/intake`,{revision:m.intake.revision,...next},'PUT');}
 catch(error){if(error.code!=='intake_conflict')throw error;const intake=await r.api.get(`/api/contacts/${encodeURIComponent(m.contact.id)}/intake`);publish(r,ctx,{modal:{...m,intake}});throw Error('These tags changed in another window. Review the current settings and save again.');}
 await reload(r,ctx);publish(r,ctx,{modal:null,notice:'Tags updated. Future messages use them; the link itself is unchanged.'});}}
export class RotateChallenge extends OwnerFlow{async perform(r,ctx){const m=snapshot(r).modal;if(m?.kind!=='rotate')return;const result=await r.api.request(`/api/contacts/${encodeURIComponent(m.contact.id)}/rotate`,{});const url=contactURL(r,result?.url);await reload(r,ctx);publish(r,ctx,{modal:{kind:'share',contact:{...m.contact,url}},notice:'Challenge rotated. The previous link no longer works.'});}}
export class RestoreDefaultRule extends OwnerFlow{async perform(r,ctx,d){await r.api.request(`/api/rules/${encodeURIComponent(d.id)}/restore`,{});await reload(r,ctx);publish(r,ctx,{notice:'Default rule restored.'});}}
export class SaveTagLabel extends OwnerFlow{async perform(r,ctx,d){const v=d.values,label=String(v.label??'').trim(),id=String(v.id??'').trim(),registry=snapshot(r).data?.tagLabels;if(!label||label.length>64)throw Error('Use a label of up to 64 characters.');if(id&&!tagId(id))throw Error('Use tag names of up to 64 characters. Names starting with “sys:” are reserved.');await r.api.request('/api/tags/labels',{...id?{id}:{},label,...Number.isSafeInteger(registry?.revision)?{expectedRevision:registry.revision}:{}},'PUT');await reload(r,ctx);publish(r,ctx,{modal:null,notice:'Tag label saved. Messages keep their tags.'});}}
