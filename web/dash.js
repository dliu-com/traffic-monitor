// Shared helpers for the dashboard pages (All sites, Site, IP).
// Every value from the logs is attacker-controlled, so it is only ever set with textContent.
export const $ = (id) => document.getElementById(id);
export const number = new Intl.NumberFormat();
export const state = { siteHosts: {} };
export const siteName = (key) => state.siteHosts[key] || key;
export const fmt = (value) => number.format(Number(value) || 0);
export const IP_PATTERN = /^[0-9a-fA-F:.]{2,45}$/;

const DAY_MS = 24 * 60 * 60 * 1000;
const RANGES = [['1h', '1 hour'], ['12h', '12 hours'], ['24h', '24 hours'], ['7d', '7 days'], ['30d', '30 days'], ['90d', '90 days'], ['365d', '1 year']];
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

// Loads one widget on its own: shows a spinner over `node` until its data arrives,
// and drops answers that come back after a newer request (e.g. the period changed again).
export function widget(node, fetchData, render) {
  let latest = 0;
  return async () => {
    const id = ++latest;
    node.classList.add('loading');
    node.setAttribute('aria-busy', 'true');
    try {
      const data = await fetchData();
      if (id === latest) render(data);
    } catch (error) {
      if (id === latest) handleError(error);
    } finally {
      if (id === latest) {
        node.classList.remove('loading');
        node.removeAttribute('aria-busy');
      }
    }
  };
}

// One named query of /api/overview or /api/ip.
export const part = (path, name, params) => api(`${path}?${new URLSearchParams({ ...params, part: name })}`);

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
// Relative ranges use ?range=; custom periods use ?from=&to= as UTC instants (YYYY-MM-DDTHH:MMZ).
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

const formatMinute = (d) => `${formatDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
const toInstant = (d) => `${d.toISOString().slice(0, 16)}Z`;

// "YYYY-MM-DD HH:MM" (or just "YYYY-MM-DD") in local time -> Date. A date-only end means the end of that day.
function parseLocal(text, isEnd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?$/.exec(text.trim());
  if (!m) return null;
  const [y, mo, d, h = '0', mi = '0'] = m.slice(1);
  const date = new Date(+y, mo - 1, +d, +h, +mi);
  if (date.getMonth() !== mo - 1 || date.getDate() !== +d || +h > 23 || +mi > 59) return null;
  if (isEnd && m[4] === undefined) date.setDate(date.getDate() + 1);
  return date;
}

// URL value -> text for the input (old date-only links are shown as they are).
const inputValue = (value) => (/^\d{4}-\d{2}-\d{2}$/.test(value) ? value : formatMinute(new Date(value)));

const zone = () => {
  const offset = -new Date().getTimezoneOffset();
  return `UTC${offset >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
};

export function periodBar(onChange) {
  const bar = el('div', { class: 'period', role: 'group', 'aria-label': 'Period' });
  const custom = el('form', { class: 'custom-dates', hidden: true, novalidate: true });
  const timeInput = (name, label) => el('input', {
    type: 'text', name, required: true, inputmode: 'numeric', autocomplete: 'off', spellcheck: 'false',
    placeholder: 'YYYY-MM-DD HH:MM', 'aria-label': `${label} (YYYY-MM-DD HH:MM, local time)`, maxlength: 16, size: 16,
  });
  const from = timeInput('from', 'From');
  const to = timeInput('to', 'To');
  custom.append(
    el('label', {}, ['From ', from]),
    el('label', {}, ['To ', to]),
    el('button', { type: 'submit', text: 'Show' }),
    el('span', { class: 'zone', text: `your local time (${zone()})` }),
  );
  const buttons = [];

  function mark() {
    const current = period();
    for (const button of buttons) button.setAttribute('aria-pressed', String(current.from ? button.dataset.range === 'custom' : button.dataset.range === current.range));
    custom.hidden = !current.from && custom.dataset.open !== 'true';
    if (current.from) {
      from.value = inputValue(current.from);
      to.value = inputValue(current.to);
    }
  }

  for (const [key, label] of [...RANGES, ['custom', 'Custom…']]) {
    const button = el('button', { type: 'button', 'data-range': key, text: label });
    button.addEventListener('click', () => {
      if (key === 'custom') {
        custom.dataset.open = 'true';
        if (!from.value) {
          const now = new Date();
          now.setSeconds(0, 0);
          to.value = formatMinute(now);
          from.value = formatMinute(new Date(now.getTime() - DAY_MS));
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
    const start = parseLocal(from.value, false);
    const end = parseLocal(to.value, true);
    if (!start || !end) return setStatus('Enter dates as YYYY-MM-DD HH:MM, e.g. 2026-10-09 14:30', true);
    if (end <= start) return setStatus('From must be before To', true);
    if (end - start > MAX_CUSTOM_DAYS * DAY_MS) return setStatus(`A custom period can be at most ${MAX_CUSTOM_DAYS} days`, true);
    setStatus('');
    setPeriod({ from: toInstant(start), to: toInstant(end) });
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

function tableBody(table, columns, rows, empty, rowClass) {
  const head = el('thead', {}, [el('tr', {}, columns.map((c) => el('th', { class: c.cls, text: c.label })))]);
  const body = el('tbody');
  if (!rows.length) body.append(el('tr', {}, [el('td', { class: 'empty', colspan: columns.length, text: empty })]));
  for (const row of rows) {
    const tr = el('tr', { class: rowClass ? rowClass(row) : null });
    for (const column of columns) {
      const value = column.value(row);
      const text = value == null ? '' : String(value);
      const href = column.href && text ? column.href(row) : null;
      const td = el('td', { class: column.cls, title: column.title ? column.title(row) : null });
      td.append(href ? el('a', { href, text }) : text);
      tr.append(td);
    }
    body.append(tr);
  }
  table.replaceChildren(head, body);
}

// A short list that is always shown in full (e.g. the sites one IP visited).
// columns: { label, value(row), cls, href(row), title(row) }
export function staticTable({ columns, empty = 'No data', rowClass }) {
  const table = el('table');
  return { node: el('div', { class: 'table-wrap' }, [table]), set: (rows) => tableBody(table, columns, rows, empty, rowClass) };
}

// Characters the server accepts in a search; anything else is turned into a space.
const SEARCH_JUNK = /[^\p{L}\p{N}\p{M} ._:/@?=&+~,#%()-]/gu;

// A long list paged on the server: only `pageSize` rows are fetched at a time,
// "Show more" fetches the next page and the search box runs the search in Athena.
export function pagedTable({ list, params, pageSize, columns, placeholder = 'Search…', empty = 'No data', rowClass }) {
  const search = el('input', { type: 'search', class: 'table-filter', placeholder, 'aria-label': placeholder, maxlength: 100, hidden: true });
  const table = el('table');
  const info = el('span', { class: 'table-info' });
  const fewer = el('button', { type: 'button', class: 'link-button', text: 'Show fewer', hidden: true });
  const more = el('button', { type: 'button', class: 'show-more', hidden: true });
  const node = el('div', {}, [el('div', { class: 'table-wrap' }, [table]), more, el('div', { class: 'table-foot' }, [info, fewer])]);
  let rows = [];
  let total = 0;
  let query = '';
  let request = 0;
  let timer;

  function draw() {
    tableBody(table, columns, rows, query ? 'No matching rows' : empty, rowClass);
    search.hidden = total <= pageSize && !query;
    const left = total - rows.length;
    more.hidden = left <= 0;
    more.disabled = false;
    more.textContent = `Show ${fmt(Math.min(left, pageSize))} more`;
    fewer.hidden = rows.length <= pageSize;
    info.textContent = total > pageSize || query ? `Showing ${fmt(rows.length)} of ${fmt(total)}${query ? ' matching' : ''}` : '';
  }

  async function fetchPage(offset) {
    const id = ++request;
    node.classList.add('loading');
    node.setAttribute('aria-busy', 'true');
    try {
      const data = await api(`/api/list?${new URLSearchParams({ list, ...params(), ...(query ? { q: query } : {}), offset, limit: pageSize })}`);
      if (id !== request) return;
      rows = offset ? rows.concat(data.rows) : data.rows;
      total = data.total;
      draw();
    } catch (error) {
      if (id === request) {
        handleError(error);
        draw();
      }
    } finally {
      if (id === request) {
        node.classList.remove('loading');
        node.removeAttribute('aria-busy');
      }
    }
  }

  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const next = search.value.replace(SEARCH_JUNK, ' ').trim().slice(0, 100);
      if (next === query) return;
      query = next;
      info.textContent = 'Searching…';
      fetchPage(0);
    }, 400);
  });
  more.addEventListener('click', () => {
    more.disabled = true;
    more.textContent = 'Loading…';
    fetchPage(rows.length);
  });
  fewer.addEventListener('click', () => {
    rows = rows.slice(0, pageSize);
    draw();
    node.scrollIntoView({ block: 'nearest' });
  });
  return { node, search, load: () => fetchPage(0) };
}

// ---- charts ----
const STEP = { minute: 60e3, hour: 3600e3, day: DAY_MS };
const utc = (sqlTime) => Date.parse(`${sqlTime.replace(' ', 'T')}Z`);

// Every minute/hour/day in the period, so quiet times show as gaps instead of disappearing.
export function buckets(filters) {
  const step = STEP[filters.unit] || DAY_MS;
  let t = filters.since ? Math.floor(utc(filters.since) / step) * step : Date.parse(`${filters.startDay}T00:00:00Z`);
  const end = filters.until ? utc(filters.until) - 1 : Math.min(Date.now(), Date.parse(`${filters.endDay}T23:59:59Z`));
  const keys = [];
  for (; t <= end && keys.length < 2000; t += step) keys.push(`${new Date(t).toISOString().slice(0, 19)}Z`);
  return keys;
}

export function bucketOf(iso, unit) {
  if (unit === 'minute') return `${iso.slice(0, 16)}:00Z`;
  if (unit === 'hour') return `${iso.slice(0, 13)}:00:00Z`;
  return `${iso.slice(0, 10)}T00:00:00Z`;
}

const SVG = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}) => {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
};

function bucketLabel(key, unit, manyDays) {
  if (unit === 'day') return key.slice(0, 10);
  const text = formatMinute(new Date(key));
  return manyDays ? text : text.slice(11);
}

// bars and line are arrays aligned with keys.
export function chart(keys, { bars, line, barLabel, lineLabel, unit }) {
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
  const manyDays = Date.parse(keys[keys.length - 1]) - Date.parse(keys[0]) >= DAY_MS;
  const points = [];
  keys.forEach((key, i) => {
    const x = left + i * step;
    const bar = svgEl('rect', { x: x + step * 0.1, width: Math.max(1, step * 0.8), y: y(bars[i]), height: top + plotH - y(bars[i]), class: 'bar' });
    const title = svgEl('title');
    title.textContent = `${unit === 'day' ? key.slice(0, 10) : formatMinute(new Date(key))}\n${barLabel}: ${number.format(bars[i])}${line ? `\n${lineLabel}: ${number.format(line[i])}` : ''}`;
    bar.append(title);
    svg.append(bar);
    if (line) points.push(`${x + step / 2},${y(line[i])}`);
    if (i % every === 0) {
      const label = svgEl('text', { x: x + step / 2, y: height - 6, 'text-anchor': 'middle', class: 'axis' });
      label.textContent = bucketLabel(key, unit, manyDays);
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
  if (filters.since) {
    const end = filters.until ? formatMinute(new Date(utc(filters.until))) : 'now';
    return `${formatMinute(new Date(utc(filters.since)))} to ${end} (${zone()})`;
  }
  return `${filters.startDay === filters.endDay ? filters.startDay : `${filters.startDay} to ${filters.endDay}`} (whole UTC days)`;
}

export const isBot = (row) => row.is_bot === true || row.is_bot === 'true';
