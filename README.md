# counter

A small self-hosted visit counter for the projects of [robinsout](https://github.com/robinsout): **no cookies, no IP addresses, no third-party scripts**. One service on our Hetzner machine, one stats page for all projects, one registry entry per project.

## What is counted, and what is not

Each project lists its events and their fields in [`projects.json`](projects.json); the server takes nothing else. Every event also gets:

- the **day and hour** (Barcelona time), never the exact time;
- the **device**: phone or computer (by screen width);
- the **referrer host** (`web.whatsapp.com`), only with the first event of a visit, never the full address;
- a **day-only visitor fingerprint**: SHA-256 of a random salt + address + browser + project, cut to 64 bits. The salt lives **only in memory** and changes every day, so the same person cannot be followed from one day to the next, and a leaked database cannot be matched against addresses. The address and browser string themselves are never stored.

Not stored, ever: IP addresses, the browser string, full URLs, form data, anything outside the project's schema. Raw events are kept 90 days, then summed by day (the fingerprints go away). Nothing is stored on the visitor's device except the opt-out switch they set themselves, so no consent banner is needed.

Visitors are not counted when they turn on "do not count my visits" (`localStorage` key `robinsout-counter-off`, one switch for all our projects on the same origin) or when their browser sends [Global Privacy Control](https://globalprivacycontrol.org/).

## Add a project

1. **Registry.** Add an entry to [`projects.json`](projects.json):
   ```json
   { "id": "my-project", "name": "My project", "origins": ["https://robinsout.github.io"],
     "events": { "view": { "page": "id", "lang": "lang" } },
     "panels": [{ "type": "pivot", "title": "Pages × language", "event": "view", "rows": "page", "cols": "lang" }] }
   ```
   Field types: `id` (`[a-z0-9-]`, up to 48 characters), `lang` (2–3 letters), `int` (0–100000), or a **list of allowed values** (`["ru", "en", "es"]`) — use a list wherever the set is known: made-up values then cannot get in at all. Panels: `pivot` (two fields, `measure`: `events` or `visitors`), `top` (fields joined, optional `limit`), `score` (attempts and average of `score` / `total`). The tests check the registry; `npm run deploy` to apply.
2. **Client.** Copy [`client/counter.ts`](client/counter.ts) into the project's own source. **Do not load it from the server**: all GitHub Pages sites of the account share the origin `robinsout.github.io` and its `localStorage`, so a script from elsewhere could read it.
   ```ts
   import { createCounter } from './counter.ts';
   const counter = createCounter({ endpoint: 'https://188.245.182.47/c/hit', project: 'my-project' });
   counter.count('view', { page: 'home', lang: 'en' });
   ```
   Leave `endpoint` empty in development and tests. **Send only fixed ids you control** — never a route parameter, a raw URL or user input (a route such as `#/<lang>/sync/:code` carries a secret that would pass as an id). Offer the opt-out: `setCounterOff(true)`.
3. **CSP.** Allow `https://188.245.182.47` in `connect-src` (sendBeacon is a connection).

## Stats page

**https://188.245.182.47/stats/** — any user name, the password from `install.sh --new-password`. Project and period (7, 30, 90, 365 days) are switches at the top.

## Security

- **Two locks on `/stats/`.** Caddy adds a secret header only on the route of `/stats/` (and strips it on the open route `/c/*`); the service refuses the page without it, so a mistake in the proxy routes or a path trick cannot open it. Then the password (HTTP Basic over HTTPS): a random 144-bit one, so a fast SHA-256 is safe to use and a flood of tries costs no CPU (a slow hash such as bcrypt would let a flood of wrong tries load the machine). Without a configured secret the page is closed; without a configured password it stays closed too, and only a request that passed the proxy's secret gets a page (503) with the command that sets the password.
- **Nobody can lock the owner out.** The right password always gets in. Wrong ones: five per client lock that client for 15 minutes, and 120 a minute from everyone together; requests without a password: 30 a minute per client. A client is an IPv4 address or an IPv6 /64 network.
- **Only below `/stats/`**, so the browser sends the remembered password only there, not with the events to `/c/hit`. Another site cannot make the owner's browser load the page (`Sec-Fetch-Site`, `Cross-Origin-Resource-Policy: same-origin`).
- **The password** is generated on the server, shown once to whoever runs the command, and stored only as a hash in `/etc/counter/env` (root only). It is not in this repository, in logs or anywhere else.
- **Artificial load.** Events: 300 a minute per client (a class behind one school Wi-Fi) and 3000 a minute in total, counting only what passed the per-client limit (429); bodies up to 8 KB at Caddy and 4 KB in the service (413); at most 2000 new combinations of fields per project and day, so made-up values cannot blow up the data (507); database up to 256 MB in use (507). The stats page shows at most 50 rows and 12 columns per table, the rest as «другие». Answers are tiny (204). Header size and request timeouts in Caddy and Node. The service may use at most 256 MB of memory, and under memory pressure it goes first, before the sync server and Caddy; no core dumps.
- **Stored XSS.** Values are limited to plain ids by the schema and escaped on the page; the page has no scripts and a `default-src 'none'` CSP, no framing, no referrer.
- **No logs of visitors.** The service logs no requests; Caddy has no access log.
- **Sandbox.** The systemd unit runs as a throwaway user with a read-only system, writes only to `/var/lib/counter`, and may talk only to localhost. Code in `/opt/counter` is read-only.
- **Fake events** can be sent by anyone who wants to (a counter cannot prove a browser is real); the limits above bound them, and they cannot carry anything but schema fields.
- **No runtime dependencies**: Node 24 built-ins only (`node:sqlite`, `node:http`, `node:crypto`).

## Deploy and operations

Runs next to the sync server of [crema-catalana](https://github.com/robinsout/crema-catalana) on the same machine and Caddy, which imports `/etc/caddy/routes.d/*.caddy`.

```sh
npm run deploy                                        # checks, rsync to /opt/counter, deploy/install.sh
ssh -t hetzner bash /opt/counter/deploy/install.sh --new-password   # run yourself: the password is shown once
ssh hetzner systemctl status counter
ssh hetzner journalctl -u counter -f
curl https://188.245.182.47/c/health
```

| | |
|---|---|
| Code | `/opt/counter` (read-only), Node 24 from `/opt/node/sync-current` |
| Database | `/var/lib/private/counter/counter.db` (SQLite, only the service) |
| Secrets | `/etc/counter/env` (root only): `STATS_SECRET`, `STATS_PASSWORD_SHA256` |
| Caddy routes | `/etc/caddy/routes.d/counter.caddy` (made by `install.sh`, kept only if Caddy validates and the sync server answers after the restart, else rolled back): `/c/*` → service, `/stats/*` → service with the secret header |
| Updates | `counter-update.timer`, Sundays: restart if the machine's Node got a new patch |
| Monitoring | `.github/workflows/monitor.yml`: daily health, and `/stats/` must refuse without a password |

## API

`POST /c/hit` — body `{ "p": project, "e": event, "d": "phone" | "desktop", "r"?: referrer host, "props"?: { … } }` as `text/plain` (sendBeacon, no CORS preflight) → 204 · `GET /c/health` → `{ "ok": true }` · `GET /stats/?project=…&days=…` (secret header + password).

## License

[PolyForm Noncommercial 1.0.0](LICENSE).
