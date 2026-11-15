import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { resolve } from 'node:path';

const token = randomBytes(32).toString('hex');
const child = spawn(process.execPath, [resolve(import.meta.dirname, '../main.ts')], {
  cwd: resolve(import.meta.dirname, '..'),
  env: { PATH: process.env.PATH, MAKEFUN_SHOP_TOKEN: token, FORGE_LOGIN: 'operator' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const exited = once(child, 'exit');
let diagnostics = '';
child.stderr.on('data', b => { diagnostics += b; });
let timer;
try {
  const base = await Promise.race([
    new Promise((resolve, reject) => {
      let text = '';
      child.stdout.on('data', b => {
        text += b;
        const match = /^http:\/\/127\.0\.0\.1:\d+$/m.exec(text);
        if (match) resolve(match[0]);
      });
      child.once('error', reject);
      child.once('exit', () => reject(Error('App exited before readiness')));
    }),
    new Promise((_, reject) => { timer = setTimeout(() => reject(Error('App readiness timeout')), 10000); }),
  ]);
  clearTimeout(timer);
  const request = async (path, method = 'GET', body, authenticated = true) => {
    const headers = { 'content-type': 'application/json' };
    if (authenticated) headers.authorization = `Bearer ${token}`;
    const response = await fetch(base + path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000),
    });
    assert(response.headers.get('x-github-request-id'));
    return { status: response.status, body: await response.json() };
  };
  assert.deepEqual(await request('/healthz', 'GET', undefined, false), { status: 200, body: { ok: true } });
  assert.equal((await request('/api/v3/user', 'GET', undefined, false)).status, 401);
  const repo = await request('/api/v3/user/repos', 'POST', { name: 'socket-smoke', private: true });
  assert.equal(repo.status, 201);
  assert.equal(repo.body.full_name, 'operator/socket-smoke');
  const rpc = await request('/mcp', 'POST', { jsonrpc: '2.0', id: 17, method: 'tools/call', params: {
    name: 'create_issue', arguments: { owner: 'operator', repo: 'socket-smoke', title: 'Socket verified', body: 'Shared state' },
  } });
  assert.equal(rpc.body.id, 17);
  assert.equal(rpc.body.result.isError, false);
  const issue = rpc.body.result.structuredContent;
  const read = await request(`/api/v3/repos/operator/socket-smoke/issues/${issue.number}`);
  assert.equal(read.body.id, issue.id);
  const graph = await request('/api/graphql', 'POST', { query: '{ repository(owner: "operator", name: "socket-smoke") { issues(first: 1) { nodes { title id } } } }' });
  assert.equal(graph.body.errors, undefined);
  assert.equal(graph.body.data.repository.issues.nodes[0].title, 'Socket verified');
  assert.equal(graph.body.data.repository.issues.nodes[0].id, issue.node_id);
  const git = await fetch(base + '/operator/socket-smoke.git/info/refs?service=git-upload-pack', {
    headers: { authorization: `Bearer ${token}`, 'git-protocol': 'version=2' }, signal: AbortSignal.timeout(5000),
  });
  assert.equal(git.status, 200);
  assert((await git.text()).startsWith('000eversion 2\n'));
  assert.equal((await request('/api/v3/repos/stranger/socket-smoke')).status, 404);
  child.kill('SIGTERM');
  assert.deepEqual(await exited, [0, null]);
  assert(!diagnostics.includes(token));
  console.log('PASS: main.ts socket, health, auth, REST, MCP to REST to GraphQL shared state, git v2, owner isolation, SIGTERM exit 0');
} finally {
  clearTimeout(timer);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await exited;
  }
}
