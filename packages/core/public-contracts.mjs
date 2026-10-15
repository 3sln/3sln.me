// Explicit publication catalog. Design-only contracts and superseded fixtures
// must not become public merely because a file exists in docs/artefacts.
const authority='https://3sln.me';
export const publicContracts=Object.freeze([
 ['object-storage','Object storage','docs/spec/storage.html'],
 ['preferences','Preferences','docs/spec/contracts.html'],
 ['profile','Profile','docs/spec/contracts.html'],
 ['app-messages','Messages from connected apps','docs/spec/app-messages.html'],
 ['resource-descriptor','Resource descriptor','docs/spec/contracts.html'],
 ['resource-scoping','Resource scoping','docs/spec/federation-implementation.html'],
].map(([name,title,documentation])=>Object.freeze({name,title,version:'v1',kind:'rpc-contract',status:'draft',id:`${authority}/artefacts/contracts/${name}/v1`,path:`/artefacts/contracts/${name}/v1.json`,source:`docs/artefacts/${name}-v1.json`,documentation:`/${documentation}`})));
export const publicSchemas=Object.freeze([Object.freeze({name:'conversation',title:'Conversation v1 local submission envelope',version:'v1',kind:'submission-schema',status:'provisional',id:`${authority}/artefacts/conversation-v1.json`,path:'/artefacts/conversation-v1.json',source:'docs/artefacts/conversation-v1.json',documentation:'/docs/spec/conversations.html'})]);
export const publicFragments=Object.freeze([Object.freeze({name:'app-message-preferences',title:'App messages preference fragment',version:'v1',kind:'preferences-fragment',status:'draft',id:'https://3sln.me/artefacts/preferences/app-messages/v1',path:'/artefacts/preferences/app-messages/v1.json',source:'docs/artefacts/app-message-preferences-v1.json',documentation:'/docs/spec/app-messages.html'})]);
// 3sln.me manifest profiles: provider declarations under the core `profiles` container, not Bindle protocol.
// Provisional: publication implies no provider conformance; the source stays with its decision note until sign-off.
export const publicProfiles=Object.freeze([Object.freeze({name:'components',title:'3sln.me components profile',version:'v1',kind:'manifest-profile',status:'provisional',id:`${authority}/artefacts/profiles/components/v1`,path:'/artefacts/profiles/components/v1.json',source:'docs/architecture/artefacts/components-profile-v1.json',documentation:'/docs/profiles/components-v1.html'})]);
export const publicArtifacts=Object.freeze([...publicContracts,...publicSchemas,...publicFragments,...publicProfiles]);
/** Which member of the JSON source carries the published identifier. */
export const artifactIdentifier=(artifact,value)=>['preferences-fragment','manifest-profile'].includes(artifact.kind)?value.id:value.$id;
export function publicArtifact(path){return publicArtifacts.find(entry=>path===entry.path||path===`/artefacts/${entry.name}-${entry.version}.json`||path==='/'+entry.source||path===new URL(entry.id).pathname);}
export function contractRegistry(){const entry=({title,id,path,version,kind,status,documentation})=>({title,id,schema:path,version,kind,status,documentation});return {version:1,description:'Published draft definitions. Schema validity grants no authority and does not imply provider or external interoperability conformance.',contracts:publicContracts.map(entry),schemas:publicSchemas.map(entry),fragments:publicFragments.map(entry),profiles:publicProfiles.map(entry)};}
