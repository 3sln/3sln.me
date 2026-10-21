// App-originated activity model (docs/spec/activity.md, docs/architecture/activity-center.md): input grammar,
// limits and the typed app-tag namespace. Pure and portable; storage lives in store.mjs, signing in evidence.mjs.
// The limits are provisional 3sln.me service choices (activity-center "New limits"), not Bindle wire constants.
import {validateContent} from '../content/render.mjs';
import {reservedTag} from '../messaging/tags.mjs';
import {UUID} from '../core/primitives.mjs';

export const ACTIVITY_PURPOSE='bindle-activity-admission-v1';
export const ACTIVITY_LIMITS=Object.freeze({
 requestBytes:16384,subject:120,body:12000,tags:31,
 operationWindow:86400000,futureSkew:60000,receiptRetention:2*86400000,
 // Live receipts: create/replace per app and per account; retractions have their own account bound (above the
 // retract lanes' two-day maximum) so admission traffic can never exhaust the capacity retraction needs.
 liveReceipts:256,appReceipts:128,retractReceipts:640,
 maxExpiry:90*86400000,revisions:32,items:2000,bytes:16*1048576,appItems:500,appBytes:4*1048576,rememberedTags:500,eventMembers:32,
 // Per app principal (survives reconnection) and per account aggregate; retraction has its own reserve.
 app:Object.freeze({minute:10,day:100}),account:Object.freeze({minute:30,day:300}),
 retract:Object.freeze({minute:5,day:100}),accountRetract:Object.freeze({minute:15,day:300}),
});
export const PRIORITIES=Object.freeze(['low','normal','urgent']);
export const APP_TAG=/^[a-z0-9][a-z0-9._-]{0,63}$/,COLLAPSE_KEY=/^[A-Za-z0-9._-]{1,64}$/;

export class ActivityFault extends Error{
 constructor(code,message=code,status=400,retryAfter){super(message);this.name='ActivityFault';this.code=code;this.status=status;if(retryAfter)this.retryAfter=retryAfter;}
}
export const fail=(code,message,status,retryAfter)=>{throw new ActivityFault(code,message,status,retryAfter);};
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&[Object.prototype,null].includes(Object.getPrototypeOf(x));
const controls=/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
// A subject sits beside trusted app attribution (feed, push, lock screen): no bidi embedding/override/isolate or line
// separators, and it must show something other than whitespace and default-ignorable characters.
const subjectUnsafe=/[\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/,invisible=/[\s\u00ad\u034f\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0]/gu;
const text=(value,max)=>typeof value==='string'&&value.trim()!==''&&Array.from(value).length<=max&&!controls.test(value);
const subjectText=value=>text(value,ACTIVITY_LIMITS.subject)&&!subjectUnsafe.test(value)&&value.replace(invisible,'')!=='';

/** A tag an app may assert. Anything resembling a host namespace (`sys:`, case/width/bidi look-alikes, any colon)
 * is refused outright rather than escaped: an app can never deliver a system or recipient tag. */
export function appTagId(tag){
 if(typeof tag!=='string')fail('invalid_args','Tags are lowercase identifiers.');
 if(reservedTag(tag)||/[:：﹕꞉∶]/.test(tag.normalize('NFKC')))fail('reserved_tag','Apps cannot set host or system tags.',403);
 if(!APP_TAG.test(tag))fail('invalid_args','Tags are lowercase identifiers of up to 64 characters.');
 return tag;
}
/** The qualified identity of an app tag: never equal to a system/owner tag or to the same local ID of another app. */
export const qualifiedTag=(app,id)=>Object.freeze({namespace:'app',app:principalOf(app),id});
export const principalOf=app=>`${app.issuer}#${app.clientId}`;

const FIELDS={
 create:['operationId','createdAt','subject','body','mimeType','tags','priority','collapseKey','expiresAt'],
 replace:['operationId','createdAt','item','expectedRevision','subject','body','mimeType','tags','priority','collapseKey','expiresAt'],
 retract:['operationId','createdAt','item','expectedRevision'],
};
/** Validates one app mutation request. Unknown members (a forged app, origin, sender, recipient, channel, system
 * tag or read state) are refused, never ignored. Returns the normalized operation with explicit defaults. */
export function activityInput(kind,input,{now,operationId}={}){
 if(!Object.hasOwn(FIELDS,kind))fail('unsupported_method','Unsupported activity operation.');
 if(!plain(input)||Object.keys(input).some(k=>!FIELDS[kind].includes(k)))fail('invalid_args','Use only the documented activity fields.');
 let size;try{size=new TextEncoder().encode(JSON.stringify(input)).byteLength;}catch{fail('invalid_args','Use a JSON activity request.');}
 if(size>ACTIVITY_LIMITS.requestBytes)fail('body_too_large','Activity requests are limited to 16 KiB.',413);
 if(typeof input.operationId!=='string'||!UUID.test(input.operationId)||operationId!==undefined&&input.operationId!==operationId)fail('invalid_args','Use a stable lowercase operation UUID.');
 if(!Number.isSafeInteger(input.createdAt)||input.createdAt<=now-ACTIVITY_LIMITS.operationWindow||input.createdAt>now+ACTIVITY_LIMITS.futureSkew)fail('operation_expired','This activity operation is invalid or expired.',409);
 const operation={kind,operationId:input.operationId,createdAt:input.createdAt};
 if(kind!=='create'){
  if(typeof input.item!=='string'||!UUID.test(input.item))fail('invalid_args','Choose an activity item.');
  if(!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<1)fail('invalid_args','Give the expected current revision.');
  Object.assign(operation,{item:input.item,expectedRevision:input.expectedRevision});
 }
 if(kind==='retract')return operation;
 if(!subjectText(input.subject)||!text(input.body,ACTIVITY_LIMITS.body))fail('invalid_args','Use a nonempty subject (120 characters) and body (12,000 characters).');
 const mimeType=input.mimeType??'text/plain';if(!['text/plain','text/html'].includes(mimeType))fail('invalid_args','Use text/plain or text/html.');
 try{validateContent(mimeType,new TextEncoder().encode(input.body));}catch{fail('invalid_args','Use strict UTF-8 text.');}
 const tags=input.tags??[];if(!Array.isArray(tags)||tags.length>ACTIVITY_LIMITS.tags)fail('invalid_args','Use up to 31 distinct tags.');
 tags.forEach(appTagId);if(new Set(tags).size!==tags.length)fail('invalid_args','Use up to 31 distinct tags.');
 const priority=input.priority??'normal';if(!PRIORITIES.includes(priority))fail('invalid_args','Priority is low, normal or urgent.');
 const collapseKey=input.collapseKey??null;if(collapseKey!==null&&(typeof collapseKey!=='string'||!COLLAPSE_KEY.test(collapseKey)))fail('invalid_args','Use a collapse key of up to 64 ASCII letters, digits, dots, underscores or hyphens.');
 const expiresAt=input.expiresAt??null;if(expiresAt!==null&&!Number.isSafeInteger(expiresAt))fail('invalid_args','Expiry is an absolute UTC time in milliseconds.');
 return Object.assign(operation,{content:{subject:input.subject,body:input.body,mimeType,tags:[...tags],priority,collapseKey,expiresAt}});
}
/** Expiry is checked against the admission time, inside the admitting transaction's clock reading. */
export function checkExpiry(expiresAt,admittedAt){if(expiresAt!==null&&(expiresAt<=admittedAt||expiresAt>admittedAt+ACTIVITY_LIMITS.maxExpiry))fail('invalid_expiry','Expiry must be in the future and at most 90 days ahead.');}
