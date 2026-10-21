// Run with Node >=24. Reserved example hosts; no provider is implemented here.
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline/promises';
import {pathToFileURL} from 'node:url';
import {createDeviceClient} from '../packages/sdk/src/device.mjs';
import {boundedJSON} from '../packages/sdk/src/tokens.mjs';
import {nodeDeviceFetch} from './device-authorization-node-transport.mjs';

export async function openSystemBrowser(uri){
 const url=new URL(uri);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw Error('Open only the base HTTPS verification URL.');
 const command=process.platform==='darwin'?'open':process.platform==='win32'?'rundll32':'xdg-open',args=process.platform==='win32'?['url.dll,FileProtocolHandler',url.href]:[url.href];
 await new Promise((resolve,reject)=>{const child=spawn(command,args,{stdio:'ignore',shell:false});child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error('Open the displayed URL in your system browser.')));});
}
/** Terminal is a thin native UI adapter. A TV app uses display.userCode,
 * verificationUri and codeLabel in its native accessibility tree instead.
 * No browser/webview transport, complete URI, QR-only display or auto-open.
 */
export async function signInFromTerminal({options,terminal,openBrowser=openSystemBrowser,signal}){
 const client=createDeviceClient({...options,confirm:async(account,{signal})=>{
  const expiry=new Date(account.refreshExpiresAt).toISOString();
  return /^y(?:es)?$/i.test((await terminal.question(`Signed in as ${account.subject} until ${expiry}. Continue? [y/N] `,{signal})).trim());
 }});
 try{
  const view=await client.start({signal});terminal.write(view.text+'\n');terminal.write(view.codeLabel+'\n');
  const choice=await terminal.question('Press Enter to open your system browser, or type wait to open it yourself: ',{signal});
  if(choice==='')await openBrowser(view.verificationUri);
  const session=await client.poll({signal});return {client,session};
 }catch(error){await client.dispose();throw error;}
}
async function main(){
 const issuer='https://provider.example',clientId='https://acme.example/cli',controller=new AbortController(),stop=()=>controller.abort();
 process.once('SIGINT',stop);const readline=createInterface({input:process.stdin,output:process.stdout}),terminal={write:text=>process.stdout.write(text),question:(...args)=>readline.question(...args)};
 let client;
 try{
  const response=await nodeDeviceFetch(issuer+'/.well-known/bindle/manifest.json',{credentials:'omit',redirect:'error',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(10000)])});if(!response.ok)throw Error('Provider discovery failed.');
  const manifest=await boundedJSON(response),signed=await signInFromTerminal({options:{issuer,manifest,clientId,fetcher:nodeDeviceFetch},terminal,signal:controller.signal});client=signed.client;
  terminal.write(`Confirmed ${signed.session.subject}. This example now revokes its session.\n`);
 }finally{await client?.dispose();readline.close();process.removeListener('SIGINT',stop);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{process.stderr.write(`Sign-in ended: ${error.code??error.message}\n`);process.exitCode=1;});
