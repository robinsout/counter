// The real process on a port: body limit, client address from the local proxy only, end-to-end hit → page.
import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { startServer } from '../src/main.ts';

const SITE = 'https://robinsout.github.io';
const SECRET = 'x'.repeat(40);
const PASSWORD = 'p'.repeat(24);
const AUTH = `Basic ${Buffer.from(`s:${PASSWORD}`).toString('base64')}`;
let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; });

async function start() {
  const dir = mkdtempSync(join(tmpdir(), 'counter-'));
  const registryPath = join(dir, 'projects.json');
  writeFileSync(registryPath, JSON.stringify({ projects: [{ id: 'quadern', name: 'Quadern', origins: [SITE], events: { view: { page: 'id' } }, panels: [{ type: 'top', title: 'Pages', event: 'view', props: ['page'] }] }] }));
  const s = await startServer({
    port: 0, host: '127.0.0.1', dbPath: join(dir, 'counter.db'), registryPath, statsSecret: SECRET, passwordSha256: createHash('sha256').update(PASSWORD).digest('hex'),
    perMinute: 100, totalPerMinute: 1000, maxBodyBytes: 512, maxDbBytes: 1e9, keepDays: 90,
  });
  close = s.close;
  return s.url;
}

test('a hit is counted and shows up on the page', async () => {
  const url = await start();
  const res = await fetch(`${url}/c/hit`, { method: 'POST', headers: { origin: SITE, 'content-type': 'text/plain' }, body: JSON.stringify({ p: 'quadern', e: 'view', d: 'phone', props: { page: 'b1-04' } }) });
  assert.equal(res.status, 204);
  const page = await fetch(`${url}/stats/`, { headers: { 'x-counter-stats': SECRET, authorization: AUTH } });
  assert.equal(page.status, 200);
  assert.ok((await page.text()).includes('b1-04'));
  assert.equal((await fetch(`${url}/stats/`)).status, 403);
});

test('a large body is cut off before it is read', async () => {
  const url = await start();
  const res = await fetch(`${url}/c/hit`, { method: 'POST', headers: { origin: SITE }, body: 'x'.repeat(10_000) });
  assert.equal(res.status, 413);
});

test('a broken registry stops the start', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'counter-'));
  const registryPath = join(dir, 'projects.json');
  writeFileSync(registryPath, '{"projects":[{"id":"Bad"}]}');
  await assert.rejects(startServer({
    port: 0, host: '127.0.0.1', dbPath: ':memory:', registryPath, statsSecret: SECRET, passwordSha256: undefined,
    perMinute: 1, totalPerMinute: 1, maxBodyBytes: 1, maxDbBytes: 1, keepDays: 1,
  }), /projects.json/);
});
