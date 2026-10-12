import test from 'node:test';import assert from 'node:assert/strict';
import {AccountController} from '../packages/runtime/accounts.mjs';
import {SqliteMetadata,SerialGate} from '../apps/node/resources.mjs';
test('repeated owner reads do not write activity and push scheduled work into the future',async()=>{
 const metadata=new SqliteMetadata(':memory:');try{const owner='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',controller=new AccountController({metadata,gate:new SerialGate(),blobs:{delete:async()=>{}},archives:{},config:{APP_ORIGIN:'https://app.example',LOCAL_DEVELOPMENT:'false',SEMANTIC_SEARCH_ENABLED:'false'},sql:metadata.sql});
 await controller.touch(owner);const timestamp=await metadata.get('lastOwnerActiveAt');await metadata.setAlarm(Date.now()+1000);const alarm=await metadata.getAlarm();let writes=0;const put=metadata.put.bind(metadata);metadata.put=async(...args)=>{writes++;return put(...args);};
 await controller.touch(owner);await controller.touch(owner);assert.equal(writes,0);assert.equal(await metadata.get('lastOwnerActiveAt'),timestamp);assert.equal(await metadata.getAlarm(),alarm);
 }finally{metadata.close();}
});
