// Pure, self-contained functions also embedded in the isolated renderer. Both
// parsers project HTML into these plain records before computing the digest.
export function normalizeMessageForm(raw,origin){
 const invalid=()=>{throw new Error('Unsupported message form');};
 if(!raw||typeof raw!=='object'||!Array.isArray(raw.controls)||raw.controls.length>64)invalid();
 let base,url;try{base=new URL(origin);url=new URL(raw.action??'',base);}catch{invalid();}
 if(base.protocol!=='https:'||base.origin!==origin||url.protocol!=='https:'||url.origin!==origin||url.username||url.password||url.hash||url.href.length>2048)invalid();
 const method=String(raw.method??'get').toUpperCase(),enctype=String(raw.enctype??'application/x-www-form-urlencoded').toLowerCase();if(String(raw.target??'').toLowerCase()==='_blank'||method!=='POST'||enctype!=='application/x-www-form-urlencoded'||raw.externalAssociation||raw.overrides)invalid();
 const controls=[],names=new Set();for(const entry of raw.controls){
  const tag=String(entry.tag??'').toLowerCase(),type=tag==='input'?String(entry.type??'text').toLowerCase():tag==='button'?String(entry.type??'submit').toLowerCase():tag;
  if(!['input','button','textarea','select'].includes(tag)||tag==='input'&&!['text','email','url','number','date','time','datetime-local','checkbox','radio','hidden','submit'].includes(type)||tag==='button'&&!['submit','button','reset'].includes(type)||entry.externalAssociation||entry.overrides)invalid();
  if(entry.disabled||tag==='button'&&type!=='submit')continue;const name=entry.name??'';if(!name&&(type==='submit'))continue;
  if(typeof name!=='string'||!name||name.length>100||/[\u0000-\u001f\u007f]/.test(name)||names.has(name))invalid();names.add(name);
  let value=entry.value??(['checkbox','radio'].includes(type)?'on':'');if(typeof value!=='string'||value.length>4096)invalid();
  const control={tag,type,name,...['hidden','checkbox','radio','submit'].includes(type)?{value}:{}};
  if(tag==='select'){if(!Array.isArray(entry.options)||entry.options.length>128)invalid();control.multiple=entry.multiple===true;control.options=entry.options.filter(o=>!o.disabled).map(o=>{if(typeof o.value!=='string'||o.value.length>4096)invalid();return o.value;});if(new Set(control.options).size!==control.options.length)invalid();}
  controls.push(control);
 }
 return {version:1,url:url.href,method,enctype,disposition:'message',controls};
}
export function messageFormFingerprint(form){return JSON.stringify(form);}
export function validateMessageFormFields(form,fields){
 const invalid=()=>{throw new Error('Invalid message form fields');};if(!Array.isArray(fields)||fields.length>64)invalid();const pairs=fields.map(pair=>{if(!Array.isArray(pair)||pair.length!==2||pair.some(v=>typeof v!=='string')||pair[0].length>100||pair[1].length>4096)invalid();return [...pair];});if(new TextEncoder().encode(JSON.stringify(pairs)).length>16384)invalid();
 const seen=new Map();for(const [name,value]of pairs){const c=form.controls.find(c=>c.name===name);if(!c)invalid();const count=(seen.get(name)||0)+1;seen.set(name,count);if(count>1&&!(c.tag==='select'&&c.multiple))invalid();if(['hidden','checkbox','radio','submit'].includes(c.type)&&value!==c.value||c.tag==='select'&&!c.options.includes(value))invalid();}
 if(form.controls.filter(c=>c.type==='submit'&&seen.has(c.name)).length>1)invalid();for(const c of form.controls)if(!['checkbox','radio','submit'].includes(c.type)&&!seen.has(c.name)&&!(c.tag==='select'&&c.multiple))invalid();
 const body=new URLSearchParams(pairs).toString();if(new TextEncoder().encode(body).length>16384)invalid();return body;
}
