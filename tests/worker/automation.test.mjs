import test from 'node:test';
import assert from 'node:assert/strict';
import {createHarness} from './harness.mjs';
async function signed(t){const h=await createHarness();t.after(()=>h.close());const {result:owner,cookie}=await h.signup(),headers={Origin:h.origin,Cookie:cookie,'X-CSRF-Token':owner.csrfToken};const response=await h.request('/api/resources',{method:'POST',headers,value:{name:'Browser documents',provider:'hosted'}});assert.equal(response.status,200);const source=await response.json();return {h,owner,cookie,headers,source,collectionId:'resource:'+source.id};}
async function read(response,status=200){assert.equal(response.status,status);return response.json();}

test('actual Worker browser automation enforces HTTP owner/CSRF and exact grants with one-use confirmed writes',async t=>{const f=await signed(t),{h,headers,collectionId}=f;
 assert.equal((await h.request('/api/automation/tools')).status,401);
 const tools=await read(await h.request('/api/automation/tools',{headers}));assert.equal(tools.tools.length,5);assert.equal(tools.grant,null);
 const other=await read(await h.request('/api/resources',{method:'POST',headers,value:{name:'Unselected documents',provider:'hosted'}}));
 const permission={permissions:[{collectionId,tools:['collections_list','item_read']}]};
 assert.equal((await h.request('/api/automation/grant',{method:'PUT',headers:{...headers,'X-CSRF-Token':'wrong'},value:permission})).status,403);
 assert.equal((await h.request('/api/automation/grant',{method:'PUT',headers:{...headers,Origin:'https://attacker.example'},value:permission})).status,403);
 await read(await h.request('/api/automation/grant',{method:'PUT',headers,value:permission}));
 const invoke=input=>h.request('/api/automation/invoke',{method:'POST',headers,value:input});
 const listed=await read(await invoke({name:'collections_list',args:{}}));assert.deepEqual(listed.collections.map(c=>c.id),[collectionId]);assert.deepEqual(listed.collections[0].tools,['collections_list','item_read']);
 assert.equal((await invoke({name:'item_read',args:{collectionId:'resource:'+other.id,key:'known.txt'}})).status,403);
 const operation={name:'item_write',args:{collectionId,key:'confirmed.txt',requestId:crypto.randomUUID(),dataBase64:Buffer.from('confirmed worker write').toString('base64'),condition:{absent:true}}};
 assert.equal((await h.request('/api/automation/prepare',{method:'POST',headers,value:operation})).status,403);
 await read(await h.request('/api/automation/grant',{method:'PUT',headers,value:{permissions:[{collectionId,tools:['collections_list','item_read','item_write']}]}}));
 assert.equal((await invoke(operation)).status,403);
 const prepare=await read(await h.request('/api/automation/prepare',{method:'POST',headers,value:operation}));assert.deepEqual(prepare.review,operation);
 assert.equal((await h.request('/api/automation/confirm',{method:'POST',headers:{...headers,'X-CSRF-Token':'wrong'},value:{nonce:prepare.nonce}})).status,403);
 const confirmation=await read(await h.request('/api/automation/confirm',{method:'POST',headers,value:{nonce:prepare.nonce}}));
 assert.equal((await invoke({...operation,args:{...operation.args,key:'substituted.txt'},confirmation:confirmation.confirmation})).status,403);
 await read(await invoke({...operation,confirmation:confirmation.confirmation}));
 assert.equal((await invoke({...operation,confirmation:confirmation.confirmation})).status,403);
 const contents=await read(await invoke({name:'item_read',args:{collectionId,key:'confirmed.txt'}}));assert.equal(Buffer.from(contents.dataBase64,'base64').toString(),'confirmed worker write');
 assert.equal((await invoke({name:'item_read',args:{collectionId,key:'substituted.txt'}})).status,404);
});

test('actual Worker browser grant remains device-bound and dies on app disconnect and logout',async t=>{const f=await signed(t),{h,headers,collectionId}=f,permissions=[{collectionId,tools:['collections_list']}];
 await read(await h.request('/api/automation/grant',{method:'PUT',headers,value:{permissions}}));
 const login=await h.request('/api/auth/login/password',{method:'POST',headers:{Origin:h.origin},value:{handle:f.owner.account.handle,password:'isolated test account password',turnstileToken:'local-browser-test-token'}});assert.equal(login.status,200);const second=await login.json(),secondHeaders={Origin:h.origin,Cookie:login.headers.get('Set-Cookie').split(';')[0],'X-CSRF-Token':second.csrfToken};
 const operation={name:'collections_list',args:{}};
 assert.equal((await h.request('/api/automation/invoke',{method:'POST',headers:secondHeaders,value:operation})).status,403);
 const apps=await read(await h.request('/api/apps',{headers})),connection=apps.apps.find(a=>a.transport==='browser');assert(connection);assert.equal(connection.provenance.kind,'owner-browser-consent');
 await read(await h.request('/api/apps/'+connection.id,{method:'DELETE',headers}));
 assert.equal((await h.request('/api/automation/invoke',{method:'POST',headers,value:operation})).status,401);
 await read(await h.request('/api/automation/grant',{method:'PUT',headers,value:{permissions}}));
 await read(await h.request('/api/automation/invoke',{method:'POST',headers,value:operation}));
 await read(await h.request('/api/auth/logout',{method:'POST',headers,value:{}}));
 assert.equal((await h.request('/api/automation/invoke',{method:'POST',headers,value:operation})).status,401);
 assert.equal((await h.request('/api/automation/tools',{headers})).status,401);
});
