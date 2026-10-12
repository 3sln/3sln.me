import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { transform } from 'esbuild';
import { fileURLToPath } from 'node:url';

const packageRoot = new URL('../node_modules/hash-wasm/', import.meta.url);
const destination = new URL('../vendor/hash-wasm/', import.meta.url);
const pkg = JSON.parse(await readFile(new URL('package.json', packageRoot), 'utf8'));
if (pkg.version !== '4.12.0') throw new Error('Review the static WASM adaptation before updating hash-wasm');
let source = await readFile(new URL('dist/index.esm.js', packageRoot), 'utf8');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const provenance = { package: 'hash-wasm', version: pkg.version, source: 'https://registry.npmjs.org/hash-wasm/-/hash-wasm-4.12.0.tgz',
  upstream: 'https://github.com/Daninet/hash-wasm', license: 'MIT', originalSourceSha256: digest(source),
  adaptation: 'Original Argon2id and BLAKE2b retained; WASMInterface selects statically imported modules instead of runtime WebAssembly.compile. Public exports narrowed to argon2id and argon2Verify.', binaries: {} };
await mkdir(destination, { recursive: true });
for (const name of ['argon2', 'blake2b']) {
  const match = new RegExp(`var name(\\$[a-z]+)? = "${name}";\\nvar data(?:\\$[a-z]+)? = "([A-Za-z0-9+/=]+)";`).exec(source);
  if (!match) throw new Error(`Cannot extract maintained ${name} module`);
  const bytes = Buffer.from(match[2], 'base64');
  // Validate extracted assets during preparation, outside the Worker runtime.
  if (!WebAssembly.validate(bytes)) throw new Error(`Invalid ${name} module`);
  await writeFile(new URL(`${name}.wasm`, destination), bytes);
  provenance.binaries[name] = { bytes: bytes.byteLength, sha256: digest(bytes) };
  source = source.replace(match[2], '');
}
const loading = `            if (!wasmModuleCache.has(binary.name)) {
                const asm = decodeBase64(binary.data);
                const promise = WebAssembly.compile(asm);
                wasmModuleCache.set(binary.name, promise);
            }
            const module = yield wasmModuleCache.get(binary.name);`;
if (source.split(loading).length !== 2) throw new Error('Upstream WASM loading seam changed');
source = source.replace(loading, `            const module = precompiledModules[binary.name];
            if (!module) throw new Error("Unsupported static hash module");`);
source = source.replace(/export \{[^}]+\};\s*$/, 'export { argon2id, argon2Verify };');
source = `import argon2Module from './argon2.wasm';\nimport blake2bModule from './blake2b.wasm';\nconst precompiledModules = {argon2: argon2Module, blake2b: blake2bModule};\n${source}`;
// Transform preserves the maintained algorithm. Tree shaking in Wrangler
// excludes unrelated exported hash functions; no runtime source evaluation.
const generated = await transform(source, { loader: 'js', format: 'esm', target: 'es2022', minify: false, legalComments: 'inline' });
if (generated.code.includes('WebAssembly.compile')) throw new Error('Dynamic WASM compilation survived adaptation');
await writeFile(new URL('argon2-workers.mjs', destination), generated.code);
await writeFile(new URL('LICENSE', destination), await readFile(new URL('LICENSE', packageRoot)));
await writeFile(new URL('PROVENANCE.json', destination), `${JSON.stringify(provenance, null, 2)}\n`);
console.log(`Prepared maintained Argon2 assets in ${fileURLToPath(destination)}`);
