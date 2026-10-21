// EXT-X10: provider-authored built-in definition for X4. Upstream accounts/folders remain separate resources under
// one connection. No OAuth, connector, mapping authority, resource generation or local-only disconnect changes.
// Fragment publication remains provisional (.example); only the shared classifier slot has publication authority.
import {AppQuery,ownerOf} from '../app/engine.mjs';
import {AppFault} from '../app/faults.mjs';
import {integrationsEnabled} from '../app/domains/connections.mjs';
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
export const GOOGLE_DRIVE_SETUP_FRAGMENT=freeze({id:'https://3sln.example/artefacts/fragments/google-drive-setup/v1',title:'Google Drive setup',description:'Name a managed folder, then explicitly authorize Google Drive using the existing Google connection flow.',publisher:'https://3sln.example',fields:{name:{title:'Managed folder name',type:'string',minLength:1,maxLength:100}}});
export const GOOGLE_DRIVE_INTEGRATION=freeze({name:'Google Drive',manifest:{v:1,setup:{fragments:[{fragment:GOOGLE_DRIVE_SETUP_FRAGMENT.id,required:true,purpose:'Name the managed Drive folder before authorizing your Google account.',fields:['name']}]},resources:{contracts:['https://3sln.me/artefacts/contracts/object-storage/v1']}}});
export const GOOGLE_DRIVE_DISCLOSURE=freeze({upstreamAuthorization:'Google OAuth with drive.file; each authorization creates or reconnects a separate managed resource.',conditionalAuthority:'bindle-host',physicalRetention:true,nativeDocuments:false,disconnect:{localOnly:true,providerRevoked:false,remoteDataDeleted:false}});
export class DriveIntegrationSetup extends AppQuery {
 static operation='drive-integration.setup';static deps=['config','accountStore','connections'];static refreshOn=['connections-changed'];
 async fetch({config,accountStore,connections}){
  if(!integrationsEnabled(config))throw new AppFault('not_found','Not found.',404);
  const owner=ownerOf(this.actor);if(await accountStore.get('owner')!==owner)throw new AppFault('forbidden','Account owner mismatch.',403);
  if(this.input!==undefined&&(!this.input||typeof this.input!=='object'||Array.isArray(this.input)||Object.keys(this.input).length))throw new AppFault('invalid_args','Setup takes no arguments.',400);
  const result=await connections.list();return {integration:'google-drive',definition:structuredClone(GOOGLE_DRIVE_INTEGRATION),fragment:structuredClone(GOOGLE_DRIVE_SETUP_FRAGMENT),disclosure:structuredClone(GOOGLE_DRIVE_DISCLOSURE),connections:result.connections.filter(r=>r.integration?.kind==='built-in'&&r.integration.builtin==='google-drive').map(r=>({id:r.id,state:r.state,generation:r.generation,configured:r.configured})),upstreamConfigured:Boolean(config.GOOGLE_CLIENT_ID&&config.GOOGLE_CLIENT_SECRET&&config.KEY_ENCRYPTION_KEY&&config.APP_ORIGIN)};
 }
}
export const DRIVE_INTEGRATION_OPERATIONS=Object.freeze([DriveIntegrationSetup]);
