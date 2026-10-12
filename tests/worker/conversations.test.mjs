import test from 'node:test';
import assert from 'node:assert/strict';
import {createHarness} from './harness.mjs';
test('actual Worker conversation bearer posts reach the owner inbox without leaking secrets and reject forged rights',async t=>{
 const h=await createHarness();t.after(()=>h.close());const {result:session,cookie}=await h.signup();const owner=session.account.id,headers={Origin:h.origin,Cookie:cookie,'X-CSRF-Token':session.csrfToken};
 const get=async(path,options={})=>{const r=await h.request(path,{headers,...options});assert.ok(r.ok,`${r.status} ${await r.clone().text()}`);return r.json();};const snapshot=await get('/api/account');
 const room=await get('/api/conversations',{method:'POST',value:{title:'Worker thread',collection:snapshot.collections[0].id}}),path='/api/conversations/'+owner+'/'+room.id;
 const cap=await get(path+'/action',{method:'POST',value:{source:room.source,operation:'capability',input:{}}});const eventId=crypto.randomUUID(),payload={version:1,id:room.id,source:room.source,epoch:cap.epoch,eventId,actor:'bearer',operation:'post',input:{text:'Worker human text\nsecond line'}};
 const posted=await h.request(path,{method:'POST',headers:{Authorization:'Bearer '+cap.secret},value:{payload}});assert.equal(posted.status,202);
 let receipt;for(let i=0;i<20;i++){receipt=await get(path+'/action',{method:'POST',value:{source:room.source,operation:'receipt',input:{eventId}}});if(receipt.complete)break;await new Promise(r=>setTimeout(r,20));}assert.equal(receipt.complete,true,JSON.stringify(receipt));
 const inbox=await get('/api/messages/page'),message=inbox.items.find(m=>m.conversation?.eventId===eventId);assert.ok(message);const rendered=await get('/api/messages/'+message.id);assert.equal(rendered.render.kind,'document');assert.ok(rendered.render.html.includes('Worker human text'));assert.ok(!JSON.stringify(rendered).includes(cap.secret));
 const forbidden=await h.request(path,{method:'POST',headers:{Authorization:'Bearer '+cap.secret},value:{payload:{...payload,eventId:crypto.randomUUID(),actor:owner,operation:'remove',input:{target:{origin:h.origin,owner},confirmed:true}}}});assert.equal(forbidden.status,403);
});
