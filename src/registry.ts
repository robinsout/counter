// The project registry (projects.json): which sites may send events, which events and fields they have,
// which panels the stats page shows. Every incoming event is checked against it; anything else is refused.

// 'id' and 'lang' are formats; a list of strings allows only those values (use it where the set is known:
// a flood of made-up values then cannot get in at all)
export type FieldType = 'id' | 'lang' | 'int' | string[];
export type Measure = 'events' | 'visitors';

export type Panel =
  | { type: 'pivot'; title: string; event: string; rows: string; cols: string; measure?: Measure }
  | { type: 'top'; title: string; event: string; props: string[]; measure?: Measure; limit?: number }
  | { type: 'score'; title: string; event: string; rows: string[]; score: string; total: string };

export interface Project {
  id: string;
  name: string;
  origins: string[];
  events: Record<string, Record<string, FieldType>>;
  panels: Panel[];
}

export interface Registry {
  projects: Project[];
  byId: Map<string, Project>;
}

export type Device = 'phone' | 'desktop';
export type Props = Record<string, string | number>;

export interface Hit {
  project: string;
  event: string;
  device: Device;
  ref: string | null;
  props: Props;
}

export type ParseResult = { ok: true; hit: Hit } | { ok: false; error: string };

const ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const LANG_RE = /^[a-z]{2,3}$/;
const HOST_RE = /^(?=.{1,64}$)[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const ORIGIN_RE = /^https?:\/\/[a-z0-9.-]+(:\d+)?$/;
const FIELD_TYPES: string[] = ['id', 'lang', 'int'];
const MAX_INT = 100_000;

function fail(where: string, what: string): never {
  throw new Error(`projects.json: ${where}: ${what}`);
}

export function loadRegistry(json: unknown): Registry {
  const projects = (json as { projects?: unknown })?.projects;
  if (!Array.isArray(projects)) fail('root', 'expected { projects: [...] }');
  const byId = new Map<string, Project>();
  for (const p of projects as Project[]) {
    const where = `project ${JSON.stringify(p?.id)}`;
    if (typeof p?.id !== 'string' || !ID_RE.test(p.id)) fail(where, 'bad id');
    if (byId.has(p.id)) fail(where, 'listed twice');
    if (typeof p.name !== 'string' || !p.name) fail(where, 'no name');
    if (!Array.isArray(p.origins) || !p.origins.length || !p.origins.every((o) => typeof o === 'string' && ORIGIN_RE.test(o))) {
      fail(where, 'origins must be like https://example.org');
    }
    if (typeof p.events !== 'object' || !p.events) fail(where, 'no events');
    for (const [event, fields] of Object.entries(p.events)) {
      if (!ID_RE.test(event)) fail(where, `bad event name ${event}`);
      for (const [field, type] of Object.entries(fields)) {
        if (!ID_RE.test(field)) fail(where, `bad field name ${event}.${field}`);
        if (Array.isArray(type)) {
          if (!type.length || !type.every((v) => typeof v === 'string' && ID_RE.test(v))) fail(where, `bad list of values of ${event}.${field}`);
        } else if (!FIELD_TYPES.includes(type)) fail(where, `unknown type ${type} of ${event}.${field}`);
      }
    }
    for (const panel of p.panels ?? []) checkPanel(where, p, panel);
    byId.set(p.id, { ...p, panels: p.panels ?? [] });
  }
  return { projects: [...byId.values()], byId };
}

function checkPanel(where: string, p: Project, panel: Panel): void {
  const fields = p.events[panel.event];
  if (!fields) fail(where, `panel "${panel.title}" uses an unknown event ${panel.event}`);
  const need = (...names: string[]) => {
    for (const n of names) if (!(n in fields)) fail(where, `panel "${panel.title}": no field ${n} in event ${panel.event}`);
  };
  if (typeof panel.title !== 'string' || !panel.title) fail(where, 'a panel without a title');
  if (panel.type === 'pivot') need(panel.rows, panel.cols);
  else if (panel.type === 'top') need(...panel.props);
  else if (panel.type === 'score') need(...panel.rows, panel.score, panel.total);
  else fail(where, `unknown panel type ${(panel as { type: string }).type}`);
}

function valid(type: FieldType, v: unknown): v is string | number {
  if (Array.isArray(type)) return typeof v === 'string' && type.includes(v);
  if (type === 'int') return Number.isInteger(v) && (v as number) >= 0 && (v as number) <= MAX_INT;
  return typeof v === 'string' && (type === 'id' ? ID_RE : LANG_RE).test(v);
}

function host(r: unknown): string | null | undefined {
  if (r === undefined || r === null || r === '') return null;
  if (typeof r !== 'string') return undefined;
  const h = r.toLowerCase().replace(/^www\./, '');
  return HOST_RE.test(h) ? h : undefined;
}

// Body of POST /c/hit: { p: project, e: event, d: device, r?: referrer host, props?: {...} }
export function parseHit(registry: Registry, origin: string | null, text: string): ParseResult {
  let body: { p?: unknown; e?: unknown; d?: unknown; r?: unknown; props?: unknown };
  try { body = JSON.parse(text); } catch { return { ok: false, error: 'bad json' }; }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, error: 'bad body' };
  const project = typeof body.p === 'string' ? registry.byId.get(body.p) : undefined;
  if (!project) return { ok: false, error: 'unknown project' };
  if (!origin || !project.origins.includes(origin)) return { ok: false, error: 'origin not allowed' };
  const fields = typeof body.e === 'string' ? project.events[body.e] : undefined;
  if (!fields) return { ok: false, error: 'unknown event' };
  if (body.d !== 'phone' && body.d !== 'desktop') return { ok: false, error: 'bad device' };
  const ref = host(body.r);
  if (ref === undefined) return { ok: false, error: 'bad referrer' };
  const given = typeof body.props === 'object' && body.props !== null ? body.props as Record<string, unknown> : {};
  const props: Props = {};
  for (const [field, type] of Object.entries(fields)) {
    const v = given[field];
    if (v === undefined) continue;
    if (!valid(type, v)) return { ok: false, error: `bad ${field}` };
    props[field] = v;
  }
  return { ok: true, hit: { project: project.id, event: body.e as string, device: body.d, ref, props } };
}
