import {open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {mintBootToken,bootTokenDigest,BOOT_TOKEN_WINDOW_MS} from '../packages/identity/boot.mjs';
// Writes the boot token only to a new private 0600 file. Stdout carries just the
// non-secret digest for deployment configuration (BOOTSTRAP_TOKEN_SHA256).
async function privateRead(path){const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const stat=await file.stat();if(!stat.isFile()||stat.mode&0o077||stat.size>4096||process.getuid&&stat.uid!==process.getuid())throw Error('The token file must be a small private regular file owned by this operator.');return await file.readFile('utf8');}finally{await file.close();}}
async function privateWrite(path,value){const file=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await file.writeFile(value);await file.sync();}finally{await file.close();}}
export async function runBootToken(argv,{clock=Date.now,write=value=>process.stdout.write(value)}={}){const [command,...args]=argv,options={};for(let i=0;i<args.length;i+=2){const name=args[i],value=args[i+1];if(!['--out','--origin','--in'].includes(name)||!value||value.startsWith('--')||Object.hasOwn(options,name))throw Error('Use explicit supported options exactly once.');options[name]=value;}
 if(command==='mint'){if(!options['--out']||!options['--origin']||options['--in'])throw Error('Use mint --origin ORIGIN --out FILE.');const now=clock(),token=mintBootToken(options['--origin'],{now}),digest=await bootTokenDigest(token);await privateWrite(options['--out'],JSON.stringify({format:'bindle-boot-token/v1',issuer:options['--origin'],mintedAt:now,usableUntil:now+BOOT_TOKEN_WINDOW_MS,digest,token},null,2)+'\n');write(`BOOTSTRAP_TOKEN_SHA256=${digest}\n`);return digest;}
 if(command==='digest'){if(!options['--in']||options['--out']||options['--origin'])throw Error('Use digest --in FILE.');const value=JSON.parse(await privateRead(options['--in']));if(value?.format!=='bindle-boot-token/v1'||typeof value.token!=='string')throw Error('Not a boot token file.');const digest=await bootTokenDigest(value.token);write(`BOOTSTRAP_TOKEN_SHA256=${digest}\n`);return digest;}
 throw Error('Use mint or digest.');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))runBootToken(process.argv.slice(2)).catch(()=>{process.stderr.write('Boot token operation failed. Check the exact origin, private file permissions and that the output file does not already exist.\n');process.exitCode=1;});
