import { fail, key, boundedString, base64url, digest, fromBase64url } from './store.mjs';
import { UUID_V4, canonical } from '../core/primitives.mjs';
import {Provider} from '../../vendor/ngin/index.js';
import {AppAction,AppQuery,ownerOf} from '../app/engine.mjs';
import {AppFault} from '../app/faults.mjs';
import {activityState} from '../activity/store.mjs';

export const defaultNotificationPreferences = () => ({
  enabled: true, push: { enabled: false, preview: false },
  email: { enabled: false, delayMinutes: 60, repeatHours: 24, maxReminders: 3 },
  collections: [], excludeTags: [],
  quiet: { enabled: false, startHour: 22, endHour: 8, utcOffsetMinutes: 0 },
});
const validatePreferences = preferences => {
  const defaults = defaultNotificationPreferences();
  if (!preferences || Object.keys(preferences).some(name => !Object.hasOwn(defaults, name)) || typeof preferences.enabled !== 'boolean' || typeof preferences.push?.enabled !== 'boolean' || typeof preferences.email?.enabled !== 'boolean' || typeof preferences.quiet?.enabled !== 'boolean') fail('invalid_preferences');
  for (const group of ['push', 'email', 'quiet']) if (Object.keys(preferences[group]).some(name => !Object.hasOwn(defaults[group], name))) fail('invalid_preferences');
  if(preferences.push.preview!==undefined&&typeof preferences.push.preview!=='boolean')fail('invalid_preferences');
  const { delayMinutes, repeatHours, maxReminders } = preferences.email;
  const { startHour, endHour, utcOffsetMinutes } = preferences.quiet;
  if (!Number.isInteger(delayMinutes) || delayMinutes < 5 || delayMinutes > 10080 || !Number.isInteger(repeatHours) || repeatHours < 1 || repeatHours > 720 || !Number.isInteger(maxReminders) || maxReminders < 1 || maxReminders > 10 || !Number.isInteger(startHour) || startHour < 0 || startHour > 23 || !Number.isInteger(endHour) || endHour < 0 || endHour > 23 || !Number.isInteger(utcOffsetMinutes) || utcOffsetMinutes < -720 || utcOffsetMinutes > 840) fail('invalid_preferences');
  for (const field of ['collections', 'excludeTags']) if (!Array.isArray(preferences[field]) || preferences[field].length > 100 || preferences[field].some(value => !boundedString(value)) || new Set(preferences[field]).size !== preferences[field].length) fail('invalid_preferences');
};
// ACT-2: activity push is prospective from the moment the account push channel turns (back) on.
const channelOn=p=>p?.enabled===true&&p.push?.enabled===true;
const markChannel=async(tx,owner,before,after,now)=>{if(!channelOn(before)&&channelOn(after))await tx.set(key('activity-push-channel',owner),{enabledAt:now});};
const quietNow = (quiet, now) => {
  if (!quiet.enabled) return false;
  const hour = new Date(now + quiet.utcOffsetMinutes * 60000).getUTCHours();
  if (quiet.startHour === quiet.endHour) return true;
  return quiet.startHour < quiet.endHour ? hour >= quiet.startHour && hour < quiet.endHour : hour >= quiet.startHour || hour < quiet.endHour;
};

export class NotificationService {
  constructor({ store, messageAllowed = async()=>true, crypto = globalThis.crypto, clock = () => Date.now(), allowedPushOrigins = ['https://fcm.googleapis.com', 'https://updates.push.services.mozilla.com', 'https://web.push.apple.com'] }) { Object.assign(this, { store, messageAllowed, crypto, clock, allowedPushOrigins }); }
  async preferences(owner) { return this.store.transaction(async tx => await tx.get(key('notification-preferences', owner)) || defaultNotificationPreferences()); }
  async setPreferences(owner, preferences, { verifiedEmail = false } = {}) {
    validatePreferences(preferences);
    if (preferences.email.enabled && !verifiedEmail) fail('verified_email_required');
    return this.store.transaction(async tx => {
      for (const id of preferences.collections) if (!(await tx.get(key('collection', owner, id)))?.active) fail('invalid_collection');
      await markChannel(tx, owner, await tx.get(key('notification-preferences', owner)) || defaultNotificationPreferences(), preferences, this.clock());
      await tx.set(key('notification-preferences', owner), preferences); return preferences;
    });
  }
  async subscribe(owner, { endpoint, keys }, label = 'This device', {enable=false}={}) {
    let url; try { url = new URL(endpoint); } catch { fail('invalid_subscription'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || endpoint.length > 2048 || !this.allowedPushOrigins.includes(url.origin) || !boundedString(label, 100)) fail('invalid_subscription');
    if (!keys || fromBase64url(keys.p256dh).length !== 65 || fromBase64url(keys.auth).length !== 16) fail('invalid_subscription');
    const id = await digest(this.crypto, endpoint);
    return this.store.transaction(async tx => {
      const all = await tx.list(key('push-subscription', owner));
      if (all.length >= 10 && !all.some(row => row.value.id === id)) fail('subscription_limit');
      if(enable){const preferences=await tx.get(key('notification-preferences',owner))??defaultNotificationPreferences();validatePreferences(preferences);await markChannel(tx,owner,structuredClone(preferences),{enabled:true,push:{enabled:true}},this.clock());preferences.enabled=true;preferences.push.enabled=true;await tx.set(key('notification-preferences',owner),preferences);}
      await tx.set(key('push-subscription', owner, id), { id, owner, endpoint, keys, label, createdAt: this.clock() });
      return { id, label };
    });
  }
  async subscriptions(owner) { return this.store.transaction(async tx => (await tx.list(key('push-subscription', owner))).map(({ value: { id, label, createdAt } }) => ({ id, label, createdAt }))); }
  async unsubscribeDevice(owner, id) { return this.store.transaction(tx => tx.delete(key('push-subscription', owner, id))); }
  async issueUnsubscribe(owner, channel = 'email') {
    if (!['email', 'push', 'all'].includes(channel)) fail('invalid_channel');
    const token = base64url(this.crypto.getRandomValues(new Uint8Array(32)));
    const tokenHash = await digest(this.crypto, token);
    await this.store.transaction(tx => tx.set(key('notification-unsubscribe', tokenHash), { owner, channel, expiresAt: this.clock() + 366 * 86400000 }));
    return token;
  }
  async unsubscribe(token) {
    if (typeof token !== 'string' || token.length !== 43) fail('invalid_unsubscribe');
    const tokenHash = await digest(this.crypto, token);
    return this.store.transaction(async tx => {
      const record = await tx.get(key('notification-unsubscribe', tokenHash));
      if (!record || record.expiresAt <= this.clock()) fail('invalid_unsubscribe');
      const preferences = await tx.get(key('notification-preferences', record.owner)) || defaultNotificationPreferences();
      if (record.channel === 'all') preferences.enabled = false; else preferences[record.channel].enabled = false;
      await tx.set(key('notification-preferences', record.owner), preferences);
      return { unsubscribed: true }; // No account identity or email disclosure.
    });
  }
  async eligible(tx, owner, event, channel, now) {
    const message = await tx.get(key('message', owner, event.messageId));
    const preferences = await tx.get(key('notification-preferences', owner)) || defaultNotificationPreferences();
    if (!message || !await this.messageAllowed(tx,owner,message) || message.readAt !== null || message.quarantined || !preferences.enabled || !preferences[channel].enabled || quietNow(preferences.quiet, now) || (preferences.collections.length && !preferences.collections.includes(message.collection)) || message.tags.some(tag => preferences.excludeTags.includes(tag))) return null;
    return { message, preferences };
  }
  async claimDue(owner, { limit = 20, leaseMs = 60000 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(leaseMs) || leaseMs < 1000 || leaseMs > 300000) fail('invalid_limit');
    return this.store.transaction(async tx => {
      const result = []; const now = this.clock();
      for (const { value: event } of await tx.list(key('notification-event', owner))) {
        for (const channel of ['push', 'email']) {
          const eligible = await this.eligible(tx, owner, event, channel, now); if (!eligible) continue;
          const subscriptions = channel === 'push' ? (await tx.list(key('push-subscription', owner))).map(row => row.value) : [null];
          for (const subscription of subscriptions) {
            if (result.length >= limit) return result;
            if(channel==='email'){const state=await tx.get(key('notification-email-budget',owner));if(state&&(state.nextAt>now||state.leaseUntil>now))continue;if(result.some(job=>job.channel==='email'))continue;}
            const id = `${event.id}:${channel}:${subscription?.id || 'email'}`;
            const path = key('notification-job', owner, id);
            const job = await tx.get(path) || { id, owner, eventId: event.id, channel, subscriptionId: subscription?.id || null, delivered: 0, attempts: 0, nextAt: event.createdAt + (channel === 'email' ? eligible.preferences.email.delayMinutes * 60000 : 0) };
            const max = channel === 'email' ? eligible.preferences.email.maxReminders : 1;
            const minimumAt = channel === 'email' ? (job.delivered ? job.lastDeliveredAt + eligible.preferences.email.repeatHours * 3600000 : event.createdAt + eligible.preferences.email.delayMinutes * 60000) : 0;
            if (job.delivered >= max || job.attempts >= 8 || job.nextAt > now || minimumAt > now || job.leaseUntil > now) continue;
            job.preview=channel==='push'&&eligible.preferences.push.preview===true;
            job.lease = this.crypto.randomUUID(); job.leaseUntil = now + leaseMs; job.attempts++;
            if(channel==='email')await tx.set(key('notification-email-budget',owner),{lease:job.lease,leaseUntil:job.leaseUntil,nextAt:0});
            await tx.set(path, job);
            result.push({ ...job, messageId: event.messageId, payload: messagePushPayload(eligible.message,job.preview,{owner}), subscription });
          }
        }
      }
      return result;
    });
  }
  async authorizeDelivery(owner, id, lease) {
    return this.store.transaction(async tx => {
      const job = await tx.get(key('notification-job', owner, id));
      if (!job || job.lease !== lease || job.leaseUntil <= this.clock()) return false;
      const event = await tx.get(key('notification-event', owner, job.eventId));
      if (!event || !(await this.eligible(tx, owner, event, job.channel, this.clock()))) return false;
      if(job.preview===true&&(await tx.get(key('notification-preferences',owner)))?.push?.preview!==true)return false;
      if (job.channel === 'push' && !(await tx.get(key('push-subscription', owner, job.subscriptionId)))) return false;
      return true;
    });
  }
  async finish(owner, id, lease, { delivered = false, gone = false } = {}) {
    return this.store.transaction(async tx => {
      const path = key('notification-job', owner, id); const job = await tx.get(path);
      if (!job || job.lease !== lease || job.leaseUntil <= this.clock()) fail('stale_lease');
      if (gone && job.channel === 'push') await tx.delete(key('push-subscription', owner, job.subscriptionId));
      const preferences = await tx.get(key('notification-preferences', owner)) || defaultNotificationPreferences();
      if(job.channel==='email'){const budget=await tx.get(key('notification-email-budget',owner));if(budget?.lease===lease)await tx.set(key('notification-email-budget',owner),{lease:null,leaseUntil:0,nextAt:this.clock()+(delivered?preferences.email.repeatHours*3600000:Math.min(3600000,30000*2**job.attempts))});}
      if (delivered) { job.delivered++; job.attempts = 0; job.lastDeliveredAt = this.clock(); job.nextAt = this.clock() + (job.channel === 'email' ? preferences.email.repeatHours * 3600000 : 0); }
      else job.nextAt = this.clock() + Math.min(3600000, 30000 * 2 ** job.attempts);
      job.lease = null; job.leaseUntil = 0; await tx.set(path, job);
      return { delivered: job.delivered };
    });
  }
  async nextDue(owner){return this.store.transaction(async tx=>{
    const now=this.clock(),preferences=await tx.get(key('notification-preferences',owner))||defaultNotificationPreferences();if(!preferences.enabled)return null;let due=null;
    const events=await tx.list(key('notification-event',owner));const devices=await tx.list(key('push-subscription',owner));
    for(const {value:event}of events){const message=await tx.get(key('message',owner,event.messageId));if(!message||!await this.messageAllowed(tx,owner,message)||message.readAt!==null||message.quarantined||preferences.collections.length&&!preferences.collections.includes(message.collection)||message.tags.some(tag=>preferences.excludeTags.includes(tag)))continue;
      for(const channel of ['push','email']){if(!preferences[channel].enabled)continue;for(const device of channel==='push'?devices:[{value:null}]){const id=`${event.id}:${channel}:${device.value?.id||'email'}`;const job=await tx.get(key('notification-job',owner,id));if(job&&(job.delivered>=(channel==='push'?1:preferences.email.maxReminders)||job.attempts>=8))continue;let at=job?.nextAt??event.createdAt+(channel==='email'?preferences.email.delayMinutes*60000:0);at=Math.max(at,job?.leaseUntil||0);if(channel==='email'){const budget=await tx.get(key('notification-email-budget',owner));at=Math.max(at,budget?.nextAt||0,budget?.leaseUntil||0);}if(quietNow(preferences.quiet,now))at=Math.max(at,now+900000);at=Math.max(at,now+1000);due=due===null?at:Math.min(due,at);}}
    }return due;
  });}
}

// The destination owner is a routing hint for the provider console, never authority.
// Its account label is lock-screen visible, so it is attached only with previews on.
export function messagePushPayload(message,preview=false,{owner,accountLabel}={}){
 const destination=UUID_V4.test(owner??'')?owner:null;
 const payload={type:'bindle-message',...destination?{owner:destination}:{},messageId:message.id,title:'New message',body:'You have an unread message.',path:'/console?'+(destination?'account='+destination+'&':'')+'message='+encodeURIComponent(message.id),actions:[]};
 if(!preview)return payload;if(destination&&typeof accountLabel==='string'&&accountLabel.length>0&&accountLabel.length<=100)payload.accountLabel=accountLabel;const summary=message.notificationSummary,p=message.appNotification;if(!summary||summary.version!==1)return payload;
 if(p){payload.sender={name:p.name,origin:p.origin};payload.title=`${p.name} (${p.origin})`;}
 else payload.title=summary.title||'New message';
 payload.body=Array.from([p?summary.title:null,summary.text].filter(Boolean).join('\n')).slice(0,360).join('');payload.sourceDigest=summary.sourceDigest;
 if(p)payload.actions=(summary.actions||[]).slice(0,2).map(a=>({action:a.kind==='form'?`form:${a.formId}:${a.buttonId}`:`link:${a.linkId}`,title:a.label}));return payload;
}

// ---------------------------------------------------------------------------------------------------------------
// ACT-2 activity push policy (docs/architecture/activity-center.md "Admission and push are separate controls",
// "Multi-account destinations and lock screens"). Engine operations over the account store, behind
// ACTIVITY_V2_ENABLED (the account RPC `activityPush` and the /api/notifications/activity routes check it); nothing
// above changes. The leased outbox keeps the legacy semantics: claim leases one delivery per enrolled device, the
// dispatcher calls `authorize` immediately before transport (current item/rule/consent/privacy state), then `finish`.
//
// Records (owner-scoped through core `key`; ACT-1 owns activity-item/-event, read here):
//   activity-push-policy/<owner>/            owner policy: switches, preview, quiet hours, digest, mutes, ordered rules
//   activity-push-app/<owner>/<connection>/  per-app opt-in for one connection incarnation (absent = off)
//   activity-push-device/<owner>/<sub>/      device enrollment for activity push and its own preview consent
//   activity-push-budget/<owner>/<lane>/     fixed hour/day logical-notice windows ('account', 'app.<connection>')
//   activity-push-group/<owner>/<group>/     collapse group: open unfrozen job and last notice time (cooldown)
//   activity-push-bucket/<owner>/<bucket>/   held ('held': quiet hours/overflow) or digest ('digest.<dueAt>') members
//   activity-push-job/<owner>/<job>/         one logical notice: frozen device set and per-device leased deliveries

export const ACTIVITY_PUSH_LIMITS=Object.freeze({
 app:Object.freeze({hour:3,day:10}),account:Object.freeze({hour:6,day:20}),
 rules:100,mutes:100,optInTags:64,ruleTags:31,bucketMembers:32,buckets:101,jobs:64,events:64,attempts:8,jobLifetime:86400000,groupCooldown:600000,digestLines:3,
});
const RANK={low:0,normal:1,urgent:2},ROUTES=['feed','immediate','digest'],CONNECTION=/^[a-f0-9-]{36}$/,TAG_ID=/^[a-z0-9][a-z0-9._-]{0,63}$/,RULE_ID=/^[A-Za-z0-9_-]{1,32}$/;
const pfault=(code,message,status=400)=>{throw new AppFault(code,message,status);};
const isPlain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const only=(value,names)=>isPlain(value)&&Object.keys(value).every(k=>names.includes(k));
export const defaultActivityPushPolicy=()=>({enabled:false,paused:false,preview:false,
 quiet:{enabled:false,startHour:22,endHour:8,timeZone:null,utcOffsetMinutes:0},digest:{cadence:'daily',hour:8},mutes:[],rules:[],enabledAt:null});

/** Local wall-clock {hour, minute} at `at` for a named IANA zone (DST-aware) or a fixed UTC offset. */
const zoneFormats=new Map();
export function localTime(at,{timeZone=null,utcOffsetMinutes=0}={}){
 if(!timeZone){const d=new Date(at+utcOffsetMinutes*60000);return {hour:d.getUTCHours(),minute:d.getUTCMinutes()};}
 let format=zoneFormats.get(timeZone);if(!format){try{format=new Intl.DateTimeFormat('en-US',{timeZone,hour:'numeric',minute:'numeric',hourCycle:'h23'});}catch{return localTime(at,{utcOffsetMinutes});}if(zoneFormats.size<64)zoneFormats.set(timeZone,format);}
 const parts=Object.fromEntries(format.formatToParts(new Date(at)).filter(p=>p.type==='hour'||p.type==='minute').map(p=>[p.type,Number(p.value)]));
 return {hour:parts.hour%24,minute:parts.minute};
}
const canonicalZone=value=>{if(typeof value!=='string'||value.length>64||!/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(value))return null;try{return new Intl.DateTimeFormat('en-US',{timeZone:value}).resolvedOptions().timeZone;}catch{return null;}};
/** Quiet at `at`? Equal endpoints mean quiet all day (no automatic release). */
export function activityQuiet(quiet,at){
 if(!quiet?.enabled)return false;if(quiet.startHour===quiet.endHour)return true;
 const {hour}=localTime(at,quiet);return quiet.startHour<quiet.endHour?hour>=quiet.startHour&&hour<quiet.endHour:hour>=quiet.startHour||hour<quiet.endHour;
}
/** The next quarter-hour instant after `at` whose local time is hour:00 (daily) or any :00 (hourly), within 49 h.
 * When a DST gap skips the daily hour, the first instant after the gap is used, so no day loses its digest. */
export function nextDigestAt(digest,quiet,at){
 const zone={timeZone:quiet.timeZone,utcOffsetMinutes:quiet.utcOffsetMinutes};let previous=null;
 for(let t=Math.floor(at/900000)*900000+900000,end=at+49*3600000;t<=end;t+=900000){const {hour,minute}=localTime(t,zone);if(minute===0&&(digest.cadence==='hourly'||hour===digest.hour)||digest.cadence==='daily'&&previous!==null&&previous<digest.hour&&hour>digest.hour)return t;previous=hour;}
 return Math.floor(at/3600000)*3600000+3600000;
}

function validatePolicy(input,prior,now){
 const names=['enabled','paused','preview','quiet','digest','mutes','rules'];
 if(!only(input,names)||!names.every(n=>Object.hasOwn(input,n))||['enabled','paused','preview'].some(n=>typeof input[n]!=='boolean'))pfault('invalid_preferences','Choose valid activity push settings.');
 const q=input.quiet;if(!only(q,['enabled','startHour','endHour','timeZone','utcOffsetMinutes'])||typeof q.enabled!=='boolean'||![q.startHour,q.endHour].every(h=>Number.isInteger(h)&&h>=0&&h<=23))pfault('invalid_preferences','Quiet hours use whole hours from 0 to 23.');
 const utcOffsetMinutes=q.utcOffsetMinutes??0;if(!Number.isInteger(utcOffsetMinutes)||utcOffsetMinutes<-720||utcOffsetMinutes>840||utcOffsetMinutes%15!==0)pfault('invalid_preferences','Choose a UTC offset from -12:00 to +14:00 in 15-minute steps.');
 let timeZone=null;if(q.timeZone!==undefined&&q.timeZone!==null){timeZone=canonicalZone(q.timeZone);if(!timeZone)pfault('invalid_preferences','Choose a known time zone.');}
 const d=input.digest;if(!only(d,['cadence','hour'])||!['hourly','daily'].includes(d.cadence)||!Number.isInteger(d.hour)||d.hour<0||d.hour>23)pfault('invalid_preferences','Choose an hourly or daily digest time.');
 const tags=(v,max)=>v===undefined||Array.isArray(v)&&v.length<=max&&v.every(t=>typeof t==='string'&&TAG_ID.test(t))&&new Set(v).size===v.length;
 if(!Array.isArray(input.mutes)||input.mutes.length>ACTIVITY_PUSH_LIMITS.mutes||input.mutes.some(m=>!only(m,['app','tag'])||typeof m.app!=='string'||!CONNECTION.test(m.app)||m.tag!==undefined&&(typeof m.tag!=='string'||!TAG_ID.test(m.tag))))pfault('invalid_preferences','Mute an app or one of its tags.');
 if(!Array.isArray(input.rules)||input.rules.length>ACTIVITY_PUSH_LIMITS.rules)pfault('invalid_preferences','Use at most 100 push rules.');
 const ids=new Set(),old=new Map((prior.rules??[]).map(r=>[r.id,r]));
 const rules=input.rules.map(r=>{
  if(!only(r,['id','app','tags','excludeTags','minPriority','route','priority','quietBypass'])||typeof r.id!=='string'||!RULE_ID.test(r.id)||ids.has(r.id)||typeof r.app!=='string'||!CONNECTION.test(r.app)||!ROUTES.includes(r.route)||!tags(r.tags,ACTIVITY_PUSH_LIMITS.ruleTags)||!tags(r.excludeTags,ACTIVITY_PUSH_LIMITS.ruleTags)||r.minPriority!==undefined&&!Object.hasOwn(RANK,r.minPriority)||r.priority!==undefined&&!Object.hasOwn(RANK,r.priority)||r.quietBypass!==undefined&&typeof r.quietBypass!=='boolean')pfault('invalid_preferences','Each push rule names one app, a route and optional tag and priority filters.');
  // A quiet-hours bypass is an explicit, app-scoped immediate rule; it never applies to digest or feed routes.
  if(r.quietBypass===true&&r.route!=='immediate')pfault('invalid_preferences','Only an immediate rule can bypass quiet hours.');
  ids.add(r.id);const rule={id:r.id,app:r.app,tags:r.tags??[],excludeTags:r.excludeTags??[],minPriority:r.minPriority??'low',route:r.route,priority:r.priority??null,quietBypass:r.quietBypass===true};
  // Broadening is prospective: a new or edited rule only routes activity admitted after it changed.
  const before=old.get(r.id),same=before&&JSON.stringify({...before,since:undefined})===JSON.stringify({...rule,since:undefined});
  return {...rule,since:same?before.since:now};
 });
 const resumed=input.enabled&&!input.paused&&!(prior.enabled&&!prior.paused);
 return {enabled:input.enabled,paused:input.paused,preview:input.preview,quiet:{enabled:q.enabled,startHour:q.startHour,endHour:q.endHour,timeZone,utcOffsetMinutes},digest:{cadence:d.cadence,hour:d.hour},mutes:input.mutes.map(m=>({app:m.app,...m.tag?{tag:m.tag}:{}})),rules,enabledAt:resumed?now:prior.enabledAt??null};
}

/** The device's per-account destination hint: lets a signed-in client route a notice to the exact account without
 * putting the owner ID in the payload; it differs per device subscription, so it does not link accounts. */
export const activityDestinationHint=async(owner,subscriptionId)=>(await digest(globalThis.crypto,canonical(['activity-destination-v1',owner,subscriptionId]))).slice(0,22);
const topicOf=async(owner,subscriptionId,group)=>(await digest(globalThis.crypto,canonical(['activity-topic-v1',owner,subscriptionId,group]))).slice(0,32);
const appLabel=item=>`${Array.from(item.app.name).slice(0,60).join('')} (${item.app.origin})`;
const clip=(value,max)=>Array.from(value).slice(0,max).join('');
/** Lock-screen payload. Generic (default) notices carry no app, account, tag, subject, count or content; the
 * destination is routing data only. With account and device preview consent, the app, subject and the destination
 * account label are shown. No icon, URL, action or credential is ever included. */
export function activityPushPayload({kind,items,destination,preview,accountLabel}){
 const payload={type:'bindle-activity',version:1,title:'New activity',body:'Open your account to review it.',destination,actions:[]};
 if(!preview)return payload;
 const label=typeof accountLabel==='string'&&accountLabel.length>0&&accountLabel.length<=100&&!/[\u0000-\u001f\u007f]/.test(accountLabel)?accountLabel:null;
 if(kind==='single'){const [item]=items;payload.title=appLabel(item);payload.body=clip(item.subject,120);}
 else{payload.title=`${items.length} new activity item${items.length===1?'':'s'}`;payload.body=items.slice(0,ACTIVITY_PUSH_LIMITS.digestLines).map(i=>`${clip(i.app.name,40)}: ${clip(i.subject,80)}`).join('\n')+(items.length>ACTIVITY_PUSH_LIMITS.digestLines?`\n+${items.length-ACTIVITY_PUSH_LIMITS.digestLines} more`:'');}
 if(label){payload.accountLabel=label;payload.body=`For ${label}\n${payload.body}`;}
 return payload;
}

const listed=async(tx,prefix,limit)=>[...(await tx.list({prefix,...limit?{limit}:{}})).entries()];
function windowCharge(record,limits,now){
 const hour=Math.floor(now/3600000),day=Math.floor(now/86400000),hourCount=record?.hour===hour?record.hourCount:0,dayCount=record?.day===day?record.dayCount:0;
 return {ok:hourCount<limits.hour&&dayCount<limits.day,next:{hour,day,hourCount:hourCount+1,dayCount:dayCount+1},retryAt:dayCount>=limits.day?(day+1)*86400000:(hour+1)*3600000};
}

export class ActivityPushStore{
 constructor({accountStore,clock,random}){Object.assign(this,{accountStore,clock,random});}
 transaction(operation){return this.accountStore.transaction(operation);}
 async context(tx,owner){
  const policy=await tx.get(key('activity-push-policy',owner))??defaultActivityPushPolicy(),channel=await tx.get(key('notification-preferences',owner))??defaultNotificationPreferences();
  const channelOn=(await tx.get(key('activity-push-channel',owner)))?.enabledAt??null;
  return {owner,policy,channel,channelOn,now:this.clock.now(),optIns:new Map(),connections:new Map()};
 }
 async optIn(tx,ctx,id){if(!ctx.optIns.has(id))ctx.optIns.set(id,await tx.get(key('activity-push-app',ctx.owner,id))??null);return ctx.optIns.get(id);}
 async connection(tx,ctx,id){if(!ctx.connections.has(id))ctx.connections.set(id,await tx.get('resource/'+id)??null);return ctx.connections.get(id);}
 /** Deterministic routing of one item revision (activity-center "Evaluation is deterministic"). The app's priority
  * is only a claim: it can satisfy an owner rule's minimum, but its effective value is capped at normal unless an
  * owner rule sets one, and it can never select a route, bypass quiet hours, budgets, mutes or consent. */
 async decide(tx,ctx,item){
  const silent=reason=>({route:'feed',reason});
  if(!item||item.owner!==ctx.owner||activityState(item,ctx.now)!=='active')return silent('inactive');
  if(item.read)return silent('read');if(item.archived)return silent('archived');
  if(!ctx.channel.enabled||!ctx.channel.push?.enabled)return silent('channel_off');
  if(!ctx.policy.enabled)return silent('push_off');if(ctx.policy.paused)return silent('paused');
  const app=item.connection.id,r=await this.connection(tx,ctx,app);
  if(r?.owner!==ctx.owner||r.kind!=='app-connection'||r.status!=='active'||r.clientId!==item.app.clientId||r.generation!==item.connection.generation||r.notifications?.enabled!==true||r.notifications.generation!==item.connection.admissionGeneration)return silent('disconnected');
  const optIn=await this.optIn(tx,ctx,app);
  if(!optIn||optIn.generation!==item.connection.generation)return silent('app_off');
  if(item.createdAt<=Math.max(ctx.policy.enabledAt??Infinity,optIn.since,ctx.channelOn??-Infinity))return silent('before_opt_in');
  if(ctx.policy.mutes.some(m=>m.app===app&&(!m.tag||item.tags.includes(m.tag))))return silent('muted');
  const capped=RANK[item.priority]>RANK.normal?'normal':item.priority;
  const inScope=extra=>optIn.mode==='all'||item.tags.some(t=>optIn.tags.includes(t)||extra.includes(t));
  for(const rule of ctx.policy.rules){
   if(rule.app!==app||rule.tags.length&&!rule.tags.some(t=>item.tags.includes(t))||rule.excludeTags.some(t=>item.tags.includes(t))||RANK[item.priority]<RANK[rule.minPriority])continue;
   if(rule.route==='feed')return {...silent('rule'),rule:rule.id};
   if(item.createdAt<=rule.since||!inScope(rule.tags))continue;
   return {route:rule.route,reason:'rule',rule:rule.id,app,priority:rule.priority??capped,bypass:rule.quietBypass};
  }
  if(!inScope([]))return silent('tag_not_selected');
  return {route:optIn.route,reason:'opt_in',app,priority:capped,bypass:false};
 }
 async charge(tx,ctx,app,{dryRun=false}={}){
  const lanes=[[key('activity-push-budget',ctx.owner,'account'),ACTIVITY_PUSH_LIMITS.account],...app?[[key('activity-push-budget',ctx.owner,'app.'+app),ACTIVITY_PUSH_LIMITS.app]]:[]];
  const checked=[];for(const [path,limits]of lanes){const c=windowCharge(await tx.get(path),limits,ctx.now);if(!c.ok)return {ok:false,retryAt:c.retryAt};checked.push([path,c.next]);}
  if(!dryRun)for(const [path,value]of checked)await tx.put(path,value);return {ok:true};
 }
 /** Hold one member in its app's own bucket. Each member keeps its own release time, which never moves later, and
  * an app evicts only its own oldest members: one app cannot delay or displace another app's held activity. */
 async hold(tx,ctx,member,{dueAt=0,scheduled=false}={}){
  const path=key('activity-push-bucket',ctx.owner,'app.'+member.app),bucket=await tx.get(path)??{members:[]},prior=bucket.members.find(m=>m.item===member.item);
  const entry=prior&&prior.dueAt<=dueAt?{...prior,revision:member.revision}:{...member,dueAt,scheduled};
  await tx.put(path,{members:[...bucket.members.filter(m=>m.item!==member.item),entry].slice(-ACTIVITY_PUSH_LIMITS.bucketMembers)});
 }
 digestHold(ctx){return {dueAt:nextDigestAt(ctx.policy.digest,ctx.policy.quiet,ctx.now),scheduled:true};}
 async devices(tx,owner){
  const out=[];for(const [,sub]of await listed(tx,key('push-subscription',owner),11)){const enrolled=await tx.get(key('activity-push-device',owner,sub?.id));if(sub?.owner===owner&&enrolled?.enrolled===true)out.push({sub,enrolled});}
  return out;
 }
 async newJob(tx,ctx,{kind,group,members,priority,bypass}){
  const devices=await this.devices(tx,ctx.owner);if(!devices.length)return null;
  const id=this.random.uuid(),job={id,kind,group,members,priority,bypass:bypass===true,createdAt:ctx.now,deliveries:Object.fromEntries(devices.map(({sub})=>[sub.id,{attempts:0,nextAt:0,lease:null,leaseUntil:0,state:'pending'}]))};
  await tx.put(key('activity-push-job',ctx.owner,id),job);return job;
 }
 /** Turn pending ACT-1 notification groups into notices, held buckets or nothing; consumed groups are removed. */
 async plan(tx,ctx,room){
  for(const [path,event]of await listed(tx,key('activity-event',ctx.owner),ACTIVITY_PUSH_LIMITS.events)){
   let chosen=null,decision=null;
   // Latest still-eligible member: a later muted, read or expired member cannot displace eligible content.
   for(const member of [...(event?.members??[])].reverse()){if(member.revision!==1)continue;const item=await tx.get(key('activity-item',ctx.owner,member.item));if(!item||item.eventGroup!==event.group)continue;const d=await this.decide(tx,ctx,item);if(d.route!=='feed'){chosen=item;decision=d;break;}}
   await tx.delete(path);if(!chosen)continue;
   await this.route(tx,ctx,{item:chosen.id,revision:chosen.revision,group:event.group,app:decision.app},decision,room);
  }
  // Collapse-group cooldown records are bounded by pruning the idle ones.
  for(const [path,group]of await listed(tx,key('activity-push-group',ctx.owner),32))if(!group?.job&&ctx.now-group.lastAt>=ACTIVITY_PUSH_LIMITS.groupCooldown)await tx.delete(path);
 }
 async route(tx,ctx,member,decision,room){
  if(decision.route==='digest')return this.hold(tx,ctx,member,this.digestHold(ctx));
  if(!decision.bypass&&activityQuiet(ctx.policy.quiet,ctx.now))return this.hold(tx,ctx,member);
  const gpath=key('activity-push-group',ctx.owner,member.group),group=await tx.get(gpath)??{job:null,lastAt:0};
  // Push-side collapse: a newer member replaces the group's notice while no delivery attempt has frozen it.
  const open=group.job?await tx.get(key('activity-push-job',ctx.owner,group.job)):null;
  if(open&&Object.values(open.deliveries).every(d=>d.attempts===0)){await tx.put(key('activity-push-job',ctx.owner,open.id),{...open,members:[member],priority:decision.priority,bypass:decision.bypass});return;}
  // Fatigue guards: one immediate notice per collapse group per cooldown, a bounded outbox, then app/account budgets.
  if(ctx.now-group.lastAt<ACTIVITY_PUSH_LIMITS.groupCooldown||!room())return this.hold(tx,ctx,member,{dueAt:Math.max(group.lastAt+ACTIVITY_PUSH_LIMITS.groupCooldown,ctx.now)});
  // Over the app or account budget: the overflow waits for the owner's scheduled digest, never an extra notice.
  const budget=await this.charge(tx,ctx,decision.app,{dryRun:true});if(!budget.ok)return this.hold(tx,ctx,member,this.digestHold(ctx));
  const job=await this.newJob(tx,ctx,{kind:'single',group:member.group,members:[member],priority:decision.priority,bypass:decision.bypass});
  if(!job)return;await this.charge(tx,ctx,decision.app);await tx.put(gpath,{job:job.id,lastAt:ctx.now});
 }
 /** Members still eligible now, collapsed to the latest per group; `exact` also requires the frozen revisions. */
 async eligibleMembers(tx,ctx,members,{exact=false,route=null}={}){
  const out=new Map();
  for(const m of members){const item=await tx.get(key('activity-item',ctx.owner,m.item));const d=await this.decide(tx,ctx,item);if(d.route==='feed'||route&&d.route!==route||exact&&item.revision!==m.revision)continue;const prior=out.get(m.group);if(!prior||prior.item.updatedAt<=item.updatedAt)out.set(m.group,{member:{...m,revision:item.revision},item,decision:d});}
  return [...out.values()];
 }
 /** Release due held members as ONE account summary per pass. Unscheduled releases (quiet end, cooldown) are spaced
  * an hour apart; scheduled digest/overflow members are released at the owner's digest time. Ineligible members are
  * pruned on every pass, quiet or not. Summaries spend the account budget. */
 async releaseBuckets(tx,ctx,room){
  const quiet=activityQuiet(ctx.policy.quiet,ctx.now),buckets=[],due=[];
  for(const [path,bucket]of await listed(tx,key('activity-push-bucket',ctx.owner),ACTIVITY_PUSH_LIMITS.buckets)){
   const keep=[];for(const m of bucket?.members??[]){const item=await tx.get(key('activity-item',ctx.owner,m.item)),d=await this.decide(tx,ctx,item);if(d.route==='feed')continue;if(!quiet&&m.dueAt<=ctx.now)due.push({m,item,path});else keep.push(m);}
   buckets.push({path,before:bucket?.members?.length??0,keep});
  }
  const write=async()=>{for(const b of buckets){if(!b.keep.length)await tx.delete(b.path);else if(b.keep.length!==b.before)await tx.put(b.path,{members:b.keep});}};
  const back=()=>{for(const {m,path}of due)buckets.find(b=>b.path===path).keep.push(m);};
  if(!due.length)return write();
  const last=await tx.get(key('activity-push-budget',ctx.owner,'summary'));
  if(!due.some(x=>x.m.scheduled)&&last&&ctx.now-last.at<3600000||!(await this.charge(tx,ctx,null,{dryRun:true})).ok||!room()){back();return write();}
  const latest=new Map();for(const x of due){const p=latest.get(x.m.group);if(!p||p.item.updatedAt<=x.item.updatedAt)latest.set(x.m.group,x);}
  // Round-robin across apps (newest first within each), so one app's volume cannot crowd others out of the summary.
  const byApp=new Map();for(const x of [...latest.values()].sort((a,b)=>b.item.updatedAt-a.item.updatedAt)){if(!byApp.has(x.m.app))byApp.set(x.m.app,[]);byApp.get(x.m.app).push(x);}
  const chosen=[];for(let i=0;chosen.length<ACTIVITY_PUSH_LIMITS.bucketMembers&&[...byApp.values()].some(l=>l.length>i);i++)for(const l of byApp.values())if(l[i]&&chosen.length<ACTIVITY_PUSH_LIMITS.bucketMembers)chosen.push(l[i]);
  const job=await this.newJob(tx,ctx,{kind:'digest',group:'digest',members:chosen.map(({m,item})=>({item:m.item,revision:item.revision,group:m.group,app:m.app})),priority:'normal',bypass:false});
  if(job){await this.charge(tx,ctx,null);await tx.put(key('activity-push-budget',ctx.owner,'summary'),{at:ctx.now});}
  // Members beyond the summary bound stay held for the next pass; collapsed older members are dropped.
  const included=new Set(chosen.map(({m})=>m.group));
  for(const x of due)if(!included.has(x.m.group)&&latest.get(x.m.group)===x)buckets.find(b=>b.path===x.path).keep.push(x.m);
  return write();
 }
 /** Whether one delivery may still go out now, and its items; null cancels it. Runs at claim and at authorize. */
 async deliverable(tx,ctx,job,subId){
  const sub=await tx.get(key('push-subscription',ctx.owner,subId)),enrolled=await tx.get(key('activity-push-device',ctx.owner,subId));
  if(!sub||enrolled?.enrolled!==true)return null;
  const delivery=job.deliveries[subId],frozen=delivery.attempts>0;
  const live=await this.eligibleMembers(tx,ctx,job.members,{exact:frozen,route:job.kind==='single'?'immediate':null});
  if(!live.length||frozen&&live.length!==new Set(job.members.map(m=>m.group)).size)return null;
  if(job.kind==='single'&&!live[0].decision.bypass&&activityQuiet(ctx.policy.quiet,ctx.now))return {quiet:true};
  const preview=ctx.policy.preview===true&&enrolled.preview===true;
  // A frozen preview payload is never sent once either preview consent is withdrawn.
  if(frozen&&delivery.preview&&!preview)return null;
  return {sub,live,preview:frozen?delivery.preview:preview};
 }
 async claim(owner,{limit=20,leaseMs=60000,accountLabel}={}){
  if(!Number.isInteger(limit)||limit<1||limit>100||!Number.isInteger(leaseMs)||leaseMs<15000||leaseMs>300000)pfault('invalid_limit','Choose a valid claim size.');
  return this.transaction(async tx=>{
   const ctx=await this.context(tx,owner),out=[];let jobs=(await listed(tx,key('activity-push-job',owner),ACTIVITY_PUSH_LIMITS.jobs+1)).length;const room=()=>jobs++<ACTIVITY_PUSH_LIMITS.jobs;
   await this.plan(tx,ctx,room);await this.releaseBuckets(tx,ctx,room);
   // Oldest notice first, so retries and new notices are served in admission order.
   for(const [path,stored]of (await listed(tx,key('activity-push-job',owner),ACTIVITY_PUSH_LIMITS.jobs*2)).sort((x,y)=>x[1].createdAt-y[1].createdAt||(x[0]<y[0]?-1:1))){
    let job=stored,changed=false;
    if(ctx.now-job.createdAt>ACTIVITY_PUSH_LIMITS.jobLifetime){await this.close(tx,ctx,job);continue;}
    for(const [subId,delivery]of Object.entries(job.deliveries)){
     if(out.length>=limit||delivery.state!=='pending'||delivery.nextAt>ctx.now||delivery.leaseUntil>ctx.now)continue;
     const ok=await this.deliverable(tx,ctx,job,subId);
     // A route changed to digest before any attempt rebuckets the notice instead of creating a second intent.
     if(!ok&&job.kind==='single'&&Object.values(job.deliveries).every(d=>d.attempts===0)){const item=await tx.get(key('activity-item',owner,job.members[0].item)),d=await this.decide(tx,ctx,item);if(d.route==='digest'){await this.hold(tx,ctx,{...job.members[0],revision:item.revision},this.digestHold(ctx));await this.close(tx,ctx,job);job=null;break;}}
     if(!ok){job.deliveries[subId]={...delivery,state:'cancelled',lease:null};changed=true;continue;}
     if(ok.quiet){
      // Quiet hours began before any attempt: rebucket into the held digest rather than ringing.
      if(Object.values(job.deliveries).every(d=>d.attempts===0)){for(const m of job.members)await this.hold(tx,ctx,m);await this.close(tx,ctx,job);job=null;break;}
      continue;
     }
     if(delivery.attempts===0&&job.kind==='single'&&job.members[0].revision!==ok.live[0].member.revision){job.members=[ok.live[0].member];changed=true;}
     const items=ok.live.map(l=>l.item),destination={account:await activityDestinationHint(owner,subId),...job.kind==='single'?{item:items[0].id,revision:items[0].revision}:{}};
     const payload=delivery.payload??activityPushPayload({kind:job.kind,items,destination,preview:ok.preview,accountLabel});
     const options={urgency:job.kind==='digest'||job.priority==='low'?'low':job.priority==='urgent'?'high':'normal',topic:await topicOf(owner,subId,job.group),ttl:job.priority==='urgent'?3600:600};
     job.deliveries[subId]={...delivery,attempts:delivery.attempts+1,lease:this.random.uuid(),leaseUntil:ctx.now+leaseMs,preview:ok.preview,payload,options};changed=true;
     out.push({job:job.id,device:subId,lease:job.deliveries[subId].lease,payload,options,subscription:{endpoint:ok.sub.endpoint,keys:ok.sub.keys}});
    }
    if(job&&changed){if(await this.settled(tx,ctx,job))continue;await tx.put(path,job);}
   }
   return out;
  });
 }
 async settled(tx,ctx,job){if(Object.values(job.deliveries).some(d=>d.state==='pending'))return false;await this.close(tx,ctx,job);return true;}
 async close(tx,ctx,job){
  await tx.delete(key('activity-push-job',ctx.owner,job.id));
  const gpath=key('activity-push-group',ctx.owner,job.group),group=await tx.get(gpath);if(group?.job===job.id){if(ctx.now-group.lastAt>=ACTIVITY_PUSH_LIMITS.groupCooldown)await tx.delete(gpath);else await tx.put(gpath,{...group,job:null});}
 }
 async leased(tx,owner,input){
  if(!only(input,['job','device','lease','delivered','gone'])||typeof input.job!=='string'||typeof input.device!=='string'||typeof input.lease!=='string')pfault('invalid_args','Name a leased delivery.');
  const job=await tx.get(key('activity-push-job',owner,input.job)),delivery=job?.deliveries?.[input.device];
  return delivery&&delivery.lease===input.lease&&delivery.leaseUntil>this.clock.now()&&delivery.state==='pending'?{job,delivery}:null;
 }
 /** The final check, immediately before transport: current item, route, consent, device and preview state. */
 async authorize(owner,input){
  return this.transaction(async tx=>{
   const held=await this.leased(tx,owner,input);if(!held)return false;
   const ctx=await this.context(tx,owner),ok=await this.deliverable(tx,ctx,held.job,input.device);
   // Authorized: extend the lease past the transport timeout, so an in-flight send is never claimed again.
   if(ok&&!ok.quiet&&ok.preview===held.delivery.preview){held.job.deliveries[input.device]={...held.delivery,leaseUntil:Math.max(held.delivery.leaseUntil,ctx.now+30000)};await tx.put(key('activity-push-job',owner,held.job.id),held.job);return true;}
   // Quiet hours began after the claim and nothing was delivered: hold the notice for the post-quiet summary.
   if(ok?.quiet&&!Object.values(held.job.deliveries).some(d=>d.state==='delivered')){for(const m of held.job.members)await this.hold(tx,ctx,m);await this.close(tx,ctx,held.job);return false;}
   held.job.deliveries[input.device]={...held.delivery,state:'cancelled',lease:null,leaseUntil:0};
   if(!await this.settled(tx,ctx,held.job))await tx.put(key('activity-push-job',owner,held.job.id),held.job);
   return false;
  });
 }
 async finish(owner,input){
  return this.transaction(async tx=>{
   const held=await this.leased(tx,owner,input);if(!held)pfault('stale_lease','This delivery lease is no longer valid.',409);
   const ctx=await this.context(tx,owner),{job,delivery}=held;
   if(input.gone===true){await tx.delete(key('push-subscription',owner,input.device));await tx.delete(key('activity-push-device',owner,input.device));}
   // Automatic retries keep the notice identity and frozen payload; no unread reminders follow a delivery.
   job.deliveries[input.device]=input.delivered===true?{...delivery,state:'delivered',lease:null,leaseUntil:0}:input.gone===true||delivery.attempts>=ACTIVITY_PUSH_LIMITS.attempts?{...delivery,state:'failed',lease:null,leaseUntil:0}:{...delivery,lease:null,leaseUntil:0,nextAt:ctx.now+Math.min(3600000,30000*2**delivery.attempts)};
   if(!await this.settled(tx,ctx,job))await tx.put(key('activity-push-job',owner,job.id),job);
   return {state:job.deliveries[input.device].state};
  });
 }
 // Owner settings.
 async settings(owner){
  return this.transaction(async tx=>{
   const policy=await tx.get(key('activity-push-policy',owner))??defaultActivityPushPolicy(),apps=(await listed(tx,key('activity-push-app',owner),201)).map(([,v])=>({connection:v.connection,generation:v.generation,mode:v.mode,tags:v.tags,route:v.route,since:v.since}));
   const devices=[];for(const [,sub]of await listed(tx,key('push-subscription',owner),11)){const d=await tx.get(key('activity-push-device',owner,sub.id));devices.push({id:sub.id,label:sub.label,enrolled:d?.enrolled===true,preview:d?.preview===true});}
   return {policy:{...policy,rules:policy.rules.map(({since,...r})=>r)},apps,devices,limits:ACTIVITY_PUSH_LIMITS};
  });
 }
 async configure(owner,input){
  return this.transaction(async tx=>{const now=this.clock.now(),prior=await tx.get(key('activity-push-policy',owner))??defaultActivityPushPolicy(),next=validatePolicy(input,prior,now);await tx.put(key('activity-push-policy',owner),next);return {...next,rules:next.rules.map(({since,...r})=>r)};});
 }
 /** Per-app opt-in for the connection's current incarnation. Reconnecting needs a fresh opt-in; broadening the tag
  * scope is prospective. Admission consent, OS permission or an app's urgency never turn this on. */
 async setApp(owner,connection,input){
  if(typeof connection!=='string'||!CONNECTION.test(connection)||!only(input,['mode','tags','route'])||!['off','selected','all'].includes(input.mode))pfault('invalid_args','Choose off, selected tags or all activity for this app.');
  const tags=input.tags??[],route=input.route??'immediate';
  if(input.mode!=='off'&&(!Array.isArray(tags)||tags.length>ACTIVITY_PUSH_LIMITS.optInTags||tags.some(t=>typeof t!=='string'||!TAG_ID.test(t))||new Set(tags).size!==tags.length||!['immediate','digest'].includes(route)||input.mode==='selected'&&!tags.length))pfault('invalid_args','Choose the app tags and an immediate or digest route.');
  return this.transaction(async tx=>{
   const path=key('activity-push-app',owner,connection);
   if(input.mode==='off'){await tx.delete(path);return {connection,mode:'off'};}
   const r=await tx.get('resource/'+connection);
   if(r?.owner!==owner||r.kind!=='app-connection'||r.transport!=='bindle'||r.status!=='active')pfault('not_found','App connection not found.',404);
   const now=this.clock.now(),prior=await tx.get(path),same=prior?.generation===r.generation;
   const broadened=!same||input.mode==='all'&&prior.mode!=='all'||input.mode==='selected'&&prior.mode==='selected'&&tags.some(t=>!prior.tags.includes(t));
   const record={connection,generation:r.generation,mode:input.mode,tags:input.mode==='all'?[]:[...tags],route,since:broadened?now:prior.since};
   await tx.put(path,record);return record;
  });
 }
 async setDevice(owner,id,input){
  if(typeof id!=='string'||id.length>64||!only(input,['enrolled','preview'])||typeof input.enrolled!=='boolean'||input.preview!==undefined&&typeof input.preview!=='boolean')pfault('invalid_args','Enroll or remove this device for activity push.');
  return this.transaction(async tx=>{
   const sub=await tx.get(key('push-subscription',owner,id));if(!sub||sub.owner!==owner)pfault('not_found','Push device not found.',404);
   if(!input.enrolled){await tx.delete(key('activity-push-device',owner,id));return {id,enrolled:false,preview:false};}
   const record={enrolled:true,preview:input.preview===true,enrolledAt:this.clock.now()};await tx.put(key('activity-push-device',owner,id),record);return {id,enrolled:true,preview:record.preview};
  });
 }
 /** Why an item would or would not push now (rule editor explanation). Never reveals other accounts' state. */
 async explain(owner,id){
  if(typeof id!=='string'||!CONNECTION.test(id))pfault('not_found','Activity item not found.',404);
  return this.transaction(async tx=>{const item=await tx.get(key('activity-item',owner,id));if(!item||item.owner!==owner)pfault('not_found','Activity item not found.',404);const ctx=await this.context(tx,owner),d=await this.decide(tx,ctx,item);return {...d,quiet:activityQuiet(ctx.policy.quiet,ctx.now)};});
 }
}

export class ActivityPushProvider extends Provider{
 static deps=['accountStore','clock','random'];
 #deps;#held=new WeakMap();
 constructor(deps){super();this.#deps=deps;}
 async obtain({actor}={}){
  const owner=ownerOf(actor),resources={},obtained=[];
  try{
   for(const name of this.constructor.deps){resources[name]=await this.#deps[name].obtain();obtained.push(name);}
   const bound=await resources.accountStore.get('owner');if(bound!==undefined&&bound!==owner)throw new AppFault('forbidden','Account owner mismatch.',403);
   const store=new ActivityPushStore(resources);
   const handle=Object.freeze({settings:()=>store.settings(owner),configure:input=>store.configure(owner,input),setApp:(id,input)=>store.setApp(owner,id,input),setDevice:(id,input)=>store.setDevice(owner,id,input),explain:id=>store.explain(owner,id),claim:input=>store.claim(owner,input),authorize:input=>store.authorize(owner,input),finish:input=>store.finish(owner,input)});
   this.#held.set(handle,{resources,obtained});return handle;
  }catch(error){for(const name of obtained)await this.#deps[name].release(resources[name]);throw error;}
 }
 async release(handle){const held=this.#held.get(handle);if(!held)return;this.#held.delete(handle);for(const name of held.obtained)await this.#deps[name].release(held.resources[name]);}
}
export class ActivityPushSettings extends AppQuery{static operation='activity.push.settings';static deps=['activityPush'];static refreshOn=['activity-push-changed'];fetch({activityPush}){return activityPush.settings();}}
export class ConfigureActivityPush extends AppAction{static operation='activity.push.configure';static deps=['activityPush'];static changes='activity-push-changed';run({activityPush}){return activityPush.configure(this.input);}}
/** `id`: app connection; `input`: {mode:'off'|'selected'|'all', tags?, route?}. */
export class SetActivityPushApp extends AppAction{static operation='activity.push.app';static deps=['activityPush'];static changes='activity-push-changed';run({activityPush}){return activityPush.setApp(this.id,this.input);}}
/** `id`: push device; `input`: {enrolled, preview?}. */
export class SetActivityPushDevice extends AppAction{static operation='activity.push.device';static deps=['activityPush'];static changes='activity-push-changed';run({activityPush}){return activityPush.setDevice(this.id,this.input);}}
export class ExplainActivityPush extends AppQuery{static operation='activity.push.explain';static deps=['activityPush'];fetch({activityPush}){return activityPush.explain(this.id);}}
// Dispatcher operations (system work in the owner's account); not reachable through owner HTTP routes.
export class ClaimActivityPush extends AppAction{static operation='activity.push.claim';static deps=['activityPush'];run({activityPush}){return activityPush.claim(this.input??{});}}
export class AuthorizeActivityPush extends AppAction{static operation='activity.push.authorize';static deps=['activityPush'];run({activityPush}){return activityPush.authorize(this.input);}}
export class FinishActivityPush extends AppAction{static operation='activity.push.finish';static deps=['activityPush'];run({activityPush}){return activityPush.finish(this.input);}}
export const ACTIVITY_PUSH_PROVIDERS={activityPush:ActivityPushProvider};
/** Owner settings operations by name. Deliberately absent from ACCOUNT_OPERATIONS: the flag-checking account RPC
 * `activityPush` is their only entry point, so nothing is reachable with ACTIVITY_V2_ENABLED off. */
export const ACTIVITY_PUSH_OWNER_OPERATIONS=Object.freeze({settings:ActivityPushSettings,configure:ConfigureActivityPush,app:SetActivityPushApp,device:SetActivityPushDevice,explain:ExplainActivityPush});

/** One dispatch pass: claim, authorize each delivery immediately before transport, send, finish. `perform` runs an
 * Action in the owner's account engine. Transport faults retry with backoff; 404/410 expire the subscription. */
export async function dispatchActivityPush({perform,owner,transport,accountLabel,limit=20}){
 const actor={kind:'owner',owner},results=[];
 for(const claimed of await perform(new ClaimActivityPush({actor,input:{limit,...accountLabel?{accountLabel}:{}}}))){
  const lease={job:claimed.job,device:claimed.device,lease:claimed.lease};
  if(!await perform(new AuthorizeActivityPush({actor,input:lease}))){results.push({...lease,state:'cancelled'});continue;}
  let outcome={delivered:true};
  try{await transport.send(claimed.subscription,claimed.payload,claimed.options);}catch(error){outcome=error?.code==='push_subscription_gone'?{gone:true}:{delivered:false};}
  try{results.push({...lease,...await perform(new FinishActivityPush({actor,input:{...lease,...outcome}}))});}catch{results.push({...lease,state:'stale'});}
 }
 return results;
}
