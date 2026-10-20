// Fixed-window limit per client address, in memory: `limit` events per `windowMs` (same as crema-catalana's sync server).
export class RateLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  #windowStart = 0;
  #counts = new Map<string, number>();

  constructor({ limit, windowMs, now = () => Date.now() }: { limit: number; windowMs: number; now?: () => number }) {
    this.#limit = limit;
    this.#windowMs = windowMs;
    this.#now = now;
  }

  // counts an event; returns seconds to wait, or 0 when it may go through
  check(client: string): number {
    const t = this.#now();
    if (t - this.#windowStart >= this.#windowMs) {
      this.#windowStart = t;
      this.#counts.clear();
    }
    const n = (this.#counts.get(client) ?? 0) + 1;
    this.#counts.set(client, n);
    return n > this.#limit ? Math.ceil((this.#windowStart + this.#windowMs - t) / 1000) || 1 : 0;
  }
}

// Wrong passwords per client: after `limit` failures within `windowMs` (counted from the first one)
// the client is blocked until the window ends, even with the right password.
export class FailureCounter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  #fails = new Map<string, { n: number; since: number }>();

  constructor({ limit, windowMs, now = () => Date.now() }: { limit: number; windowMs: number; now?: () => number }) {
    this.#limit = limit;
    this.#windowMs = windowMs;
    this.#now = now;
  }

  // seconds the client still has to wait, or 0
  blocked(client: string): number {
    const f = this.#fails.get(client);
    if (!f) return 0;
    const left = f.since + this.#windowMs - this.#now();
    if (left <= 0) { this.#fails.delete(client); return 0; }
    return f.n >= this.#limit ? Math.ceil(left / 1000) : 0;
  }

  fail(client: string): void {
    const t = this.#now();
    if (this.#fails.size > 100_000) this.#fails.clear(); // a flood of addresses must not fill the memory
    const f = this.#fails.get(client);
    if (!f || t - f.since >= this.#windowMs) this.#fails.set(client, { n: 1, since: t });
    else f.n++;
  }
}
