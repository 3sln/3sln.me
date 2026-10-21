import {validateHostAlias,configuredReservedName,projectAccountBadges,defaultBadgeResolver,configuredBadgeIDs} from './badge-policy.mjs';
import {onboardingAlias,sameOnboardingIdentity} from './onboarding.mjs';
import {systemMarker,systemBadge,sameSystemIdentity} from './system-bootstrap.mjs';
import {normalizeHandle,validatePaidHandle,isReservedHandle} from './handles.mjs';
import { IdentityCrypto, secureEqual } from './crypto.mjs';
import { DeviceLogin } from './device-login.mjs';
import { LinkedApproval, MemoryLinkedLimits, pruneLineage, revokeLineage, revokeAllLineage } from './linked-approval.mjs';

export class IdentityFault extends Error {
  constructor(code, message = 'The account request could not be completed.') { super(message); this.code = code; }
}
const fail = (code, message) => { throw new IdentityFault(code, message); };
const publicAccount = (a,badges=[]) => ({ id: a.id, handle: a.handle, status: a.status, createdAt: a.createdAt,
  badges,termsVersion: a.termsVersion, hasPassword: Boolean(a.passwordHash), passkeyCount: a.credentials.length,
  recoveryConfigured: Boolean(a.recoveryHash), paidHandle:a.paidHandle||null, aliases:[a.handle,...onboardingAlias(a)?[onboardingAlias(a)]:[],...a.paidHandle?[a.paidHandle]:[],...systemBadge(a)?[a.systemIdentity.handle]:[]],...systemBadge(a)?{systemBadge:systemBadge(a)}:{}, verifiedEmail: a.verifiedEmail || null, emailLoginEnabled: a.emailLoginEnabled === true, lastActiveAt: a.lastActiveAt });
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
  constructor({ repository, deviceRequests, linkedApprovals = deviceRequests, linkedLimits, linkedPollLimits, approvalNotices, crypto, clock = () => Date.now(), turnstile, rateLimiter, webauthn, passwordHasher, mailer, identityBackup, paidHandleEligibility, setupBilling, systemBootstrap, onboarding, resolveIdentityBadges, pushTransport, reservedHandle, config }) {
    if (!repository || !turnstile || !rateLimiter || !webauthn || !passwordHasher || !config?.termsVersion) throw new TypeError('Identity resources and terms version are required');
    const origin = new URL(config.origin);
    if (origin.origin !== config.origin || origin.hostname !== config.rpID || (origin.protocol !== 'https:' && !(config.allowInsecureLocalhost && origin.protocol === 'http:' && origin.hostname === 'localhost'))) throw new TypeError('Exact RP origin is required');
    this.repository = repository; this.crypto = new IdentityCrypto(crypto); this.clock = clock;
    this.turnstile = turnstile; this.rateLimiter = rateLimiter; this.webauthn = webauthn; this.passwordHasher = passwordHasher;
    this.pushTransport=pushTransport;this.mailer = mailer; this.identityBackup = identityBackup; this.paidHandleEligibility=paidHandleEligibility;
    // `linkedApprovals` is the renamed `deviceRequests` repository (create/get/findByUserCode/compareAndSwap).
    // `linkedLimits` is the durable window port for budgets; `linkedPollLimits` the non-durable poll limiter.
    this.deviceRequests = this.linkedApprovals = linkedApprovals; this.linkedLimits = linkedLimits ?? new MemoryLinkedLimits(clock); this.linkedPollLimits = linkedPollLimits ?? new MemoryLinkedLimits(clock); this.approvalNotices = approvalNotices;
    this.setupBilling = setupBilling;this.systemBootstrap=systemBootstrap;this.onboarding=onboarding;this.resolveIdentityBadges=resolveIdentityBadges??defaultBadgeResolver;this.reservedHandle=reservedHandle;
    this.config = { rpName: '3sln.me', sessionTtlMs: 86400000, pendingTtlMs: 1800000, challengeTtlMs: 300000, ...config };
    if (!(this.config.sessionTtlMs > 0 && this.config.sessionTtlMs <= 86400000)) throw new TypeError('Sessions must expire within 24 hours');
  }
  origin(context) { if (context?.origin !== this.config.origin) fail('csrf', 'Use the account website to complete this request.'); }
  async projectAccount(account){
    const aliases=[account.handle,...onboardingAlias(account)?[onboardingAlias(account)]:[],...account.paidHandle?[account.paidHandle]:[],...systemBadge(account)?[account.systemIdentity.handle]:[]],identity=Object.freeze({id:account.id,handle:account.handle,status:account.status,aliases:Object.freeze(aliases),badgeIds:Object.freeze(Array.isArray(account.badgeIds)?[...account.badgeIds]:[])});let ids,timer;
    try{ids=await Promise.race([Promise.resolve().then(()=>this.resolveIdentityBadges(identity)),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Badge resolution timed out')),500);})]);}catch{ids=[];}finally{clearTimeout(timer);}
    return publicAccount(account,projectAccountBadges(account,this.config,ids));
  }
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
    if((this.config.requireReachability===true||account.systemIdentity||account.onboardingIdentity)&&context){if(!context.setupBinding)fail('unauthorized');account.setupBindingHash=await this.crypto.hash('setup-binding',context.setupBinding);}
    delete account.setupEmailChallenge;delete account.setupPushChallenge;delete account.setupPushVerified;delete account.pendingCredentialAt;
    const value = `${account.id}.${this.crypto.random()}`;
    account.pendingHash = await this.crypto.hash('pending', value); account.pendingExpiresAt = this.clock() + this.config.pendingTtlMs;
    return value;
  }
  async session(account, { label, credentialId, source = 'credential', activationCredentialAt, parentSessionId, expiresAt: cap = Infinity } = {}) {
    const sessionToken = `${account.id}.${this.crypto.random()}`; const csrfToken = this.crypto.random();
    const expiresAt = Math.min(this.clock() + this.config.sessionTtlMs, cap);
    await this.pruneSessions(account, s => s.expiresAt <= this.clock(), { natural: true });
    // Eviction never ends the new session's own ancestry, prefers sessions with no derived sessions or apps, and
    // cascades like any explicit termination (architecture §7.4).
    const protectedIds=new Set();for(let id=parentSessionId;id&&!protectedIds.has(id);id=account.sessions.find(s=>s.id===id)?.parentSessionId)protectedIds.add(id);
    const busy=s=>account.sessions.some(child=>child.parentSessionId===s.id)||(account.linkedLineage??[]).some(entry=>entry.sessions.includes(s.id));
    while(account.sessions.length>=10){const target=account.sessions.find(s=>!protectedIds.has(s.id)&&!busy(s))??account.sessions.find(s=>!protectedIds.has(s.id));if(!target)fail('conflict');await this.pruneSessions(account,s=>s===target);}
    account.sessions = [...account.sessions, {
      id: this.crypto.id(), label: safeLabel(label), credentialId, source, parentSessionId, ...source==='activation'&&Number.isSafeInteger(activationCredentialAt)?{activationCredentialAt}:{},
      hash: await this.crypto.hash('session', sessionToken), csrfToken, expiresAt, createdAt: this.clock(), lastUsedAt: this.clock() }];
    account.lastActiveAt = this.clock(); this.audit(account, 'session-created');
    return { account: await this.projectAccount(account), sessionToken, csrfToken, expiresAt, sessionContext:account.sessions.at(-1).id };
  }
  async authorized(context, mutation = false) {
    if (mutation) this.origin(context);
    const [id] = tokenParts(context?.sessionToken); const account = await this.repository.get(id);
    const hash = await this.crypto.hash('session', context.sessionToken);
    const session = account?.sessions.find(s => secureEqual(s.hash, hash) && s.expiresAt > this.clock());
    if (!account || account.status !== 'active' || !session) fail('unauthorized', 'Sign in to continue.');
    if(context.expectedOwner&&context.expectedOwner!==account.id)throw Object.assign(new Error('Reload the account chooser before continuing.'),{code:'account_context_conflict',status:409});
    if(context.sessionContext&&context.sessionContext!==await this.sessionID(session))throw Object.assign(new Error('Reload the account chooser before continuing.'),{code:'session_context_conflict',status:409});
    if (mutation && !secureEqual(session.csrfToken, context.csrfToken)) fail('csrf', 'Reload the account page and try again.');
    return { account, session };
  }
  authAt(session){return Math.max(session.source==='activation'&&Number.isSafeInteger(session.activationCredentialAt)&&session.activationCredentialAt<=this.clock()?session.activationCredentialAt:-Infinity,session.source==='credential'&&Number.isSafeInteger(session.createdAt)&&session.createdAt<=this.clock()?session.createdAt:-Infinity,Number.isSafeInteger(session.stepUpAt)&&session.stepUpAt<=this.clock()?session.stepUpAt:-Infinity);}
  /** Removes sessions and their transitive descendants. Removing a still-live session is an explicit termination
   * in every mode: approval lineage through it ends and its app families enter the revocation outbox in this same
   * account CAS. Already-expired sessions end naturally and keep their lineage until E (deterministic whether or
   * not expiry pruning ran first). `natural` only documents the expiry-pruning caller. */
  async pruneSessions(account,remove,{natural=false}={}){
    const now=this.clock(),removed=new Set(),explicit=new Set();for(const session of account.sessions)if(remove(session)){const id=await this.sessionID(session);removed.add(id);if(session.expiresAt>now)explicit.add(id);}
    let changed=true;while(changed){changed=false;for(const session of account.sessions)if(session.parentSessionId&&removed.has(session.parentSessionId)){const id=await this.sessionID(session);if(!removed.has(id)){removed.add(id);if(session.expiresAt>now)explicit.add(id);changed=true;}}}
    account.sessions=(await Promise.all(account.sessions.map(async session=>({session,id:await this.sessionID(session)})))).filter(item=>!removed.has(item.id)).map(item=>item.session);
    pruneLineage(account,now);if(explicit.size)revokeLineage(account,explicit,now);
  }
  async recent(context) {
    const result = await this.authorized(context, true);
    if (this.authAt(result.session) + 900000 <= this.clock()) fail('reauthentication_required', 'Confirm your password or passkey before changing account access.');
    return result;
  }
  async sessionID(session) { return session.id || this.crypto.hash('session-public-id', session.hash); }
  // Privileged consoles need a per-session step-up, not merely a young session.
  async privileged(context,windowMs=300000){const {account,session}=await this.authorized(context,true);if(!Number.isSafeInteger(session.stepUpAt)||session.stepUpAt>this.clock()||session.stepUpAt+windowMs<=this.clock())fail('step_up_required','Confirm your password or passkey to continue.');return {account,session,sessionId:await this.sessionID(session)};}
  async stepUpBegin(input,context){const {account,session}=await this.authorized(context,true),revision=account.revision;if(!account.credentials.length)return {password:Boolean(account.passwordHash),passkey:false};const authenticationOptions=await this.webauthn.authenticationOptions({config:this.config});account.challenges=[...account.challenges.filter(c=>c.expiresAt>this.clock()&&c.purpose!=='step-up').slice(-4),{purpose:'step-up',value:authenticationOptions.challenge,sessionHash:session.hash,expiresAt:this.clock()+this.config.challengeTtlMs}];await this.save(account,revision);return {password:Boolean(account.passwordHash),passkey:true,authenticationOptions};}
  async stepUp(input,context){
    const {account,session}=await this.authorized(context,true),revision=account.revision;if(!await this.rateLimiter.check({operation:'step-up',remoteIP:context.remoteIP,handle:account.handle}))fail('rate_limited','Please wait before trying again.');
    if(input.method==='password'){password(input.password);if(!account.passwordHash||!await this.passwordHasher.verify(input.password,account.passwordHash))fail('unauthorized','Authentication failed.');}
    else if(input.method==='passkey'){const challenge=account.challenges.find(c=>c.purpose==='step-up'&&secureEqual(c.sessionHash,session.hash)&&c.expiresAt>this.clock()),credential=account.credentials.find(c=>c.id===input.response?.id);if(!challenge||!credential)fail('unauthorized','Authentication failed.');let verified;try{verified=await this.webauthn.verifyAuthentication({response:input.response,challenge:challenge.value,credential,account,config:this.config});}catch{fail('unauthorized','Authentication failed.');}credential.counter=verified.counter;credential.backedUp=verified.backedUp;account.challenges=account.challenges.filter(c=>c!==challenge);}
    else fail('invalid_method');
    session.stepUpAt=this.clock();this.audit(account,'step-up');await this.save(account,revision);return {stepUpUntil:session.stepUpAt+300000};
  }
  async signup(input, context) {
    await this.guard('signup', input, context);
    // Portable repositories without an allocator keep the canonical handle, so
    // case/confusable variants cannot register twice or strand a login.
    const requestedHandle=this.repository.allocateFreeHandle?input.handle:handle(input.handle);
    if (input.termsAccepted !== true || input.termsVersion !== this.config.termsVersion) fail('terms_required', 'Agree to the current account terms.');
    if (!['passkey', 'password'].includes(input.method)) fail('invalid_method');
    const selectedPassword = input.method === 'password' ? password(input.password) : null;
    const signupPlan=input.signupPlan??'free';if(!['free','paid','plus','ultra'].includes(signupPlan))fail('invalid_plan','Choose a supported signup plan.');
    if(signupPlan!=='free'&&(this.config.paidSignupEnabled!==true||!this.setupBilling))throw Object.assign(new IdentityFault('paid_signup_unavailable','Paid signup is not available.'),{status:503});
    if (!this.repository.allocateFreeHandle&&await this.repository.findByHandle(requestedHandle)) fail('handle_unavailable', 'Choose another account handle.');
    // Global/daily creation capacity is reserved only for a valid proof and
    // complete valid signup, never for anonymous CAPTCHA or malformed attempts.
    const id=this.crypto.id(),assignmentId=this.crypto.id();
    // The new account ID is the admission receipt: a retried capacity claim for
    // this signup spends at most one unit.
    if (!await this.rateLimiter.check({ phase: 'admitted', operation: 'signup', signupKind:signupPlan==='free'?'free':'paid',remoteIP: context.remoteIP, region:context.region, handle: input.handle, admissionId:id })) fail('rate_limited', 'Account creation is limited for this network or region. Please try again in a few hours.');
    const allocatedHandle=this.repository.allocateFreeHandle?await this.repository.allocateFreeHandle(input.handle,id,assignmentId):requestedHandle;
    const account = { id, assignmentId, nameAssignmentId:assignmentId, revision: 0, handle: allocatedHandle, status: 'pending',
      admission:{version:1,kind:signupPlan==='free'?'free':'paid',plan:signupPlan,...signupPlan==='free'?{}:{incarnation:this.crypto.id(),checkoutStartUntil:this.clock()+86400000,initialPaymentRequired:true}},
      createdAt: this.clock(), lastActiveAt: this.clock(), termsVersion: this.config.termsVersion,
      termsAcceptedAt: this.clock(), credentials: [], sessions: [], challenges: [], audit: [], recoveryHash: null, emailLoginEnabled: false,
      passwordHash: selectedPassword ? await this.passwordHasher.hash(selectedPassword) : null };
    if(this.config.requireReachability===true){if(!context.setupBinding)fail('unauthorized','Start setup in the account browser.');account.setupBindingHash=await this.crypto.hash('setup-binding',context.setupBinding);}
    const pendingToken = await this.newPending(account,context);if(selectedPassword)await this.verifyPendingPassword(account,selectedPassword);
    let registrationOptions;
    if (input.method === 'passkey') {
      registrationOptions = await this.webauthn.registrationOptions({ account, config: this.config });
      account.challenges.push({ purpose: 'register', value: registrationOptions.challenge, expiresAt: this.clock() + this.config.challengeTtlMs });
    }
    this.audit(account, 'signup-pending');
    if (!await this.repository.create(account)) fail('handle_unavailable', 'Choose another account handle.');
    return { pendingToken, account: await this.projectAccount(account), registrationOptions, readyForRecovery: input.method === 'password',signupPlan,paymentRequired:signupPlan!=='free' };
  }
  async inspectOnboarding(input,context){this.origin(context);if(Object.keys(input).length!==1||typeof input.onboardingToken!=='string')fail('invalid_onboarding_invitation');if(!this.onboarding)fail('onboarding_unavailable');return this.onboarding.inspect(input.onboardingToken);}
  async issueOnboarding(input,context){this.origin(context);if(Object.keys(input).length!==2||typeof input.onboardingToken!=='string'||typeof input.issuanceProof!=='string')fail('invalid_onboarding_issuance');if(!this.onboarding)fail('onboarding_unavailable');return this.onboarding.issue(input.onboardingToken,input.issuanceProof);}
  async claimOnboarding(input,context){
    await this.guard('onboarding',input,context);if(!this.onboarding)fail('onboarding_unavailable','Account onboarding is not configured.');if(!context.setupBinding)fail('setup_binding_required','Prepare account onboarding in this browser before continuing.');
    if(Object.keys(input).some(name=>!['onboardingToken','name','method','password','termsAccepted','termsVersion','turnstileToken'].includes(name)))fail('invalid_onboarding_request');
    if(input.termsAccepted!==true||input.termsVersion!==this.config.termsVersion)fail('terms_required','Agree to the current account terms.');if(!['passkey','password'].includes(input.method))fail('invalid_method');const selectedPassword=input.method==='password'?password(input.password):null;
    const binding=await this.crypto.hash('onboarding-setup-browser',context.setupBinding),prepared=await this.onboarding.prepare(input.onboardingToken,input.name,binding),{claims,digest,item,marker}=prepared,previous=await this.repository.get(item.owner);
    if(previous){if(previous.assignmentId!==item.assignmentId||!sameOnboardingIdentity(previous.onboardingIdentity,marker))fail('onboarding_conflict','Onboarding setup needs operator reconciliation.');await this.onboarding.finish(item,digest,binding);fail('onboarding_invitation_consumed','Setup already started for this name. Sign in with its credential, or ask the host operator for help.');}
    let canonical=prepared.reservation.canonical;if(!canonical){const allocated=await this.repository.allocateFreeHandle(undefined,item.owner,item.assignmentId),reservation=await this.onboarding.canonical(item,digest,binding,allocated);if(!reservation?.canonical)fail('onboarding_conflict','Onboarding setup needs operator reconciliation.');canonical=reservation.canonical;}
    const account={id:item.owner,assignmentId:item.assignmentId,nameAssignmentId:item.assignmentId,revision:0,handle:canonical,status:'pending',onboardingIdentity:marker,badgeIds:[...item.badgeIds],admission:{version:1,kind:'operator',plan:'free'},createdAt:this.clock(),lastActiveAt:this.clock(),termsVersion:this.config.termsVersion,termsAcceptedAt:this.clock(),credentials:[],sessions:[],challenges:[],audit:[],recoveryHash:null,emailLoginEnabled:false,passwordHash:selectedPassword?await this.passwordHasher.hash(selectedPassword):null};
    const pendingToken=await this.newPending(account,context);if(selectedPassword)await this.verifyPendingPassword(account,selectedPassword);let registrationOptions;if(input.method==='passkey'){registrationOptions=await this.webauthn.registrationOptions({account,config:this.config});account.challenges.push({purpose:'register',value:registrationOptions.challenge,expiresAt:this.clock()+this.config.challengeTtlMs});}
    if(claims.expiresAt<=this.clock())fail('invalid_onboarding_invitation','This onboarding invitation expired before account creation.');this.audit(account,'operator-onboarding-pending');if(!await this.repository.create(account))fail('onboarding_conflict','Setup already started for this name. Sign in with its credential or ask the operator to reconcile it.');if(!await this.onboarding.finish(item,digest,binding))fail('onboarding_conflict','Onboarding setup needs operator reconciliation.');return {pendingToken,account:await this.projectAccount(account),registrationOptions,readyForRecovery:input.method==='password',signupPlan:'free',paymentRequired:false};
  }
  async bootstrapSystem(input,context){
    await this.guard('system-bootstrap',input,context);
    if(!this.systemBootstrap||!this.repository.reserveSystemIdentity)fail('system_bootstrap_unavailable','System setup is not configured.');
    if(!context.setupBinding)fail('setup_binding_required','Prepare system setup in this browser before continuing.');
    if(input.termsAccepted!==true||input.termsVersion!==this.config.termsVersion)fail('terms_required','Agree to the current account terms.');
    if(!['passkey','password'].includes(input.method))fail('invalid_method');const selectedPassword=input.method==='password'?password(input.password):null;
    const binding=await this.crypto.hash('system-setup-browser',context.setupBinding),prepared=await this.systemBootstrap.prepare(input.bootstrapToken,binding),{claims,digest}=prepared,marker=systemMarker(claims,digest);
    const previous=await this.repository.get(claims.owner);
    if(previous){if(previous.assignmentId!==claims.assignmentId||!sameSystemIdentity(previous.systemIdentity,marker))fail('system_bootstrap_conflict','System setup needs operator reconciliation.');await this.systemBootstrap.finish(claims,digest,binding);fail('system_invitation_consumed','This invitation was already used. Sign in with the configured credential, or ask the operator to repair incomplete setup.');}
    let canonical=prepared.reservation.canonical;if(!canonical){const allocated=await this.repository.allocateFreeHandle(undefined,claims.owner,claims.assignmentId),reservation=await this.systemBootstrap.canonical(claims,digest,binding,allocated);if(!reservation?.canonical)fail('system_bootstrap_conflict','System setup needs operator reconciliation.');canonical=reservation.canonical;}
    const account={id:claims.owner,assignmentId:claims.assignmentId,nameAssignmentId:claims.assignmentId,revision:0,handle:canonical,status:'pending',systemIdentity:marker,badgeIds:configuredBadgeIDs(this.config).includes('system')?['system']:[],admission:{version:1,kind:'system',plan:'free',initialSystemActivationRequired:true},createdAt:this.clock(),lastActiveAt:this.clock(),termsVersion:this.config.termsVersion,termsAcceptedAt:this.clock(),credentials:[],sessions:[],challenges:[],audit:[],recoveryHash:null,emailLoginEnabled:false,passwordHash:selectedPassword?await this.passwordHasher.hash(selectedPassword):null};
    const pendingToken=await this.newPending(account,context);if(selectedPassword)await this.verifyPendingPassword(account,selectedPassword);let registrationOptions;if(input.method==='passkey'){registrationOptions=await this.webauthn.registrationOptions({account,config:this.config});account.challenges.push({purpose:'register',value:registrationOptions.challenge,expiresAt:this.clock()+this.config.challengeTtlMs});}
    if(claims.expiresAt<=this.clock())fail('invalid_system_invitation','This system invitation expired before account creation.');
    this.audit(account,'system-bootstrap-pending');if(!await this.repository.create(account))fail('system_bootstrap_conflict','System setup was already started. Sign in with the configured credential or ask the operator to reconcile it.');
    if(!await this.systemBootstrap.finish(claims,digest,binding))fail('system_bootstrap_conflict','System setup needs operator reconciliation.');
    return {pendingToken,account:await this.projectAccount(account),registrationOptions,readyForRecovery:input.method==='password',signupPlan:'free',paymentRequired:false};
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
    account.pendingCredentialAt=this.clock();account.credentials.push({ ...credential, label: safeLabel(input.label, 'Passkey'), createdAt: this.clock() }); account.challenges = []; this.audit(account, 'passkey-registered');
    await this.save(account, revision); return { readyForRecovery: true };
  }
  async verifyPendingPassword(account,value){if(!await this.passwordHasher.verify(value,account.passwordHash))fail('unauthorized','Password verification failed.');account.pendingCredentialAt=this.clock();}
  async setPendingPassword(input, context) {
    this.origin(context); const account = await this.pending(input.pendingToken,context); const revision = account.revision;
    account.passwordHash = await this.passwordHasher.hash(password(input.password));await this.verifyPendingPassword(account,input.password);
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
    let selected;try{selected=validateHostAlias(input.handle);}catch{fail('invalid_handle','Choose a custom handle of 3–32 letters, digits, underscores or hyphens.');}
    if(configuredReservedName(this.config,selected)||this.reservedHandle&&await this.reservedHandle(selected)!==false)fail('reserved_handle','This handle is reserved for operator-issued account onboarding.');
    if(!await this.rateLimiter.check({operation:'handle-claim',remoteIP:context.remoteIP}))fail('rate_limited','Please wait before trying again.');
    if(account.paidHandle&&account.paidHandle!==selected)fail('handle_already_claimed','This identity already has a permanent custom handle.');
    if(!this.paidHandleEligibility||!await this.paidHandleEligibility(account.id))fail('paid_history_required','A verified paid subscription is required to claim a custom handle.');
    if(!this.repository.claimPaidHandle||!account.assignmentId)fail('handle_claim_unavailable','Custom handles are unavailable for this identity.');
    if(!await this.repository.claimPaidHandle(selected,account.id,account.assignmentId))fail('handle_unavailable','This handle is permanently assigned or you already claimed another handle.');
    if(!account.paidHandle){const revision=account.revision;account.paidHandle=selected;this.audit(account,'paid-handle-claimed');await this.save(account,revision);}
    return {account:await this.projectAccount(account)};
  }
  async handleCertificate(input,context){
    const {account}=await this.authorized(context,true);
    if(!this.identityBackup?.certificate)fail('recovery_unavailable','Certificate signing is unavailable.');
    const selected=input.handle===undefined?account.handle:handle(input.handle);
    if(selected!==account.handle&&selected!==onboardingAlias(account)&&selected!==account.paidHandle&&selected!==await this.repository.paidHandleForOwner?.(account.id))fail('forbidden','This handle does not belong to your identity.');
    const certificate=await this.identityBackup.certificate(account,selected,this.clock());
    return {fileName:`handle-claim-${selected}.json`,content:JSON.stringify(certificate,null,2)};
  }
  setupProjection(account){const push=typeof this.pushTransport?.send==='function'&&typeof this.pushTransport?.register==='function'&&account.setupPushVerified?.expiresAt>this.clock();return {accountId:account.id,signupPlan:account.admission?.plan??'free',paymentRequired:account.admission?.kind==='paid'&&account.admission.initialPaymentRequired!==false,channelRequired:this.config.requireReachability===true||Boolean(account.systemIdentity),channelVerified:Boolean(account.verifiedEmail&&Number.isFinite(account.emailVerifiedAt)||push),verifiedEmail:account.verifiedEmail??null,pushVerified:Boolean(push),emailAvailable:typeof this.mailer?.sendSetupCode==='function',pushAvailable:typeof this.pushTransport?.send==='function'&&typeof this.pushTransport?.register==='function'};}
  async setupSendAdmission(account,kind,context,target){const now=this.clock(),windowKey='setup'+kind+'WindowAt',countKey='setup'+kind+'Sends',sentKey='setup'+kind+'SentAt';const window=account[windowKey];if(window!==undefined&&(!Number.isSafeInteger(window)||window>now))fail('rate_limited');if(window===undefined||now-window>=600000){account[windowKey]=now;account[countKey]=0;}if(!Number.isInteger(account[countKey])||account[countKey]<0||account[countKey]>=3||account[sentKey]&&now-account[sentKey]<60000||!await this.rateLimiter.check({operation:'email',remoteIP:context.remoteIP,handle:target}))fail('rate_limited','Wait before requesting another verification check.');account[countKey]++;account[sentKey]=now;}
  async setupStatus(input,context){this.origin(context);return this.setupProjection(await this.pending(input.pendingToken,context));}
  async setupBillingCheckout(input,context){this.origin(context);const account=await this.pending(input.pendingToken,context);if(!['pending','recovering'].includes(account.status)||account.admission?.kind!=='paid'||account.admission.initialPaymentRequired===false||!this.setupBilling)fail('invalid_paid_setup');await this.requireSetupChannel(account);if(!await this.rateLimiter.check({operation:'paid-setup',remoteIP:context.remoteIP,handle:account.id}))fail('rate_limited');const result=await this.setupBilling.checkout(account.id,account.admission,{requestId:input.requestId,currency:input.currency,priceDigest:input.priceDigest});await this.pending(input.pendingToken,context);return result;}
  async setupBillingStatus(input,context){this.origin(context);const account=await this.pending(input.pendingToken,context);if(!['pending','recovering'].includes(account.status)||account.admission?.kind!=='paid'||account.admission.initialPaymentRequired===false||!this.setupBilling)fail('invalid_paid_setup');if(!await this.rateLimiter.check({operation:'paid-setup',remoteIP:context.remoteIP,handle:account.id}))fail('rate_limited');const result=await this.setupBilling.status(account.id,account.admission);await this.pending(input.pendingToken,context);return result;}
  async setupEmailStart(input,context){this.origin(context);if(input.locale!==undefined&&!['en','es'].includes(input.locale))fail('invalid_locale','Choose English or Spanish.');const account=await this.pending(input.pendingToken,context),revision=account.revision;if(typeof this.mailer?.sendSetupCode!=='function')fail('email_unavailable','Email delivery is not configured.');const email=emailAddress(input.email),now=this.clock();if(account.systemIdentity?.requiredEmail&&account.admission?.initialSystemActivationRequired!==false&&email!==emailAddress(account.systemIdentity.requiredEmail))fail('contact_required','Use the contact address assigned by the system invitation.');await this.setupSendAdmission(account,'Email',context,email);let number;do{number=globalThis.crypto.getRandomValues(new Uint32Array(1))[0];}while(number>=4200000000);const code=String(number%100000000).padStart(8,'0');account.setupEmailChallenge={email,hash:await this.crypto.hash('setup-email',account.id+'|'+account.pendingHash+'|'+email+'|'+code),pendingHash:account.pendingHash,expiresAt:now+600000,attempts:0};await this.save(account,revision);await this.mailer.sendSetupCode({email,code,issuer:this.config.origin,locale:input.locale??'en'});return {sent:true,...this.setupProjection(account)};}
  async setupEmailConfirm(input,context){this.origin(context);const account=await this.pending(input.pendingToken,context),revision=account.revision,challenge=account.setupEmailChallenge;if(!challenge||challenge.pendingHash!==account.pendingHash||challenge.expiresAt<=this.clock()||challenge.attempts>=5||typeof input.code!=='string'||!/^\d{8}$/.test(input.code))fail('invalid_challenge','Request a fresh email code.');challenge.attempts++;if(!secureEqual(challenge.hash,await this.crypto.hash('setup-email',account.id+'|'+account.pendingHash+'|'+challenge.email+'|'+input.code))){await this.save(account,revision);fail('invalid_challenge','That email code is incorrect.');}const existing=await this.repository.findByEmail(challenge.email);if(existing&&existing.id!==account.id)fail('email_already_linked','This verified email belongs to another account. Sign in to that account.');account.verifiedEmail=challenge.email;account.emailVerifiedAt=this.clock();account.emailLoginEnabled=false;delete account.setupEmailChallenge;this.audit(account,'setup-email-verified');await this.save(account,revision);return this.setupProjection(account);}
  async setupPushStart(input,context){this.origin(context);if(input.locale!==undefined&&!['en','es'].includes(input.locale))fail('invalid_locale','Choose English or Spanish.');const account=await this.pending(input.pendingToken,context),revision=account.revision;if(typeof this.pushTransport?.send!=='function')fail('push_unavailable','Push delivery is not configured.');const subscription=input.subscription;if(!subscription||typeof subscription.endpoint!=='string'||subscription.endpoint.length>4096||!subscription.keys||typeof subscription.keys.p256dh!=='string'||typeof subscription.keys.auth!=='string'||JSON.stringify(subscription).length>8192)fail('invalid_subscription','Use a browser-created push subscription.');await this.setupSendAdmission(account,'Push',context,account.handle);const proof=account.id+'.'+this.crypto.random();account.setupPushChallenge={subscription:structuredClone(subscription),hash:await this.crypto.hash('setup-push',proof),pendingHash:account.pendingHash,expiresAt:this.clock()+300000};delete account.setupPushVerified;await this.save(account,revision);await this.pushTransport.send(subscription,{type:'bindle-setup-challenge',proof,owner:account.id,locale:input.locale??'en'});return {sent:true,...this.setupProjection(account)};}
  async setupPushConfirm(input,context){this.origin(context);const account=await this.pending(input.pendingToken,context),revision=account.revision,challenge=account.setupPushChallenge;if(typeof this.pushTransport?.send!=='function'||!challenge||challenge.pendingHash!==account.pendingHash||challenge.expiresAt<=this.clock()||typeof input.proof!=='string'||!secureEqual(challenge.hash,await this.crypto.hash('setup-push',input.proof)))fail('invalid_challenge','Enable notifications and request a fresh push check.');account.setupPushVerified={subscription:challenge.subscription,verifiedAt:this.clock(),expiresAt:account.pendingExpiresAt};delete account.setupPushChallenge;this.audit(account,'setup-push-verified');await this.save(account,revision);return this.setupProjection(account);}
  async requireSetupChannel(account){if(this.config.requireReachability!==true&&!account.systemIdentity)return;if(account.systemIdentity?.requiredEmail&&account.admission?.initialSystemActivationRequired!==false&&account.verifiedEmail!==emailAddress(account.systemIdentity.requiredEmail))fail('contact_required','Verify the contact address assigned by the system invitation.');if(account.verifiedEmail&&Number.isFinite(account.emailVerifiedAt)){const owner=await this.repository.findByEmail(account.verifiedEmail);if(owner?.id===account.id)return;}if(typeof this.pushTransport?.send==='function'&&account.setupPushVerified?.expiresAt>this.clock()){if(typeof this.pushTransport.register!=='function')fail('push_unavailable','Push registration is not configured.');await this.pushTransport.register({owner:account.id,subscription:account.setupPushVerified.subscription});if(account.pendingExpiresAt<=this.clock()||account.setupPushVerified.expiresAt<=this.clock())fail('unauthorized','This setup proof expired. Start another check.');return;}fail('contact_required','Verify an email address or enable and verify push notifications before activating your account.');}
  async confirmRecovery(input, context) {
    this.origin(context); const account = await this.pending(input.pendingToken,context); const revision = account.revision,activationDeadline=account.pendingExpiresAt;
    if (input.downloadConfirmed !== true || !account.recoveryHash || typeof input.recoveryToken !== 'string' || !secureEqual(account.recoveryHash, await this.crypto.hash('recovery', input.recoveryToken))) fail('recovery_confirmation_required', 'Download and confirm your recovery file before continuing.');
    if (!account.passwordHash && !account.credentials.length) fail('credential_required');
    await this.requireSetupChannel(account);
    if(account.admission?.kind==='paid'&&account.admission.initialPaymentRequired!==false){if(!this.setupBilling)fail('payment_required','Verify your paid subscription before activating this account.');const payment=await this.setupBilling.status(account.id,account.admission);if(payment?.paymentVerified!==true||payment.signupPlan!==account.admission.plan||payment.validUntil<=this.clock())fail('payment_required','Payment is still being verified. Recheck before activating your account.');account.admission.initialPaymentRequired=false;}
    if(account.systemIdentity)account.admission={...account.admission,initialSystemActivationRequired:false};
    const source=account.status==='recovering'?'recovery':'activation',activationCredentialAt=account.pendingCredentialAt;delete account.pendingCredentialAt;
    account.status = 'active'; account.pendingHash = null; account.pendingExpiresAt = null; account.challenges = [];delete account.setupBindingHash;delete account.setupEmailChallenge;delete account.setupPushChallenge;delete account.setupEmailSends;delete account.setupEmailSentAt;delete account.setupPushSends;delete account.setupPushSentAt;delete account.setupEmailWindowAt;delete account.setupPushWindowAt;
    delete account.recoveryResumeHash; delete account.recoveryResumeBackupVersion;
    this.audit(account, 'account-activated'); const result = await this.session(account,{source,activationCredentialAt});if(activationDeadline<=this.clock())fail('unauthorized','This setup session expired.');
    await this.save(account, revision); return result;
  }
  async resumeSetupCredential(account,context,revision=account.revision){const pendingToken=await this.newPending(account,context);account.pendingCredentialAt=this.clock();account.challenges=[];this.audit(account,'setup-credential-resumed');await this.save(account,revision);return {pendingToken,account:await this.projectAccount(account),readyForRecovery:Boolean(account.passwordHash||account.credentials.length),credentialRequired:false,resumed:true,signupPlan:account.admission?.plan??'free',paymentRequired:account.admission?.kind==='paid'&&account.admission.initialPaymentRequired!==false,setup:this.setupProjection(account)};}
  async loginPassword(input, context) {
    this.origin(context);input={...input,handle:handle(input.handle)};await this.guard('login', input, context); password(input.password);
    const account = await this.repository.findByHandle(input.handle);
    // The dummy hash performs equivalent KDF work for unknown accounts.
    this.dummyPasswordHash ??= this.passwordHasher.dummyHash || this.passwordHasher.hash(this.crypto.random());
    const dummyHash = await this.dummyPasswordHash;
    const hash = account?.passwordHash || dummyHash;
    const verified = await this.passwordHasher.verify(input.password, hash);
    if (!account || !['active',...(this.config.requireReachability===true||account?.systemIdentity||account?.onboardingIdentity)?['pending','recovering']:[]].includes(account.status) || !account.passwordHash || !verified) fail('unauthorized', 'Authentication failed.');
    if(account.status!=='active')return this.resumeSetupCredential(account,context);
    const revision = account.revision; const result = await this.session(account, { label: input.label }); await this.save(account, revision); return result;
  }
  async beginPasskeyLogin(input, context) {
    this.origin(context);input={...input,handle:handle(input.handle)};await this.guard('login', input, context);
    const account = await this.repository.findByHandle(input.handle);
    const authenticationOptions = await this.webauthn.authenticationOptions({ config: this.config });
    const challengeToken = `${account?.id || this.crypto.id()}.${this.crypto.random()}`;
    if (account?.status === 'active'||(this.config.requireReachability===true||account?.systemIdentity||account?.onboardingIdentity)&&['pending','recovering'].includes(account?.status)) {
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
    if (!account || !['active',...(this.config.requireReachability===true||account?.systemIdentity||account?.onboardingIdentity)?['pending','recovering']:[]].includes(account.status) || !challenge || !credential) fail('unauthorized', 'Authentication failed.');
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
      account.status = 'recovering'; account.recoveryHash = null; account.credentials = []; account.passwordHash = null; account.sessions = []; revokeAllLineage(account, this.clock()); account.emailChallenges = [];
    }
    // Resumption only rotates the limited setup authority; completed replacement
    // credentials and the replacement recovery file remain intact.
    account.challenges = [];
    const pendingToken = await this.newPending(account,context); this.audit(account, resumed ? 'recovery-setup-resumed' : 'account-recovery-started');
    await this.save(account, revision);
    const credentialRequired = !account.passwordHash && !account.credentials.length;
    return { pendingToken, account: await this.projectAccount(account), credentialRequired, readyForRecovery: !credentialRequired, resumed };
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
    return { account: await this.projectAccount(account), csrfToken: session.csrfToken, expiresAt: session.expiresAt,authTime:Number.isFinite(this.authAt(session))?this.authAt(session):null,sessionContext:await this.sessionID(session),signOutImpact:await this.signOutImpact(account,session),
      credentials: publicCredentials(account),
      devices: await Promise.all(account.sessions.filter(s => s.expiresAt > this.clock()).map(async s => ({
        id: await this.sessionID(s), label: s.label || 'Browser session', createdAt: s.createdAt, ...s.parentSessionId?{approvedFrom:s.parentSessionId}:{},
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
    await this.pruneSessions(account,s=>s.credentialId===input.credentialId);
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
    await this.pruneSessions(account,s=>s===target); this.audit(account, 'device-session-revoked');
    await this.save(account, revision); return { revoked: true, currentSessionRevoked: !account.sessions.includes(session) };
  }
  async revokeOtherSessions(input, context) {
    const { account, session } = await this.recent(context); const revision = account.revision;
    const keep=new Set([await this.sessionID(session)]);let parent=session.parentSessionId;while(parent&&!keep.has(parent)){keep.add(parent);parent=account.sessions.find(s=>s.id===parent)?.parentSessionId;}const before=account.sessions.filter(s=>s.expiresAt>this.clock()).length;const ids=new Map(await Promise.all(account.sessions.map(async s=>[s,await this.sessionID(s)])));await this.pruneSessions(account,s=>!keep.has(ids.get(s)));const count=before-account.sessions.filter(s=>s.expiresAt>this.clock()).length; this.audit(account, 'other-device-sessions-revoked');
    await this.save(account, revision); return { revoked: count };
  }
  /** What ordinary sign-out of `session` also ends, for the sign-out warning (architecture §7.4). */
  async signOutImpact(account,session){const now=this.clock(),chain=new Set([await this.sessionID(session)]);let changed=true;while(changed){changed=false;for(const s of account.sessions)if(s.parentSessionId&&chain.has(s.parentSessionId)&&s.expiresAt>now&&!chain.has(s.id)){chain.add(s.id);changed=true;}}return {sessions:chain.size-1,apps:(account.linkedLineage??[]).filter(entry=>entry.expiresAt>now&&entry.sessions.some(id=>chain.has(id))).length};}
  linkedFlow() { return this.linkedApproval ||= new LinkedApproval(this, IdentityFault); }
  deviceFlow() { return this.deviceLogin ||= new DeviceLogin(this, IdentityFault); }
  // Linked approval (packages/identity/linked-approval.mjs; contract in linked-approval.md §10.1). Gated by
  // config.deviceAuthorizationEnabled. The system operations below are for the federation engine and are never routed.
  async linkedStart(input, context) { return this.linkedFlow().start(input, context); }
  async linkedResolve(input, context) { return this.linkedFlow().resolve(input, context); }
  async linkedApprove(input, context) { return this.linkedFlow().approve(input, context); }
  async linkedDeny(input, context) { return this.linkedFlow().deny(input, context); }
  async linkedPoll(input, context) { return this.linkedFlow().poll(input, context); }
  async linkedAccept(input, context) { return this.linkedFlow().accept(input, context); }
  async linkedCancel(input, context) { this.linkedFlow().enabled(); return this.linkedFlow().cancel(input, context); }
  async linkedStartApp(input, context) { return this.linkedFlow().startApp(input, context); }
  async linkedRedeem(input, context) { return this.linkedFlow().redeem(input, context); }
  async linkedCancelApp(input) { return this.linkedFlow().cancelApp(input); }
  async linkedLineageLive(input) { return this.linkedFlow().lineageLive(input); }
  async linkedLineageRevoke(input) { return this.linkedFlow().lineageRevoke(input); }
  async linkedOutbox(input) { return this.linkedFlow().outbox(input); }
  async linkedOutboxAck(input) { return this.linkedFlow().outboxAck(input); }
  async createDeviceLogin(input, context) { return this.deviceFlow().create(input, context); }
  async deviceRequest(input, context) { return this.deviceFlow().inspect(input, context); }
  async approveDeviceLogin(input, context) { return this.deviceFlow().approve(input, context); }
  async denyDeviceLogin(input, context) { return this.deviceFlow().deny(input, context); }
  async pollDeviceLogin(input, context) { return this.deviceFlow().poll(input, context); }
  async cancelDeviceLogin(input, context) { return this.deviceFlow().cancel(input, context); }
  async emailStart(input, context) {
    if (!this.mailer) fail('email_unavailable', 'Email delivery is not configured.');
    const { account, session } = await this.authorized(context, true); const revision = account.revision;
    if (this.authAt(session) + 900000 <= this.clock()) fail('reauthentication_required', 'Sign in again before changing recovery email.');
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
    this.audit(account, 'email-linked'); await this.save(account, revision); return { linked: true, account: await this.projectAccount(account) };
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
    const result = await this.session(account,{source:'email'}); await this.save(account, revision); return result;
  }
  async configureEmailLogin(input, context) {
    const { account } = await this.recent(context); const revision = account.revision;
    if (typeof input.enabled !== 'boolean') fail('invalid_request', 'Choose whether email can sign in to this account.');
    if (input.enabled && !account.verifiedEmail) fail('verified_email_required', 'Verify a contact email before enabling email sign-in.');
    account.emailLoginEnabled = input.enabled;
    account.emailChallenges = (account.emailChallenges || []).filter(challenge => challenge.purpose !== 'login');
    this.audit(account, input.enabled ? 'email-login-enabled' : 'email-login-disabled');
    await this.save(account, revision); return { emailLoginEnabled: account.emailLoginEnabled, account: await this.projectAccount(account) };
  }
  async logoutSaved(input,context){
    this.origin(context);const {account,session}=await this.authorized(context);const revision=account.revision;await this.pruneSessions(account,s=>s===session);this.audit(account,'session-closed');await this.save(account,revision);return {loggedOut:true};
  }
  async logout(input, context) {
    const { account, session } = await this.authorized(context, true); const revision = account.revision;
    await this.pruneSessions(account,s=>s===session); this.audit(account, 'session-closed');
    await this.save(account, revision); return { loggedOut: true };
  }
}
