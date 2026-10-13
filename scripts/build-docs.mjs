import {readFile,writeFile,mkdir,rm,cp} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {marked} from 'marked';
import {publicDocumentation,publicMarkdown} from './public-docs.mjs';
const out=process.env.PUBLIC_DOCS_OUTPUT||'.output/public';
const escape=value=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
const style='body{margin:0;background:#f6f7f4;color:#24332f;font:17px/1.7 system-ui,sans-serif}header,main,footer{max-width:920px;margin:auto;padding:24px}header{border-bottom:1px solid #d5ded8}a{color:#175e52}h1,h2,h3{line-height:1.2}pre{overflow:auto;background:#e8eeea;padding:18px;border-radius:8px}code{font-size:.9em}table{border-collapse:collapse;width:100%;display:block;overflow:auto}td,th{border:1px solid #d5ded8;padding:10px;text-align:left}img{max-width:100%}nav{display:flex;gap:20px;flex-wrap:wrap}.intro{max-width:680px}.doc-list{padding-left:22px}.doc-list li{margin:8px 0}';
const shell=(title,body)=>`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" type="image/svg+xml" href="/icon.svg"><title>${escape(title)} · Bindle documentation</title><style>${style}</style></head><body><header><nav aria-label="Documentation"><a href="/">3sln.me</a><a href="/docs/">Documentation</a><a href="/docs/spec/protocol.html">Bindle spec</a><a href="/docs/self-hosting.html">Self-host</a><a href="/artefacts/contracts/object-storage/v1">Object storage contract</a></nav></header><main>${body}</main><footer><p>Bindle v0 is an open specification draft. Available features depend on provider configuration.</p><a href="https://github.com/3sln/3sln.me">Source code</a> · <a href="/llms.txt">Agent documentation index</a></footer></body></html>`;
// Remove previously generated development pages before publishing the allowlist.
await rm(join(out,'docs'),{recursive:true,force:true});
for(const name of ['DEVLOG.md','DEVLOG.html'])await rm(join(out,name),{force:true});
await mkdir(join(out,'docs'),{recursive:true});
for(const page of publicDocumentation){
 const markdown=publicMarkdown(await readFile(page.source,'utf8'),page.source),title=markdown.match(/^# (.+)/m)?.[1]||page.title;
 const html=marked.parse(markdown).replace(/(href="[^"]+)\.md(#[^"]*)?"/g,'$1.html$2"');
 const output=join(out,page.source.replace(/\.md$/,'.html'));await mkdir(dirname(output),{recursive:true});await writeFile(output,shell(title,html));await writeFile(join(out,page.source),markdown);
}
const groups=[...new Set(publicDocumentation.map(page=>page.group))];
await writeFile(join(out,'docs/index.html'),shell('Documentation','<h1>Build with Bindle and 3sln.me.</h1><p class="intro">Specifications, integration guides and self-hosting instructions for identities, preference fragments, resources and messaging.</p>'+groups.map(group=>`<section><h2>${escape(group)}</h2><ul class="doc-list">${publicDocumentation.filter(page=>page.group===group).map(page=>`<li><a href="/${escape(page.source.replace(/\.md$/,'.html'))}">${escape(page.title)}</a> · <a href="/${escape(page.source)}">Markdown</a></li>`).join('')}</ul></section>`).join('')));
await mkdir(join(out,'artefacts/contracts/object-storage'),{recursive:true});
await cp('docs/artefacts/object-storage-v1.json',join(out,'artefacts/contracts/object-storage/v1.json'));
for(const contract of ['preferences','profile','resource-descriptor','resource-scoping']){await mkdir(join(out,`artefacts/contracts/${contract}`),{recursive:true});await cp(`docs/artefacts/${contract}-v1.json`,join(out,`artefacts/contracts/${contract}/v1.json`));}
await cp('docs/artefacts/conversation-v1.json',join(out,'artefacts/conversation-v1.json'));
await writeFile(join(out,'llms.txt'),'# 3sln.me and Bindle developer documentation\n\nBindle v0 is an open specification draft. Available features depend on provider configuration.\n\n'+publicDocumentation.map(page=>`- [${page.title}](/${page.source})`).join('\n')+'\n\n- [Object storage schema](/artefacts/contracts/object-storage/v1.json)\n- [Source](https://github.com/3sln/3sln.me)\n');
await writeFile(join(out,'robots.txt'),'User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /users/\nDisallow: /device\nDisallow: /email/\nDisallow: /unsubscribe\n');
console.log(`Published ${publicDocumentation.length} curated English developer documents and canonical artefacts.`);
