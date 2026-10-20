// counter client — copy this file into your project's build (do not load it from the server:
// on a shared origin such as robinsout.github.io a script from elsewhere could read its localStorage).
// No dependencies, no cookies; one small request per event, sent with sendBeacon.
//
//   const counter = createCounter({ endpoint: 'https://188.245.182.47/c/hit', project: 'my-project' });
//   counter.count('view', { page: 'home' });
//
// Fields must be listed for the event in projects.json of robinsout/counter, or the event is refused.
// https://github.com/robinsout/counter

export type Props = Record<string, string | number>;

export interface CounterOptions {
  endpoint: string; // empty: counting is off (development, tests)
  project: string;
  isOff?: () => boolean; // default: the "do not count my visits" switch in localStorage
  isPhone?: () => boolean;
  referrer?: () => string;
  send?: (url: string, body: string) => void;
}

// one switch for every project of the origin: whoever turns it off is not counted anywhere
export const OFF_KEY = 'robinsout-counter-off';

export function isCounterOff(): boolean {
  try { return localStorage.getItem(OFF_KEY) === '1'; } catch { return false; }
}

export function setCounterOff(off: boolean): void {
  try {
    if (off) localStorage.setItem(OFF_KEY, '1');
    else localStorage.removeItem(OFF_KEY);
  } catch { /* storage blocked: nothing to remember */ }
}

function beacon(url: string, body: string): void {
  // text/plain keeps it a "simple" request: no CORS preflight
  const blob = new Blob([body], { type: 'text/plain' });
  if (!navigator.sendBeacon?.(url, blob)) void fetch(url, { method: 'POST', body: blob, keepalive: true, credentials: 'omit' }).catch(() => {});
}

function refHost(referrer: string): string | undefined {
  try {
    const u = new URL(referrer);
    return u.host && u.host !== location.host ? u.hostname : undefined;
  } catch { return undefined; }
}

export function createCounter(o: CounterOptions): { count: (event: string, props?: Props) => void } {
  const isOff = o.isOff ?? isCounterOff;
  const isPhone = o.isPhone ?? (() => matchMedia('(max-width: 899px)').matches);
  const referrer = o.referrer ?? (() => document.referrer);
  const send = o.send ?? beacon;
  let first = true;
  return {
    count(event, props = {}) {
      try {
        if (!o.endpoint || isOff() || (navigator as { globalPrivacyControl?: boolean }).globalPrivacyControl === true) return;
        const r = first ? refHost(referrer()) : undefined;
        first = false;
        send(o.endpoint, JSON.stringify({ p: o.project, e: event, d: isPhone() ? 'phone' : 'desktop', ...(r ? { r } : {}), props }));
      } catch { /* counting must never break the page */ }
    },
  };
}
