import {validateIdentityBackup,verifyIdentityBackup} from '/packages/recovery/identity-backup.mjs';
import { Provider } from '../shared/stack.mjs';
function validatePayload(payload,issuer){
 if(payload?.version===2){const result=validateIdentityBackup(payload);if(result.issuer!==issuer)throw new Error('This recovery file belongs to another service.');return result;}
 if(!payload||Object.getPrototypeOf(payload)!==Object.prototype||Object.keys(payload).some(key=>!['version','issuer','handle','recoveryToken','warning'].includes(key))||payload.version!==1||payload.issuer!==issuer||typeof payload.handle!=='string'||!/^[a-z][a-z0-9_-]{2,31}$/.test(payload.handle)||typeof payload.recoveryToken!=='string'||!/^[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/.test(payload.recoveryToken)||(payload.warning!==undefined&&typeof payload.warning!=='string'))throw new Error('This recovery file has an invalid payload or belongs to another service.');
 return payload;
}
export default class RecoveryFileProvider extends Provider {
 #workers=new Set();#operations=new Set();#disposed=false;
 async #verify(payload,issuer,signal){
  signal.throwIfAborted();
  if(payload.version!==2)return payload;
  const response=await fetch('/api/recovery/authority',{credentials:'same-origin',cache:'no-store',signal:AbortSignal.any([signal,AbortSignal.timeout(10000)])});
  if(!response.ok)throw new Error('The service could not verify this identity backup. Try again later.');
  const authority=await response.json();const result=await verifyIdentityBackup(payload,authority,{issuer});signal.throwIfAborted();return result;
 }
 async #run(operation){
  if(this.#disposed||this.#operations.size)throw new Error('Recovery operation is unavailable.');
  const controller=new AbortController();this.#operations.add(controller);
  try{const result=await operation(controller.signal);controller.signal.throwIfAborted();return result;}finally{this.#operations.delete(controller);}
 }
 async obtain(){return Object.freeze({
  inspect:async file=>{const text=await this.#read(file),core=await import('/packages/recovery/index.mjs');return {text,header:core.inspectRecoveryFile(text)};},
  encrypt:async(payload,questions,answers,issuer)=>this.#run(async signal=>{payload=await this.#verify(validatePayload(payload,issuer),issuer,signal);const core=await import('/packages/recovery/index.mjs');return core.encryptRecoveryFile(payload,questions,answers,{deriveKey:options=>this.#derive(options,signal),crypto:globalThis.crypto});}),
  decrypt:async(file,answers,issuer)=>this.#run(async signal=>{const core=await import('/packages/recovery/index.mjs');const result=await core.decryptRecoveryFile(file,answers,{deriveKey:options=>this.#derive(options,signal),crypto:globalThis.crypto});return this.#verify(validatePayload(result,issuer),issuer,signal);}),
  cancel:()=>this.#cancel()
 });}
 release(){}
 async #read(file){if(!file||file.size>131072||typeof file.text!=='function')throw new Error('Choose an encrypted recovery file smaller than 128 KB.');const text=await file.text();if(new TextEncoder().encode(text).length>131072)throw new Error('This encrypted recovery file is too large.');return text;}
 #derive(options,signal){signal?.throwIfAborted();if(this.#disposed)throw new Error('Recovery operation was closed.');if(this.#workers.size)throw new Error('A recovery operation is already running.');return new Promise((resolve,reject)=>{
  const worker=new Worker(import.meta.resolve('/recovery-kdf-worker.mjs'),{type:'module'});const record={worker,reject,timer:null};this.#workers.add(record);
  const stop=()=>{clearTimeout(record.timer);worker.terminate();this.#workers.delete(record);};
  record.timer=setTimeout(()=>{stop();reject(new Error('Recovery key derivation timed out. Try again on a device with more available memory.'));},90000);
  worker.onmessage=event=>{stop();if(event.data?.key instanceof Uint8Array&&event.data.key.length===32)resolve(event.data.key);else reject(new Error('Recovery key derivation could not be completed on this device.'));};
  worker.onerror=event=>{event.preventDefault();stop();reject(new Error('Recovery key derivation could not be completed on this device.'));};
  // Structured clone preserves the caller's buffer so the core can wipe it.
  worker.postMessage({options});
 });}
 #cancel(){for(const operation of this.#operations)operation.abort();for(const record of this.#workers){clearTimeout(record.timer);record.worker.terminate();record.reject(new Error('Recovery operation canceled.'));}this.#workers.clear();}
 dispose(){this.#disposed=true;this.#cancel();}
}
