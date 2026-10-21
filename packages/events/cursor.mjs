// Cursor and receipt MACs (docs/spec/events.md §4.1, §4.2). A cursor is client-held and bound by HMAC-SHA-256 to
// (owner, bus resource, bus incarnation, reader client, reader floor, reader nonce, position). The nonce changes
// whenever a read grant is re-approved after revocation, so a cursor never outlives the floor it was minted under, but
// survives grant widening (it is not bound to the grant identifier). A receipt is an opaque per-record MAC that does not
// reveal the global `seq` (SEC-13). Keys are derived with HKDF from a host secret under separate labels.
import {base64url,fromBase64url} from '../core/records.mjs';

const encoder=new TextEncoder();
const fail=()=>{throw Object.assign(new Error('The cursor is not valid for this reader.'),{code:'invalid_args',status:400});};
function secretBytes(value){
 if(value instanceof Uint8Array)return value;
 if(typeof value!=='string'||!value)return null;
 try{const bytes=Uint8Array.from(atob(value),c=>c.charCodeAt(0));if(bytes.length>=32)return bytes;}catch{}
 return value.length>=32?encoder.encode(value):null;
}
/** Derive the bus MAC keys from `EVENT_BUS_CURSOR_KEY` or else `KEY_ENCRYPTION_KEY` (HKDF, label-separated). Null when
 * neither is a 256-bit secret: callers then refuse bus operations (fail closed) instead of minting unkeyed cursors. */
export async function busKeys(config,crypto=globalThis.crypto){
 const secret=secretBytes(config?.EVENT_BUS_CURSOR_KEY)??secretBytes(config?.KEY_ENCRYPTION_KEY);if(!secret)return null;
 const base=await crypto.subtle.importKey('raw',secret,'HKDF',false,['deriveKey']);
 const derive=label=>crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:encoder.encode('bindle-event-bus-v1'),info:encoder.encode(label)},base,{name:'HMAC',hash:'SHA-256',length:256},false,['sign','verify']);
 return {cursor:await derive('cursor'),receipt:await derive('receipt'),reader:await derive('reader'),crypto};
}
const bind=(owner,bus,client,payload)=>encoder.encode(`bindle-event-bus-cursor-v1\0${owner}\0${bus}\0${client}\0${payload}`);
/** Opaque cursor string, at most 512 characters. */
export async function mintCursor(keys,{owner,bus,client},state){
 const payload=base64url(encoder.encode(JSON.stringify([1,state.incarnation,state.floor,state.nonce,state.position])));
 const mac=base64url(new Uint8Array(await keys.crypto.subtle.sign('HMAC',keys.cursor,bind(owner,bus,client,payload))));
 return `${payload}.${mac}`;
}
/** The verified cursor state, or `invalid_args` for anything forged, foreign, stale or malformed (nothing revealed). */
export async function openCursor(keys,{owner,bus,client},cursor){
 if(typeof cursor!=='string'||cursor.length>512||!/^[A-Za-z0-9_-]{1,400}\.[A-Za-z0-9_-]{43}$/.test(cursor))fail();
 const [payload,mac]=cursor.split('.');let signature;try{signature=fromBase64url(mac);}catch{fail();}
 if(!await keys.crypto.subtle.verify('HMAC',keys.cursor,signature,bind(owner,bus,client,payload)))fail();
 let value;try{value=JSON.parse(new TextDecoder().decode(fromBase64url(payload)));}catch{fail();}
 if(!Array.isArray(value)||value.length!==5||value[0]!==1||typeof value[1]!=='string'||!Number.isSafeInteger(value[2])||typeof value[3]!=='string'||!Number.isSafeInteger(value[4])||value[4]<value[2])fail();
 return {incarnation:value[1],floor:value[2],nonce:value[3],position:value[4]};
}
/** Opaque receipt: unique per (bus incarnation, seq), meaningless outside this host. */
export async function receiptFor(keys,{owner,bus,incarnation,seq}){
 return 'r1.'+base64url(new Uint8Array(await keys.crypto.subtle.sign('HMAC',keys.receipt,encoder.encode(`bindle-event-bus-receipt-v1\0${owner}\0${bus}\0${incarnation}\0${seq}`)))).slice(0,32);
}
/** Stable storage key for a principal: keyed hash, so client identifiers of arbitrary length never form row keys and
 * rows do not list client identifiers in clear. */
export async function principalKey(keys,label,value){
 return base64url(new Uint8Array(await keys.crypto.subtle.sign('HMAC',keys.reader,encoder.encode(`bindle-event-bus-principal-v1\0${label}\0${value}`)))).slice(0,32);
}
