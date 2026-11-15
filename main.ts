import { createApp } from './src/app.ts';

const envUrl = (process.env.MAKEFUN_ENV_URL || '').replace(/\/+$/, '');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  const { server } = createApp();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '0.0.0.0', resolve); });
  const port = server.address().port;
  if (port === 8080) throw Error('Ephemeral port conflicts with suite');
  const close = () => new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); });
  process.once('SIGTERM', () => { server.closeAllConnections(); server.close(() => process.exit(0)); });
  process.once('SIGINT', () => { server.closeAllConnections(); server.close(() => process.exit(0)); });
  if (!envUrl) { process.stdout.write(`http://127.0.0.1:${port}\n`); return; }
  let delay = 250;
  while (true) {
    try {
      const response = await fetch(`${envUrl}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ port }), signal: AbortSignal.timeout(30000) });
      await response.arrayBuffer();
      if (response.ok || response.status === 409) break;
    } catch {}
    await sleep(delay); delay = Math.min(2000, delay * 2);
  }
  delay = 250;
  while (true) {
    try {
      const response = await fetch(`${envUrl}/done`, { signal: AbortSignal.timeout(30000) });
      if (response.ok && (await response.json()).done === true) break;
      delay = 250;
    } catch { delay = Math.min(2000, delay * 2); }
    await sleep(delay);
  }
  await close();
}
main().catch(e => { process.stderr.write(`[entry] ${e.message}\n`); process.exit(1); });
