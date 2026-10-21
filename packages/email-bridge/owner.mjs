import {bridgeObjectName} from './worker.mjs';
const unavailable=()=>{throw Object.assign(new Error('The email bridge is unavailable.'),{code:'email_unavailable',status:503});};
export async function ownerOperation(env,id,operation,input){
 if(env.EMAIL_BRIDGE?.get&&env.EMAIL_BRIDGE?.idFromName)return env.EMAIL_BRIDGE.get(env.EMAIL_BRIDGE.idFromName(bridgeObjectName(id))).operate(operation,id,input);
 // Durable Node adapters may inject this owner transport; no SMTP or demo HTTP endpoint is mounted.
 const name={'bridge.settings':'settings','bridge.configure':'configure','bridge.accepted':'accepted'}[operation],port=env.EMAIL_BRIDGE_OWNER;
 if(typeof port?.[name]==='function')return port[name](id,operation==='bridge.accepted'?input.jti:input);
 unavailable();
}
