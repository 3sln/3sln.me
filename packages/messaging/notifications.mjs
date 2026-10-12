import { fail, key, boundedString, base64url, digest, fromBase64url } from './store.mjs';

export const defaultNotificationPreferences = () => ({
  enabled: true, push: { enabled: false },
  email: { enabled: false, delayMinutes: 60, repeatHours: 24, maxReminders: 3 },
  collections: [], excludeTags: [],
  quiet: { enabled: false, startHour: 22, endHour: 8, utcOffsetMinutes: 0 },
});
const validatePreferences = preferences => {
  const defaults = defaultNotificationPreferences();
  if (!preferences || Object.keys(preferences).some(name => !Object.hasOwn(defaults, name)) || typeof preferences.enabled !== 'boolean' || typeof preferences.push?.enabled !== 'boolean' || typeof preferences.email?.enabled !== 'boolean' || typeof preferences.quiet?.enabled !== 'boolean') fail('invalid_preferences');
  for (const group of ['push', 'email', 'quiet']) if (Object.keys(preferences[group]).some(name => !Object.hasOwn(defaults[group], name))) fail('invalid_preferences');
  const { delayMinutes, repeatHours, maxReminders } = preferences.email;
  const { startHour, endHour, utcOffsetMinutes } = preferences.quiet;
  if (!Number.isInteger(delayMinutes) || delayMinutes < 5 || delayMinutes > 10080 || !Number.isInteger(repeatHours) || repeatHours < 1 || repeatHours > 720 || !Number.isInteger(maxReminders) || maxReminders < 1 || maxReminders > 10 || !Number.isInteger(startHour) || startHour < 0 || startHour > 23 || !Number.isInteger(endHour) || endHour < 0 || endHour > 23 || !Number.isInteger(utcOffsetMinutes) || utcOffsetMinutes < -720 || utcOffsetMinutes > 840) fail('invalid_preferences');
  for (const field of ['collections', 'excludeTags']) if (!Array.isArray(preferences[field]) || preferences[field].length > 100 || preferences[field].some(value => !boundedString(value)) || new Set(preferences[field]).size !== preferences[field].length) fail('invalid_preferences');
};
const quietNow = (quiet, now) => {
  if (!quiet.enabled) return false;
  const hour = new Date(now + quiet.utcOffsetMinutes * 60000).getUTCHours();
  if (quiet.startHour === quiet.endHour) return true;
  return quiet.startHour < quiet.endHour ? hour >= quiet.startHour && hour < quiet.endHour : hour >= quiet.startHour || hour < quiet.endHour;
};

export class NotificationService {
  constructor({ store, crypto = globalThis.crypto, clock = () => Date.now(), allowedPushOrigins = ['https://fcm.googleapis.com', 'https://updates.push.services.mozilla.com', 'https://web.push.apple.com'] }) { Object.assign(this, { store, crypto, clock, allowedPushOrigins }); }
  async preferences(owner) { return this.store.transaction(async tx => await tx.get(key('notification-preferences', owner)) || defaultNotificationPreferences()); }
  async setPreferences(owner, preferences, { verifiedEmail = false } = {}) {
    validatePreferences(preferences);
    if (preferences.email.enabled && !verifiedEmail) fail('verified_email_required');
    return this.store.transaction(async tx => {
      for (const id of preferences.collections) if (!(await tx.get(key('collection', owner, id)))?.active) fail('invalid_collection');
      await tx.set(key('notification-preferences', owner), preferences); return preferences;
    });
  }
  async subscribe(owner, { endpoint, keys }, label = 'This device') {
    let url; try { url = new URL(endpoint); } catch { fail('invalid_subscription'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || endpoint.length > 2048 || !this.allowedPushOrigins.includes(url.origin) || !boundedString(label, 100)) fail('invalid_subscription');
    if (!keys || fromBase64url(keys.p256dh).length !== 65 || fromBase64url(keys.auth).length !== 16) fail('invalid_subscription');
    const id = await digest(this.crypto, endpoint);
    return this.store.transaction(async tx => {
      const all = await tx.list(key('push-subscription', owner));
      if (all.length >= 10 && !all.some(row => row.value.id === id)) fail('subscription_limit');
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
    if (!message || message.readAt !== null || message.quarantined || !preferences.enabled || !preferences[channel].enabled || quietNow(preferences.quiet, now) || (preferences.collections.length && !preferences.collections.includes(message.collection)) || message.tags.some(tag => preferences.excludeTags.includes(tag))) return null;
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
            job.lease = this.crypto.randomUUID(); job.leaseUntil = now + leaseMs; job.attempts++;
            if(channel==='email')await tx.set(key('notification-email-budget',owner),{lease:job.lease,leaseUntil:job.leaseUntil,nextAt:0});
            await tx.set(path, job);
            result.push({ ...job, messageId: event.messageId, payload: { title: 'New message', body: 'You have an unread message.', path: '/messages' }, subscription });
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
    for(const {value:event}of events){const message=await tx.get(key('message',owner,event.messageId));if(!message||message.readAt!==null||message.quarantined||preferences.collections.length&&!preferences.collections.includes(message.collection)||message.tags.some(tag=>preferences.excludeTags.includes(tag)))continue;
      for(const channel of ['push','email']){if(!preferences[channel].enabled)continue;for(const device of channel==='push'?devices:[{value:null}]){const id=`${event.id}:${channel}:${device.value?.id||'email'}`;const job=await tx.get(key('notification-job',owner,id));if(job&&(job.delivered>=(channel==='push'?1:preferences.email.maxReminders)||job.attempts>=8))continue;let at=job?.nextAt??event.createdAt+(channel==='email'?preferences.email.delayMinutes*60000:0);at=Math.max(at,job?.leaseUntil||0);if(channel==='email'){const budget=await tx.get(key('notification-email-budget',owner));at=Math.max(at,budget?.nextAt||0,budget?.leaseUntil||0);}if(quietNow(preferences.quiet,now))at=Math.max(at,now+900000);at=Math.max(at,now+1000);due=due===null?at:Math.min(due,at);}}
    }return due;
  });}
}
