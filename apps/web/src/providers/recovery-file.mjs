import { Provider } from '../shared/stack.mjs';
function validatePayload(payload,issuer){
 if(!payload||Object.getPrototypeOf(payload)!==Object.prototype||Object.keys(payload).some(key=>!['version','issuer','handle','recoveryToken','warning'].includes(key))||payload.version!==1||payload.issuer!==issuer||typeof payload.handle!=='string'||!/^[a-z][a-z0-9_-]{2,31}$/.test(payload.handle)||typeof payload.recoveryToken!=='string'||!/^[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/.test(payload.recoveryToken)||(payload.warning!==undefined&&typeof payload.warning!=='string'))throw new Error('This recovery file has an invalid payload or belongs to another service.');
 return payload;
}
export default class RecoveryFileProvider extends Provider {
 #workers=new Set();#disposed=false;
 async obtain(){return Object.freeze({
  inspect:async file=>{const text=await this.#read(file),core=await import('/packages/recovery/index.mjs');return {text,header:core.inspectRecoveryFile(text)};},
  encrypt:async(payload,questions,answers,issuer)=>{validatePayload(payload,issuer);const core=await import('/packages/recovery/index.mjs');return core.encryptRecoveryFile(payload,questions,answers,{deriveKey:options=>this.#derive(options),crypto:globalThis.crypto});},
  decrypt:async(file,answers,issuer)=>{const core=await import('/packages/recovery/index.mjs');const result=await core.decryptRecoveryFile(file,answers,{deriveKey:options=>this.#derive(options),crypto:globalThis.crypto});return validatePayload(result,issuer);},
  cancel:()=>this.#cancel()
 });}
 release(){}
 async #read(file){if(!file||file.size>131072||typeof file.text!=='function')throw new Error('Choose an encrypted recovery file smaller than 128 KB.');const text=await file.text();if(new TextEncoder().encode(text).length>131072)throw new Error('This encrypted recovery file is too large.');return text;}
 #derive(options){if(this.#disposed)throw new Error('Recovery operation was closed.');if(this.#workers.size)throw new Error('A recovery operation is already running.');return new Promise((resolve,reject)=>{
  const worker=new Worker('/recovery-kdf-worker.mjs',{type:'module'});const record={worker,reject,timer:null};this.#workers.add(record);
  const stop=()=>{clearTimeout(record.timer);worker.terminate();this.#workers.delete(record);};
  record.timer=setTimeout(()=>{stop();reject(new Error('Recovery key derivation timed out. Try again on a device with more available memory.'));},90000);
  worker.onmessage=event=>{stop();if(event.data?.key instanceof Uint8Array&&event.data.key.length===32)resolve(event.data.key);else reject(new Error('Recovery key derivation could not be completed on this device.'));};
  worker.onerror=event=>{event.preventDefault();stop();reject(new Error('Recovery key derivation could not be completed on this device.'));};
  // Structured clone preserves the caller's buffer so the core can wipe it.
  worker.postMessage({options});
 });}
 #cancel(){for(const record of this.#workers){clearTimeout(record.timer);record.worker.terminate();record.reject(new Error('Recovery operation canceled.'));}this.#workers.clear();}
 dispose(){this.#disposed=true;this.#cancel();}
}
