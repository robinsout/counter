// The project registry (projects.json) and the check of incoming events against a project's schema.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { loadRegistry, parseHit } from '../src/registry.ts';

const SITE = 'https://robinsout.github.io';

const config = {
  projects: [{
    id: 'quadern',
    name: 'Quadern de català',
    origins: [SITE],
    events: {
      view: { lesson: 'id', lang: 'lang' },
      exercise: { lesson: 'id', exercise: 'id', score: 'int', total: 'int' },
      sync: {},
    },
    panels: [
      { type: 'pivot', title: 'Уроки', event: 'view', rows: 'lesson', cols: 'lang' },
      { type: 'score', title: 'Упражнения', event: 'exercise', rows: ['lesson', 'exercise'], score: 'score', total: 'total' },
    ],
  }],
};

const registry = loadRegistry(config);
const hit = (body: unknown, origin: string | null = SITE) => parseHit(registry, origin, JSON.stringify(body));

test('a valid event is accepted with only the fields of its schema', () => {
  const r = hit({ p: 'quadern', e: 'view', d: 'phone', props: { lesson: 'b1-04', lang: 'es', extra: 'dropped' } });
  assert.deepEqual(r, { ok: true, hit: { project: 'quadern', event: 'view', device: 'phone', ref: null, props: { lesson: 'b1-04', lang: 'es' } } });
});

test('fields may be missing, but a wrong value rejects the event', () => {
  assert.equal(hit({ p: 'quadern', e: 'view', d: 'desktop', props: {} }).ok, true);
  for (const props of [{ lesson: 'B1 04' }, { lesson: 'a'.repeat(49) }, { lang: 'english' }, { lesson: 5 }]) {
    assert.equal(hit({ p: 'quadern', e: 'view', d: 'desktop', props }).ok, false, JSON.stringify(props));
  }
  assert.equal(hit({ p: 'quadern', e: 'exercise', d: 'desktop', props: { score: 1.5 } }).ok, false);
  assert.equal(hit({ p: 'quadern', e: 'exercise', d: 'desktop', props: { score: -1 } }).ok, false);
  assert.deepEqual(hit({ p: 'quadern', e: 'exercise', d: 'desktop', props: { score: 3, total: 5 } }),
    { ok: true, hit: { project: 'quadern', event: 'exercise', device: 'desktop', ref: null, props: { score: 3, total: 5 } } });
});

test('a full address or a sync code cannot get in: ids are short and plain', () => {
  for (const lesson of ['#/ru/sync/0123456789abcdef', 'https://x.y/z', 'b1-04?code=1']) {
    assert.equal(hit({ p: 'quadern', e: 'view', d: 'phone', props: { lesson } }).ok, false, lesson);
  }
});

test('unknown project, unknown event, foreign site, bad device and bad JSON are refused', () => {
  assert.equal(hit({ p: 'other', e: 'view', d: 'phone' }).ok, false);
  assert.equal(hit({ p: 'quadern', e: 'click', d: 'phone' }).ok, false);
  assert.equal(hit({ p: 'quadern', e: 'view', d: 'phone' }, 'https://evil.example').ok, false);
  assert.equal(hit({ p: 'quadern', e: 'view', d: 'tablet' }).ok, false);
  assert.equal(parseHit(registry, SITE, '{nope').ok, false);
  assert.equal(parseHit(registry, SITE, JSON.stringify([1])).ok, false);
});

test('a field can be limited to a list of values', () => {
  const r = loadRegistry({ projects: [{ ...config.projects[0], events: { view: { lang: ['ru', 'en', 'es'] } }, panels: [] }] });
  assert.equal(parseHit(r, SITE, JSON.stringify({ p: 'quadern', e: 'view', d: 'phone', props: { lang: 'es' } })).ok, true);
  assert.equal(parseHit(r, SITE, JSON.stringify({ p: 'quadern', e: 'view', d: 'phone', props: { lang: 'xx' } })).ok, false);
  assert.throws(() => loadRegistry({ projects: [{ ...config.projects[0], events: { view: { lang: [] } }, panels: [] }] }), /values/);
  assert.throws(() => loadRegistry({ projects: [{ ...config.projects[0], events: { view: { lang: ['Bad value'] } }, panels: [] }] }), /values/);
});

test('the referrer is kept as a bare host name, without www', () => {
  const ref = (r: unknown) => {
    const res = hit({ p: 'quadern', e: 'view', d: 'phone', r });
    return res.ok ? res.hit.ref : 'refused';
  };
  assert.equal(ref('www.Google.com'), 'google.com');
  assert.equal(ref('web.whatsapp.com'), 'web.whatsapp.com');
  assert.equal(ref('https://google.com/search?q=x'), 'refused');
  assert.equal(ref('a'.repeat(70) + '.com'), 'refused');
  assert.equal(ref(undefined), null);
});

test('a broken registry is refused when it is loaded', () => {
  const broken = (patch: object) => () => loadRegistry({ projects: [{ ...config.projects[0], ...patch }] });
  assert.throws(broken({ id: 'Bad Id' }), /id/);
  assert.throws(broken({ origins: ['robinsout.github.io'] }), /origin/);
  assert.throws(broken({ events: { view: { lesson: 'text' } } }), /type/);
  assert.throws(broken({ panels: [{ type: 'pivot', title: 'x', event: 'nope', rows: 'lesson', cols: 'lang' }] }), /event/);
  assert.throws(broken({ panels: [{ type: 'pivot', title: 'x', event: 'view', rows: 'nope', cols: 'lang' }] }), /field/);
  assert.throws(broken({ panels: [{ type: 'pie', title: 'x', event: 'view' }] }), /panel/);
  assert.throws(() => loadRegistry({ projects: [config.projects[0], config.projects[0]] }), /twice/);
});

test('the projects.json of this repository is valid', async () => {
  const { readFileSync } = await import('node:fs');
  const r = loadRegistry(JSON.parse(readFileSync(new URL('../projects.json', import.meta.url), 'utf8')));
  assert.ok(r.projects.length > 0);
});
