// Shared host composition. X8's projection is unavailable unless an adapter passes `snapshot` (EXT-X8
// preferencesSnapshotPort over the owner's federation shard) with BROKERING_ENABLED; X8 hook: `snapshot`, consumer mint,
// introspection evidence.
// One adapter mount decision controls the handler, declaration and write minting (X8-R7).
export const brokeringMounts=c=>({integrations:c?.BROKERED_INTROSPECTION_MOUNTED===true,brokeredResources:c?.BROKERED_INTROSPECTION_MOUNTED===true,brokeredIntrospection:c?.BROKERED_INTROSPECTION_MOUNTED===true});
const on=(c,k)=>[true,'true'].includes(c?.[k]);
export const pendingPreferencesSnapshot=Object.freeze(Object.assign(async()=>{throw Object.assign(new Error('Preferences v2 snapshots await EXT-X8.'),{code:'snapshot_unavailable'});},{available:false}));
export function integrationPorts(config,{signer,mint,eventEgress,egress,doorbellGrant,describe,snapshot,introspection=false}={}){
 if(!on(config,'INTEGRATIONS_ENABLED'))return {};
 return {
  INTEGRATION_EVENT_PORTS:{...signer?{signer}:{},...eventEgress?{egress:eventEgress}:{},snapshot:on(config,'BROKERING_ENABLED')&&typeof snapshot==='function'&&snapshot.available===true?snapshot:pendingPreferencesSnapshot,...doorbellGrant?{doorbellGrant}:{}},
  ...on(config,'BROKERING_ENABLED')&&typeof mint==='function'?{BROKERING_CONSUMER_MINT:claims=>{if(claims?.purpose!=='invoke'||typeof claims.clientId!=='string'||claims.clientId===config.APP_ORIGIN||claims.feature!==undefined)throw Object.assign(new Error('Consumer tokens are app invoke tokens only.'),{code:'invalid_request'});return mint(claims);},...introspection===true?{BROKERED_INTROSPECTION_MOUNTED:true}:{}}:{},
  ...on(config,'BROKERING_ENABLED')&&typeof mint==='function'&&egress?{BROKERING_MINT:claims=>mint({...claims,clientId:config.APP_ORIGIN}),INTEGRATION_EGRESS:egress,...on(config,'BINDLEBOX_ENABLED')&&typeof describe==='function'?{MESSAGING_DESCRIBE:describe}:{}}:{},
 };
}
