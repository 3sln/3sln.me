// EXT-X11 composition seam. Transport adapters supply trusted X4/setup/client-metadata ports; no invented HTTP API.
// `owner(request,{api,owner})` calls connectionsOwner; only its server adapter supplies authTime.
const unavailable=()=>{throw Object.assign(Error('connections_unavailable'),{code:'connections_unavailable'});};
export function createConnectionsPort({owner=unavailable,setup=unavailable,saveSetup=unavailable,external=unavailable,offerings=[]}={}){
 return Object.freeze({owner,setup,saveSetup,external,offerings:structuredClone(offerings)});
}
export const connectionManifest=c=>c?.integration?.snapshot?.manifest??c?.integration?.manifest??{};
// Only a validated, pinned manifest may supply navigation, never a typed URL or a discovery item's metadata.
// integrations §4.5: when the owner is choosing a resource for a field, `contracts` adds the creation hints.
export function connectionLink(value,clientId,issuer,{contracts}={}){try{const u=new URL(value),client=new URL(clientId),iss=new URL(issuer);if(u.protocol!=='https:'||u.origin!==client.origin||u.username||u.password||u.hash||iss.protocol!=='https:')return null;u.searchParams.set('iss',iss.origin);if(contracts?.length){u.searchParams.set('bindle_management','create');u.searchParams.set('contracts',contracts.join(' '));}return u.href;}catch{return null;}}
export const connectionHost=c=>{try{return new URL(c.appOrigin??c.clientId).host;}catch{return null;}};
