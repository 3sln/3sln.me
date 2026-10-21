// Record validation against a pinned bus payload schema (docs/spec/events.md §2.2, §4.1). The schema itself was
// validated by EV-1 (packages/federation/event-buses.mjs): only the subset keywords exist, every string and array is
// bounded and depth is at most 6, so this walk is bounded by the schema. No regular expression comes from a manifest.
import {canonical} from '../core/primitives.mjs';

const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const DATE_TIME=/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])[Tt]([01]\d|2[0-3]):[0-5]\d:([0-5]\d|60)(\.\d{1,9})?([Zz]|[+-]([01]\d|2[0-3]):[0-5]\d)$/;
const UUIDISH=/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
export const jsonBytes=value=>new TextEncoder().encode(JSON.stringify(value)).length;
function typed(type,value){
 switch(type){
  case 'null':return value===null;case 'boolean':return typeof value==='boolean';case 'string':return typeof value==='string';
  case 'integer':return Number.isSafeInteger(value);case 'number':return typeof value==='number'&&Number.isFinite(value)&&(!Number.isInteger(value)||Number.isSafeInteger(value));
  case 'array':return Array.isArray(value);case 'object':return plain(value);default:return false;
 }
}
function format(kind,value){
 if(kind==='uuid')return UUIDISH.test(value);
 if(kind==='date-time')return DATE_TIME.test(value)&&!Number.isNaN(Date.parse(value.replace(/:60(\.|[Zz+-])/,':59$1')));
 if(kind==='uri'){try{const url=new URL(value);return url.protocol==='https:'&&url.href.length<=4096&&!/[\u0000- \u007f]/.test(value);}catch{return false;}}
 return false;
}
const multiple=(value,step)=>{const ratio=value/step;return Number.isFinite(ratio)&&Math.abs(ratio-Math.round(ratio))<=1e-9*Math.max(1,Math.abs(ratio));};
/** True when `value` satisfies `schema`. Strings count code points (JSON Schema `maxLength`). */
export function conforms(schema,value){
 const types=Array.isArray(schema.type)?schema.type:[schema.type];
 if(!types.some(type=>typed(type,value)))return false;
 if(Object.hasOwn(schema,'const')&&canonical(schema.const)!==canonical(value))return false;
 if(Object.hasOwn(schema,'enum')&&!schema.enum.some(member=>canonical(member)===canonical(value)))return false;
 if(typeof value==='string'){if(Object.hasOwn(schema,'maxLength')&&[...value].length>schema.maxLength)return false;if(schema.format&&!format(schema.format,value))return false;}
 if(typeof value==='number'){
  if(Object.hasOwn(schema,'minimum')&&value<schema.minimum||Object.hasOwn(schema,'maximum')&&value>schema.maximum)return false;
  if(Object.hasOwn(schema,'multipleOf')&&!multiple(value,schema.multipleOf))return false;
 }
 if(Array.isArray(value)){if(value.length>(schema.maxItems??0))return false;if(schema.items&&!value.every(item=>conforms(schema.items,item)))return false;}
 if(plain(value)){
  const properties=plain(schema.properties)?schema.properties:{};
  if(schema.additionalProperties===false&&Object.keys(value).some(name=>!Object.hasOwn(properties,name)))return false;
  if(Array.isArray(schema.required)&&schema.required.some(name=>!Object.hasOwn(value,name)))return false;
  for(const [name,child]of Object.entries(properties))if(Object.hasOwn(value,name)&&!conforms(child,value[name]))return false;
 }
 return true;
}
/** `{type, data}` for a publish, or a `reason` code. The size bound is the smaller of the manifest and host limits. */
export function checkRecord(spec,{type,data},hostMax){
 if(typeof type!=='string'||!spec.types.includes(type))return {ok:false,reason:'unknown_type'};
 let size;try{size=jsonBytes(data);}catch{return {ok:false,reason:'invalid_data'};}
 if(data===undefined||size>Math.min(spec.max_record_bytes,hostMax))return {ok:false,reason:'record_too_large'};
 if(!conforms(spec.payload,data))return {ok:false,reason:'schema_mismatch'};
 return {ok:true,bytes:size};
}
