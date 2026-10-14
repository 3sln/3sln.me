import {open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {encode} from '../packages/identity/crypto.mjs';
import {signSystemInvitation} from '../packages/identity/system-bootstrap.mjs';
async function privateRead(path){const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const stat=await file.stat();if(!stat.isFile()||stat.mode&0o077||stat.size>256||process.getuid&&stat.uid!==process.getuid())throw Error('The key file must be a small private regular file owned by this operator.');return (await file.readFile('utf8')).trim();}finally{await file.close();}}
async function privateWrite(path,value){const file=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await file.writeFile(value);await file.sync();}finally{await file.close();}}
export async function runSystemBootstrap(argv){const [command,...args]=argv,options={};for(let i=0;i<args.length;i+=2){const name=args[i],value=args[i+1];if(!['--out','--key-file','--origin','--handle','--role','--hours','--email'].includes(name)||!value||value.startsWith('--')||Object.hasOwn(options,name))throw Error('Use explicit supported options exactly once.');options[name]=value;}if(!options['--out'])throw Error('A new private output file is required.');
 if(command==='key'){if(Object.keys(options).length!==1)throw Error('Key generation accepts only --out.');await privateWrite(options['--out'],encode(crypto.getRandomValues(new Uint8Array(32)))+'\n');return;}
 if(command!=='invite'||!options['--key-file']||!options['--origin']||!options['--handle']||!options['--role'])throw Error('Use invite --key-file FILE --origin ORIGIN --handle HANDLE --role developer|system --out FILE.');
 const raw=options['--hours']??'24';if(!/^\d+$/.test(raw)||Number(raw)<1||Number(raw)>168)throw Error('Invitation validity must be1–168 hours.');const now=Date.now(),claims={version:1,purpose:'bindle-system-account-setup',issuer:options['--origin'],handle:options['--handle'],role:options['--role'],owner:crypto.randomUUID(),assignmentId:crypto.randomUUID(),nonce:crypto.randomUUID(),issuedAt:now,expiresAt:now+Number(raw)*3600000,...options['--email']?{email:options['--email']}:{}};
 const secret=await privateRead(options['--key-file']),token=await signSystemInvitation(claims,secret,{now});await privateWrite(options['--out'],JSON.stringify({format:'bindle-system-invitation/v1',issuer:claims.issuer,handle:claims.handle,role:claims.role,expiresAt:claims.expiresAt,token},null,2)+'\n');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))runSystemBootstrap(process.argv.slice(2)).catch(()=>{process.stderr.write('System invitation operation failed. Check private file permissions, supported options, configuration and destination uniqueness.\n');process.exitCode=1;});
