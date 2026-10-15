// Transport policy stays independent of Workers and browser push.
// Delivery resources receive stable attempt keys; provider deduplication is
// optional, so ambiguous transport failures can still produce duplicates.
// Push previews require owner opt-in; email content remains generic.
// Preview withdrawal is checked again before each claimed push delivery.
export class NotificationDispatcher {
 constructor({notifications,push,email,recipient,payloads}){if(email&&!payloads?.getOrCreate)throw new TypeError('Email delivery requires durable, encrypted retry payloads.');Object.assign(this,{notifications,push,email,recipient,payloads});}
 async dispatch(owner){
  const results=[];
  for(let count=0;count<10;count++){
   const [job]=await this.notifications.claimDue(owner,{limit:1,leaseMs:300000});if(!job)break;
   let delivered=false,gone=false;
   try{
    if(!await this.notifications.authorizeDelivery(owner,job.id,job.lease))continue;
    const idempotencyKey=`${job.id}:${job.delivered+1}`;
    if(job.channel==='push'&&this.push){const label=job.preview&&job.payload.owner===owner?(await this.recipient?.current?.(owner))?.handle:null;await this.push.send(job.subscription,typeof label==='string'&&label.length<=100?{...job.payload,accountLabel:label}:job.payload,{idempotencyKey});delivered=true;}
    if(job.channel==='email'&&this.email){const target=await this.recipient.current(owner);if(target?.verifiedEmail){const payload=await this.payloads.getOrCreate(idempotencyKey,async()=>({email:target.verifiedEmail,owner,token:await this.notifications.issueUnsubscribe(owner,'email'),idempotencyKey}));if(payload.email===target.verifiedEmail){await this.email.sendReminder(payload);delivered=true;}}}
   }catch(error){gone=job.channel==='push'&&[404,410].includes(error.status);}
   finally{try{await this.notifications.finish(owner,job.id,job.lease,{delivered,gone});}catch(error){if(error.code!=='stale_lease')throw error;}}
   results.push({id:job.id,delivered,gone});
  }
  return results;
 }
}

const LIFECYCLE_PHASES=Object.freeze({warning:'suspension-warning',suspended:'deletion-warning'});
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
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
