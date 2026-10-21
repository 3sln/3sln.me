// Shared host composition. X8's projection is deliberately unavailable until its implementation is mounted.
const on=(c,k)=>[true,'true'].includes(c?.[k]);
export const pendingPreferencesSnapshot=Object.freeze(Object.assign(async()=>{throw Object.assign(new Error('Preferences v2 snapshots await EXT-X8.'),{code:'snapshot_unavailable'});},{available:false}));
export function integrationPorts(config,{signer,mint,eventEgress,egress,doorbellGrant,describe}={}){
 if(!on(config,'INTEGRATIONS_ENABLED'))return {};
 return {
  INTEGRATION_EVENT_PORTS:{...signer?{signer}:{},...eventEgress?{egress:eventEgress}:{},snapshot:pendingPreferencesSnapshot,...doorbellGrant?{doorbellGrant}:{}},
  ...on(config,'BROKERING_ENABLED')&&typeof mint==='function'&&egress?{BROKERING_MINT:claims=>mint({...claims,clientId:config.APP_ORIGIN}),INTEGRATION_EGRESS:egress,...on(config,'BINDLEBOX_ENABLED')&&typeof describe==='function'?{MESSAGING_DESCRIBE:describe}:{}}:{},
 };
}
