// Exact implemented app message profile; forms use the shared content renderer. Public schemas are emitted from docs/artefacts.
export const APP_NOTIFICATIONS='https://3sln.me/artefacts/contracts/app-messages/v1';
export const APP_NOTIFICATION_PREFERENCES='https://3sln.me/artefacts/preferences/app-messages/v1';
export const APP_NOTIFICATION_MAX_BYTES=16384;
export function hasNotificationMethod(methods={}){return Object.values(methods).some(contracts=>contracts?.[APP_NOTIFICATIONS]?.includes('createOwn'));}
export function notificationInput(input,tx,now=Date.now()){
 const fail=(code,message,status=400)=>{throw Object.assign(new Error(message),{code,status});};
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['transactionId','createdAt','subject','body','mimeType','tags'].includes(k))||typeof input.transactionId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.transactionId)||input.transactionId!==tx||typeof input.subject!=='string'||!input.subject.trim()||Array.from(input.subject).length>120||typeof input.body!=='string'||!input.body.trim()||Array.from(input.body).length>12000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.subject+input.body))fail('invalid_args','Use a subject and message body with a stable transaction.');
 if(input.mimeType!==undefined&&!['text/plain','text/html'].includes(input.mimeType)||input.tags!==undefined&&(!Array.isArray(input.tags)||input.tags.length>31||input.tags.includes('app-message')||new Set(input.tags).size!==input.tags.length||input.tags.some(tag=>typeof tag!=='string'||!tag.trim()||Array.from(tag).length>64||/[\u0000-\u001f\u007f]/.test(tag))))fail('invalid_args','Use plain text or HTML and up to 31 distinct tags.');
 if(!Number.isSafeInteger(input.createdAt)||input.createdAt<=0||input.createdAt>now+60000||input.createdAt<=now-86400000)fail('operation_expired','This notification operation is invalid or expired.',409);
 if(new TextEncoder().encode(JSON.stringify(input)).byteLength>APP_NOTIFICATION_MAX_BYTES)fail('body_too_large','Notification content is limited to 16 KiB.',413);
 return {...structuredClone(input),mimeType:input.mimeType??'text/plain',tags:input.tags??[]};
}
