import {StorageError} from '../storage/policy.mjs';

/** Deliberately expose only the bucket operations used by account logic.
 * Extra billable APIs (list/copy/multipart) require explicit metered adapters.
 * Admission context is internal and never forwarded to the provider. */
export function guardedBucket(bucket,{admit}){
 return {
  get:(...args)=>bucket.get(...args),
  delete:(...args)=>bucket.delete(...args),
  async put(key,value,options){
   if(options!==undefined&&(!options||typeof options!=='object'||Array.isArray(options)))throw new StorageError('invalid_args','Invalid storage options.');
   const {storageAdmission,...providerOptions}=options??{};
   if(storageAdmission!==undefined&&(!storageAdmission||typeof storageAdmission.clientId!=='string'||Object.keys(storageAdmission).some(key=>key!=='clientId')))throw new StorageError('invalid_args','Invalid storage admission context.');
   await admit(storageAdmission?.clientId??'@system');
   return options===undefined?bucket.put(key,value):bucket.put(key,value,providerOptions);
  }
 };
}
