import { createServer } from 'node:http';
import { Forge, HttpError } from './store.ts';
import { rest } from './rest.ts';
import { gitRequest } from './git.ts';
import { createGraphQL } from './graphql.ts';
import { mcp } from './mcp.ts';

export function createApp({ token = process.env.MAKEFUN_SHOP_TOKEN, login = process.env.FORGE_LOGIN } = {}) {
  if (!token) throw Error('MAKEFUN_SHOP_TOKEN must be set');
  const forge = new Forge(login || null), graph = createGraphQL(forge);
  const expected = `Bearer ${token}`; let requestNumber = 0;
  const server = createServer((req, res) => {
    res.setHeader('x-github-request-id', (++requestNumber).toString(16));
    const json = (status, body, headers = {}) => {
      const bytes = status === 204 ? '' : JSON.stringify(body) + '\n';
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(bytes), ...headers }); res.end(bytes);
    };
    const failure = e => {
      if (!res.headersSent) json(e.status || 500, { message: e.status ? e.message : 'Internal server error' });
      else res.destroy();
      if (!e.status) process.stderr.write(`[forge] ${e.stack}\n`);
    };
    const target = req.url || '/', query = target.indexOf('?');
    const pathname = query < 0 ? target : target.slice(0, query);
    try {
      if (req.method === 'GET' && pathname === '/healthz') return json(200, { ok: true });
      if (req.headers.authorization !== expected) return json(401, { message: 'Bad credentials' });
      if (req.method === 'GET') {
        const issue = /^\/api\/v3\/repos\/([^/?]+)\/([^/?]+)\/issues\/(\d+)(?:\?.*)?$/.exec(target);
        if (issue) {
          const repo = forge.repo(decodeURIComponent(issue[1]), decodeURIComponent(issue[2]));
          const x = forge.issue(repo, issue[3]);
          const bytes = x._jsonBuffer ||= Buffer.from(forge.issueJsonString(x));
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': bytes.length });
          return res.end(bytes);
        }
      }
    } catch (e) { failure(e); return; }
    void (async () => {
      let url;
      try {
      if (req.method === 'POST') {
        const issue = /^\/api\/v3\/repos\/([^/?]+)\/([^/?]+)\/issues(?:\?.*)?$/.exec(target);
        if (issue) {
          const chunks = []; let size = 0;
          for await (const chunk of req) { size += chunk.length; if (size > 64 * 1024 * 1024) throw new HttpError(413, 'Request body too large'); chunks.push(chunk); }
          let body;
          try { body = JSON.parse(Buffer.concat(chunks).toString()); }
          catch { return json(400, { message: 'Malformed JSON' }); }
          if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Expected JSON object');
          const repo = forge.repo(decodeURIComponent(issue[1]), decodeURIComponent(issue[2]));
          return json(201, forge.issueJson(forge.createIssue(repo, body)));
        }
      }
      if (!target.startsWith('/')) url = new URL(target);
      else {
        const origin = `http://${req.headers.host || 'localhost'}`;
        url = { pathname, searchParams: new URLSearchParams(query < 0 ? '' : target.slice(query + 1)), href: origin + target, toString() { return this.href; } };
      }
      const chunks = []; let size = 0;
      if (req.headers['content-length'] !== undefined || req.headers['transfer-encoding'] !== undefined) {
        for await (const chunk of req) { size += chunk.length; if (size > 64 * 1024 * 1024) throw new HttpError(413, 'Request body too large'); chunks.push(chunk); }
      }
      const raw = chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0);
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
        const out = rest(forge, req.method, url, body);
        if (out.raw !== undefined) { res.writeHead(out.status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(out.raw), ...out.headers }); return res.end(out.raw); }
        return json(out.status, out.body, out.headers);
      }
      return json(404, { message: 'Not Found' });
      } catch (e) { failure(e); }
    })();
  });
  server.requestTimeout = 30000; server.keepAliveTimeout = 60000;
  return { server, forge };
}
