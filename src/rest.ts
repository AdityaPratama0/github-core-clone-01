import { fail } from './store.ts';

export function rest(forge, method, url, body) {
  const parts = url.pathname.replace(/^\/api\/v3\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  const path = parts.join('/');
  const response = (status, body, headers = {}, raw) => ({ status, body, headers, raw });
  const ok = b => response(200, b);
  const created = b => response(201, b);
  const page = items => {
    const size = Math.max(1, Math.min(100, Number(url.searchParams.get('per_page')) || 30));
    const n = Math.max(1, Number(url.searchParams.get('page')) || 1), headers = {};
    if (n * size < items.length) { const next = new URL(url); next.searchParams.set('page', String(n + 1)); next.searchParams.set('per_page', String(size)); headers.link = `<${next.href}>; rel="next"`; }
    return response(200, items.slice((n - 1) * size, n * size), headers);
  };
  const filtered = items => { const state = url.searchParams.get('state') || 'open'; return items.filter(x => state === 'all' || x.state === state).sort((a, b) => url.searchParams.get('direction') === 'asc' ? a.number - b.number : b.number - a.number); };
  if (method === 'GET' && !path) return response(200, { current_user_url: '/api/v3/user', repository_url: '/api/v3/repos/{owner}/{repo}' }, { 'x-oauth-scopes': 'repo, read:org' });
  if (method === 'GET' && path === 'healthz') return ok({ ok: true });
  if (method === 'GET' && path === 'meta') return ok({ installed_version: 'forge-1.0.0' });
  if (method === 'GET' && path === 'user') return ok({ login: forge.owner || 'owner', id: 1 });
  if (path === 'user/repos') {
    if (method === 'POST') return created(forge.repoJson(forge.createRepo(body)));
    if (method === 'GET') return page([...forge.repos.values()].map(r => forge.repoJson(r)));
  }
  if (parts[0] !== 'repos' || parts.length < 3) fail(404, 'Not Found');
  const [, owner, name, area, value, extra] = parts, r = forge.repo(owner, name);
  if (parts.length === 3) {
    if (method === 'GET') return ok(forge.repoJson(r));
    if (method === 'DELETE') { forge.repos.delete(name); forge.nodes.delete(r.node_id); return response(204, null); }
    if (method === 'PATCH') { if (typeof body.description === 'string') r.description = body.description; if (body.default_branch) { if (!forge.tip(r, body.default_branch)) fail(422, 'Unknown branch'); r.default_branch = body.default_branch; r.packCache.clear(); } return ok(forge.repoJson(r)); }
  }
  if (area === 'contents') {
    const file = parts.slice(4).join('/');
    if (method === 'GET') return ok(forge.content(r, file, url.searchParams.get('ref') || undefined));
    if (method === 'PUT' || method === 'DELETE') return forge.putContent(r, file, body, method === 'DELETE');
  }
  if (area === 'branches' && method === 'GET') { const branches = [...r.refs].filter(([ref]) => ref.startsWith('refs/heads/')).map(([ref, sha]) => ({ name: ref.slice(11), commit: { sha } })); if (value) { const branch = branches.find(b => b.name === parts.slice(4).join('/')); if (!branch) fail(404, 'Not Found'); return ok(branch); } return page(branches); }
  if (area === 'commits' && method === 'GET') {
    const sha = forge.tip(r, value || url.searchParams.get('sha') || undefined); if (!sha) fail(404, 'Reference not found');
    const describe = id => { const c = r.objects.commit(id); return { sha: id, commit: { message: c.message, tree: { sha: c.tree } }, parents: c.parents.map(sha => ({ sha })) }; };
    if (value) return ok(describe(sha));
    const out = [], seen = new Set(), q = [sha]; while (q.length) { const id = q.shift(); if (seen.has(id)) continue; seen.add(id); out.push(describe(id)); q.push(...r.objects.commit(id).parents); } return page(out);
  }
  if (area === 'git') {
    const ref = parts.slice(5).join('/'), fullRef = ref.startsWith('refs/') ? ref : `refs/${ref}`;
    if (['ref', 'refs'].includes(value)) {
      if (method === 'POST' && parts.length === 5) { if (!/^refs\/(heads|tags)\/.+/.test(body.ref || '') || !r.objects.map.has(body.sha) || r.refs.has(body.ref)) fail(422, 'Invalid reference'); r.refs.set(body.ref, body.sha); r.packCache.clear(); return created({ ref: body.ref, object: { sha: body.sha, type: r.objects.get(body.sha).type } }); }
      if (method === 'GET') { const sha = r.refs.get(fullRef); if (!sha) fail(404, 'Not Found'); return ok({ ref: fullRef, object: { sha, type: r.objects.get(sha).type } }); }
      if (method === 'DELETE') { if (!r.refs.delete(fullRef)) fail(404, 'Not Found'); r.packCache.clear(); return response(204, null); }
      if (method === 'PATCH') { const old = r.refs.get(fullRef); if (!old) fail(404, 'Not Found'); if (!r.objects.map.has(body.sha) || !r.objects.ancestor(old, body.sha)) fail(422, 'Non-fast-forward'); r.refs.set(fullRef, body.sha); r.packCache.clear(); return ok({ ref: fullRef, object: { sha: body.sha } }); }
    }
  }
  if (area === 'labels') {
    if (method === 'GET') return page([...r.labels.values()]);
    if (method === 'POST') { if (!body.name || r.labels.has(body.name)) fail(422, 'Invalid label'); const l = { id: ++forge.sequence, name: body.name, color: body.color || 'ededed', description: body.description || '' }; r.labels.set(l.name, l); return created(l); }
  }
  if (area === 'issues') {
    if (!value) {
      if (method === 'POST') return created(forge.issueJson(forge.createIssue(r, body)));
      if (method === 'GET') return page(filtered([...r.issues.values()]).map(x => forge.issueJson(x)));
    } else {
      const x = forge.issue(r, value);
      if (extra === 'comments') { if (method === 'POST') return created(forge.comment(x, body)); if (method === 'GET') return page(x.comments); }
      if (!extra && method === 'GET') return response(200, null, {}, forge.issueJsonString(x));
      if (!extra && method === 'PATCH') { for (const key of ['title', 'body']) if (typeof body[key] === 'string') x[key] = body[key]; if (body.state) { if (!['open', 'closed'].includes(body.state)) fail(422, 'Invalid state'); x.state = body.state; } delete x._json; delete x._jsonBuffer; return ok(forge.issueJson(x)); }
    }
  }
  if (area === 'pulls') {
    if (!value) { if (method === 'POST') return created(forge.pullJson(forge.createPull(r, body))); if (method === 'GET') return page(filtered([...r.pulls.values()]).map(x => forge.pullJson(x))); }
    else {
      const x = forge.pull(r, value);
      if (!extra && method === 'GET') return ok(forge.pullJson(x));
      if (extra === 'files' && method === 'GET') return page(forge.files(x));
      if (extra === 'merge' && method === 'PUT') return ok(forge.merge(x, body));
      if (!extra && method === 'PATCH') { for (const key of ['title', 'body', 'state']) if (body[key] !== undefined) x[key] = body[key]; return ok(forge.pullJson(x)); }
    }
  }
  fail(404, 'Not Found');
}
