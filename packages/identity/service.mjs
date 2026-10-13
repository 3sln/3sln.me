import {normalizeHandle,validatePaidHandle} from './handles.mjs';
import { IdentityCrypto, secureEqual } from './crypto.mjs';
import { DeviceLogin } from './device-login.mjs';

export class IdentityFault extends Error {
  constructor(code, message = 'The account request could not be completed.') { super(message); this.code = code; }
}
const fail = (code, message) => { throw new IdentityFault(code, message); };
const publicAccount = a => ({ id: a.id, handle: a.handle, status: a.status, createdAt: a.createdAt,
  termsVersion: a.termsVersion, hasPassword: Boolean(a.passwordHash), passkeyCount: a.credentials.length,
  recoveryConfigured: Boolean(a.recoveryHash), paidHandle:a.paidHandle||null, aliases:[a.handle,...a.paidHandle?[a.paidHandle]:[]], verifiedEmail: a.verifiedEmail || null, emailLoginEnabled: a.emailLoginEnabled === true, lastActiveAt: a.lastActiveAt });
function emailAddress(value) {
  if (typeof value !== 'string' || value.length > 254 || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+$/.test(value)) fail('invalid_email', 'Enter an ordinary email address.');
  const [local, domain] = value.split('@');
  if (local.length > 64 || local.startsWith('.') || local.endsWith('.') || local.includes('..') || !domain.includes('.') || domain.split('.').some(part => !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(part))) fail('invalid_email');
  return `${local}@${domain.toLowerCase()}`;
}
function handle(value){try{return normalizeHandle(value);}catch{fail('invalid_handle','Enter your complete account handle.');}}

function password(value) {
  if (typeof value !== 'string' || [...value].length < 15 || [...value].length > 128 || new TextEncoder().encode(value).length > 512) fail('invalid_password', 'Use a password of 15–128 characters.');
  return value;
}
function tokenParts(value) {
  if (typeof value !== 'string' || value.length > 150 || !/^[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/.test(value)) fail('unauthorized', 'Authentication failed.');
  return value.split('.');
}
function safeLabel(value, fallback = 'Browser session') {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !value.trim() || value.length > 80 || /[\u0000-\u001f\u007f]/.test(value)) fail('invalid_label', 'Use a device or passkey name of 1–80 characters.');
  return value.trim();
}
const publicCredentials = account => account.credentials.map(({ id, label, deviceType, backedUp, createdAt }) => ({ id, label: label || 'Passkey', deviceType, backedUp, createdAt }));

/** Platform-independent account policy. Repository must implement linearizable
 * create and compareAndSwap; an in-memory repository is only a test resource. */
export class IdentityService {
  constructor({ repository, deviceRequests, crypto, clock = () => Date.now(), turnstile, rateLimiter, webauthn, passwordHasher, mailer, identityBackup, paidHandleEligibility, pushTransport, config }) {
    if (!repository || !turnstile || !rateLimiter || !webauthn || !passwordHasher || !config?.termsVersion) throw new TypeError('Identity resources and terms version are required');
    const origin = new URL(config.origin);
    if (origin.origin !== config.origin || origin.hostname !== config.rpID || (origin.protocol !== 'https:' && !(config.allowInsecureLocalhost && origin.protocol === 'http:' && origin.hostname === 'localhost'))) throw new TypeError('Exact RP origin is required');
    this.repository = repository; this.crypto = new IdentityCrypto(crypto); this.clock = clock;
    this.turnstile = turnstile; this.rateLimiter = rateLimiter; this.webauthn = webauthn; this.passwordHasher = passwordHasher;
    this.pushTransport=pushTransport;this.mailer = mailer; this.identityBackup = identityBackup; this.paidHandleEligibility=paidHandleEligibility;
    this.deviceRequests = deviceRequests;
    this.config = { rpName: '3sln.me', sessionTtlMs: 86400000, pendingTtlMs: 1800000, challengeTtlMs: 300000, ...config };
    if (!(this.config.sessionTtlMs > 0 && this.config.sessionTtlMs <= 86400000)) throw new TypeError('Sessions must expire within 24 hours');
  }
  origin(context) { if (context?.origin !== this.config.origin) fail('csrf', 'Use the account website to complete this request.'); }
  async guard(operation, input, context) {
    this.origin(context);
    if (!await this.rateLimiter.check({ phase: 'attempt', operation, remoteIP: context.remoteIP, region:context.region, handle: input.handle })) fail('rate_limited', 'Please wait before trying again.');
    if (typeof input.turnstileToken !== 'string' || input.turnstileToken.length > 4096 || !await this.turnstile.verify({ token: input.turnstileToken, remoteIP: context.remoteIP, action: operation, hostname: new URL(this.config.origin).hostname })) fail('challenge_failed', 'Complete the security check and try again.');
  }
  audit(account, type) { account.audit = [...(account.audit || []).slice(-99), { id: this.crypto.id(), type, at: this.clock() }]; }
  async save(account, revision) {
    account.revision = revision + 1;
    if (!await this.repository.compareAndSwap(account.id, revision, account)) fail('conflict', 'The account changed; start this step again.');
  }
  async pending(value, context) {
    const [id] = tokenParts(value); const account = await this.repository.get(id);
    if (!account || !['pending', 'recovering'].includes(account.status) || account.pendingExpiresAt <= this.clock() || !secureEqual(account.pendingHash, await this.crypto.hash('pending', value))) fail('unauthorized', 'This setup session has expired.');
    if(account.setupBindingHash&&(!context?.setupBinding||!secureEqual(account.setupBindingHash,await this.crypto.hash('setup-binding',context.setupBinding))))fail('unauthorized','Continue account setup in the browser that started it.');return account;
  }
  async newPending(account,context) {
    if(this.config.requireReachability===true&&context){if(!context.setupBinding)fail('unauthorized');account.setupBindingHash=await this.crypto.hash('setup-binding',context.setupBinding);}
    delete account.setupEmailChallenge;delete account.setupPushChallenge;delete account.setupPushVerified;
    const value = `${account.id}.${this.crypto.random()}`;
    account.pendingHash = await this.crypto.hash('pending', value); account.pendingExpiresAt = this.clock() + this.config.pendingTtlMs;
    return value;
  }
  async session(account, { label, credentialId, source = 'credential' } = {}) {
    const sessionToken = `${account.id}.${this.crypto.random()}`; const csrfToken = this.crypto.random();
    const expiresAt = this.clock() + this.config.sessionTtlMs;
    account.sessions = [...account.sessions.filter(s => s.expiresAt > this.clock()).slice(-9), {
      id: this.crypto.id(), label: safeLabel(label), credentialId, source,
      hash: await this.crypto.hash('session', sessionToken), csrfToken, expiresAt, createdAt: this.clock(), lastUsedAt: this.clock() }];
    account.lastActiveAt = this.clock(); this.audit(account, 'session-created');
    return { account: publicAccount(account), sessionToken, csrfToken, expiresAt };
  }
  async authorized(context, mutation = false) {
    if (mutation) this.origin(context);
    const [id] = tokenParts(context?.sessionToken); const account = await this.repository.get(id);
    const hash = await this.crypto.hash('session', context.sessionToken);
    const session = account?.sessions.find(s => secureEqual(s.hash, hash) && s.expiresAt > this.clock());
    if (!account || account.status !== 'active' || !session) fail('unauthorized', 'Sign in to continue.');
    if (mutation && !secureEqual(session.csrfToken, context.csrfToken)) fail('csrf', 'Reload the account page and try again.');
    return { account, session };
  }
  async recent(context) {
    const result = await this.authorized(context, true);
    if (result.session.createdAt + 900000 <= this.clock()) fail('reauthentication_required', 'Sign in again before changing account access.');
    return result;
  }
  async sessionID(session) { return session.id || this.crypto.hash('session-public-id', session.hash); }
  async signup(input, context) {
    await this.guard('signup', input, context);
    if(!this.repository.allocateFreeHandle)handle(input.handle);
    if (input.termsAccepted !== true || input.termsVersion !== this.config.termsVersion) fail('terms_required', 'Agree to the current account terms.');
    if (!['passkey', 'password'].includes(input.method)) fail('invalid_method');
    const selectedPassword = input.method === 'password' ? password(input.password) : null;
    if (!this.repository.allocateFreeHandle&&await this.repository.findByHandle(input.handle)) fail('handle_unavailable', 'Choose another account handle.');
    // Global/daily creation capacity is reserved only for a valid proof and
    // complete valid signup, never for anonymous CAPTCHA or malformed attempts.
    if (!await this.rateLimiter.check({ phase: 'admitted', operation: 'signup', remoteIP: context.remoteIP, region:context.region, handle: input.handle })) fail('rate_limited', 'Account creation is limited for this network or region. Please try again in a few hours.');
    const id=this.crypto.id(),assignmentId=this.crypto.id();
    const allocatedHandle=this.repository.allocateFreeHandle?await this.repository.allocateFreeHandle(input.handle,id,assignmentId):input.handle;
    const account = { id, assignmentId, nameAssignmentId:assignmentId, revision: 0, handle: allocatedHandle, status: 'pending',
      createdAt: this.clock(), lastActiveAt: this.clock(), termsVersion: this.config.termsVersion,
      termsAcceptedAt: this.clock(), credentials: [], sessions: [], challenges: [], audit: [], recoveryHash: null, emailLoginEnabled: false,
      passwordHash: selectedPassword ? await this.passwordHasher.hash(selectedPassword) : null };
    if(this.config.requireReachability===true){if(!context.setupBinding)fail('unauthorized','Start setup in the account browser.');account.setupBindingHash=await this.crypto.hash('setup-binding',context.setupBinding);}
    const pendingToken = await this.newPending(account,context);
    let registrationOptions;
    if (input.method === 'passkey') {
      registrationOptions = await this.webauthn.registrationOptions({ account, config: this.config });
      account.challenges.push({ purpose: 'register', value: registrationOptions.challenge, expiresAt: this.clock() + this.config.challengeTtlMs });
    }
    this.audit(account, 'signup-pending');
    if (!await this.repository.create(account)) fail('handle_unavailable', 'Choose another account handle.');
    return { pendingToken, account: publicAccount(account), registrationOptions, readyForRecovery: input.method === 'password' };
  }
  async beginPasskeyRegistration(input, context) {
    this.origin(context); const account = await this.pending(input.pendingToken,context); const revision = account.revision;
    const registrationOptions = await this.webauthn.registrationOptions({ account, config: this.config });
    account.challenges = [{ purpose: 'register', value: registrationOptions.challenge, expiresAt: this.clock() + this.config.challengeTtlMs }];
    await this.save(account, revision); return { registrationOptions };
  }
  async registerPasskey(input, context) {
    this.origin(context); const account = await this.pending(input.pendingToken,context); const revision = account.revision;
    const challenge = account.challenges.find(c => c.purpose === 'register' && c.expiresAt > this.clock());
    if (!challenge) fail('invalid_challenge');
    let credential;
    try { credential = await this.webauthn.verifyRegistration({ response: input.response, challenge: challenge.value, config: this.config }); } catch { fail('invalid_passkey', 'Passkey verification failed.'); }
    if (!credential?.id || !credential.publicKey || account.credentials.length >= 5 || account.credentials.some(c => c.id === credential.id)) fail('invalid_passkey');
    account.credentials.push({ ...credential, label: safeLabel(input.label, 'Passkey'), createdAt: this.clock() }); account.challenges = []; this.audit(account, 'passkey-registered');
    await this.save(account, revision); return { readyForRecovery: true };
  }
  async setPendingPassword(input, context) {
    this.origin(context); const account = await this.pending(input.pendingToken,context); const revision = account.revision;
    account.passwordHash = await this.passwordHasher.hash(password(input.password));
    this.audit(account, 'password-configured'); await this.save(account, revision); return { readyForRecovery: true };
  }
  async downloadRecovery(input, context) {
    this.origin(context); const account = await this.pending(input.pendingToken,context); const revision = account.revision;
    if (!account.passwordHash && !account.credentials.length) fail('credential_required', 'Set up your passkey or password first.');
    const recoveryToken = `${account.id}.${this.crypto.random()}`;
    account.recoveryHash = await this.crypto.hash('recovery', recoveryToken); account.recoveryIssuedAt = this.clock();
    let backup;
    if(this.identityBackup){
      account.nameAssignmentId ||= this.crypto.id();
      backup=await this.identityBackup.issue(account,recoveryToken);
      account.recoveryBackupVersion=2;
    }
    this.audit(account, 'recovery-file-issued'); await this.save(account, revision);
    if(backup)return {fileName:`3sln-recovery-${account.id}.json`,content:JSON.stringify(backup),handle:account.handle,recoveryToken};
    return { fileName: `3sln-recovery-${account.handle}.json`, content: JSON.stringify({ version: 1,
      issuer: this.config.origin, handle: account.handle, recoveryToken,
      warning: 'Keep this file private and backed up. It is the only way to recover this account without a verified email or phone. It starts one recovery transaction and can resume that transaction until replacement setup is confirmed.' }, null, 2), recoveryToken };
  }
  async claimHandle(input,context){
    const {account}=await this.recent(context);
    let selected;try{selected=validatePaidHandle(input.handle);}catch{fail('invalid_handle','Choose a custom handle of 3–32 letters, digits, underscores or hyphens.');}
    if(!await this.rateLimiter.check({operation:'handle-claim',remoteIP:context.remoteIP}))fail('rate_limited','Please wait before trying again.');
    if(account.paidHandle&&account.paidHandle!==selected)fail('handle_already_claimed','This identity already has a permanent custom handle.');
    if(!this.paidHandleEligibility||!await this.paidHandleEligibility(account.id))fail('paid_history_required','A verified paid subscription is required to claim a custom handle.');
    if(!this.repository.claimPaidHandle||!account.assignmentId)fail('handle_claim_unavailable','Custom handles are unavailable for this identity.');
    if(!await this.repository.claimPaidHandle(selected,account.id,account.assignmentId))fail('handle_unavailable','This handle is permanently assigned or you already claimed another handle.');
    if(!account.paidHandle){const revision=account.revision;account.paidHandle=selected;this.audit(account,'paid-handle-claimed');await this.save(account,revision);}
    return {account:publicAccount(account)};
  }
  async handleCertificate(input,context){
    const {account}=await this.authorized(context,true);
    if(!this.identityBackup?.certificate)fail('recovery_unavailable','Certificate signing is unavailable.');
    const selected=input.handle===undefined?account.handle:handle(input.handle);
    if(selected!==account.handle&&selected!==account.paidHandle&&selected!==await this.repository.paidHandleForOwner?.(account.id))fail('forbidden','This handle does not belong to your identity.');
    const certificate=await this.identityBackup.certificate(account,selected,this.clock());
    return {fileName:`handle-claim-${selected}.json`,content:JSON.stringify(certificate,null,2)};
  }
  setupProjection(account){const push=typeof this.pushTransport?.send==='function'&&typeof this.pushTransport?.register==='function'&&account.setupPushVerified?.expiresAt>this.clock();return {accountId:account.id,channelRequired:this.config.requireReachability===true,channelVerified:Boolean(account.verifiedEmail&&Number.isFinite(account.emailVerifiedAt)||push),verifiedEmail:account.verifiedEmail??null,pushVerified:Boolean(push),emailAvailable:typeof this.mailer?.sendSetupCode==='function',pushAvailable:typeof this.pushTransport?.send==='function'&&typeof this.pushTransport?.register==='function'};}
  async setupSendAdmission(account,kind,context,target){const now=this.clock(),windowKey='setup'+kind+'WindowAt',countKey='setup'+kind+'Sends',sentKey='setup'+kind+'SentAt';const window=account[windowKey];if(window!==undefined&&(!Number.isSafeInteger(window)||window>now))fail('rate_limited');if(window===undefined||now-window>=600000){account[windowKey]=now;account[countKey]=0;}if(!Number.isInteger(account[countKey])||account[countKey]<0||account[countKey]>=3||account[sentKey]&&now-account[sentKey]<60000||!await this.rateLimiter.check({operation:'email',remoteIP:context.remoteIP,handle:target}))fail('rate_limited','Wait before requesting another verification check.');account[countKey]++;account[sentKey]=now;}
  async setupStatus(input,context){this.origin(context);return this.setupProjection(await this.pending(input.pendingToken,context));}
  async setupEmailStart(input,context){this.origin(context);if(input.locale!==undefined&&!['en','es'].includes(input.locale))fail('invalid_locale','Choose English or Spanish.');const account=await this.pending(input.pendingToken,context),revision=account.revision;if(typeof this.mailer?.sendSetupCode!=='function')fail('email_unavailable','Email delivery is not configured.');const email=emailAddress(input.email),now=this.clock();await this.setupSendAdmission(account,'Email',context,email);let number;do{number=globalThis.crypto.getRandomValues(new Uint32Array(1))[0];}while(number>=4200000000);const code=String(number%100000000).padStart(8,'0');account.setupEmailChallenge={email,hash:await this.crypto.hash('setup-email',account.id+'|'+account.pendingHash+'|'+email+'|'+code),pendingHash:account.pendingHash,expiresAt:now+600000,attempts:0};await this.save(account,revision);await this.mailer.sendSetupCode({email,code,issuer:this.config.origin,locale:input.locale??'en'});return {sent:true,...this.setupProjection(account)};}
  async setupEmailConfirm(input,context){this.origin(context);const account=await this.pending(input.pendingToken,context),revision=account.revision,challenge=account.setupEmailChallenge;if(!challenge||challenge.pendingHash!==account.pendingHash||challenge.expiresAt<=this.clock()||challenge.attempts>=5||typeof input.code!=='string'||!/^\d{8}$/.test(input.code))fail('invalid_challenge','Request a fresh email code.');challenge.attempts++;if(!secureEqual(challenge.hash,await this.crypto.hash('setup-email',account.id+'|'+account.pendingHash+'|'+challenge.email+'|'+input.code))){await this.save(account,revision);fail('invalid_challenge','That email code is incorrect.');}const existing=await this.repository.findByEmail(challenge.email);if(existing&&existing.id!==account.id)fail('email_already_linked','This verified email belongs to another account. Sign in to that account.');account.verifiedEmail=challenge.email;account.emailVerifiedAt=this.clock();account.emailLoginEnabled=false;delete account.setupEmailChallenge;this.audit(account,'setup-email-verified');await this.save(account,revision);return this.setupProjection(account);}
  async setupPushStart(input,context){this.origin(context);if(input.locale!==undefined&&!['en','es'].includes(input.locale))fail('invalid_locale','Choose English or Spanish.');const account=await this.pending(input.pendingToken,context),revision=account.revision;if(typeof this.pushTransport?.send!=='function')fail('push_unavailable','Push delivery is not configured.');const subscription=input.subscription;if(!subscription||typeof subscription.endpoint!=='string'||subscription.endpoint.length>4096||!subscription.keys||typeof subscription.keys.p256dh!=='string'||typeof subscription.keys.auth!=='string'||JSON.stringify(subscription).length>8192)fail('invalid_subscription','Use a browser-created push subscription.');await this.setupSendAdmission(account,'Push',context,account.handle);const proof=account.id+'.'+this.crypto.random();account.setupPushChallenge={subscription:structuredClone(subscription),hash:await this.crypto.hash('setup-push',proof),pendingHash:account.pendingHash,expiresAt:this.clock()+300000};delete account.setupPushVerified;await this.save(account,revision);await this.pushTransport.send(subscription,{type:'bindle-setup-challenge',proof,owner:account.id,locale:input.locale??'en'});return {sent:true,...this.setupProjection(account)};}
  async setupPushConfirm(input,context){this.origin(context);const account=await this.pending(input.pendingToken,context),revision=account.revision,challenge=account.setupPushChallenge;if(typeof this.pushTransport?.send!=='function'||!challenge||challenge.pendingHash!==account.pendingHash||challenge.expiresAt<=this.clock()||typeof input.proof!=='string'||!secureEqual(challenge.hash,await this.crypto.hash('setup-push',input.proof)))fail('invalid_challenge','Enable notifications and request a fresh push check.');account.setupPushVerified={subscription:challenge.subscription,verifiedAt:this.clock(),expiresAt:account.pendingExpiresAt};delete account.setupPushChallenge;this.audit(account,'setup-push-verified');await this.save(account,revision);return this.setupProjection(account);}
  async requireSetupChannel(account){if(this.config.requireReachability!==true)return;if(account.verifiedEmail&&Number.isFinite(account.emailVerifiedAt)){const owner=await this.repository.findByEmail(account.verifiedEmail);if(owner?.id===account.id)return;}if(typeof this.pushTransport?.send==='function'&&account.setupPushVerified?.expiresAt>this.clock()){if(typeof this.pushTransport.register!=='function')fail('push_unavailable','Push registration is not configured.');await this.pushTransport.register({owner:account.id,subscription:account.setupPushVerified.subscription});if(account.pendingExpiresAt<=this.clock()||account.setupPushVerified.expiresAt<=this.clock())fail('unauthorized','This setup proof expired. Start another check.');return;}fail('contact_required','Verify an email address or enable and verify push notifications before activating your account.');}
  async confirmRecovery(input, context) {
    this.origin(context); const account = await this.pending(input.pendingToken,context); const revision = account.revision,activationDeadline=account.pendingExpiresAt;
    if (input.downloadConfirmed !== true || !account.recoveryHash || typeof input.recoveryToken !== 'string' || !secureEqual(account.recoveryHash, await this.crypto.hash('recovery', input.recoveryToken))) fail('recovery_confirmation_required', 'Download and confirm your recovery file before continuing.');
    if (!account.passwordHash && !account.credentials.length) fail('credential_required');
    await this.requireSetupChannel(account);
    account.status = 'active'; account.pendingHash = null; account.pendingExpiresAt = null; account.challenges = [];delete account.setupBindingHash;delete account.setupEmailChallenge;delete account.setupPushChallenge;delete account.setupEmailSends;delete account.setupEmailSentAt;delete account.setupPushSends;delete account.setupPushSentAt;delete account.setupEmailWindowAt;delete account.setupPushWindowAt;
    delete account.recoveryResumeHash; delete account.recoveryResumeBackupVersion;
    this.audit(account, 'account-activated'); const result = await this.session(account);if(activationDeadline<=this.clock())fail('unauthorized','This setup session expired.');
    await this.save(account, revision); return result;
  }
  async resumeSetupCredential(account,context,revision=account.revision){const pendingToken=await this.newPending(account,context);account.challenges=[];this.audit(account,'setup-credential-resumed');await this.save(account,revision);return {pendingToken,account:publicAccount(account),readyForRecovery:Boolean(account.passwordHash||account.credentials.length),credentialRequired:false,resumed:true,setup:this.setupProjection(account)};}
  async loginPassword(input, context) {
    this.origin(context);input={...input,handle:handle(input.handle)};await this.guard('login', input, context); password(input.password);
    const account = await this.repository.findByHandle(input.handle);
    // The dummy hash performs equivalent KDF work for unknown accounts.
    this.dummyPasswordHash ??= this.passwordHasher.dummyHash || this.passwordHasher.hash(this.crypto.random());
    const dummyHash = await this.dummyPasswordHash;
    const hash = account?.passwordHash || dummyHash;
    const verified = await this.passwordHasher.verify(input.password, hash);
    if (!account || !['active',...this.config.requireReachability===true?['pending','recovering']:[]].includes(account.status) || !account.passwordHash || !verified) fail('unauthorized', 'Authentication failed.');
    if(account.status!=='active')return this.resumeSetupCredential(account,context);
    const revision = account.revision; const result = await this.session(account, { label: input.label }); await this.save(account, revision); return result;
  }
  async beginPasskeyLogin(input, context) {
    this.origin(context);input={...input,handle:handle(input.handle)};await this.guard('login', input, context);
    const account = await this.repository.findByHandle(input.handle);
    const authenticationOptions = await this.webauthn.authenticationOptions({ config: this.config });
    const challengeToken = `${account?.id || this.crypto.id()}.${this.crypto.random()}`;
    if (account?.status === 'active'||this.config.requireReachability===true&&['pending','recovering'].includes(account?.status)) {
      const revision = account.revision;
      account.challenges = [...account.challenges.filter(c => c.expiresAt > this.clock() && c.purpose !== 'register').slice(-4),
        { purpose: 'login', value: authenticationOptions.challenge, hash: await this.crypto.hash('challenge', challengeToken), expiresAt: this.clock() + this.config.challengeTtlMs }];
      await this.save(account, revision);
    }
    return { authenticationOptions, challengeToken };
  }
  async finishPasskeyLogin(input, context) {
    this.origin(context);
    if (!await this.rateLimiter.check({ operation: 'assertion', remoteIP: context.remoteIP })) fail('rate_limited');
    const [id] = tokenParts(input.challengeToken); const account = await this.repository.get(id);
    const hash = await this.crypto.hash('challenge', input.challengeToken);
    const challenge = account?.challenges.find(c => c.purpose === 'login' && secureEqual(c.hash, hash) && c.expiresAt > this.clock());
    const credential = account?.credentials.find(c => c.id === input.response?.id);
    if (!account || !['active',...this.config.requireReachability===true?['pending','recovering']:[]].includes(account.status) || !challenge || !credential) fail('unauthorized', 'Authentication failed.');
    const revision = account.revision; let verified;
    try { verified = await this.webauthn.verifyAuthentication({ response: input.response, challenge: challenge.value, credential, account, config: this.config }); } catch { fail('unauthorized', 'Authentication failed.'); }
    credential.counter = verified.counter; credential.backedUp = verified.backedUp;
    account.challenges = account.challenges.filter(c => c !== challenge);
    if(account.status!=='active')return this.resumeSetupCredential(account,context,revision);
    const result = await this.session(account, { label: input.label, credentialId: credential.id }); await this.save(account, revision); return result;
  }
  async recover(input, context) {
    await this.guard('recovery', input, context); const [id] = tokenParts(input.recoveryToken);
    const account = await this.repository.get(id);
    const proofHash = await this.crypto.hash('recovery', input.recoveryToken);
    const resumed = account?.status === 'recovering' && secureEqual(account.recoveryResumeHash, proofHash);
    if (!account || (!resumed && (!['active','pending'].includes(account.status) || !secureEqual(account.recoveryHash, proofHash)))) fail('unauthorized', 'Recovery failed.');
    if((resumed?account.recoveryResumeBackupVersion:account.recoveryBackupVersion)===2){
      if(!this.identityBackup||!input.identityBackup)fail('unauthorized','Provide the signed identity recovery file.');
      try{await this.identityBackup.verify(input.identityBackup,account,input.recoveryToken);}catch{fail('unauthorized','Recovery failed.');}
    }
    const revision = account.revision;
    if (!resumed) {
      account.recoveryResumeHash = account.recoveryHash;
      account.recoveryResumeBackupVersion=account.recoveryBackupVersion||1;
      account.status = 'recovering'; account.recoveryHash = null; account.credentials = []; account.passwordHash = null; account.sessions = []; account.emailChallenges = [];
    }
    // Resumption only rotates the limited setup authority; completed replacement
    // credentials and the replacement recovery file remain intact.
    account.challenges = [];
    const pendingToken = await this.newPending(account,context); this.audit(account, resumed ? 'recovery-setup-resumed' : 'account-recovery-started');
    await this.save(account, revision);
    const credentialRequired = !account.passwordHash && !account.credentials.length;
    return { pendingToken, account: publicAccount(account), credentialRequired, readyForRecovery: !credentialRequired, resumed };
  }
  async owner(input, context) {
    const { account, session } = await this.authorized(context);
    if(!account.paidHandle&&this.repository.paidHandleForOwner)account.paidHandle=await this.repository.paidHandleForOwner(account.id)||undefined;
    // Throttle last-use persistence; telemetry must not cause a read to fail
    // if another authenticated mutation won the account revision race.
    if ((session.lastUsedAt || session.createdAt) + 60000 <= this.clock()) {
      const revision = account.revision; session.lastUsedAt = this.clock();
      account.revision = revision + 1;
      await this.repository.compareAndSwap(account.id, revision, account);
    }
    return { account: publicAccount(account), csrfToken: session.csrfToken, expiresAt: session.expiresAt,
      credentials: publicCredentials(account),
      devices: await Promise.all(account.sessions.filter(s => s.expiresAt > this.clock()).map(async s => ({
        id: await this.sessionID(s), label: s.label || 'Browser session', createdAt: s.createdAt,
        lastUsedAt: s === session ? this.clock() : s.lastUsedAt || s.createdAt, expiresAt: s.expiresAt, current: s === session }))),
      audit: account.audit.slice(-20) };
  }
  async credentialBegin(input, context) {
    const { account, session } = await this.recent(context); const revision = account.revision;
    if (account.credentials.length >= 5) fail('credential_limit', 'You can register up to five passkeys.');
    const registrationOptions = await this.webauthn.registrationOptions({ account, config: this.config });
    const challengeId = this.crypto.id();
    account.challenges = [...account.challenges.filter(c => c.expiresAt > this.clock() && c.purpose !== 'credential').slice(-4), {
      id: challengeId, purpose: 'credential', value: registrationOptions.challenge, sessionHash: session.hash,
      label: safeLabel(input.label, 'Passkey'), expiresAt: this.clock() + this.config.challengeTtlMs }];
    await this.save(account, revision); return { registrationOptions, challengeId };
  }
  async credentialFinish(input, context) {
    const { account, session } = await this.recent(context); const revision = account.revision;
    const challenge = account.challenges.find(c => c.purpose === 'credential' && c.id === input.challengeId && c.expiresAt > this.clock() && secureEqual(c.sessionHash, session.hash));
    if (!challenge) fail('invalid_challenge');
    let credential;
    try { credential = await this.webauthn.verifyRegistration({ response: input.response, challenge: challenge.value, config: this.config }); } catch { fail('invalid_passkey', 'Passkey verification failed.'); }
    if (!credential?.id || !credential.publicKey || account.credentials.length >= 5 || account.credentials.some(c => c.id === credential.id)) fail('invalid_passkey');
    account.credentials.push({ ...credential, label: challenge.label, createdAt: this.clock() });
    account.challenges = account.challenges.filter(c => c !== challenge); this.audit(account, 'passkey-added');
    await this.save(account, revision); return { credentials: publicCredentials(account) };
  }
  async renamePasskey(input, context) {
    const { account } = await this.recent(context); const revision = account.revision;
    const credential = account.credentials.find(c => c.id === input.credentialId);
    if (!credential) fail('not_found', 'Passkey not found.');
    credential.label = safeLabel(input.label, 'Passkey'); this.audit(account, 'passkey-renamed');
    await this.save(account, revision); return { credentials: publicCredentials(account) };
  }
  async removePasskey(input, context) {
    const { account, session } = await this.recent(context); const revision = account.revision;
    if (!account.credentials.some(c => c.id === input.credentialId)) fail('not_found', 'Passkey not found.');
    if (!account.recoveryHash || (account.credentials.length === 1 && !account.passwordHash)) fail('credential_required', 'Keep a working login method and your recovery file before removing this passkey.');
    account.credentials = account.credentials.filter(c => c.id !== input.credentialId);
    account.sessions = account.sessions.filter(s => s.credentialId !== input.credentialId);
    account.challenges = account.challenges.filter(c => c.purpose !== 'credential'); this.audit(account, 'passkey-removed');
    await this.save(account, revision); return { removed: true, currentSessionRevoked: !account.sessions.includes(session), credentials: publicCredentials(account) };
  }
  async renameSession(input, context) {
    const {account}=await this.authorized(context,true);const revision=account.revision;
    if(typeof input.label!=='string'||!input.label.trim()||input.label.length>80||/[\u0000-\u001f\u007f]/.test(input.label))fail('invalid_device_label','Choose a device name of up to 80 characters.');
    const target=(await Promise.all(account.sessions.map(async s=>({session:s,id:await this.sessionID(s)})))).find(s=>s.id===input.sessionId&&s.session.expiresAt>this.clock())?.session;
    if(!target)fail('not_found','Device session not found.');target.label=input.label.trim();this.audit(account,'device-session-renamed');await this.save(account,revision);return {renamed:true,sessionId:input.sessionId,label:target.label};
  }
  async revokeSession(input, context) {
    const { account, session } = await this.recent(context); const revision = account.revision;
    const target = (await Promise.all(account.sessions.map(async s => ({ session: s, id: await this.sessionID(s) })))).find(s => s.id === input.sessionId)?.session;
    if (!target) fail('not_found', 'Device session not found.');
    account.sessions = account.sessions.filter(s => s !== target); this.audit(account, 'device-session-revoked');
    await this.save(account, revision); return { revoked: true, currentSessionRevoked: target === session };
  }
  async revokeOtherSessions(input, context) {
    const { account, session } = await this.recent(context); const revision = account.revision;
    const count = account.sessions.length - 1; account.sessions = [session]; this.audit(account, 'other-device-sessions-revoked');
    await this.save(account, revision); return { revoked: count };
  }
  deviceFlow() { return this.deviceLogin ||= new DeviceLogin(this, IdentityFault); }
  async createDeviceLogin(input, context) { return this.deviceFlow().create(input, context); }
  async deviceRequest(input, context) { return this.deviceFlow().inspect(input, context); }
  async approveDeviceLogin(input, context) { return this.deviceFlow().approve(input, context); }
  async denyDeviceLogin(input, context) { return this.deviceFlow().deny(input, context); }
  async pollDeviceLogin(input, context) { return this.deviceFlow().poll(input, context); }
  async cancelDeviceLogin(input, context) { return this.deviceFlow().cancel(input, context); }
  async emailStart(input, context) {
    if (!this.mailer) fail('email_unavailable', 'Email delivery is not configured.');
    const { account, session } = await this.authorized(context, true); const revision = account.revision;
    if (session.createdAt + 900000 <= this.clock()) fail('reauthentication_required', 'Sign in again before changing recovery email.');
    const email = emailAddress(input.email);
    if (!await this.rateLimiter.check({ operation: 'email', remoteIP: context.remoteIP, handle: account.handle })) fail('rate_limited');
    const token = `${account.id}.${this.crypto.random()}`;
    account.emailChallenges = [{ purpose: 'link', email, hash: await this.crypto.hash('email', token), sessionHash: session.hash, expiresAt: this.clock() + 600000 }];
    this.audit(account, 'email-link-requested'); await this.save(account, revision);
    // Tokens only leave through the mail transport, never through API results.
    await this.mailer.sendVerification({ email, token, purpose: 'link', issuer: this.config.origin });
    return { sent: true };
  }
  async emailConfirm(input, context) {
    const { account, session } = await this.authorized(context, true); const revision = account.revision;
    if (input.confirmed !== true || typeof input.token !== 'string') fail('confirmation_required');
    const hash = await this.crypto.hash('email', input.token);
    const challenge = account.emailChallenges?.find(c => c.purpose === 'link' && secureEqual(c.hash, hash) && secureEqual(c.sessionHash, session.hash) && c.expiresAt > this.clock());
    if (!challenge) fail('invalid_challenge', 'This email confirmation is expired or belongs to another browser session.');
    if (account.verifiedEmail !== challenge.email) account.emailLoginEnabled = false;
    account.verifiedEmail = challenge.email; account.emailVerifiedAt = this.clock(); account.emailChallenges = [];
    this.audit(account, 'email-linked'); await this.save(account, revision); return { linked: true, account: publicAccount(account) };
  }
  async emailLoginStart(input, context) {
    if (!this.mailer || typeof this.repository.findByEmail !== 'function') fail('email_unavailable', 'Email delivery is not configured.');
    await this.guard('email', input, context); const email = emailAddress(input.email);
    const account = await this.repository.findByEmail(email);
    if (account?.status === 'active' && account.emailLoginEnabled === true) {
      const revision = account.revision; const token = `${account.id}.${this.crypto.random()}`;
      account.emailChallenges = [...(account.emailChallenges || []).filter(c => c.expiresAt > this.clock()).slice(-3), {
        purpose: 'login', email, emailRevision: account.emailVerifiedAt,
        hash: await this.crypto.hash('email', token), expiresAt: this.clock() + 600000 }];
      await this.save(account, revision);
      await this.mailer.sendVerification({ email, token, purpose: 'login', issuer: this.config.origin });
    }
    return { sent: true };
  }
  async emailLoginConfirm(input, context) {
    this.origin(context); const [id] = tokenParts(input.token); const account = await this.repository.get(id);
    if (input.confirmed !== true) fail('confirmation_required');
    const hash = await this.crypto.hash('email', input.token);
    const challenge = account?.emailChallenges?.find(c => c.purpose === 'login' && secureEqual(c.hash, hash) && c.expiresAt > this.clock());
    if (!account || account.status !== 'active' || account.emailLoginEnabled !== true || !challenge || challenge.email !== account.verifiedEmail || challenge.emailRevision !== account.emailVerifiedAt) fail('unauthorized', 'Email login failed.');
    const revision = account.revision; account.emailChallenges = account.emailChallenges.filter(c => c !== challenge);
    const result = await this.session(account); await this.save(account, revision); return result;
  }
  async configureEmailLogin(input, context) {
    const { account } = await this.recent(context); const revision = account.revision;
    if (typeof input.enabled !== 'boolean') fail('invalid_request', 'Choose whether email can sign in to this account.');
    if (input.enabled && !account.verifiedEmail) fail('verified_email_required', 'Verify a contact email before enabling email sign-in.');
    account.emailLoginEnabled = input.enabled;
    account.emailChallenges = (account.emailChallenges || []).filter(challenge => challenge.purpose !== 'login');
    this.audit(account, input.enabled ? 'email-login-enabled' : 'email-login-disabled');
    await this.save(account, revision); return { emailLoginEnabled: account.emailLoginEnabled, account: publicAccount(account) };
  }
  async logout(input, context) {
    const { account, session } = await this.authorized(context, true); const revision = account.revision;
    account.sessions = account.sessions.filter(s => s !== session); this.audit(account, 'session-closed');
    await this.save(account, revision); return { loggedOut: true };
  }
}
