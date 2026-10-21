// Raw Node HTTPS deliberately avoids fetch's automatic Sec-Fetch-Mode header.
import {request as httpsRequest} from 'node:https';
import {Readable} from 'node:stream';

export function createNodeDeviceFetch({requester=httpsRequest}={}){
 return (target,{method='GET',headers={},body,signal,credentials='omit',redirect='error'}={})=>new Promise((resolve,reject)=>{
  const url=new URL(target),outbound=new Headers(headers);
  if(url.protocol!=='https:'||url.username||url.password||credentials!=='omit'||redirect!=='error'||[...outbound.keys()].some(name=>name==='origin'||name.startsWith('sec-fetch-')))throw Error('Device transport requires credential-free HTTPS without browser headers.');
  const request=requester(url,{method,headers:Object.fromEntries(outbound),signal},incoming=>{
   const responseHeaders=new Headers();for(let i=0;i<incoming.rawHeaders.length;i+=2)responseHeaders.append(incoming.rawHeaders[i],incoming.rawHeaders[i+1]);
   const empty=[204,205,304].includes(incoming.statusCode);if(empty)incoming.resume();
   resolve(new Response(empty?null:Readable.toWeb(incoming),{status:incoming.statusCode,statusText:incoming.statusMessage,headers:responseHeaders}));
  });
  request.once('error',reject);request.end(body===undefined?undefined:String(body));
 });
}
export const nodeDeviceFetch=createNodeDeviceFetch();
