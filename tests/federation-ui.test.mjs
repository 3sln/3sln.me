import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
test('federation consent renders and decisions use real dodo/ngin',()=>{const result=spawnSync(process.execPath,['--experimental-loader','./tests/browser/loader.mjs','tests/federation-dom.mjs'],{cwd:new URL('../',import.meta.url),encoding:'utf8',timeout:10000});assert.equal(result.status,0,result.stderr||result.stdout);});
