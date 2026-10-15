// Island avatar bytes (embed islands §6.2, EIR-18). The account picture is an HTTPS URL in the owner's profile; no
// uploaded bytes exist. The embed origin never passes that URL or its bytes through: it reads the source once per
// request, accepts only a bounded, non-interlaced 8-bit PNG, decodes it, cover-crops it to a square and re-encodes a
// fresh RGBA PNG at exactly one bucket size. No codec is vendored, so other formats (JPEG, WebP, GIF, SVG) are refused
// and the island keeps its monogram. Sources are limited to the provider's own static assets and operator-approved
// HTTPS origins (`EMBED_AVATAR_ORIGINS`), mirroring the explicit egress approval used for form postbacks.
export const AVATAR_BUCKETS=Object.freeze([64,128,256,512]);
export const AVATAR={sourceBytes:1048576,sourceSide:1024,timeoutMs:1000,responseMs:1500};
const SIGNATURE=[137,80,78,71,13,10,26,10],CHANNELS={0:1,2:3,3:1,4:2,6:4};
const unavailable=()=>Object.assign(new Error('The picture is unavailable.'),{code:'avatar_unavailable'});

/** Operator egress approval: HTTPS origins without userinfo, path or IP literal. Invalid configuration approves nothing. */
export function avatarOrigins(value){
 let list;try{list=typeof value==='string'?JSON.parse(value||'[]'):value??[];}catch{return new Set();}
 if(!Array.isArray(list)||list.length>32)return new Set();
 const out=new Set();for(const item of list){let url;try{url=new URL(item);}catch{return new Set();}if(url.protocol!=='https:'||url.origin!==item||/^\[|^\d+(?:\.\d+){3}$/.test(url.hostname))return new Set();out.add(url.origin);}return out;
}

async function bounded(response,max){
 const reader=response.body?.getReader();if(!reader)throw unavailable();const chunks=[];let size=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>max)throw unavailable();chunks.push(value);}}catch(error){reader.cancel().catch(()=>{});throw error;}
 const out=new Uint8Array(size);let at=0;for(const chunk of chunks){out.set(chunk,at);at+=chunk.byteLength;}return out;
}
/** Reads the source picture. `assets` serves the provider's own origin; `fetch` (strictly public on Workers) serves
 * approved origins. No credentials, no redirects, no query strings, a byte cap and a timeout. */
export async function readAvatarSource(source,{issuer,assets,fetch,origins=new Set(),timeoutMs=AVATAR.timeoutMs,maxBytes=AVATAR.sourceBytes}){
 let url;try{url=new URL(source);}catch{throw unavailable();}
 if(url.protocol!=='https:'&&url.origin!==issuer||url.username||url.password||url.search||url.hash)throw unavailable();
 const own=url.origin===issuer;if(!own&&!origins.has(url.origin))throw unavailable();
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
 try{
  const response=own?await assets?.fetch(new Request(new URL(url.pathname,issuer),{method:'GET'})):await fetch?.(url.href,{method:'GET',headers:{Accept:'image/png'},credentials:'omit',redirect:'manual',cache:'no-store',referrerPolicy:'no-referrer',signal:controller.signal});
  if(!response||response.status!==200){await response?.body?.cancel();throw unavailable();}
  const length=response.headers.get('Content-Length');if(length!==null&&!(Number(length)<=maxBytes)){await response.body?.cancel();throw unavailable();}
  return await bounded(response,maxBytes);
 }catch{throw unavailable();}finally{clearTimeout(timer);}
}

const u32=(bytes,at)=>(bytes[at]<<24|bytes[at+1]<<16|bytes[at+2]<<8|bytes[at+3])>>>0;
async function inflate(bytes,expected){
 const stream=new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate')),reader=stream.getReader(),out=new Uint8Array(expected);let at=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;if(at+value.byteLength>expected)throw unavailable();out.set(value,at);at+=value.byteLength;}}catch(error){reader.cancel().catch(()=>{});throw unavailable();}
 if(at!==expected)throw unavailable();return out;
}
/** Decodes a non-interlaced 8-bit PNG (grey, RGB, palette, grey+alpha, RGBA) into RGBA. Anything else is refused. */
export async function decodePNG(bytes,{maxSide=AVATAR.sourceSide}={}){
 if(!(bytes instanceof Uint8Array)||bytes.length<57||!SIGNATURE.every((b,i)=>bytes[i]===b))throw unavailable();
 let at=8,header=null,palette=null,alpha=null;const data=[];let dataSize=0;
 while(at+12<=bytes.length){
  const length=u32(bytes,at),type=String.fromCharCode(...bytes.subarray(at+4,at+8));if(length>bytes.length-at-12)throw unavailable();const body=bytes.subarray(at+8,at+8+length);at+=12+length;
  if(!header&&type!=='IHDR')throw unavailable();
  if(type==='IHDR'){if(header||length!==13)throw unavailable();header={width:u32(body,0),height:u32(body,4),depth:body[8],color:body[9],compression:body[10],filter:body[11],interlace:body[12]};}
  else if(type==='PLTE'){if(length%3||length>768)throw unavailable();palette=body;}
  else if(type==='tRNS')alpha=body;
  else if(type==='IDAT'){data.push(body);dataSize+=length;}
  else if(type==='IEND')break;
 }
 const {width,height,depth,color,compression,filter,interlace}=header??{};
 if(!header||!width||!height||width>maxSide||height>maxSide||depth!==8||!(color in CHANNELS)||compression||filter||interlace||!dataSize||color===3&&!palette)throw unavailable();
 const channels=CHANNELS[color],stride=width*channels,joined=new Uint8Array(dataSize);let offset=0;for(const chunk of data){joined.set(chunk,offset);offset+=chunk.length;}
 const raw=await inflate(joined,height*(stride+1)),pixels=new Uint8Array(height*stride);
 for(let y=0;y<height;y++){
  const type=raw[y*(stride+1)],line=raw.subarray(y*(stride+1)+1,(y+1)*(stride+1)),row=y*stride,prior=row-stride;
  for(let x=0;x<stride;x++){
   const a=x>=channels?pixels[row+x-channels]:0,b=y?pixels[prior+x]:0,c=y&&x>=channels?pixels[prior+x-channels]:0;let value=line[x];
   if(type===1)value+=a;else if(type===2)value+=b;else if(type===3)value+=(a+b)>>1;
   else if(type===4){const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);value+=pa<=pb&&pa<=pc?a:pb<=pc?b:c;}
   else if(type!==0)throw unavailable();
   pixels[row+x]=value&255;
  }
 }
 const rgba=new Uint8Array(width*height*4);
 for(let i=0,j=0;i<width*height;i++,j+=channels){
  const o=i*4;
  if(color===0){rgba[o]=rgba[o+1]=rgba[o+2]=pixels[j];rgba[o+3]=255;}
  else if(color===2){rgba[o]=pixels[j];rgba[o+1]=pixels[j+1];rgba[o+2]=pixels[j+2];rgba[o+3]=255;}
  else if(color===3){const k=pixels[j];if(k*3+2>=palette.length)throw unavailable();rgba[o]=palette[k*3];rgba[o+1]=palette[k*3+1];rgba[o+2]=palette[k*3+2];rgba[o+3]=alpha&&k<alpha.length?alpha[k]:255;}
  else if(color===4){rgba[o]=rgba[o+1]=rgba[o+2]=pixels[j];rgba[o+3]=pixels[j+1];}
  else{rgba[o]=pixels[j];rgba[o+1]=pixels[j+1];rgba[o+2]=pixels[j+2];rgba[o+3]=pixels[j+3];}
 }
 return {width,height,rgba};
}
/** Centre cover-crop to a square, then an area-average resample to `size` × `size` (nearest when enlarging). */
export function squareResample({width,height,rgba},size){
 const side=Math.min(width,height),left=(width-side)/2,top=(height-side)/2,scale=side/size,out=new Uint8Array(size*size*4);
 for(let y=0;y<size;y++)for(let x=0;x<size;x++){
  const x0=left+x*scale,y0=top+y*scale,x1=Math.max(Math.floor(x0)+1,Math.ceil(x0+scale)),y1=Math.max(Math.floor(y0)+1,Math.ceil(y0+scale)),sum=[0,0,0,0];let n=0;
  for(let sy=Math.floor(y0);sy<Math.min(y1,height);sy++)for(let sx=Math.floor(x0);sx<Math.min(x1,width);sx++){const i=(sy*width+sx)*4,a=rgba[i+3];sum[0]+=rgba[i]*a;sum[1]+=rgba[i+1]*a;sum[2]+=rgba[i+2]*a;sum[3]+=a;n++;}
  const o=(y*size+x)*4;if(sum[3]){for(let c=0;c<3;c++)out[o+c]=Math.round(sum[c]/sum[3]);}out[o+3]=n?Math.round(sum[3]/n):0;
 }
 return out;
}
const CRC=(()=>{const table=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;table[n]=c>>>0;}return table;})();
const crc32=bytes=>{let c=0xffffffff;for(const byte of bytes)c=CRC[(c^byte)&255]^(c>>>8);return (c^0xffffffff)>>>0;};
const be=value=>[value>>>24&255,value>>>16&255,value>>>8&255,value&255];
const chunk=(type,data)=>{const body=new Uint8Array(4+data.length);for(let i=0;i<4;i++)body[i]=type.charCodeAt(i);body.set(data,4);return [new Uint8Array(be(data.length)),body,new Uint8Array(be(crc32(body)))];};
/** A fresh RGBA PNG with no ancillary chunks. */
export async function encodePNG(rgba,size){
 const raw=new Uint8Array(size*(size*4+1));for(let y=0;y<size;y++)raw.set(rgba.subarray(y*size*4,(y+1)*size*4),y*(size*4+1)+1);
 const compressed=new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
 return new Uint8Array(await new Blob([new Uint8Array(SIGNATURE),...chunk('IHDR',new Uint8Array([...be(size),...be(size),8,6,0,0,0])),...chunk('IDAT',compressed),...chunk('IEND',new Uint8Array())]).arrayBuffer());
}
/** Source bytes to served bytes: decode, crop, resample and re-encode. Throws `avatar_unavailable` on anything unexpected. */
export async function reencodeAvatar(bytes,size){
 if(!AVATAR_BUCKETS.includes(size))throw unavailable();
 try{return await encodePNG(squareResample(await decodePNG(bytes),size),size);}catch{throw unavailable();}
}
