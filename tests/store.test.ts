// Storage: events with a day-only visitor fingerprint, daily salts that are never kept, roll-up of old events.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { DailySalt, localDayHour, visitorId } from '../src/time.ts';
import { SqliteStore } from '../src/store.ts';
import type { Hit } from '../src/registry.ts';

const view = (page: string, lang = 'ru', device: Hit['device'] = 'phone', ref: string | null = null): Hit =>
  ({ project: 'quadern', event: 'view', device, ref, props: { page, lang } });

test('days and hours are counted in Barcelona time, across summer time', () => {
  assert.deepEqual(localDayHour(Date.UTC(2026, 9, 20, 22, 30)), { day: '2026-10-21', hour: 0 }); // CEST, +2
  assert.deepEqual(localDayHour(Date.UTC(2026, 11, 31, 22, 30)), { day: '2026-12-31', hour: 23 }); // CET, +1
  assert.deepEqual(localDayHour(Date.UTC(2026, 2, 29, 1, 30)), { day: '2026-03-29', hour: 3 });
});

test('a visitor fingerprint is stable within a day and project, and says nothing about the address', () => {
  const a = visitorId('salt-1', '203.0.113.7', 'Firefox', 'quadern');
  assert.equal(a, visitorId('salt-1', '203.0.113.7', 'Firefox', 'quadern'));
  assert.notEqual(a, visitorId('salt-2', '203.0.113.7', 'Firefox', 'quadern'));
  assert.notEqual(a, visitorId('salt-1', '203.0.113.8', 'Firefox', 'quadern'));
  assert.notEqual(a, visitorId('salt-1', '203.0.113.7', 'Firefox', 'other'));
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.ok(!a.includes('203'));
});

test('a salt lives one day and only in memory: the next day gets a new one', () => {
  const salts = new DailySalt();
  const s1 = salts.for('2026-10-20');
  assert.equal(salts.for('2026-10-20'), s1);
  assert.match(s1, /^[0-9a-f]{64}$/);
  assert.notEqual(salts.for('2026-10-21'), s1);
  assert.notEqual(new DailySalt().for('2026-10-20'), s1, 'a restart gets a fresh salt: nothing is stored');
});

test('events are grouped by day, event and fields, with events and distinct visitors', () => {
  const store = new SqliteStore(':memory:');
  store.record(view('b1-04'), 'v1', '2026-10-20', 9);
  store.record(view('b1-04'), 'v1', '2026-10-20', 10);
  store.record(view('b1-04'), 'v2', '2026-10-20', 10);
  store.record(view('b1-04', 'es'), 'v3', '2026-10-21', 8);
  store.record({ ...view('x'), project: 'other' }, 'v9', '2026-10-21', 8);
  const rows = store.rows('quadern', '2026-10-01');
  assert.deepEqual(rows.map((r) => [r.day, r.event, r.props, r.n, r.visitors]), [
    ['2026-10-20', 'view', { lang: 'ru', page: 'b1-04' }, 3, 2],
    ['2026-10-21', 'view', { lang: 'es', page: 'b1-04' }, 1, 1],
  ]);
  assert.deepEqual(store.rows('quadern', '2026-10-21').length, 1);
  assert.deepEqual(store.dailyVisitors('quadern', '2026-10-01'), [
    { day: '2026-10-20', visitors: 2, events: 3 },
    { day: '2026-10-21', visitors: 1, events: 1 },
  ]);
});

test('old events are rolled up into daily sums: the totals stay, the fingerprints go', () => {
  const store = new SqliteStore(':memory:');
  store.record(view('b1-04', 'ru', 'phone', 'google.com'), 'v1', '2026-06-01', 9);
  store.record(view('b1-04', 'ru', 'phone', 'google.com'), 'v2', '2026-06-01', 9);
  store.record(view('b1-04'), 'v3', '2026-10-20', 9);
  const before = store.rows('quadern', '2026-01-01');
  const visitorsBefore = store.dailyVisitors('quadern', '2026-01-01');
  assert.equal(store.rollUp('2026-07-22'), 2);
  assert.equal(store.rawCount(), 1);
  assert.deepEqual(store.rows('quadern', '2026-01-01'), before);
  assert.deepEqual(store.dailyVisitors('quadern', '2026-01-01'), visitorsBefore);
  assert.equal(store.rollUp('2026-07-22'), 0);
});

test('groups over a range sum the days; combinations of a day are listed for the cap', () => {
  const store = new SqliteStore(':memory:');
  store.record(view('b1-04'), 'v1', '2026-10-20', 9);
  store.record(view('b1-04'), 'v1', '2026-10-21', 9);
  store.record(view('b1-04', 'es'), 'v2', '2026-10-21', 9);
  assert.deepEqual(store.groups('quadern', '2026-10-01').map((g) => [g.event, g.props, g.n, g.visitors]), [
    ['view', { lang: 'es', page: 'b1-04' }, 1, 1],
    ['view', { lang: 'ru', page: 'b1-04' }, 2, 2],
  ]);
  assert.equal(store.combos('quadern', '2026-10-21').length, 2);
  assert.equal(store.combos('quadern', '2026-10-22').length, 0);
});

test('the size of the database does not count free pages left by deletions', () => {
  const store = new SqliteStore(':memory:');
  for (let i = 0; i < 3000; i++) store.record(view(`p${i}`), `v${i}`, '2026-06-01', 9);
  const full = store.sizeBytes();
  store.rollUp('2026-07-01');
  store.purgeDailyBefore('2026-07-01');
  assert.ok(store.sizeBytes() < full / 2, `${store.sizeBytes()} < ${full / 2}`);
});
