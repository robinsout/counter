// SQLite storage (node:sqlite, no dependencies).
//   events         — recent events with the day-only visitor fingerprint (kept KEEP_DAYS)
//   daily          — older events summed by day, event, fields, device and referrer; no fingerprints
//   daily_visitors — distinct visitors per project and day, for the rolled-up days
//   (the daily salt of the fingerprints is never stored: see DailySalt in time.ts)
import { DatabaseSync } from 'node:sqlite';
import type { Hit, Props } from './registry.ts';

export interface Group {
  event: string;
  props: Props;
  device: string;
  ref: string | null;
  n: number;
  visitors: number; // distinct visitors per day, summed over the days
}

export interface Row extends Group {
  day: string;
}

export interface DayTotal {
  day: string;
  visitors: number;
  events: number;
}

// sorted keys: the same fields always give the same text, so they group together
export function canonical(props: Props): string {
  return JSON.stringify(Object.fromEntries(Object.entries(props).sort(([a], [b]) => a.localeCompare(b))));
}

export class SqliteStore {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA journal_size_limit = 8388608;
      CREATE TABLE IF NOT EXISTS events (
        project TEXT NOT NULL, day TEXT NOT NULL, hour INTEGER NOT NULL, event TEXT NOT NULL,
        props TEXT NOT NULL, device TEXT NOT NULL, ref TEXT, visitor TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_project_day ON events (project, day);
      CREATE TABLE IF NOT EXISTS daily (
        project TEXT NOT NULL, day TEXT NOT NULL, event TEXT NOT NULL, props TEXT NOT NULL,
        device TEXT NOT NULL, ref TEXT, n INTEGER NOT NULL, visitors INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS daily_project_day ON daily (project, day);
      CREATE TABLE IF NOT EXISTS daily_visitors (
        project TEXT NOT NULL, day TEXT NOT NULL, visitors INTEGER NOT NULL, events INTEGER NOT NULL,
        PRIMARY KEY (project, day));
    `);
  }

  record(hit: Hit, visitor: string, day: string, hour: number): void {
    this.#db.prepare('INSERT INTO events (project, day, hour, event, props, device, ref, visitor) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(hit.project, day, hour, hit.event, canonical(hit.props), hit.device, hit.ref, visitor);
  }

  rows(project: string, fromDay: string): Row[] {
    const rows = this.#db.prepare(`
      SELECT day, event, props, device, ref, COUNT(*) AS n, COUNT(DISTINCT visitor) AS visitors
        FROM events WHERE project = ? AND day >= ? GROUP BY day, event, props, device, ref
      UNION ALL
      SELECT day, event, props, device, ref, n, visitors FROM daily WHERE project = ? AND day >= ?
      ORDER BY day, event, props, device, ref`).all(project, fromDay, project, fromDay) as unknown as (Omit<Row, 'props'> & { props: string })[];
    return rows.map((r) => ({ ...r, props: JSON.parse(r.props) as Props })); // plain objects, not null-prototype rows
  }

  // the same groups summed over the whole range: what the panels of the stats page need
  groups(project: string, fromDay: string): Group[] {
    const rows = this.#db.prepare(`
      SELECT event, props, device, ref, SUM(n) AS n, SUM(visitors) AS visitors FROM (
        SELECT day, event, props, device, ref, COUNT(*) AS n, COUNT(DISTINCT visitor) AS visitors
          FROM events WHERE project = ? AND day >= ? GROUP BY day, event, props, device, ref
        UNION ALL
        SELECT day, event, props, device, ref, n, visitors FROM daily WHERE project = ? AND day >= ?)
      GROUP BY event, props, device, ref ORDER BY event, props, device, ref`).all(project, fromDay, project, fromDay) as unknown as (Omit<Group, 'props'> & { props: string })[];
    return rows.map((r) => ({ ...r, props: JSON.parse(r.props) as Props }));
  }

  // distinct combinations (see comboKey) seen on a day: the cap on new ones survives a restart
  combos(project: string, day: string): string[] {
    return (this.#db.prepare(`SELECT DISTINCT event || '|' || props || '|' || device || '|' || IFNULL(ref, '') AS k
      FROM events WHERE project = ? AND day = ?`).all(project, day) as { k: string }[]).map((r) => r.k);
  }

  dailyVisitors(project: string, fromDay: string): DayTotal[] {
    return this.#db.prepare(`
      SELECT day, COUNT(DISTINCT visitor) AS visitors, COUNT(*) AS events FROM events
        WHERE project = ? AND day >= ? GROUP BY day
      UNION ALL
      SELECT day, visitors, events FROM daily_visitors WHERE project = ? AND day >= ?
      ORDER BY day`).all(project, fromDay, project, fromDay).map((r) => ({ ...r })) as unknown as DayTotal[];
  }

  // moves events of days before `beforeDay` into the daily sums; returns how many events were rolled up
  rollUp(beforeDay: string): number {
    const n = (this.#db.prepare('SELECT COUNT(*) AS n FROM events WHERE day < ?').get(beforeDay) as { n: number }).n;
    if (!n) return 0;
    this.#db.exec('BEGIN');
    try {
      this.#db.prepare(`
        INSERT INTO daily (project, day, event, props, device, ref, n, visitors)
        SELECT project, day, event, props, device, ref, COUNT(*), COUNT(DISTINCT visitor)
          FROM events WHERE day < ? GROUP BY project, day, event, props, device, ref`).run(beforeDay);
      this.#db.prepare(`
        INSERT OR REPLACE INTO daily_visitors (project, day, visitors, events)
        SELECT project, day, COUNT(DISTINCT visitor), COUNT(*) FROM events WHERE day < ? GROUP BY project, day`).run(beforeDay);
      this.#db.prepare('DELETE FROM events WHERE day < ?').run(beforeDay);
      this.#db.exec('COMMIT');
    } catch (e) {
      this.#db.exec('ROLLBACK');
      throw e;
    }
    return n;
  }

  // daily sums are kept for years; this drops the ones older than a day
  purgeDailyBefore(day: string): void {
    this.#db.prepare('DELETE FROM daily WHERE day < ?').run(day);
    this.#db.prepare('DELETE FROM daily_visitors WHERE day < ?').run(day);
  }

  rawCount(): number {
    return (this.#db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;
  }

  // pages in use: free pages left by deletions are reused, so they do not count
  sizeBytes(): number {
    const page = this.#db.prepare('PRAGMA page_size').get() as { page_size: number };
    const count = this.#db.prepare('PRAGMA page_count').get() as { page_count: number };
    const free = this.#db.prepare('PRAGMA freelist_count').get() as { freelist_count: number };
    return page.page_size * (count.page_count - free.freelist_count);
  }

  close(): void {
    this.#db.close();
  }
}

export function comboKey(hit: Hit): string {
  return `${hit.event}|${canonical(hit.props)}|${hit.device}|${hit.ref ?? ''}`;
}
