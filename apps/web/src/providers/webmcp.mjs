// Browser-native tool registration is an active-page affordance, never a new
// bearer credential. Callbacks route through the portal's owner checks.
export function browserModelContext(document=globalThis.document,navigator=globalThis.navigator){return document?.modelContext??navigator?.modelContext??null;}
const immutable=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(immutable);Object.freeze(value);}return value;};
export class BrowserAutomationAdapter{
 constructor({document=globalThis.document,navigator=globalThis.navigator,invoke,confirm,current=()=>true}){Object.assign(this,{context:browserModelContext(document,navigator),invoke,confirm,current});this.generation=0;this.names=[];this.controller=null;this.pending=Promise.resolve();}
 get supported(){return typeof this.context?.registerTool==='function';}
 async enable(tools){
  this.disable();const requested=this.generation;
  const run=this.pending.catch(()=>{}).then(()=>this.register(tools,requested));this.pending=run;return run;
 }
 async register(tools,requested){
  if(requested!==this.generation)throw Error('Browser automation was disabled.');if(!this.supported)throw Error('Browser automation is not supported by this browser.');
  const generation=this.generation,controller=new AbortController();this.controller=controller;
  try{for(const tool of tools){
   if(!this.current()||generation!==this.generation)throw Error('Browser automation was disabled.');
   const definition={name:tool.name,description:tool.label,inputSchema:tool.inputSchema,annotations:{readOnlyHint:tool.readOnly,consequentialHint:!tool.readOnly,untrustedContentHint:true},execute:async(input,client)=>{
    const args=immutable(structuredClone(input));
    const signal=client?.signal?AbortSignal.any([controller.signal,client.signal]):controller.signal;
    const live=()=>this.current()&&generation===this.generation&&!controller.signal.aborted&&!client?.signal?.aborted;
    if(!live())throw Error('Browser automation was disabled.');
    // Browser-provided annotations are hints, not authorization. The portal
    // owns this confirmation; no browser caller identity is asserted.
    if(!tool.readOnly&&(!this.confirm||!await this.confirm({tool:tool.name,args,signal})))throw Error('The owner declined this action.');
    if(!live())throw Error('Browser automation was disabled.');
    const result=await this.invoke(tool.name,args,{signal});
    if(!live())throw Error('Browser automation was disabled.');
    return {content:[{type:'text',text:JSON.stringify(result)}]};
   }};
   await this.context.registerTool(definition,{signal:controller.signal});this.names.push(tool.name);
   if(generation!==this.generation){this.context.unregisterTool?.(tool.name);throw Error('Browser automation was disabled.');}
  }}catch(error){if(generation===this.generation)this.disable();throw error;}
 }
 disable(){this.generation++;this.controller?.abort();this.controller=null;for(const name of this.names){try{this.context?.unregisterTool?.(name);}catch{}}this.names=[];}
 dispose(){this.disable();}
}
