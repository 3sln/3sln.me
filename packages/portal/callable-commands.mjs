// Opt-in host adapter, not an app registry or authorization service. All ports
// below are trusted host code. Descriptor data never contributes executable code.
import {canonical} from '../core/primitives.mjs';
const own=(value,key)=>Object.hasOwn(value,key);
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const forbiddenKeys=new Set(['__proto__','prototype','constructor']);
const fieldName=name=>typeof name==='string'&&/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)&&!forbiddenKeys.has(name);
const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
function data(value,maxBytes=65536){
 let nodes=0;
 function copy(input,depth){
  if(++nodes>4096||depth>12)fail('unsupported_descriptor','Data exceeds the supported bounds.');
  if(input===null||typeof input==='boolean'||typeof input==='number'&&Number.isFinite(input))return input;
  if(typeof input==='string'){if(input.length>65536)fail('unsupported_descriptor','String exceeds the supported bounds.');return input;}
  if(typeof input!=='object'||![Object.prototype,null,Array.prototype].includes(Object.getPrototypeOf(input)))fail('unsupported_descriptor','Only inert JSON data is supported.');
  const array=Array.isArray(input);if(array&&(input.length>4096||Object.keys(input).length!==input.length))fail('unsupported_descriptor','Arrays must be dense and bounded.');const result=array?[]:{};
  for(const key of Reflect.ownKeys(input)){if(key==='length'&&Array.isArray(input))continue;const property=Object.getOwnPropertyDescriptor(input,key);if(typeof key!=='string'||array&&!/^(0|[1-9][0-9]*)$/.test(key)||forbiddenKeys.has(key)||!property.enumerable||!own(property,'value'))fail('unsupported_descriptor','Only plain data properties are supported.');result[key]=copy(property.value,depth+1);}
  return result;
 }
 const result=copy(value,0);if(new TextEncoder().encode(JSON.stringify(result)).length>maxBytes)fail('unsupported_descriptor','Data exceeds the supported byte limit.');return result;
}
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function exact(value,keys){if(!object(value)||Object.keys(value).some(key=>!keys.includes(key)))fail('unsupported_descriptor','Unexpected descriptor fields.');}
function text(value,max,optional=false){if(optional&&value===undefined)return;if(typeof value!=='string'||!value.trim()||value.length>max||/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(value))fail('unsupported_descriptor','Bounded plain text is required.');}
function url(value){text(value,2048);try{const parsed=new URL(value);if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.hash||parsed.href!==value)throw Error();}catch{fail('unsupported_descriptor','A canonical HTTPS identity is required.');}}
function scalar(value,schema){
 if(schema.type==='string')return typeof value==='string'&&value.length>=(schema.minLength??0)&&value.length<=schema.maxLength;
 if(schema.type==='boolean')return typeof value==='boolean';
 return typeof value==='number'&&Number.isFinite(value)&&value>=schema.minimum&&value<=schema.maximum&&(schema.type!=='integer'||Number.isSafeInteger(value));
}
function schema(input){
 exact(input,['type','properties','required','additionalProperties']);
 if(input.type!=='object'||input.additionalProperties!==false||!object(input.properties)||Object.keys(input.properties).length>16)fail('unsupported_schema','Use a strict object with at most sixteen scalar fields.');
 if(!Array.isArray(input.required)||new Set(input.required).size!==input.required.length||input.required.some(name=>typeof name!=='string'||!own(input.properties,name)))fail('unsupported_schema','Required fields must name existing properties.');
 for(const [name,field]of Object.entries(input.properties)){
  if(!fieldName(name))fail('unsupported_schema','Unsupported argument name.');
  exact(field,['type','enum','minLength','maxLength','minimum','maximum']);
  if(!['string','boolean','integer','number'].includes(field.type))fail('unsupported_schema','Only bounded scalar arguments are supported.');
  if(field.type==='string'){
   if(!Number.isSafeInteger(field.maxLength)||field.maxLength<1||field.maxLength>4096||field.minLength!==undefined&&(!Number.isSafeInteger(field.minLength)||field.minLength<0||field.minLength>field.maxLength)||field.minimum!==undefined||field.maximum!==undefined)fail('unsupported_schema','String arguments require explicit length bounds.');
  }else if(field.type==='boolean'){
   if(['minLength','maxLength','minimum','maximum'].some(key=>own(field,key)))fail('unsupported_schema','Boolean arguments cannot use numeric or string bounds.');
  }else if(!Number.isFinite(field.minimum)||!Number.isFinite(field.maximum)||field.minimum>field.maximum||Math.max(Math.abs(field.minimum),Math.abs(field.maximum))>Number.MAX_SAFE_INTEGER||field.type==='integer'&&(!Number.isSafeInteger(field.minimum)||!Number.isSafeInteger(field.maximum))||field.minLength!==undefined||field.maxLength!==undefined)fail('unsupported_schema','Numeric arguments require explicit finite bounds.');
  if(field.enum!==undefined&&(!Array.isArray(field.enum)||!field.enum.length||field.enum.length>32||new Set(field.enum).size!==field.enum.length||field.enum.some(value=>!scalar(value,field))))fail('unsupported_schema','An enumeration must contain distinct values matching its field.');
 }
}
function descriptor(value){
 const result=data(value,32768);exact(result,['resource','contract','method','revision','inputSchema','effects','userCommand']);url(result.resource);url(result.contract);if(!fieldName(result.method))fail('unsupported_descriptor','A fixed method identifier is required.');text(result.revision,128);schema(result.inputSchema);
 exact(result.effects,['readOnly','requiresConfirmation']);if(typeof result.effects.readOnly!=='boolean'||typeof result.effects.requiresConfirmation!=='boolean'||!result.effects.readOnly&&!result.effects.requiresConfirmation)fail('unsupported_descriptor','Reviewed effects and confirmation policy are required.');
 if(result.userCommand!==undefined){const command=result.userCommand;exact(command,['label','description','argumentHints']);text(command.label,100);text(command.description,500,true);if(command.argumentHints!==undefined){if(!object(command.argumentHints)||Object.keys(command.argumentHints).length>16)fail('unsupported_descriptor','Argument hints must be a bounded object.');for(const[name,hint]of Object.entries(command.argumentHints)){if(!own(result.inputSchema.properties,name))fail('unsupported_descriptor','A hint cannot introduce an argument.');exact(hint,['label','description']);text(hint.label,100,true);text(hint.description,300,true);}}}
 return freeze(result);
}
const semantic=({resource,contract,method,revision,inputSchema,effects})=>({resource,contract,method,revision,inputSchema,effects});
function argumentsFor(value,inputSchema){const args=data(value);if(!object(args)||Object.keys(args).some(name=>!own(inputSchema.properties,name))||inputSchema.required.some(name=>!own(args,name)))fail('invalid_args','Arguments must match the approved fields.');for(const[name,item]of Object.entries(args)){const field=inputSchema.properties[name];if(!scalar(item,field)||field.enum&&!field.enum.includes(item))fail('invalid_args','An argument violates the approved type or bounds.');}return freeze(args);}
const active=signal=>{if(signal?.aborted)fail('canceled','The invocation was canceled; already accepted effects may finish.');};
function immutableCaller(caller){
 if(typeof caller==='symbol'||typeof caller==='bigint')return;
 if(caller===null||caller===undefined)fail('invalid_context','An immutable original caller is required.');
 try{data(caller,16384);}catch{fail('invalid_context','Caller records must contain bounded inert data.');}
 function check(value){if(value&&typeof value==='object'){if(!Object.isFrozen(value))fail('invalid_context','Caller records must be deeply frozen before invocation.');for(const property of Object.values(Object.getOwnPropertyDescriptors(value)))if(own(property,'value'))check(property.value);}}
 check(caller);
}

class CallableBinding {
 constructor({descriptor:input,resolveBinding,dispatch,review}){
  if(typeof resolveBinding!=='function'||typeof dispatch!=='function'||review!==undefined&&typeof review!=='function')throw new TypeError('Trusted binding-resolution and dispatch ports are required.');
  const pinned=descriptor(input),fingerprint=canonical(semantic(pinned));
  this.identity=freeze({resource:pinned.resource,contract:pinned.contract,method:pinned.method,revision:pinned.revision});
  this.inputSchema=pinned.inputSchema;this.effects=pinned.effects;this.userCommand=pinned.userCommand;
  this.invoke=async(args,context)=>{
   if(!object(context)||!Object.isFrozen(context)||!own(Object.getOwnPropertyDescriptor(context,'caller')??{},'value')||!own(Object.getOwnPropertyDescriptor(context,'transactionId')??{},'value')||own(context,'signal')&&!own(Object.getOwnPropertyDescriptor(context,'signal'),'value')||typeof context.transactionId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(context.transactionId))fail('invalid_context','A frozen original caller context and transaction UUID are required.');
   immutableCaller(context.caller);
   const input=argumentsFor(args,pinned.inputSchema),request=freeze({binding:semantic(pinned),args:input,transactionId:context.transactionId});
   const verify=async()=>{active(context.signal);const current=await resolveBinding(this.identity,context);active(context.signal);if(!current||canonical(semantic(descriptor(current)))!==fingerprint)fail('binding_changed','The approved callable binding is unavailable or has changed.');};
   await verify();
   if(pinned.effects.requiresConfirmation){if(!review||await review(request,context)!==true)fail('confirmation_required','Approve the exact inputs before this action.');await verify();}
   active(context.signal);
   // Dispatcher authenticates THIS original context, atomically checks live
   // grants/source and the pinned binding at dispatch, and owns the existing
   // journal, replay and confirmation receipt. It MUST reauthorize private and
   // cached results before returning them; resolver checks cannot do that.
   // This projection neither mints authority nor converts a caller to the owner.
   const result=await dispatch(request,context);active(context.signal);return freeze(data(result));
  };
  Object.freeze(this);
 }
}

/** Transport-neutral pinned method; no user-command metadata is required. */
export const createCallableBinding=options=>new CallableBinding(options);

/** Curated host selection. Returned text is inert data, never HTML or code. */
export function projectUserCommand(callable,{enabled=false}={}){
 if(!(callable instanceof CallableBinding))throw new TypeError('A host-created callable binding is required.');
 if(enabled!==true||!callable.userCommand)return null;
 const {identity,userCommand,inputSchema}=callable;
 return Object.freeze({id:`callable:${encodeURIComponent(identity.resource)}:${encodeURIComponent(identity.contract)}:${identity.method}:${encodeURIComponent(identity.revision)}`,label:userCommand.label,description:userCommand.description??'',identity,effects:callable.effects,fields:freeze(Object.entries(inputSchema.properties).map(([name,type])=>({name,...type,required:inputSchema.required.includes(name),...userCommand.argumentHints?.[name]}))),invoke:callable.invoke});
}

/** Trusted opt-in composition into existing portal commands. contextFrom is
 * host code using leased resources, never a callback from imported metadata.
 * Portals without an authority provider must leave these commands uninstalled.
 */
export function portalCallableCommand(command,{id=command?.id,capability,deps,contextFrom}={}){
 if(!command||typeof command.invoke!=='function'||typeof id!=='string'||!id||typeof capability!=='string'||!capability||!object(deps)||typeof contextFrom!=='function')throw new TypeError('A projected command and explicit trusted host authority composition are required.');
 return Object.freeze({id,title:command.label,description:command.description,capability,deps:freeze(data(deps)),execute:async(resources,detail,execution)=>command.invoke(detail.args,await contextFrom(resources,execution))});
}
