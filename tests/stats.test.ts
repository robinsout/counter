// The report behind the stats page: days, devices, referrers and the project's own panels.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { buildReport } from '../src/stats.ts';
import { loadRegistry } from '../src/registry.ts';
import type { Row } from '../src/store.ts';

const project = loadRegistry({
  projects: [{
    id: 'quadern', name: 'Quadern', origins: ['https://robinsout.github.io'],
    events: {
      view: { page: 'id', lang: 'lang' },
      chapter: { lesson: 'id', chapter: 'id' },
      exercise: { lesson: 'id', exercise: 'id', score: 'int', total: 'int' },
    },
    panels: [
      { type: 'pivot', title: 'Pages', event: 'view', rows: 'page', cols: 'lang' },
      { type: 'pivot', title: 'Readers', event: 'view', rows: 'page', cols: 'lang', measure: 'visitors' },
      { type: 'top', title: 'Chapters', event: 'chapter', props: ['lesson', 'chapter'], measure: 'visitors', limit: 1 },
      { type: 'score', title: 'Exercises', event: 'exercise', rows: ['lesson', 'exercise'], score: 'score', total: 'total' },
    ],
  }],
}).projects[0]!;

const row = (day: string, event: string, props: Row['props'], n: number, visitors: number, device = 'phone', ref: string | null = null): Row =>
  ({ day, event, props, device, ref, n, visitors });

const rows: Row[] = [
  row('2026-10-19', 'view', { page: 'b1-04', lang: 'es' }, 5, 3, 'phone', 'web.whatsapp.com'),
  row('2026-10-20', 'view', { page: 'b1-04', lang: 'ru' }, 2, 1, 'desktop'),
  row('2026-10-20', 'view', { page: 'plan', lang: 'es' }, 1, 1),
  row('2026-10-20', 'chapter', { lesson: 'b1-04', chapter: 'dies' }, 4, 4),
  row('2026-10-20', 'chapter', { lesson: 'b1-04', chapter: 'apats' }, 2, 2),
  row('2026-10-20', 'exercise', { lesson: 'b1-04', exercise: 'rellotge', score: 8, total: 8 }, 1, 1),
  row('2026-10-20', 'exercise', { lesson: 'b1-04', exercise: 'rellotge', score: 4, total: 8 }, 3, 2),
];
const days = [{ day: '2026-10-19', visitors: 3, events: 5 }, { day: '2026-10-20', visitors: 6, events: 13 }];

const report = buildReport(project, rows, days, { from: '2026-10-18', to: '2026-10-20' });

test('every day of the range is there, empty days with zeros', () => {
  assert.deepEqual(report.days, [
    { day: '2026-10-18', visitors: 0, events: 0 },
    { day: '2026-10-19', visitors: 3, events: 5 },
    { day: '2026-10-20', visitors: 6, events: 13 },
  ]);
  assert.equal(report.visitorDays, 9);
  assert.equal(report.events, 18);
});

test('devices and referrers', () => {
  assert.deepEqual(report.devices, [{ key: 'phone', value: 16 }, { key: 'desktop', value: 2 }]);
  assert.deepEqual(report.refs, [{ key: 'web.whatsapp.com', value: 5 }]);
});

test('a pivot counts events, or visitors per day, by two fields', () => {
  const [pages, readers] = report.panels;
  assert.deepEqual(pages, {
    type: 'pivot', title: 'Pages', cols: ['es', 'ru'],
    rows: [{ key: 'b1-04', cells: [5, 2], total: 7 }, { key: 'plan', cells: [1, 0], total: 1 }],
  });
  assert.deepEqual(readers?.type === 'pivot' && readers.rows[0], { key: 'b1-04', cells: [3, 1], total: 4 });
});

test('a top list joins its fields and keeps the largest', () => {
  assert.deepEqual(report.panels[2], { type: 'top', title: 'Chapters', items: [{ key: 'b1-04 · dies', value: 4 }] });
});

test('a score panel gives attempts and the average result', () => {
  assert.deepEqual(report.panels[3], {
    type: 'score', title: 'Exercises', items: [{ key: 'b1-04 · rellotge', attempts: 4, percent: 63 }],
  });
});

test('big tables are cut to the largest rows and columns, the rest go to «others»', () => {
  const many: Row[] = [];
  for (let i = 0; i < 10; i++) for (let j = 0; j < 6; j++) many.push(row('2026-10-20', 'view', { page: `p${i}`, lang: `l${j}` }, 10 - i + (6 - j), 1));
  const r = buildReport(project, many, days, { from: '2026-10-20', to: '2026-10-20' }, { maxRows: 3, maxCols: 2 });
  const pivot = r.panels[0];
  assert.ok(pivot?.type === 'pivot');
  assert.deepEqual(pivot.cols, ['l0', 'l1', 'другие']);
  assert.deepEqual(pivot.rows.map((x) => x.key), ['p0', 'p1', 'p2', 'другие']);
  assert.equal(pivot.rows.reduce((s, x) => s + x.total, 0), many.reduce((s, x) => s + x.n, 0), 'nothing is lost');
});
