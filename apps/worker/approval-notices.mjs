// LA7: injected after-approval port. The integrator supplies verified owner contacts;
// no account lookup, production delivery, or notification on pending requests is implied.
import {Action,Engine,Provider} from '../../vendor/ngin/index.js';
import {createLocalization} from '../../packages/i18n/index.mjs';
import {UUID} from '../../packages/core/primitives.mjs';
export function approvalNoticeTemplate(notice,{origin,locale='en'}={}){
 let url;try{url=new URL(origin);}catch{throw TypeError('Invalid approval notice origin.');}
 if(url.origin!==origin||url.protocol!=='https:'||url.username||url.password||!notice||notice.type!=='linked-approval'||!UUID.test(notice.owner??'')||!['app','session'].includes(notice.kind)||!Number.isSafeInteger(notice.approvedAt)||notice.approvedAt<=0||!(notice.kind==='app'&&notice.expiresAt===null)&&(!Number.isSafeInteger(notice.expiresAt)||notice.expiresAt<=notice.approvedAt))throw TypeError('Invalid approval notice.');
 const {t,date}=createLocalization({locale});let subject;
 if(notice.kind==='app'){
  const host=notice.subject?.host,parts=typeof host==='string'?/^([a-z0-9.-]{1,253})(?::([0-9]{1,5}))?$/i.exec(host):null;if(!parts||!parts[1].split('.').every(p=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(p))||parts[2]&&(+parts[2]<1||+parts[2]>65535))throw TypeError('Invalid approval notice host.');
  subject=host.toLowerCase();
 }else {if(!['tv','computer','phone'].includes(notice.subject?.deviceKind))throw TypeError('Invalid approval notice device.');subject=t({'tv':'a TV or shared screen','computer':'a computer','phone':'a phone'}[notice.subject.deviceKind]);}
 const when=value=>date(value,{dateStyle:'medium',timeStyle:'short',timeZone:'UTC'})+' UTC',path='/console?account='+notice.owner;
 const lifetime=notice.expiresAt===null?t('This sign-in is ongoing until you disconnect it. It ends after 180 days without a refresh.'):t('It ends at {date}.',{date:when(notice.expiresAt)});
 const title=t('You approved a sign-in'),body=[t('You approved a sign-in for {subject} at {date}.',{subject,date:when(notice.approvedAt)}),lifetime,t('Signing out the approving device also ends the sign-ins it approved.'),t('Not you? Review devices.')].join(' ');
 // Ignore the caller's consoleUrl: the configured HTTPS host is the only link authority.
 return {subject:title,text:body+'\n\n'+origin+path,push:{type:'bindle-approval-notice',owner:notice.owner,title,body,path}};
}
export class SendApprovalNotice extends Action {
 static deps=['approvalDelivery'];
 constructor(notice){super();this.notice=notice;}
 async execute({approvalDelivery:p},{dispatchFeed}){
  if(p.enabled!==true){dispatchFeed.dispatchEvent(new CustomEvent('result',{detail:{enabled:false}}));return;}
  // Validate before lookup, then format using the account's locale. Owner records
  // come from the host port, never from app metadata or the approval request.
  approvalNoticeTemplate(this.notice,{origin:p.origin});const owner=await p.owner(this.notice.owner),template=approvalNoticeTemplate(this.notice,{origin:p.origin,locale:owner?.locale});
  const attempts=[];
  if(typeof p.push?.send==='function')for(const subscription of owner?.subscriptions??[])attempts.push(Promise.resolve().then(()=>p.push.send(subscription,template.push)).then(()=>({channel:'push',accepted:true}),()=>({channel:'push',accepted:false})));
  if(owner?.verifiedEmail&&typeof p.mail?.sendApprovalNotice==='function')attempts.push(Promise.resolve().then(()=>p.mail.sendApprovalNotice({email:owner.verifiedEmail,notice:this.notice,locale:owner.locale})).then(result=>({channel:'email',accepted:typeof result?.messageId==='string'&&!!result.messageId}),()=>({channel:'email',accepted:false})));
  dispatchFeed.dispatchEvent(new CustomEvent('result',{detail:{enabled:true,attempts:await Promise.all(attempts)}}));
 }
}
export function createApprovalNotices(ports){const engine=new Engine({providers:{approvalDelivery:Provider.fromSingleton(ports)}});return {approved:notice=>engine.dispatch(new SendApprovalNotice(notice)).next('complete'),dispose:()=>engine.dispose()};}
/** Host composition: verified identity contact and the account dispatcher subscriptions, never request text. */
export function hostApprovalNotices({config,repository,accounts,mail,push}){
 if(config.DEVICE_AUTHORIZATION_ENABLED!=='true')return undefined;
 return createApprovalNotices({enabled:true,origin:config.APP_ORIGIN,mail,push,owner:async id=>{
  const owner=await repository.get(id);if(owner?.status!=='active')return null;
  const result=await accounts.get(id).invoke({method:'approvalNoticeContacts',args:[id]});if(result?.$fault)throw new Error('Notice contacts unavailable.');
  return {verifiedEmail:owner.emailVerifiedAt?owner.verifiedEmail:null,locale:owner.locale??'en',subscriptions:result?.subscriptions??[]};
 }});
}
