// The stats page: plain server-rendered HTML with inline styles and an SVG chart.
// No scripts and nothing loaded from elsewhere (its CSP is default-src 'none').
import type { Project } from './registry.ts';
import type { PanelReport, Report, Item } from './stats.ts';

export const PERIODS = [7, 30, 90, 365];

const esc = (s: string | number) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const fmt = (n: number) => n.toLocaleString('ru-RU');
const DEVICES: Record<string, string> = { phone: 'телефон', desktop: 'компьютер' };

function link(project: string, days: number) {
  return `?project=${encodeURIComponent(project)}&amp;days=${days}`;
}

function chart(report: Report): string {
  const w = 720, h = 140, pad = 18;
  const max = Math.max(1, ...report.days.map((d) => d.visitors));
  const step = (w - pad) / report.days.length;
  const bars = report.days.map((d, i) => {
    const bh = Math.round(((h - pad) * d.visitors) / max);
    return `<rect x="${(pad + i * step + step * 0.15).toFixed(1)}" y="${h - pad - bh}" width="${(step * 0.7).toFixed(1)}" height="${bh}" rx="2"><title>${esc(d.day)}: ${d.visitors} посет., ${d.events} событий</title></rect>`;
  }).join('');
  const first = report.days[0]?.day ?? '', last = report.days.at(-1)?.day ?? '';
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="Посетители по дням">
<text x="0" y="12">${max}</text><line x1="${pad}" x2="${w}" y1="${h - pad}" y2="${h - pad}"/>${bars}
<text x="${pad}" y="${h - 2}">${esc(first.slice(5))}</text><text x="${w}" y="${h - 2}" text-anchor="end">${esc(last.slice(5))}</text></svg>`;
}

function bars(items: Item[], empty = 'нет данных'): string {
  if (!items.length) return `<p class="muted">${empty}</p>`;
  const max = Math.max(...items.map((i) => i.value));
  return `<table class="bars">${items.map((i) => `<tr><td>${esc(i.key)}</td><td class="num">${fmt(i.value)}</td>`
    + `<td class="bar"><svg viewBox="0 0 100 8" preserveAspectRatio="none"><rect width="${Math.max(1, Math.round((100 * i.value) / max))}" height="8" rx="1"/></svg></td></tr>`).join('')}</table>`;
}

function panel(p: PanelReport): string {
  if (p.type === 'pivot') {
    if (!p.rows.length) return `<section><h2>${esc(p.title)}</h2><p class="muted">нет данных</p></section>`;
    return `<section><h2>${esc(p.title)}</h2><div class="scroll"><table><thead><tr><th></th>${p.cols.map((c) => `<th class="num">${esc(c)}</th>`).join('')}<th class="num">всего</th></tr></thead><tbody>`
      + p.rows.map((r) => `<tr><td>${esc(r.key)}</td>${r.cells.map((c) => `<td class="num">${c ? fmt(c) : ''}</td>`).join('')}<td class="num"><b>${fmt(r.total)}</b></td></tr>`).join('')
      + '</tbody></table></div></section>';
  }
  if (p.type === 'top') return `<section><h2>${esc(p.title)}</h2>${bars(p.items)}</section>`;
  if (!p.items.length) return `<section><h2>${esc(p.title)}</h2><p class="muted">нет данных</p></section>`;
  return `<section><h2>${esc(p.title)}</h2><div class="scroll"><table><thead><tr><th></th><th class="num">решали</th><th class="num">средний результат</th></tr></thead><tbody>`
    + p.items.map((i) => `<tr><td>${esc(i.key)}</td><td class="num">${fmt(i.attempts)}</td><td class="num">${i.percent}%</td></tr>`).join('')
    + '</tbody></table></div></section>';
}

const STYLE = `
:root{--bg:#f6f6f3;--card:#fff;--fg:#1d2330;--muted:#6b7280;--line:#e3e3dc;--accent:#2b59a8}
@media (prefers-color-scheme:dark){:root{--bg:#14171d;--card:#1c2028;--fg:#e8e9ec;--muted:#9aa1ad;--line:#2d323c;--accent:#7ea6f0}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:860px;margin:0 auto;padding:20px 16px 48px}h1{font-size:24px;margin:8px 0 4px}h2{font-size:16px;margin:0 0 10px}
nav{display:flex;flex-wrap:wrap;gap:6px;margin:4px 0}nav a{padding:4px 10px;border:1px solid var(--line);border-radius:999px;color:var(--fg);text-decoration:none;font-size:14px}
nav a[aria-current]{background:var(--accent);border-color:var(--accent);color:var(--bg)}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:16px 0}
.kpi,section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}section{margin:12px 0}
.kpi b{display:block;font-size:24px}.kpi span,.muted{color:var(--muted);font-size:13px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}.grid section{margin:0}
table{border-collapse:collapse;width:100%}td,th{padding:4px 6px;border-bottom:1px solid var(--line);text-align:left;font-weight:normal;white-space:nowrap}
th{color:var(--muted);font-size:13px}.num{text-align:right;font-variant-numeric:tabular-nums}.scroll{overflow-x:auto}
.bars td.bar{width:40%}.bars svg{width:100%;height:8px;display:block}.bars rect,.chart rect{fill:var(--accent)}
.chart{width:100%;height:auto;display:block}.chart text{fill:var(--muted);font-size:11px}.chart line{stroke:var(--line)}
footer{color:var(--muted);font-size:13px;margin-top:24px}`;

export function renderPage(o: { projects: Project[]; project: Project; days: number; report: Report; today: string }): string {
  const { report, project, days } = o;
  const today = report.days.at(-1);
  const switcher = o.projects.length > 1
    ? `<nav aria-label="Проект">${o.projects.map((p) => `<a href="${link(p.id, days)}"${p.id === project.id ? ' aria-current="page"' : ''}>${esc(p.name)}</a>`).join('')}</nav>`
    : '';
  const periods = `<nav aria-label="Период">${PERIODS.map((d) => `<a href="${link(project.id, d)}"${d === days ? ' aria-current="page"' : ''}>${d} дн.</a>`).join('')}</nav>`;
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Статистика · ${esc(project.name)}</title><style>${STYLE}</style></head><body><main>
${switcher}<h1>${esc(project.name)}</h1>${periods}
<div class="kpis">
<div class="kpi"><b>${fmt(today?.visitors ?? 0)}</b><span>посетителей сегодня</span></div>
<div class="kpi"><b>${fmt(report.visitorDays)}</b><span>посетителей за ${days} дн. (каждый — раз в день)</span></div>
<div class="kpi"><b>${fmt(report.events)}</b><span>событий за ${days} дн.</span></div>
<div class="kpi"><b>${fmt(Math.round((10 * report.visitorDays) / Math.max(1, report.days.length)) / 10)}</b><span>посетителей в среднем за день</span></div>
</div>
<section><h2>Посетители по дням</h2>${chart(report)}</section>
<div class="grid"><section><h2>Устройства</h2>${bars(report.devices.map((d) => ({ ...d, key: DEVICES[d.key] ?? d.key })))}</section><section><h2>Откуда пришли</h2>${bars(report.refs, 'переходов с других сайтов нет')}</section></div>
${report.panels.map(panel).join('\n')}
<footer>Без cookies и без IP-адресов: посетитель узнаётся только в пределах одного дня. Сегодня — ${esc(o.today)}, время барселонское.</footer>
</main></body></html>`;
}

export function renderNoPassword(): string {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Статистика</title><style>${STYLE}</style></head><body><main>
<h1>Статистика</h1>
<section><p>Пароль статистики ещё не задан:</p><p><code>ssh -t hetzner bash /opt/counter/deploy/install.sh --new-password</code></p>
<p class="muted">Пароль покажется один раз; потом обновите эту страницу.</p></section>
</main></body></html>`;
}
