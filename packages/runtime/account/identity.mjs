// AccountController slice 13a, Edge engine and identity (docs/architecture/app-engine.md §12): account identity keys and signup bookkeeping.
// `methods` are installed on AccountController.prototype (`this` is the controller); `rpc` lists the methods
// `invoke` accepts and the placement policy it applies to each (packages/runtime/account/index.mjs).
import {UNPAID_LIFECYCLE_ORIGIN} from '../../identity/lifecycle-protection.mjs';
import {key} from '../../messaging/store.mjs';
import {encryptSecret,decryptSecret} from '../secrets.mjs';
import {StorageError} from '../../storage/policy.mjs';

export const methods={
  async signingKey(owner){
    const existing=await this.metadata.get('signing-key');
    if(existing){const jwk=await decryptSecret(existing.encrypted,this.config.KEY_ENCRYPTION_KEY);return {kid:existing.kid,privateKey:await crypto.subtle.importKey('jwk',jwk,{name:'ECDSA',namedCurve:'P-256'},false,['sign'])};}
    const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);const kid=crypto.randomUUID();
    const exported=await crypto.subtle.exportKey('jwk',pair.publicKey);
    // Construct the public shape explicitly; an imported/exported key object
    // must never smuggle private material into the verification registry.
    const publicJwk={kty:'EC',crv:'P-256',x:exported.x,y:exported.y,key_ops:['verify'],ext:true};
    await this.tokens.registerKey(owner,{kid,alg:'ES256',publicJwk});
    await this.metadata.put('signing-key',{kid,encrypted:await encryptSecret(await crypto.subtle.exportKey('jwk',pair.privateKey),this.config.KEY_ENCRYPTION_KEY)});
    return {kid,privateKey:pair.privateKey};
  },
  // Internal identity-backup port only; never exposed by owner/MCP HTTP routes.
  async identityKeychain(owner,{create=true}={}){
    if(create){await this.warm(owner);await this.signingKey(owner);}
    const signing=await this.metadata.get('signing-key');
    let encryption=await this.metadata.get('encryption-key');
    if(!signing||(!encryption&&!create))throw new StorageError('identity_keys_unavailable','Identity keys are unavailable.',409);
    if(!encryption){
      const pair=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveKey','deriveBits']);
      encryption={kid:crypto.randomUUID(),encrypted:await encryptSecret(await crypto.subtle.exportKey('jwk',pair.privateKey),this.config.KEY_ENCRYPTION_KEY)};
      await this.metadata.put('encryption-key',encryption);
    }
    return {version:1,signing:{kid:signing.kid,privateJWK:await decryptSecret(signing.encrypted,this.config.KEY_ENCRYPTION_KEY)},encryption:{kid:encryption.kid,privateJWK:await decryptSecret(encryption.encrypted,this.config.KEY_ENCRYPTION_KEY)}};
  },
  // Public identity port: only this account's current identity signing key; runs outside the gate.
  async identitySigningKey(owner,kid){if(await this.metadata.get('owner')!==owner)return null;const signing=await this.metadata.get('signing-key');if(!signing||signing.kid!==kid)return null;const record=await this.metadata.get(key('contact-key',owner,kid));if(!record||record.owner!==owner||record.alg!=='ES256')return null;const {kty,crv,x,y}=record.publicJwk;return {alg:'ES256',publicJwk:{kty,crv,x,y},active:record.active===true,purpose:'signing'};},
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
