import {createIdentityBackup,verifyIdentityBackup,createNameAssignment} from '../recovery/identity-backup.mjs';

/** Provider authority is an injected, independent key; never derive it from
 * the credential-encryption key or trust an authority embedded in a file. */
export function identityBackupPort({config,accounts}){
  let authority;
  const load=()=>{
    if(authority)return authority;
    if(!config.RECOVERY_SIGNING_KEY)throw Object.assign(new Error('Identity backup signing is not configured.'),{code:'recovery_unavailable',status:503});
    const value=JSON.parse(config.RECOVERY_SIGNING_KEY);
    if(!value||typeof value.kid!=='string'||!value.privateJWK?.d)throw new Error('Invalid recovery authority configuration');
    const {d,key_ops,...publicJWK}=value.privateJWK;
    return authority={kid:value.kid,privateKey:value.privateJWK,publicKey:publicJWK};
  };
  const chain=async (owner,create=true)=>{
    const result=await accounts.get(owner).invoke({method:'identityKeychain',args:[owner,{create}]});
    if(result?.$fault)throw Object.assign(new Error(result.$fault.message),result.$fault);
    return result;
  };
  return {
    async issue(account,recoveryToken){const authority=load();return createIdentityBackup({issuer:config.APP_ORIGIN,entity:account.id,keychain:await chain(account.id),recoveryToken,warning:'Keep this encrypted identity backup private. It contains your signing and encryption keys. Recovery replaces login credentials; revoked permissions stay revoked. A name assignment does not override a newer assignment or recreate deleted data.'},authority);},
    async certificate(account,handle,issuedAt){return createNameAssignment({issuer:config.APP_ORIGIN,entity:account.id,handle,assignmentId:account.assignmentId||account.nameAssignmentId,issuedAt},load());},
    async verify(backup,account,recoveryToken){
      const result=await verifyIdentityBackup(backup,load(),{issuer:config.APP_ORIGIN,entity:account.id});
      if(result.recoveryToken!==recoveryToken)throw new Error('Recovery proof does not match');
      const current=await chain(account.id,false);
      for(const purpose of ['signing','encryption']){
        if(current[purpose].kid!==result.keychain[purpose].kid)throw new Error('Identity key has changed');
        for(const field of ['kty','crv','x','y','d'])if(current[purpose].privateJWK[field]!==result.keychain[purpose].privateJWK[field])throw new Error('Identity key has changed');
      }
      return result;
    }
  };
}

export function recoveryAuthorityPublic(config){
  if(!config.RECOVERY_SIGNING_KEY)throw Object.assign(new Error('Identity backup signing is not configured.'),{code:'recovery_unavailable',status:503});
  const {kid,privateJWK}=JSON.parse(config.RECOVERY_SIGNING_KEY);
  if(typeof kid!=='string'||!privateJWK?.d||privateJWK.kty!=='EC'||privateJWK.crv!=='P-256')throw new Error('Invalid recovery authority configuration');
  return {kid,publicKey:{kty:'EC',crv:'P-256',x:privateJWK.x,y:privateJWK.y}};
}
