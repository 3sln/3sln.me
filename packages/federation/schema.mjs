import { canonical, digest, boundedString } from '../messaging/store.mjs';
export class FederationFault extends Error { constructor(code,message=code){super(message);this.name='FederationFault';this.code=code;} }
export const fail=(code,message)=>{throw new FederationFault(code,message);};
export const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
export function exact(value,keys){if(!object(value)||Object.keys(value).some(key=>!keys.includes(key)))fail('invalid_args','Unexpected fields.');}
export function https(value){try{const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password||url.hash||url.href!==value&&url.origin!==value)fail('invalid_args','Canonical HTTPS URL required.');return url;}catch{fail('invalid_args','Canonical HTTPS URL required.');}}
export function strings(value,max=64){if(!Array.isArray(value)||value.length>max||new Set(value).size!==value.length||value.some(x=>!boundedString(x,2048)))fail('invalid_args','Bounded distinct strings required.');return value;}
export function validateSchema(schema,url){
  exact(schema,['id','title','description','publisher','fields']);if(schema.id!==url||!boundedString(schema.title,200)||!boundedString(schema.description,2000))fail('invalid_schema');https(schema.publisher);
  if(!object(schema.fields)||!Object.keys(schema.fields).length||Object.keys(schema.fields).length>32)fail('invalid_schema');
  for(const [name,field] of Object.entries(schema.fields)){
    if(!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name))fail('invalid_schema');
    exact(field,['title','description','type','cardinality','contracts','values','minLength','maxLength','minimum','maximum']);
    if(!boundedString(field.title,200)||field.description!==undefined&&!boundedString(field.description,1000)||!['string','boolean','integer','number','enum','url','resource'].includes(field.type))fail('invalid_schema');
    const cardinality=field.cardinality??{min:1,max:1};exact(cardinality,['min','max']);if(!Number.isSafeInteger(cardinality.min)||!Number.isSafeInteger(cardinality.max)||cardinality.min<0||cardinality.max<1||cardinality.max>16||cardinality.min>cardinality.max)fail('invalid_schema');
    if(field.type==='resource'){strings(field.contracts,16);if(!field.contracts.length)fail('invalid_schema');field.contracts.forEach(https);}
    else if(field.contracts!==undefined)fail('invalid_schema');
    if(field.type==='enum'){strings(field.values,32);if(!field.values.length)fail('invalid_schema');}else if(field.values!==undefined)fail('invalid_schema');
    if(['string','url'].includes(field.type)){if(!Number.isSafeInteger(field.maxLength)||field.maxLength<1||field.maxLength>2048||field.minLength!==undefined&&(!Number.isSafeInteger(field.minLength)||field.minLength<0||field.minLength>field.maxLength))fail('invalid_schema');}
    else if(field.minLength!==undefined||field.maxLength!==undefined)fail('invalid_schema');
    if(['integer','number'].includes(field.type)){if(!Number.isFinite(field.minimum)||!Number.isFinite(field.maximum)||field.minimum>field.maximum||Math.abs(field.minimum)>Number.MAX_SAFE_INTEGER||Math.abs(field.maximum)>Number.MAX_SAFE_INTEGER)fail('invalid_schema');}else if(field.minimum!==undefined||field.maximum!==undefined)fail('invalid_schema');
  }
  return structuredClone(schema);
}
export function validateValue(field,value,validateURL=https){
  const {min,max}=field.cardinality??{min:1,max:1};const values=max===1?[value]:value;if(!Array.isArray(values)||values.length<min||values.length>max)fail('invalid_preferences');
  for(const item of values){const type=field.type;
    if(type==='resource'||type==='url')validateURL(item);
    if(type==='string'||type==='url'){if(typeof item!=='string'||item.length<(field.minLength??0)||item.length>field.maxLength||/[\u0000-\u001f\u007f]/.test(item))fail('invalid_preferences');}
    if(type==='boolean'&&typeof item!=='boolean'||type==='enum'&&!field.values.includes(item))fail('invalid_preferences');
    if(['integer','number'].includes(type)&&(!Number.isFinite(item)||Math.abs(item)>Number.MAX_SAFE_INTEGER||item<field.minimum||item>field.maximum||type==='integer'&&!Number.isSafeInteger(item)))fail('invalid_preferences');
  }
  if(typeResource(field)&&new Set(values).size!==values.length)fail('invalid_preferences');return values;
}
const typeResource=field=>field.type==='resource';
export async function pinSchema({store,crypto,schemaFetcher,schemaHosts},url){
  const host=https(url).host;if(!schemaHosts.includes(host)||typeof schemaFetcher!=='function')fail('untrusted_schema_host');
  // The fetcher is a trusted runtime capability: it must reject redirects and
  // private-address DNS results before making a request. No ambient fetch here.
  const schema=await schemaFetcher(url);const encoded=canonical(schema);if(new TextEncoder().encode(encoded).length>65536)fail('invalid_schema');validateSchema(schema,url);const hash=await digest(crypto,encoded);
  return store.transaction(async tx=>{const old=await tx.get(`federation/schema/${url}`);if(old&&old.digest!==hash)fail('schema_changed','Immutable fragment changed; use a new URL.');const record={schema,digest:hash};if(!old)await tx.set(`federation/schema/${url}`,record);return record;});
}
