// Builds the stats page report from stored rows: the same general part for every project
// (days, devices, referrers) plus the panels the project describes in projects.json.
import type { Measure, Project, Props } from './registry.ts';
import type { DayTotal, Group } from './store.ts';
import { addDays } from './time.ts';

export interface Item { key: string; value: number }

export type PanelReport =
  | { type: 'pivot'; title: string; cols: string[]; rows: { key: string; cells: number[]; total: number }[] }
  | { type: 'top'; title: string; items: Item[] }
  | { type: 'score'; title: string; items: { key: string; attempts: number; percent: number }[] };

export interface Report {
  days: DayTotal[];
  visitorDays: number; // distinct visitors summed over days: a person counts once per day
  events: number;
  devices: Item[];
  refs: Item[];
  panels: PanelReport[];
}

const NONE = '—';
const OTHERS = 'другие';
const DEFAULT_LIMIT = 30;

export interface Limits { maxRows?: number; maxCols?: number }

const measureOf = (r: Group, m: Measure = 'events') => (m === 'visitors' ? r.visitors : r.n);
const field = (props: Props, name: string) => (props[name] === undefined ? NONE : String(props[name]));
const byValue = (a: Item, b: Item) => b.value - a.value || a.key.localeCompare(b.key);

function sums(rows: Group[], key: (r: Group) => string | null, value: (r: Group) => number): Item[] {
  const m = new Map<string, number>();
  for (const r of rows) {
    const k = key(r);
    if (k !== null) m.set(k, (m.get(k) ?? 0) + value(r));
  }
  return [...m].map(([k, v]) => ({ key: k, value: v })).sort(byValue);
}

// Big tables are cut to the largest rows and columns (the rest are summed as «другие»): a flood of
// made-up values cannot turn the page into megabytes.
export function buildReport(project: Project, rows: Group[], dayTotals: DayTotal[], range: { from: string; to: string },
  { maxRows = 50, maxCols = 12 }: Limits = {}): Report {
  const byDay = new Map(dayTotals.map((d) => [d.day, d]));
  const days: DayTotal[] = [];
  for (let d = range.from; d <= range.to; d = addDays(d, 1)) days.push(byDay.get(d) ?? { day: d, visitors: 0, events: 0 });

  const panels = project.panels.map((panel): PanelReport => {
    const of = rows.filter((r) => r.event === panel.event);
    if (panel.type === 'pivot') {
      const keep = (items: Item[], max: number) => new Set(items.slice(0, max).map((i) => i.key));
      const colKeep = keep(sums(of, (r) => field(r.props, panel.cols), (r) => measureOf(r, panel.measure)), maxCols);
      const rowKeep = keep(sums(of, (r) => field(r.props, panel.rows), (r) => measureOf(r, panel.measure)), maxRows);
      const colOf = (r: Group) => (colKeep.has(field(r.props, panel.cols)) ? field(r.props, panel.cols) : OTHERS);
      const rowOf = (r: Group) => (rowKeep.has(field(r.props, panel.rows)) ? field(r.props, panel.rows) : OTHERS);
      const named = [...colKeep].sort();
      const cols = of.some((r) => colOf(r) === OTHERS) ? [...named, OTHERS] : named;
      const index = new Map(cols.map((c, i) => [c, i]));
      const table = new Map<string, number[]>();
      for (const r of of) {
        const cells = table.get(rowOf(r)) ?? cols.map(() => 0);
        const i = index.get(colOf(r)) ?? 0;
        cells[i] = (cells[i] ?? 0) + measureOf(r, panel.measure);
        table.set(rowOf(r), cells);
      }
      const out = [...table].map(([key, cells]) => ({ key, cells, total: cells.reduce((a, b) => a + b, 0) }))
        .sort((a, b) => Number(a.key === OTHERS) - Number(b.key === OTHERS) || b.total - a.total || a.key.localeCompare(b.key));
      return { type: 'pivot', title: panel.title, cols, rows: out };
    }
    if (panel.type === 'top') {
      const items = sums(of, (r) => panel.props.map((p) => field(r.props, p)).join(' · '), (r) => measureOf(r, panel.measure));
      return { type: 'top', title: panel.title, items: items.slice(0, panel.limit ?? DEFAULT_LIMIT) };
    }
    const acc = new Map<string, { attempts: number; score: number; total: number }>();
    for (const r of of) {
      const key = panel.rows.map((p) => field(r.props, p)).join(' · ');
      const a = acc.get(key) ?? { attempts: 0, score: 0, total: 0 };
      a.attempts += r.n;
      a.score += Number(r.props[panel.score] ?? 0) * r.n;
      a.total += Number(r.props[panel.total] ?? 0) * r.n;
      acc.set(key, a);
    }
    const items = [...acc].map(([key, a]) => ({ key, attempts: a.attempts, percent: a.total ? Math.round((100 * a.score) / a.total) : 0 }))
      .sort((a, b) => b.attempts - a.attempts || a.key.localeCompare(b.key));
    return { type: 'score', title: panel.title, items: items.slice(0, maxRows) };
  });

  return {
    days,
    visitorDays: days.reduce((s, d) => s + d.visitors, 0),
    events: days.reduce((s, d) => s + d.events, 0),
    devices: sums(rows, (r) => r.device, (r) => r.n),
    refs: sums(rows, (r) => r.ref, (r) => r.n).slice(0, DEFAULT_LIMIT),
    panels,
  };
}
