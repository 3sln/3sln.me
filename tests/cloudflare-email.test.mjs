import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mailTransport } from '../apps/worker/email.mjs';

const origin = 'https://space.example';
const email = 'recipient@inbox.example';
const token = 'account-id.secret_opaque-token';
function fixture(send) {
  const sent = [];
  const env = { APP_ORIGIN: origin, MAIL_ENABLED: 'true', MAIL_SENDER_DOMAIN: 'sys.3sln.me', BRAND_NAME: '3sln.me', EMAIL: { async send(message) {
    sent.push(message);
    return send ? send(message) : { messageId: `accepted-${sent.length}` };
  } } };
  return { env, sent, transport: mailTransport(env) };
}

test('Cloudflare mail requires explicit enablement, binding and canonical HTTPS origin', () => {
  const { env } = fixture();
  for (const MAIL_ENABLED of [undefined, 'false', '', 'TRUE', true, 1]) assert.equal(mailTransport({ ...env, MAIL_ENABLED }), null);
  assert.equal(mailTransport(), null);
  assert.equal(mailTransport({ ...env, EMAIL: undefined }), null);
  assert.equal(mailTransport({ ...env, EMAIL: { send: true } }), null);
  for (const APP_ORIGIN of [undefined, 'http://localhost:8787', `${origin}/`, `${origin}/path`, `${origin}?query=1`, `${origin}#token`, 'https://person:secret@space.example', `${origin}\r\nInjected: yes`]) assert.equal(mailTransport({ ...env, APP_ORIGIN }), null);
  assert.equal(mailTransport({ APP_ORIGIN: origin, RESEND_API_KEY: 'obsolete', MAIL_FROM: 'arbitrary@sender.example' }), null);
});

test('link and login use distinct approved senders and fragment confirmation routes', async () => {
  const { transport, sent } = fixture();
  for (const purpose of ['link', 'login']) {
    const result = await transport.sendVerification({ email, token, purpose, issuer: origin });
    assert.deepEqual(result, { messageId: `accepted-${sent.length}` });
    const message = sent.at(-1);
    assert.equal(message.to, email);
    assert.equal(message.from, purpose === 'link' ? 'verify@sys.3sln.me' : 'login@sys.3sln.me');
    assert.match(message.text, /expires in ten minutes/);
    assert.match(message.text, /until you confirm/);
    const url = new URL(message.text.split('\n').find(line => line.startsWith('https://')));
    assert.equal(url.pathname, purpose === 'link' ? '/email/confirm' : '/email/login');
    assert.equal(url.search, '');
    assert.equal(new URLSearchParams(url.hash.slice(1)).get('token'), token);
    assert.equal(message.headers, undefined);
    assert.match(message.html, /<!doctype html>/);
    assert.equal(message.attachments, undefined);
  }
  assert.match(sent[0].text, /browser session that requested/);
});

test('hosted mail embeds the unchanged canonical logo without remote image fetches', async () => {
  const { env, sent } = fixture();
  const hostedOrigin = 'https://3sln.me';
  const transport = mailTransport({ ...env, APP_ORIGIN: hostedOrigin });
  await transport.sendVerification({ email, token, purpose: 'login', issuer: hostedOrigin });
  const message = sent[0];
  assert.match(message.html, /src="cid:3sln-logo"/);
  assert.doesNotMatch(message.html, /<img[^>]*src="https?:|<script|<iframe/);
  assert.equal(message.attachments.length, 1);
  const logo = message.attachments[0];
  assert.deepEqual({ ...logo, content: undefined }, { content: undefined, filename: '3sln-avatar.png', type: 'image/png', disposition: 'inline', contentId: '3sln-logo' });
  const source = await readFile(new URL('../apps/web/branding/3sln-avatar.png', import.meta.url));
  assert.deepEqual(Buffer.from(logo.content, 'base64'), source);
  assert.equal(logo.content.length < 26000, true);
  assert.match(message.html, /href="https:\/\/3sln.me\/email\/login#token=/);
  assert.match(message.text, /expires in ten minutes/);
});

test('HTML presentation escapes arbitrary operator brands and preserves fragment links', async () => {
  const { env, sent } = fixture();
  const brand = '<img src=x onerror="alert(1)"> & Own Space';
  const transport = mailTransport({ ...env, BRAND_NAME: brand });
  await transport.sendVerification({ email, token: 'opaque&<>"\'value', purpose: 'link', issuer: origin });
  const message = sent[0];
  assert.match(message.html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt; &amp; Own Space/);
  assert.doesNotMatch(message.html, /<img|cid:3sln-logo/);
  assert.equal(message.attachments, undefined);
  assert.equal(new URLSearchParams(new URL(message.text.split('\n').find(line => line.startsWith('https://'))).hash.slice(1)).get('token'), 'opaque&<>"\'value');
});

test('reminder uses notify sender, generic content and manual fragment unsubscribe', async () => {
  const { transport, sent } = fixture();
  const input = { email, owner: 'account-id', token: 'unsubscribe-secret', idempotencyKey: 'job-1:1', senderName: 'Private sender', body: 'Private message body' };
  await transport.sendReminder(input);
  await transport.sendReminder(input);
  assert.equal(sent.length, 2, 'the binding has no documented provider deduplication');
  const message = sent[0];
  assert.equal(message.from, 'notify@sys.3sln.me');
  assert.equal(message.to, email);
  assert.deepEqual(message.headers, { 'List-Unsubscribe': `<${origin}/unsubscribe#token=account-id.unsubscribe-secret>` });
  assert.equal(message.headers['List-Unsubscribe-Post'], undefined);
  assert.equal(message.headers['Message-ID'], undefined);
  assert.equal(message.idempotencyKey, undefined);
  assert.doesNotMatch(message.text, /Private sender|Private message body|job-1/);
});

test('account and security notice resources restrict templates and senders', async () => {
  const { transport, sent } = fixture();
  for (const type of ['inactivity-warning', 'deletion-scheduled', 'deletion-cancelled']) {
    await transport.sendAccountNotice({ email, type });
    assert.equal(sent.at(-1).from, 'accounts@sys.3sln.me');
    assert.match(sent.at(-1).text, /Open https:\/\/space.example\//);
  }
  assert.doesNotMatch(sent[1].text, /\d{4}-\d{2}-\d{2}|grace|days/);
  for (const type of ['recovery-used', 'passkey-added', 'passkey-removed', 'password-changed']) {
    await transport.sendSecurityAlert({ email, type });
    assert.equal(sent.at(-1).from, 'security@sys.3sln.me');
  }
  assert.throws(() => transport.sendAccountNotice({ email, type: 'unknown' }), /Invalid mail notice type/);
  assert.throws(() => transport.sendSecurityAlert({ email, type: 'toString' }), /Invalid mail notice type/);
  assert.equal(sent.length, 7);
});

test('mail rejects CRLF envelopes, token injection, malformed addresses and substituted issuers before binding calls', async () => {
  const { transport, sent } = fixture();
  const input = { email, token, purpose: 'link', issuer: origin };
  for (const badEmail of [`${email}\r\nBcc: other@inbox.example`, 'Person <recipient@inbox.example>', 'a@inbox.example,other@inbox.example', 'a..b@inbox.example', 'a@-bad.example', '', undefined]) await assert.rejects(transport.sendVerification({ ...input, email: badEmail }), /Invalid mail envelope/);
  for (const badToken of ['secret\r\nInjected: yes', '', undefined]) await assert.rejects(transport.sendVerification({ ...input, token: badToken }), /Invalid mail link/);
  for (const issuer of ['https://attacker.example', `${origin}\r\nInjected: yes`]) await assert.rejects(transport.sendVerification({ ...input, issuer }), /Invalid mail verification request/);
  await assert.rejects(transport.sendVerification({ ...input, purpose: 'recovery' }), /Invalid mail verification request/);
  await assert.rejects(transport.sendReminder({ email, token, owner: 'owner\r\nInjected: yes' }), /Invalid mail link/);
  assert.throws(() => transport.sendSecurityAlert({ email, type: 'password-changed\r\nSubject: forged' }), /Invalid mail notice type/);
  assert.equal(sent.length, 0);
});

test('provider errors preserve only known codes, never secrets, causes or logs', async t => {
  const logs = [];
  for (const method of ['log', 'info', 'warn', 'error']) t.mock.method(console, method, (...args) => logs.push(args));
  for (const code of ['E_SENDER_NOT_VERIFIED', `secret-${token}`]) {
    const { transport } = fixture(() => { throw Object.assign(new Error(`Failed ${email} ${token}`), { code, cause: new Error(token) }); });
    await assert.rejects(transport.sendVerification({ email, token, purpose: 'login', issuer: origin }), error => {
      assert.equal(error.message, 'Mail delivery is temporarily unavailable.');
      assert.equal(error.code, code === 'E_SENDER_NOT_VERIFIED' ? code : 'mail_delivery_unavailable');
      assert.equal(error.cause, undefined);
      assert.doesNotMatch(error.stack + JSON.stringify(error), /secret_opaque-token|recipient@inbox.example/);
      return true;
    });
  }
  assert.deepEqual(logs, []);
});

test('missing provider acceptance result fails safely', async () => {
  for (const result of [undefined, {}, { messageId: '' }, { messageId: 'id\r\nsecret' }]) {
    const { transport } = fixture(() => result);
    await assert.rejects(transport.sendVerification({ email, token, purpose: 'link', issuer: origin }), { message: 'Mail delivery is temporarily unavailable.', code: 'mail_delivery_unavailable' });
  }
});

test('checked-in Cloudflare config enables authorized mail and restricts the binding to five senders', async () => {
  const production = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  const local = JSON.parse(await readFile(new URL('../wrangler.local.jsonc', import.meta.url), 'utf8'));
  assert.equal(production.vars.MAIL_ENABLED, 'true');
  assert.equal(production.vars.MAIL_SENDER_DOMAIN, 'sys.3sln.me');
  assert.deepEqual(production.send_email, [{ name: 'EMAIL', allowed_sender_addresses: ['verify@sys.3sln.me', 'login@sys.3sln.me', 'notify@sys.3sln.me', 'accounts@sys.3sln.me', 'security@sys.3sln.me'] }]);
  assert.equal(local.send_email, undefined, 'local development cannot deliver remote mail');
  assert.notEqual(local.vars.MAIL_ENABLED, 'true');
});

test('self-hosted Cloudflare mail uses operator domain and brand with fixed roles and unchanged link issuer', async () => {
  const { env, sent } = fixture();
  const transport = mailTransport({ ...env, MAIL_SENDER_DOMAIN: undefined, BRAND_NAME: 'Own Space' });
  await transport.sendVerification({ email, token, purpose: 'link', issuer: origin, from: 'attacker@elsewhere.example' });
  await transport.sendVerification({ email, token, purpose: 'login', issuer: origin });
  await transport.sendReminder({ email, owner: 'account-id', token });
  await transport.sendAccountNotice({ email, type: 'deletion-scheduled' });
  await transport.sendSecurityAlert({ email, type: 'recovery-used' });
  assert.deepEqual(sent.map(message => message.from), ['verify@space.example', 'login@space.example', 'notify@space.example', 'accounts@space.example', 'security@space.example']);
  for (const message of sent) {
    assert.match(message.subject, /Own Space/);
    assert.doesNotMatch(JSON.stringify(message), /3sln.me|attacker@elsewhere/);
    assert.match(message.text, /https:\/\/space.example\//);
  }
  const custom = mailTransport({ ...env, MAIL_SENDER_DOMAIN: 'MAIL.OPERATOR.EXAMPLE', BRAND_NAME: undefined });
  await custom.sendVerification({ email, token, purpose: 'login', issuer: origin });
  assert.equal(sent.at(-1).from, 'login@mail.operator.example');
  assert.equal(sent.at(-1).subject, 'Confirm your space.example sign-in');
  await assert.rejects(custom.sendVerification({ email, token, purpose: 'login', issuer: 'https://mail.operator.example' }), /Invalid mail verification request/);
  for (const domain of ['localhost', '127.0.0.1', 'https://sender.example', 'sender.example/path', 'sender.example:443', 'other@sender.example', 'sender.example\r\nBcc: stolen', '-sender.example', 'sender..example', 'sender.example.', `${'x'.repeat(64)}.example`, '']) assert.equal(mailTransport({ ...env, MAIL_SENDER_DOMAIN: domain }), null);
  for (const brand of ['\r\nSubject: forged', ' ', '', 'x'.repeat(81)]) assert.equal(mailTransport({ ...env, BRAND_NAME: brand }), null);
});

test('signup codes use the verified sender and reject malformed proof envelopes before delivery',async()=>{const {transport,sent}=fixture();await transport.sendSetupCode({email,code:'01234567',issuer:origin});assert.equal(sent[0].from,'verify@sys.3sln.me');assert.match(sent[0].text,/01234567/);assert.match(sent[0].text,/does not sign you in/);for(const code of ['1234567','123456789','1234\n567','abcdefgh'])await assert.rejects(transport.sendSetupCode({email,code,issuer:origin}),/Invalid setup verification request/);await assert.rejects(transport.sendSetupCode({email,code:'01234567',issuer:'https://attacker.example'}));assert.equal(sent.length,1);});
test('unpaid suspension and deletion notices have bounded countdowns and preserve external-storage distinction',async()=>{const {transport,sent}=fixture();await transport.sendAccountNotice({email,type:'suspension-warning',days:7});await transport.sendAccountNotice({email,type:'deletion-warning',days:30});assert.equal(sent[0].from,'accounts@sys.3sln.me');assert.match(sent[0].subject,/Action required.*suspended in 7 days/);assert.match(sent[1].subject,/Action required.*deleted in 30 days/);assert.match(sent[1].text,/external storage providers will not be deleted/);for(const days of [0,-1,1.5,3651,'7'])await assert.rejects(async()=>transport.sendAccountNotice({email,type:'suspension-warning',days}),/Invalid account notice deadline/);assert.equal(sent.length,2);});

test('setup email uses the shared Bab catalogue for the requested supported language',async()=>{const {transport,sent}=fixture();await transport.sendSetupCode({email,code:'01234567',issuer:origin,locale:'es'});assert.match(sent[0].subject,/Confirma/);assert.match(sent[0].text,/01234567/);assert.doesNotMatch(sent[0].text,/Your verification code/);});

test('waitlist confirmation mail uses the registered verification sender, Bab locale and explicit opt-in fragment', async () => {
  const {transport,sent}=fixture();
  for(const locale of ['en','es']){
    await transport.sendWaitlistConfirmation({email,token,issuer:origin,locale});
    const message=sent.at(-1);assert.equal(message.from,'verify@sys.3sln.me');assert.equal(message.to,email);
    const url=new URL(message.text.split('\n').find(line=>line.startsWith('https://')));
    assert.equal(url.origin,origin);assert.equal(url.pathname,'/waitlist/confirm');assert.equal(url.search,'');
    assert.equal(new URLSearchParams(url.hash.slice(1)).get('token'),token);
    assert.match(message.subject,locale==='es'?/Confirma tu solicitud/:/Confirm your/);
    assert.match(message.text,locale==='es'?/no crea una cuenta ni reserva una plaza/:/does not create an account or reserve a place/);
    assert.match(message.text,locale==='es'?/diez minutos/:/ten minutes/);
    assert.match(message.html,/waitlist\/confirm#token=/);assert.equal(message.headers,undefined);
  }
});

test('waitlist mail rejects alternate issuers, header injection and unsupported locales before sending', async () => {
  const {transport,sent}=fixture();
  for(const override of [{issuer:'https://other.example'},{token:'bad\r\nHeader: yes'},{email:'recipient@inbox.example\r\nInjected: yes'},{locale:'unsupported'}]){
    await assert.rejects(transport.sendWaitlistConfirmation({email,token,issuer:origin,...override}));
  }
  assert.equal(sent.length,0);
});
