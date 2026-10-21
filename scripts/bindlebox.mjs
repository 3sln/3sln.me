#!/usr/bin/env node
// Local, memory-only simulator CLI. No external network or production services.
// node scripts/bindlebox.mjs --list
// echo '{"as":"alice","op":"mailbox.ping"}' | node scripts/bindlebox.mjs --peers 3 --seed 7 -
// Steps: {as,op,id?,input?,save?,expect?,expectFault?}, {advance:ms}, {as,audit:true}.
// Prepare a signed local delivery: {as:"alice",prepare:{to:"bob",text:"Hello"},save:"draft"}.
// Reference saved values in input/id: {"$":"draft"} or {"$":"draft.operationId"}.
import {createMailboxSimulator} from '../packages/bindlebox-engine/simulator.mjs';
import {readFile} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import {operate,MailboxQuery} from '../packages/bindlebox-engine/engine.mjs';
import {PROVIDERS,memoryEffects} from '../packages/bindlebox-engine/providers.mjs';
import {MAILBOX_OPERATIONS} from '../packages/bindlebox-engine/operations.mjs';
import {faultOf} from '../packages/bindlebox-engine/faults.mjs';
const print=value=>process.stdout.write(JSON.stringify(value)+'\n');
const matches=(expected,actual)=>Array.isArray(expected)?Array.isArray(actual)&&expected.length===actual.length&&expected.every((v,i)=>matches(v,actual[i])):expected!==null&&typeof expected==='object'?actual!==null&&typeof actual==='object'&&Object.entries(expected).every(([k,v])=>matches(v,actual[k])):Object.is(expected,actual);
let peers=new Map(),simulator;const saved=new Map();
const resolve=value=>value&&typeof value==='object'?Object.keys(value).length===1&&typeof value.$==='string'?value.$.split('.').reduce((v,k,i)=>i===0?saved.get(k):v?.[k],undefined):Array.isArray(value)?value.map(resolve):Object.fromEntries(Object.entries(value).map(([k,v])=>[k,resolve(v)])):value;
try{
 const {values:options,positionals}=parseArgs({allowPositionals:true,options:{peers:{type:'string'},seed:{type:'string'},list:{type:'boolean'},help:{type:'boolean',short:'h'}}});
 if(options.help)process.stdout.write((await readFile(new URL(import.meta.url),'utf8')).split('\n').filter(line=>line.startsWith('//')).map(line=>line.slice(3)).join('\n')+'\n');
 else if(options.list){for(const [provider,row]of Object.entries(PROVIDERS))print({provider,...row});for(const [operation,Operation]of Object.entries(MAILBOX_OPERATIONS))print({operation,class:Operation.name,kind:Operation.prototype instanceof MailboxQuery?'query':'action',deps:Operation.deps});}
 else{
  const count=Number(options.peers??1),seed=Number(options.seed??1);if(!Number.isInteger(count)||count<1||count>64||!Number.isSafeInteger(seed)||positionals.length>1)throw new TypeError('Use --peers 1–64, an integer --seed and at most one script file');
  const clock=memoryEffects().clock;
  simulator=await createMailboxSimulator({count,seed,clock});peers=simulator.peers;
  const source=positionals[0]&&positionals[0]!=='-'?await readFile(positionals[0],'utf8'):await new Promise((resolve,reject)=>{let source='';process.stdin.setEncoding('utf8').on('data',chunk=>source+=chunk).on('end',()=>resolve(source)).on('error',reject);});
  const trimmed=source.trim(),steps=trimmed.startsWith('[')?JSON.parse(trimmed):trimmed.split('\n').filter(line=>line.trim()).map(line=>JSON.parse(line));
  for(const [index,step]of steps.entries()){
   let outcome;
   try{
    if(!step||typeof step!=='object'||Array.isArray(step))throw new TypeError('A step must be an object');
    if(step.advance!==undefined){print({step:index,advance:step.advance,now:clock.advance(step.advance)});continue;}
    const peer=peers.get(step.as??'alice');if(!peer)throw new TypeError(`Unknown peer ${step.as}`);
    if(step.audit){print({step:index,as:step.as??'alice',audit:peer.audit.entries});continue;}
    if(step.prepare){outcome={ok:true,result:await simulator.prepare(step.as??'alice',step.prepare.to,step.prepare)};}
    else {if(!Object.hasOwn(MAILBOX_OPERATIONS,step.op))throw new TypeError(`Unknown operation ${step.op}`);
    outcome={ok:true,result:await operate(peer.engine,new MAILBOX_OPERATIONS[step.op]({actor:{kind:'owner',owner:peer.owner},...step.id!==undefined?{id:resolve(step.id)}:{},...step.input!==undefined?{input:resolve(step.input)}:{}}))};}
    if(outcome.ok&&step.save)saved.set(step.save,outcome.result);
   }catch(error){outcome={ok:false,fault:error instanceof TypeError?{code:'invalid_step',message:error.message}:faultOf(error)};}
   const expected=outcome.fault?.code!=='invalid_step'&&(step?.expectFault!==undefined?!outcome.ok&&outcome.fault.code===step.expectFault:outcome.ok&&(step?.expect===undefined||matches(step.expect,outcome.result)));
   if(!expected)process.exitCode=1;print({step:index,as:step?.as??'alice',op:step?.op,...outcome,...expected?{}:{unexpected:true}});
  }
 }
}catch(error){print({ok:false,fault:{code:'invalid_script',message:error.message}});process.exitCode=1;}
finally{await Promise.all([...peers.values()].map(peer=>peer.engine.dispose()));}
