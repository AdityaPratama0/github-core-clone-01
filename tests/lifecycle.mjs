import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const kit = process.argv[2];
if (!kit) throw Error('Usage: node tests/lifecycle.mjs /path/to/kit [report.json]');
const { startEnv } = await import(pathToFileURL(resolve(kit, 'program/env/src/main.ts')).href);
const { scoreExport } = await import(pathToFileURL(resolve(kit, 'program/scorer/score.ts')).href);
const directory = mkdtempSync(join(tmpdir(), 'forge-lifecycle-'));
const runs = [], states = [];
try {
  for (let pass = 0; pass < 2; pass++) {
    const token = randomBytes(32).toString('hex');
    const stateDir = join(directory, String(pass));
    const env = await startEnv({ env: { MAKEFUN_SHOP_TOKEN: token }, stateDir, host: '127.0.0.1', port: 0, log: line => {
      if (line.includes(token)) throw Error('Credential in log');
      if (/export:|benchmark:|boot:/.test(line)) process.stderr.write(`[pass ${pass + 1}] ${line}\n`);
    } });
    let child;
    let timer;
    try {
      child = spawn(process.execPath, [resolve(import.meta.dirname, '../main.ts')], {
        cwd: resolve(import.meta.dirname, '..'),
        env: { PATH: process.env.PATH, MAKEFUN_SHOP_TOKEN: token, MAKEFUN_ENV_URL: `http://127.0.0.1:${env.address.port}` },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let diagnostics = '';
      child.stdout.on('data', b => { diagnostics += b; });
      child.stderr.on('data', b => { diagnostics += b; });
      const exited = new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', (code, signal) => resolve({ code, signal })); });
      const result = await Promise.race([
        Promise.all([env.done, exited]),
        new Promise((_, reject) => { timer = setTimeout(() => { child.kill('SIGKILL'); reject(Error('Lifecycle exceeded 120 seconds')); }, 120000); }),
      ]);
      const [outcome, exit] = result;
      assert.equal(exit.code, 0, diagnostics.replaceAll(token, '[redacted]'));
      assert.equal(exit.signal, null);
      assert.equal(outcome.registered, true);
      assert.equal(outcome.bootOk, true);
      assert.equal(outcome.passed, 120);
      assert.equal(outcome.total, 120);
      assert.equal(outcome.deadlineFallen, false);
      assert.equal(outcome.aborted, false);
      const state = readFileSync(join(stateDir, 'export/state.json'));
      const perf = readFileSync(join(stateDir, 'export/perf.json'), 'utf8');
      assert(!state.includes(token) && !perf.includes(token));
      const scored = scoreExport(state.toString(), perf);
      assert.equal(scored.scores.feature, 600);
      assert.equal(scored.scores.agent, 200);
      assert.equal(scored.scores.working, 1);
      assert.deepEqual(scored.notes, []);
      states.push(state);
      runs.push({ pass: pass + 1, exitCode: exit.code, registered: true, bootOk: true, passed: outcome.passed, total: outcome.total, scores: scored.scores, perf: JSON.parse(perf), stateSha256: createHash('sha256').update(state).digest('hex') });
    } finally {
      clearTimeout(timer);
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await env.stop('test cleanup');
    }
  }
  assert(states[0].equals(states[1]), 'Replay state exports differ');
  const report = { runtime: process.version, method: 'Official startEnv and scoreExport, actual main.ts child process, two fresh sequential runs', replayIdentical: true, stateBytes: states[0].length, runs };
  if (process.argv[3]) writeFileSync(process.argv[3], JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  rmSync(directory, { recursive: true, force: true });
}
