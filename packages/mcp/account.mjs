import {StorageError} from '../storage/policy.mjs';
import {key,canonical,digest} from '../messaging/store.mjs';
const fail=(code,message,status=403)=>{throw new StorageError(code,message,status);};
export async function mcpCollections(account,owner){
 await account.warm(owner);
 const inbox=(await account.messages.collections(owner)).filter(c=>c.active).map(c=>({id:`inbox:${c.id}`,name:c.name,kind:'inbox',tools:['collections_list','items_list','item_read','item_write','item_delete']}));
 const resources=[...(await account.metadata.list({prefix:'resource/',limit:201})).values()];
 if(resources.length>200||resources.filter(r=>r.kind!=='app-connection').length>100)fail('resource_limit','This account has too many sources.',429);
 return [...inbox,...resources.filter(r=>r.owner===owner&&r.kind!=='app-connection'&&r.status==='connected').map(r=>({id:`resource:${r.id}`,name:r.name,kind:'storage',tools:['collections_list',...r.capabilities?.read?['item_read']:[],...r.provider==='hosted'?['item_write','item_delete']:[]]}))];
}
export async function mcpOperation(account,owner,clientId,tool,args){
 const collection=(await mcpCollections(account,owner)).find(c=>c.id===args.collectionId);
 if(!collection||!collection.tools.includes(tool))fail('forbidden','The collection or function is no longer available.');
 const id=collection.id.split(':')[1];
 if(collection.kind==='storage'){
  const method={item_read:'get',item_write:'put',item_delete:'delete'}[tool];
  const input=tool==='item_read'?{key:args.key}:tool==='item_write'?{key:args.key,dataBase64:args.dataBase64,contentType:args.contentType,condition:args.condition}:{key:args.key,version:args.version};
  if(tool==='item_read'&&collection.kind==='storage'){
   const resource=await account.metadata.get(`resource/${id}`);
   if(resource.provider==='hosted'){const item=await account.metadata.get(`hosted/${id}/${encodeURIComponent(args.key)}`);if(item?.size>65536)fail('result_too_large','Download this item through the account interface.',413);}
  }
  if(tool==='item_delete'&&!await account.metadata.get(`rpc-journal/${encodeURIComponent(`mcp:${clientId}`)}/${args.requestId}`))await account.admitWork(owner);
  return account.federationRPC({subject:`${account.config.APP_ORIGIN}/entities/${owner}`,clientId:`mcp:${clientId}`,resource:`${account.config.APP_ORIGIN}/entities/${owner}/resources/${id}`,contract:'https://3sln.me/artefacts/contracts/object-storage/v1',method,args:input,tx:args.requestId??crypto.randomUUID()});
 }
 if(tool==='items_list')return account.messagePage(owner,{collection:id,limit:args.limit??20,cursor:args.cursor});
 const writing=['item_write','item_delete'].includes(tool);
 let journal,fingerprint;
 if(writing){
  if(!/^[a-f0-9-]{36}$/.test(args.requestId||''))fail('invalid_args','A request UUID is required.',400);
  journal=`mcp/operation/${encodeURIComponent(clientId)}/${args.requestId}`;fingerprint=await digest(crypto,canonical({tool,args}));const prior=await account.metadata.get(journal);
  if(prior){if(prior.fingerprint!==fingerprint)fail('tx_conflict','Request identifier was reused.',409);if(prior.state!=='done')fail('indeterminate','Read the item before retrying this operation.',503);return prior.result;}
 }
 if(typeof args.key!=='string'||!/^[a-f0-9-]{36}$/.test(args.key))fail('invalid_args','A message identifier is required.',400);
 const record=await account.metadata.get(key('message',owner,args.key));
 if(!record||record.owner!==owner||record.collection!==id)fail('forbidden','This item does not belong to the selected collection.');
 if(tool==='item_read'){
  if(record.size>65536)fail('result_too_large','Download this item through the account interface.',413);
  const payload=await account.messageBytes(owner,args.key);
  return {item:{id:record.id,mimeType:record.mimeType,size:record.size,tags:record.tags,classification:record.classification},dataBase64:btoa(String.fromCharCode(...payload.bytes))};
 }
 if(tool==='item_write'&&(!args.actions||Object.keys(args.actions).some(k=>!['tags','classification','quarantined','read'].includes(k))))fail('invalid_args','Only message metadata can be changed.',400);
 await account.admitWork(owner);await account.metadata.put(journal,{fingerprint,state:'reserved',createdAt:Date.now()});
 let result;
 if(tool==='item_write'){
  result=await account.updateMessage(owner,args.key,args.actions);
 }
 else if(tool==='item_delete')result=await account.deleteMessage(owner,args.key);
 else fail('unsupported_method','This function is unavailable.',400);
 await account.metadata.put(journal,{fingerprint,state:'done',result,createdAt:Date.now()});return result;
}
