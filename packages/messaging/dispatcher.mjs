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
