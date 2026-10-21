// AccountController slice 13a, Edge engine and identity (docs/architecture/app-engine.md §12): account identity keys and signup bookkeeping.
// `methods` are installed on AccountController.prototype (`this` is the controller); `rpc` lists the methods
// `invoke` accepts and the placement policy it applies to each (packages/runtime/account/index.mjs).
import {UNPAID_LIFECYCLE_ORIGIN} from '../../identity/lifecycle-protection.mjs';
import {IdentityKeyRegistry,createIdentityKeyEngine,performKeyAction,readKeyQuery,EnsureIdentityKey,RotateIdentityKey,RevokeIdentityKey,IdentityKeyByKid,IdentityKeyHistory} from '../../identity/keys.mjs';
import {encryptSecret,decryptSecret} from '../secrets.mjs';
import {StorageError} from '../../storage/policy.mjs';

// One identity key engine per controller, over the controller's transactional account store (packages/identity/keys.mjs).
// Private keys are sealed under KEY_ENCRYPTION_KEY exactly as before; nothing here logs or returns key material
// except the internal identity-backup port.
const engines=new WeakMap();
function keyEngine(c){let engine=engines.get(c);if(!engine){engine=createIdentityKeyEngine(new IdentityKeyRegistry({store:c.store,seal:value=>encryptSecret(value,c.config.KEY_ENCRYPTION_KEY),open:value=>decryptSecret(value,c.config.KEY_ENCRYPTION_KEY)}));engines.set(c,engine);}return engine;}
const unavailable=()=>new StorageError('identity_keys_unavailable','Identity keys are unavailable.',409);

export const methods={
  async signingKey(owner){
    const engine=keyEngine(this);let signer=await engine.identityKeys.privateKey(owner,'signing');
    if(!signer){await performKeyAction(engine,new EnsureIdentityKey({owner,input:{purpose:'signing'}}));signer=await engine.identityKeys.privateKey(owner,'signing');}
    if(!signer)throw unavailable();return signer;
  },
  // Internal identity-backup port only; never exposed by owner/MCP HTTP routes. `create:false` never writes.
  async identityKeychain(owner,{create=true}={}){
    const engine=keyEngine(this);
    if(create){await this.warm(owner);for(const purpose of ['signing','encryption'])await performKeyAction(engine,new EnsureIdentityKey({owner,input:{purpose}}));}
    const signing=await engine.identityKeys.exportPrivate(owner,'signing'),encryption=await engine.identityKeys.exportPrivate(owner,'encryption');
    if(!signing||!encryption)throw unavailable();
    return {version:1,signing,encryption};
  },
  // Internal key management (no `rpc` entry, so never reachable through `invoke`). Rotation and revocation change
  // what old recovery files restore: verification compares against the current keys and rejects older files.
  async rotateIdentityKey(owner,{purpose,expectedKid}={}){await this.warm(owner);return performKeyAction(keyEngine(this),new RotateIdentityKey({owner,input:{purpose,expectedKid}}));},
  async revokeIdentityKey(owner,{purpose,kid,reason}={}){await this.warm(owner);return performKeyAction(keyEngine(this),new RevokeIdentityKey({owner,input:{purpose,kid,...reason===undefined?{}:{reason}}}));},
  async identityKeyHistory(owner,{purpose}={}){return readKeyQuery(keyEngine(this),new IdentityKeyHistory({owner,input:{purpose}}));},
  // Public identity port: this account's signing key `kid`; runs outside the gate. Only the current key is `active`;
  // a retired or revoked key is reported inactive with its state, an unknown kid is null.
  async identitySigningKey(owner,kid){if(await this.metadata.get('owner')!==owner||typeof kid!=='string')return null;const record=await readKeyQuery(keyEngine(this),new IdentityKeyByKid({owner,input:{purpose:'signing',kid}}));if(!record||record.alg!=='ES256')return null;const {kty,crv,x,y}=record.publicJwk;return {kid,alg:'ES256',publicJwk:{kty,crv,x,y},active:record.current===true,purpose:'signing',state:record.state};},
  // Same-host principal lookup: identity directory status/handle plus that account's signing key.
  async identityRecord(subject,kid){if(!/^[a-f0-9-]{36}$/.test(subject)||typeof kid!=='string'||typeof this.config.IDENTITY_ACCOUNT!=='function')return null;const account=await this.config.IDENTITY_ACCOUNT(subject);if(!account)return null;const local=await this.metadata.get('owner')===subject,record=local?await this.identitySigningKey(subject,kid):await this.config.CONVERSATION_ACCOUNT?.(subject)?.invoke({method:'identitySigningKey',args:[subject,kid]});return record&&!record.$fault?{...record,accountActive:account.status==='active',handle:account.handle}:null;},
  async identityKey(subject,kid){const record=await this.identityRecord(subject,kid);return record&&{alg:record.alg,publicJwk:record.publicJwk,active:record.active,purpose:record.purpose,accountActive:record.accountActive};},
  async rememberSignupOrigin(owner,{createdAt}={}){if(!Number.isSafeInteger(createdAt)||createdAt>Date.now()||createdAt<0)throw new StorageError('invalid_signup_origin','Trusted signup creation time is required.');await this.warm(owner);await this.metadata.transaction(async tx=>{if(await tx.get('owner')!==owner)throw new StorageError('forbidden','Account owner mismatch.',403);if(await tx.get(UNPAID_LIFECYCLE_ORIGIN)!==undefined)return;if(await tx.get('billing/state')!==undefined||await tx.get('lifecycle/paid-protection-v1')!==undefined||await tx.get('billing/ever-paid/production/'+owner)!==undefined||await tx.get('billing/ever-paid/sandbox/'+owner)!==undefined)return;await tx.put(UNPAID_LIFECYCLE_ORIGIN,{version:1,owner,origin:this.config.APP_ORIGIN,createdAt,source:'identity-signup'});});return {recorded:true};},
  async registerSignupPush(owner,{subscription}={}){await this.warm(owner);return this.notifications.subscribe(owner,subscription,'Account notifications',{enable:true});},
};

export const rpc={
 identitySigningKey:{lifecycle:'purging',gate:'none'},
 identityKeychain:{lifecycle:'suspended'},
 rememberSignupOrigin:{},
 registerSignupPush:{},
};
