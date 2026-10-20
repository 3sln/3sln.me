#!/usr/bin/env node
// Engine CLI: drive the application engine directly, without HTTP or a browser
// (docs/architecture/app-engine.md §9). It composes exactly the provider set the
// engine tests use (packages/app/memory-providers.mjs), so what an agent explores here
// is what the tests verify. It is a development tool: in-memory by default, or a
// local SQLite file with --db; it never reaches a deployment.
//
//   node scripts/engine.mjs --list                    catalogue and registered operations
//   node scripts/engine.mjs steps.json                run a script (JSON array or JSON lines)
//   echo '{"op":"views.list"}' | node scripts/engine.mjs -
//   node scripts/engine.mjs --db .output/engine.sqlite --seed 7 steps.json
//   node scripts/engine.mjs --repl                    interactive, with the engine in scope
//
// A step is one of:
//   {"op":"views.create","input":{...},"as":"work"}          dispatch by wire name; name the result
//   {"op":"views.update","id":{"$":"work.id"},"input":{...}}  {"$":"name.path"} reads a named result
//   {"op":"rules.list","owner":"<uuid>"}                      act as another owner (default OWNER)
//   {"op":"...","expect":{...}} | {"op":"...","expectFault":"code"}  checked as a subset; a mismatch
//                                                            or an unknown operation exits 1
//   {"advance":60000}  move the fake clock     {"events":true}  facts since the last report
//   {"audit":true}     audit entries so far
// Output is one JSON line per step: {step, op, ok, result | fault}.
import {readFile} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import repl from 'node:repl';
import {createMemoryEngine,OWNER,OTHER,ownerActor} from '../packages/app/memory-providers.mjs';
import {PROVIDERS} from '../packages/app/providers.mjs';
import {ACCOUNT_OPERATIONS} from '../packages/app/operations.mjs';
import {AppQuery,perform,read} from '../packages/app/engine.mjs';
import {faultOf} from '../packages/app/faults.mjs';

const {values:options,positionals}=parseArgs({allowPositionals:true,options:{db:{type:'string'},seed:{type:'string'},owner:{type:'string'},list:{type:'boolean'},repl:{type:'boolean'},help:{type:'boolean',short:'h'}}});
const print=value=>process.stdout.write(JSON.stringify(value)+'\n');
if(options.help){process.stdout.write((await readFile(new URL(import.meta.url),'utf8')).split('\n').filter(line=>line.startsWith('//')).map(line=>line.slice(3)).join('\n')+'\n');process.exit(0);}
if(options.list){
 for(const [name,row]of Object.entries(PROVIDERS))print({provider:name,...row});
 for(const [name,Operation]of Object.entries(ACCOUNT_OPERATIONS))print({operation:name,class:Operation.name,kind:Operation.prototype instanceof AppQuery?'query':'action',deps:Operation.deps,...Operation.changes?{changes:Operation.changes}:{},...Operation.refreshOn?{refreshOn:Operation.refreshOn}:{}});
 process.exit(0);
}
// Exploration files only: a file a server has bound to an account (it holds an `owner` key) is never opened.
if(options.db&&options.db!==':memory:'){const {existsSync}=await import('node:fs');if(existsSync(options.db)){const {DatabaseSync}=await import('node:sqlite');const probe=new DatabaseSync(options.db,{readOnly:true});let bound=false;try{bound=Boolean(probe.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='records'").get()&&probe.prepare("SELECT 1 FROM records WHERE key='owner'").get());}finally{probe.close();}if(bound){process.stderr.write(`Refusing ${options.db}: it belongs to an account. Use a scratch file.\n`);process.exit(2);}}}
const owner=options.owner??OWNER,engine=await createMemoryEngine({db:options.db??':memory:',...options.seed!==undefined?{seed:Number(options.seed)}:{}});
if(options.repl){
 process.stdout.write(`App engine (${options.db??'in-memory'}). In scope: engine, perform, read, run(name, params), ops, actor(owner), OWNER, OTHER, clock, events, audit.\n`);
 const session=repl.start({prompt:'engine> '});
 Object.assign(session.context,{engine:engine.engine,perform:action=>perform(engine.engine,action),read:query=>read(engine.engine,query),run:(name,params={})=>engine.run(name,{actor:ownerActor(owner),...params}),ops:ACCOUNT_OPERATIONS,actor:ownerActor,OWNER,OTHER,clock:engine.clock,events:engine.events,audit:engine.audit.entries});
 session.on('exit',async()=>{await engine.dispose();process.exit(0);});
}else{
 const source=positionals[0]==='-'||!positionals.length?await new Promise((resolve,reject)=>{let text='';process.stdin.setEncoding('utf8').on('data',chunk=>text+=chunk).on('end',()=>resolve(text)).on('error',reject);}):await readFile(positionals[0],'utf8');
 const trimmed=source.trim(),steps=trimmed.startsWith('[')?JSON.parse(trimmed):trimmed.split('\n').filter(line=>line.trim()).map(line=>JSON.parse(line));
 const named={},resolve=value=>Array.isArray(value)?value.map(resolve):value&&typeof value==='object'?Object.keys(value).length===1&&typeof value.$==='string'?value.$.split('.').reduce((v,k)=>v?.[k],named):Object.fromEntries(Object.entries(value).map(([k,v])=>[k,resolve(v)])):value;
 // Expected values match as a subset: listed object fields must match; arrays match element by element at equal length.
 const matches=(expected,actual)=>Array.isArray(expected)?Array.isArray(actual)&&actual.length===expected.length&&expected.every((v,i)=>matches(v,actual[i])):expected!==null&&typeof expected==='object'?actual!==null&&typeof actual==='object'&&Object.entries(expected).every(([k,v])=>matches(v,actual[k])):Object.is(expected,actual);
 let failures=0,reported=0;
 for(const [index,raw]of steps.entries()){
  const step=resolve(raw);
  if(step.advance!==undefined){print({step:index,advance:step.advance,now:engine.clock.advance(step.advance)});continue;}
  if(step.events){print({step:index,events:engine.events.slice(reported)});reported=engine.events.length;continue;}
  if(step.audit){print({step:index,audit:engine.audit.entries});continue;}
  let outcome;
  try{outcome={ok:true,result:await engine.run(step.op,{actor:ownerActor(step.owner??owner),...step.id!==undefined?{id:step.id}:{},...step.input!==undefined?{input:step.input}:{}})};if(step.as)named[step.as]=outcome.result;}
  catch(error){outcome={ok:false,fault:faultOf(error)};if(error instanceof TypeError&&!error.code)outcome.fault={code:'invalid_step',message:error.message};}
  const expected=outcome.fault?.code==='invalid_step'?false:step.expectFault!==undefined?!outcome.ok&&outcome.fault.code===step.expectFault:step.expect!==undefined?outcome.ok&&matches(step.expect,outcome.result):true;
  if(!expected)failures++;
  print({step:index,op:step.op,...outcome,...expected?{}:{unexpected:true}});
 }
 await engine.dispose();
 process.exitCode=failures?1:0;
}
