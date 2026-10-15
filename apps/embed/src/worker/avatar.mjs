// Island picture rasters (embed-islands §6.1–6.4). Runs in the island worker. Every state yields exactly one
// fixed-size raster per tile: a re-encoded avatar, the subject's monogram (profile Appendix A), or a fully
// transparent tile when there is no subject, so the document always performs one decode-and-swap per tile.
// Avatar bytes must be PNG or WebP by magic number (no SVG, no passthrough of other types).
import {monogramPattern,monogramColors,AVATAR_BUCKETS} from '../../../../packages/sdk/src/islands-protocol.mjs';

const CRC=(()=>{const table=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;table[n]=c>>>0;}return table;})();
const crc32=bytes=>{let c=0xffffffff;for(const byte of bytes)c=CRC[(c^byte)&255]^(c>>>8);return (c^0xffffffff)>>>0;};
const u32=value=>[value>>>24&255,value>>>16&255,value>>>8&255,value&255];
const chunk=(type,data)=>{const body=new Uint8Array(4+data.length);for(let i=0;i<4;i++)body[i]=type.charCodeAt(i);body.set(data,4);return [new Uint8Array(u32(data.length)),body,new Uint8Array(u32(crc32(body)))];};
async function deflate(bytes){const stream=new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));return new Uint8Array(await new Response(stream).arrayBuffer());}
const rgb=hex=>[1,3,5].map(i=>Number.parseInt(hex.slice(i,i+2),16));
/** Indexed-colour PNG (colour type 3, 8-bit). `palette` is [[r,g,b,a]…]; `pixel(x,y)` returns an index. */
export async function encodeIndexedPNG(size,palette,pixel){
  const raw=new Uint8Array(size*(size+1));for(let y=0;y<size;y++){const row=y*(size+1);raw[row]=0;for(let x=0;x<size;x++)raw[row+1+x]=pixel(x,y);}
  const ihdr=new Uint8Array([...u32(size),...u32(size),8,3,0,0,0]),plte=new Uint8Array(palette.flatMap(([r,g,b])=>[r,g,b])),trns=new Uint8Array(palette.map(c=>c[3]));
  return new Blob([new Uint8Array([137,80,78,71,13,10,26,10]),...chunk('IHDR',ihdr),...chunk('PLTE',plte),...chunk('tRNS',trns),...chunk('IDAT',await deflate(raw)),...chunk('IEND',new Uint8Array())],{type:'image/png'});
}
export const validBucket=size=>AVATAR_BUCKETS.includes(size);
/** The monogram tile: opaque square background (the element clips the shape), 5×5 cells, 12.5% inset. */
export function monogramPNG(subject,{size,scheme}){
  const pattern=monogramPattern(subject),colors=monogramColors(subject,scheme);if(!pattern||!validBucket(size))return transparentPNG(size);
  const cell=Math.floor(size*0.75/5),inset=Math.floor((size-cell*5)/2);
  return encodeIndexedPNG(size,[[...rgb(colors.background),255],[...rgb(colors.foreground),255]],(x,y)=>{const c=Math.floor((x-inset)/cell),r=Math.floor((y-inset)/cell);return c>=0&&c<5&&r>=0&&r<5&&pattern.cells[r*5+c]?1:0;});
}
export function transparentPNG(size){return encodeIndexedPNG(validBucket(size)?size:AVATAR_BUCKETS[0],[[0,0,0,0]],()=>0);}
/** Accepts only PNG or WebP by magic number. */
export async function rasterKind(blob){
  if(!(blob instanceof Blob)||!blob.size||blob.size>2*1024*1024)return null;const head=new Uint8Array(await blob.slice(0,12).arrayBuffer());
  if([137,80,78,71,13,10,26,10].every((b,i)=>head[i]===b))return 'image/png';
  if(String.fromCharCode(...head.subarray(0,4))==='RIFF'&&String.fromCharCode(...head.subarray(8,12))==='WEBP')return 'image/webp';return null;
}
/** Re-encodes server bytes to a PNG of exactly `size` px where the worker has a canvas; otherwise passes the
 * already server-re-encoded raster through after the magic check. Null on any failure (caller keeps the monogram). */
export async function reencodeAvatar(blob,size,{createImageBitmap=globalThis.createImageBitmap,OffscreenCanvas=globalThis.OffscreenCanvas}={}){
  const kind=await rasterKind(blob);if(!kind||!validBucket(size))return null;
  if(typeof createImageBitmap!=='function'||typeof OffscreenCanvas!=='function')return new Blob([blob],{type:kind});
  try{
    const bitmap=await createImageBitmap(blob),canvas=new OffscreenCanvas(size,size),context=canvas.getContext('2d');
    const scale=Math.max(size/bitmap.width,size/bitmap.height),w=bitmap.width*scale,h=bitmap.height*scale;
    context.drawImage(bitmap,(size-w)/2,(size-h)/2,w,h);bitmap.close?.();return await canvas.convertToBlob({type:'image/png'});
  }catch{return null;}
}
