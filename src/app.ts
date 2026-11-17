import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Forge, HttpError } from './store.ts';
import { rest } from './rest.ts';
import { gitRequest } from './git.ts';
import { createGraphQL } from './graphql.ts';
import { mcp } from './mcp.ts';

export function createApp({ token = process.env.MAKEFUN_SHOP_TOKEN, login = process.env.FORGE_LOGIN } = {}) {
  if (!token) throw Error('MAKEFUN_SHOP_TOKEN must be set');
  const forge = new Forge(login || null), graph = createGraphQL(forge);
  const expected = Buffer.from(`Bearer ${token}`); let requestNumber = 0;
  const server = createServer(async (req, res) => {
    res.setHeader('x-github-request-id', (++requestNumber).toString(16).padStart(16, '0'));
    const json = (status, body, headers = {}) => {
      const bytes = status === 204 ? '' : JSON.stringify(body) + '\n';
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(bytes), ...headers }); res.end(bytes);
    };
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      if (req.method === 'GET' && url.pathname === '/healthz') return json(200, { ok: true });
      const auth = Buffer.from(req.headers.authorization || '');
      if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) return json(401, { message: 'Bad credentials' });
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 64 * 1024 * 1024) throw new HttpError(413, 'Request body too large'); chunks.push(chunk); }
      const raw = Buffer.concat(chunks);
      const git = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(url.pathname);
      if (git) {
        const repo = forge.repo(decodeURIComponent(git[1]), decodeURIComponent(git[2]));
        const advertise = git[3] === 'info/refs', service = advertise ? url.searchParams.get('service') : git[3];
        if (!['git-upload-pack', 'git-receive-pack'].includes(service) || (advertise ? req.method !== 'GET' : req.method !== 'POST')) throw new HttpError(404, 'Not Found');
        let data;
        try { data = gitRequest(repo, service, advertise, req.headers['git-protocol']?.includes('version=2'), raw); }
        catch (e) { throw new HttpError(400, e.message); }
        res.writeHead(200, { 'content-type': `application/x-${service}-${advertise ? 'advertisement' : 'result'}`, 'content-length': data.length, 'cache-control': 'no-cache' }); return res.end(data);
      }
      let body = {};
      if (raw.length) {
        try { body = JSON.parse(raw.toString()); }
        catch { return json(400, url.pathname === '/mcp' ? { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } : { message: 'Malformed JSON' }); }
      }
      if (url.pathname === '/mcp' && req.method === 'POST') { const result = mcp(forge, body); return result === null ? json(202, {}) : json(200, result); }
      if (url.pathname === '/api/graphql' && req.method === 'POST') return json(200, await graph(body));
      if (url.pathname === '/api/v3' || url.pathname.startsWith('/api/v3/')) {
        if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Expected JSON object');
        const out = rest(forge, req.method, url, body); return json(out.status, out.body, out.headers);
      }
      return json(404, { message: 'Not Found' });
    } catch (e) {
      if (!res.headersSent) json(e.status || 500, { message: e.status ? e.message : 'Internal server error' });
      else res.destroy();
      if (!e.status) process.stderr.write(`[forge] ${e.stack}\n`);
    }
  });
  server.requestTimeout = 30000; server.keepAliveTimeout = 60000;
  return { server, forge };
}
