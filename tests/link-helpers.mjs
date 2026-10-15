// Test helper (not a test file): identity-authored contact delivery for HTTP and runtime tests.
import {multipartDeliveryBody} from '../packages/messaging/contact-delivery-wire.mjs';
import {digest} from '../packages/messaging/store.mjs';
// `sign(input)` returns {envelope}: AccountController.authorLinkEnvelope or POST /api/links/envelope.
export async function authored(sign,link,{text='Hello',mimeType='text/plain',subject='',optionalTags=[],operationId=crypto.randomUUID(),createdAt}={}){
 const body=typeof text==='string'?new TextEncoder().encode(text):text,{envelope}=await sign({link,mimeType,subject,optionalTags,byteLength:body.byteLength,sha256:await digest(crypto,body),operationId,...createdAt===undefined?{}:{createdAt}});
 return {envelope,body,...multipartDeliveryBody(envelope,body)};
}
export const httpSigner=(request,headers)=>async input=>{const response=await request('/api/links/envelope',input,headers);if(response.status!==200)throw Object.assign(new Error(await response.text()),{status:response.status});return response.json();};
export const deliveryRequest=(url,{contentType,bytes},headers={})=>new Request(url,{method:'POST',headers:{'Content-Type':contentType,...headers},body:bytes});
