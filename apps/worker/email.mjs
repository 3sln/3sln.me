const SENDER_ROLES = Object.freeze({
  link: 'verify', login: 'login', reminder: 'notify',
  account: 'accounts', security: 'security'
});
const PROVIDER_CODES = new Set([
  'E_VALIDATION_ERROR', 'E_FIELD_MISSING', 'E_SENDER_NOT_VERIFIED',
  'E_RECIPIENT_NOT_ALLOWED', 'E_RECIPIENT_SUPPRESSED', 'E_SENDER_DOMAIN_NOT_AVAILABLE',
  'E_CONTENT_TOO_LARGE', 'E_DELIVERY_FAILED', 'E_RATE_LIMIT_EXCEEDED',
  'E_DAILY_LIMIT_EXCEEDED', 'E_INTERNAL_SERVER_ERROR', 'E_HEADER_NOT_ALLOWED',
  'E_HEADER_USE_API_FIELD', 'E_HEADER_VALUE_INVALID', 'E_HEADER_VALUE_TOO_LONG',
  'E_HEADER_NAME_INVALID', 'E_HEADERS_TOO_LARGE', 'E_HEADERS_TOO_MANY'
]);
const ACCOUNT_NOTICES = Object.freeze({
  'inactivity-warning': ['Review your {brand} account', 'Your account needs an activity review. Open your personal space to review its current status and options.'],
  'deletion-scheduled': ['Review scheduled {brand} account deletion', 'Account deletion has been scheduled. Open your personal space to review the schedule and available options.'],
  'deletion-cancelled': ['{brand} account deletion cancelled', 'Scheduled account deletion has been cancelled. Open your personal space to review your account.']
});
const SECURITY_ALERTS = Object.freeze({
  'recovery-used': ['{brand} account recovery used', 'An account recovery file was used.'],
  'passkey-added': ['{brand} passkey added', 'A passkey was added to your account.'],
  'passkey-removed': ['{brand} passkey removed', 'A passkey was removed from your account.'],
  'password-changed': ['{brand} password changed', 'Your account password was changed.']
});

function safeHeader(value, max = 2048) {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}
function validEmail(value) {
  if (!safeHeader(value, 254) || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+$/.test(value)) return false;
  const [local, domain] = value.split('@');
  return local.length <= 64 && !local.startsWith('.') && !local.endsWith('.') && !local.includes('..') && domain.includes('.') && domain.split('.').every(part => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(part));
}
function validOrigin(value) {
  if (!safeHeader(value)) return false;
  try { const url = new URL(value); return url.protocol === 'https:' && url.origin === value; }
  catch { return false; }
}
function validSenderDomain(value) {
  // Longest fixed local part is eight characters; complete address <=254.
  return safeHeader(value, 245) && value.includes('.') && !/^\d+\.\d+\.\d+\.\d+$/.test(value) && value.split('.').every(part => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(part));
}
function requireToken(value) {
  if (!safeHeader(value, 1024)) throw new Error('Invalid mail link.');
}

/** Hosted Cloudflare resource; portable services receive this through injection.
 * EMAIL.send acknowledges acceptance with messageId, without a documented
 * idempotency facility. Retry keys are not forwarded as deduplication promises.
 */
export function mailTransport(env = {}) {
  if (env.MAIL_ENABLED !== 'true' || typeof env.EMAIL?.send !== 'function' || !validOrigin(env.APP_ORIGIN)) return null;
  const origin = env.APP_ORIGIN;
  const domain = env.MAIL_SENDER_DOMAIN ?? new URL(origin).hostname;
  const brand = env.BRAND_NAME ?? new URL(origin).hostname;
  if (!validSenderDomain(domain) || !safeHeader(brand, 80) || !brand.trim()) return null;
  const senders = Object.fromEntries(Object.entries(SENDER_ROLES).map(([role, local]) => [role, `${local}@${domain.toLowerCase()}`]));
  const send = async ({ from, to, subject, text, headers = {} }) => {
    if (!Object.values(senders).includes(from) || !validEmail(to) || !safeHeader(subject) || typeof text !== 'string' || !text || Object.entries(headers).some(([name, value]) => name !== 'List-Unsubscribe' || !safeHeader(value))) throw new Error('Invalid mail envelope.');
    try {
      const result = await env.EMAIL.send({ from, to, subject, text, ...(Object.keys(headers).length ? { headers } : {}) });
      if (!safeHeader(result?.messageId)) throw new Error('Invalid mail acceptance result.');
      return { messageId: result.messageId };
    } catch (error) {
      // Never include provider messages, causes, recipient addresses, or tokens.
      throw Object.assign(new Error('Mail delivery is temporarily unavailable.'), {
        code: PROVIDER_CODES.has(error?.code) ? error.code : 'mail_delivery_unavailable'
      });
    }
  };
  const notice = (templates, from, { email, type }) => {
    if (!Object.hasOwn(templates, type)) throw new Error('Invalid mail notice type.');
    const [subject, text] = templates[type];
    return send({ from, to: email, subject: subject.replaceAll('{brand}', () => brand), text: `${text}\n\nOpen ${origin}/\n\nIf you did not request this change, review your account security in your personal space.` });
  };
  return {
    async sendVerification({ email, token, purpose, issuer }) {
      if (!['link', 'login'].includes(purpose) || issuer !== origin) throw new Error('Invalid mail verification request.');
      requireToken(token);
      const login = purpose === 'login';
      const url = `${origin}${login ? '/email/login' : '/email/confirm'}#token=${encodeURIComponent(token)}`;
      return send({ from: senders[purpose], to: email,
        subject: `Confirm your ${brand} ${login ? 'sign-in' : 'email'}`,
        text: `Only continue if you requested this ${login ? 'sign-in' : 'email association'}.\n\n${url}\n\nThe link expires in ten minutes. Opening it does not sign in or link the email until you confirm.${login ? '' : ' Confirm in the browser session that requested the association.'}` });
    },
    async sendReminder({ email, owner, token }) {
      requireToken(token);
      if (!safeHeader(owner, 128) || !/^[A-Za-z0-9_-]+$/.test(owner)) throw new Error('Invalid mail link.');
      const url = `${origin}/unsubscribe#token=${encodeURIComponent(`${owner}.${token}`)}`;
      return send({ from: senders.reminder, to: email, subject: `You have unread messages in ${brand}`,
        text: `You have unread messages in your personal space.\n\nOpen ${origin}/\n\nTurn off email notifications: ${url}`,
        headers: { 'List-Unsubscribe': `<${url}>` } });
    },
    // Resources for future lifecycle/security callers; these do not schedule
    // notices or establish that the corresponding event has occurred.
    sendAccountNotice: input => notice(ACCOUNT_NOTICES, senders.account, input),
    sendSecurityAlert: input => notice(SECURITY_ALERTS, senders.security, input)
  };
}
