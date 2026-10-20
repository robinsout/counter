// Counter process: node:http in front of the portable handler (src/app.ts).
// Configuration from the environment (deploy/counter.service, secrets in /etc/counter/env):
//   PORT (8788), HOST (127.0.0.1), DB_PATH ($STATE_DIRECTORY/counter.db), REGISTRY_PATH (../projects.json),
//   STATS_SECRET (required for /stats, set by Caddy), STATS_PASSWORD_SHA256 (hex), RATE_PER_MINUTE (300), TOTAL_PER_MINUTE (3000),
//   MAX_BODY_BYTES (4096), MAX_DB_MB (256), KEEP_DAYS (90)
// Requests are not logged: no addresses end up in the journal.
import { createServer, type IncomingMessage } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHandler } from './app.ts';
import { SqliteStore } from './store.ts';
import { RateLimiter } from './ratelimit.ts';
import { loadRegistry } from './registry.ts';

export interface ServerOptions {
  port: number;
  host: string;
  dbPath: string;
  registryPath: string;
  statsSecret: string | undefined;
  passwordSha256: string | undefined;
  perMinute: number;
  totalPerMinute: number;
  maxBodyBytes: number;
  maxDbBytes: number;
  keepDays: number;
}

// The proxy (Caddy) runs on this machine: trust X-Forwarded-For only from loopback.
function clientAddress(req: IncomingMessage): string {
  const remote = req.socket.remoteAddress ?? '';
  const fromProxy = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  const forwarded = req.headers['x-forwarded-for'];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
  return fromProxy && first ? first : remote;
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer | 'too large'> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) return 'too large';
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export async function startServer(o: ServerOptions): Promise<{ url: string; close: () => Promise<void> }> {
  const registry = loadRegistry(JSON.parse(readFileSync(o.registryPath, 'utf8')));
  const store = new SqliteStore(o.dbPath);
  const handle = createHandler({
    registry, store, statsSecret: o.statsSecret, passwordSha256: o.passwordSha256,
    limiter: new RateLimiter({ limit: o.perMinute, windowMs: 60_000 }),
    totalLimiter: new RateLimiter({ limit: o.totalPerMinute, windowMs: 60_000 }),
    maxBodyChars: o.maxBodyBytes, maxDbBytes: o.maxDbBytes, keepDays: o.keepDays,
  });

  const server = createServer(async (req, res) => {
    try {
      const body = req.method === 'POST' ? await readBody(req, o.maxBodyBytes) : null;
      if (body === 'too large') {
        res.writeHead(413, { 'content-type': 'application/json', 'cache-control': 'no-store', connection: 'close' }).end('{"error":"too large"}');
        req.destroy();
        return;
      }
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
      const request = new Request(`http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`, {
        method: req.method, headers, body: body && body.length ? new Uint8Array(body) : null,
      });
      const response = await handle(request, clientAddress(req));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (e) {
      console.error('request failed', e instanceof Error ? e.message : e);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":"internal"}');
    }
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;

  await new Promise<void>((resolve) => server.listen(o.port, o.host, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : o.port;
  return {
    url: `http://${o.host}:${port}`,
    close: () => new Promise((resolve) => server.close(() => { store.close(); resolve(); })),
  };
}

// started as a program: node src/main.ts
if (import.meta.url === `file://${process.argv[1]}`) {
  const env = process.env;
  if (!env.STATS_SECRET || env.STATS_SECRET.length < 32 || !env.STATS_PASSWORD_SHA256) {
    console.warn('STATS_SECRET or STATS_PASSWORD_SHA256 is not set: the stats page stays closed (deploy/install.sh --new-password)');
  }
  const server = await startServer({
    port: Number(env.PORT ?? 8788),
    host: env.HOST ?? '127.0.0.1',
    dbPath: env.DB_PATH ?? join(env.STATE_DIRECTORY ?? '.', 'counter.db'),
    registryPath: env.REGISTRY_PATH ?? fileURLToPath(new URL('../projects.json', import.meta.url)),
    statsSecret: env.STATS_SECRET,
    passwordSha256: env.STATS_PASSWORD_SHA256,
    perMinute: Number(env.RATE_PER_MINUTE ?? 300),
    totalPerMinute: Number(env.TOTAL_PER_MINUTE ?? 3000),
    maxBodyBytes: Number(env.MAX_BODY_BYTES ?? 4096),
    maxDbBytes: Number(env.MAX_DB_MB ?? 256) * 1024 * 1024,
    keepDays: Number(env.KEEP_DAYS ?? 90),
  });
  console.log(`counter listening on ${server.url}`);
  const stop = () => { server.close().then(() => process.exit(0)); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
