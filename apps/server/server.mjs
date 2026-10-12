import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BindleEngine, Fault } from '../../packages/core/engine.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
export function createDemoServer() {
  const engine = new BindleEngine();
  const owner = 'https://3sln.example/subjects/demo';
  const storage = engine.addStorage(owner, 'Personal sync storage');
  engine.configure(owner, [storage]);
  return http.createServer(async (req, res) => {
    const respond = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(body));
    };
    try {
      // This unauthenticated fixture server is restricted to a loopback origin.
      const expectedHost = `127.0.0.1:${res.socket.localPort}`;
      if (req.headers.host !== expectedHost && req.headers.host !== `localhost:${res.socket.localPort}`) return respond(403, { error: 'invalid_host' });
      const origin = req.headers.origin;
      if (origin && origin !== `http://${req.headers.host}`) return respond(403, { error: 'invalid_origin' });
      const url = new URL(req.url, `http://${expectedHost}`);
      if (req.method === 'GET' && url.pathname === '/api/demo') return respond(200, engine.snapshot(owner));
      if (req.method === 'POST') {
        if (!req.headers['content-type']?.startsWith('application/json')) return respond(415, { error: 'json_required' });
        let body = ''; let bytes = 0;
        for await (const chunk of req) { bytes += chunk.length; if (bytes > 100000) return respond(413, { error: 'body_too_large' }); body += chunk; }
        let input; try { input = JSON.parse(body); } catch { return respond(400, { error: 'invalid_json' }); }
        if (url.pathname === '/api/demo/consent') return respond(200, engine.consent(owner, input.client, input));
        if (url.pathname === '/api/demo/preferences') { engine.configure(owner, input.storage); return respond(200, engine.snapshot(owner)); }
        if (url.pathname === '/api/demo/revoke') { engine.revoke(owner, input.id); return respond(200, { revoked: true }); }
        if (url.pathname === '/rpc') return respond(200, engine.rpc(req.headers.authorization?.replace(/^Bearer /, ''), input));
        return respond(404, { error: 'not_found' });
      }
      if (req.method !== 'GET') return respond(405, { error: 'method_not_allowed' });
      const pathname = decodeURIComponent(url.pathname);
      const relative = pathname === '/' ? 'apps/web/index.html' : pathname.startsWith('/vendor/') || pathname.startsWith('/packages/sdk/') ? pathname.slice(1) : `apps/web/${pathname.slice(1)}`;
      const file = resolve(root, relative);
      if (!file.startsWith(root) || !['.html', '.css', '.js', '.mjs', '.json'].includes(extname(file))) return respond(404, { error: 'not_found' });
      const content = await readFile(file);
      const type = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json' }[extname(file)];
      res.writeHead(200, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
      res.end(content);
    } catch (error) {
      if (error instanceof Fault) return respond(error.code === 'unauthorized' ? 401 : error.code === 'forbidden' ? 403 : 400, { error: error.code, message: error.message });
      if (error.code === 'ENOENT') return respond(404, { error: 'not_found' });
      respond(500, { error: 'internal_error' });
    }
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createDemoServer().listen(Number(process.env.PORT || 3000), '127.0.0.1', () => console.log('Bindle local prototype: http://127.0.0.1:' + (process.env.PORT || 3000)));
}
