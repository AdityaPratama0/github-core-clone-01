import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApp } from '../src/app.ts';

const kit = process.argv[2];
if (!kit) throw Error('Usage: node tests/conformance.mjs /path/to/kit [report.json]');
const token = randomBytes(32).toString('hex');
const { server } = createApp({ token });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const child = spawn(process.execPath, ['--experimental-strip-types', resolve(kit, 'sdk/run.ts'), '--url', `http://127.0.0.1:${server.address().port}`, '--token', token, '--perf', '--json'], { stdio: ['ignore', 'pipe', 'inherit'] });
  let text = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => { text += chunk; });
  const code = await new Promise((resolve, reject) => { child.on('exit', resolve); child.on('error', reject); });
  if (code !== 0) throw Error(`Official runner exited ${code}`);
  if (text.includes(token)) throw Error('Refusing to persist credential');
  const report = JSON.parse(text);
  if (process.argv[3]) writeFileSync(process.argv[3], JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  const checks = report.checks || report.rows;
  if (!Array.isArray(checks) || checks.some(x => !x.ok)) process.exitCode = 1;
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
