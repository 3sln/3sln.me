import { readFile,writeFile,mkdir,readdir,cp } from 'node:fs/promises';
import { dirname,join,relative } from 'node:path';
import { marked } from 'marked';
const escape=value=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
const pages=[];
async function walk(directory){for(const item of await readdir(directory,{withFileTypes:true})){const file=join(directory,item.name);if(item.isDirectory())await walk(file);else if(item.name.endsWith('.md'))pages.push(file);}}
await walk('docs');
pages.push('DEVLOG.md');
const style='body{margin:0;background:#f6f7f4;color:#24332f;font:17px/1.7 system-ui,sans-serif}header,main,footer{max-width:920px;margin:auto;padding:24px}header{border-bottom:1px solid #d5ded8}a{color:#175e52}h1,h2,h3{line-height:1.2}pre{overflow:auto;background:#e8eeea;padding:18px;border-radius:8px}code{font-size:.9em}table{border-collapse:collapse;width:100%;display:block;overflow:auto}td,th{border:1px solid #d5ded8;padding:10px;text-align:left}img{max-width:100%}.status{border-left:4px solid #b67e2b;padding:12px 20px;background:#f4eee2}nav{display:flex;gap:20px;flex-wrap:wrap}';
const shell=(title,body)=>`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · Bindle documentation</title><style>${style}</style></head><body><header><nav><a href="/">Personal space</a><a href="/docs/">Documentation</a><a href="/docs/spec/protocol.html">Bindle spec</a><a href="/docs/self-hosting.html">Self-host</a><a href="/artefacts/contracts/object-storage/v1">Object storage contract</a></nav></header><main>${body}</main><footer><p>Open implementation drafts. Publication and interoperability remain gated until verified.</p></footer></body></html>`;
await mkdir('.output/public/docs',{recursive:true});
for(const page of pages){const markdown=await readFile(page,'utf8');const title=markdown.match(/^# (.+)/m)?.[1]||page;const output=join('.output/public',page.replace(/\.md$/,'.html'));await mkdir(dirname(output),{recursive:true});await writeFile(output,shell(title,marked.parse(markdown).replace(/(href="[^"]+)\.md(#[^"]*)?"/g,'$1.html$2"')));await cp(page,join('.output/public',page));}
await writeFile('.output/public/docs/index.html',shell('Documentation','<h1>Build on an open personal space.</h1><p class="status">This is an implementation draft. Production release gates and independent audit findings remain visible.</p><ul>'+pages.filter(p=>!p.includes('/release/')).map(p=>`<li><a href="/${escape(p.replace(/\.md$/,'.html'))}">${escape(p.replace(/^docs\//,''))}</a> · <a href="/${escape(p)}">Markdown</a></li>`).join('')+'</ul><h2>Independent reviews</h2><ul>'+pages.filter(p=>p.includes('/release/')).map(p=>`<li><a href="/${escape(p.replace(/\.md$/,'.html'))}">${escape(p)}</a></li>`).join('')+'</ul>'));
await mkdir('.output/public/artefacts/contracts/object-storage',{recursive:true});
await cp('docs/artefacts/object-storage-v1.json','.output/public/artefacts/contracts/object-storage/v1.json');
await cp('docs/artefacts/conversation-v1.json','.output/public/artefacts/conversation-v1.json');
await writeFile('.output/public/llms.txt','# Personal Space / 3sln.me / Bindle\n\nOpen implementation draft; public federation not yet operational.\n\n'+pages.filter(p=>!p.includes('/release/')).map(p=>`- [${p}](/${p})`).join('\n')+'\n\n- [Object storage schema](/artefacts/contracts/object-storage/v1.json)\n- [Source](https://github.com/3sln/3sln.me)\n');
await writeFile('.output/public/robots.txt','User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /users/\nDisallow: /device\nDisallow: /email/\nDisallow: /unsubscribe\n');
console.log('Public HTML/Markdown documentation and canonical artefacts assembled.');
