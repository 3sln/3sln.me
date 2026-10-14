// Generate a separate provider attestation key without printing private material.
import {mkdir,lstat,writeFile,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
const args=process.argv.slice(2);
if(args.length!==2||args[0]!=='--out-dir'){console.error('Usage: node scripts/app-message-key.mjs --out-dir PRIVATE_DIRECTORY');process.exit(2);}
const directory=resolve(args[1]);
await mkdir(directory,{recursive:true,mode:0o700});
const stat=await lstat(directory);
if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||process.getuid&&stat.uid!==process.getuid())throw Error('Use an owned private directory with mode 0700.');
const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
const kid='app-message-'+crypto.randomUUID();
const privateJWK={...await crypto.subtle.exportKey('jwk',pair.privateKey),kid,alg:'ES256',use:'sig'};
const publicJWK={...await crypto.subtle.exportKey('jwk',pair.publicKey),kid,alg:'ES256',use:'sig'};
const privatePath=join(directory,'app-message-signing.json'),publicPath=join(directory,'app-message-public.json');
await writeFile(privatePath,JSON.stringify(privateJWK)+'\n',{flag:'wx',mode:0o600});
try{await writeFile(publicPath,JSON.stringify({keys:[publicJWK]},null,2)+'\n',{flag:'wx',mode:0o600});}catch(error){await rm(privatePath,{force:true});throw error;}
console.log('Generated provider app-message attestation files in '+directory+'. Private material was not printed.');
