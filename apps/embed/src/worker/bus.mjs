// Partition bus schema (embed-islands §5.2). Same-origin provider code only (BroadcastChannel is partitioned by
// top-level site), but still schema-checked: a stale or buggy island must not corrupt another island's state.
import {AVATAR_BUCKETS} from '../../../../packages/sdk/src/islands-protocol.mjs';
const INSTANCE=/^[A-Za-z0-9_-]{22}$/,uint=value=>Number.isSafeInteger(value)&&value>=0;
const keys=(value,required,optional=[])=>Object.keys(value).every(k=>required.includes(k)||optional.includes(k))&&required.every(k=>Object.hasOwn(value,k));
const string=(value,max)=>typeof value==='string'&&value.length>0&&value.length<=max;
function view(value){
  if(!value||typeof value!=='object'||!keys(value,['id','subject','handle','name','delivered','avatars']))return null;
  if(!INSTANCE.test(value.id)&&!/^[A-Za-z0-9_-]{24}$/.test(value.id)||!(value.subject===null||string(value.subject,2048))||!string(value.handle,320)||!(value.name===null||string(value.name,200))||typeof value.delivered!=='boolean')return null;
  const avatars={};if(!value.avatars||typeof value.avatars!=='object')return null;
  for(const [bucket,blob] of Object.entries(value.avatars)){if(!AVATAR_BUCKETS.includes(Number(bucket))||!(blob instanceof Blob))return null;avatars[bucket]=blob;}
  return {id:value.id,subject:value.subject,handle:value.handle,name:value.name,delivered:value.delivered,avatars};
}
export function validateBus(data){
  if(!data||typeof data!=='object'||typeof data.type!=='string')return null;
  switch(data.type){
    case 'term':return keys(data,['type','term','instance'])&&uint(data.term)&&INSTANCE.test(data.instance)?data:null;
    case 'heartbeat':return keys(data,['type','term','seq'])&&uint(data.term)&&uint(data.seq)?data:null;
    case 'resign':return keys(data,['type','term'])&&uint(data.term)?data:null;
    case 'snapshot':{if(!keys(data,['type','term','seq','views','issuedAt'])||!uint(data.term)||!uint(data.seq)||!uint(data.issuedAt)||!Array.isArray(data.views)||data.views.length>8)return null;const views=data.views.map(view);return views.every(Boolean)?{...data,views}:null;}
    case 'hello':return keys(data,['type','instance','avatarBucket'])&&INSTANCE.test(data.instance)&&(data.avatarBucket===null||AVATAR_BUCKETS.includes(data.avatarBucket))?data:null;
    case 'credentials-changed':return keys(data,['type','instance'])&&INSTANCE.test(data.instance)?data:null;
    case 'forget':return keys(data,['type','instance'],['subject'])&&INSTANCE.test(data.instance)&&(!Object.hasOwn(data,'subject')||string(data.subject,2048))?data:null;
  }
  return null;
}
