// Client side of event-bus pulls (docs/spec/events.md §3.2, §4.2, §6.2, §7.1) for provider- and integration-hosted
// buses, plus conformance hooks exercised by EV-4. Integration-hosted buses are pull-only
// in v1: no subscription is ever attempted through this client.
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const origin=value=>{try{return typeof value==='string'&&new URL(value).protocol==='https:'&&new URL(value).origin===value;}catch{return false;}};
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};

/**
 * `call(method, args)` performs one `event-bus/v1` RPC on the bus resource. `attestor` is the origin the consumer
 * called: the issuer, or `broker.origin` from its preferences v2 projection. Records whose `attested_by` differs are
 * discarded (§6.2). `brokered: {floorAt, history}` applies the `bindle.bus` claim locally as defence in depth: a
 * dishonest host could still fabricate records, which consent discloses. Delivery is deduplicated by `seq`.
 */
export function createBusReader({call,attestor,cursor:initial=null,brokered=null,limit,onGap}={}){
 if(typeof call!=='function'||typeof attestor!=='string'||!attestor)throw new TypeError('A bus RPC and the called origin are required.');
 if(brokered!==null&&(!plain(brokered)||!Number.isSafeInteger(brokered.floorAt)||brokered.floorAt<0||typeof brokered.history!=='boolean'))throw new TypeError('The verified brokered reader floor and history choice are required.');
 if(limit!==undefined&&(!Number.isSafeInteger(limit)||limit<1||limit>100))throw new TypeError('The read limit must be 1–100.');
 let cursor=initial,last=0;
 return {
  get cursor(){return cursor;},
  /** One pull. `wait` is a long-poll in seconds (0-25). Resolves {records, gap, head, oldest, discarded}. */
  async pull({wait=0}={}){
   if(!Number.isFinite(wait)||wait<0||wait>25)throw new TypeError('The read wait must be 0–25 seconds.');
   const args={...cursor?{cursor}:{start:'oldest'},...limit?{limit}:{},...wait?{wait}:{}};
   const result=await call('read',args),problems=readProblems(result,{limit:limit??50});if(problems.length)fail('invalid_result',`The bus host answered an invalid read (${problems[0]}).`);
   let discarded=0;const records=[];
   for(const record of result.records){
    if(record.attested_by!==attestor){discarded++;continue;}
    if(brokered&&brokered.history!==true&&!(record.published_at>brokered.floorAt)){discarded++;continue;}
    if(record.seq<=last){discarded++;continue;}last=record.seq;records.push(record);
   }
   cursor=result.cursor;if(result.gap)onGap?.(result.gap);
   return {records,gap:result.gap,head:result.head,oldest:result.oldest,discarded};
  },
  /** Publish under a caller-held transaction id. An `indeterminate` outcome must be retried with the SAME `tx`. */
  async publish(type,data,tx){const result=await call('publish',{type,data},tx),problems=publishProblems(result);if(problems.length)fail('invalid_result',`The bus host answered an invalid publish (${problems[0]}).`);return result;},
 };
}

// Conformance hooks (EV-4): pure checks a harness applies to any host's answers.
/** Problems with a `read` result, or [] (§4.2, §6.1). */
export function readProblems(result,{limit=50,floorSeq}={}){
 const problems=[];
 if(!plain(result))return ['result'];
 if(Object.keys(result).some(key=>!['records','cursor','head','oldest','gap'].includes(key)))problems.push('members');
 if(!Array.isArray(result.records)||result.records.length>limit)problems.push('records');
 if(typeof result.cursor!=='string'||!result.cursor||result.cursor.length>512)problems.push('cursor');
 for(const name of ['head','oldest'])if(result[name]!==null&&!(Number.isSafeInteger(result[name])&&result[name]>0))problems.push(name);
 if(result.gap!==null&&!(plain(result.gap)&&Object.keys(result.gap).length===2&&Number.isSafeInteger(result.gap.from)&&Number.isSafeInteger(result.gap.to)&&result.gap.from>0&&result.gap.from<=result.gap.to&&Number.isSafeInteger(result.head)&&result.gap.to<=result.head&&(result.oldest===null||result.gap.to<result.oldest)))problems.push('gap');
 if(result.oldest!==null&&(result.head===null||result.oldest>result.head))problems.push('oldest');
 let previous=result.gap?.to??0;
 for(const record of Array.isArray(result.records)?result.records:[]){
  if(!plain(record)||Object.keys(record).some(key=>!['seq','type','published_at','publisher','attested_by','data'].includes(key))||!Number.isSafeInteger(record.seq)||record.seq<=0||record.seq<=previous)problems.push('order');
  else previous=record.seq;
  if(typeof record?.type!=='string'||!/^[a-z][a-z0-9.-]{0,47}$/.test(record.type)||!Number.isSafeInteger(record?.published_at)||record.published_at<0||!origin(record?.attested_by)||record?.data===undefined)problems.push('record');
  const publisher=record?.publisher;
  if(!plain(publisher)||!['application','provider'].includes(publisher.kind)||publisher.kind==='application'&&(typeof publisher.client_id!=='string'||!publisher.client_id||!origin(publisher.origin)||Object.keys(publisher).some(key=>!['kind','client_id','origin'].includes(key)))||publisher.kind==='provider'&&(typeof publisher.feature!=='string'||!publisher.feature||Object.keys(publisher).some(key=>!['kind','feature'].includes(key))))problems.push('publisher');
  if(floorSeq!==undefined&&record?.seq<=floorSeq)problems.push('floor');
  if(result.head===null||record?.seq>result.head)problems.push('head');
  if(result.oldest===null||record?.seq<result.oldest)problems.push('oldest');
 }
 if(floorSeq!==undefined)for(const name of ['head','oldest'])if(result[name]!==null&&result[name]<=floorSeq)problems.push(`${name}-floor`);
 if(floorSeq!==undefined&&result.gap!==null&&result.gap?.from<=floorSeq)problems.push('gap-floor');
 return [...new Set(problems)];
}
/** Problems with a `publish` result (§4.1): an opaque receipt of at most 128 characters that is not a bare `seq`. */
export function publishProblems(result){
 const problems=[];if(!plain(result)||Object.keys(result).some(key=>!['receipt','published_at'].includes(key)))return ['members'];
 if(typeof result.receipt!=='string'||!result.receipt||result.receipt.length>128||/^\d+$/.test(result.receipt))problems.push('receipt');
 if(!Number.isSafeInteger(result.published_at)||result.published_at<0)problems.push('published_at');
 return problems;
}
/** Rules EV-4 asserts against integration-hosted (brokered) bus hosts, with the spec section each one comes from. */
export const BROKERED_BUS_RULES=Object.freeze([
 {id:'pull-only',section:'§3.2',rule:'subscribe and unsubscribe answer unsupported_method'},
 {id:'publish-introspects',section:'§3.2',rule:'every publish is introspected live without cached authorization'},
 {id:'floor-at',section:'§3.2',rule:'records at or before bindle.bus floor_at are never returned unless history is true'},
 {id:'attested-by',section:'§6.2',rule:'attested_by is the integration origin'},
 {id:'gap',section:'§4.2',rule:'retention loss is reported as a gap, never skipped silently'},
 {id:'receipt',section:'§4.1',rule:'publish receipts are opaque and never the global seq'},
 {id:'journal',section:'§4.1',rule:'publish journal kept at least min(24 h, max retention), never under 10 minutes'},
]);
