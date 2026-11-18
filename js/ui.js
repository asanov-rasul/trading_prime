/* SMC Signals — интерфейс. Весь текст из сети выводится через textContent (без innerHTML).
   Графики рисуются вручную на canvas. */
'use strict';

var UI = (function () {
  var C = CONFIG;
  var App = null;
  var charts = [];       // функции перерисовки видимых графиков
  var built = {};
  var current = 'best';

  // ---------- DOM ----------
  function h(tag, props) {
    var el = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = String(v);
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k === 'value') el.value = String(v);
        else if (k === 'checked') el.checked = !!v;
        else if (k === 'disabled') el.disabled = !!v;
        else if (k === 'selected') el.selected = !!v;
        else el.setAttribute(k, v === true ? '' : String(v));
      });
    }
    for (var i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }
  function add(el, c) {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { add(el, x); }); return; }
    if (typeof c === 'string' || typeof c === 'number') { el.appendChild(document.createTextNode(String(c))); return; }
    el.appendChild(c);
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
  function $(id) { return document.getElementById(id); }
  function footer() { return h('footer', { class: 'disclaimer' }, C.disclaimer); }

  // ---------- форматирование ----------
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function decOf(p) {
    var a = Math.abs(p);
    if (a >= 1000) return 2;
    if (a >= 100) return 2;
    if (a >= 10) return 3;
    if (a >= 1) return 4;
    if (a >= 0.1) return 5;
    if (a >= 0.01) return 6;
    return 8;
  }
  function fP(p) { return isNum(p) ? p.toFixed(decOf(p)) : '—'; }
  function roundP(p) { return isNum(p) ? Number(p.toFixed(decOf(p))) : NaN; }
  function fN(x, d) { return isNum(x) ? x.toFixed(d === undefined ? 2 : d) : '—'; }
  function fPct(x, d) { return isNum(x) ? (x > 0 ? '+' : '') + x.toFixed(d === undefined ? 2 : d) + '%' : '—'; }
  function fRate(x) { return isNum(x) ? Math.round(x * 100) + '%' : '—'; }
  function fR(r) { return isNum(r) ? (r > 0 ? '+' : '') + r.toFixed(2) + 'R' : (r === Infinity ? '∞' : '—'); }
  function fUsd(x) { return isNum(x) ? (x > 0 ? '+' : '') + x.toFixed(2) : '—'; }
  function fTime(t) { return t ? new Date(t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '—'; }
  function fTimeS(t) { return t ? new Date(t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—'; }
  function fDT(t) { return t ? new Date(t).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'; }
  function fDate(t) { return t ? new Date(t).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—'; }
  function fAgo(ms) {
    if (!isNum(ms)) return '—';
    if (ms < 0) ms = 0;
    var m = Math.floor(ms / 60000);
    if (m < 1) return 'меньше минуты';
    if (m < 60) return m + ' мин';
    var hh = Math.floor(m / 60), mm = m % 60;
    if (hh < 24) return hh + ' ч' + (mm ? ' ' + mm + ' мин' : '');
    var d = Math.floor(hh / 24);
    return d + ' дн ' + (hh % 24) + ' ч';
  }
  function pctFrom(entry, p) { return (p - entry) / entry * 100; }
  function accColor(v) { return v < 60 ? 'bad' : (v < 75 ? 'mid' : 'good'); }

  // ---------- общие элементы ----------
  function toast(text, kind) {
    var t = $('toast');
    if (!t) return;
    t.textContent = text;
    t.className = 'toast ' + (kind || '');
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { t.hidden = true; }, 3500);
  }
  function badgeSide(dir) { return h('span', { class: 'badge ' + (dir === 1 ? 'long' : 'short') }, dir === 1 ? 'LONG' : 'SHORT'); }
  function statusChip(sig, prov) {
    var s = prov || sig, cls = 'chip';
    if (s.status === 'pending') cls += ' wait';
    else if (s.status === 'active') cls += ' live';
    else if (s.status === 'closed') cls += s.tpHit[0] ? ' good' : ' bad';
    else cls += ' muted';
    var txt = Signals.statusText(s);
    if (prov && prov.status !== sig.status) txt += ' (по незакрытой свече)';
    return h('span', { class: cls }, txt);
  }
  function section(title, body, extraClass) {
    return h('div', { class: 'card ' + (extraClass || '') }, title ? h('h3', { class: 'card-title' }, title) : null, body);
  }
  function kv(label, value, cls) {
    return h('div', { class: 'kv' }, h('span', { class: 'k' }, label), h('span', { class: 'v ' + (cls || '') }, value));
  }
  function tableWrap(table) { return h('div', { class: 'table-wrap' }, table); }
  function mkTable(head, rows, opts) {
    opts = opts || {};
    var thead = h('thead', null, h('tr', null, head.map(function (c, k) {
      var th = h('th', { class: (opts.sortKey && opts.sortKey === (opts.keys && opts.keys[k])) ? 'sorted' : '' }, c);
      if (opts.onSort && opts.keys && opts.keys[k]) {
        th.classList.add('sortable');
        th.tabIndex = 0;
        th.addEventListener('click', function () { opts.onSort(opts.keys[k]); });
      }
      return th;
    })));
    var tbody = h('tbody', null, rows.map(function (r) {
      return h('tr', { class: r.cls || '' }, r.cells.map(function (c) {
        if (c && typeof c === 'object' && c.nodeType) return h('td', null, c);
        if (c && typeof c === 'object' && 'v' in c) return h('td', { class: c.cls || '' }, c.v);
        return h('td', null, c === null || c === undefined ? '—' : String(c));
      }));
    }));
    return h('table', { class: 'tbl' + (opts.cls ? ' ' + opts.cls : '') }, thead, tbody);
  }
  function field(label, input, hint) {
    return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input, hint ? h('span', { class: 'field-hint' }, hint) : null);
  }
  function numInput(value, opts) {
    opts = opts || {};
    return h('input', {
      type: 'number', inputmode: 'decimal', step: opts.step || 'any', min: opts.min, max: opts.max,
      value: isNum(value) ? String(value) : '', class: 'inp', oninput: opts.oninput, onchange: opts.onchange, placeholder: opts.placeholder
    });
  }
  function select(options, value, onchange) {
    var s = h('select', { class: 'inp', onchange: onchange });
    options.forEach(function (o) { s.appendChild(h('option', { value: o[0], selected: String(o[0]) === String(value) }, o[1])); });
    return s;
  }
  function seg(options, value, onpick) {
    var wrap = h('div', { class: 'seg', role: 'group' });
    options.forEach(function (o) {
      wrap.appendChild(h('button', {
        type: 'button', class: 'seg-btn' + (String(o[0]) === String(value) ? ' on' : ''), 'aria-pressed': String(o[0]) === String(value) ? 'true' : 'false',
        onclick: function () { onpick(o[0]); }
      }, o[1]));
    });
    return wrap;
  }

  // ---------- canvas ----------
  function cssVar(name, def) {
    try {
      var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || def;
    } catch (e) { return def; }
  }
  function setupCanvas(cv) {
    var dpr = window.devicePixelRatio || 1, w = cv.clientWidth, hh = cv.clientHeight;
    if (!w || !hh) return null;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(hh * dpr);
    var g = cv.getContext('2d');
    if (!g) return null;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { g: g, w: w, h: hh };
  }
  function spreadLabels(items, minGap, top, bottom) {
    items.sort(function (a, b) { return a.y - b.y; });
    for (var k = 1; k < items.length; k++) if (items[k].y - items[k - 1].y < minGap) items[k].y = items[k - 1].y + minGap;
    if (items.length && items[items.length - 1].y > bottom) {
      items[items.length - 1].y = bottom;
      for (k = items.length - 2; k >= 0; k--) if (items[k + 1].y - items[k].y < minGap) items[k].y = items[k + 1].y - minGap;
    }
    items.forEach(function (it) { if (it.y < top) it.y = top; });
    return items;
  }
  // Свечной мини-график с зонами и уровнями.
  function drawCandles(cv, candles, o) {
    var s = setupCanvas(cv);
    if (!s) return;
    var g = s.g, W = s.w, Hh = s.h, padR = 78, padT = 8, padB = 16, plotW = W - padR;
    var col = {
      up: cssVar('--up', '#22c55e'), dn: cssVar('--down', '#ef4444'), grid: cssVar('--grid', '#1f2937'),
      muted: cssVar('--muted', '#94a3b8'), text: cssVar('--text', '#e5e7eb'), bg: cssVar('--card', '#111827')
    };
    g.clearRect(0, 0, W, Hh);
    g.font = '10px system-ui, sans-serif';
    var n = Math.max(12, Math.min(candles.length, Math.floor(plotW / 6)));
    var cs = candles.slice(-n);
    if (!cs.length) { g.fillStyle = col.muted; g.fillText('нет данных', 10, 20); return; }
    var lo = Infinity, hi = -Infinity;
    cs.forEach(function (c) { if (c.l < lo) lo = c.l; if (c.h > hi) hi = c.h; });
    (o.levels || []).forEach(function (l) { if (isNum(l.price)) { lo = Math.min(lo, l.price); hi = Math.max(hi, l.price); } });
    var pad = (hi - lo) * 0.06 || hi * 0.01;
    lo -= pad; hi += pad;
    var plotH = Hh - padT - padB;
    function y(p) { return padT + (hi - p) / (hi - lo) * plotH; }
    var bw = plotW / cs.length, step = cs.length > 1 ? cs[1].t - cs[0].t : 1;
    function xOfT(t) { return Math.max(0, Math.min(plotW, (t - cs[0].t) / step * bw)); }
    g.strokeStyle = col.grid;
    g.lineWidth = 1;
    g.fillStyle = col.muted;
    for (var k = 0; k <= 4; k++) {
      var yy = padT + plotH * k / 4;
      g.beginPath(); g.moveTo(0, yy + 0.5); g.lineTo(plotW, yy + 0.5); g.stroke();
    }
    (o.zones || []).forEach(function (z) {
      if (!isNum(z.bot) || !isNum(z.top)) return;
      var x0 = z.from ? xOfT(z.from) : 0;
      g.fillStyle = z.color;
      g.fillRect(x0, y(z.top), plotW - x0, Math.max(1, y(z.bot) - y(z.top)));
    });
    (o.markers || []).forEach(function (m) {
      if (!m.t || m.t < cs[0].t) return;
      var xm = xOfT(m.t) + bw / 2;
      g.strokeStyle = m.color; g.setLineDash([2, 3]);
      g.beginPath(); g.moveTo(xm, padT); g.lineTo(xm, padT + plotH); g.stroke();
      g.setLineDash([]);
    });
    cs.forEach(function (c, k2) {
      var up = c.c >= c.o, x = k2 * bw + bw / 2;
      g.strokeStyle = up ? col.up : col.dn;
      g.fillStyle = up ? col.up : col.dn;
      g.globalAlpha = c.closed === false ? 0.55 : 1;
      g.beginPath(); g.moveTo(x, y(c.h)); g.lineTo(x, y(c.l)); g.stroke();
      var bt = y(Math.max(c.o, c.c)), bb = y(Math.min(c.o, c.c));
      g.fillRect(x - bw * 0.35, bt, Math.max(1, bw * 0.7), Math.max(1, bb - bt));
      g.globalAlpha = 1;
    });
    var labels = [];
    (o.levels || []).forEach(function (l) {
      if (!isNum(l.price)) return;
      var yy = y(l.price);
      g.strokeStyle = l.color; g.lineWidth = l.width || 1;
      g.setLineDash(l.dash ? [5, 4] : []);
      g.beginPath(); g.moveTo(0, yy); g.lineTo(plotW, yy); g.stroke();
      g.setLineDash([]); g.lineWidth = 1;
      labels.push({ y: yy, text: l.label + ' ' + fP(l.price), color: l.color });
    });
    spreadLabels(labels, 13, padT + 6, Hh - padB);
    labels.forEach(function (lb) {
      g.fillStyle = col.bg;
      g.fillRect(plotW + 2, lb.y - 7, padR - 3, 13);
      g.fillStyle = lb.color;
      g.fillText(lb.text, plotW + 5, lb.y + 3.5, padR - 7);
    });
    g.fillStyle = col.muted;
    g.fillText(fTime(cs[0].t), 2, Hh - 3);
    var tl = fTime(cs[cs.length - 1].t);
    g.fillText(tl, plotW - g.measureText(tl).width - 2, Hh - 3);
  }
  // Кривая капитала в R.
  function drawEquity(cv, curve) {
    var s = setupCanvas(cv);
    if (!s) return;
    var g = s.g, W = s.w, Hh = s.h, padL = 40, padT = 10, padB = 18, padR = 8;
    var col = { line: cssVar('--accent', '#60a5fa'), grid: cssVar('--grid', '#1f2937'), muted: cssVar('--muted', '#94a3b8'), up: cssVar('--up', '#22c55e'), dn: cssVar('--down', '#ef4444') };
    g.clearRect(0, 0, W, Hh);
    g.font = '10px system-ui, sans-serif';
    if (!curve.length) { g.fillStyle = col.muted; g.fillText('нет закрытых сделок', 10, 20); return; }
    var pts = [0].concat(curve.map(function (p) { return p.r; }));
    var lo = Math.min.apply(null, pts.concat([0])), hi = Math.max.apply(null, pts.concat([0]));
    if (hi - lo < 1) { hi += 0.5; lo -= 0.5; }
    var plotW = W - padL - padR, plotH = Hh - padT - padB;
    function x(k) { return padL + (pts.length > 1 ? k / (pts.length - 1) : 0) * plotW; }
    function y(v) { return padT + (hi - v) / (hi - lo) * plotH; }
    g.strokeStyle = col.grid; g.fillStyle = col.muted;
    for (var k = 0; k <= 4; k++) {
      var v = lo + (hi - lo) * k / 4, yy = y(v);
      g.beginPath(); g.moveTo(padL, yy + 0.5); g.lineTo(W - padR, yy + 0.5); g.stroke();
      g.fillText((v < -0.005 ? '−' : '') + Math.abs(v).toFixed(1) + 'R', 2, yy + 3);
    }
    g.strokeStyle = col.muted; g.setLineDash([3, 3]);
    g.beginPath(); g.moveTo(padL, y(0)); g.lineTo(W - padR, y(0)); g.stroke(); g.setLineDash([]);
    g.beginPath();
    pts.forEach(function (p, k2) { if (k2 === 0) g.moveTo(x(k2), y(p)); else g.lineTo(x(k2), y(p)); });
    g.strokeStyle = pts[pts.length - 1] >= 0 ? col.up : col.dn;
    g.lineWidth = 2; g.stroke(); g.lineWidth = 1;
    g.fillStyle = col.muted;
    g.fillText('сделок: ' + curve.length, padL, Hh - 4);
    var fin = fR(pts[pts.length - 1]);
    g.fillText(fin, W - padR - g.measureText(fin).width, Hh - 4);
  }
  function redrawCharts() { charts.forEach(function (fn) { try { fn(); } catch (e) { /* график не критичен */ } }); }

  // ---------- статус ----------
  function renderStatus(st) {
    var el = $('status');
    if (!el) return;
    clear(el);
    var cls = st.state === 'ok' ? 'ok' : (st.state === 'warn' || st.state === 'loading' ? 'warn' : (st.state === 'error' ? 'err' : 'idle'));
    var text = st.source || 'Источник не выбран';
    el.appendChild(h('span', { class: 'dot ' + cls, 'aria-hidden': 'true' }));
    el.appendChild(h('span', { class: 'st-src' }, text));
    el.appendChild(h('span', { class: 'st-time' }, st.state === 'loading' ? (st.progress || 'загрузка…') : (st.lastUpdate ? 'обновлено ' + fTimeS(st.lastUpdate) : '—')));
    if (st.error) el.appendChild(h('span', { class: 'st-err', title: st.error }, st.error));
    el.title = [text, st.error].concat(st.notes || []).filter(Boolean).join('\n');
  }

  // ---------- навигация ----------
  function show(name) {
    current = name;
    charts = [];
    document.querySelectorAll('.screen').forEach(function (s) { s.hidden = s.getAttribute('data-screen') !== name; });
    document.querySelectorAll('.tab').forEach(function (b) {
      var on = b.getAttribute('data-screen') === name;
      b.classList.toggle('on', on);
      b.setAttribute('aria-current', on ? 'page' : 'false');
    });
    update(name, true);
    window.scrollTo(0, 0);
  }
  function update(name, force) {
    if (!name) name = current;
    if (name !== current && !force) return;
    var fn = RENDER[name];
    if (fn) { charts = []; fn(force); }
  }
  function isShown(name) { return current === name; }

  // =====================================================================================
  // ЭКРАН «ЛУЧШАЯ СДЕЛКА СЕЙЧАС»
  // =====================================================================================
  function accuracyBlock(sig) {
    var acc = Signals.Calib.accuracy(sig.coin, sig.score);
    var wrap = h('div', { class: 'acc' });
    if (!acc) {
      var tn = Signals.Calib.totals().n;
      wrap.appendChild(h('div', { class: 'acc-num ' + accColor(sig.score) }, String(sig.score)));
      wrap.appendChild(h('div', { class: 'acc-label' }, 'Score · предварительная оценка'));
      wrap.appendChild(h('div', { class: 'acc-sub' }, tn > 0
        ? 'Калибровка ненадёжна: в истории всего ' + tn + ' сделок (нужно не меньше ' + C.calibration.minTotal + ') — точность не показывается'
        : 'Калибровки по истории ещё нет'));
      wrap.appendChild(h('button', { type: 'button', class: 'btn small', onclick: function () { App.calibrate(); } }, 'Откалибровать'));
    } else {
      var v = Math.round(acc.value * 100);
      wrap.appendChild(h('div', { class: 'acc-num ' + accColor(v) }, v + '%'));
      wrap.appendChild(h('div', { class: 'acc-label' }, 'Точность'));
      var sub = 'score ' + sig.score + ' · по истории ' + v + '% на ' + acc.n + ' сделках';
      if (acc.smoothed) sub += ' (сглажено к общей ' + Math.round(acc.p * 100) + '%)';
      sub += ' · корзина ' + Signals.Calib.bucketLabel(acc.bucket) + ', ' + acc.scope;
      wrap.appendChild(h('div', { class: 'acc-sub' }, sub));
    }
    wrap.appendChild(h('div', { class: 'acc-note' }, 'Оценка, а не гарантия'));
    return wrap;
  }
  function levelsTable(sig) {
    function row(name, price, r, cls) {
      return { cls: cls, cells: [name, fP(price), fPct(pctFrom(sig.entry, price)), r] };
    }
    var rows = [
      { cls: 'lv-entry', cells: ['Вход (лимит)', fP(sig.entry), '—', '0R'] },
      row('SL', sig.sl, '−1R', 'lv-sl'),
      row('TP1 · ' + Math.round(C.tp.fractions[0] * 100) + '%', sig.tp1, C.tp.r[0] + 'R', 'lv-tp'),
      row('TP2 · ' + Math.round(C.tp.fractions[1] * 100) + '%', sig.tp2, C.tp.r[1] + 'R', 'lv-tp'),
      row('TP3 · ' + Math.round(C.tp.fractions[2] * 100) + '%', sig.tp3, fN(sig.tp3R, 1) + 'R', 'lv-tp')
    ];
    return h('div', null,
      tableWrap(mkTable(['Уровень', 'Цена', '% от входа', 'R'], rows, { cls: 'levels' })),
      h('div', { class: 'muted small zone-line' }, 'Зона входа: ' + fP(sig.zone.bot) + '–' + fP(sig.zone.top) + ' (' + sig.zone.kind.toUpperCase() + '), риск ' + fN(sig.riskPct, 2) + '% от входа'));
  }
  function whyList(sig) {
    var ul = h('ul', { class: 'why' });
    sig.factors.forEach(function (f) {
      ul.appendChild(h('li', { class: f.pts > 0 ? 'ok' : 'no' }, h('span', { class: 'mark' }, f.pts > 0 ? '✓' : '·'), h('span', { class: 'txt' }, f.label), h('span', { class: 'pts' }, (f.pts > 0 ? '+' : '') + f.pts + '/' + f.max)));
    });
    (sig.penalties || []).forEach(function (p) {
      ul.appendChild(h('li', { class: p.active ? 'pen' : 'no' }, h('span', { class: 'mark' }, p.active ? '−' : '·'), h('span', { class: 'txt' }, p.label), h('span', { class: 'pts' }, p.active ? String(p.pts) : '0')));
    });
    var extra = [];
    if (sig.poi) extra.push('Зона 1H: ' + sig.poi.kind.toUpperCase() + ' ' + fP(sig.poi.bot) + '–' + fP(sig.poi.top));
    if (sig.sweep && isNum(sig.sweep.level)) extra.push('Снятый уровень: ' + fP(sig.sweep.level) + ', экстремум ' + fP(sig.sweep.ext) + ' в ' + fTime(sig.sweep.t));
    if (sig.structure) extra.push(sig.structure.type + ' уровня ' + fP(sig.structure.level));
    if (sig.target) extra.push('Ближайшая цель: ' + sig.target.name + ' ' + sig.target.tf + ' ' + fP(sig.target.p) + ' (' + fN(sig.roomR, 1) + 'R)');
    else extra.push('Цели в окне нет — TP3 = ' + C.tp.tp3MaxR + 'R');
    if (sig.ote) extra.push('OTE: ' + fP(sig.ote.bot) + '–' + fP(sig.ote.top) + (sig.inOte ? ' (вход внутри)' : ''));
    extra.push('Зона входа: ' + sig.zone.kind + ', риск ' + fN(sig.riskPct, 2) + '%');
    return h('div', null, ul, h('ul', { class: 'why-extra' }, extra.map(function (t) { return h('li', null, t); })));
  }
  function chartFor(sig, holder) {
    var cv = h('canvas', { class: 'chart', 'aria-label': 'Мини-график свечей ' + sig.coin });
    holder.appendChild(cv);
    var draw = function () {
      var cds = App.candlesFor(sig.sym);
      var zones = [];
      if (sig.poi) zones.push({ bot: sig.poi.bot, top: sig.poi.top, from: sig.poi.t, color: 'rgba(250, 204, 21, 0.10)' });
      zones.push({ bot: sig.zone.bot, top: sig.zone.top, from: sig.zone.t, color: 'rgba(96, 165, 250, 0.22)' });
      drawCandles(cv, cds, {
        zones: zones,
        markers: [{ t: sig.triggerT, color: cssVar('--muted', '#94a3b8') }],
        levels: [
          { price: sig.tp3, color: cssVar('--up', '#22c55e'), label: 'TP3' },
          { price: sig.tp2, color: cssVar('--up', '#22c55e'), label: 'TP2', dash: true },
          { price: sig.tp1, color: cssVar('--up', '#22c55e'), label: 'TP1', dash: true },
          { price: sig.entry, color: cssVar('--accent', '#60a5fa'), label: 'Вход', width: 2 },
          { price: sig.sl, color: cssVar('--down', '#ef4444'), label: 'SL' },
          { price: App.priceOf(sig.sym), color: cssVar('--muted', '#94a3b8'), label: 'Цена', dash: true }
        ]
      });
    };
    charts.push(draw);
    requestAnimationFrame(draw);
  }
  function signalCardFull(sig) {
    var prov = App.provisionalOf(sig);
    var nowT = Data.now();
    var card = h('div', { class: 'card signal-card' });
    card.appendChild(h('div', { class: 'sig-head' },
      h('div', { class: 'sig-coin' }, sig.coin, h('span', { class: 'sig-pair' }, '/' + C.quote)),
      badgeSide(sig.dir), statusChip(sig, prov)));
    if (sig.late) card.appendChild(h('div', { class: 'note warn' }, 'Сигнал найден при загрузке приложения: вход мог пройти без вас.'));
    card.appendChild(accuracyBlock(sig));
    card.appendChild(levelsTable(sig));
    var price = App.priceOf(sig.sym);
    var meta = h('div', { class: 'kv-grid' },
      kv('Цена сейчас', fP(price)),
      kv('Возраст сигнала', fAgo(nowT - sig.createdT)),
      sig.status === 'pending' ? kv('Срок входа', 'до ' + fTime(sig.expiresT) + ' (' + fAgo(sig.expiresT - nowT) + ')') : kv('Вход', fDT(sig.filledT)),
      sig.status === 'active' ? kv('Текущий результат', fR(Signals.openR(sig, price))) : kv('До входа', isNum(price) ? fPct(pctFrom(price, sig.entry)) : '—'),
      kv('Создан', fDT(sig.createdT)),
      kv('ТФ', sig.tf.htf + ' → ' + sig.tf.mtf + ' → ' + sig.tf.ltf)
    );
    card.appendChild(meta);
    var chartBox = h('div', { class: 'chart-box' });
    card.appendChild(chartBox);
    chartFor(sig, chartBox);
    card.appendChild(h('h4', { class: 'sub-title' }, 'Почему этот сигнал'));
    card.appendChild(whyList(sig));
    card.appendChild(h('div', { class: 'row-btns' },
      h('button', { type: 'button', class: 'btn primary', onclick: function () { App.toCalc(sig.id); } }, 'В калькулятор')));
    return card;
  }
  function coinsTable() {
    var rows = App.coinRows().map(function (r) {
      var trend = r.bias === 1 ? { v: '▲ рост', cls: 'up' } : (r.bias === -1 ? { v: '▼ падение', cls: 'down' } : { v: '◆ флэт', cls: 'muted' });
      return { cells: [
        h('span', { class: 'coin-cell' }, r.coin, r.replaces ? h('span', { class: 'muted small' }, ' вместо ' + r.replaces) : null),
        fP(r.price), trend, { v: r.status, cls: r.statusCls || '' }, r.score === null ? '—' : String(r.score)
      ] };
    });
    return tableWrap(mkTable(['Монета', 'Цена', 'Тренд 4H', 'Статус', 'Score'], rows, { cls: 'coins' }));
  }
  function renderBest() {
    var root = $('screen-best');
    clear(root);
    root.appendChild(h('h2', { class: 'screen-title' }, 'Лучшая сделка сейчас'));
    var best = App.bestSignal();
    if (best) root.appendChild(signalCardFull(best));
    else {
      var st = App.feedStatus();
      var msg = st.state === 'loading' || !st.lastUpdate ? 'Загружаю данные и анализирую рынок…' : 'Сейчас нет качественных сетапов — лучше ждать';
      root.appendChild(h('div', { class: 'card empty' },
        h('div', { class: 'empty-title' }, msg),
        h('p', { class: 'muted' }, 'Бот публикует сигнал только при полном сценарии SMC (bias ' + C.timeframes.htf + ', свежая зона ' + C.timeframes.mtf + ', sweep и CHoCH/BOS на ' + C.timeframes.ltf + ') и score не ниже ' + App.settings.minScore + '. Отсутствие сигнала — правильный результат, а не ошибка.'),
        !Signals.Calib.has() ? h('button', { type: 'button', class: 'btn small', onclick: function () { App.calibrate(); } }, 'Откалибровать точность (бэктест 60 дней)') : null));
    }
    var others = App.openSignals().filter(function (s) { return !best || s.id !== best.id; });
    if (others.length) {
      root.appendChild(section('Другие открытые сигналы', h('div', { class: 'mini-list' }, others.map(miniSignal))));
    }
    root.appendChild(section('Все монеты', coinsTable()));
    root.appendChild(footer());
  }
  function miniSignal(sig) {
    var acc = Signals.Calib.accuracy(sig.coin, sig.score);
    return h('div', { class: 'mini' },
      h('div', { class: 'mini-top' }, h('b', null, sig.coin), badgeSide(sig.dir), statusChip(sig, App.provisionalOf(sig))),
      h('div', { class: 'mini-lv' }, 'Вход ' + fP(sig.entry) + ' · SL ' + fP(sig.sl) + ' · TP3 ' + fP(sig.tp3)),
      h('div', { class: 'mini-sub' }, 'score ' + sig.score + (acc ? ' · точность ' + Math.round(acc.value * 100) + '%' : ' · предварительно') + ' · ' + fDT(sig.createdT)),
      h('div', { class: 'row-btns' }, h('button', { type: 'button', class: 'btn small', onclick: function () { App.toCalc(sig.id); } }, 'В калькулятор')));
  }

  // =====================================================================================
  // ЭКРАН «СИГНАЛЫ»
  // =====================================================================================
  var sigFilter = 'all';
  function renderSignals() {
    var root = $('screen-signals');
    clear(root);
    root.appendChild(h('h2', { class: 'screen-title' }, 'Сигналы'));
    root.appendChild(h('div', { class: 'note' }, 'Сигналы по разным монетам сильно коррелируют: не открывайте больше 2–3 сделок одновременно.'));
    var all = Signals.Journal.list.slice();
    var coins = [];
    all.forEach(function (s) { if (coins.indexOf(s.coin) < 0) coins.push(s.coin); });
    var list = sigFilter === 'all' ? all : all.filter(function (s) { return s.coin === sigFilter; });
    var st = Signals.stats(list);
    root.appendChild(section('Статистика журнала (live)', h('div', { class: 'kv-grid' },
      kv('Сигналов', String(st.signals)), kv('Открыто', String(st.open)),
      kv('Закрытых сделок', String(st.n)), kv('Успешных ✓', st.n ? st.wins + ' (' + fRate(st.winRate) + ')' : '—', 'good'),
      kv('Неуспешных ✗', st.n ? st.losses + ' (' + fRate(st.lossRate) + ')' : '—', 'bad'), kv('✓ затем безубыток', String(st.be)),
      kv('Просрочено', String(st.expired + st.invalidated)), kv('Средний результат', fR(st.avgR)),
      kv('Сумма', st.n ? fR(st.sumR) : '—'), kv('Profit factor', isNum(st.pf) ? fN(st.pf, 2) : (st.pf === Infinity ? '∞' : '—'))
    )));
    var opts = [['all', 'Все монеты']].concat(coins.map(function (c) { return [c, c]; }));
    root.appendChild(h('div', { class: 'toolbar' }, field('Фильтр по монете', select(opts, sigFilter, function (e) { sigFilter = e.target.value; renderSignals(); }))));
    if (!list.length) root.appendChild(h('div', { class: 'card empty' }, h('div', { class: 'empty-title' }, 'Журнал пуст'), h('p', { class: 'muted' }, 'Сюда попадают все выданные сигналы и их итог: TP1, TP2, TP3, SL, безубыток, просрочен.')));
    var box = h('div', { class: 'sig-list' });
    list.forEach(function (sig) { box.appendChild(journalItem(sig)); });
    root.appendChild(box);
    root.appendChild(footer());
  }
  function journalItem(sig) {
    var prov = App.provisionalOf(sig);
    var acc = Signals.Calib.accuracy(sig.coin, sig.score);
    var res = sig.status === 'closed' ? fR(sig.resultR) : (sig.status === 'active' ? fR(Signals.openR(sig, App.priceOf(sig.sym))) + ' (открыта)' : '');
    var item = h('details', { class: 'card j-item' });
    item.appendChild(h('summary', null,
      h('div', { class: 'j-top' }, h('b', null, sig.coin), badgeSide(sig.dir), statusChip(sig, prov), h('span', { class: 'j-res ' + (sig.resultR > 0 ? 'good' : (sig.resultR < 0 ? 'bad' : '')) }, res)),
      h('div', { class: 'j-sub' }, fDT(sig.createdT) + ' · score ' + sig.score + (acc ? ' · точность ' + Math.round(acc.value * 100) + '%' : '') + (sig.late ? ' · найден при загрузке' : ''))));
    item.appendChild(levelsTable(sig));
    var ex = h('ul', { class: 'why-extra' });
    if (sig.filledT) ex.appendChild(h('li', null, 'Вход: ' + fDT(sig.filledT)));
    sig.exits.forEach(function (e) { ex.appendChild(h('li', null, (e.kind === 'stop' ? 'Стоп' : e.kind.toUpperCase()) + ': ' + fP(e.price) + ' · ' + Math.round(e.frac * 100) + '% · ' + fDT(e.t))); });
    if (sig.note) ex.appendChild(h('li', null, sig.note));
    ex.appendChild(h('li', null, 'Источник: ' + (sig.source || '—') + ' · комиссия ' + fN(sig.fee * 100, 3) + '% · проскальзывание ' + fN(sig.slip * 100, 3) + '%'));
    item.appendChild(ex);
    item.appendChild(whyList(sig));
    item.appendChild(h('div', { class: 'row-btns' }, h('button', { type: 'button', class: 'btn small', onclick: function () { App.toCalc(sig.id); } }, 'В калькулятор')));
    return item;
  }

  // =====================================================================================
  // ЭКРАН «КАЛЬКУЛЯТОР ПРИБЫЛИ»
  // =====================================================================================
  function renderCalc() {
    var root = $('screen-calc');
    clear(root);
    var s = App.calc;
    root.appendChild(h('h2', { class: 'screen-title' }, 'Калькулятор прибыли'));
    var res = h('div', { id: 'calc-res' });
    function recalc() { renderCalcResult(res); }
    function bindNum(key) {
      return numInput(s[key], { oninput: function (e) { s[key] = e.target.value === '' ? NaN : Number(e.target.value); recalc(); } });
    }
    var sigOpts = [['', '— выберите сигнал —']].concat(App.calcSignals().map(function (x) {
      return [x.id, x.coin + ' ' + x.side + ' · ' + fDT(x.createdT) + ' · ' + Signals.statusText(x)];
    }));
    var pick = select(sigOpts, s.sigId || '', function (e) { s.sigId = e.target.value; });
    root.appendChild(section('Сигнал', h('div', { class: 'form-row' }, pick,
      h('button', { type: 'button', class: 'btn', onclick: function () { if (s.sigId) { App.fillCalcFromSignal(s.sigId); renderCalc(); } else toast('Выберите сигнал'); } }, 'Заполнить из сигнала'))));
    root.appendChild(section('Режим', seg([['risk', 'От риска'], ['amount', 'От суммы']], s.mode, function (v) { s.mode = v; renderCalc(); })));
    var grid = h('div', { class: 'form-grid' });
    grid.appendChild(field('Депозит, USDT', bindNum('deposit')));
    if (s.mode === 'risk') grid.appendChild(field('Риск на сделку, %', bindNum('riskPct')));
    else grid.appendChild(field('Сумма в сделке (своих), USDT', bindNum('amount'), 'позиция = сумма × плечо'));
    grid.appendChild(field('Направление', seg([[1, 'LONG'], [-1, 'SHORT']], s.dir, function (v) { s.dir = Number(v); renderCalc(); })));
    grid.appendChild(field('Вход', bindNum('entry')));
    grid.appendChild(field('SL', bindNum('sl')));
    grid.appendChild(field('TP1', bindNum('tp1')));
    grid.appendChild(field('TP2', bindNum('tp2')));
    grid.appendChild(field('TP3', bindNum('tp3')));
    grid.appendChild(field('Доля TP1, %', bindNum('fr1')));
    grid.appendChild(field('Доля TP2, %', bindNum('fr2')));
    grid.appendChild(field('Доля TP3, %', bindNum('fr3')));
    grid.appendChild(field('Плечо, x', bindNum('leverage'), 'выше ' + C.calculator.leverageWarn + 'x — предупреждение'));
    grid.appendChild(field('Комиссия за сторону, %', bindNum('feePct'), '0.05 — фьючерсы, 0.1 — спот'));
    grid.appendChild(field('Проскальзывание на стопе, %', bindNum('slipPct')));
    grid.appendChild(field('Мин. ордер биржи, USDT', bindNum('minOrder'), 'зависит от монеты и рынка'));
    grid.appendChild(field('Поддерж. маржа, %', bindNum('mmrPct'), 'для оценки ликвидации'));
    grid.appendChild(field('Вероятность успеха p, %', bindNum('probPct'), 'из сигнала или вручную'));
    root.appendChild(section('Параметры сделки', grid));
    root.appendChild(res);
    recalc();
    root.appendChild(footer());
  }
  function renderCalcResult(box) {
    clear(box);
    var s = App.calc;
    var r = Calc.compute({
      deposit: s.deposit, riskPct: s.riskPct, dir: s.dir, entry: s.entry, sl: s.sl, tp: [s.tp1, s.tp2, s.tp3],
      fr: [s.fr1, s.fr2, s.fr3], leverage: s.leverage, feePct: s.feePct, slipPct: s.slipPct, minOrder: s.minOrder,
      mode: s.mode, amount: s.amount, mmrPct: s.mmrPct, prob: isNum(s.probPct) ? s.probPct / 100 : null
    });
    if (r.warnings.length) {
      box.appendChild(h('div', { class: 'warns' }, r.warnings.map(function (w) { return h('div', { class: 'note ' + (w.level === 'error' ? 'err' : 'warn') }, w.text); })));
    }
    if (!r.ok) return;
    var coin = (App.calcSignalCoin() || 'монет');
    box.appendChild(section('Позиция', h('div', { class: 'kv-grid' },
      kv('Размер позиции', fN(r.qty, r.qty >= 100 ? 2 : 6) + ' ' + coin),
      kv('Стоимость позиции', fN(r.notional, 2) + ' USDT'),
      kv('Требуемая маржа', fN(r.margin, 2) + ' USDT'),
      kv('Риск на сделку', fN(r.riskUsd, 2) + ' USDT (' + fN(r.riskUsd / s.deposit * 100, 2) + '%)'),
      kv('Риск на монету', fP(r.riskPerUnit) + ' USDT'),
      kv('Ликвидация (оценка, изол.)', r.liq ? fP(r.liq) : 'нет при 1x'),
      kv('Безубыток после TP1', fP(r.be))
    )));
    var sc = r.scenarios;
    function row(name, x) { return { cells: [name, x ? { v: fUsd(x.usd), cls: x.usd >= 0 ? 'good' : 'bad' } : '—', x ? fPct(x.pct) : '—', x ? fR(x.r) : '—', x ? fN(x.fees, 3) : '—'] }; }
    box.appendChild(section('Сценарии (с комиссиями)', tableWrap(mkTable(['Сценарий', 'USDT', '% депозита', 'R', 'Комиссии'], [
      row('SL', sc.sl), row('TP1, затем безубыток', sc.tp1be), row('TP1 и TP2 (остаток по TP1)', sc.tp12), row('Все три TP', sc.all)
    ]))));
    box.appendChild(section('R:R и ожидание', h('div', { class: 'kv-grid' },
      kv('R:R TP1 / TP2 / TP3', fN(r.rr[0], 2) + ' / ' + fN(r.rr[1], 2) + ' / ' + fN(r.rr[2], 2)),
      kv('Средний R:R (по долям)', fN(r.rrAvg, 2)),
      kv('Матожидание', r.ev === null ? 'укажите p' : fUsd(r.ev) + ' USDT', r.ev > 0 ? 'good' : (r.ev < 0 ? 'bad' : '')),
      kv('Формула', 'p × «TP1→БУ» + (1 − p) × «SL»')
    )));
  }

  // =====================================================================================
  // ЭКРАН «ПРОВЕРКА СТРАТЕГИИ»
  // =====================================================================================
  var btSort = { key: 'createdT', dir: -1 }, btFilter = { coin: 'all', out: 'all' };
  function renderBacktest() {
    var root = $('screen-backtest');
    clear(root);
    var bt = App.bt, p = bt.params;
    root.appendChild(h('h2', { class: 'screen-title' }, 'Проверка стратегии'));
    root.appendChild(h('p', { class: 'muted' }, 'Прогон тех же функций detect() и validate(), что и в live-режиме, по истории. Параметры стратегии фиксированы в CONFIG и не подгоняются под историю.'));
    var coinOpts = [['all', 'Все монеты']].concat(App.activeCoins().map(function (c) { return [c.coin, c.coin]; }));
    var presetOpts = Object.keys(C.presets).map(function (k) { return [k, C.presets[k].name]; });
    var form = h('div', { class: 'form-grid' },
      field('Монета', select(coinOpts, p.coin, function (e) { p.coin = e.target.value; })),
      field('Период', seg(C.backtest.days.map(function (d) { return [d, d + ' дн']; }), p.days, function (v) { p.days = Number(v); renderBacktest(); })),
      field('Пресет таймфреймов', select(presetOpts, p.presetId, function (e) { p.presetId = e.target.value; }), 'сравнивайте пресеты только по контрольным 30%'),
      field('minScore', numInput(p.minScore, { min: 60, max: 100, step: 1, oninput: function (e) { p.minScore = Number(e.target.value); } })),
      field('Комиссия за сторону, %', numInput(p.feePct, { min: 0, step: 0.01, oninput: function (e) { p.feePct = Number(e.target.value); } }), '0.05 — фьючерсы, 0.1 — спот'),
      field('Проскальзывание на стопе, %', numInput(p.slipPct, { min: 0, step: 0.01, oninput: function (e) { p.slipPct = Number(e.target.value); } }))
    );
    var btns = h('div', { class: 'row-btns' },
      bt.running
        ? h('button', { type: 'button', class: 'btn danger', onclick: function () { App.cancelBacktest(); } }, 'Отменить')
        : h('button', { type: 'button', class: 'btn primary', onclick: function () { App.runBacktest(); } }, 'Запустить бэктест'));
    root.appendChild(section('Параметры', [form, btns]));
    if (bt.running || bt.progress.text) {
      var pr = h('div', { class: 'progress' }, h('div', { class: 'bar', style: 'width:' + Math.round((bt.progress.frac || 0) * 100) + '%' }));
      root.appendChild(section(null, [pr, h('div', { class: 'muted small', id: 'bt-progress-text' }, bt.progress.text || '')]));
    }
    if (bt.error) root.appendChild(h('div', { class: 'note err' }, 'Ошибка: ' + bt.error));
    var res = bt.result;
    if (res) renderBtResult(root, res);
    var cmp = Data.Store.get(C.storage.presets, []);
    if (Array.isArray(cmp) && cmp.length) {
      root.appendChild(section('Сравнение пресетов (только контрольные 30%)', tableWrap(mkTable(['Пресет', 'Период', 'Сделок', '✓', 'Средний R', 'PF', 'Дата'], cmp.map(function (x) {
        return { cells: [x.presetName, x.days + ' дн', String(x.n), fRate(x.winRate), fR(x.avgR), isNum(x.pf) ? fN(x.pf, 2) : '—', fDT(x.ts)] };
      })))));
    }
    root.appendChild(footer());
  }
  function updateBtProgress() {
    var bt = App.bt;
    var bar = document.querySelector('#screen-backtest .progress .bar');
    var tx = $('bt-progress-text');
    if (bar && tx) {
      bar.style.width = Math.round((bt.progress.frac || 0) * 100) + '%';
      tx.textContent = bt.progress.text || '';
    } else if (current === 'backtest') renderBacktest();
  }
  function statsRow(name, s) {
    return { cells: [name, String(s.signals), String(s.n), s.n ? fRate(s.winRate) : '—', fR(s.avgR), isNum(s.pf) ? fN(s.pf, 2) : (s.pf === Infinity ? '∞' : '—'), fR(s.sumR)] };
  }
  var STATS_HEAD = ['', 'Сигналов', 'Сделок', '✓', 'Средний R', 'PF', 'Сумма R'];
  function renderBtResult(root, res) {
    var m = res.meta, s = res.summary;
    root.appendChild(h('div', { class: 'note' }, m.presetName + ' · ' + m.days + ' дн (' + fDate(m.startT) + ' — ' + fDate(m.endT) + ') · minScore ' + m.minScore + ' · комиссия ' + m.feePct + '% · проскальзывание ' + m.slipPct + '% · ' + m.source + (m.longOnly ? ' · только LONG' : '')));
    if (s.n < C.backtest.minTrades) root.appendChild(h('div', { class: 'note warn' }, 'Выборка мала, выводы ненадёжны (сделок: ' + s.n + ', нужно хотя бы ' + C.backtest.minTrades + ').'));
    (res.warnings || []).forEach(function (w) { root.appendChild(h('div', { class: 'note warn' }, w)); });
    if (res.calibrated) root.appendChild(h('div', { class: 'note good' }, 'Калибровка точности обновлена по корзинам score этого прогона.'));
    root.appendChild(section('Сводка', h('div', { class: 'kv-grid' },
      kv('Сигналов', String(s.signals)), kv('Входов', String(s.entries)),
      kv('Просрочено', String(s.expired + s.invalidated)), kv('Открыто на конец', String(s.open)),
      kv('Успешных ✓', s.n ? s.wins + ' (' + fRate(s.winRate) + ')' : '—', 'good'),
      kv('Неуспешных ✗', s.n ? s.losses + ' (' + fRate(s.lossRate) + ')' : '—', 'bad'),
      kv('✓ затем безубыток', String(s.be)),
      kv('TP1 / TP2 / TP3', fRate(s.tpRate[0]) + ' / ' + fRate(s.tpRate[1]) + ' / ' + fRate(s.tpRate[2])),
      kv('Средний результат', fR(s.avgR)), kv('Матожидание на сделку', fR(s.avgR)),
      kv('Profit factor', isNum(s.pf) ? fN(s.pf, 2) : (s.pf === Infinity ? '∞' : '—')),
      kv('Макс. просадка', fR(-s.maxDD)),
      kv('Итог при риске 1%', fPct(s.compPct) + ' (сложный процент)'),
      kv('Серия неуспешных', String(s.maxLossStreak))
    )));
    var cv = h('canvas', { class: 'chart eq', 'aria-label': 'Кривая капитала в R' });
    root.appendChild(section('Кривая капитала, R', cv));
    var drawEq = function () { drawEquity(cv, s.curve); };
    charts.push(drawEq);
    requestAnimationFrame(drawEq);
    root.appendChild(section('Контроль: первые 70% и последние 30% периода', tableWrap(mkTable(STATS_HEAD, [
      statsRow('Первые 70%', res.split.inS), statsRow('Последние 30% (контроль)', res.split.outS)
    ]))));
    root.appendChild(section('По монетам', tableWrap(mkTable(STATS_HEAD, res.byCoin.map(function (x) { return statsRow(x.coin, x.s); })))));
    root.appendChild(section('По корзинам score (из неё считается калибровка)', tableWrap(mkTable(STATS_HEAD, res.byBucket.map(function (x) { return statsRow(x.label, x.s); })))));
    if (res.funnel) {
      root.appendChild(section('Воронка отбора', tableWrap(mkTable(['Стадия', 'Осталось'], res.funnel.map(function (f) { return { cells: [f.label, f.n.toLocaleString('ru-RU')] }; })))));
    }
    if (res.rejects && res.rejects.length) {
      root.appendChild(section('Причины отказа (после слома структуры)', tableWrap(mkTable(['Причина', 'Раз'], res.rejects.slice(0, 15).map(function (x) { return { cells: [x.text, String(x.n)] }; })))));
    }
    renderTradeList(root, res);
  }
  function outcomeCell(sig) {
    if (sig.status === 'closed') return { v: sig.tpHit[0] ? (sig.outcome === 'be' ? '✓ БУ' : '✓ ' + (sig.outcome || '').toUpperCase()) : '✗ SL', cls: sig.tpHit[0] ? 'good' : 'bad' };
    if (sig.status === 'expired' || sig.status === 'invalidated') return { v: 'просрочен', cls: 'muted' };
    return { v: 'открыт', cls: 'muted' };
  }
  function renderTradeList(root, res) {
    var coins = res.meta.coins;
    var list = res.signals.filter(function (x) {
      if (btFilter.coin !== 'all' && x.coin !== btFilter.coin) return false;
      if (btFilter.out === 'win') return x.status === 'closed' && x.tpHit[0];
      if (btFilter.out === 'loss') return x.status === 'closed' && !x.tpHit[0];
      if (btFilter.out === 'be') return x.status === 'closed' && x.outcome === 'be';
      if (btFilter.out === 'expired') return x.status === 'expired' || x.status === 'invalidated';
      if (btFilter.out === 'open') return Signals.isOpen(x);
      return true;
    });
    var k = btSort.key, d = btSort.dir;
    list.sort(function (a, b) {
      var va = a[k], vb = b[k];
      if (k === 'resultR') { va = isNum(va) ? va : -1e9; vb = isNum(vb) ? vb : -1e9; }
      if (typeof va === 'string') return d * va.localeCompare(vb);
      return d * ((va || 0) - (vb || 0));
    });
    var tools = h('div', { class: 'toolbar' },
      field('Монета', select([['all', 'Все']].concat(coins.map(function (c) { return [c, c]; })), btFilter.coin, function (e) { btFilter.coin = e.target.value; rerenderList(); })),
      field('Итог', select([['all', 'Все'], ['win', '✓ успешные'], ['loss', '✗ неуспешные'], ['be', '✓ затем БУ'], ['expired', 'Просроченные'], ['open', 'Открытые']], btFilter.out, function (e) { btFilter.out = e.target.value; rerenderList(); })),
      h('button', { type: 'button', class: 'btn', onclick: function () { App.exportCSV(); } }, 'Экспорт CSV'));
    var keys = ['createdT', 'coin', 'side', 'score', 'entry', 'sl', 'tp1', 'tp2', 'tp3', null, 'resultR'];
    var rows = list.slice(0, 500).map(function (x) {
      return { cells: [fDT(x.createdT), x.coin, { v: x.side, cls: x.dir === 1 ? 'up' : 'down' }, String(x.score), fP(x.entry), fP(x.sl), fP(x.tp1), fP(x.tp2), fP(x.tp3), outcomeCell(x), { v: x.status === 'closed' ? fR(x.resultR) : '—', cls: x.resultR > 0 ? 'good' : (x.resultR < 0 ? 'bad' : '') }] };
    });
    var table = mkTable(['Дата', 'Монета', 'Сторона', 'Score', 'Вход', 'SL', 'TP1', 'TP2', 'TP3', 'Итог', 'R'], rows, {
      keys: keys, sortKey: btSort.key, cls: 'trades',
      onSort: function (key) { if (btSort.key === key) btSort.dir = -btSort.dir; else { btSort.key = key; btSort.dir = -1; } rerenderList(); }
    });
    var wrapBox = h('div', { id: 'bt-list' }, tools, tableWrap(table), list.length > 500 ? h('div', { class: 'muted small' }, 'Показаны первые 500 из ' + list.length + '. Полный список — в CSV.') : null);
    var old = $('bt-list');
    if (old) old.replaceWith(section('Проверенные сигналы (' + list.length + ')', wrapBox));
    else root.appendChild(section('Проверенные сигналы (' + list.length + ')', wrapBox));
    function rerenderList() {
      var holder = $('bt-list');
      if (!holder) return;
      var card = holder.parentNode;
      var parent = card.parentNode, next = card.nextSibling;
      parent.removeChild(card);
      var tmp = document.createElement('div');
      renderTradeList(tmp, res);
      parent.insertBefore(tmp.firstChild, next);
    }
  }

  // =====================================================================================
  // ЭКРАН «НАСТРОЙКИ»
  // =====================================================================================
  function renderSettings() {
    var root = $('screen-settings');
    clear(root);
    var s = App.settings;
    root.appendChild(h('h2', { class: 'screen-title' }, 'Настройки'));
    var srcOpts = [['auto', 'Авто: Futures → Spot → Bybit']].concat(C.sourceOrder.map(function (id) { return [id, Data.ADAPTERS[id].name]; }));
    var coinsInp = h('input', { type: 'text', class: 'inp', value: s.symbols.join(', '), autocapitalize: 'characters', spellcheck: 'false' });
    root.appendChild(section('Данные и режим', h('div', { class: 'form-grid' },
      field('Источник данных', select(srcOpts, s.source, function (e) { App.updateSettings({ source: e.target.value }, true); })),
      field('Режим сигналов', seg([['both', 'LONG и SHORT'], ['long', 'Только LONG']], s.mode, function (v) { App.updateSettings({ mode: v }, false); renderSettings(); }), '«Только LONG» — для спота'),
      field('minScore (порог публикации)', numInput(s.minScore, { min: 60, max: 100, step: 1, onchange: function (e) { App.updateSettings({ minScore: Number(e.target.value) }, false); renderSettings(); } }), 'от 60 до 100, по умолчанию ' + C.minScore),
      field('Риск на сделку, %', numInput(s.riskPct, { min: 0.1, max: 10, step: 0.1, onchange: function (e) { App.updateSettings({ riskPct: Number(e.target.value) }, false); } })),
      field('Комиссия фьючерсы, % за сторону', numInput(s.feeFutures, { min: 0, step: 0.01, onchange: function (e) { App.updateSettings({ feeFutures: Number(e.target.value) }, false); } })),
      field('Комиссия спот, % за сторону', numInput(s.feeSpot, { min: 0, step: 0.01, onchange: function (e) { App.updateSettings({ feeSpot: Number(e.target.value) }, false); } })),
      field('Проскальзывание на стопе, %', numInput(s.slipPct, { min: 0, step: 0.01, onchange: function (e) { App.updateSettings({ slipPct: Number(e.target.value) }, false); } }))
    )));
    root.appendChild(section('Список монет', [
      field('Тикеры через запятую (пары к ' + C.quote + ')', coinsInp, 'Если пары нет на источнике, берётся запасная: ' + C.reserveSymbols.join(', ')),
      h('div', { class: 'row-btns' },
        h('button', { type: 'button', class: 'btn primary', onclick: function () { App.setCoins(coinsInp.value); } }, 'Применить'),
        h('button', { type: 'button', class: 'btn', onclick: function () { coinsInp.value = C.symbols.join(', '); App.setCoins(coinsInp.value); } }, 'По умолчанию'))
    ]));
    var snd = h('input', { type: 'checkbox', checked: s.sound, onchange: function (e) { App.updateSettings({ sound: e.target.checked }, false); } });
    root.appendChild(section('Уведомления', h('div', { class: 'row-btns' },
      h('label', { class: 'check' }, snd, h('span', null, 'Звук при новом сигнале')),
      h('button', { type: 'button', class: 'btn small', onclick: function () { App.beep(); } }, 'Проверить звук'))));
    var tot = Signals.Calib.totals(), cd = Signals.Calib.data;
    var calibBody = [];
    if (tot.n) {
      calibBody.push(h('div', { class: 'muted small' }, 'Обновлена ' + fDT(cd.ts) + ' · ' + cd.days + ' дн · minScore ' + cd.minScore + ' · сделок ' + tot.n + ' · общая успешность ' + Math.round(tot.s / tot.n * 100) + '%'));
      if (tot.n < C.calibration.minTotal) calibBody.push(h('div', { class: 'note warn' }, 'Выборка мала, выводы ненадёжны: ' + tot.n + ' сделок из нужных ' + C.calibration.minTotal + '. Точность на карточках не показывается — только score с пометкой «предварительная оценка». Увеличьте период бэктеста (180 дней).'));
      calibBody.push(tableWrap(mkTable(['Корзина', 'Сделок', 'Успешных', '%'], C.calibration.buckets.map(function (b) {
        var x = tot.b[b];
        return { cells: [Signals.Calib.bucketLabel(b), String(x.n), String(x.s), x.n ? Math.round(x.s / x.n * 100) + '%' : '—'] };
      }))));
    } else calibBody.push(h('p', { class: 'muted' }, 'Калибровки нет: точность показывается как score с пометкой «предварительная оценка».'));
    calibBody.push(h('div', { class: 'row-btns' },
      h('button', { type: 'button', class: 'btn primary', onclick: function () { App.calibrate(); } }, 'Откалибровать (60 дней)'),
      tot.n ? h('button', { type: 'button', class: 'btn', onclick: function () { Signals.Calib.clear(); toast('Калибровка сброшена'); renderSettings(); } }, 'Сбросить калибровку') : null));
    root.appendChild(section('Калибровка точности', calibBody));
    root.appendChild(section('Сброс сохранённых данных', h('div', { class: 'row-btns' },
      h('button', { type: 'button', class: 'btn', onclick: function () { if (confirm('Удалить журнал сигналов?')) App.resetJournal(); } }, 'Журнал сигналов'),
      h('button', { type: 'button', class: 'btn', onclick: function () { App.clearCache(); } }, 'Кэш истории'),
      h('button', { type: 'button', class: 'btn danger', onclick: function () { if (confirm('Сбросить все настройки, журнал, калибровку и кэш?')) App.resetAll(); } }, 'Сбросить всё'))));
    var stt = App.feedStatus(), net = Data.Net.stats;
    root.appendChild(section('Состояние', h('div', { class: 'kv-grid' },
      kv('Источник', stt.source || '—'), kv('Рынок', stt.market === 'spot' ? 'спот' : (stt.market ? 'фьючерсы' : '—')),
      kv('Обновлено', fTimeS(stt.lastUpdate)), kv('Ошибка', stt.error || 'нет'),
      kv('Запросов', String(net.requests)), kv('Повторов / ошибок', net.retries + ' / ' + net.errors),
      kv('Самопроверка', App.selfTest ? (App.selfTest.ok ? 'OK (' + App.selfTest.passed + '/' + App.selfTest.total + ')' : 'ОШИБКА: ' + App.selfTest.failed.join(', ')) : '—', App.selfTest && App.selfTest.ok ? 'good' : 'bad'),
      kv('Версия', C.version)
    )));
    if (stt.notes && stt.notes.length) root.appendChild(section('Замены монет', h('ul', { class: 'why-extra' }, stt.notes.map(function (n) { return h('li', null, n); }))));
    var logBox = h('div', { class: 'log' });
    App.logs.slice().reverse().slice(0, 200).forEach(function (l) {
      logBox.appendChild(h('div', { class: 'log-row ' + l.level }, h('span', { class: 'log-t' }, fDT(l.t)), h('span', { class: 'log-x' }, l.text)));
    });
    if (!App.logs.length) logBox.appendChild(h('div', { class: 'muted' }, 'Пока пусто'));
    root.appendChild(section('Отладочный лог (причины отказов)', [logBox, h('div', { class: 'row-btns' }, h('button', { type: 'button', class: 'btn small', onclick: function () { App.clearLog(); renderSettings(); } }, 'Очистить лог'))]));
    root.appendChild(footer());
  }

  var RENDER = { best: renderBest, signals: renderSignals, calc: renderCalc, backtest: renderBacktest, settings: renderSettings };

  function init(app) {
    App = app;
    document.querySelectorAll('.tab').forEach(function (b) {
      b.addEventListener('click', function () { App.navigate(b.getAttribute('data-screen')); });
    });
    var t = null;
    window.addEventListener('resize', function () { clearTimeout(t); t = setTimeout(redrawCharts, 150); });
  }

  return {
    init: init, show: show, update: update, isShown: isShown, renderStatus: renderStatus, toast: toast,
    updateBtProgress: updateBtProgress, fP: fP, roundP: roundP, fDT: fDT, current: function () { return current; }
  };
})();
