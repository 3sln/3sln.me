import {isUUID as uuid} from '../core/primitives.mjs';
const LIFECYCLE_PHASES=Object.freeze({warning:'suspension-warning',suspended:'deletion-warning'});
/** One lifecycle notice attempt: push to every registered device and, when a
 * verified associated email exists, the fixed `accounts@` sender. Lifecycle
 * notices are account notices, not unread-message reminders, so message
 * notification preferences do not suppress them. Each channel is tried once per
 * attempt; the lifecycle executor owns spaced repetition. Acceptance means a
 * provider accepted the request, never that the owner read it. The payload and
 * mail carry no secret; links require signing in. */
export async function dispatchLifecycleNotice({push,mail,owner,phase,deletion=true,days,attemptId,email,subscriptions=[]}){
 if(typeof deletion!=='boolean'||!uuid(owner)||!uuid(attemptId)||!Object.hasOwn(LIFECYCLE_PHASES,phase)||!Number.isSafeInteger(days)||days<0||!Array.isArray(subscriptions))throw new TypeError('Invalid lifecycle notice');
 // With deletion disabled, a suspended account is retained indefinitely, so notices never announce a deletion date.
 const remaining=Math.max(1,Math.min(3650,days)),type=phase==='suspended'&&!deletion?'suspended-notice':LIFECYCLE_PHASES[phase],channels=[];let receipt=null,uncertain=false,suppressed=false;
 if(typeof push?.send==='function')for(const subscription of subscriptions.slice(0,10)){
  try{await push.send(subscription,{type:'bindle-account-notice',owner,phase,...type==='suspended-notice'?{deletion:false}:{},days:remaining,path:`/console?account=${owner}&lifecycle=review`});channels.push('push');receipt??=`push:${attemptId}`;}
  catch(error){if(![400,404,410].includes(error?.status))uncertain=true;}
 }
 if(email&&typeof mail?.sendAccountNotice==='function'){
  try{const result=await mail.sendAccountNotice({email,type,...type==='suspended-notice'?{}:{days:remaining},owner});if(typeof result?.messageId==='string'&&result.messageId){channels.push('email');receipt=`email:${result.messageId}`.slice(0,256);}}
  catch(error){if(error?.code==='E_RECIPIENT_SUPPRESSED')suppressed=true;else if(!['E_VALIDATION_ERROR','E_RECIPIENT_NOT_ALLOWED'].includes(error?.code))uncertain=true;}
 }
 if(receipt)return {accepted:true,receipt,channels:[...new Set(channels)]};
 return {outcome:uncertain?'unknown':'failed',...suppressed?{blocked:'suppressed'}:{}};
}
