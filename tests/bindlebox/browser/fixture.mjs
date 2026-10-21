// Local test adapter only; no demo routes or credentials are mounted in the app.
import {ARCHIVE_CAPABILITIES} from '../../../apps/bindlebox/web/providers/mailbox.mjs';
export const OWNER='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',ROOM='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',MESSAGE='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
export const principal={issuer:'https://provider.example',subject:OWNER};
export function fixture({size=10001,archive=false}={}){
 const calls=[],drafts=new Map(),rooms=[{id:ROOM,subject:'A conversation <script>window.hacked=true</script>',state:'active'}],timeline=Array.from({length:size},(_,i)=>({eventId:'event-'+i,author:principal,createdAt:1792454400000+i,text:'Message '+i,own:true}));
 const message={messageId:MESSAGE,revision:1,recipientCount:4,delivered:1,pending:1,failed:1,cancelled:1,recipients:['delivered','unknown','expired','cancelled'].map((state,i)=>({principal:{issuer:principal.issuer,subject:'recipient-'+i},state,reason:state==='unknown'?'unreachable':null,nextAttemptAt:1792454500000,deadline:1792540800000}))};
 const rejected=[{id:'R'.repeat(43),subject:'A recoverable request',origin:'native',kind:'one-off',state:'rejected',priority:'normal',author:{verified:true,principal},tags:[{id:'sys:spam'}],tagHistory:[{action:'rejected',rule:'default:reject.spam'}]}],requests=[],views=[{id:'all',name:'All messages',builtin:true,revision:1}],contacts=[],outbox=[message];let lostReply=false,progressFailure=false;
 const archiveStatus={enabled:true,generation:0,lastCheckpointAt:null,encrypted:true,endToEnd:false,imported:null,resend:0};
 const mailbox={calls,archive:archive?ARCHIVE_CAPABILITIES:undefined,async run(name,{input={},id}={}){
  calls.push({name,input:structuredClone(input),id});
  if(name==='conversations.list')return {conversations:structuredClone(rooms)};
  if(name==='conversations.invitations')return {invitations:[]};
  if(name==='conversations.get'){const limit=input.limit??40,offset=input.offset??Math.floor(Math.max(0,timeline.length-1)/limit)*limit;return {...rooms.find(r=>r.id===input.conversationId),timeline:structuredClone(timeline.slice(offset,offset+limit)),pagination:{offset,limit,total:timeline.length,previous:offset>0?Math.max(0,offset-limit):null,next:offset+limit<timeline.length?offset+limit:null},gap:true};}
  if(name==='receive.body')return {id:input.id,text:'A recoverable request body',truncated:false};
  if(name==='shell.conversation-create')return {conversationId:ROOM};
  if(name==='contacts.list')return {contacts:structuredClone(contacts),links:[]};
  if(name==='views.list')return {views:structuredClone(views)};
  if(name==='outbox.list'){if(progressFailure){progressFailure=false;throw Object.assign(new Error('unavailable'),{code:'unavailable'});}return structuredClone(outbox);}
  if(name==='outbox.get')return structuredClone(message);
  if(name==='outbox.retry-missing'){assertId(id);for(const r of message.recipients)if(['expired','unknown'].includes(r.state))r.state='retry_scheduled';Object.assign(message,{pending:2,failed:0,revision:message.revision+1});return 2;}
  if(name==='intake.requests')return structuredClone(requests);
  if(name==='intake.rejected')return structuredClone(rejected);
  if(name==='intake.rescue'){const i=rejected.findIndex(r=>r.id===input.id);if(i<0)throw new Error('missing request');requests.push({...rejected.splice(i,1)[0],state:'request',allowed:input.allow});return {id:input.id,state:'request'};}
  if(name==='contacts.add'){contacts.push({id:'contact',label:input.label,principal});return contacts.at(-1);}
  if(name==='contacts.remove'){contacts.splice(0,1);return {removed:true};}
  if(name==='contacts.block')return {blocked:true};
  if(name==='views.create'){views.push({id:'view-'+views.length,name:input.name,revision:1,filter:input.filter});return views.at(-1);}
  if(name==='incoming.query')return {items:Array.from({length:40},(_,i)=>({id:'item-'+i,subject:'View item '+i,state:'inbox'})),cursor:input.cursor?null:'next',total:80};
  if(name==='conversations.send'){if(lostReply){lostReply=false;throw Object.assign(new Error('lost reply'),{code:'network'});}return {operationId:input.operationId};}
  if(name==='conversations.accept')return {decision:'accept'};
  if(name==='archive.status')return structuredClone(archiveStatus);
  if(name==='archive.checkpoint'){archiveStatus.generation=1;return {kind:'snapshot',generation:1,records:5};}
  if(name==='archive.verify')return {ok:true,generation:archiveStatus.generation,segments:1,records:5,writer:'self',current:true};
  if(name==='archive.export'){archiveStatus.generation=2;return {generation:2,digest:'D'.repeat(43),segments:1,records:5};}
  if(name==='archive.import'){archiveStatus.generation=3;archiveStatus.imported={generation:2,anchored:true};return {generation:3,source:2,imported:{items:5},resend:0,anchored:true,next:['conversations.rejoin']};}
  if(name==='conversations.rejoin')return {rejoins:1};
  throw new Error('Unexpected fixture operation '+name);
 },async progress(after){calls.push({name:'progress',after});return after==='stale'?{events:[{type:'reset',id:'epoch/2',data:{reason:'resume_gap'}}],reset:true,resumeToken:'epoch/2'}:{events:[{type:'message',id:'epoch/1',data:{messageId:MESSAGE}}],reset:false,resumeToken:'epoch/1'};}};
 const browser={id:()=> 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',drafts:{get:async id=>drafts.get(id),set:async(id,text)=>{drafts.set(id,text);}}};
 function assertId(id){if(id!==MESSAGE)throw new Error('wrong message');}
 return {mailbox,browser,calls,drafts,message,requests,rejected,archiveStatus,archiveEnabled:archive,loseReply:()=>{lostReply=true;},failSnapshot:()=>{progressFailure=true;}};
}
