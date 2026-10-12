import webpush from 'web-push';
export { mailTransport } from './email.mjs';
export function pushTransport(env){
 if(!env.VAPID_PUBLIC_KEY||!env.VAPID_PRIVATE_KEY)return null;
 return {async send(subscription,payload){const details=webpush.generateRequestDetails(subscription,JSON.stringify(payload),{TTL:300,urgency:'normal',vapidDetails:{subject:env.APP_ORIGIN,publicKey:env.VAPID_PUBLIC_KEY,privateKey:env.VAPID_PRIVATE_KEY}});const response=await fetch(details.endpoint,{method:details.method,headers:details.headers,body:details.body,redirect:'error',signal:AbortSignal.timeout(10000)});if(!response.ok)throw Object.assign(new Error('Push provider rejected delivery.'),{status:response.status});}};
}
