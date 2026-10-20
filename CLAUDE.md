# counter

Cookieless self-hosted visit counter for robinsout projects. Read README.md first: what is counted, security, deploy.

- Stack: Node 24 built-ins only (`node:sqlite`, `node:http`, `node:crypto`), TypeScript run by Node directly (erasable syntax only, imports with `.ts`), Vitest with `node:assert/strict`. **No runtime dependencies.**
- TDD: a failing test in `tests/` first, then the code. `npm run check` = types + tests.
- Privacy rules are part of the contract and tested: no IP addresses, no browser strings, no full URLs stored; the daily salt only in memory; only schema fields (`projects.json`) get in.
- `/stats` has two locks (secret header from the Caddy route + password with a failure limit); never weaken either. Secrets live only in `/etc/counter/env` on the server, never in the repo, logs or chat.
- The client (`client/counter.ts`) is copied into each project, never served from the server (shared origin robinsout.github.io).
- Deploy: `npm run deploy` (ssh host `hetzner`). The machine's Caddy and Node come from robinsout/crema-catalana `deploy/`.
- Commits from robinsout@gmail.com with the personal key (set in this repo's local git config).
