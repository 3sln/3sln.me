import { readFile } from 'node:fs/promises';
const status=JSON.parse(await readFile(new URL('../release-status.json',import.meta.url)));
const missing=Object.entries(status.gates).filter(([,passed])=>passed!==true).map(([name])=>name);
if(status.releaseReady!==true||missing.length){console.error('Production publication is blocked by unresolved release gates:\n'+missing.map(name=>' - '+name).join('\n'));process.exit(1);}
console.log('Recorded release gates are satisfied. Deployment still runs automated checks.');
