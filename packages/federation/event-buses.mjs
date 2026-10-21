import {AppAction,AppQuery} from '../app/engine.mjs';
import {canonical} from '../messaging/store.mjs';
import {fail,object,strings,pinSchema} from './schema.mjs';
import {validateSlotManifest,validateExtensionDigest,slotDigest} from './extensions.mjs';

export const EVENT_BUS_CONTRACT='https://spec.bindle.example/contracts/event-bus/v1';
const BUS_KEYS=['v','types','payload','max_record_bytes','retention','publishers','readers','history','categories','effects'];
const SCHEMA_KEYS=['type','enum','const','properties','required','additionalProperties','items','maxItems','maxLength','format','minimum','maximum','multipleOf'],TYPES=['object','array','string','integer','number','boolean','null'];
const own=(value,key)=>object(value)&&Object.hasOwn(value,key),bytes=value=>new TextEncoder().encode(JSON.stringify(value)).length;
const integer=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const exact=(value,keys)=>{if(!object(value)||Object.keys(value).some(key=>!keys.includes(key)))fail('invalid_bus');};
const subset=value=>{strings(value,2);if(!value.length||value.some(kind=>!['application','provider'].includes(kind)))fail('invalid_bus');};
// BCP 47 syntax, including private-use and grandfathered tags that Intl may not support.
const locale=/^(?:(?:[a-z]{2,3}(?:-[a-z]{3}){0,3}|[a-z]{4}|[a-z]{5,8})(?:-[a-z]{4})?(?:-[a-z]{2}|-\d{3})?(?:-(?:[a-z0-9]{5,8}|\d[a-z0-9]{3}))*(?:-[0-9a-wy-z](?:-[a-z0-9]{2,8})+)*(?:-x(?:-[a-z0-9]{1,8})+)?|x(?:-[a-z0-9]{1,8})+|en-GB-oed|i-(?:ami|bnn|default|enochian|hak|klingon|lux|mingo|navajo|pwn|tao|tay|tsu)|sgn-(?:BE-FR|BE-NL|CH-DE))$/i;
const grandfathered=new Set('art-lojban cel-gaulish en-gb-oed i-ami i-bnn i-default i-enochian i-hak i-klingon i-lux i-mingo i-navajo i-pwn i-tao i-tay i-tsu no-bok no-nyn sgn-be-fr sgn-be-nl sgn-ch-de zh-guoyu zh-hakka zh-min zh-min-nan zh-xiang'.split(' '));
function languageTag(tag){if(!locale.test(tag))return false;try{Intl.getCanonicalLocales(tag);return true;}catch{return /^x-/i.test(tag)||grandfathered.has(tag.toLowerCase());}}
function effects(value){
 exact(value,['read','write']);
 for(const mode of ['read','write']){
  const map=value[mode];if(!object(map)||!own(map,'en')||Object.keys(map).length>8)fail('invalid_bus');
  const seen=new Set();for(const [tag,text] of Object.entries(map)){const key=tag.toLowerCase();if(!languageTag(tag)||seen.has(key)||typeof text!=='string'||!text.trim()||[...text].length>200||/[\u0000-\u001f\u007f]/.test(text))fail('invalid_bus');seen.add(key);}
 }
}
function payloadSchema(schema,depth=1,budget={properties:0}){
 exact(schema,SCHEMA_KEYS);if(depth>6)fail('invalid_bus_schema');
 const types=Array.isArray(schema.type)?schema.type:[schema.type];if(!types.length||new Set(types).size!==types.length||types.some(type=>!TYPES.includes(type)))fail('invalid_bus_schema');
 if(own(schema,'enum')&&(!Array.isArray(schema.enum)||!schema.enum.length||schema.enum.length>64||new Set(schema.enum.map(canonical)).size!==schema.enum.length))fail('invalid_bus_schema');
 if(types.includes('object')&&schema.additionalProperties!==false)fail('invalid_bus_schema');
 if(own(schema,'additionalProperties')&&schema.additionalProperties!==false)fail('invalid_bus_schema');
 if(own(schema,'properties')){
  if(!object(schema.properties))fail('invalid_bus_schema');budget.properties+=Object.keys(schema.properties).length;if(budget.properties>128)fail('invalid_bus_schema');
  for(const child of Object.values(schema.properties))payloadSchema(child,depth+1,budget);
 }
 if(own(schema,'required')){if(!Array.isArray(schema.required)||new Set(schema.required).size!==schema.required.length||schema.required.some(key=>typeof key!=='string'||!own(schema.properties,key)))fail('invalid_bus_schema');}
 if(types.includes('array')&&(!own(schema,'items')||!integer(schema.maxItems,0,256)))fail('invalid_bus_schema');
 if(own(schema,'maxItems')&&!integer(schema.maxItems,0,256))fail('invalid_bus_schema');if(own(schema,'items'))payloadSchema(schema.items,depth+1,budget);
 if(types.includes('string')&&!integer(schema.maxLength,0,4096))fail('invalid_bus_schema');
 if(own(schema,'maxLength')&&!integer(schema.maxLength,0,4096)||own(schema,'format')&&!['uri','date-time','uuid'].includes(schema.format))fail('invalid_bus_schema');
 for(const key of ['minimum','maximum','multipleOf'])if(own(schema,key)&&(!Number.isFinite(schema[key])||types.includes('integer')&&Math.abs(schema[key])>Number.MAX_SAFE_INTEGER||key==='multipleOf'&&schema[key]<=0))fail('invalid_bus_schema');
 if(own(schema,'minimum')&&own(schema,'maximum')&&schema.minimum>schema.maximum)fail('invalid_bus_schema');
 // Values of enum/const are JSON literals, not schema nodes; the same depth/property
 // budget does not apply to them. The complete document remains bounded to 16 KiB.
 for(const value of [...schema.enum??[],...own(schema,'const')?[schema.const]:[]])if(types.includes('integer')&&typeof value==='number'&&Number.isInteger(value)&&!Number.isSafeInteger(value))fail('invalid_bus_schema');
}

// Adapt only critical-member recognition for the inherited checks. Keep the original
// document in results and digests: the shadow is never pinned or returned as a bus.
export function validateBusManifest(schema,url=schema?.id,{contracts={}}={}){
 const shadow=structuredClone(schema),slot=shadow?.slot,critical=slot?.crit;
 if(object(slot)&&Array.isArray(critical))slot.crit=critical.filter(key=>key!=='bus');
 const base=validateSlotManifest(shadow,url,{contracts}),fragment=base.schema;
 if(object(fragment.slot)&&Array.isArray(critical))fragment.slot.crit=structuredClone(critical);
 if(base.status!=='valid')return {status:base.status,schema:fragment,...base.reason?{reason:base.reason}:{}};
 if(!own(fragment.slot,'bus')&&!critical?.includes('bus'))return {status:'absent',schema:fragment};
 try{
  if(bytes(fragment)>16384||!Array.isArray(critical)||!critical.includes('bus')||new Set(critical).size!==critical.length||fragment.slot.selection!=='exclusive'||Object.keys(fragment.fields).length!==1)fail('invalid_bus');
  const field=fragment.fields[fragment.slot.field],bus=fragment.slot.bus;if(field.contracts.length!==1||field.contracts[0]!==EVENT_BUS_CONTRACT)fail('invalid_bus');exact(bus,BUS_KEYS);
  if(bus.v!==1)fail('invalid_bus_version');strings(bus.types,32);if(!bus.types.length||bus.types.some(type=>!/^[a-z][a-z0-9.-]{0,47}$/.test(type)))fail('invalid_bus');
  payloadSchema(bus.payload);if(!integer(bus.max_record_bytes,64,16384))fail('invalid_bus');
  exact(bus.retention,['min_seconds','max_seconds']);if(!integer(bus.retention.max_seconds,1,2592000)||!integer(bus.retention.min_seconds,0,bus.retention.max_seconds))fail('invalid_bus');
  subset(bus.publishers);subset(bus.readers);if(bus.readers.some(kind=>!fragment.slot.consumers.includes(kind)))fail('invalid_bus');
  if(bus.history!==undefined&&!['never','owner-choice'].includes(bus.history))fail('invalid_bus');if(bus.categories!==undefined)strings(bus.categories);effects(bus.effects);
  return {status:'valid',schema:fragment,slot:structuredClone(fragment.slot),bus:structuredClone(bus),harmless:base.harmless};
 }catch(error){if(!error.code)throw error;return {status:'invalid',schema:fragment,reason:error.code};}
}

// Same immutable ordinary-fragment namespace and trusted fetch boundary as slots.
// No bus, occupant, grant, route or capability declaration is created by a pin.
export async function pinBusManifest(options,url,expectedDigest){
 if(expectedDigest!==undefined)validateExtensionDigest(expectedDigest);
 const pin=await pinSchema({...options,schemaFetcher:typeof options.schemaFetcher==='function'?async target=>{
  const schema=structuredClone(await options.schemaFetcher(target));if(validateBusManifest(schema,target,{contracts:options.contracts}).status!=='valid')fail('unsupported_fragment');
  if(expectedDigest!==undefined&&await slotDigest(options.crypto,schema)!==expectedDigest)fail('digest_mismatch');return schema;
 }:undefined},url);
 return {...pin,digest:'sha256-'+pin.digest};
}
export function createEventBusesProvider(options={}){return Object.freeze({validate:input=>validateBusManifest(input.schema,input.url??input.schema?.id,{contracts:options.contracts}),pin:input=>pinBusManifest(options,input.url,input.digest)});}
function enabled(config){if(config?.EVENT_BUSES_ENABLED!==true&&config?.EVENT_BUSES_ENABLED!=='true')fail('event_buses_disabled');}
export class BusManifest extends AppQuery {static operation='events.manifest';static deps=['config','eventBuses'];fetch({config,eventBuses}){enabled(config);return eventBuses.validate(this.input);}}
export class PinBusManifest extends AppAction {static operation='events.pin';static deps=['config','eventBuses'];run({config,eventBuses}){enabled(config);return eventBuses.pin(this.input);}}
