// @vitest-environment happy-dom
// The browser client that projects copy into their own build.
import { test, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { createCounter, setCounterOff, isCounterOff, OFF_KEY } from '../client/counter.ts';

let sent: { url: string; body: unknown }[];
const send = (url: string, body: string) => { sent.push({ url, body: JSON.parse(body) }); };

beforeEach(() => {
  sent = [];
  localStorage.clear();
  Object.defineProperty(navigator, 'globalPrivacyControl', { value: undefined, configurable: true });
});

const counter = (o: Partial<Parameters<typeof createCounter>[0]> = {}) =>
  createCounter({ endpoint: 'https://stats.example/c/hit', project: 'quadern', send, isPhone: () => true, referrer: () => 'https://web.whatsapp.com/x', ...o });

test('an event goes to the endpoint with the project, device and fields', () => {
  counter().count('view', { page: 'b1-04', lang: 'es' });
  assert.deepEqual(sent, [{ url: 'https://stats.example/c/hit', body: { p: 'quadern', e: 'view', d: 'phone', r: 'web.whatsapp.com', props: { page: 'b1-04', lang: 'es' } } }]);
});

test('the referrer host goes only with the first event, and never the own site', () => {
  const c = counter();
  c.count('view', { page: 'plan' });
  c.count('view', { page: 'b1-04' });
  assert.equal((sent[0]?.body as { r?: string }).r, 'web.whatsapp.com');
  assert.equal((sent[1]?.body as { r?: string }).r, undefined);
  counter({ referrer: () => `${location.origin}/crema-catalana/` }).count('view');
  assert.equal((sent[2]?.body as { r?: string }).r, undefined);
  counter({ referrer: () => '' }).count('view');
  assert.equal((sent[3]?.body as { r?: string }).r, undefined);
});

test('"do not count my visits" and Global Privacy Control turn it off', () => {
  assert.equal(isCounterOff(), false);
  setCounterOff(true);
  assert.equal(localStorage.getItem(OFF_KEY), '1');
  assert.equal(isCounterOff(), true);
  counter().count('view');
  assert.equal(sent.length, 0);
  setCounterOff(false);
  assert.equal(localStorage.getItem(OFF_KEY), null);
  Object.defineProperty(navigator, 'globalPrivacyControl', { value: true, configurable: true });
  counter().count('view');
  assert.equal(sent.length, 0);
});

test('without an endpoint, or when sending fails, nothing breaks', () => {
  counter({ endpoint: '' }).count('view');
  assert.equal(sent.length, 0);
  counter({ send: () => { throw new Error('offline'); } }).count('view');
  counter({ isOff: () => { throw new Error('storage blocked'); } }).count('view');
});
