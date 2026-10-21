// Fixtures for IA-1/IA-2: an `incremental` provider over in-memory fakes of the owner-shard ports (grants, preferences,
// sessions), a CX-1 consent provider, a fixture-only registrable-domain resolver and a movable clock. Hosts are
// reserved .example names.
import {webcrypto,createHash} from 'node:crypto';
import {MemoryMessagingStore,canonical,base64url} from '../packages/messaging/store.mjs';
import {createIncrementalProvider} from '../packages/federation/incremental.mjs';
import {createConsentProvider} from '../packages/consent/index.mjs';
import {createTestEngine} from './helpers/app-engine.mjs';
export const issuer='https://provider.example',owner='0b5f2a52-5b8e-4f3e-9a51-0c1d2e3f4a5b',subject=`${issuer}/entities/${owner}`,otherOwner='1c6a3b63-6c9f-4a4f-8b62-1d2e3f4a5b6c';
export const CAL='https://cal.example/preferences/calendars/v1',CAL2='https://cal.example/preferences/calendars/v2',SUMMARY='https://tasks.example/preferences/summary/v1',SUMMARY2='https://tasks.example/preferences/summary/v2',MAILPREF='https://mail.example/preferences/outbox/v1';
export const CALENDAR='https://spec.bindle.example/contracts/calendar/v1',MAIL='https://mail.example/contracts/mail/v1';
export const tasks={id:'https://tasks.example/client',name:'Tasks',origin:'https://tasks.example',redirectUris:['https://tasks.example/bindle/callback']};
export const tasksMobile={id:'https://m.tasks.example/client',name:'Tasks mobile',origin:'https://m.tasks.example',redirectUris:['https://m.tasks.example/callback']};
export const stranger={id:'https://stranger.example/client',name:'Stranger',origin:'https://stranger.example',redirectUris:['https://stranger.example/callback'],reviewed:false};
export const registrableDomain=host=>host.endsWith('.example')?host.split('.').slice(-2).join('.'):undefined;
export const pkce=verifier=>createHash('sha256').update(verifier).digest('base64url');
export const b64=size=>base64url(webcrypto.getRandomValues(new Uint8Array(size)));
export const SCHEMAS={
 [CAL]:{id:CAL,title:'Calendars',description:'Calendars',publisher:'https://cal.example',fields:{calendar:{title:'Calendar',type:'resource',contracts:[CALENDAR],cardinality:{min:0,max:1}},color:{title:'Color',type:'enum',values:['red','blue']},week:{title:'Week start',type:'enum',values:['monday','sunday']}}},
 [CAL2]:{id:CAL2,title:'Calendars',description:'Calendars v2',publisher:'https://cal.example',supersedes:CAL,fields:{calendar:{title:'Calendar',type:'resource',contracts:[CALENDAR],cardinality:{min:0,max:1}},color:{title:'Color',type:'enum',values:['red','blue']}}},
 [SUMMARY]:{id:SUMMARY,title:'Weekly summary',description:'Summary',publisher:'https://tasks.example',fields:{day:{title:'Send day',type:'enum',values:['monday','friday']},enabled:{title:'Send summaries',type:'boolean'},forward:{title:'Forward to',type:'url',maxLength:200},email:{title:'Reply address',type:'string',format:'email',maxLength:200},label:{title:'Label',type:'string',maxLength:40},secret:{title:'Secret',type:'string',maxLength:40,sensitive:true},shared:{title:'Shared label',type:'string',maxLength:40},target:{title:'Target',type:'resource',contracts:[CALENDAR],cardinality:{min:0,max:1}}}},
 [SUMMARY2]:{id:SUMMARY2,title:'Weekly summary',description:'Summary v2',publisher:'https://tasks.example',fields:{day:{title:'Send day',type:'enum',values:['monday','friday']}}},
 [MAILPREF]:{id:MAILPREF,title:'Outbox',description:'Outbox',publisher:'https://mail.example',fields:{outbox:{title:'Outbox',type:'resource',contracts:[MAIL],cardinality:{min:0,max:1}}}},
};
export const clock=(start=Date.UTC(2026,9,20,12))=>{let now=start;const f=()=>now;f.advance=ms=>now+=ms;f.set=ms=>now=ms;return f;};
/** In-memory owner-shard ports. Grants are union-only and idempotent per decision, like the FederationService adapter must be. */
export function ports({time}){
 const grants=new Map(),connections=new Set(),prefs=new Map(),receivers=new Map(),candidates=new Map(),newest=new Map(),calls={commit:0,save:0,issue:0,revoke:[],decisions:new Map(),saves:[]};
 const gk=(s,c,f)=>`${s}|${c}|${f}`;
 const union=(a,b)=>{const out={fields:[...new Set([...a?.fields??[],...b.fields??[]])],methods:structuredClone(a?.methods??{}),resources:structuredClone(a?.resources??{})};for(const [field,contracts] of Object.entries(b.methods??{}))for(const [contract,list] of Object.entries(contracts)){const into=((out.methods[field]??={})[contract]??=[]);for(const m of list)if(!into.includes(m))into.push(m);}for(const [field,ids] of Object.entries(b.resources??{}))out.resources[field]=[...new Set([...out.resources[field]??[],...ids])];return out;};
 return {calls,grants,connections,prefs,receivers,candidates,newest,
  connect(clientId,s=subject){connections.add(`${s}|${clientId}`);},grant(clientId,fragment,grant,s=subject){grants.set(gk(s,clientId,fragment),structuredClone(grant));},
  grantsPort:{connection:async({subject:s,clientId})=>connections.has(`${s}|${clientId}`),current:async({subject:s,clientId,fragment})=>structuredClone(grants.get(gk(s,clientId,fragment))??null),
   async commit({subject:s,clientId,decision,changes}){calls.commit++;if(calls.decisions.has(decision))return structuredClone(calls.decisions.get(decision));const results=changes.map(change=>{const before=grants.get(gk(s,clientId,change.fragment))??null,after=union(before,change);grants.set(gk(s,clientId,change.fragment),after);return {fragment:change.fragment,before:structuredClone(before),after:structuredClone(after)};});const result={results};calls.decisions.set(decision,result);return structuredClone(result);}},
  preferencesPort:{read:async({subject:s,fragment})=>structuredClone(prefs.get(`${s}|${fragment}`)??null),receivers:async({fragment,field})=>structuredClone(receivers.get(`${fragment}#${field}`)??[]),candidates:async({fragment,field})=>structuredClone(candidates.get(`${fragment}#${field}`)??[]),
   async save({subject:s,fragment,values,expectedRevision}){calls.save++;const old=prefs.get(`${s}|${fragment}`);if((old?.revision??null)!==expectedRevision)throw Object.assign(new Error('stale'),{code:'stale_consent'});const revision=`r${calls.save}`;prefs.set(`${s}|${fragment}`,{revision,values:structuredClone(values)});calls.saves.push({fragment,values:structuredClone(values)});return {revision};}},
  sessionsPort:{newest:async({subject:s,clientId})=>structuredClone(newest.get(`${s}|${clientId}`)??null),
   async issue({subject:s,clientId,dpopJkt,notAfter,authTime}){calls.issue++;calls.lastIssue={subject:s,clientId,dpopJkt,notAfter,authTime};return {access_token:`at-${calls.issue}`,token_type:dpopJkt?'DPoP':'Bearer',expires_in:900,refresh_token:`rt-${calls.issue}`,family:`family-${calls.issue}`};},
   async revoke(input){calls.revoke.push(input);}},
 };
}
export function consentPort(){
 const pin=(id,methods)=>({schema:{$id:id,'x-methods':methods},digest:'sha256-fixture'});
 return createConsentProvider({contracts:{[CALENDAR]:pin(CALENDAR,{readEvents:{effect:'read'},createEvent:{effect:'write'}}),[MAIL]:pin(MAIL,{send:{effect:'write',categories:['send-as-you']},list:{effect:'read'}})},apps:{[tasks.id]:{reviewed:true},[stranger.id]:{reviewed:false}},registrableDomain});
}
export function fixture({start,limits,schemas=SCHEMAS}={}){
 const time=clock(start),p=ports({time}),store=new MemoryMessagingStore(),pins=[];
 const clients=new Map([tasks,tasksMobile,stranger].map(c=>[c.id,c]));
 const pinSchema=async url=>{pins.push(url);if(!Object.hasOwn(schemas,url))throw Object.assign(new Error('unsupported'),{code:'unsupported_fragment'});return {schema:structuredClone(schemas[url]),digest:createHash('sha256').update(canonical(schemas[url])).digest('base64url')};};
 const incremental=createIncrementalProvider({store,issuer,crypto:webcrypto,clock:time,registrableDomain,grants:p.grantsPort,preferences:p.preferencesPort,sessions:p.sessionsPort,consent:consentPort(),pinSchema,clients:id=>clients.get(id)??null,limits});
 for(const client of [tasks,tasksMobile,stranger])p.connect(client.id);
 return {time,p,store,incremental,pins,clients};
}
let counter=0;
export const entryHash=()=>b64(32).slice(0,42)+'ABCDEFGH'[counter++%8];
export function grantMoreInput(requests,{client=tasks,dpopJkt,reason}={}){const verifier=b64(48);return {verifier,input:{entryHash:entryHash(),subject,clientId:client.id,client:{id:client.id,name:client.name,origin:client.origin,reviewed:client.reviewed!==false},intent:'grant-more',requests,...reason?{reason}:{},binding:{redirectUri:client.redirectUris[0],challenge:pkce(verifier),...dpopJkt?{dpopJkt}:{}}}};}
export function configureInput(target,suggestion,{client=tasks}={}){return {input:{entryHash:entryHash(),subject,clientId:client.id,client:{id:client.id,name:client.name,origin:client.origin,reviewed:client.reviewed!==false},intent:'configure',target,...suggestion?{suggestion}:{},binding:{redirectUri:client.redirectUris[0]}}};}
export const calRequest=(over={})=>({fragment:CAL,purpose:'Add task due dates as events.',fields:['calendar'],methods:{calendar:{[CALENDAR]:['createEvent']}},...over});
export async function engine(t,f,config={INCREMENTAL_AUTH_ENABLED:true}){const e=await createTestEngine({providers:{config,incremental:f.incremental}});t.after(()=>e.dispose());return e;}
