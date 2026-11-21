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
  function modeName(m) { return (C.strategyModes[m] || C.strategyModes.strict).name; }
  // Срок ожидания входа: «12 свечей 15m (3 ч)».
  function plural(n, one, few, many) {
    var a = Math.abs(n) % 100, b = a % 10;
    if (a > 10 && a < 20) return many;
    if (b === 1) return one;
    if (b >= 2 && b <= 4) return few;
    return many;
  }
  function hoursText(bars, tf) {
    var mins = bars * SMC.tfMs(tf || C.timeframes.ltf) / 60000;
    if (mins < 60) return Math.round(mins) + ' мин';
    var hrs = mins / 60;
    if (hrs >= 48 && hrs % 24 === 0) return (hrs / 24) + ' дн';
    return (hrs % 1 === 0 ? String(hrs) : hrs.toFixed(1)) + ' ч';
  }
  function waitText(bars, tf) {
    bars = bars || C.lifecycle.expiryBars;
    return bars + ' ' + plural(bars, 'свеча', 'свечи', 'свечей') + ' ' + (tf || C.timeframes.ltf) + ' (' + hoursText(bars, tf) + ')';
  }
  function modeChip(sig) {
    var M = C.strategyModes[sig.mode];
    return (M && sig.mode !== 'strict') ? h('span', { class: 'chip ' + sig.mode, title: 'Профиль стратегии: ' + M.name }, M.short) : null;
  }
  function presetOf(sig) { return C.presets[sig.preset] || C.presets.main; }
  function presetChip(sig) {
    var P = presetOf(sig);
    return P.id === 'main' ? null : h('span', { class: 'chip preset', title: P.name }, P.short);
  }
  function accuracyBlock(sig) {
    var acc = Signals.Calib.accuracy(sig.coin, sig.score, sig.mode, sig.preset);
    var wrap = h('div', { class: 'acc' });
    var calName = 'профиля «' + modeName(sig.mode) + '», пресет ' + presetOf(sig).short;
    if (!acc) {
      var tn = Signals.Calib.totals(sig.mode, sig.preset).n;
      wrap.appendChild(h('div', { class: 'acc-num ' + accColor(sig.score) }, String(sig.score)));
      wrap.appendChild(h('div', { class: 'acc-label' }, 'Score · предварительная оценка'));
      wrap.appendChild(h('div', { class: 'acc-sub' }, tn > 0
        ? 'Калибровка ' + calName + ' ненадёжна: в истории всего ' + tn + ' сделок (нужно не меньше ' + C.calibration.minTotal + ') — точность не показывается'
        : 'Калибровки ' + calName + ' по истории ещё нет'));
      if (sig.mode === (App.settings.strategy || 'strict')) wrap.appendChild(h('button', { type: 'button', class: 'btn small', onclick: function () { App.calibrate(sig.preset); } }, 'Откалибровать'));
    } else {
      var v = Math.round(acc.value * 100);
      wrap.appendChild(h('div', { class: 'acc-num ' + accColor(v) }, v + '%'));
      wrap.appendChild(h('div', { class: 'acc-label' }, 'Точность'));
      var sub = 'score ' + sig.score + ' · по истории ' + v + '% на ' + acc.n + ' сделках';
      if (acc.smoothed) sub += ' (сглажено к общей ' + Math.round(acc.p * 100) + '%)';
      sub += ' · корзина ' + Signals.Calib.bucketLabel(acc.bucket) + ', ' + acc.scope;
      wrap.appendChild(h('div', { class: 'acc-sub' }, sub));
      var ci = Signals.Calib.info(sig.mode, sig.preset), calWait = ci && ci.expiryBars ? ci.expiryBars : C.lifecycle.expiryBars;
      if (calWait !== (sig.expiryBars || C.lifecycle.expiryBars)) {
        wrap.appendChild(h('div', { class: 'acc-sub warn-text' }, 'Калибровка сделана при ожидании входа ' + waitText(calWait) + ', а у сигнала — ' + waitText(sig.expiryBars) + '. Откалибруйте заново для точной оценки.'));
      }
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
      h('div', { class: 'muted small zone-line' }, 'Зона входа: ' + fP(sig.zone.bot) + '–' + fP(sig.zone.top) + ' (' + sig.zone.kind.toUpperCase() + '), риск ' + fN(sig.riskPct, 2) + '% от входа'),
      h('div', { class: 'muted small' }, managementText()));
  }
  // Название стопа после TP: 'be' — безубыток, 'tp1' — стоп на TP1, null — стоп не двигается (prev).
  function stopName(kind, prev) {
    var k = kind || prev;
    return k === 'be' ? 'безубыток' : (k === 'tp1' ? 'стоп на TP1' : 'стоп по SL');
  }
  // Сопровождение одной строкой — по CONFIG.tp (доли и перенос стопа).
  function managementText() {
    var mv = C.tp.moveStop, f = C.tp.fractions;
    function act(k, prev) { return k === 'be' ? 'стоп в безубыток' : (k === 'tp1' ? 'стоп на TP1' : (prev ? 'стоп не двигаем' : 'стоп остаётся на SL')); }
    return 'Сопровождение: на TP1 закрыть ' + Math.round(f[0] * 100) + '% — ' + act(mv[0], false) + '; на TP2 закрыть ' + Math.round(f[1] * 100) + '% — ' +
      act(mv[1], true) + '; остаток — на TP3.';
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
      var cds = App.candlesFor(sig.sym, sig.tf && sig.tf.ltf);
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
      badgeSide(sig.dir), statusChip(sig, prov), presetChip(sig), modeChip(sig)));
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
      kv('ТФ', sig.tf.htf + ' → ' + sig.tf.mtf + ' → ' + sig.tf.ltf),
      kv('Пресет', presetOf(sig).name),
      kv('Профиль стратегии', modeName(sig.mode)),
      kv('Ожидание входа', waitText(sig.expiryBars, sig.tf && sig.tf.ltf))
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
    var PP = C.presets[App.primaryPreset()];
    return tableWrap(mkTable(['Монета', 'Цена', 'Тренд ' + PP.htf.toUpperCase(), 'Статус', 'Score'], rows, { cls: 'coins' }));
  }
  // «Стоп-кран»: реальные сделки журнала идут заметно хуже истории (пороги — CONFIG.guard).
  function guardNote() {
    var g = App.guardStatus(), G = C.guard;
    if (!g.active) return null;
    var why = [];
    if (g.streak) why.push(G.lossStreak + ' неуспешных сделок подряд');
    if (g.deep) why.push('итог за ' + G.windowDays + ' дней ' + fR(g.sumR));
    return h('div', { class: 'note err' }, '⚠️ Режим идёт хуже истории: ' + why.join(', ') + '. Сделайте паузу и проверьте режим: Настройки → «Проверка на истории» (90 и 180 дней).');
  }
  // Карточка из ссылки Telegram (#sig=… или #coin=…): сигнал из журнала с графиком, иначе график монеты.
  function focusCard(f) {
    var head = h('div', { class: 'row-btns focus-head' }, h('span', { class: 'chip live' }, 'Из Telegram'),
      h('button', { type: 'button', class: 'btn small', onclick: function () { App.clearFocus(); } }, 'Скрыть'));
    var sig = App.focusSignal();
    if (sig) {
      var card = signalCardFull(sig);
      card.insertBefore(head, card.firstChild);
      return card;
    }
    var coin = f.coin, sym = coin ? coin + C.quote : null, tf = C.presets[App.primaryPreset()].ltf;
    var box = h('div', { class: 'card' }, head, h('h3', { class: 'card-title' }, coin ? 'График ' + coin + ' · ' + tf : 'Сигнал из Telegram'));
    if (!App.ready) { box.appendChild(h('p', { class: 'muted' }, 'Загружаю данные…')); return box; }
    if (f.sig) box.appendChild(h('div', { class: 'note' }, 'Этого сигнала нет в журнале приложения: возможно, он уже завершился, найден по другим свечам или приложение было закрыто. Ниже — график монеты.'));
    var cds = sym ? App.candlesFor(sym, tf) : null;
    if (!cds || !cds.length) {
      box.appendChild(h('p', { class: 'muted' }, coin ? 'Монеты ' + coin + ' нет в вашем списке — добавьте её в Настройках, чтобы видеть график.' : 'Монета не указана.'));
      return box;
    }
    var cv = h('canvas', { class: 'chart', 'aria-label': 'График ' + coin });
    box.appendChild(h('div', { class: 'chart-box' }, cv));
    var draw = function () {
      drawCandles(cv, App.candlesFor(sym, tf), { levels: [{ price: App.priceOf(sym), color: cssVar('--muted', '#94a3b8'), label: 'Цена', dash: true }] });
    };
    charts.push(draw);
    requestAnimationFrame(draw);
    return box;
  }
  function renderBest() {
    var root = $('screen-best');
    clear(root);
    root.appendChild(h('h2', { class: 'screen-title' }, 'Лучшая сделка сейчас'));
    var gnb = guardNote();
    if (gnb) root.appendChild(gnb);
    if (App.focus) root.appendChild(focusCard(App.focus));
    var best = App.bestSignal(), focusSig = App.focus ? App.focusSignal() : null;
    if (best && focusSig && best.id === focusSig.id) { /* лучший сигнал уже показан карточкой из Telegram */ }
    else if (best) root.appendChild(signalCardFull(best));
    else {
      var st = App.feedStatus();
      if (st.state === 'error' || (st.state === 'loading' && st.error)) {
        root.appendChild(h('div', { class: 'card empty' },
          h('div', { class: 'empty-title' }, 'Нет связи с биржами'),
          h('p', { class: 'muted' }, (st.error || 'Нет ответа').replace(/[.\s]+$/, '') + '. Приложение само повторяет подключение. Источник выбирается в Настройках (по умолчанию Binance Spot, режим «Авто» перебирает Binance Futures → Binance Spot → Bybit). Проверьте интернет; если биржи заблокированы в вашей сети, данные не загрузятся.')));
      } else {
        var msg = st.state === 'loading' || !st.lastUpdate ? 'Загружаю данные и анализирую рынок…' : 'Сейчас нет качественных сетапов — лучше ждать';
        var soft = App.settings.strategy !== 'strict', pids = App.activePresets();
        var tfsText = pids.map(function (pid) { var P = C.presets[pid]; return P.short + ' ' + P.htf + '/' + P.mtf + '/' + P.ltf; }).join(', ');
        root.appendChild(h('div', { class: 'card empty' },
          h('div', { class: 'empty-title' }, msg),
          h('p', { class: 'muted' }, 'Профиль «' + modeName(App.settings.strategy) + '», таймфреймы: ' + tfsText + '. Бот публикует сигнал только при полном сценарии SMC (тренд старшего ТФ, свежая зона среднего, ' + (soft ? 'CHoCH/BOS' : 'sweep и CHoCH/BOS') + ' на младшем) и score не ниже ' + App.settings.minScore + '. Отсутствие сигнала — правильный результат, а не ошибка.'),
          !Signals.Calib.has(App.settings.strategy, pids[0]) ? h('button', { type: 'button', class: 'btn small', onclick: function () { App.calibrate(pids[0]); } }, 'Откалибровать точность (бэктест 60 дней)') : null));
      }
    }
    var others = App.openSignals().filter(function (s) { return !best || s.id !== best.id; });
    if (others.length) {
      root.appendChild(section('Другие открытые сигналы', h('div', { class: 'mini-list' }, others.map(miniSignal))));
    }
    root.appendChild(section('Все монеты', coinsTable()));
    root.appendChild(footer());
  }
  function miniSignal(sig) {
    var acc = Signals.Calib.accuracy(sig.coin, sig.score, sig.mode, sig.preset);
    return h('div', { class: 'mini' },
      h('div', { class: 'mini-top' }, h('b', null, sig.coin), badgeSide(sig.dir), statusChip(sig, App.provisionalOf(sig)), presetChip(sig), modeChip(sig)),
      h('div', { class: 'mini-lv' }, 'Вход ' + fP(sig.entry) + ' · SL ' + fP(sig.sl) + ' · TP3 ' + fP(sig.tp3)),
      h('div', { class: 'mini-sub' }, 'score ' + sig.score + (acc ? ' · точность ' + Math.round(acc.value * 100) + '%' : ' · предварительно') + ' · ' + fDT(sig.createdT)),
      h('div', { class: 'row-btns' }, h('button', { type: 'button', class: 'btn small', onclick: function () { App.toCalc(sig.id); } }, 'В калькулятор')));
  }

  // =====================================================================================
  // ЭКРАН «СИГНАЛЫ»
  // =====================================================================================
  var sigFilter = 'all', sigMode = 'all', sigPreset = 'all';
  function renderSignals() {
    var root = $('screen-signals');
    clear(root);
    root.appendChild(h('h2', { class: 'screen-title' }, 'Сигналы'));
    root.appendChild(h('div', { class: 'note' }, 'Сигналы по разным монетам сильно коррелируют: не открывайте больше 2–3 сделок одновременно.'));
    var gn = guardNote();
    if (gn) root.appendChild(gn);
    var all = Signals.Journal.list.slice();
    var coins = [];
    all.forEach(function (s) { if (coins.indexOf(s.coin) < 0) coins.push(s.coin); });
    var list = all.filter(function (s) {
      return (sigFilter === 'all' || s.coin === sigFilter) && (sigMode === 'all' || (s.mode || 'strict') === sigMode) &&
        (sigPreset === 'all' || (s.preset || 'main') === sigPreset);
    });
    var st = Signals.stats(list);
    root.appendChild(section('Статистика журнала (live)', h('div', { class: 'kv-grid' },
      kv('Сигналов', String(st.signals)), kv('Открыто', String(st.open)),
      kv('Закрытых сделок', String(st.n)), kv('Дошли до TP1 ✓', st.n ? st.wins + ' (' + fRate(st.winRate) + ')' : '—', 'good'),
      kv('Не дошли до TP1 ✗', st.n ? st.losses + ' (' + fRate(st.lossRate) + ')' : '—', 'bad'), kv('✓ затем безубыток', String(st.be)),
      kv('Просрочено', String(st.expired + st.invalidated)), kv('Средний результат', fR(st.avgR)),
      kv('Сумма', st.n ? fR(st.sumR) : '—'), kv('Profit factor', isNum(st.pf) ? fN(st.pf, 2) : (st.pf === Infinity ? '∞' : '—'))
    )));
    var opts = [['all', 'Все монеты']].concat(coins.map(function (c) { return [c, c]; }));
    var modeOpts = [['all', 'Все профили']].concat(Object.keys(C.strategyModes).map(function (k) { return [k, C.strategyModes[k].name]; }));
    var presetOpts = [['all', 'Все пресеты']].concat(Object.keys(C.presets).map(function (k) { return [k, C.presets[k].name]; }));
    root.appendChild(h('div', { class: 'toolbar' },
      field('Фильтр по монете', select(opts, sigFilter, function (e) { sigFilter = e.target.value; renderSignals(); })),
      field('Пресет', select(presetOpts, sigPreset, function (e) { sigPreset = e.target.value; renderSignals(); })),
      field('Профиль стратегии', select(modeOpts, sigMode, function (e) { sigMode = e.target.value; renderSignals(); }))));
    if (!list.length) root.appendChild(h('div', { class: 'card empty' }, h('div', { class: 'empty-title' }, 'Журнал пуст'), h('p', { class: 'muted' }, 'Сюда попадают все выданные сигналы и их итог: TP1, TP2, TP3, SL, безубыток, просрочен.')));
    var box = h('div', { class: 'sig-list' });
    list.forEach(function (sig) { box.appendChild(journalItem(sig)); });
    root.appendChild(box);
    root.appendChild(footer());
  }
  function journalItem(sig) {
    var prov = App.provisionalOf(sig);
    var acc = Signals.Calib.accuracy(sig.coin, sig.score, sig.mode, sig.preset);
    var res = sig.status === 'closed' ? fR(sig.resultR) : (sig.status === 'active' ? fR(Signals.openR(sig, App.priceOf(sig.sym))) + ' (открыта)' : '');
    var item = h('details', { class: 'card j-item' });
    item.appendChild(h('summary', null,
      h('div', { class: 'j-top' }, h('b', null, sig.coin), badgeSide(sig.dir), statusChip(sig, prov), presetChip(sig), modeChip(sig), h('span', { class: 'j-res ' + (sig.resultR > 0 ? 'good' : (sig.resultR < 0 ? 'bad' : '')) }, res)),
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
      kv(r.moveStop[0] === 'be' ? 'Безубыток (стоп после TP1)' : (r.moveStop[1] === 'be' ? 'Безубыток (стоп после TP2)' : 'Безубыток'), fP(r.be))
    )));
    var sc = r.scenarios;
    function row(name, x) { return { cells: [name, x ? { v: fUsd(x.usd), cls: x.usd >= 0 ? 'good' : 'bad' } : '—', x ? fPct(x.pct) : '—', x ? fR(x.r) : '—', x ? fN(x.fees, 3) : '—'] }; }
    box.appendChild(section('Сценарии (с комиссиями)', tableWrap(mkTable(['Сценарий', 'USDT', '% депозита', 'R', 'Комиссии'], [
      row('SL', sc.sl), row('TP1, затем ' + stopName(r.moveStop[0], 'sl'), sc.tp1stop),
      row('TP1 и TP2, затем ' + stopName(r.moveStop[1], r.moveStop[0] || 'sl'), sc.tp12), row('Все три TP', sc.all)
    ]))));
    box.appendChild(section('R:R и ожидание', h('div', { class: 'kv-grid' },
      kv('R:R TP1 / TP2 / TP3', fN(r.rr[0], 2) + ' / ' + fN(r.rr[1], 2) + ' / ' + fN(r.rr[2], 2)),
      kv('Средний R:R (по долям)', fN(r.rrAvg, 2)),
      kv('Матожидание', r.ev === null ? 'укажите p' : fUsd(r.ev) + ' USDT', r.ev > 0 ? 'good' : (r.ev < 0 ? 'bad' : '')),
      kv('Формула', 'p × «TP1, затем ' + stopName(r.moveStop[0], 'sl') + '» + (1 − p) × «SL»')
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
    var modeOpts = Object.keys(C.strategyModes).map(function (k) { return [k, C.strategyModes[k].name]; });
    var waitOpts = C.lifecycle.expiryOptions.map(function (b) {
      return [b, b + ' ' + plural(b, 'свеча', 'свечи', 'свечей') + (b === C.lifecycle.expiryBars ? ' — по промпту' : '')];
    });
    var form = h('div', { class: 'form-grid' },
      field('Профиль стратегии', select(modeOpts, p.mode || 'strict', function (e) { p.mode = e.target.value; }), 'мягкий: sweep не обязателен, P/D по 1H, вход у границы зоны'),
      field('Ожидание входа', select(waitOpts, p.expiryBars || C.lifecycle.expiryBars, function (e) { p.expiryBars = Number(e.target.value); }), 'свечей младшего ТФ; на 15m: ' + C.lifecycle.expiryOptions.map(function (b) { return hoursText(b, '15m'); }).join(' / ')),
      field('Монета', select(coinOpts, p.coin, function (e) { p.coin = e.target.value; })),
      field('Период', seg(C.backtest.days.map(function (d) { return [d, d + ' дн']; }), p.days, function (v) { p.days = Number(v); renderBacktest(); })),
      field('Пресет таймфреймов', select(presetOpts, p.presetId, function (e) { p.presetId = e.target.value; }), 'сравнивайте пресеты только по контрольным 30%'),
      field('minScore', numInput(p.minScore, { min: 60, max: 100, step: 1, oninput: function (e) { p.minScore = Number(e.target.value); } })),
      field('Комиссия за сторону, %', numInput(p.feePct, { min: 0, step: 0.01, oninput: function (e) { p.feePct = Number(e.target.value); } }), '0.05 — фьючерсы, 0.1 — спот'),
      field('Проскальзывание на стопе, %', numInput(p.slipPct, { min: 0, step: 0.01, oninput: function (e) { p.slipPct = Number(e.target.value); } })),
      field('Сопровождение сделки', select(Object.keys(C.managementVariants).map(function (k) {
        return [k, C.managementVariants[k].name + (k === Backtest.currentManagement() ? ' — сейчас' : '')];
      }), p.management, function (e) { p.management = e.target.value; }), 'сравнивайте варианты на обоих отрезках: последние N дней и N дней до них'),
      field('Отрезок', seg([['0', 'Последние N дней'], ['1', 'N дней до них']], p.prev ? '1' : '0', function (v) { p.prev = v === '1'; renderBacktest(); }), 'N — выбранный период; «до них» — более ранний, независимый отрезок')
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
      root.appendChild(section('Сравнение вариантов (только контрольные 30%)', tableWrap(mkTable(['Пресет', 'Профиль', 'Ожидание', 'Период', 'Сделок', '✓', 'Средний R', 'PF', 'Дата'], cmp.map(function (x) {
        var eb = x.expiryBars || C.lifecycle.expiryBars;
        return { cells: [x.presetName, modeName(x.mode), eb + ' ' + plural(eb, 'свеча', 'свечи', 'свечей'), x.days + ' дн', String(x.n), fRate(x.winRate), fR(x.avgR), isNum(x.pf) ? fN(x.pf, 2) : '—', fDT(x.ts)] };
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
    var modeTxt = modeName(m.mode) + (m.requestedMode && m.requestedMode !== m.mode ? ' (выбран «' + modeName(m.requestedMode) + '»: на этом пресете — правила «' + modeName(m.mode) + '»)' : '');
    var mg = C.managementVariants[m.management];
    root.appendChild(h('div', { class: 'note' }, m.presetName + ' · профиль «' + modeTxt + '» · ожидание входа ' + waitText(m.expiryBars, m.tf && m.tf.ltf) + ' · ' + m.days + ' дн' +
      (m.offsetDays ? ' до последних ' + m.offsetDays + ' (независимый отрезок)' : '') + ' (' + fDate(m.startT) + ' — ' + fDate(m.endT) + ') · minScore ' + m.minScore +
      ' · комиссия ' + m.feePct + '% · проскальзывание ' + m.slipPct + '% · сопровождение «' + (mg ? mg.name : 'свои настройки') + '» · ' + m.source + (m.longOnly ? ' · только LONG' : '')));
    if (m.offsetDays || m.management !== Backtest.currentManagement()) root.appendChild(h('div', { class: 'note' }, 'Прогон не по текущим настройкам на свежей истории — калибровка и сравнение вариантов не обновлялись.'));
    if (s.n < C.backtest.minTrades) root.appendChild(h('div', { class: 'note warn' }, 'Выборка мала, выводы ненадёжны (сделок: ' + s.n + ', нужно хотя бы ' + C.backtest.minTrades + ').'));
    (res.warnings || []).forEach(function (w) { root.appendChild(h('div', { class: 'note warn' }, w)); });
    if (res.calibrated) root.appendChild(h('div', { class: 'note good' }, 'Калибровка точности обновлена: профиль «' + modeName(m.mode) + '», пресет ' + (C.presets[m.presetId] || C.presets.main).short + '.'));
    root.appendChild(section('Сводка', h('div', { class: 'kv-grid' },
      kv('Сигналов', String(s.signals)), kv('Входов', String(s.entries)),
      kv('Просрочено', String(s.expired + s.invalidated)), kv('Открыто на конец', String(s.open)),
      kv('Дошли до TP1 ✓', s.n ? s.wins + ' (' + fRate(s.winRate) + ')' : '—', 'good'),
      kv('Не дошли до TP1 ✗', s.n ? s.losses + ' (' + fRate(s.lossRate) + ')' : '—', 'bad'),
      kv('✓ затем безубыток', String(s.be)),
      kv('TP1 / TP2 / TP3', fRate(s.tpRate[0]) + ' / ' + fRate(s.tpRate[1]) + ' / ' + fRate(s.tpRate[2])),
      kv('Средний результат', fR(s.avgR)), kv('Матожидание на сделку', fR(s.avgR)),
      kv('Profit factor', isNum(s.pf) ? fN(s.pf, 2) : (s.pf === Infinity ? '∞' : '—')),
      kv('Макс. просадка', fR(-s.maxDD)),
      kv('Итог при риске 1%', fPct(s.compPct) + ' (сложный процент)'),
      kv('Серия неуспешных', String(s.maxLossStreak)),
      kv('Разброс итога, 90% повторов', res.spread ? fR(res.spread.p5) + ' … ' + fR(res.spread.p95) : '—'),
      kv('Итог ≤ 0 в повторах', res.spread ? Math.round(res.spread.pNeg * 100) + '% (просадка до ' + fR(-res.spread.dd95) + ')' : '—')
    )));
    var cv = h('canvas', { class: 'chart eq', 'aria-label': 'Кривая капитала в R' });
    root.appendChild(section('Кривая капитала, R', cv));
    var drawEq = function () { drawEquity(cv, s.curve); };
    charts.push(drawEq);
    requestAnimationFrame(drawEq);
    root.appendChild(section('Контроль: первые 70% и последние 30% периода', tableWrap(mkTable(STATS_HEAD, [
      statsRow('Первые 70%', res.split.inS), statsRow('Последние 30% (контроль)', res.split.outS)
    ]))));
    if (res.byMonth && res.byMonth.length > 1) {
      root.appendChild(section('По месяцам (блоки по 30 дней, справа — последний)', [monthBars(res.byMonth), monthTable(res.byMonth, false),
        h('div', { class: 'muted small' }, 'Ровный результат по месяцам важнее общего итога: один удачный месяц может перекрыть несколько убыточных.')]));
    }
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
    if (sig.status === 'closed') {
      var OUT = { be: '✓ TP1 → БУ', tp1sl: '✓ TP1 → SL', tp2: '✓ TP2 → TP1', tp2be: '✓ TP2 → БУ', tp2sl: '✓ TP2 → SL', tp3: '✓ TP3' };
      return { v: sig.tpHit[0] ? (OUT[sig.outcome] || '✓ ' + String(sig.outcome || '').toUpperCase()) : '✗ SL', cls: sig.resultR > 0 ? 'good' : 'bad' };
    }
    if (sig.status === 'expired' || sig.status === 'invalidated') return { v: 'просрочен', cls: 'muted' };
    return { v: 'открыт', cls: 'muted' };
  }
  function renderTradeList(root, res) {
    var coins = res.meta.coins;
    var list = res.signals.filter(function (x) {
      if (btFilter.coin !== 'all' && x.coin !== btFilter.coin) return false;
      if (btFilter.out === 'win') return x.status === 'closed' && x.tpHit[0];
      if (btFilter.out === 'loss') return x.status === 'closed' && !x.tpHit[0];
      if (btFilter.out === 'be') return x.status === 'closed' && (x.outcome === 'be' || x.outcome === 'tp2be');
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

  // ---------- проверка на истории: сигналы в день и итог по месяцам (все цифры — из App.runLiveCheck) ----------
  function fDay(t, wd) { return new Date(t).toLocaleDateString('ru-RU', wd ? { weekday: 'short', day: '2-digit', month: '2-digit' } : { day: '2-digit', month: '2-digit' }); }
  function monthLabel(m) { return fDay(m.from) + '–' + fDay(m.to - 1); }
  function rCls(x) { return x > 0 ? 'good' : (x < 0 ? 'bad' : ''); }
  // Столбики итога по месяцам (блоки по 30 дней): вверх — в плюсе, вниз — в минусе; высота — итог в R.
  function monthBars(months) {
    var top = 1;
    months.forEach(function (m) { if (Math.abs(m.sumR) > top) top = Math.abs(m.sumR); });
    var grid = h('div', {
      class: 'mbars', role: 'img', style: 'grid-template-columns:repeat(' + Math.max(1, months.length) + ',minmax(0,1fr))',
      'aria-label': 'Итог по месяцам: ' + months.map(function (m) { return monthLabel(m) + ' ' + fR(m.sumR); }).join(', ')
    });
    months.forEach(function (m) {
      var hgt = 'height:' + Math.max(4, Math.round(Math.abs(m.sumR) / top * 100)) + '%';
      grid.appendChild(h('div', { class: 'mb-col', title: monthLabel(m) + ': сделок ' + m.n + ', итог ' + fR(m.sumR) },
        h('div', { class: 'mb-up' }, m.sumR > 0 ? h('div', { class: 'mb-bar good', style: hgt }) : null),
        h('div', { class: 'mb-down' }, m.sumR < 0 ? h('div', { class: 'mb-bar bad', style: hgt }) : null),
        h('div', { class: 'mb-r ' + rCls(m.sumR) }, m.n ? fR(m.sumR) : '—'),
        h('div', { class: 'mb-d' }, fDay(m.from))));
    });
    return grid;
  }
  // Таблица по месяцам: perDay — сигналы в день (проверка live) или штуки (бэктест).
  function monthTable(months, perDay) {
    return tableWrap(mkTable(['Период', perDay ? 'Сигн./день' : 'Сигналов', 'Сделок', '✓ / ✗', 'Итог'], months.map(function (m) {
      return {
        cells: [monthLabel(m), perDay ? fN(m.signals / Math.max(1, m.days), 2) : String(m.signals), String(m.n),
          m.n ? m.wins + ' / ' + m.losses : '—', { v: m.n ? fR(m.sumR) : '—', cls: rCls(m.sumR) }]
      };
    })));
  }
  function liveCheckCard() {
    var lc = App.lc, r = lc.res, body = [];
    var pids = App.activePresets();
    body.push(h('p', { class: 'muted small' }, 'Прогон текущих настроек live по истории: те же detect() и validate(), что в live, по всем монетам списка и всем включённым пресетам (сейчас: ' +
      pids.map(function (p) { return C.presets[p].short; }).join(', ') + '). Смотрите не только на общий итог, но и на месяцы: ровный результат важнее одного удачного месяца. Калибровку и результаты бэктеста проверка не меняет.'));
    body.push(field('Период', seg(C.liveCheck.periods.map(function (p) { return [p.id, p.label]; }), lc.period, function (v) {
      if (lc.running) return;
      App.setLiveCheckPeriod(v);
      updateLiveCheck(true);
    }), '«180 дней до них» — 181–360 дней назад: на этом отрезке состав режима не выбирался, поэтому это честная проверка'));
    var ra = lc.byPeriod.d180, rb = lc.byPeriod.prev180;
    if (ra && rb && !lc.running) {
      var both = ra.sumR > 0 && rb.sumR > 0, sameSet = JSON.stringify(ra.snap) === JSON.stringify(rb.snap);
      body.push(h('div', { class: 'note ' + (both ? 'good' : 'warn') }, 'Последние 180 дней: ' + fR(ra.sumR) + ' (' + ra.n + ' ' + plural(ra.n, 'сделка', 'сделки', 'сделок') + ', в плюсе ' + ra.posMonths + ' из ' + ra.months.length + ' мес.) · 180 дней до них: ' +
        fR(rb.sumR) + ' (' + rb.n + ' ' + plural(rb.n, 'сделка', 'сделки', 'сделок') + ', в плюсе ' + rb.posMonths + ' из ' + rb.months.length + ' мес.). ' +
        (both ? 'Плюс держится на обоих отрезках.' : 'На одном из отрезков итог не в плюсе — преимущество не подтверждено.') + (sameSet ? '' : ' Проверки сделаны с разными настройками — запустите обе заново.')));
    }
    if (lc.running) {
      body.push(h('div', { class: 'progress' }, h('div', { class: 'bar', style: 'width:' + Math.round((lc.progress.frac || 0) * 100) + '%' })));
      body.push(h('div', { class: 'muted small', id: 'lc-progress-text' }, lc.progress.text || ''));
      body.push(h('div', { class: 'row-btns' }, h('button', { type: 'button', class: 'btn danger', onclick: function () { App.cancelLiveCheck(); } }, 'Остановить')));
    } else {
      body.push(h('div', { class: 'row-btns' },
        h('button', { type: 'button', class: 'btn primary', onclick: function () { App.runLiveCheck(); } }, r ? 'Проверить заново' : 'Проверить на истории'),
        h('span', { class: 'muted small' }, 'первый прогон долгий: грузится история всех монет, потом она берётся из кэша')));
    }
    if (lc.error) body.push(h('div', { class: 'note err' }, 'Проверка остановлена: ' + lc.error));
    if (r) {
      var rules = (r.presets || []).map(function (p, k) {
        return (r.modes && r.modes[k] && r.modes[k] !== r.snap.strategy) ? ' (' + C.presets[p].short + ' — по правилам «' + modeName(r.modes[k]) + '»)' : '';
      }).join('');
      var perText = r.offset ? r.periodDays + ' дней до последних ' + r.offset + ' (независимый отрезок)' : r.periodDays + ' дней';
      body.push(h('div', { class: 'note' }, 'Проверено ' + fDT(r.ts) + ' · ' + perText + ': ' + fDate(r.fromT) + ' — ' + fDate(r.toT) + ' · профиль «' + modeName(r.snap.strategy) + '»' + rules +
        ' · пресеты: ' + (r.presets || []).map(function (p) { return C.presets[p].short; }).join(', ') + ' · монет ' + r.coins + ' · ожидание входа ' + r.snap.expiryBars + ' ' +
        plural(r.snap.expiryBars, 'свеча', 'свечи', 'свечей') + ' · minScore ' + r.snap.minScore + (r.snap.mode === 'long' ? ' · только LONG' : '') + ' · ' + r.source));
      if (App.liveCheckStale()) body.push(h('div', { class: 'note warn' }, 'Настройки live изменились после проверки: цифры ниже относятся к прежним настройкам. Запустите проверку заново.'));
      var nm = r.months.length, sp = r.spread;
      body.push(h('div', { class: 'kv-grid' },
        kv('Месяцев в плюсе', r.posMonths + ' из ' + nm, nm && r.posMonths === nm ? 'good' : (r.posMonths * 2 < nm ? 'bad' : '')),
        kv('Итог', fR(r.sumR), rCls(r.sumR)),
        kv('Разброс итога, 90% повторов', sp ? fR(sp.p5) + ' … ' + fR(sp.p95) : '—', sp ? (sp.p5 > 0 ? 'good' : (sp.p95 < 0 ? 'bad' : '')) : ''),
        kv('Итог ≤ 0 в повторах', sp ? Math.round(sp.pNeg * 100) + '%' : '—', sp ? (sp.pNeg >= 0.2 ? 'bad' : (sp.pNeg <= 0.05 ? 'good' : '')) : ''),
        kv('Просадка, 95% повторов', sp ? fR(-sp.dd95) : '—'),
        kv('Сделок за период', String(r.n)),
        kv('Дошли до TP1 ✓', r.n ? r.wins + ' (' + fRate(r.winRate) + ')' : '—', 'good'),
        kv('Не дошли до TP1 ✗', r.n ? String(r.losses) : '—', 'bad'),
        kv('Profit factor', isNum(r.pf) ? fN(r.pf, 2) : (r.pfInf ? '∞' : '—')),
        kv('Макс. просадка', fR(-r.maxDD)),
        kv('Итог при риске 1%', fPct(r.compPct) + ' (сложный процент)'),
        kv('Сигналов в день, в среднем', fN(r.avg, 2)),
        kv('Входов в день (лимит исполнился)', fN(r.avgEntries, 2)),
        kv('Дней без сигналов', r.zero + ' из ' + r.nDays),
        kv('Контроль: последние 30%', r.outN + ' ' + plural(r.outN, 'сделка', 'сделки', 'сделок') + ', ' + fR(r.outSumR), rCls(r.outSumR))
      ));
      body.push(h('h4', { class: 'sub-title' }, 'По месяцам (блоки по 30 дней, справа — последний)'));
      body.push(monthBars(r.months));
      body.push(monthTable(r.months, true));
      if (r.n < C.backtest.minTrades) body.push(h('div', { class: 'note warn' }, 'Выборка мала, выводы ненадёжны (сделок: ' + r.n + ', нужно хотя бы ' + C.backtest.minTrades + ').'));
      (r.warnings || []).forEach(function (w) { body.push(h('div', { class: 'note warn' }, w)); });
      body.push(h('ul', { class: 'why-extra' }, [
        h('li', null, 'Месяц — блок 30 дней от даты проверки назад. Если в половине месяцев минус, общий итог держится на одном-двух удачных отрезках.'),
        h('li', null, 'Разброс — бутстрэп: из тех же сделок ' + (sp ? sp.iters : C.backtest.spreadIters) + ' раз набирается случайная выборка того же размера. Если в заметной доле повторов итог не выше нуля, плюс может быть случайным. Просадка — при случайном порядке тех же сделок.'),
        h('li', null, 'Сигналы в день считаются по полным суткам по вашему времени (' + r.nDays + ' ' + plural(r.nDays, 'день', 'дня', 'дней') + '), сделки — за весь период.'),
        h('li', null, 'Пресеты прогоняются отдельно и объединяются по правилам live: по монете одновременно открыт один сигнал, пауза после SL общая. Это приближение к live, а не точная копия.'),
        h('li', null, 'Прошлые месяцы не гарантируют будущих.')
      ]));
    }
    return h('div', { class: 'card', id: 'lc-card' }, h('h3', { class: 'card-title' }, 'Проверка на истории: сигналы и итог по месяцам'), body);
  }
  // Обновление карточки проверки: full — перестроить, иначе только полоса прогресса.
  function updateLiveCheck(full) {
    var card = $('lc-card');
    if (!card) return;
    if (!full) {
      var bar = card.querySelector('.progress .bar'), tx = $('lc-progress-text');
      if (bar && tx) {
        bar.style.width = Math.round((App.lc.progress.frac || 0) * 100) + '%';
        tx.textContent = App.lc.progress.text || '';
        return;
      }
    }
    card.replaceWith(liveCheckCard());
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
    // Таймфреймы live-сигналов: один из пресетов или все три сразу.
    var pids = App.activePresets();
    var qp = C.qualityPreset, qMulti = qp.presets.length > 1;
    var liveOpts = [['main', C.presets.main.name], ['swing', C.presets.swing.name], ['scalp', C.presets.scalp.name], ['all', 'Все сразу']];
    if (qMulti) liveOpts.push(['quality', 'Качественный набор']);
    var liveSeg = seg(liveOpts, s.livePreset, function (v) {
      if (v === s.livePreset) return;
      App.updateSettings({ livePreset: v }, false);
      toast('Таймфреймы live: ' + App.livePresetName(v) + ' — загружаю данные', 'good');
      renderSettings();
    });
    // Качественный режим — одной кнопкой; состав — CONFIG.qualityPreset (те же сигналы присылает Telegram-бот).
    // Цифр здесь нет: как режим ведёт себя по месяцам, считает проверка на истории (карточка ниже).
    var qOn = App.isQuality();
    var qWait = qp.presets.map(function (p) { return C.presets[p].short + ' — ' + hoursText(qp.expiryBars, C.presets[p].ltf); }).join(', ');
    root.appendChild(section('Качественный режим', [
      h('p', { class: 'muted small' }, 'Профиль «' + modeName(qp.strategy) + '», ' + qp.presets.map(function (p) { return C.presets[p].name; }).join(' + ') + ', ' +
        qp.symbols.length + ' монет, ожидание входа ' + qp.expiryBars + ' ' + plural(qp.expiryBars, 'свеча', 'свечи', 'свечей') + ' младшего ТФ (' + qWait + '), minScore ' + qp.minScore +
        (qp.source && Data.ADAPTERS[qp.source] ? ', свечи ' + Data.ADAPTERS[qp.source].name + ' — как у Telegram-бота' : '') + '.'),
      h('ul', { class: 'why-extra' }, [
        h('li', null, 'Лучший из проверенных вариантов, но преимущество небольшое, а сделок на истории мало. Состав выбран правилом, заданным до проверки.'),
        h('li', null, 'Сигналов немного. Добрать их без потери качества не получилось: на истории не держались ни ослабленные правила (частый профиль), ни новые монеты (широкий список).'),
        h('li', null, 'Как режим ведёт себя по месяцам, покажет проверка ниже: её цифры считает приложение.'),
        h('li', null, 'Сначала проверьте режим 2–4 недели без реальных денег: журнал сигналов и Telegram-бот считают результат сами.'),
        h('li', null, 'Те же сигналы может присылать Telegram-бот с GitHub. Инструкция — в репозитории, файл bot/НАСТРОЙКА.md.')
      ]),
      h('div', { class: 'row-btns' }, qOn
        ? h('span', { class: 'chip good' }, 'Режим включён')
        : h('button', { type: 'button', class: 'btn primary', onclick: function () { App.applyQuality(); toast('Качественный режим включён — загружаю ' + qp.symbols.length + ' монет', 'good'); renderSettings(); } }, 'Включить качественный режим'))
    ]));
    root.appendChild(liveCheckCard());
    var liveHints = [
      h('li', null, 'Основной 4H/1H/15m — как в промпте: тренд 4H, зона 1H, вход 15m. Сделки длятся часы и дни.'),
      h('li', null, 'Свинг 1D/4H/1H — сигналов меньше, сделки дольше (дни), стопы шире.'),
      h('li', null, 'Скальп 1H/15m/5m — сигналов больше, сделки короче (часы), стопы уже; откаты есть даже при сильном тренде.'),
      h('li', null, 'Все сразу — три пресета параллельно, данных и запросов больше. По одной монете одновременно открыт только один сигнал (первым проверяется основной пресет).')
    ];
    if (qMulti) liveHints.push(h('li', null, 'Качественный набор — пресеты качественного режима: ' + qp.presets.map(function (p) { return C.presets[p].short; }).join(' + ') + '.'));
    root.appendChild(section('Таймфреймы live-сигналов', [
      liveSeg,
      h('ul', { class: 'why-extra' }, liveHints.concat([
        h('li', null, 'Правила стратегии одинаковые, отличаются только таймфреймы. Проверить каждый пресет можно в бэктесте; калибровка точности ведётся для каждого пресета отдельно.')
      ]))
    ]));
    var modeSeg = seg([['strict', 'Строгий (по промпту)'], ['soft', 'Мягкий'], ['frequent', 'Частый']], s.strategy, function (v) {
      if (v === s.strategy) return;
      App.updateSettings({ strategy: v }, false);
      toast('Профиль: ' + modeName(v) + ' — последние свечи перепроверены по его правилам', 'good');
      renderSettings();
    });
    var modeHints = {
      strict: [
        'Все условия промпта обязательны: тренд старшего ТФ, вход из Discount/Premium его диапазона, свежая зона среднего ТФ, sweep, CHoCH/BOS с displacement на младшем.',
        'Сигналов очень мало, зато каждый — полный сетап. Сколько их выходит на ваших монетах, покажет проверка на истории выше.'
      ],
      soft: [
        'Sweep ликвидности не обязателен: если он был, даёт +' + C.weights.sweep + ' к score, если нет — сигнал всё равно возможен.',
        'Premium/Discount считается по диапазону среднего ТФ (откат внутри тренда старшего), а не по большому диапазону старшего ТФ.',
        'Вход у ближней к цене границы зоны (чаще исполняется, но стоп и R шире).',
        'Остальное как в строгом: тренд старшего ТФ, свежая зона среднего, CHoCH/BOS с displacement на младшем, риск 0.25–3%, место ≥ 3R, двойная проверка.'
      ],
      frequent: [
        'Всё из мягкого, плюс: зона среднего ТФ желательна (+ до ' + C.weights.zoneObFvg + ' баллов), но не обязательна; если есть — может быть дальше, до 1×ATR.',
        'Импульс на слом слабее: тело от 1.2×ATR (пара свечей — от 1.6×ATR) вместо 1.5 и 2.0.',
        'Место для хода от 2.5R вместо 3R.',
        'Остаются: тренд старшего ТФ, Premium/Discount, CHoCH/BOS, риск 0.25–3%, minScore и двойная проверка.',
        'Сигналов больше, но на длинной истории частый профиль терял: удачный месяц сменялся убыточными. Для входа в сделки его лучше не использовать — проверьте сами на 90 и 180 днях.',
        'На скальпе (5m) частый профиль работает по мягким правилам: ослабленные фильтры на 5m дают слишком много шума.'
      ]
    };
    root.appendChild(section('Профиль стратегии', [
      modeSeg,
      h('ul', { class: 'why-extra' }, (modeHints[s.strategy] || modeHints.strict).map(function (t) { return h('li', null, t); })),
      h('div', { class: 'muted small' }, 'Мягкий и частый профили заданы заранее, а не подобраны по истории. Сравнивайте профили в бэктесте только по контрольным 30% периода. Калибровка и статистика ведутся отдельно для каждого профиля.')
    ]));
    var waitSeg = seg(C.lifecycle.expiryOptions.map(function (b) { return [b, b + ' ' + plural(b, 'свеча', 'свечи', 'свечей')]; }), s.expiryBars, function (v) {
      v = Number(v);
      if (v === s.expiryBars) return;
      App.updateSettings({ expiryBars: v }, false);
      toast('Ожидание входа: ' + v + ' ' + plural(v, 'свеча', 'свечи', 'свечей') + ' младшего ТФ — для новых сигналов', 'good');
      renderSettings();
    });
    var waitByPreset = pids.map(function (pid) { var P = C.presets[pid]; return P.short + ' (' + P.ltf + '): ' + hoursText(s.expiryBars, P.ltf); }).join(' · ');
    root.appendChild(section('Ожидание входа', [
      waitSeg,
      h('ul', { class: 'why-extra' }, [
        h('li', null, 'Сейчас: ' + s.expiryBars + ' ' + plural(s.expiryBars, 'свеча', 'свечи', 'свечей') + ' младшего ТФ — ' + waitByPreset + (s.expiryBars === C.lifecycle.expiryBars ? '. Как в промпте.' : '. В промпте — 12 свечей.')),
        h('li', null, 'Если цена не вернулась к лимитному входу за это время, сигнал считается просроченным и сделки нет.'),
        h('li', null, 'Дольше ждать — больше исполненных входов, но вход случается позже импульса, когда сетап уже мог устареть: часть таких входов уходит в стоп. Сравните варианты в бэктесте по контрольным 30%.'),
        h('li', null, 'Срок применяется к новым сигналам; у уже выданных он не меняется.')
      ])
    ]));
    root.appendChild(section('Данные и режим', h('div', { class: 'form-grid' },
      field('Источник данных', select(srcOpts, s.source, function (e) { App.updateSettings({ source: e.target.value }, true); }), 'Binance Spot — как у Telegram-бота, тогда сигналы совпадают'),
      field('Где торгуете (для комиссий)', seg([['futures', 'Фьючерсы'], ['spot', 'Спот']], s.tradeMarket, function (v) { App.updateSettings({ tradeMarket: v }, false); renderSettings(); }), 'комиссия берётся по рынку сделки, а не по источнику свечей'),
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
        h('button', { type: 'button', class: 'btn', onclick: function () { coinsInp.value = C.symbols.join(', '); App.setCoins(coinsInp.value); } }, 'По умолчанию (10)'),
        h('button', { type: 'button', class: 'btn', onclick: function () { coinsInp.value = C.extendedSymbols.join(', '); App.setCoins(coinsInp.value); } }, 'Расширенный (' + C.extendedSymbols.length + ')'),
        h('button', { type: 'button', class: 'btn', onclick: function () { coinsInp.value = C.wideSymbols.join(', '); App.setCoins(coinsInp.value); } }, 'Широкий (' + C.wideSymbols.length + ')')),
      h('div', { class: 'muted small' }, 'Больше монет — больше сигналов при тех же правилах, но не обязательно лучше: на монетах, добавленных в широкий список, мягкий профиль на истории терял — проверьте сами на 180 днях. До ' + C.maxSymbols + ' монет. Монеты двигаются вместе, поэтому сигналы часто приходят пачкой.')
    ]));
    var snd = h('input', { type: 'checkbox', checked: s.sound, onchange: function (e) { App.updateSettings({ sound: e.target.checked }, false); } });
    var perm = App.notifyPermission();
    var permText = {
      granted: 'разрешены', denied: 'запрещены в браузере', 'default': 'ещё не разрешены', unsupported: 'не поддерживаются этим браузером'
    }[perm] || perm;
    var ntf = h('input', {
      type: 'checkbox', checked: s.notify && perm === 'granted', disabled: perm === 'unsupported' || perm === 'denied',
      onchange: function (e) {
        var on = e.target.checked;
        if (!on) { App.updateSettings({ notify: false }, false); renderSettings(); return; }
        // Запрос разрешения — только по действию пользователя (этот клик).
        App.requestNotify().then(function (res) {
          if (res === 'granted') {
            App.updateSettings({ notify: true }, false);
            toast('Уведомления включены', 'good');
          } else {
            App.updateSettings({ notify: false }, false);
            toast(res === 'denied' ? 'Браузер запретил уведомления — разрешите их в настройках сайта' : 'Уведомления не разрешены', 'bad');
          }
          renderSettings();
        });
      }
    });
    var ntfSt = h('input', {
      type: 'checkbox', checked: s.notifyStatus, disabled: !(s.notify && perm === 'granted'),
      onchange: function (e) { App.updateSettings({ notifyStatus: e.target.checked }, false); }
    });
    var hints = [
      h('li', null, 'Разрешение браузера: ' + permText + '.'),
      h('li', null, 'Уведомление приходит, когда вкладка в фоне или окно не в фокусе. Если вкладка открыта перед глазами, сработают звук и плашка внизу экрана.'),
      h('li', null, 'Вкладка с приложением должна оставаться открытой: без своего сервера закрытая вкладка рынок не смотрит. Удобно закрепить вкладку.'),
      h('li', null, 'На телефоне браузер усыпляет фоновые вкладки, поэтому уведомления надёжно работают только на компьютере.')
    ];
    if (location.protocol === 'file:') hints.push(h('li', null, 'Приложение открыто как файл. Chrome может не разрешить уведомления для файлов — тогда пользуйтесь версией на GitHub Pages (https).'));
    if (perm === 'denied') hints.push(h('li', null, 'Чтобы включить: значок замка/настроек слева от адреса → «Уведомления» → «Разрешить», затем обновите страницу.'));
    root.appendChild(section('Уведомления', [
      h('div', { class: 'row-btns' },
        h('label', { class: 'check' }, snd, h('span', null, 'Звук при новом сигнале')),
        h('button', { type: 'button', class: 'btn small', onclick: function () { App.beep(); } }, 'Проверить звук')),
      h('div', { class: 'row-btns' },
        h('label', { class: 'check' }, ntf, h('span', null, 'Системное уведомление о новом сигнале'))),
      h('div', { class: 'row-btns' },
        h('label', { class: 'check' + (ntfSt.disabled ? ' muted' : '') }, ntfSt, h('span', null, 'Также о входе, TP1, TP2 и закрытии сделки'))),
      perm === 'granted' ? h('div', { class: 'row-btns' },
        h('button', { type: 'button', class: 'btn small', onclick: function () {
          if (App.testNotify()) toast('Проверочное уведомление отправлено', 'good');
          else toast('Не удалось показать уведомление — см. отладочный лог', 'bad');
        } }, 'Проверить уведомление')) : null,
      h('ul', { class: 'why-extra' }, hints)
    ]));
    // Калибровка — отдельно для каждого активного пресета (профиль — текущий).
    var calibBody = [];
    pids.forEach(function (pid) {
      var P = C.presets[pid], tot = Signals.Calib.totals(s.strategy, pid), cd = Signals.Calib.info(s.strategy, pid);
      calibBody.push(h('h4', { class: 'sub-title' }, P.name));
      if (tot.n) {
        calibBody.push(h('div', { class: 'muted small' }, 'Обновлена ' + fDT(cd.ts) + ' · ' + cd.days + ' дн · minScore ' + cd.minScore + ' · сделок ' + tot.n + ' · общая успешность ' + Math.round(tot.s / tot.n * 100) + '%'));
        if (tot.n < C.calibration.minTotal) calibBody.push(h('div', { class: 'note warn' }, 'Выборка мала, выводы ненадёжны: ' + tot.n + ' сделок из нужных ' + C.calibration.minTotal + '. Точность на карточках не показывается — только score с пометкой «предварительная оценка». Увеличьте период бэктеста (180 дней).'));
        calibBody.push(tableWrap(mkTable(['Корзина', 'Сделок', 'Успешных', '%'], C.calibration.buckets.map(function (b) {
          var x = tot.b[b];
          return { cells: [Signals.Calib.bucketLabel(b), String(x.n), String(x.s), x.n ? Math.round(x.s / x.n * 100) + '%' : '—'] };
        }))));
      } else calibBody.push(h('p', { class: 'muted' }, 'Калибровки нет: точность показывается как score с пометкой «предварительная оценка».'));
      calibBody.push(h('div', { class: 'row-btns' },
        h('button', { type: 'button', class: 'btn primary', onclick: function () { App.calibrate(pid); } }, 'Откалибровать (60 дней)'),
        tot.n ? h('button', { type: 'button', class: 'btn', onclick: function () { Signals.Calib.clear(s.strategy, pid); toast('Калибровка сброшена'); renderSettings(); } }, 'Сбросить') : null));
    });
    root.appendChild(section('Калибровка точности · профиль «' + modeName(s.strategy) + '»', calibBody));
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
    updateBtProgress: updateBtProgress, updateLiveCheck: updateLiveCheck,
    fP: fP, roundP: roundP, fDT: fDT, fTime: fTime, current: function () { return current; }
  };
})();
