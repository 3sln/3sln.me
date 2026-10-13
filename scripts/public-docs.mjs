import path from 'node:path';
import {marked} from 'marked';
// Explicit publication boundary. Adding a development document cannot publish it.
export const publicDocumentation=Object.freeze([
 ['Start here','docs/integration.md','Application integration'],
 ['Start here','docs/self-hosting.md','Self-hosting'],
 ['Start here','docs/modules.md','Portal modules and commands'],
 ['Bindle specification','docs/spec/protocol.md','Protocol and discovery'],
 ['Bindle specification','docs/spec/federation-implementation.md','OAuth and RPC wire profile'],
 ['Bindle specification','docs/spec/auth.md','Authentication'],
 ['Bindle specification','docs/spec/contracts.md','Resources and preference fragments'],
 ['Bindle specification','docs/spec/resource-contributions.md','Application connections and tools'],
 ['Bindle specification','docs/spec/app-metadata.md','Application metadata'],
 ['Bindle specification','docs/spec/contact-tokens.md','Contact endpoints'],
 ['Bindle specification','docs/spec/messaging.md','Messages and collections'],
 ['Bindle specification','docs/spec/conversations.md','Conversations'],
 ['Bindle specification','docs/spec/security.md','Security boundaries'],
 ['Reference service','docs/spec/storage.md','Object storage'],
 ['Reference service','docs/spec/device-login.md','Device sign-in'],
 ['Reference service','docs/spec/identity-names.md','Identity names'],
 ['Reference service','docs/spec/recovery-identity.md','Identity recovery'],
 ['Reference service','docs/spec/recovery-file.md','Recovery file format'],
 ['Reference service','docs/spec/mcp-service.md','Agent connections'],
 ['Reference service','docs/spec/browser-automation.md','Browser automation'],
 ['Reference service','docs/spec/omni-search.md','Search'],
 ['Reference service','docs/spec/beaming.md','File transfers'],
 ['Reference service','docs/spec/notifications.md','Notifications'],
 ['Hosting and providers','docs/deployment/client-build.md','Client builds'],
 ['Hosting and providers','docs/deployment/federation.md','Provider federation configuration'],
 ['Hosting and providers','docs/deployment/google-drive.md','Google Drive configuration'],
 ['Hosting and providers','docs/deployment/mcp.md','Agent endpoint configuration'],
 ['Hosting and providers','docs/deployment/email.md','Email configuration'],
 ['Hosting and providers','docs/deployment/identity-backups.md','Identity authority and signup configuration'],
 ['Hosting and providers','docs/deployment/billing.md','Billing configuration'],
 ['Hosting and providers','docs/deployment/beaming.md','File transfer configuration'],
].map(([group,source,title])=>Object.freeze({group,source,title})));
const sources=new Set(publicDocumentation.map(page=>page.source));
const internalSections=/^(?:Sign-off checkpoints|Evidence and review|Evidence and gates|Verification and remaining release gates|Release verification|Current live verification|Operator provisioning history|Local verification history|Validation)$/i;
const trackingSentence=/(?:DEVLOG|release-status\.json|reviewer\s*[:/]?\s*___|decision sign.off|human (?:review|sign.off)|reviewer fields|reviewer \/ date|local service fixtures|independent.*(?:audit|review).*(?:passed|recorded)|validation.*\d+\/\d+)/i;
export function publicMarkdown(markdown,source){
 if(!sources.has(source))throw new TypeError('Document is outside the public allowlist.');
 const output=[];let skippedDepth=0;
 for(const token of marked.lexer(markdown)){
  if(token.type==='heading'){
   if(skippedDepth&&token.depth<=skippedDepth)skippedDepth=0;
   if(!skippedDepth&&internalSections.test(token.text)){skippedDepth=token.depth;continue;}
  }
  if(skippedDepth)continue;
  if(token.type==='table'&&token.header.some(cell=>/reviewer|review checkpoint/i.test(cell.text)))continue;
  let text=token.raw;
  // Mixed paragraphs often contain both operational requirements and review
  // bookkeeping. Remove only the tracking sentences, never the whole paragraph.
  if(token.type==='paragraph'){
   const trailing=text.match(/\s*$/)?.[0]||'';
   text=text.trimEnd().split(/(?<=[.!?])\s+(?=[A-Z`\[])/).filter(sentence=>!trackingSentence.test(sentence)).join(' ');
   if(!text)continue;
   text+=trailing;
  }
  // Keep code byte-for-byte; presentation links to unpublished tracking pages
  // become ordinary text rather than broken or accidentally public URLs.
  if(token.type!=='code')text=text.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,(whole,label,target)=>{
   if(/^(?:https?:|#|mailto:)/.test(target))return whole;
   const link=target.split('#')[0];
   if(!link.endsWith('.md'))return whole;
   const resolved=link.startsWith('/')?link.slice(1):path.posix.normalize(path.posix.join(path.posix.dirname(source),link));
   return sources.has(resolved)?whole:label;
  });
  output.push(text);
 }
 return output.join('');
}
