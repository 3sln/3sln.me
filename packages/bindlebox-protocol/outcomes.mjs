// Honest per-recipient outcomes (spec §7.3, §8.1, §8.3; architecture §9.3–§9.4). Only a verified custody receipt
// makes an obligation `delivered`; indeterminate transport outcomes are `unknown` and retried with the identical envelope.
import {LIMITS,ERRORS as STATUS_OF} from './constants.mjs';
import {malformed,plain,exact,text,detach} from './encoding.mjs';
import {validateReceipt} from './envelope.mjs';

export const OBLIGATION_STATES=Object.freeze({
 queued:{bucket:'pending',final:false},retry_scheduled:{bucket:'pending',final:false},in_progress:{bucket:'pending',final:false},unknown:{bucket:'pending',final:false},
 delivered:{bucket:'delivered',final:true},rejected:{bucket:'failed',final:true},expired:{bucket:'failed',final:true},cancelled:{bucket:'cancelled',final:true},
});
export const RETRY_REASONS=Object.freeze(['rate_limited','unreachable','unavailable','storage','epoch','moved','authorization']);
export const REJECT_CLASSES=Object.freeze(['not_authorized','invalid','too_large','participants_exceeded','author_unverifiable']);
const rejectClass=code=>code==='too_large'?'too_large':code==='participants_exceeded'?'participants_exceeded':code==='author_unverifiable'?'author_unverifiable':['not_authorized','link_invalid','audience_ineligible','author_required','record_forbidden'].includes(code)?'not_authorized':'invalid';

// Retry-After as a lower bound in ms; absent or malformed means 60 s (architecture §9.2).
export function retryAfterMs(value,now){
 if(typeof value==='string'&&/^[0-9]{1,9}$/.test(value))return Number(value)*1000;
 if(typeof value==='string'&&Number.isSafeInteger(now)){const at=Date.parse(value);if(Number.isFinite(at)&&/GMT$/.test(value))return Math.max(0,at-now);}
 return 60000;
}

// One attempt's failure -> next step. input: {transport?:'timeout'|'reset'|'network', status?, error?, retryAfter?,
// record?:boolean, knownRotation?:boolean, repaired?:boolean, linked?:boolean}. Results:
//  {action:'retry', state:'retry_scheduled'|'unknown', reason, notBefore?}  retryable until the deadline;
//  {action:'repair', reason}  one bounded re-resolve/renew, then the caller re-classifies with repaired:true;
//  {action:'terminal', state:'rejected', class}.
export function classifyFailure({transport,status,error,retryAfter,record=false,knownRotation=false,repaired=false,linked=!record,now}={}){
 // A timeout or reset may have committed: indeterminate, retried with the identical envelope, never a new operation.
 if(transport==='timeout'||transport==='reset')return {action:'retry',state:'unknown',reason:'unreachable'};
 if(transport)return {action:'retry',state:'retry_scheduled',reason:'unreachable'};
 if(status>=300&&status<400)return {action:'retry',state:'retry_scheduled',reason:'unreachable'};
 if(status===429)return {action:'retry',state:'retry_scheduled',reason:'rate_limited',notBefore:retryAfterMs(retryAfter,now)};
 if(status===503)return {action:'retry',state:'retry_scheduled',reason:error==='recipient_storage_unavailable'?'storage':'unavailable',notBefore:retryAfterMs(retryAfter,now)};
 if(status>=500||!Number.isSafeInteger(status))return {action:'retry',state:'unknown',reason:'unavailable'};
 if(status===404||status===410||error==='ingress_moved')return linked&&!repaired?{action:'repair',reason:'moved'}:linked?{action:'terminal',state:'rejected',class:'not_authorized'}:{action:'retry',state:'retry_scheduled',reason:'moved'};
 if(status===403&&record&&knownRotation&&error==='not_authorized')return {action:'retry',state:'retry_scheduled',reason:'epoch'};
 if(status===401||status===403)return repaired?{action:'terminal',state:'rejected',class:rejectClass(error)}:{action:'repair',reason:'authorization'};
 // Only explicit permanent refusals are terminal; any other status (2xx without a verified receipt, 1xx, 408, 425, 0) is indeterminate.
 return [400,409,413,415].includes(status)?{action:'terminal',state:'rejected',class:rejectClass(error)}:{action:'retry',state:'unknown',reason:'unavailable'};
}
// A late verified receipt resolves unknown/expired (and any pending state) to delivered; for a cancelled obligation it is
// recorded as delivered-before-cancel and never revives work; final states otherwise never move.
export function applyReceipt(state){
 if(!Object.hasOwn(OBLIGATION_STATES,state))malformed();
 if(state==='cancelled')return {state:'cancelled',deliveredBeforeCancel:true};
 if(state==='rejected')return {state:'rejected',lateReceipt:true};
 return {state:'delivered'};
}
export function aggregate(states){
 const out={delivered:0,pending:0,failed:0,cancelled:0};for(const s of states){if(!Object.hasOwn(OBLIGATION_STATES,s))malformed();out[OBLIGATION_STATES[s].bucket]++;}return out;
}

// Multicast response (§7.3) validated against the request: exactly one entry per context, in order. A whole-request
// failure leaves every context unresolved. `accepted-host` and `unknown` stay unresolved (pending reconciliation with
// the unchanged envelope); `delivered` still needs verifyReceipt; only `rejected` is classified.
export function parseMulticastResults(input,count){
 const body=detach(input);exact(body,['results']);if(!Array.isArray(body.results)||body.results.length!==count||count<1||count>LIMITS.maxBatchContexts)malformed();
 return body.results.map((r,index)=>{
  if(!plain(r)||r.index!==index)malformed();
  switch(r.state){
   case 'delivered':exact(r,['index','state','receipt']);validateReceipt(r.receipt,{allowLoopback:true});return {index,state:'delivered',receipt:r.receipt};
   case 'rejected':exact(r,['index','state','error']);if(!text(r.error,64,1)||!/^[a-z_]+$/.test(r.error))malformed();return {index,state:'rejected',error:r.error};
   case 'accepted-host':case 'unknown':exact(r,['index','state']);return {index,state:r.state};
   default:malformed();
  }
 });
}
// Maps validated multicast entries to obligation steps. Rejections classify as their individual §8.3 status would.
export function multicastOutcome(entry,{record=false,repaired=false,knownRotation=false,linked=!record}={}){
 if(entry.state==='delivered')return {action:'verify-receipt',receipt:entry.receipt};
 // A per-context result carries no status or Retry-After, so author_unverifiable (401 or retryable 503) stays unknown (review BR-3).
 if(entry.state==='rejected')return entry.error==='author_unverifiable'?{action:'retry',state:'unknown',reason:'authorization'}:classifyFailure({status:entry.error==='recipient_unavailable'?503:STATUS_OF[entry.error]??400,error:entry.error,record,repaired,knownRotation,linked});
 return {action:'retry',state:'unknown',reason:entry.state==='accepted-host'?'unavailable':'unreachable',reconcile:true};
}
