// The counter as a portable handler: POST /c/hit takes events, GET /stats/ shows the page.
// /stats/ needs two things: the secret header that only the Caddy route of /stats/ adds (a mistake in the
// proxy routes cannot open it), and the password (HTTP Basic), checked here with limits on wrong tries.
import { test, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { clientKey, createHandler, type HandlerOptions } from '../src/app.ts';
import { SqliteStore } from '../src/store.ts';
import { RateLimiter } from '../src/ratelimit.ts';
import { loadRegistry } from '../src/registry.ts';

const SITE = 'https://robinsout.github.io';
const SECRET = 's'.repeat(43);
const PASSWORD = 'correct-horse-battery-staple-42';
const PASSWORD_SHA256 = createHash('sha256').update(PASSWORD).digest('hex');
const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
const registry = loadRegistry({
  projects: [
    { id: 'quadern', name: 'Quadern <de> català', origins: [SITE], events: { view: { page: 'id', lang: 'lang' } },
      panels: [{ type: 'pivot', title: 'Pages', event: 'view', rows: 'page', cols: 'lang' }] },
    { id: 'puntillo', name: 'Puntillo', origins: [SITE], events: { view: { page: 'id' } }, panels: [] },
  ],
});

let now: number;
let store: SqliteStore;
let handle: ReturnType<typeof createHandler>;

const make = (o: Partial<HandlerOptions> = {}) => createHandler({
  registry, store, now: () => now,
  limiter: new RateLimiter({ limit: 3, windowMs: 60_000, now: () => now }),
  maxBodyChars: 500, maxDbBytes: Infinity, statsSecret: SECRET, passwordSha256: PASSWORD_SHA256,
  ...o,
});

beforeEach(() => {
  now = Date.UTC(2026, 9, 20, 10, 0);
  store = new SqliteStore(':memory:');
  handle = make();
});

const hit = (body: unknown, { origin = SITE as string | null, client = '203.0.113.7', ua = 'Firefox' } = {}) =>
  handle(new Request('https://188.245.182.47/c/hit', {
    method: 'POST',
    headers: { 'content-type': 'text/plain;charset=UTF-8', 'user-agent': ua, ...(origin ? { origin } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }), client);

const get = (path: string, { secret = SECRET as string | null, auth = basic('stats', PASSWORD) as string | null, client = '127.0.0.1', site = null as string | null } = {}) =>
  handle(new Request(`https://188.245.182.47${path}`, {
    headers: {
      ...(secret ? { 'x-counter-stats': secret } : {}),
      ...(auth ? { authorization: auth } : {}),
      ...(site ? { 'sec-fetch-site': site } : {}),
    },
  }), client);

const view = (page: string, lang = 'ru') => ({ p: 'quadern', e: 'view', d: 'phone', props: { page, lang } });

test('health', async () => {
  const res = await get('/c/health');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test('an event is stored with a day fingerprint; the address itself is not', async () => {
  const res = await hit(view('b1-04'));
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), SITE);
  await hit(view('b1-04'), { client: '198.51.100.1' });
  await hit(view('b1-04'));
  const [row] = store.rows('quadern', '2026-10-01');
  assert.equal(row?.n, 3);
  assert.equal(row?.visitors, 2);
  assert.ok(!JSON.stringify(store.rows('quadern', '2026-10-01')).includes('203.0.113.7'));
});

test('bad events are refused and not stored', async () => {
  assert.equal((await hit({ p: 'quadern', e: 'view', d: 'phone', props: { page: '#/ru/sync/abc' } })).status, 400);
  assert.equal((await hit(view('b1-04'), { origin: 'https://evil.example' })).status, 403);
  assert.equal((await hit(view('b1-04'), { origin: null })).status, 403);
  assert.equal((await hit('x'.repeat(501))).status, 413);
  assert.equal(store.rawCount(), 0);
});

test('too many events from one address get 429, without using up the limit of everyone else', async () => {
  handle = make({ totalLimiter: new RateLimiter({ limit: 5, windowMs: 60_000, now: () => now }) });
  for (let i = 0; i < 3; i++) assert.equal((await hit(view('b1-04'))).status, 204);
  for (let i = 0; i < 20; i++) assert.equal((await hit(view('b1-04'))).status, 429);
  assert.equal((await hit(view('b1-04'), { client: '2.2.2.2' })).status, 204, 'the flood did not count against the total');
  assert.equal((await hit(view('b1-04'), { client: '3.3.3.3' })).status, 204);
  assert.equal((await hit(view('b1-04'), { client: '4.4.4.4' })).status, 429, 'the total limit itself still works');
});

test('IPv6 addresses of one /64 network count as one client', () => {
  assert.equal(clientKey('2001:db8:1:2:aaaa::1'), clientKey('2001:db8:1:2:bbbb:cccc:dddd:9'));
  assert.notEqual(clientKey('2001:db8:1:2::1'), clientKey('2001:db8:1:3::1'));
  assert.equal(clientKey('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(clientKey('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(clientKey('203.0.113.7'), '203.0.113.7');
});

test('a flood of made-up values cannot blow up the data: new combinations per day are capped', async () => {
  handle = make({ limiter: new RateLimiter({ limit: 1000, windowMs: 60_000 }), maxNewCombosPerDay: 3 });
  for (const page of ['a', 'b', 'c']) assert.equal((await hit(view(page))).status, 204);
  assert.equal((await hit(view('d'))).status, 507);
  assert.equal((await hit(view('a'))).status, 204, 'known combinations still count');
  handle = make({ limiter: new RateLimiter({ limit: 1000, windowMs: 60_000 }), maxNewCombosPerDay: 3 });
  assert.equal((await hit(view('e'))).status, 507, 'a restart remembers today\'s combinations');
  now += 86_400_000;
  assert.equal((await hit(view('e'))).status, 204, 'a new day starts over');
});

test('when the database is full, new events are dropped', async () => {
  handle = make({ maxDbBytes: 1 });
  assert.equal((await hit(view('b1-04'))).status, 507);
});

test('a CORS preflight is answered for the project sites only', async () => {
  const pre = (origin: string) => handle(new Request('https://188.245.182.47/c/hit', { method: 'OPTIONS', headers: { origin } }), '1.1.1.1');
  const ok = await pre(SITE);
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get('access-control-allow-origin'), SITE);
  assert.equal((await pre('https://evil.example')).status, 403);
});

test('the stats page shows a project chosen by a switch, escaped, with no outside resources', async () => {
  await hit(view('b1-04'));
  const res = await get('/stats/?project=quadern&days=30');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'none'/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('cross-origin-resource-policy'), 'same-origin');
  const html = await res.text();
  assert.ok(html.includes('Quadern &lt;de&gt; català'));
  assert.ok(!html.includes('<de>'));
  assert.ok(html.includes('href="?project=puntillo&amp;days=30"'));
  assert.ok(html.includes('b1-04'));
  assert.ok(!/(src|href)="https?:/.test(html), 'no outside scripts, styles or images');
});

test('the stats page picks the first project and 30 days by default, and refuses unknown ones', async () => {
  const html = await (await get('/stats/')).text();
  assert.match(html, /<h1>[^<]*Quadern/);
  assert.ok(html.includes('aria-current="page">30'));
  assert.equal((await get('/stats/?project=nope')).status, 404);
  assert.ok((await (await get('/stats/?days=99999')).text()).includes('aria-current="page">30'));
});

test('old events are rolled up when a hit sees a new day', async () => {
  await hit(view('b1-04'));
  now += 100 * 86_400_000;
  await hit(view('b1-05'));
  assert.equal(store.rawCount(), 1);
  assert.equal(store.rows('quadern', '2026-01-01').length, 2);
});

test('unknown paths and methods', async () => {
  assert.equal((await get('/nope')).status, 404);
  assert.equal((await get('/stats')).status, 404, 'only /stats/: the browser keeps the password for /stats/ alone');
  assert.equal((await handle(new Request('https://188.245.182.47/stats/', { method: 'POST' }), '1.1.1.1')).status, 403);
  assert.equal((await handle(new Request('https://188.245.182.47/stats/', { method: 'POST', headers: { 'x-counter-stats': SECRET, authorization: basic('stats', PASSWORD) } }), '1.1.1.1')).status, 405);
});

test('the stats page needs the secret from the proxy; without a configured secret or password it is always closed', async () => {
  assert.equal((await get('/stats/', { secret: null })).status, 403);
  assert.equal((await get('/stats/', { secret: 'wrong' })).status, 403);
  assert.equal((await get('/stats/', { secret: SECRET.slice(1) + 'x' })).status, 403);
  assert.equal((await get('/stats/')).status, 200);
  for (const o of [{ statsSecret: undefined }, { statsSecret: '' }, { statsSecret: 'short' }, { passwordSha256: undefined }, { passwordSha256: 'not-a-hash' }]) {
    handle = make(o);
    assert.equal((await get('/stats/', { secret: o.statsSecret ?? SECRET })).status, 403, JSON.stringify(o));
  }
});

test('a path trick does not reach the stats page from the open route', async () => {
  for (const path of ['/c/../stats/', '/c/%2e%2e/stats/', '/STATS/', '/stats']) {
    const res = await get(path, { secret: null });
    assert.notEqual(res.status, 200, path);
  }
});

test('another site cannot make the owner\'s browser load the page', async () => {
  assert.equal((await get('/stats/', { site: 'cross-site' })).status, 403);
  assert.equal((await get('/stats/', { site: 'same-site' })).status, 403);
  assert.equal((await get('/stats/', { site: 'none' })).status, 200);
  assert.equal((await get('/stats/', { site: 'same-origin' })).status, 200);
});

test('the stats page asks for the password', async () => {
  const none = await get('/stats/', { auth: null });
  assert.equal(none.status, 401);
  assert.match(none.headers.get('www-authenticate') ?? '', /^Basic realm="counter", charset="UTF-8"$/);
  assert.equal((await get('/stats/', { auth: basic('stats', 'wrong') })).status, 401);
  assert.equal((await get('/stats/', { auth: 'Basic !!!' })).status, 401);
  assert.equal((await get('/stats/', { auth: basic('anyone', PASSWORD) })).status, 200, 'the user name does not matter');
});

test('wrong passwords are limited per address, but the right password always gets in', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await get('/stats/', { auth: basic('s', `wrong${i}`), client: '9.9.9.9' })).status, 401);
  const locked = await get('/stats/', { auth: basic('s', 'wrong'), client: '9.9.9.9' });
  assert.equal(locked.status, 429);
  assert.ok(Number(locked.headers.get('retry-after')) > 0);
  assert.equal((await get('/stats/', { client: '9.9.9.9' })).status, 200, 'an attacker on a shared address cannot lock the owner out');
  now += 15 * 60_000 + 1;
  assert.equal((await get('/stats/', { auth: basic('s', 'wrong'), client: '9.9.9.9' })).status, 401, 'the window passes');
});

test('a flood of requests to the page cannot lock the owner out', async () => {
  for (let i = 0; i < 200; i++) await get('/stats/', { auth: null, client: `10.0.${i >> 8}.${i & 255}` });
  for (let i = 0; i < 200; i++) await get('/stats/', { auth: basic('s', `w${i}`), client: `10.1.${i >> 8}.${i & 255}` });
  assert.equal((await get('/stats/', { auth: basic('s', 'w'), client: '10.2.0.1' })).status, 429, 'wrong tries from everyone are limited');
  for (let i = 0; i < 40; i++) await get('/stats/', { auth: null, client: '10.3.0.1' });
  assert.equal((await get('/stats/', { auth: null, client: '10.3.0.1' })).status, 429, 'requests without a password are limited per address');
  assert.equal((await get('/stats/', { client: '10.4.0.1' })).status, 200);
  assert.equal((await get('/stats/', { client: '10.3.0.1' })).status, 200);
});
