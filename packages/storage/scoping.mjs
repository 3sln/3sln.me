export const RESOURCE_SCOPING='https://3sln.me/artefacts/contracts/resource-scoping/v1';
/** Optional contract: constraints become part of the shared field assignment,
 * never an upstream credential or a client-selected per-invocation expansion. */
export function storageScopeOptions(capabilities={}){return {contract:RESOURCE_SCOPING,fields:{prefix:{type:'string',maxLength:1024,description:'Allow this logical key and keys beneath it, using slash-delimited containment.'},readOnly:{type:'boolean',description:'Deny writes, deletion and write presigning.'},maxObjectBytes:{type:'integer',minimum:1,maximum:capabilities.maxObjectBytes??1048576,description:'Bound reads and uploads, including delegated signed URLs.'}}};}
