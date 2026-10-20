// The counter as a portable handler: (Request, client address) → Response.
//   POST /c/hit    an event from a project site (sendBeacon, text/plain JSON) → 204
//   GET  /c/health → { ok: true }
//   GET  /stats/   the stats page (?project=…&days=7|30|90|365). Two locks: the X-Counter-Stats secret that only
//                  the Caddy route of /stats/ adds, and the password (HTTP Basic). The password is a random
//                  144-bit one, so a fast SHA-256 is enough and a flood of tries costs nothing; the right password
//                  always gets in, so nobody can lock the owner out. Under /stats/ (not /stats) so that the
//                  browser sends the password only there, not with every request to the host.
import { createHash, timingSafeEqual } from 'node:crypto';
import { parseHit, type Registry } from './registry.ts';
import { comboKey, type SqliteStore } from './store.ts';
import { FailureCounter, RateLimiter } from './ratelimit.ts';
import { addDays, DailySalt, localDayHour, visitorId } from './time.ts';
import { buildReport } from './stats.ts';
import { PERIODS, renderPage } from './page.ts';

export interface HandlerOptions {
  registry: Registry;
  store: SqliteStore;
  limiter: RateLimiter; // events per client
  totalLimiter?: RateLimiter; // events from everyone together (only those that passed the per-client limit)
  maxNewCombosPerDay?: number; // new combinations of fields per project and day: caps made-up values
  statsSecret?: string; // set by Caddy on the route of /stats/ only; at least 32 characters
  passwordSha256?: string; // hex SHA-256 of the stats password
  failures?: FailureCounter; // wrong passwords per client
  wrongLimiter?: RateLimiter; // wrong passwords from everyone together
  anonLimiter?: RateLimiter; // requests to /stats/ without a password, per client
  now?: () => number;
  maxBodyChars?: number;
  maxDbBytes?: number; // past this size new events are dropped: protects the disk
  keepDays?: number; // raw events with fingerprints; older ones are summed by day
  keepDailyDays?: number; // daily sums
}

const BASE = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const PAGE_HEADERS = {
  ...BASE,
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'cross-origin-resource-policy': 'same-origin',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};
const ASK_PASSWORD = { 'www-authenticate': 'Basic realm="counter", charset="UTF-8"' };

const MIN_SECRET = 32;
const SHA256_RE = /^[0-9a-f]{64}$/;
const MINUTE = 60_000;

function equal(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

function sameSecret(given: string | null, secret: string | undefined): boolean {
  if (!secret || secret.length < MIN_SECRET || given === null) return false; // not configured: always closed
  return equal(Buffer.from(given), Buffer.from(secret));
}

// the password of "Authorization: Basic base64(user:password)"; the user name is ignored
function basicPassword(header: string | null): string | null {
  const m = /^Basic ([A-Za-z0-9+/=]{1,512})$/.exec(header ?? '');
  if (!m) return null;
  const decoded = Buffer.from(m[1] ?? '', 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  return i < 0 ? null : decoded.slice(i + 1);
}

// Limits count clients, not addresses: one IPv6 network /64 is one client (a single machine can rotate
// through all of it), an IPv4-mapped address is its IPv4.
export function clientKey(address: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return mapped[1] ?? address;
  if (!address.includes(':')) return address;
  const lower = address.toLowerCase();
  const [head = '', tail = ''] = lower.split('::');
  const left = head ? head.split(':') : [];
  const right = lower.includes('::') && tail ? tail.split(':') : [];
  const groups = lower.includes('::') ? [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

export function createHandler({
  registry, store, limiter, totalLimiter, statsSecret, passwordSha256, now = Date.now,
  maxBodyChars = 2048, maxDbBytes = Infinity, keepDays = 90, keepDailyDays = 3 * 365, maxNewCombosPerDay = 2000,
  failures = new FailureCounter({ limit: 5, windowMs: 15 * MINUTE, now }),
  wrongLimiter = new RateLimiter({ limit: 120, windowMs: MINUTE, now }),
  anonLimiter = new RateLimiter({ limit: 30, windowMs: MINUTE, now }),
}: HandlerOptions) {
  const expected = passwordSha256 && SHA256_RE.test(passwordSha256) ? Buffer.from(passwordSha256, 'hex') : null;
  const origins = new Set(registry.projects.flatMap((p) => p.origins));
  const salts = new DailySalt();
  const combos = new Map<string, { day: string; seen: Set<string> }>();
  let rolledFor = '';

  // once a day: sum up events older than keepDays (their fingerprints go) and drop very old sums
  const today = () => {
    const t = localDayHour(now());
    if (t.day !== rolledFor) {
      rolledFor = t.day;
      store.rollUp(addDays(t.day, -keepDays));
      store.purgeDailyBefore(addDays(t.day, -keepDailyDays));
    }
    return t;
  };

  // true when the combination is known today or there is still room for a new one
  const roomFor = (project: string, day: string, key: string) => {
    let c = combos.get(project);
    if (!c || c.day !== day) {
      c = { day, seen: new Set(store.combos(project, day)) };
      combos.set(project, c);
    }
    if (c.seen.has(key)) return true;
    if (c.seen.size >= maxNewCombosPerDay) return false;
    c.seen.add(key);
    return true;
  };

  return async function handle(request: Request, address: string): Promise<Response> {
    const url = new URL(request.url);
    const client = clientKey(address);
    const origin = request.headers.get('origin');
    const cors: Record<string, string> = origin && origins.has(origin) ? { 'access-control-allow-origin': origin, vary: 'Origin' } : { vary: 'Origin' };
    const json = (status: number, body?: unknown, extra: Record<string, string> = {}) => new Response(
      body === undefined ? null : JSON.stringify(body),
      { status, headers: { ...BASE, ...cors, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...extra } },
    );
    const tooMany = (wait: number) => json(429, { error: 'too many requests' }, { 'retry-after': String(wait) });

    if (url.pathname === '/c/health' && request.method === 'GET') return json(200, { ok: true });

    if (url.pathname === '/c/hit') {
      if (!origin || !origins.has(origin)) return json(403, { error: 'origin not allowed' });
      if (request.method === 'OPTIONS') {
        return json(204, undefined, { 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400' });
      }
      if (request.method !== 'POST') return json(405, { error: 'method not allowed' });
      // the total counts only what passed the per-client limit: one client cannot use it up
      const wait = limiter.check(client) || (totalLimiter?.check('*') ?? 0);
      if (wait > 0) return tooMany(wait);
      const text = await request.text();
      if (text.length > maxBodyChars) return json(413, { error: 'too large' });
      const parsed = parseHit(registry, origin, text);
      if (!parsed.ok) return json(parsed.error === 'origin not allowed' ? 403 : 400, { error: parsed.error });
      const { day, hour } = today();
      if (store.sizeBytes() > maxDbBytes) return json(507, { error: 'storage full' });
      if (!roomFor(parsed.hit.project, day, comboKey(parsed.hit))) return json(507, { error: 'too many distinct values today' });
      const visitor = visitorId(salts.for(day), address, request.headers.get('user-agent') ?? '', parsed.hit.project);
      store.record(parsed.hit, visitor, day, hour);
      return json(204);
    }

    if (url.pathname === '/stats/') {
      if (!sameSecret(request.headers.get('x-counter-stats'), statsSecret) || !expected) return json(403, { error: 'forbidden' });
      // another site must not make the owner's browser (which keeps the password) load the page
      const site = request.headers.get('sec-fetch-site');
      if (site !== null && site !== 'none' && site !== 'same-origin') return json(403, { error: 'forbidden' });
      const password = basicPassword(request.headers.get('authorization'));
      const right = password !== null && equal(createHash('sha256').update(password).digest(), expected);
      if (!right) {
        if (password === null) {
          const wait = anonLimiter.check(client);
          return wait > 0 ? tooMany(wait) : json(401, { error: 'password required' }, ASK_PASSWORD);
        }
        const wait = failures.blocked(client) || wrongLimiter.check('*');
        if (wait > 0) return tooMany(wait);
        failures.fail(client);
        return json(401, { error: 'password required' }, ASK_PASSWORD);
      }
      if (request.method !== 'GET') return json(405, { error: 'method not allowed' });
      const id = url.searchParams.get('project');
      const project = id === null ? registry.projects[0] : registry.byId.get(id);
      if (!project) return new Response('unknown project', { status: 404, headers: { ...BASE, 'content-type': 'text/plain; charset=utf-8' } });
      const asked = Number(url.searchParams.get('days'));
      const days = PERIODS.includes(asked) ? asked : 30;
      const { day } = today();
      const from = addDays(day, -(days - 1));
      const report = buildReport(project, store.groups(project.id, from), store.dailyVisitors(project.id, from), { from, to: day });
      return new Response(renderPage({ projects: registry.projects, project, days, report, today: day }), { status: 200, headers: PAGE_HEADERS });
    }

    return json(404, { error: 'not found' });
  };
}
