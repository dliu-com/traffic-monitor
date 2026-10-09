'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const state = { visitor: null, ip: null, siteHosts: {} };
  const siteName = (key) => state.siteHosts[key] || key;
  const number = new Intl.NumberFormat();

  function setStatus(text, isError) {
    $('status').textContent = text || '';
    $('status').className = isError ? 'error' : '';
  }

  async function api(path) {
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

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value == null ? '' : String(value);
      else node.setAttribute(key, value);
    }
    for (const child of children) node.append(child);
    return node;
  }

  function formatBytes(value) {
    let bytes = Number(value) || 0;
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let unit = 0;
    while (bytes >= 1024 && unit < units.length - 1) { bytes /= 1024; unit++; }
    return `${bytes.toFixed(unit ? 1 : 0)} ${units[unit]}`;
  }

  function formatTime(iso) {
    if (!iso) return '';
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
  }

  // columns: [header, key or fn, className]
  function renderTable(table, columns, rows, onClick) {
    table.replaceChildren();
    table.append(el('thead', {}, [el('tr', {}, columns.map(([label, , cls]) => el('th', { class: cls || '', text: label })))]));
    const body = el('tbody');
    if (!rows.length) {
      body.append(el('tr', {}, [el('td', { class: 'empty', colspan: columns.length, text: 'No data' })]));
    }
    for (const row of rows) {
      const tr = el('tr', row.is_bot === 'true' ? { class: 'bot' } : {});
      for (const [, key, cls] of columns) {
        const value = typeof key === 'function' ? key(row) : row[key];
        tr.append(el('td', { class: cls || '', text: value }));
      }
      if (onClick) tr.addEventListener('click', () => onClick(row));
      body.append(tr);
    }
    table.append(body);
  }

  function renderKpis(summary) {
    const s = summary[0] || {};
    const items = [
      ['Visitors', number.format(s.visitors || 0)],
      ['Page views', number.format(s.pageviews || 0)],
      ['Requests', number.format(s.requests || 0)],
      ['Unique IPs', number.format(s.ips || 0)],
      ['Bot requests', number.format(s.bot_requests || 0)],
      ['Errors (4xx/5xx)', number.format(s.errors || 0)],
      ['Data served', formatBytes(s.bytes)],
    ];
    $('kpis').replaceChildren(...items.map(([label, value]) =>
      el('div', { class: 'kpi' }, [el('div', { class: 'value', text: value }), el('div', { class: 'label', text: label })])));
  }

  function renderChart(series, hourly) {
    const container = $('chart');
    container.replaceChildren();
    if (!series.length) {
      container.append(el('p', { class: 'empty', text: 'No data in this range' }));
      return;
    }
    const ns = 'http://www.w3.org/2000/svg';
    const svgEl = (tag, attrs) => {
      const node = document.createElementNS(ns, tag);
      for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
      return node;
    };
    const width = 1000, height = 220, left = 40, bottom = 22, top = 10;
    const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none' });
    const max = Math.max(1, ...series.map((p) => Number(p.requests)));
    const plotW = width - left, plotH = height - bottom - top;
    const step = plotW / series.length;
    const y = (v) => top + plotH - (Number(v) / max) * plotH;

    for (const fraction of [0, 0.5, 1]) {
      const yy = top + plotH - fraction * plotH;
      svg.append(svgEl('line', { x1: left, x2: width, y1: yy, y2: yy, class: 'grid-line' }));
      const label = svgEl('text', { x: 2, y: yy + 4, class: 'axis' });
      label.textContent = number.format(Math.round(max * fraction));
      svg.append(label);
    }
    const points = [];
    series.forEach((point, i) => {
      const x = left + i * step;
      const bar = svgEl('rect', { x: x + step * 0.1, width: Math.max(1, step * 0.8), y: y(point.requests), height: top + plotH - y(point.requests), class: 'bar' });
      const title = svgEl('title', {});
      title.textContent = `${formatTime(point.bucket)}\nrequests ${point.requests} · page views ${point.pageviews} · visitors ${point.visitors}`;
      bar.append(title);
      svg.append(bar);
      points.push(`${x + step / 2},${y(point.visitors)}`);
      const every = Math.ceil(series.length / 8);
      if (i % every === 0) {
        const label = svgEl('text', { x: x + step / 2, y: height - 6, 'text-anchor': 'middle', class: 'axis' });
        const date = new Date(point.bucket);
        label.textContent = hourly
          ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          : date.toLocaleDateString([], { month: 'short', day: 'numeric' });
        svg.append(label);
      }
    });
    svg.append(svgEl('polyline', { points: points.join(' '), class: 'line' }));
    container.append(svg);
  }

  function filterQuery(extra = {}) {
    const params = new URLSearchParams({ site: $('site').value, range: $('range').value, ...extra });
    return params.toString();
  }

  async function loadRequests() {
    const extra = { limit: '300' };
    if ($('hide-bots').checked) extra.bots = 'hide';
    if ($('pages-only').checked) extra.pages = 'only';
    if (state.visitor) extra.visitor = state.visitor;
    if (state.ip) extra.ip = state.ip;
    $('requests-title').textContent = state.visitor ? `Requests from visitor ${state.visitor}`
      : state.ip ? `Requests from IP ${state.ip}` : 'Recent requests';
    $('clear-visitor').hidden = !(state.visitor || state.ip);
    const data = await api(`/api/requests?${filterQuery(extra)}`);
    renderTable($('requests'), [
      ['Time', (r) => formatTime(r.time)],
      ['Site', (r) => siteName(r.site)],
      ['IP', 'ip'],
      ['Visitor', 'visitor_id'],
      ['Method', 'method'],
      ['Path', 'path', 'wrap'],
      ['Status', 'status', 'num'],
      ['Referrer', 'referrer', 'wrap'],
      ['User agent', 'ua', 'ua wrap'],
    ], data.requests);
  }

  function selectVisitor(row) {
    state.visitor = row.visitor_id || null;
    state.ip = row.visitor_id ? null : row.last_ip;
    $('hide-bots').checked = false;
    loadRequests().catch(handleError);
    $('requests-title').scrollIntoView({ behavior: 'smooth' });
  }

  async function loadOverview() {
    setStatus('Loading… (Athena queries take a few seconds)');
    const data = await api(`/api/overview?${filterQuery()}`);
    renderKpis(data.summary);
    renderChart(data.timeseries, data.filters.hourly);
    renderTable($('sites'), [['Site', (r) => siteName(r.site)], ['Requests', 'requests', 'num'], ['Page views', 'pageviews', 'num'], ['Visitors', 'visitors', 'num']], data.sites);
    renderTable($('pages'), [['Site', (r) => siteName(r.site)], ['Path', 'path', 'wrap'], ['Views', 'views', 'num'], ['Visitors', 'visitors', 'num']], data.pages);
    renderTable($('referrers'), [['Referrer', 'referrer', 'wrap'], ['Views', 'views', 'num'], ['Visitors', 'visitors', 'num']], data.referrers);
    renderTable($('visitors'), [
      ['Visitor', (r) => r.visitor_id || `(no cookie) ${r.last_ip}`],
      ['First seen', (r) => formatTime(r.first_seen)],
      ['Last seen', (r) => formatTime(r.last_seen)],
      ['Sites', (r) => String(r.sites || '').split(',').filter(Boolean).map(siteName).join(', ')],
      ['Page views', 'pageviews', 'num'],
      ['Requests', 'requests', 'num'],
      ['IPs', 'ips', 'num'],
      ['Last IP', 'last_ip'],
      ['Last user agent', 'last_ua', 'ua wrap'],
    ], data.visitors, selectVisitor);
    await loadRequests();
    setStatus(`Updated ${new Date().toLocaleTimeString()} · logs arrive a few minutes after each request`);
  }

  function handleError(error) {
    if (error.signedOut) {
      $('dashboard').hidden = true;
      $('filters').hidden = true;
      $('account').hidden = true;
      $('signin').hidden = false;
      setStatus('');
      return;
    }
    setStatus(error.message, true);
  }

  async function start() {
    try {
      const me = await api('/api/me');
      $('user').textContent = me.user;
      state.siteHosts = me.sites || {};
      for (const [key, host] of Object.entries(state.siteHosts)) $('site').append(el('option', { value: key, text: host }));
      $('account').hidden = false;
      $('filters').hidden = false;
      $('dashboard').hidden = false;
      await loadOverview();
    } catch (error) {
      handleError(error);
    }
  }

  $('filters').addEventListener('submit', (event) => {
    event.preventDefault();
    loadOverview().catch(handleError);
  });
  $('site').addEventListener('change', () => loadOverview().catch(handleError));
  $('range').addEventListener('change', () => loadOverview().catch(handleError));
  $('hide-bots').addEventListener('change', () => loadRequests().catch(handleError));
  $('pages-only').addEventListener('change', () => loadRequests().catch(handleError));
  $('clear-visitor').addEventListener('click', () => {
    state.visitor = null;
    state.ip = null;
    loadRequests().catch(handleError);
  });

  start();
})();
