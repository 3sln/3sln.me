// Reserved-domain, trusted-provider fixtures only; never shipped as app routes.
import {readFile} from 'node:fs/promises';
import {createConsentProvider,REVIEWED_CONTRACTS} from '../../packages/consent/index.mjs';
export const app='https://tasks.example/client',fragment='https://settings.example/preferences/v1',storage='https://3sln.me/artefacts/contracts/object-storage/v1',third='https://publisher.example/contracts/calendar/v1',feed='https://publisher.example/events/v1';
export async function descriptions(){
 const contracts={};for(const [id,pin]of Object.entries(REVIEWED_CONTRACTS))contracts[id]={schema:JSON.parse(await readFile(new URL('../../'+pin.source,import.meta.url))),digest:pin.digest};
 contracts[third]={schema:{$id:third,'x-methods':{add:{effect:'write',summary:{en:'Add events to your calendar',es:'Añadir eventos a tu calendario'}},unknown:{}}},digest:'unreviewed'};
 return createConsentProvider({contracts,apps:{[app]:{reviewed:true}},manifests:{[fragment]:{schema:{id:fragment,fields:{theme:{title:'Theme',type:'string'}}}},[feed]:{schema:{id:feed,slot:{bus:{v:1,effects:{read:{en:'Read task changes'},write:{en:'Publish task changes'}}}}}}},registrableDomain:host=>host});
}
export function fixture({locale='en',intent='grant-more',scenario='mixed'}={}){
 const entry={client:{id:app,name:'Tasks',origin:'https://tasks.example'},intent,subjectConstraint:'https://provider.example/entities/550e8400-e29b-41d4-a716-446655440001',redirectUri:'https://tasks.example/callback',requests:[],reason:'<img src=x onerror=alert(1)> Plan my week',nonce:'N'.repeat(22),delivery:'redirect',presentation:'redirect',expiresAt:Date.now()+600000};
 const field=locale==='es'?'Archivos':'Files',items=[{id:'files',title:field,fragment,revision:'r1',fields:['files'],fieldTitles:{files:field},resources:{files:['photos','work']},resourceLabels:{photos:'Photos',work:'Work'},methods:{files:{[storage]:['get','delete']}},description:{kind:'contract',contract:storage,methods:['get','delete'],label:'Photos',purpose:'The app claims this is harmless'},disclosure:{host:'storage.example',recipients:['Mail']}}];
 if(scenario!=='one')items.push({id:'publisher',title:'Calendar',fragment:fragment+'/calendar',revision:'r2',fields:['calendar'],methods:{calendar:{[third]:['add','unknown']}},description:{kind:'contract',contract:third,methods:['add','unknown']},disclosure:{current:'See events',asking:'Add events'}});
 if(scenario==='many')for(let i=0;i<2;i++)items.push({...structuredClone(items[0]),id:'destructive-'+i,fragment:fragment+'/archive-'+i,title:'Archive '+i,description:{kind:'contract',contract:storage,methods:['delete']}});
 if(scenario==='feed')items.push({id:'feed',title:'Task changes',fragment:feed,revision:'r3',fields:['events'],resources:{events:['bus-id']},methods:{events:{'https://spec.bindle.example/contracts/event-bus/v1':['read','subscribe','unsubscribe','publish']}},description:{kind:'bus',fragment:feed,mode:'readwrite',label:'Task changes'},disclosure:{retentionDays:7,historyDays:7,historyCount:1204,readers:['Notes','Mail'],publishers:['Tasks'],brokered:true,host:'publisher.example',revocationMinutes:6}});
 const facts={items,alreadyAllowed:['See your profile'],declines:3};
 if(scenario==='setup')facts.setup=[{fragment,title:'Shared settings',schema:{fields:{theme:{title:'Theme',type:'string'}}},values:{theme:'dark'},affectedApps:[{name:'Mail',fields:['theme']}],consumerDigest:'consumers-r1'}];
 if(scenario==='occupant')facts.setup=[{fragment,title:'Choose an event host',schema:{fields:{host:{title:'Event host',type:'resource'}}},values:{},candidates:[{id:'self',label:'App’s own host',host:'tasks.example',eligible:false},{id:'other',label:'Other provider',host:'publisher.example',eligible:true},{id:'create',label:'Create',host:'3sln.me',eligible:true,create:true}]}];
 if(intent==='configure'){
  facts.items=[];entry.target={fragment,fields:['day','enabled','url','shared']};entry.suggestion={values:{day:'monday',enabled:true,url:'https://hooks.tasks.example/collect',shared:'Changed for Mail'}};
  facts.configuration={fragment,revision:'r1',consumerDigest:'consumers-r1',schema:{title:'Weekly summary',fields:{day:{title:'Send day',type:'enum',values:['friday','monday']},enabled:{title:'Send summaries',type:'boolean'},url:{title:'Forward to',type:'url',cardinality:{min:0}},shared:{title:'Shared note',type:'string'}}},values:{day:'friday',enabled:false,url:'',shared:'Original for Mail'},affectedApps:[{name:'Mail',client:'https://mail.example/client',fields:['shared']}]};
 }
 return {entry,facts,locale};
}
