import webpush from 'web-push';

export const PUSH_ORIGINS = Object.freeze([
  'https://fcm.googleapis.com',
  'https://updates.push.services.mozilla.com',
  'https://web.push.apple.com',
]);
const fault = (code, status) => Object.assign(new Error('Push delivery could not be completed.'), {code, status});

export function validatePushSubscription(subscription) {
  if (!subscription || typeof subscription.endpoint !== 'string' || subscription.endpoint.length > 2048) throw fault('invalid_subscription', 400);
  let url;
  try { url = new URL(subscription.endpoint); } catch { throw fault('invalid_subscription', 400); }
  if (!PUSH_ORIGINS.includes(url.origin) || url.username || url.password || url.hash || url.protocol !== 'https:') throw fault('invalid_subscription', 400);
  const decode = (value, length) => {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || Buffer.from(value, 'base64url').length !== length) throw fault('invalid_subscription', 400);
    return Buffer.from(value, 'base64url');
  };
  if (decode(subscription.keys?.p256dh, 65)[0] !== 4) throw fault('invalid_subscription', 400);
  decode(subscription.keys?.auth, 16);
  return {endpoint: url.href, keys: {p256dh: subscription.keys.p256dh, auth: subscription.keys.auth}};
}

/** Injected delivery resource shared by Workers (nodejs_compat) and Node.
 * Request construction uses maintained Web Push encryption; fetch owns I/O.
 * Acceptance is not proof that a pending account received its challenge.
 */
export function createPushTransport(config = {}, {fetcher = fetch} = {}) {
  if (config.PUSH_ENABLED !== 'true' || !config.VAPID_PUBLIC_KEY || !config.VAPID_PRIVATE_KEY) return null;
  const subject = config.VAPID_SUBJECT ?? config.APP_ORIGIN;
  try {
    webpush.generateRequestDetails({endpoint: PUSH_ORIGINS[0] + '/wp/configuration-check'}, null, {
      TTL: 60, vapidDetails: {subject, publicKey: config.VAPID_PUBLIC_KEY, privateKey: config.VAPID_PRIVATE_KEY},
    });
  } catch { return null; }
  return Object.freeze({
    available: true,
    // `options` (ACT-2 activity push only): urgency, a Topic so the push service collapses an undelivered notice of
    // the same group, and TTL. Omitted, the request is exactly the existing one.
    async send(input, payload, {urgency = 'normal', topic, ttl = 600} = {}) {
      const subscription = validatePushSubscription(input);
      if (!['very-low', 'low', 'normal', 'high'].includes(urgency) || topic !== undefined && (typeof topic !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(topic)) || !Number.isInteger(ttl) || ttl < 0 || ttl > 86400) throw fault('invalid_push_options', 400);
      let body;
      try { body = JSON.stringify(payload); } catch { throw fault('invalid_push_payload', 400); }
      if (typeof body !== 'string' || Buffer.byteLength(body) > 2048) throw fault('invalid_push_payload', 400);
      let details;
      try {
        details = webpush.generateRequestDetails(subscription, body, {
          TTL: ttl, urgency, ...topic ? {topic} : {}, contentEncoding: 'aes128gcm',
          vapidDetails: {subject, publicKey: config.VAPID_PUBLIC_KEY, privateKey: config.VAPID_PRIVATE_KEY},
        });
      } catch { throw fault('invalid_subscription', 400); }
      let response;
      try {
        response = await fetcher(details.endpoint, {method: 'POST', headers: details.headers, body: details.body,
          redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(10000)});
      } catch { throw fault('push_delivery_unavailable', 503); }
      await response.body?.cancel();
      if (response.status === 404 || response.status === 410) throw fault('push_subscription_gone', response.status);
      if (response.status !== 201 && response.status !== 202) throw fault('push_delivery_unavailable', 503);
      return {accepted: true};
    },
  });
}
