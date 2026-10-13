import {assertBillingConfiguration,assertOwner,BillingError,metadataPrefix} from './catalog.mjs';

export const MAX_WEBHOOK_BYTES = 262144;
const handled = /^(customer\.(?:created|updated|deleted|state_changed)|subscription\.[a-z_]+|order\.(?:paid|refunded|updated))$/;
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
  let event;
  try{const {webhooks}=await import('@polar-sh/sdk/2026-10');event=await webhooks.validateEvent(body,headers,config.POLAR_WEBHOOK_SECRET);}
  catch(error){throw new BillingError(error.name==='PolarWebhookUnknownTypeError'?'unsupported_webhook':'invalid_webhook_signature','Webhook authentication or event validation failed.',403);}
  if(event.api_version!=='2026-10'||typeof event.timestamp!=='string'||!Number.isFinite(Date.parse(event.timestamp))||!event.data||typeof event.data!=='object')throw new BillingError('invalid_webhook','Webhook envelope is invalid.');
  const productEvent=['product.created','product.updated'].includes(event.type),refundEvent=['refund.created','refund.updated'].includes(event.type);if(!handled.test(event.type)&&!productEvent&&!refundEvent)return {id,ignored:true};
  // Metadata and email never identify an account. Only Polar's dedicated,
  // immutable customer external_id is a routing hint; reconciliation rechecks it.
  const owner=event.type.startsWith('customer.')?event.data.external_id:event.data.customer?.external_id;
  if(!productEvent&&!refundEvent){assertBillingConfiguration(config);assertOwner(owner);}
  if((productEvent||refundEvent)&&config.POLAR_ORGANIZATION_ID&&event.data.organization_id!==config.POLAR_ORGANIZATION_ID)throw new BillingError('webhook_organization_mismatch','Webhook belongs to a different organization.',403);
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(body));
  return {id,...productEvent?{catalog:true,organizationId:event.data.organization_id,productId:event.data.id}:refundEvent?{refund:true,organizationId:event.data.organization_id,orderId:event.data.order_id,customerId:event.data.customer_id}:{owner},type:event.type,eventTimestamp:Date.parse(event.timestamp),bodyHash:Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('')};
}
