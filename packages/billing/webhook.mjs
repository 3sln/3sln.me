import {Webhook} from 'standardwebhooks';
import {BillingError,metadataPrefix} from './catalog.mjs';

export const MAX_WEBHOOK_BYTES = 262144;
export const BILLING_WEBHOOK_EVENTS=Object.freeze(['product.created','product.updated','customer.created','customer.updated','customer.deleted','customer.state_changed','subscription.created','subscription.updated','subscription.active','subscription.canceled','subscription.cycled','subscription.migrated','subscription.past_due','subscription.paused','subscription.resumed','subscription.revoked','subscription.uncanceled','order.paid','order.updated','order.refunded','refund.created','refund.updated']);
const handled=new Set(BILLING_WEBHOOK_EVENTS);
async function readBody(request){
  const declared=request.headers.get('content-length');
  if(declared&&(!/^\d+$/.test(declared)||Number(declared)>MAX_WEBHOOK_BYTES))throw new BillingError('webhook_too_large','Webhook exceeds its size limit.',413);
  const reader=request.body?.getReader();if(!reader)throw new BillingError('invalid_webhook','Webhook body is required.');
  const chunks=[];let total=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>MAX_WEBHOOK_BYTES){await reader.cancel();throw new BillingError('webhook_too_large','Webhook exceeds its size limit.',413);}chunks.push(value);}}
  finally{reader.releaseLock();}
  const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw new BillingError('invalid_webhook','Webhook encoding is invalid.');}
}
export async function verifyPolarWebhook(request,config){
  metadataPrefix(config);
  if(!config.POLAR_WEBHOOK_SECRET||!['sandbox','production'].includes(config.POLAR_SERVER)||config.POLAR_CATALOG_MODE==='metadata'&&!/^[A-Za-z0-9_-]{1,200}$/.test(config.POLAR_ORGANIZATION_ID||''))throw new BillingError('billing_unconfigured','Webhook configuration is incomplete.',503);
  if(!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))throw new BillingError('invalid_webhook','Webhook must contain JSON.',415);
  const body=await readBody(request),headers=Object.fromEntries(request.headers);
  const id=headers['webhook-id'];
  if(!id||!/^[A-Za-z0-9_-]{1,200}$/.test(id)||!/^\d{1,12}$/.test(headers['webhook-timestamp']||'')||headers['webhook-signature']?.length>4096)throw new BillingError('invalid_webhook_signature','Webhook authentication failed.',403);
  let raw;for(const key of [new TextEncoder().encode(config.POLAR_WEBHOOK_SECRET),config.POLAR_WEBHOOK_SECRET]){try{raw=new Webhook(key,typeof key==='string'?undefined:{format:'raw'}).verify(body,headers);break;}catch{}}if(!raw)throw new BillingError('invalid_webhook_signature','Webhook authentication failed.',403);
  if(typeof raw?.type!=='string'||raw.type.length>100)throw new BillingError('invalid_webhook','Webhook envelope is invalid.');
  if(!handled.has(raw.type))return {id,ignored:true};
  const data=raw.data;if(!data||typeof data!=='object'||Array.isArray(data))throw new BillingError('invalid_webhook','Webhook envelope is invalid.');
  const productEvent=raw.type.startsWith('product.'),refundEvent=raw.type.startsWith('refund.'),customerEvent=raw.type.startsWith('customer.'),owner=customerEvent?data.external_id:data.customer?.external_id,organizationId=data.organization_id??data.customer?.organization_id;
  if(config.POLAR_ORGANIZATION_ID&&organizationId&&organizationId!==config.POLAR_ORGANIZATION_ID)return {id,ignored:true};
  if(!productEvent&&!refundEvent&&(typeof owner!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(owner)))return {id,ignored:true};
  let event;try{const {webhooks}=await import('@polar-sh/sdk/2026-10');event=await webhooks.validateEvent(body,headers,config.POLAR_WEBHOOK_SECRET);}catch{throw new BillingError('invalid_webhook','Relevant webhook payload is malformed.',400);}
  const bounded=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,200}$/.test(value);if(!bounded(data.id)||!bounded(organizationId)||customerEvent&&data.active_subscriptions!==undefined&&(!Array.isArray(data.active_subscriptions)||data.active_subscriptions.length>100||data.active_subscriptions.some(subscription=>!subscription||typeof subscription!=='object'||!bounded(subscription.product_id)))||productEvent&&data.metadata!==undefined&&(!data.metadata||typeof data.metadata!=='object'||Array.isArray(data.metadata))||refundEvent&&(!bounded(data.order_id)||!bounded(data.customer_id))||!productEvent&&!refundEvent&&!customerEvent&&(raw.type.startsWith('subscription.')&&!bounded(data.product_id)||data.product_id!=null&&!bounded(data.product_id)||!bounded(data.customer_id)))throw new BillingError('invalid_webhook','Relevant webhook routing fields are malformed.',400);
  if(event.api_version!=='2026-10'||typeof event.timestamp!=='string'||!Number.isFinite(Date.parse(event.timestamp)))throw new BillingError('invalid_webhook','Webhook envelope is invalid.');
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(body));
  return {id,...productEvent?{catalog:true,productMetadata:data.metadata,organizationId,productId:data.id}:refundEvent?{refund:true,organizationId,orderId:data.order_id,customerId:data.customer_id}:{owner,organizationId,productId:data.product_id,productMetadata:data.product?.metadata,subscriptionId:raw.type.startsWith('subscription.')?data.id:data.subscription_id,customerId:customerEvent?data.id:data.customer_id,customerEvent,productIds:customerEvent?(data.active_subscriptions??[]).map(subscription=>subscription.product_id).filter(value=>typeof value==='string'):undefined},type:event.type,eventTimestamp:Date.parse(event.timestamp),bodyHash:Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('')};
}
