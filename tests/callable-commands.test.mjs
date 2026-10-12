import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID,webcrypto} from 'node:crypto';
import {Engine,Provider} from '../vendor/ngin/index.js';
import {compilePortalModules,RunPortalCommand} from '../packages/portal/index.mjs';
import {createCallableBinding,projectUserCommand,portalCallableCommand} from '../packages/portal/callable-commands.mjs';
import {FederationController,MemoryFederationStore} from '../packages/federation/index.mjs';

const issuer='https://provider.example',subject=`${issuer}/entities/alice`,resource=`${issuer}/resources/notebook`,contract='https://spec.bindle.example/contracts/notebook/v1';
const field={type:'string',minLength:1,maxLength:100};
const readDescriptor=()=>({resource,contract,method:'get',revision:'native-notebook-v1',inputSchema:{type:'object',properties:{key:{...field}},required:['key'],additionalProperties:false},effects:{readOnly:true,requiresConfirmation:false},userCommand:{label:'Read note',description:'Read a note from this notebook.',argumentHints:{key:{label:'Note name'}}}});
const writeDescriptor=()=>({...readDescriptor(),method:'put',inputSchema:{type:'object',properties:{key:{...field},value:{type:'string',maxLength:4096},version:{type:'integer',minimum:1,maximum:1000000}},required:['key','value','version'],additionalProperties:false},effects:{readOnly:false,requiresConfirmation:true},userCommand:{label:'Update note',argumentHints:{key:{label:'Note name'},value:{label:'Contents'},version:{label:'Reviewed version'}}}});
const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
const context=(caller={},tx=randomUUID(),signal)=>Object.freeze({caller:freeze(caller),transactionId:tx,...signal?{signal}:{}});
const simple=(descriptor,ports={})=>createCallableBinding({descriptor,resolveBinding:async()=>descriptor,dispatch:async request=>({args:request.args}),...ports});

test('callable identity works without presentation; human commands require explicit curated opt-in',async()=>{
 const descriptor=readDescriptor();delete descriptor.userCommand;const callable=simple(descriptor);
 assert.deepEqual(await callable.invoke({key:'one'},context()),{args:{key:'one'}});assert.equal(projectUserCommand(callable,{enabled:true}),null);
 const presented=simple(readDescriptor());assert.equal(projectUserCommand(presented),null);const command=projectUserCommand(presented,{enabled:true});assert.equal(command.label,'Read note');assert.deepEqual(command.fields,[{name:'key',...field,required:true,label:'Note name'}]);assert.deepEqual(command.identity,{resource,contract,method:'get',revision:'native-notebook-v1'});assert.ok(Object.isFrozen(command.fields[0]));
});

test('descriptor metadata is inert, bounded and cannot introduce execution, schema features or hidden arguments',()=>{
 let getterCalls=0;const accessed=readDescriptor();Object.defineProperty(accessed.userCommand,'description',{enumerable:true,get(){getterCalls++;return 'bad';}});assert.throws(()=>simple(accessed),{code:'unsupported_descriptor'});assert.equal(getterCalls,0);
 for(const mutate of [d=>d.userCommand.execute=()=>{},d=>d.userCommand.argumentHints.key.default='secret',d=>d.userCommand.argumentHints.hidden={label:'Secret'},d=>d.inputSchema.properties.key.default='hidden',d=>d.inputSchema.properties.key={$ref:'https://schemas.example/input'},d=>d.inputSchema.properties.key={type:'array',items:field},d=>delete d.inputSchema.properties.key.maxLength,d=>d.inputSchema.additionalProperties=true,d=>delete d.effects,d=>d.effects.requiresConfirmation='yes',d=>d.userCommand.label='fake\u202eapproval']){const descriptor=readDescriptor();mutate(descriptor);assert.throws(()=>simple(descriptor));}
 const descriptor=readDescriptor();descriptor.userCommand.label='<script>Hostile label</script>';const projected=projectUserCommand(simple(descriptor),{enabled:true});assert.equal(projected.label,descriptor.userCommand.label);assert.equal(typeof projected.label,'string');assert.equal(Object.hasOwn(projected,'html'),false);
});

test('typed arguments validate again at invocation without coercion or app-supplied defaults',async()=>{
 const descriptor=readDescriptor();descriptor.inputSchema.properties.mode={type:'string',maxLength:8,enum:['small','large']};descriptor.inputSchema.properties.enabled={type:'boolean'};descriptor.inputSchema.properties.ratio={type:'number',minimum:0,maximum:1};const callable=simple(descriptor);
 for(const args of [{},{key:3},{key:'one',unknown:true},{key:'one',enabled:'true'},{key:'one',mode:'other'},{key:'one',ratio:2},{key:'one',ratio:NaN}])await assert.rejects(callable.invoke(args,context()));
 assert.deepEqual(await callable.invoke({key:'one',mode:'small',enabled:false,ratio:0.25},context()),{args:{key:'one',mode:'small',enabled:false,ratio:0.25}});
});

test('review and dispatch retain the exact immutable input and original caller context',async()=>{
 const descriptor=writeDescriptor(),originalArgs={key:'one',value:'approved',version:1},originalContext=context(Object.freeze({grant:'agent-read-only'}));let reviewed,dispatched;
 const callable=simple(descriptor,{resolveBinding:async(_,ctx)=>{assert.strictEqual(ctx,originalContext);return descriptor;},review:async(request,ctx)=>{reviewed=request;assert.strictEqual(ctx,originalContext);originalArgs.value='substituted';assert.throws(()=>{request.args.value='substituted';},TypeError);return true;},dispatch:async(request,ctx)=>{dispatched=request;assert.strictEqual(ctx,originalContext);return {value:request.args.value};}});
 assert.deepEqual(await callable.invoke(originalArgs,originalContext),{value:'approved'});assert.strictEqual(dispatched,reviewed);assert.strictEqual(originalContext.caller.grant,'agent-read-only');
 await assert.rejects(callable.invoke(originalArgs,{...originalContext}),{code:'invalid_context'});
 await assert.rejects(simple(descriptor,{review:async()=>({approved:true})}).invoke(originalArgs,context()),{code:'confirmation_required'});
});

test('caller credentials cannot be retargeted through a shallow-frozen invocation context',async()=>{
 const callable=simple(writeDescriptor(),{review:async()=>true});
 for(const caller of [{access_token:'agent'},Object.freeze({credentials:{access_token:'agent'}})])await assert.rejects(callable.invoke({key:'one',value:'two',version:1},Object.freeze({caller,transactionId:randomUUID()})),{code:'invalid_context'});
 let getterCalls=0;const accessor=Object.freeze({get caller(){getterCalls++;return 'owner';},transactionId:randomUUID()});await assert.rejects(callable.invoke({key:'one',value:'two',version:1},accessor),{code:'invalid_context'});assert.equal(getterCalls,0);
 const opaque=Symbol('host-owned caller');let seen;await simple(readDescriptor(),{dispatch:async(_,ctx)=>{seen=ctx.caller;return {};}}).invoke({key:'one'},context(opaque));assert.strictEqual(seen,opaque);
});

test('live route, schema, effects and revision changes cannot retarget a displayed command; cosmetics do not change authority',async()=>{
 for(const mutate of [d=>d.resource='https://provider.example/resources/other',d=>d.contract='https://spec.bindle.example/contracts/other/v1',d=>d.method='delete',d=>d.revision='v2',d=>d.inputSchema.properties.key.maxLength=101,d=>d.effects.requiresConfirmation=true]){const descriptor=readDescriptor(),callable=simple(descriptor);mutate(descriptor);await assert.rejects(callable.invoke({key:'one'},context()),{code:'binding_changed'});}
 const descriptor=readDescriptor(),callable=simple(descriptor);descriptor.userCommand.label='New label';assert.deepEqual(await callable.invoke({key:'one'},context()),{args:{key:'one'}});assert.equal(projectUserCommand(callable,{enabled:true}).label,'Read note');
 let dispatches=0;const write=writeDescriptor(),mutated=simple(write,{review:async()=>{write.revision='v2';return true;},dispatch:async()=>{dispatches++;return {};}});await assert.rejects(mutated.invoke({key:'one',value:'two',version:1},context()),{code:'binding_changed'});assert.equal(dispatches,0);
});

test('cancellation blocks later dispatch and rejects late results without fabricating rollback',async()=>{
 const controller=new AbortController();let dispatches=0;const callable=simple(writeDescriptor(),{review:async()=>{controller.abort();return true;},dispatch:async()=>{dispatches++;return {};}});await assert.rejects(callable.invoke({key:'one',value:'two',version:1},context({},randomUUID(),controller.signal)),{code:'canceled'});assert.equal(dispatches,0);
 const late=new AbortController(),read=simple(readDescriptor(),{dispatch:async()=>{late.abort();return {secret:'late result'};}});await assert.rejects(read.invoke({key:'one'},context({},randomUUID(),late.signal)),{code:'canceled'});
});

// Native fixture only: real FederationService grants and FederationController
// journal, injected owner authentication, and an in-memory transactional source.
// No app importer, production grant bridge, hosted state or remote provider.
async function fixture({uncertain=false}={}){
 const clientId='https://assistant.example/client',redirectUri='https://assistant.example/callback',fragment='https://schema.example/notebook/v1',owner=Object.freeze({sessionToken:'fixture-owner'}),store=new MemoryFederationStore();let writes=0,connected=true;
 const controller=new FederationController({issuer,crypto:webcrypto,metadata:store,clients:[{id:clientId,name:'Fixture assistant',origin:'https://assistant.example',redirectUris:[redirectUri]}],schemaHosts:['schema.example'],schemaFetcher:async()=>({id:fragment,title:'Notebook',description:'Choose a notebook',publisher:'https://schema.example',fields:{notebook:{title:'Notebook',type:'resource',contracts:[contract]}}}),auth:{owner:async caller=>{if(caller!==owner)throw Object.assign(Error('Owner authentication failed.'),{code:'unauthorized'});return {subject};}},dispatcher:{transactional:true,execute:async ctx=>{
  const key=`fixture/note/${ctx.subject}/${ctx.args.key}`,prior=await ctx.transaction.get(key)??{value:'Initial note',version:1};
  if(ctx.method==='get')return prior;if(ctx.method!=='put')throw Object.assign(Error('Unsupported method'),{code:'unsupported_method'});if(ctx.args.version!==prior.version)throw Object.assign(Error('Version changed'),{code:'conflict'});writes++;const next={value:ctx.args.value,version:prior.version+1};await ctx.transaction.set(key,next);if(uncertain)throw Error('Uncertain effect after accepted write');return next;
 }}});
 await controller.registerResource(owner,{id:resource,label:'Notebook',contracts:{[contract]:['get','put']}});await controller.configure(owner,{fragment,values:{notebook:resource}});
 async function assistant(methods){const verifier='v'.repeat(43),{requestId}=await controller.beginAuthorization({clientId,redirectUri,challenge:createHash('sha256').update(verifier).digest('base64url'),challengeMethod:'S256',state:'fixture-state',requests:[{fragment,required:true,purpose:'Use selected notebook methods',fields:['notebook'],methods:{notebook:{[contract]:methods}}}]});const inspected=await controller.inspect(owner,requestId);const result=await controller.approve(owner,{requestId,approved:[{fragment,revision:inspected.requests[0].revision,fields:['notebook'],resources:{notebook:[resource]},methods:{notebook:{[contract]:methods}}}]});return controller.exchange({code:new URL(result.redirectUri).searchParams.get('code'),verifier,clientId,redirectUri});}
 const descriptors={get:readDescriptor(),put:writeDescriptor()},seen=[];
 const resolveBinding=async identity=>connected?descriptors[identity.method]:null;
 const dispatch=async(request,invocation)=>{seen.push(invocation);const {binding,args,transactionId}=request;if(!connected)throw Object.assign(Error('Disconnected'),{code:'forbidden'});if(invocation.caller!==owner){const response=await controller.rpc(invocation.caller.access_token,{version:'0',tx:transactionId,resource:binding.resource,contract:binding.contract,method:binding.method,args});if(response.error)throw Object.assign(Error(response.error.message),{code:response.error.code});return response.result;}
  const authenticated=await controller.auth.owner(invocation.caller,{mutation:!binding.effects.readOnly});const value=await store.transaction(async transaction=>{const live=await transaction.get(`federation/resource/${binding.resource}`);if(!live||live.owner!==authenticated.subject||!live.contracts[binding.contract]?.includes(binding.method))throw Object.assign(Error('Forbidden resource'),{code:'forbidden'});return controller.dispatch({transaction,subject:authenticated.subject,clientId:'fixture-owner-command',resource:binding.resource,contract:binding.contract,method:binding.method,args,tx:transactionId},webcrypto);});if(value?.__federationError)throw Object.assign(Error(value.__federationError.message),{code:value.__federationError.code});return value;
 };
 const callable=(method,review=async()=>true)=>createCallableBinding({descriptor:descriptors[method],resolveBinding,dispatch,review});
 return {owner,controller,assistant,callable,seen,writes:()=>writes,disconnect:()=>{connected=false;}};
}

test('native fixture shares outcomes across a non-palette human host, leased portal command and separately granted assistant',async()=>{
 const f=await fixture(),readBinding=f.callable('get'),read=projectUserCommand(readBinding,{enabled:true}),write=projectUserCommand(f.callable('put'),{enabled:true}),ownerContext=context(f.owner),reader=await f.assistant(['get']);
 const before=await read.invoke({key:'one'},context(f.owner));assert.deepEqual(await readBinding.invoke({key:'one'},context(Object.freeze(reader))),before);
 const contribution=portalCallableCommand(write,{id:'notebook.update',capability:'fixture.note.write',deps:{invocation:{}},contextFrom:resources=>resources.invocation});
 const registry=compilePortalModules([{id:'native-notebook',contributions:{commands:[contribution]}}]);const engine=new Engine({providers:{portalAccess:Provider.fromSingleton({allowed:true}),invocation:Provider.fromSingleton(ownerContext)}});
 try{await engine.dispatch(new RunPortalCommand(registry,'notebook.update',{args:{key:'one',value:'Written through the host command',version:1},caller:reader})).next('complete');}finally{await engine.dispose();}
 assert.strictEqual(f.seen.at(-1),ownerContext);assert.deepEqual(await read.invoke({key:'one'},context(Object.freeze(reader))),{value:'Written through the host command',version:2});assert.equal(f.writes(),1);
});

test('trusted confirmation never elevates a read-only assistant and revocation/disconnect remain live',async()=>{
 const f=await fixture(),reader=await f.assistant(['get']),writer=await f.assistant(['get','put']);let reviewed=0;
 await assert.rejects(f.callable('put',async(_,ctx)=>{reviewed++;assert.strictEqual(ctx.caller,reader);return true;}).invoke({key:'one',value:'Not authorized',version:1},context(reader)),{code:'forbidden'});assert.equal(reviewed,1);assert.equal(f.writes(),0);
 await assert.rejects(f.callable('put',async()=>{await f.controller.revoke(f.owner,writer.grants[0]);return true;}).invoke({key:'one',value:'Revoked',version:1},context(writer)),{code:'unauthorized'});assert.equal(f.writes(),0);
 f.disconnect();await assert.rejects(f.callable('get').invoke({key:'one'},context(f.owner)),{code:'binding_changed'});
});

test('same existing mutation journal handles replay, collisions and uncertain results without adapter retries',async()=>{
 const f=await fixture(),callable=f.callable('put'),invocation=context(f.owner),args={key:'one',value:'Once',version:1};const result=await callable.invoke(args,invocation);assert.deepEqual(await callable.invoke(args,invocation),result);assert.equal(f.writes(),1);await assert.rejects(callable.invoke({...args,value:'Changed input'},invocation),{code:'tx_conflict'});assert.equal(f.writes(),1);
 const ambiguous=await fixture({uncertain:true}),write=ambiguous.callable('put'),retry=context(ambiguous.owner);for(let i=0;i<2;i++)await assert.rejects(write.invoke(args,retry),{code:'indeterminate'});assert.equal(ambiguous.writes(),1);
});
