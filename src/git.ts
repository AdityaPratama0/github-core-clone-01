import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO = '0'.repeat(40);
export const hash = (b) => createHash('sha1').update(b).digest('hex');
export const pkt = (x) => { const b = Buffer.from(x); if (b.length > 65516) throw Error('Oversize packet'); return Buffer.concat([Buffer.from((b.length + 4).toString(16).padStart(4, '0')), b]); };
export const flush = Buffer.from('0000');
export const delim = Buffer.from('0001');
export function packets(b) {
  let offset = 0; const lines = [];
  while (offset + 4 <= b.length) {
    const h = b.subarray(offset, offset + 4).toString();
    if (!/^[a-f0-9]{4}$/i.test(h)) break;
    const n = parseInt(h, 16); offset += 4;
    if (n <= 2) { lines.push(null); if (n === 0) break; continue; }
    if (n < 4 || offset + n - 4 > b.length) throw Error('Truncated packet');
    lines.push(b.subarray(offset, offset + n - 4)); offset += n - 4;
  }
  return { lines, offset };
}
export function allLines(b) {
  let pos = 0; const result = [];
  while (pos < b.length) { const p = packets(b.subarray(pos)); if (!p.offset) break; result.push(...p.lines.filter(Boolean).map(x => x.toString().replace(/\n$/, ''))); pos += p.offset; }
  return result;
}
const codes = { commit: 1, tree: 2, blob: 3, tag: 4 };
const types = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
export class Objects {
  map = new Map();
  put(type, data) { data = Buffer.from(data); const oid = hash(Buffer.concat([Buffer.from(`${type} ${data.length}\0`), data])); if (!this.map.has(oid)) this.map.set(oid, { type, data }); return oid; }
  get(oid) { const o = this.map.get(oid); if (!o) throw Error(`Missing object ${oid}`); return o; }
  commit(oid) { const o = this.get(oid); if (o.type !== 'commit') throw Error('Expected commit'); const [h, ...body] = o.data.toString().split('\n\n'); const lines = h.split('\n'); return { tree: lines.find(x => x.startsWith('tree '))?.slice(5), parents: lines.filter(x => x.startsWith('parent ')).map(x => x.slice(7)), message: body.join('\n\n').replace(/\n$/, '') }; }
  tree(oid) { const b = this.get(oid).data; const out = []; let p = 0; while (p < b.length) { const s = b.indexOf(32, p), n = b.indexOf(0, s); if (s < p || n < s || n + 21 > b.length) throw Error('Invalid tree'); out.push({ mode: b.subarray(p, s).toString(), name: b.subarray(s + 1, n).toString(), oid: b.subarray(n + 1, n + 21).toString('hex') }); p = n + 21; } return out; }
  files(oid) { const out = new Map(); if (!oid) return out; const walk = (id, prefix) => { for (const e of this.tree(id)) { if (e.mode === '40000' || e.mode === '040000') walk(e.oid, prefix + e.name + '/'); else out.set(prefix + e.name, e); } }; walk(this.commit(oid).tree, ''); return out; }
  makeTree(files) {
    const root = { files: new Map(), dirs: new Map() };
    for (const [path, e] of files) { const parts = path.split('/'); let node = root; for (const part of parts.slice(0, -1)) { if (!node.dirs.has(part)) node.dirs.set(part, { files: new Map(), dirs: new Map() }); node = node.dirs.get(part); } node.files.set(parts.at(-1), e); }
    const build = n => { const entries = [...n.files].map(([name, e]) => ({ name, mode: e.mode || '100644', oid: e.oid })); for (const [name, d] of n.dirs) entries.push({ name, mode: '40000', oid: build(d) }); entries.sort((a, b) => Buffer.compare(Buffer.from(a.name + (a.mode === '40000' ? '/' : '')), Buffer.from(b.name + (b.mode === '40000' ? '/' : '')))); return this.put('tree', Buffer.concat(entries.flatMap(e => [Buffer.from(`${e.mode} ${e.name}\0`), Buffer.from(e.oid, 'hex')]))); };
    return build(root);
  }
  makeCommit(files, parents, message, sequence) { const tree = this.makeTree(files); return this.put('commit', Buffer.from(`tree ${tree}\n${parents.map(p => `parent ${p}\n`).join('')}author Forge <forge@example.invalid> ${1700000000 + sequence} +0000\ncommitter Forge <forge@example.invalid> ${1700000000 + sequence} +0000\n\n${message}\n`)); }
  ancestor(old, next) { if (old === next) return true; const seen = new Set(), q = [next]; while (q.length) { const id = q.pop(); if (id === old) return true; if (seen.has(id)) continue; seen.add(id); const o = this.map.get(id); if (o?.type === 'commit') q.push(...this.commit(id).parents); } return false; }
  closure(roots, depth = Infinity, stop = new Set(), shallow = new Set()) {
    const ids = new Set(), boundaries = new Set(), best = new Map(); const q = [...roots].map(id => [id, 1]);
    while (q.length) { const [id, level] = q.shift(); if (stop.has(id) || (best.has(id) && best.get(id) <= level)) continue; best.set(id, level); const o = this.get(id); ids.add(id); if (o.type === 'commit') { const c = this.commit(id); q.push([c.tree, level]); if (level < depth && !shallow.has(id)) q.push(...c.parents.map(p => [p, level + 1])); else if (c.parents.length) boundaries.add(id); } else if (o.type === 'tree') { for (const e of this.tree(id)) if (e.mode !== '160000') q.push([e.oid, level]); } else if (o.type === 'tag') { q.push([/^object ([a-f0-9]{40})/m.exec(o.data.toString())[1], level]); } }
    return { ids, boundaries };
  }
  pack(ids) { const header = Buffer.alloc(12); header.write('PACK'); header.writeUInt32BE(2, 4); header.writeUInt32BE(ids.size, 8); const chunks = [header]; for (const id of ids) { const o = this.get(id); if (!o.packed) { let size = o.data.length; const h = []; let c = codes[o.type] * 16 + size % 16; size = Math.floor(size / 16); while (size) { h.push(c | 128); c = size % 128; size = Math.floor(size / 128); } h.push(c); o.packed = Buffer.concat([Buffer.from(h), deflateSync(o.data, { level: 1 })]); } chunks.push(o.packed); } const body = Buffer.concat(chunks); return Buffer.concat([body, Buffer.from(hash(body), 'hex')]); }
  unpack(b) {
    if (!b.length) return;
    if (b.length < 32 || b.subarray(0, 4).toString() !== 'PACK' || ![2, 3].includes(b.readUInt32BE(4))) throw Error('Invalid pack header');
    if (hash(b.subarray(0, -20)) !== b.subarray(-20).toString('hex')) throw Error('Pack checksum mismatch');
    const count = b.readUInt32BE(8); let pos = 12; const offsets = new Map(), pending = [];
    for (let i = 0; i < count; i++) { const start = pos; let c = b[pos++], size = c & 15, shift = 4; const type = (c >> 4) & 7; while (c & 128) { c = b[pos++]; size += (c & 127) * 2 ** shift; shift += 7; if (shift > 53) throw Error('Pack size overflow'); }
      let base;
      if (type === 6) { let x = b[pos++], dist = x & 127; while (x & 128) { x = b[pos++]; dist = (dist + 1) * 128 + (x & 127); } base = start - dist; }
      else if (type === 7) { base = b.subarray(pos, pos + 20).toString('hex'); pos += 20; }
      const inflated = inflateSync(b.subarray(pos, -20), { info: true, maxOutputLength: 64 * 1024 * 1024 }); const data = inflated.buffer; pos += inflated.engine.bytesWritten;
      if (data.length !== size) throw Error('Pack object size mismatch');
      if (types[type]) { const id = this.put(types[type], data); offsets.set(start, id); } else if (type === 6 || type === 7) pending.push({ start, base, data }); else throw Error('Invalid object type');
    }
    if (pos !== b.length - 20) throw Error('Trailing pack data');
    while (pending.length) { let progress = false; for (let i = pending.length - 1; i >= 0; i--) { const p = pending[i], id = typeof p.base === 'number' ? offsets.get(p.base) : p.base, base = this.map.get(id); if (!base) continue; const result = applyDelta(base.data, p.data); offsets.set(p.start, this.put(base.type, result)); pending.splice(i, 1); progress = true; } if (!progress) throw Error('Missing delta base'); }
  }
}
export function applyDelta(base, delta) {
  let p = 0; const variable = () => { let n = 0, shift = 0, c; do { if (p >= delta.length || shift > 49) throw Error('Invalid delta length'); c = delta[p++]; n += (c & 127) * 2 ** shift; shift += 7; } while (c & 128); return n; };
  if (variable() !== base.length) throw Error('Delta base length mismatch'); const length = variable(); if (length > 64 * 1024 * 1024) throw Error('Delta too large'); const out = Buffer.alloc(length); let w = 0;
  while (p < delta.length) { const op = delta[p++]; if (op & 128) { let off = 0, size = 0; for (let i = 0; i < 4; i++) if (op & (1 << i)) off += delta[p++] * 2 ** (8 * i); for (let i = 0; i < 3; i++) if (op & (16 << i)) size += delta[p++] * 2 ** (8 * i); if (!size) size = 65536; if (off + size > base.length || w + size > length) throw Error('Delta copy out of bounds'); base.copy(out, w, off, off + size); w += size; } else { if (!op || p + op > delta.length || w + op > length) throw Error('Invalid delta insert'); delta.copy(out, w, p, p + op); p += op; w += op; } }
  if (w !== length) throw Error('Delta output length mismatch'); return out;
}
export function sideband(b) { const parts = []; for (let p = 0; p < b.length; p += 60000) parts.push(pkt(Buffer.concat([Buffer.from([1]), b.subarray(p, p + 60000)]))); return Buffer.concat([...parts, flush]); }

export function gitRequest(repo, service, advertise, v2, body) {
  const store = repo.objects, refs = repo.refs;
  const head = `refs/heads/${repo.default_branch}`;
  const caps = `report-status side-band-64k delete-refs ofs-delta agent=forge/1.0 object-format=sha1`;
  if (advertise) {
    const advertiseKey = `advertise:${service}:${v2}`;
    const cached = repo.packCache.get(advertiseKey);
    if (cached) return cached;
    if (v2 && service === 'git-upload-pack') {
      const response = Buffer.concat(['version 2\n', 'agent=forge/1.0\n', 'ls-refs=unborn\n', 'fetch=shallow\n', 'object-format=sha1\n'].map(pkt).concat([flush]));
      repo.packCache.set(advertiseKey, response);
      return response;
    }
    const lines = [pkt(`# service=${service}\n`), flush]; const entries = [...refs]; if (service === 'git-upload-pack' && refs.has(head)) entries.unshift(['HEAD', refs.get(head)]);
    if (!entries.length) entries.push(['capabilities^{}', ZERO]);
    entries.forEach(([ref, sha], i) => lines.push(pkt(`${sha} ${ref}${i === 0 ? '\0' + (service === 'git-receive-pack' ? caps : `side-band-64k shallow ofs-delta symref=HEAD:${head} agent=forge/1.0`) : ''}\n`)));
    const response = Buffer.concat([...lines, flush]);
    repo.packCache.set(advertiseKey, response);
    return response;
  }
  if (service === 'git-receive-pack') {
    const p = packets(body), commands = p.lines.filter(Boolean).map(x => x.toString().split('\0')[0].trim().split(' '));
    let error = null; try { store.unpack(body.subarray(p.offset)); } catch (e) { error = e.message; }
    const reports = [pkt(`unpack ${error || 'ok'}\n`)];
    for (const [old, next, ref] of commands) {
      let reason = error;
      if (!/^refs\/(heads|tags)\/[\w./-]+$/.test(ref || '') || ref.includes('..') || ref.endsWith('/')) reason = 'invalid ref';
      else if ((refs.get(ref) || ZERO) !== old) reason = 'stale info';
      else if (next !== ZERO && !store.map.has(next)) reason = 'missing object';
      else if (next !== ZERO && old !== ZERO && !store.ancestor(old, next)) reason = 'non-fast-forward';
      if (!reason && next !== ZERO) { try { store.closure([next]); } catch { reason = 'missing object'; } }
      if (!reason) { if (next === ZERO) refs.delete(ref); else refs.set(ref, next); repo.packCache.clear(); }
      reports.push(pkt(`${reason ? 'ng' : 'ok'} ${ref}${reason ? ' ' + reason : ''}\n`));
    }
    const report = Buffer.concat([...reports, flush]); return p.lines[0]?.toString().includes('side-band-64k') ? sideband(report) : report;
  }
  const requestKey = `upload:${v2}:${body.toString('base64')}`;
  const requestCached = repo.packCache.get(requestKey);
  if (Buffer.isBuffer(requestCached)) return requestCached;
  const lines = allLines(body);
  if (lines.includes('command=ls-refs')) {
    const prefix = lines.filter(x => x.startsWith('ref-prefix ')).map(x => x.slice(11)); const out = [];
    const emit = (ref, oid, extra = '') => { if (!prefix.length || prefix.some(p => ref.startsWith(p))) out.push(pkt(`${oid} ${ref}${extra}\n`)); };
    if (refs.has(head)) emit('HEAD', refs.get(head), lines.includes('symrefs') ? ` symref-target:${head}` : ''); else if (lines.includes('unborn')) emit('HEAD', 'unborn', ` symref-target:${head}`);
    for (const [ref, oid] of refs) { let extra = ''; if (lines.includes('peel') && store.get(oid).type === 'tag') extra = ` peeled:${/^object (\w+)/m.exec(store.get(oid).data.toString())[1]}`; emit(ref, oid, extra); }
    const response = Buffer.concat([...out, flush]);
    repo.packCache.set(requestKey, response);
    return response;
  }
  const wants = lines.filter(x => x.startsWith('want ')).map(x => x.split(' ')[1]);
  const haves = lines.filter(x => x.startsWith('have ')).map(x => x.slice(5)).filter(id => store.map.has(id));
  const depth = Number(lines.find(x => x.startsWith('deepen '))?.slice(7)) || Infinity;
  const shallow = new Set(lines.filter(x => x.startsWith('shallow ')).map(x => x.slice(8)));
  const key = JSON.stringify([wants, haves, depth, [...shallow]]); let result = repo.packCache.get(key);
  if (!result) {
    // A shallow client's have commits do not imply possession of their ancestors.
    // Traverse the requested history first, then omit only objects the client owns.
    const held = store.closure(haves, Infinity, new Set(), shallow).ids;
    const walk = store.closure(wants, depth);
    for (const id of held) walk.ids.delete(id);
    result = { pack: store.pack(walk.ids), boundaries: [...walk.boundaries], responses: new Map() };
    if (repo.packCache.size > 16) repo.packCache.clear();
    repo.packCache.set(key, result);
  }
  if (!result.responses) result.responses = new Map();
  const responseKey = JSON.stringify([v2, lines.includes('command=fetch'), lines.some(x => x.includes('side-band-64k')), lines.some(x => x.startsWith('deepen '))]);
  const cached = result.responses.get(responseKey);
  if (cached) return cached;
  const sections = [];
  if (v2 || lines.includes('command=fetch')) {
    if (result.boundaries.length || lines.some(x => x.startsWith('shallow '))) { sections.push(pkt('shallow-info\n')); for (const id of result.boundaries) sections.push(pkt(`shallow ${id}\n`)); for (const l of lines.filter(x => x.startsWith('shallow '))) if (!result.boundaries.includes(l.slice(8))) sections.push(pkt(`unshallow ${l.slice(8)}\n`)); sections.push(delim); }
    sections.push(pkt('packfile\n'), sideband(result.pack));
  } else {
    if (depth !== Infinity) { for (const id of result.boundaries) sections.push(pkt(`shallow ${id}\n`)); sections.push(flush); }
    sections.push(pkt('NAK\n'));
    if (lines.some(x => x.includes('side-band-64k'))) sections.push(sideband(result.pack)); else sections.push(result.pack);
  }
  const response = Buffer.concat(sections);
  result.responses.set(responseKey, response);
  repo.packCache.set(requestKey, response);
  return response;
}
