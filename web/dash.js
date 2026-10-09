// Shared helpers for the dashboard pages (All sites, Site, IP).
// Every value from the logs is attacker-controlled, so it is only ever set with textContent.
export const $ = (id) => document.getElementById(id);
export const number = new Intl.NumberFormat();
export const state = { siteHosts: {} };
export const siteName = (key) => state.siteHosts[key] || key;
export const fmt = (value) => number.format(Number(value) || 0);
export const IP_PATTERN = /^[0-9a-fA-F:.]{2,45}$/;

const DAY_MS = 24 * 60 * 60 * 1000;
const RANGES = [['24h', '24 hours'], ['7d', '7 days'], ['30d', '30 days'], ['90d', '90 days'], ['365d', '1 year']];
const MAX_CUSTOM_DAYS = 366;
const BOT_UA = /bot|crawl|spider|slurp|curl|wget|python|httpclient|http-client|headless|monitor|preview|scanner|go-http|java\/|okhttp|axios|node-fetch|facebookexternalhit|lighthouse/i;

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = String(value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children) if (child != null) node.append(child);
  return node;
}

export function setStatus(text, isError) {
  $('status').textContent = text || '';
  $('status').className = isError ? 'error' : '';
}

export async function api(path) {
  const response = await fetch(path, { credentials: 'same-origin', headers: { accept: 'application/json' } });
  if (response.status === 401) {
    const error = new Error('signed out');
    error.signedOut = true;
    throw error;
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

export function handleError(error) {
  if (error.signedOut) {
    $('page').hidden = true;
    $('account').hidden = true;
    $('signin').hidden = false;
    setStatus('');
    return;
  }
  setStatus(error.message, true);
}

export async function start(render) {
  try {
    const me = await api('/api/me');
    state.siteHosts = me.sites || {};
    $('user').textContent = me.user;
    $('account').hidden = false;
    $('page').hidden = false;
    await render();
  } catch (error) {
    handleError(error);
  }
}

// ---- time formatting ----
const pad = (n) => String(n).padStart(2, '0');
export const formatDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${formatDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
export function ago(iso) {
  if (!iso) return '';
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (!(minutes >= 0)) return formatTime(iso);
  if (minutes < 2) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h ago`;
  if (minutes < 60 * 24 * 60) return `${Math.round(minutes / 1440)} days ago`;
  return formatTime(iso).slice(0, 10);
}

// "Chrome on macOS", "Safari on iPhone", "Bot: Googlebot"
export function describeUA(ua) {
  if (!ua) return '';
  if (BOT_UA.test(ua)) {
    const named = ua.match(/([A-Za-z0-9._-]*(?:bot|crawler|spider)[A-Za-z0-9._-]*)/i);
    return `Bot: ${named ? named[1] : ua.split(/[/ ]/)[0]}`;
  }
  const browser = /Edg(e|A|iOS)?\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /SamsungBrowser/.test(ua) ? 'Samsung Internet'
    : /Firefox\/|FxiOS/.test(ua) ? 'Firefox' : /Chrome\/|CriOS/.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : ua.split(/[/ ]/)[0];
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows'
    : /Macintosh|Mac OS X/.test(ua) ? 'macOS' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

// ---- period (kept in the URL so links and reloads keep it) ----
export function period() {
  const q = new URLSearchParams(location.search);
  if (q.get('from') && q.get('to')) return { from: q.get('from'), to: q.get('to') };
  const range = q.get('range');
  return { range: RANGES.some(([key]) => key === range) ? range : '7d' };
}

export function pageLink(path, params = {}) {
  return `${path}?${new URLSearchParams({ ...params, ...period() })}`;
}
export const siteLink = (site) => pageLink('/site', { site });
export const ipLink = (ip) => pageLink('/ip', { ip });

function setPeriod(next) {
  const q = new URLSearchParams(location.search);
  for (const key of ['range', 'from', 'to']) q.delete(key);
  for (const [key, value] of Object.entries(next)) q.set(key, value);
  history.replaceState(null, '', `${location.pathname}?${q}`);
}

export function periodBar(onChange) {
  const bar = el('div', { class: 'period', role: 'group', 'aria-label': 'Period' });
  const custom = el('form', { class: 'custom-dates', hidden: true, title: 'Whole days in UTC' });
  const today = new Date();
  const dateInput = (name) => el('input', { type: 'date', name, required: true, max: formatDate(today), min: formatDate(new Date(today.getTime() - 365 * DAY_MS)) });
  const from = dateInput('from');
  const to = dateInput('to');
  custom.append(el('label', {}, ['From ', from]), el('label', {}, ['To ', to]), el('button', { type: 'submit', text: 'Show' }));
  const buttons = [];

  function mark() {
    const current = period();
    for (const button of buttons) button.setAttribute('aria-pressed', String(current.from ? button.dataset.range === 'custom' : button.dataset.range === current.range));
    custom.hidden = !current.from && custom.dataset.open !== 'true';
    if (current.from) { from.value = current.from; to.value = current.to; }
  }

  for (const [key, label] of [...RANGES, ['custom', 'Custom…']]) {
    const button = el('button', { type: 'button', 'data-range': key, text: label });
    button.addEventListener('click', () => {
      if (key === 'custom') {
        custom.dataset.open = 'true';
        if (!from.value) {
          to.value = formatDate(today);
          from.value = formatDate(new Date(today.getTime() - 6 * DAY_MS));
        }
        custom.hidden = false;
        buttons.forEach((b) => b.setAttribute('aria-pressed', String(b === button)));
        from.focus();
        return;
      }
      custom.dataset.open = 'false';
      setPeriod({ range: key });
      mark();
      onChange();
    });
    buttons.push(button);
    bar.append(button);
  }
  custom.addEventListener('submit', (event) => {
    event.preventDefault();
    const span = (Date.parse(to.value) - Date.parse(from.value)) / DAY_MS;
    if (!(span >= 0)) return setStatus('From must be on or before To', true);
    if (span > MAX_CUSTOM_DAYS) return setStatus(`A custom period can be at most ${MAX_CUSTOM_DAYS} days`, true);
    setPeriod({ from: from.value, to: to.value });
    mark();
    onChange();
  });
  mark();
  return el('div', { class: 'period-wrap' }, [bar, custom]);
}

// ---- layout pieces ----
export function card(title, { subtitle, tools = [], className } = {}) {
  const head = el('div', { class: 'card-head' }, [el('h2', {}, [title, subtitle ? el('small', { text: subtitle }) : null]), ...tools]);
  const body = el('div', { class: 'card-body' });
  const node = el('section', { class: `card${className ? ` ${className}` : ''}` }, [head, body]);
  return { node, head, body };
}

export function kpis(items) {
  return el('div', { class: 'kpis' }, items.map(([label, value, hint]) =>
    el('div', { class: 'kpi', title: hint || null }, [el('div', { class: 'value', text: value }), el('div', { class: 'label', text: label })])));
}

export function facts(items) {
  const dl = el('dl', { class: 'facts' });
  for (const [term, value, title] of items) dl.append(el('div', {}, [el('dt', { text: term }), el('dd', { text: value || '—', title: title || null })]));
  return dl;
}

// Sortable-free table with optional search box and "Show all" for long lists.
// columns: { label, value(row), cls, href(row), title(row) }
export function dataTable({ columns, limit = Infinity, placeholder = 'Filter…', empty = 'No data', rowClass }) {
  const search = el('input', { type: 'search', class: 'table-filter', placeholder, 'aria-label': placeholder, hidden: true });
  const table = el('table');
  const more = el('button', { type: 'button', class: 'show-more', hidden: true });
  const wrap = el('div', { class: 'table-wrap' }, [table]);
  const node = el('div', {}, [wrap, more]);
  let rows = [];
  let texts = [];
  let expanded = false;
  const cell = (column, row) => {
    const value = column.value(row);
    return value == null ? '' : String(value);
  };

  function draw() {
    const words = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const matches = rows.filter((row, i) => words.every((word) => texts[i].includes(word)));
    const shown = expanded ? matches : matches.slice(0, limit);
    const head = el('thead', {}, [el('tr', {}, columns.map((c) => el('th', { class: c.cls, text: c.label })))]);
    const body = el('tbody');
    if (!shown.length) body.append(el('tr', {}, [el('td', { class: 'empty', colspan: columns.length, text: rows.length ? 'No matching rows' : empty })]));
    for (const row of shown) {
      const tr = el('tr', { class: rowClass ? rowClass(row) : null });
      for (const column of columns) {
        const text = cell(column, row);
        const href = column.href && text ? column.href(row) : null;
        const td = el('td', { class: column.cls, title: column.title ? column.title(row) : null });
        td.append(href ? el('a', { href, text }) : text);
        tr.append(td);
      }
      body.append(tr);
    }
    table.replaceChildren(head, body);
    search.hidden = rows.length <= limit && !search.value;
    more.hidden = matches.length <= limit;
    more.textContent = expanded ? 'Show fewer' : `Show all ${fmt(matches.length)}${words.length ? ' matching' : ''}`;
  }

  search.addEventListener('input', draw);
  more.addEventListener('click', () => {
    expanded = !expanded;
    draw();
    if (!expanded) node.scrollIntoView({ block: 'nearest' });
  });
  return {
    node,
    search,
    set(next) {
      rows = next;
      texts = rows.map((row) => columns.map((c) => cell(c, row)).join(' ').toLowerCase());
      expanded = false;
      draw();
    },
  };
}

// ---- charts ----
// Every hour/day in the period, so quiet days show as gaps instead of disappearing.
export function buckets(filters) {
  const step = filters.hourly ? 3600e3 : DAY_MS;
  let t = filters.since
    ? Math.floor(Date.parse(`${filters.since.replace(' ', 'T')}Z`) / 3600e3) * 3600e3
    : Date.parse(`${filters.startDay}T00:00:00Z`);
  const end = Math.min(Date.now(), Date.parse(`${filters.endDay}T23:59:59Z`));
  const keys = [];
  for (; t <= end && keys.length < 2000; t += step) keys.push(`${new Date(t).toISOString().slice(0, 19)}Z`);
  return keys;
}

export function bucketOf(iso, hourly) {
  return hourly ? `${iso.slice(0, 13)}:00:00Z` : `${iso.slice(0, 10)}T00:00:00Z`;
}

const SVG = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}) => {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
};

function bucketLabel(key, hourly) {
  if (!hourly) return key.slice(0, 10);
  const d = new Date(key);
  return `${pad(d.getHours())}:00`;
}

// bars and line are arrays aligned with keys.
export function chart(keys, { bars, line, barLabel, lineLabel, hourly }) {
  const box = el('div', { class: 'chart' });
  if (!keys.length) return box;
  const width = 1000, height = 220, left = 44, bottom = 22, top = 10;
  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': `${barLabel} over time` });
  const max = Math.max(1, ...bars, ...(line || []));
  const plotW = width - left, plotH = height - bottom - top;
  const step = plotW / keys.length;
  const y = (v) => top + plotH - (v / max) * plotH;
  for (const fraction of [0, 0.5, 1]) {
    const yy = top + plotH - fraction * plotH;
    svg.append(svgEl('line', { x1: left, x2: width, y1: yy, y2: yy, class: 'grid-line' }));
    const label = svgEl('text', { x: 2, y: yy + 4, class: 'axis' });
    label.textContent = number.format(Math.round(max * fraction));
    svg.append(label);
  }
  const every = Math.ceil(keys.length / 8);
  const points = [];
  keys.forEach((key, i) => {
    const x = left + i * step;
    const bar = svgEl('rect', { x: x + step * 0.1, width: Math.max(1, step * 0.8), y: y(bars[i]), height: top + plotH - y(bars[i]), class: 'bar' });
    const title = svgEl('title');
    title.textContent = `${hourly ? formatTime(key).slice(0, 16) : key.slice(0, 10)}\n${barLabel}: ${number.format(bars[i])}${line ? `\n${lineLabel}: ${number.format(line[i])}` : ''}`;
    bar.append(title);
    svg.append(bar);
    if (line) points.push(`${x + step / 2},${y(line[i])}`);
    if (i % every === 0) {
      const label = svgEl('text', { x: x + step / 2, y: height - 6, 'text-anchor': 'middle', class: 'axis' });
      label.textContent = bucketLabel(key, hourly);
      svg.append(label);
    }
  });
  if (line) svg.append(svgEl('polyline', { points: points.join(' '), class: 'line' }));
  const legend = el('div', { class: 'legend' }, [el('span', { class: 'key-bar', text: barLabel }), line ? el('span', { class: 'key-line', text: lineLabel }) : null]);
  box.append(svg, legend);
  return box;
}

export function sparkline(values) {
  const width = 120, height = 32;
  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none', class: 'spark', 'aria-hidden': 'true' });
  if (values.length < 2) return svg;
  const max = Math.max(1, ...values);
  const points = values.map((v, i) => `${(i / (values.length - 1)) * width},${height - 2 - (v / max) * (height - 4)}`);
  svg.append(svgEl('polygon', { points: `0,${height} ${points.join(' ')} ${width},${height}`, class: 'spark-area' }));
  svg.append(svgEl('polyline', { points: points.join(' '), class: 'spark-line' }));
  return svg;
}

// Sums rows by bucket key into an array aligned with keys.
export function series(keys, rows, field, keyOf = (row) => row.bucket) {
  const totals = new Map(keys.map((key) => [key, 0]));
  for (const row of rows) {
    const key = keyOf(row);
    if (totals.has(key)) totals.set(key, totals.get(key) + (field ? Number(row[field]) || 0 : 1));
  }
  return keys.map((key) => totals.get(key));
}

export function periodText(filters) {
  if (filters.since) return 'the last 24 hours';
  return filters.startDay === filters.endDay ? filters.startDay : `${filters.startDay} to ${filters.endDay}`;
}

export const isBot = (row) => row.is_bot === true || row.is_bot === 'true';
