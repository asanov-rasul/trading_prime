/* SMC Signals — валидатор (вторая независимая стадия проверки), жизненный цикл сигнала,
   журнал сигналов и калибровка точности. Валидатор, симулятор и статистика не обращаются к DOM. */
'use strict';

var Signals = (function () {
  var C = CONFIG;

  function isPos(x) { return typeof x === 'number' && isFinite(x) && x > 0; }
  function near(a, b, rel) {
    var tol = (rel || 1e-7) * Math.max(Math.abs(a), Math.abs(b), 1e-12);
    return Math.abs(a - b) <= tol;
  }

  // =====================================================================================
  // ВАЛИДАТОР. Заново считает bias, зону и уровни по сырым свечам, закрытым к моменту evalT.
  // От детектора берёт только «заявку» (направление, уровни, координаты зоны) и проверяет её.
  // Из движка используются лишь базовые формулы (EMA, ATR, фрактал), покрытые самотестами.
  // =====================================================================================

  // Своя проверка слома: закрытие свечи k за последним подтверждённым свингом, не сломанным раньше.
  function vBreakAt(c, swings, from, k, d) {
    var cur = null;
    for (var q = 0; q < swings.length; q++) {
      var s = swings[q];
      if (s.conf > k) break;
      if (s.i >= from) cur = s;
    }
    if (!cur) return false;
    if (!(d === 1 ? c[k].c > cur.p : c[k].c < cur.p)) return false;
    for (var x = cur.conf; x < k; x++) {
      if (d === 1 ? c[x].c > cur.p : c[x].c < cur.p) return false;
    }
    return true;
  }
  // Свой displacement: возвращает индекс начала импульса или -1.
  function vDisp(c, atr, k, d) {
    if (k < 1) return -1;
    var b0 = (c[k].c - c[k].o) * d;
    if (!(b0 > 0)) return -1;
    if (atr[k - 1] > 0 && b0 >= C.displacement.single * atr[k - 1]) return k;
    if (k >= 2) {
      var b1 = (c[k - 1].c - c[k - 1].o) * d;
      if (b1 > 0 && atr[k - 2] > 0 && b0 + b1 >= C.displacement.double * atr[k - 2]) return k - 1;
    }
    return -1;
  }
  // Свои визиты цены в зону после формирования.
  function vVisits(c, atr, bot, top, formed, to, d) {
    var runs = 0, inV = false, invalid = false, deep = NaN;
    for (var k = formed + 1; k <= to; k++) {
      var tol = (atr[k] > 0 ? atr[k] : 0) * C.poi.maxDistAtr;
      var touch = d === 1 ? c[k].l <= top : c[k].h >= bot;
      var nearZ = d === 1 ? c[k].l <= top + tol : c[k].h >= bot - tol;
      if (touch) {
        if (!inV) { runs++; inV = true; }
        var v = d === 1 ? c[k].l : c[k].h;
        if (deep !== deep || (d === 1 ? v < deep : v > deep)) deep = v;
      }
      if (!nearZ) inV = false;
      if (d === 1 ? c[k].c < bot : c[k].c > top) { invalid = true; break; }
    }
    return { runs: runs, invalid: invalid, deep: deep };
  }
  function vFill(bot, top, deep, d) {
    if (deep !== deep) return 0;
    var size = top - bot;
    if (!(size > 0)) return 1;
    var f = d === 1 ? (top - Math.max(deep, bot)) / size : (Math.min(deep, top) - bot) / size;
    return Math.max(0, Math.min(1, f));
  }
  function vBodyZone(cd) {
    return C.ob.zone === 'wick' ? { bot: cd.l, top: cd.h } : { bot: Math.min(cd.o, cd.c), top: Math.max(cd.o, cd.c) };
  }
  function vSwings(c) {
    return SMC.findSwings(c, C.swingN);
  }

  // Своя проверка bias на срезе старшего ТФ.
  function vBias(c) {
    var idx = c.length - 1, from = Math.max(0, idx - C.windows.htf + 1);
    var res = { dir: 0, eq: NaN };
    if (idx - from + 1 < C.minBars.htf) return res;
    var sw = vSwings(c);
    var H = sw.highs.filter(function (s) { return s.i >= from; });
    var L = sw.lows.filter(function (s) { return s.i >= from; });
    if (H.length < 2 || L.length < 2) return res;
    var h1 = H[H.length - 1].p, h0 = H[H.length - 2].p, l1 = L[L.length - 1].p, l0 = L[L.length - 2].p;
    var close = c[idx].c, e50 = SMC.emaArr(c, C.ema.fast)[idx];
    if (h1 > l1) res.eq = (h1 + l1) / 2;
    if (!(e50 === e50)) return res;
    if (h1 > h0 && l1 > l0 && close > e50) res.dir = 1;
    else if (h1 < h0 && l1 < l0 && close < e50) res.dir = -1;
    return res;
  }

  // Проверка заявленной зоны 1H по сырым свечам.
  function vPoi(cand, Mc, Matr, Msw, ms, eq) {
    var p = cand.poi, d = cand.dir, idx = Mc.length - 1;
    if (!p) return 'зона 1H не указана';
    var from = Math.max(0, idx - C.windows.mtf + 1);
    var parts = [];
    if (p.ob) parts.push({ kind: 'ob', z: p.ob });
    if (p.fvg) parts.push({ kind: 'fvg', z: p.fvg });
    if (!parts.length) return 'зона 1H пустая';
    var atrNow = Matr[idx], tol = C.poi.maxDistAtr * atrNow;
    for (var q = 0; q < parts.length; q++) {
      var part = parts[q], z = part.z, k = SMC.indexOfTime(Mc, z.t), formed = -1;
      if (k < from || k > idx) return 'свеча зоны 1H вне окна или из будущего';
      if (part.kind === 'ob') {
        var cd = Mc[k];
        if (!((cd.c - cd.o) * d < 0)) return 'OB не противоположная свеча';
        var bz = vBodyZone(cd);
        if (!near(bz.bot, z.bot) || !near(bz.top, z.top)) return 'границы OB не совпадают';
        formed = SMC.indexOfTime(Mc, z.formedT);
        if (formed <= k || formed > idx) return 'нет слома после OB';
        if (!vBreakAt(Mc, d === 1 ? Msw.highs : Msw.lows, from, formed, d)) return 'OB без слома структуры';
        var ds = vDisp(Mc, Matr, formed, d);
        if (ds < 0) return 'OB без displacement';
        for (var y = ds - 1; y > k; y--) {
          if ((Mc[y].c - Mc[y].o) * d < 0) return 'OB не последняя противоположная свеча';
        }
        if (ds - k > C.ob.maxLookback) return 'OB слишком далеко от импульса';
      } else {
        if (k < 1 || k + 1 > idx) return 'FVG без трёх свечей';
        var gb = d === 1 ? Mc[k - 1].h : Mc[k + 1].h, gt = d === 1 ? Mc[k + 1].l : Mc[k - 1].l;
        if (!near(gb, z.bot) || !near(gt, z.top) || !(gt > gb)) return 'FVG не совпадает со свечами';
        if (!(Matr[k] > 0) || gt - gb < C.fvg.minAtr * Matr[k]) return 'FVG меньше 0.1×ATR';
        formed = k + 1;
      }
      if (Mc[formed].t + ms > cand.sweep.t) return 'зона сформирована после sweep';
      var vs = vVisits(Mc, Matr, z.bot, z.top, formed, idx, d);
      if (vs.invalid) return 'зона недействительна (закрытие за зоной)';
      if (vs.runs > 1) return 'зона не свежая (повторный визит)';
      if (part.kind === 'fvg' && vFill(z.bot, z.top, vs.deep, d) > C.fvg.maxFill) return 'FVG заполнен больше 50%';
    }
    if (parts.length === 2 && !(p.ob.bot <= p.fvg.top && p.fvg.bot <= p.ob.top)) return 'OB и FVG не пересекаются';
    var main = p.ob || p.fvg;
    if (!near(main.bot, p.bot) || !near(main.top, p.top)) return 'границы зоны 1H не совпадают';
    var mid = (p.bot + p.top) / 2;
    if (d === 1 ? !(mid < eq) : !(mid > eq)) return 'зона 1H вне Discount/Premium';
    if (cand.sweep.ext < p.bot - tol || cand.sweep.ext > p.top + tol) return 'sweep далеко от зоны 1H';
    return '';
  }

  // Своя проверка sweep: экстремум между sweep и триггером, прокол уровня и возврат закрытием.
  function vSweep(cand, Lc) {
    var d = cand.dir, s = SMC.indexOfTime(Lc, cand.sweep.t), idx = Lc.length - 1;
    if (s < 0) return 'свеча sweep не найдена';
    if (idx - s > C.liquidity.sweepLookback) return 'sweep слишком давно';
    var ext = d === 1 ? Infinity : -Infinity;
    for (var k = Math.max(0, idx - C.liquidity.sweepLookback); k <= idx; k++) {
      var v = d === 1 ? Lc[k].l : Lc[k].h;
      if (d === 1 ? v < ext : v > ext) ext = v;
    }
    if (!near(ext, cand.sweep.ext)) return 'экстремум sweep не совпадает';
    if (!near(d === 1 ? Lc[s].l : Lc[s].h, ext)) return 'свеча sweep не экстремум';
    if (C.require.sweep) {
      var lv = cand.sweep.level;
      if (!isPos(lv)) return 'нет уровня ликвидности';
      if (!(d === 1 ? (Lc[s].l < lv && Lc[s].c > lv) : (Lc[s].h > lv && Lc[s].c < lv))) return 'нет возврата за уровень';
    }
    return '';
  }

  // Своя ближайшая противоположная цель (для проверки места для хода).
  function vNearestTarget(cand, Lc, Mc, Hc, Ms, Hs, Matr, Hatr, msM, msH, T) {
    var d = cand.dir, entry = cand.entry, best = null;
    function add(p) { if (isFinite(p) && (p - entry) * d > 0 && (best === null || (p - best) * d < 0)) best = p; }
    function maxAfter(level, j) {
      var b = d === 1 ? -Infinity : Infinity, k, tEnd;
      function upd(v) { if (d === 1 ? v > b : v < b) b = v; }
      if (level === 'H') {
        for (k = j + 1; k < Hc.length; k++) upd(d === 1 ? Hc[k].h : Hc[k].l);
        tEnd = Hc[Hc.length - 1].t + msH;
        for (k = SMC.firstIndexFrom(Mc, tEnd); k < Mc.length; k++) upd(d === 1 ? Mc[k].h : Mc[k].l);
        tEnd = Math.max(tEnd, Mc[Mc.length - 1].t + msM);
      } else {
        for (k = j + 1; k < Mc.length; k++) upd(d === 1 ? Mc[k].h : Mc[k].l);
        tEnd = Mc[Mc.length - 1].t + msM;
      }
      for (k = SMC.firstIndexFrom(Lc, tEnd); k < Lc.length; k++) upd(d === 1 ? Lc[k].h : Lc[k].l);
      return b;
    }
    var sets = [['M', Mc, Ms, Matr, C.windows.mtf], ['H', Hc, Hs, Hatr, C.windows.htf]];
    sets.forEach(function (x) {
      var level = x[0], c = x[1], sw = x[2], atr = x[3], idx = c.length - 1, from = Math.max(0, idx - x[4] + 1);
      // непробитые свинги
      (d === 1 ? sw.highs : sw.lows).forEach(function (s) {
        if (s.i < from || !((s.p - entry) * d > 0)) return;
        var ex = maxAfter(level, s.i);
        if (d === 1 ? ex <= s.p : ex >= s.p) add(s.p);
      });
      // нетронутые противоположные FVG
      for (var k = Math.max(from + 2, 2); k <= idx; k++) {
        if (!(atr[k - 1] > 0)) continue;
        var bot = d === 1 ? c[k].h : c[k - 2].h, top = d === 1 ? c[k - 2].l : c[k].l;
        if (!(top > bot) || top - bot < C.fvg.minAtr * atr[k - 1]) continue;
        var edge = d === 1 ? bot : top;
        if (!((edge - entry) * d > 0)) continue;
        var exf = maxAfter(level, k);
        if (d === 1 ? exf < bot : exf > top) add(edge);
      }
      // нетронутые противоположные OB: слом против сделки с displacement
      var opp = d === 1 ? sw.lows : sw.highs;
      for (var f = from; f <= idx; f++) {
        if (!vBreakAt(c, opp, from, f, -d)) continue;
        var ds = vDisp(c, atr, f, -d);
        if (ds < 0) continue;
        var j = -1;
        for (var y = ds - 1; y >= Math.max(from, ds - C.ob.maxLookback); y--) {
          if ((c[y].c - c[y].o) * -d < 0) { j = y; break; }
        }
        if (j < 0) continue;
        var oz = vBodyZone(c[j]);
        var e2 = d === 1 ? oz.bot : oz.top;
        if (!((e2 - entry) * d > 0)) continue;
        var exo = maxAfter(level, f);
        if (d === 1 ? exo < oz.bot : exo > oz.top) add(e2);
      }
    });
    // экстремум предыдущих суток, не снятый сегодня
    var DAY = SMC.DAY, day0 = Math.floor(T / DAY) * DAY, ph = -Infinity, pl = Infinity, cnt = 0, k2;
    for (k2 = SMC.firstIndexFrom(Mc, day0 - DAY); k2 < Mc.length && Mc[k2].t < day0; k2++) {
      cnt++;
      if (Mc[k2].h > ph) ph = Mc[k2].h;
      if (Mc[k2].l < pl) pl = Mc[k2].l;
    }
    if (cnt >= Math.floor(DAY / msM * 0.8)) {
      var lvl = d === 1 ? ph : pl, ext = d === 1 ? -Infinity : Infinity;
      for (k2 = SMC.firstIndexFrom(Mc, day0); k2 < Mc.length; k2++) { var v1 = d === 1 ? Mc[k2].h : Mc[k2].l; if (d === 1 ? v1 > ext : v1 < ext) ext = v1; }
      var tE = Math.max(day0, Mc[Mc.length - 1].t + msM);
      for (k2 = SMC.firstIndexFrom(Lc, tE); k2 < Lc.length; k2++) { var v2 = d === 1 ? Lc[k2].h : Lc[k2].l; if (d === 1 ? v2 > ext : v2 < ext) ext = v2; }
      if (d === 1 ? ext <= lvl : ext >= lvl) add(lvl);
    }
    return best;
  }

  // raw: {L, M, H — массивы свечей; ms: {L, M, H}; evalT; price — текущая цена}
  // state: {hasOpen(sym) → bool, lastSlT(sym) → время закрытия свечи с SL | null}
  function validate(cand, raw, state) {
    function rej(code, text) { return { ok: false, code: code, reason: text }; }
    var d = cand.dir, T = raw.evalT;
    if (d !== 1 && d !== -1) return rej('dir', 'нет направления');
    if (![cand.entry, cand.sl, cand.tp1, cand.tp2, cand.tp3].every(isPos)) return rej('nan', 'уровни не являются числами');

    // 1. Только закрытые свечи.
    var iL = SMC.lastClosedIndex(raw.L, raw.ms.L, T), iM = SMC.lastClosedIndex(raw.M, raw.ms.M, T), iH = SMC.lastClosedIndex(raw.H, raw.ms.H, T);
    if (iL < 1 || iM < 1 || iH < 1) return rej('data', 'нет закрытых свечей');
    var trig = raw.L[iL];
    if (trig.t !== cand.triggerT) return rej('unclosed', 'триггер не на последней закрытой свече');
    if (trig.closed === false || trig.t + raw.ms.L > T) return rej('unclosed', 'использована незакрытая свеча');
    var checks = [[raw.L, iL, C.windows.ltf], [raw.M, iM, C.windows.mtf], [raw.H, iH, C.windows.htf]];
    for (var q = 0; q < checks.length; q++) {
      var arr = checks[q][0], end = checks[q][1];
      for (var k = Math.max(0, end - checks[q][2]); k <= end; k++) {
        if (arr[k].closed === false) return rej('unclosed', 'использована незакрытая свеча');
      }
    }

    // 2. Порядок цен.
    var ordered = d === 1
      ? (cand.sl < cand.entry && cand.entry < cand.tp1 && cand.tp1 < cand.tp2 && cand.tp2 < cand.tp3)
      : (cand.sl > cand.entry && cand.entry > cand.tp1 && cand.tp1 > cand.tp2 && cand.tp2 > cand.tp3);
    if (!ordered) return rej('order', 'неверный порядок цен SL/вход/TP');

    // 3. Риск и кратность R.
    var R = Math.abs(cand.entry - cand.sl), riskPct = R / cand.entry * 100;
    if (riskPct < C.sl.minRiskPct - 1e-9 || riskPct > C.sl.maxRiskPct + 1e-9) return rej('risk', 'риск вне ' + C.sl.minRiskPct + '–' + C.sl.maxRiskPct + '%');
    if (!near(cand.tp1, cand.entry + d * C.tp.r[0] * R, 1e-6) || !near(cand.tp2, cand.entry + d * C.tp.r[1] * R, 1e-6)) return rej('levels', 'TP1/TP2 не равны 1R/2R');
    var tp3R = (cand.tp3 - cand.entry) * d / R;
    if (tp3R < C.tp.tp3MinR - 1e-6 || tp3R > C.tp.tp3MaxR + 1e-6) return rej('room', 'TP3 вне 3–5R');

    // 4. Цена не прошла вход и TP1 (режим проверки TP1 — CONFIG.validator.tp1Rule).
    var price = isPos(raw.price) ? raw.price : trig.c;
    if (d === 1 ? !(price > cand.entry) : !(price < cand.entry)) return rej('price-entry', 'цена уже прошла вход');
    if (C.validator.tp1Rule === 'literal' && (d === 1 ? !(price < cand.tp1) : !(price > cand.tp1))) return rej('price-tp1', 'цена уже прошла TP1');

    // 5. Нет активного сигнала по монете и прошла пауза после SL.
    if (state && state.hasOpen(cand.sym)) return rej('active', 'по монете уже есть активный сигнал');
    var ls = state ? state.lastSlT(cand.sym) : null;
    if (ls != null && T - ls <= C.lifecycle.cooldownBars * raw.ms.L) return rej('cooldown', 'не прошла пауза ' + C.lifecycle.cooldownBars + ' свечей после SL');

    // Срезы: только свечи, закрытые к evalT.
    var Lc = raw.L.slice(0, iL + 1), Mc = raw.M.slice(0, iM + 1), Hc = raw.H.slice(0, iH + 1);

    // 6. Bias старшего ТФ — заново.
    var vb = vBias(Hc);
    if (vb.dir !== d) return rej('bias', 'bias старшего ТФ не совпадает с направлением');
    if (!(vb.eq === vb.eq)) return rej('pd', 'нет диапазона Premium/Discount');
    if (d === 1 ? !(cand.entry < vb.eq) : !(cand.entry > vb.eq)) return rej('pd', 'вход вне Discount/Premium');

    // 7. Sweep и зона — заново.
    var sws = vSweep(cand, Lc);
    if (sws) return rej('sweep', sws);
    var Matr = SMC.atrArr(Mc, C.atrPeriod), Msw = vSwings(Mc);
    var pz = vPoi(cand, Mc, Matr, Msw, raw.ms.M, vb.eq);
    if (pz) return rej('zone', pz);
    var ez = cand.zone;
    if (!ez || !(ez.top >= ez.bot)) return rej('zone', 'нет зоны входа');
    if (ez.kind !== 'poi') {
      var zk = SMC.indexOfTime(Lc, ez.t), src = ez.src || ez;
      if (zk < 0) return rej('zone', 'свеча зоны входа не найдена');
      if (!(ez.bot >= src.bot - 1e-12 && ez.top <= src.top + 1e-12)) return rej('zone', 'зона входа шире исходной');
      for (var x = zk + 1; x < Lc.length; x++) {
        if (d === 1 ? Lc[x].c < src.bot : Lc[x].c > src.top) return rej('zone', 'зона входа недействительна');
      }
    }

    // 8. Уровни — заново: вход по зоне, стоп за экстремумом с буфером 0.25×ATR.
    var entryChk = C.entryMode === 'edge' ? (d === 1 ? ez.top : ez.bot) : (ez.bot + ez.top) / 2;
    if (!near(entryChk, cand.entry, 1e-6)) return rej('levels', 'вход не совпадает с зоной');
    var Latr = SMC.atrArr(Lc, C.atrPeriod)[iL];
    if (!(Latr > 0)) return rej('data', 'нет ATR');
    var slChk = d === 1
      ? Math.min(ez.bot, cand.sweep.ext) - C.sl.bufferAtr * Latr
      : Math.max(ez.top, cand.sweep.ext) + C.sl.bufferAtr * Latr;
    if (!near(slChk, cand.sl, 1e-6)) return rej('levels', 'стоп не совпадает с пересчётом');

    // 9. Место для хода — заново.
    var Hatr = SMC.atrArr(Hc, C.atrPeriod), Hsw = vSwings(Hc);
    var tgt = vNearestTarget(cand, Lc, Mc, Hc, Msw, Hsw, Matr, Hatr, raw.ms.M, raw.ms.H, T);
    var roomR = tgt === null ? Infinity : (tgt - cand.entry) * d / R;
    if (roomR < C.tp.tp3MinR - 1e-9) return rej('room', 'до цели меньше ' + C.tp.tp3MinR + 'R');
    if (!near(Math.min(roomR, C.tp.tp3MaxR), tp3R, 1e-6)) return rej('levels', 'TP3 не совпадает с пересчётом цели');

    return { ok: true, code: 'ok', reason: '' };
  }

  // =====================================================================================
  // ЖИЗНЕННЫЙ ЦИКЛ. pending → active → closed (TP3, TP2, безубыток, SL); expired / invalidated.
  // Одна функция для live и бэктеста. В одной свече SL и TP — считаем SL.
  // =====================================================================================
  function create(cand, meta) {
    var ltfMs = meta.ltfMs;
    return {
      id: cand.sym + '-' + cand.triggerT + '-' + (cand.dir === 1 ? 'L' : 'S'),
      sym: cand.sym, coin: cand.coin, dir: cand.dir, side: cand.side, tf: cand.tf,
      createdT: cand.T, triggerT: cand.triggerT, triggerClose: cand.triggerClose,
      expiresT: cand.T + C.lifecycle.expiryBars * ltfMs, ltfMs: ltfMs,
      entry: cand.entry, sl: cand.sl, tp1: cand.tp1, tp2: cand.tp2, tp3: cand.tp3,
      R: Math.abs(cand.entry - cand.sl), riskPct: cand.riskPct, roomR: cand.roomR, tp3R: cand.tp3R,
      zone: cand.zone, poi: cand.poi, sweep: cand.sweep, structure: cand.structure, ote: cand.ote, inOte: cand.inOte,
      target: cand.target, bias: cand.bias, disp: cand.disp,
      score: cand.score, factors: cand.factors, penalties: cand.penalties,
      fee: meta.fee, slip: meta.slip, source: meta.source || '', preset: meta.preset || 'main', late: !!meta.late,
      status: 'pending', outcome: null, tpHit: [false, false, false], stop: cand.sl,
      filledT: null, closedT: null, exits: [], resultR: null, lastT: cand.triggerT, note: ''
    };
  }
  function bePrice(sig) {
    return sig.dir === 1 ? sig.entry * (1 + 2 * sig.fee) : sig.entry * (1 - 2 * sig.fee);
  }
  function stopFill(sig, level) {
    return sig.dir === 1 ? level * (1 - sig.slip) : level * (1 + sig.slip);
  }
  function computeR(sig) {
    var gross = 0, fees = sig.entry * sig.fee;
    for (var k = 0; k < sig.exits.length; k++) {
      var e = sig.exits[k];
      gross += e.frac * (e.price - sig.entry) * sig.dir;
      fees += e.frac * e.price * sig.fee;
    }
    return (gross - fees) / sig.R;
  }
  function closeRest(sig, price, t) {
    var used = 0;
    sig.exits.forEach(function (e) { used += e.frac; });
    var rest = Math.max(0, 1 - used);
    if (rest > 1e-9) sig.exits.push({ kind: 'stop', price: price, frac: rest, t: t });
    sig.outcome = !sig.tpHit[0] ? 'sl' : (!sig.tpHit[1] ? 'be' : 'tp2');
    sig.status = 'closed';
    sig.closedT = t;
    sig.resultR = computeR(sig);
  }
  function adverse(sig, cd, level) { return sig.dir === 1 ? cd.l <= level : cd.h >= level; }
  function favor(sig, cd, level) { return sig.dir === 1 ? cd.h >= level : cd.l <= level; }

  // opts.provisional — по незакрытой свече: без правил по закрытию и без сдвига lastT.
  function step(sig, cd, cfg, opts) {
    cfg = cfg || C;
    opts = opts || {};
    if (!cd || cd.t <= sig.lastT) return sig;
    if (sig.status !== 'pending' && sig.status !== 'active') return sig;
    var tEnd = cd.t + sig.ltfMs, fr = cfg.tp.fractions;
    if (sig.status === 'pending') {
      if (adverse(sig, cd, sig.entry)) {
        sig.status = 'active';
        sig.filledT = cd.t;
        sig.stop = sig.sl;
        // Свеча входа: проверяем только SL (порядок внутри свечи неизвестен — TP на ней не засчитываем).
        if (adverse(sig, cd, sig.sl)) closeRest(sig, stopFill(sig, sig.sl), tEnd);
      } else if (cfg.lifecycle.cancelIfTp1BeforeEntry && favor(sig, cd, sig.tp1)) {
        sig.status = 'expired'; sig.outcome = 'missed'; sig.closedT = tEnd; sig.note = 'цена дошла до TP1 без входа';
      } else if (!opts.provisional && (sig.dir === 1 ? cd.c < sig.zone.bot : cd.c > sig.zone.top)) {
        sig.status = 'invalidated'; sig.outcome = 'invalidated'; sig.closedT = tEnd; sig.note = 'закрытие тела за зоной до входа';
      } else if (!opts.provisional && tEnd >= sig.expiresT) {
        sig.status = 'expired'; sig.outcome = 'expired'; sig.closedT = tEnd; sig.note = 'вход не случился за ' + cfg.lifecycle.expiryBars + ' свечей';
      }
    } else {
      if (adverse(sig, cd, sig.stop)) {
        closeRest(sig, stopFill(sig, sig.stop), tEnd);
      } else {
        var tps = [sig.tp1, sig.tp2, sig.tp3];
        for (var k = 0; k < 3; k++) {
          if (sig.tpHit[k]) continue;
          if (!favor(sig, cd, tps[k])) break;
          sig.tpHit[k] = true;
          sig.exits.push({ kind: 'tp' + (k + 1), price: tps[k], frac: fr[k], t: tEnd });
          if (k === 2) {
            sig.outcome = 'tp3'; sig.status = 'closed'; sig.closedT = tEnd; sig.resultR = computeR(sig);
            break;
          }
          var mv = cfg.tp.moveStop[k];
          if (mv === 'be') sig.stop = bePrice(sig);
          else if (mv === 'tp1') sig.stop = sig.tp1;
          // Новый стоп достижим в той же свече — считаем, что он сработал (правило «SL первым»).
          if (adverse(sig, cd, sig.stop)) { closeRest(sig, stopFill(sig, sig.stop), tEnd); break; }
        }
      }
    }
    if (!opts.provisional) sig.lastT = cd.t;
    return sig;
  }
  function clone(sig) { return JSON.parse(JSON.stringify(sig)); }
  function provisional(sig, forming) {
    if (!forming || (sig.status !== 'pending' && sig.status !== 'active')) return sig;
    return step(clone(sig), forming, C, { provisional: true });
  }
  // Текущий нереализованный результат в R для открытой сделки.
  function openR(sig, price) {
    if (sig.status !== 'active' || !isPos(price)) return null;
    var tmp = clone(sig);
    var used = 0;
    tmp.exits.forEach(function (e) { used += e.frac; });
    if (1 - used > 1e-9) tmp.exits.push({ kind: 'mark', price: price, frac: 1 - used, t: 0 });
    return computeR(tmp);
  }
  function isOpen(sig) { return sig.status === 'pending' || sig.status === 'active'; }
  function isSuccess(sig) { return sig.status === 'closed' && sig.tpHit[0]; }

  var OUTCOME = {
    sl: 'SL', be: 'TP1 → безубыток', tp2: 'TP2 → стоп на TP1', tp3: 'TP3',
    expired: 'Просрочен', missed: 'Просрочен (TP1 без входа)', invalidated: 'Отменён (зона)'
  };
  function statusText(sig) {
    if (sig.status === 'pending') return 'Ждём вход';
    if (sig.status === 'active') return sig.tpHit[1] ? 'В сделке · TP2 взят' : (sig.tpHit[0] ? 'В сделке · TP1 взят' : 'В сделке');
    return OUTCOME[sig.outcome] || sig.status;
  }

  // =====================================================================================
  // ЖУРНАЛ (localStorage).
  // =====================================================================================
  var Journal = {
    list: [],
    cooldown: {},
    load: function () {
      var d = Data.Store.get(C.storage.journal, null);
      this.list = [];
      this.cooldown = {};
      if (d && Array.isArray(d.signals)) {
        this.list = d.signals.filter(function (s) {
          return s && typeof s.id === 'string' && isPos(s.entry) && isPos(s.sl) && isPos(s.R) && Array.isArray(s.tpHit) && isPos(s.ltfMs);
        });
      }
      if (d && d.cooldown && typeof d.cooldown === 'object') this.cooldown = d.cooldown;
    },
    save: function () {
      var open = this.list.filter(isOpen), done = this.list.filter(function (s) { return !isOpen(s); });
      done.sort(function (a, b) { return b.createdT - a.createdT; });
      var max = Math.max(0, C.journalMax - open.length);
      this.list = open.concat(done.slice(0, max));
      this.list.sort(function (a, b) { return b.createdT - a.createdT; });
      Data.Store.set(C.storage.journal, { v: 1, signals: this.list, cooldown: this.cooldown });
    },
    add: function (sig) {
      for (var k = 0; k < this.list.length; k++) if (this.list[k].id === sig.id) return false;
      this.list.unshift(sig);
      return true;
    },
    remove: function (id) { this.list = this.list.filter(function (s) { return s.id !== id; }); },
    openFor: function (sym) { return this.list.filter(function (s) { return isOpen(s) && (!sym || s.sym === sym); }); },
    hasOpen: function (sym) { return this.list.some(function (s) { return isOpen(s) && s.sym === sym; }); },
    lastSlT: function (sym) { var v = this.cooldown[sym]; return typeof v === 'number' ? v : null; },
    noteClosed: function (sig) { if (sig.outcome === 'sl' && sig.closedT) this.cooldown[sig.sym] = Math.max(this.cooldown[sig.sym] || 0, sig.closedT); },
    clear: function () { this.list = []; this.cooldown = {}; Data.Store.remove(C.storage.journal); }
  };

  // Статистика по списку сигналов (live-журнал и бэктест).
  function stats(list) {
    var trades = list.filter(function (s) { return s.status === 'closed' && s.filledT != null; });
    trades.sort(function (a, b) { return a.closedT - b.closedT; });
    var n = trades.length, wins = 0, be = 0, tp = [0, 0, 0], sumR = 0, gw = 0, gl = 0;
    var eq = 0, peak = 0, dd = 0, streak = 0, maxStreak = 0, comp = 1, curve = [];
    trades.forEach(function (t) {
      if (t.tpHit[0]) wins++;
      if (t.outcome === 'be') be++;
      for (var k = 0; k < 3; k++) if (t.tpHit[k]) tp[k]++;
      var r = t.resultR || 0;
      sumR += r;
      if (r > 0) gw += r; else gl -= r;
      eq += r;
      if (eq > peak) peak = eq;
      if (peak - eq > dd) dd = peak - eq;
      if (!t.tpHit[0]) { streak++; if (streak > maxStreak) maxStreak = streak; } else streak = 0;
      comp *= (1 + 0.01 * r);
      curve.push({ t: t.closedT, r: eq });
    });
    var signals = list.length;
    var entries = list.filter(function (s) { return s.filledT != null; }).length;
    var expired = list.filter(function (s) { return s.status === 'expired'; }).length;
    var invalid = list.filter(function (s) { return s.status === 'invalidated'; }).length;
    var open = list.filter(isOpen).length;
    return {
      signals: signals, entries: entries, expired: expired, invalidated: invalid, open: open,
      n: n, wins: wins, losses: n - wins, be: be,
      winRate: n ? wins / n : NaN, lossRate: n ? (n - wins) / n : NaN,
      tpRate: [n ? tp[0] / n : NaN, n ? tp[1] / n : NaN, n ? tp[2] / n : NaN],
      sumR: sumR, avgR: n ? sumR / n : NaN, pf: gl > 0 ? gw / gl : (gw > 0 ? Infinity : NaN),
      maxDD: dd, compPct: (comp - 1) * 100, maxLossStreak: maxStreak, curve: curve
    };
  }

  // =====================================================================================
  // КАЛИБРОВКА ТОЧНОСТИ по корзинам score (localStorage).
  // =====================================================================================
  var Calib = {
    data: null,
    load: function () {
      var d = Data.Store.get(C.storage.calib, null);
      this.data = (d && d.coins && typeof d.coins === 'object') ? d : null;
    },
    save: function () { if (this.data) Data.Store.set(C.storage.calib, this.data); },
    clear: function () { this.data = null; Data.Store.remove(C.storage.calib); },
    bucketOf: function (score) {
      var b = C.calibration.buckets;
      for (var k = b.length - 1; k >= 0; k--) if (score >= b[k]) return b[k];
      return null;
    },
    bucketLabel: function (b) {
      var arr = C.calibration.buckets, k = arr.indexOf(b);
      return k < 0 ? '—' : (b + '–' + (k === arr.length - 1 ? 100 : arr[k + 1] - 1));
    },
    // Сохраняет успешность по корзинам для монет прогона (успех — TP1 раньше SL).
    update: function (signals, coins, meta) {
      var self = this, d = this.data || { v: 1, coins: {} };
      coins.forEach(function (coin) {
        var e = { ts: meta.ts, days: meta.days, minScore: meta.minScore, b: {} };
        C.calibration.buckets.forEach(function (b) { e.b[b] = { n: 0, s: 0 }; });
        d.coins[coin] = e;
      });
      signals.forEach(function (t) {
        if (t.status !== 'closed' || t.filledT == null) return;
        var e = d.coins[t.coin], b = self.bucketOf(t.score);
        if (!e || b === null) return;
        e.b[b].n++;
        if (t.tpHit[0]) e.b[b].s++;
      });
      d.ts = meta.ts; d.days = meta.days; d.minScore = meta.minScore; d.preset = meta.preset;
      this.data = d;
      this.save();
    },
    totals: function () {
      var out = { n: 0, s: 0, b: {} };
      C.calibration.buckets.forEach(function (b) { out.b[b] = { n: 0, s: 0 }; });
      if (!this.data) return out;
      var coins = this.data.coins;
      Object.keys(coins).forEach(function (coin) {
        var e = coins[coin];
        C.calibration.buckets.forEach(function (b) {
          var x = e.b && e.b[b];
          if (!x) return;
          out.b[b].n += x.n; out.b[b].s += x.s; out.n += x.n; out.s += x.s;
        });
      });
      return out;
    },
    has: function () { return !!this.data && this.totals().n >= C.calibration.minTotal; },
    // Точность сигнала: успешность его корзины; при n < 30 — сглаживание к общей p: (успехи + 10p)/(n + 10).
    // Если во всей калибровке меньше minTotal сделок, общая p ненадёжна — точность не показывается.
    accuracy: function (coin, score) {
      var tot = this.totals();
      if (tot.n < C.calibration.minTotal) return null;
      var p = tot.s / tot.n, b = this.bucketOf(score);
      if (b === null) return null;
      var ce = this.data.coins[coin], src = null, scope = '';
      if (ce && ce.b && ce.b[b] && ce.b[b].n > 0) { src = ce.b[b]; scope = coin; }
      else if (tot.b[b].n > 0) { src = tot.b[b]; scope = 'все монеты'; }
      var K = C.calibration.smoothK;
      if (!src) return { value: p, n: 0, scope: 'общая', smoothed: true, bucket: b, p: p };
      var smoothed = src.n < C.calibration.minN;
      var value = smoothed ? (src.s + K * p) / (src.n + K) : src.s / src.n;
      return { value: value, n: src.n, scope: scope, smoothed: smoothed, bucket: b, p: p };
    }
  };
  function smooth(s, n, p, K) { return (s + K * p) / (n + K); }

  return {
    validate: validate, create: create, step: step, provisional: provisional, openR: openR,
    computeR: computeR, bePrice: bePrice, isOpen: isOpen, isSuccess: isSuccess, statusText: statusText,
    OUTCOME: OUTCOME, Journal: Journal, Calib: Calib, stats: stats, smooth: smooth, clone: clone
  };
})();
