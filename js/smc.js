/* SMC Signals — движок Smart Money Concepts.
   Только чистые функции без обращения к DOM и сети. Одни и те же функции работают в live-режиме и в бэктесте.
   Правило «без заглядывания в будущее»: любая функция получает индекс последней закрытой свечи и не читает
   элементы массива с большим индексом. Свинг (фрактал) считается подтверждённым только с индекса conf = i + N. */
'use strict';

var SMC = (function () {
  var TF_MS = {
    '1m': 60000, '3m': 180000, '5m': 300000, '15m': 900000, '30m': 1800000,
    '1h': 3600000, '2h': 7200000, '4h': 14400000, '6h': 21600000, '12h': 43200000, '1d': 86400000
  };
  var DAY = 86400000;

  function tfMs(tf) {
    var v = TF_MS[tf];
    if (!v) throw new Error('Неизвестный таймфрейм: ' + tf);
    return v;
  }
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function clamp(x, a, b) { return x < a ? a : (x > b ? b : x); }

  // ---------- поиск по времени ----------
  // Наибольший индекс k, у которого свеча закрыта к моменту T (t + ms <= T). -1, если таких нет.
  function lastClosedIndex(c, ms, T) {
    var lo = 0, hi = c.length - 1, ans = -1, lim = T - ms;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (c[mid].t <= lim) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }
  // Первый индекс k с c[k].t >= t (c.length, если нет).
  function firstIndexFrom(c, t) {
    var lo = 0, hi = c.length;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (c[mid].t < t) lo = mid + 1; else hi = mid;
    }
    return lo;
  }
  function indexOfTime(c, t) {
    var k = firstIndexFrom(c, t);
    return (k < c.length && c[k].t === t) ? k : -1;
  }

  // ---------- индикаторы ----------
  function emaArr(c, period) {
    var n = c.length, out = new Float64Array(n), i;
    for (i = 0; i < n; i++) out[i] = NaN;
    if (n < period) return out;
    var sum = 0;
    for (i = 0; i < period; i++) sum += c[i].c;
    var e = sum / period, k = 2 / (period + 1);
    out[period - 1] = e;
    for (i = period; i < n; i++) { e = c[i].c * k + e * (1 - k); out[i] = e; }
    return out;
  }
  function trueRange(c, i) {
    var x = c[i];
    if (i === 0) return x.h - x.l;
    var pc = c[i - 1].c;
    return Math.max(x.h - x.l, Math.abs(x.h - pc), Math.abs(x.l - pc));
  }
  // ATR по Уайлдеру.
  function atrArr(c, period) {
    var n = c.length, out = new Float64Array(n), i;
    for (i = 0; i < n; i++) out[i] = NaN;
    if (n <= period) return out;
    var sum = 0;
    for (i = 1; i <= period; i++) sum += trueRange(c, i);
    var a = sum / period;
    out[period] = a;
    for (i = period + 1; i < n; i++) { a = (a * (period - 1) + trueRange(c, i)) / period; out[i] = a; }
    return out;
  }

  // ---------- свинги (фракталы) ----------
  // Максимум выше N свечей слева (строго) и не ниже N свечей справа (равенство справа — чтобы плато дало один свинг).
  // Фрактал на j проверяется только если существуют свечи j+1..j+N — заглядывания в будущее нет.
  function findSwings(c, n) {
    var highs = [], lows = [], len = c.length;
    for (var j = n; j + n < len; j++) {
      var h = c[j].h, l = c[j].l, isH = true, isL = true;
      for (var k = 1; k <= n && (isH || isL); k++) {
        if (isH && !(h > c[j - k].h && h >= c[j + k].h)) isH = false;
        if (isL && !(l < c[j - k].l && l <= c[j + k].l)) isL = false;
      }
      if (isH) highs.push({ i: j, t: c[j].t, p: h, conf: j + n });
      if (isL) lows.push({ i: j, t: c[j].t, p: l, conf: j + n });
    }
    return { highs: highs, lows: lows };
  }
  function lowerBoundI(list, from) {
    var lo = 0, hi = list.length;
    while (lo < hi) {
      var m = (lo + hi) >> 1;
      if (list[m].i < from) lo = m + 1; else hi = m;
    }
    return lo;
  }
  // Свинги с i >= from, подтверждённые к индексу idx (conf <= idx).
  function swingsIn(list, from, idx) {
    var out = [];
    for (var k = lowerBoundI(list, from); k < list.length && list[k].conf <= idx; k++) out.push(list[k]);
    return out;
  }

  // ---------- серия ----------
  function buildSeries(candles, tf, cfg) {
    var sw = findSwings(candles, cfg.swingN);
    return {
      tf: tf, ms: tfMs(tf), c: candles,
      atr: atrArr(candles, cfg.atrPeriod),
      ema50: emaArr(candles, cfg.ema.fast),
      ema200: emaArr(candles, cfg.ema.slow),
      highs: sw.highs, lows: sw.lows
    };
  }

  function memo(m, key, fn) {
    if (!m) return fn();
    var v = m.get(key);
    if (v === undefined) { v = fn(); m.set(key, v); }
    return v;
  }

  // ---------- структура: BOS / CHoCH ----------
  // Проход по окну [from, to]. Последний подтверждённый свинг становится уровнем слома.
  // BOS — закрытие тела за свингом по тренду, CHoCH — против текущей структуры.
  function structure(s, from, to) {
    var c = s.c, H = s.highs, L = s.lows;
    var hi = lowerBoundI(H, from), lo = lowerBoundI(L, from);
    var curH = null, curL = null, trend = 0, events = [];
    for (var k = from; k <= to; k++) {
      while (hi < H.length && H[hi].conf <= k) { curH = { p: H[hi].p, i: H[hi].i, broken: false }; hi++; }
      while (lo < L.length && L[lo].conf <= k) { curL = { p: L[lo].p, i: L[lo].i, broken: false }; lo++; }
      var cl = c[k].c;
      if (curH && !curH.broken && cl > curH.p) {
        events.push({ k: k, dir: 1, type: trend === -1 ? 'CHoCH' : 'BOS', level: curH.p, swingI: curH.i });
        trend = 1; curH.broken = true;
      } else if (curL && !curL.broken && cl < curL.p) {
        events.push({ k: k, dir: -1, type: trend === 1 ? 'CHoCH' : 'BOS', level: curL.p, swingI: curL.i });
        trend = -1; curL.broken = true;
      }
    }
    return { trend: trend, events: events };
  }

  // ---------- displacement ----------
  // Свеча k с телом >= 1.5×ATR (ATR до импульса) или пара k-1,k одного направления с суммой тел >= 2×ATR.
  function displacement(s, k, dir, cfg) {
    var c = s.c, a = s.atr, D = cfg.displacement;
    if (k < 1) return null;
    var b0 = (c[k].c - c[k].o) * dir;
    if (!(b0 > 0)) return null;
    var a1 = a[k - 1];
    if (a1 > 0 && b0 >= D.single * a1) return { start: k, end: k, body: b0, atr: a1, mult: b0 / a1, pair: false };
    if (k >= 2) {
      var b1 = (c[k - 1].c - c[k - 1].o) * dir, a2 = a[k - 2];
      if (b1 > 0 && a2 > 0 && b0 + b1 >= D.double * a2) {
        return { start: k - 1, end: k, body: b0 + b1, atr: a2, mult: (b0 + b1) / a2, pair: true };
      }
    }
    return null;
  }
  // Средний объём свечей displacement относительно среднего объёма N свечей до него.
  function volumeRatio(s, start, end, lookback) {
    var c = s.c;
    if (start - lookback < 0) return NaN;
    var sum = 0, x;
    for (x = start - lookback; x < start; x++) sum += c[x].v;
    var avg = sum / lookback;
    if (!(avg > 0)) return NaN;
    var dv = 0;
    for (x = start; x <= end; x++) dv += c[x].v;
    return dv / (end - start + 1) / avg;
  }

  // ---------- зоны ----------
  function obZone(cd, cfg) {
    return cfg.ob.zone === 'wick'
      ? { bot: cd.l, top: cd.h }
      : { bot: Math.min(cd.o, cd.c), top: Math.max(cd.o, cd.c) };
  }
  // Order Block: последняя противоположная свеча перед displacement, сломавшим структуру.
  function findOBs(s, from, to, dir, cfg) {
    var st = structure(s, from, to), out = [];
    for (var e = 0; e < st.events.length; e++) {
      var ev = st.events[e];
      if (ev.dir !== dir) continue;
      var d = displacement(s, ev.k, dir, cfg);
      if (!d) continue;
      var j = -1, lim = Math.max(from, d.start - cfg.ob.maxLookback);
      for (var x = d.start - 1; x >= lim; x--) {
        var cx = s.c[x];
        if ((cx.c - cx.o) * dir < 0) { j = x; break; }
      }
      if (j < 0) continue;
      var z = obZone(s.c[j], cfg);
      out.push({ kind: 'ob', dir: dir, i: j, t: s.c[j].t, formed: ev.k, bot: z.bot, top: z.top, evType: ev.type, disp: d });
    }
    return out;
  }
  // FVG: у бычьего максимум первой свечи ниже минимума третьей, размер >= 0.1×ATR.
  function findFVGs(s, from, to, dir, cfg) {
    var c = s.c, out = [];
    for (var k = Math.max(from + 2, 2); k <= to; k++) {
      var a = s.atr[k - 1];
      if (!(a > 0)) continue;
      var bot, top;
      if (dir === 1) { bot = c[k - 2].h; top = c[k].l; } else { bot = c[k].h; top = c[k - 2].l; }
      if (top > bot && top - bot >= cfg.fvg.minAtr * a) {
        out.push({ kind: 'fvg', dir: dir, i: k - 1, t: c[k - 1].t, formed: k, bot: bot, top: top });
      }
    }
    return out;
  }
  // Состояние зоны после формирования: число отдельных визитов цены, недействительность (закрытие тела за зоной),
  // глубина захода. Визит заканчивается, когда свеча целиком ушла дальше nearAtr×ATR от зоны.
  function zoneState(s, z, to, dir, nearAtr) {
    var c = s.c, runs = 0, inVisit = false, invalid = false, deep = NaN;
    for (var k = z.formed + 1; k <= to; k++) {
      var cd = c[k], a = s.atr[k], tol = (a > 0 ? a : 0) * nearAtr;
      var touch = dir === 1 ? cd.l <= z.top : cd.h >= z.bot;
      var near = dir === 1 ? cd.l <= z.top + tol : cd.h >= z.bot - tol;
      if (touch) {
        if (!inVisit) { runs++; inVisit = true; }
        var v = dir === 1 ? cd.l : cd.h;
        if (deep !== deep || (dir === 1 ? v < deep : v > deep)) deep = v;
      }
      if (!near) inVisit = false;
      if (dir === 1 ? cd.c < z.bot : cd.c > z.top) { invalid = true; break; }
    }
    return { runs: runs, invalid: invalid, deep: deep };
  }
  function fvgFill(z, deep, dir) {
    if (deep !== deep) return 0;
    var size = z.top - z.bot;
    if (!(size > 0)) return 1;
    var f = dir === 1 ? (z.top - Math.max(deep, z.bot)) / size : (Math.min(deep, z.top) - z.bot) / size;
    return clamp(f, 0, 1);
  }
  function intersect(a, b) {
    if (!a || !b) return null;
    var lo = Math.max(a.bot, b.bot), hi = Math.min(a.top, b.top);
    return hi > lo ? { bot: lo, top: hi } : null;
  }

  // ---------- ликвидность ----------
  // Кластеры равных уровней (>= 2 свинга в пределах допуска). side: 1 — максимумы (уровень = max), -1 — минимумы.
  function equalLevels(list, tolFn, side) {
    if (list.length < 2) return [];
    var arr = list.slice().sort(function (a, b) { return a.p - b.p; });
    var out = [], g = [arr[0]];
    function flush() {
      if (g.length < 2) return;
      var p = side === 1 ? -Infinity : Infinity, conf = -1, first = Infinity;
      for (var q = 0; q < g.length; q++) {
        if (side === 1 ? g[q].p > p : g[q].p < p) p = g[q].p;
        if (g[q].conf > conf) conf = g[q].conf;
        if (g[q].i < first) first = g[q].i;
      }
      out.push({ p: p, n: g.length, conf: conf, first: first });
    }
    for (var k = 1; k < arr.length; k++) {
      if (arr[k].p - g[0].p <= tolFn(g[0].p)) g.push(arr[k]);
      else { flush(); g = [arr[k]]; }
    }
    flush();
    return out;
  }
  // Максимум и минимум предыдущих суток (UTC) по закрытым свечам серии.
  function prevDay(s, T) {
    var day0 = Math.floor(T / DAY) * DAY, d1 = day0 - DAY;
    var k0 = firstIndexFrom(s.c, d1), k1 = firstIndexFrom(s.c, day0);
    if (k1 - k0 < Math.floor(DAY / s.ms * 0.8)) return null;
    var h = -Infinity, l = Infinity;
    for (var k = k0; k < k1; k++) {
      if (s.c[k].h > h) h = s.c[k].h;
      if (s.c[k].l < l) l = s.c[k].l;
    }
    return { h: h, l: l, day0: day0 };
  }

  // ---------- bias ----------
  // Бычий: свинги HH/HL и закрытие выше EMA50. Медвежий: LH/LL и закрытие ниже EMA50. Иначе флэт.
  function computeBias(s, idx, W, minBars, cfg) {
    var r = { dir: 0, why: '', struct: '', close: NaN, e50: NaN, e200: NaN, emaAlign: false, range: null };
    if (!s || idx < 0) { r.why = 'нет данных'; return r; }
    var from = Math.max(0, idx - W + 1);
    if (idx - from + 1 < minBars) { r.why = 'мало свечей'; return r; }
    var H = swingsIn(s.highs, from, idx), L = swingsIn(s.lows, from, idx);
    if (H.length < 2 || L.length < 2) { r.why = 'мало свингов'; return r; }
    var h1 = H[H.length - 1], h0 = H[H.length - 2], l1 = L[L.length - 1], l0 = L[L.length - 2];
    var close = s.c[idx].c, e50 = s.ema50[idx], e200 = s.ema200[idx];
    r.close = close; r.e50 = e50; r.e200 = e200;
    r.sh = h1.p; r.sl = l1.p;
    var hh = h1.p > h0.p, hl = l1.p > l0.p, lh = h1.p < h0.p, ll = l1.p < l0.p;
    r.struct = (hh ? 'HH' : (lh ? 'LH' : '=H')) + '/' + (hl ? 'HL' : (ll ? 'LL' : '=L'));
    if (h1.p > l1.p) r.range = { lo: l1.p, hi: h1.p, eq: (l1.p + h1.p) / 2 };
    if (!isNum(e50)) { r.why = 'нет EMA50'; return r; }
    if (hh && hl) {
      if (!(close > e50)) r.why = 'HH/HL, но закрытие ниже EMA50';
      else r.dir = 1;
    } else if (lh && ll) {
      if (!(close < e50)) r.why = 'LH/LL, но закрытие выше EMA50';
      else r.dir = -1;
    } else {
      r.why = 'структура ' + r.struct;
    }
    r.emaAlign = r.dir !== 0 && isNum(e200) && (r.dir === 1 ? close > e200 : close < e200);
    return r;
  }

  // Диапазон Premium/Discount: от последнего подтверждённого swing low до последнего swing high в окне серии.
  function swingRange(s, idx, W) {
    if (!s || idx < 0) return null;
    var from = Math.max(0, idx - W + 1);
    var H = swingsIn(s.highs, from, idx), L = swingsIn(s.lows, from, idx);
    if (!H.length || !L.length) return null;
    var hi = H[H.length - 1].p, lo = L[L.length - 1].p;
    return hi > lo ? { lo: lo, hi: hi, eq: (lo + hi) / 2 } : null;
  }
  // Диапазон для правила Premium/Discount по профилю: 'htf' — 4H (из bias), 'mtf' — 1H.
  function pdRangeFor(ctx, bias) {
    var cfg = ctx.cfg;
    if (cfg.pdRange === 'mtf') {
      var rg = memo(ctx.memo, 'rM' + ctx.im, function () { return swingRange(ctx.M, ctx.im, cfg.windows.mtf); });
      return rg ? { lo: rg.lo, hi: rg.hi, eq: rg.eq, tf: ctx.M.tf } : null;
    }
    return bias.range ? { lo: bias.range.lo, hi: bias.range.hi, eq: bias.range.eq, tf: ctx.H.tf } : null;
  }

  // ---------- контекст ----------
  // o: {sym, coin, L, M, H, i, btc:{M,H}|null, cfg, longOnly, memo, btcMemo}
  function makeContext(o) {
    var L = o.L, T = L.c[o.i].t + L.ms;
    var ctx = {
      sym: o.sym, coin: o.coin, cfg: o.cfg, L: L, M: o.M, H: o.H, i: o.i, T: T,
      im: lastClosedIndex(o.M.c, o.M.ms, T),
      ih: lastClosedIndex(o.H.c, o.H.ms, T),
      longOnly: !!o.longOnly, memo: o.memo || null, btc: null
    };
    if (o.btc && o.btc.M && o.btc.H) {
      ctx.btc = {
        M: o.btc.M, H: o.btc.H,
        im: lastClosedIndex(o.btc.M.c, o.btc.M.ms, T),
        ih: lastClosedIndex(o.btc.H.c, o.btc.H.ms, T),
        memo: o.btcMemo || null
      };
    }
    return ctx;
  }

  // Экстремум всей цены после свечи j указанного ТФ до момента T (каскадом: старший ТФ → младшие).
  function extremeSince(ctx, key, j, dir) {
    var best = dir === 1 ? -Infinity : Infinity;
    function scan(S, a, b) {
      for (var k = a; k <= b; k++) {
        var v = dir === 1 ? S.c[k].h : S.c[k].l;
        if (dir === 1 ? v > best : v < best) best = v;
      }
    }
    var L = ctx.L, M = ctx.M, H = ctx.H, tEnd;
    if (key === 'H') {
      scan(H, j + 1, ctx.ih);
      tEnd = ctx.ih >= 0 ? H.c[ctx.ih].t + H.ms : -Infinity;
      if (ctx.im >= 0) {
        scan(M, firstIndexFrom(M.c, tEnd), ctx.im);
        tEnd = Math.max(tEnd, M.c[ctx.im].t + M.ms);
      }
      scan(L, firstIndexFrom(L.c, tEnd), ctx.i);
    } else if (key === 'M') {
      scan(M, j + 1, ctx.im);
      tEnd = M.c[ctx.im].t + M.ms;
      scan(L, firstIndexFrom(L.c, tEnd), ctx.i);
    } else {
      scan(L, j + 1, ctx.i);
    }
    return best;
  }
  // Экстремум цены с момента t0 до T.
  function extremeSinceTime(ctx, t0, dir) {
    var best = dir === 1 ? -Infinity : Infinity, M = ctx.M, L = ctx.L, k;
    for (k = firstIndexFrom(M.c, t0); k <= ctx.im; k++) {
      var v = dir === 1 ? M.c[k].h : M.c[k].l;
      if (dir === 1 ? v > best : v < best) best = v;
    }
    var tEnd = Math.max(t0, ctx.im >= 0 ? M.c[ctx.im].t + M.ms : t0);
    for (k = firstIndexFrom(L.c, tEnd); k <= ctx.i; k++) {
      var w = dir === 1 ? L.c[k].h : L.c[k].l;
      if (dir === 1 ? w > best : w < best) best = w;
    }
    return best;
  }

  // ---------- sweep ----------
  // Экстремум движения за последние N свечей 15m должен снять ликвидность: тень за уровнем, закрытие обратно.
  // Уровни: подтверждённые свинги 15m, equal highs/lows, максимум/минимум предыдущих суток.
  // Уровень нетронут до окна sweep (ликвидность ещё на месте), после sweep нет закрытий за уровнем.
  function findSweep(ctx, lFrom, i, dir) {
    var L = ctx.L, c = L.c, cfg = ctx.cfg;
    var a = Math.max(lFrom, i - cfg.liquidity.sweepLookback);
    var s = -1, ext = dir === 1 ? Infinity : -Infinity, k;
    for (k = a; k <= i; k++) {
      var v = dir === 1 ? c[k].l : c[k].h;
      if (dir === 1 ? v < ext : v > ext) { ext = v; s = k; }
    }
    if (s < 0) return null;
    var res = { s: s, t: c[s].t, ext: ext, level: null, type: null };
    function pierce(q, p) { return dir === 1 ? c[q].l < p : c[q].h > p; }
    function back(q, p) { return dir === 1 ? c[q].c > p : c[q].c < p; }
    function test(p, k0) {
      if (k0 > s) return false;                         // уровень должен существовать до свечи sweep
      if (!((p - ext) * dir > 0) || !back(s, p)) return false; // тень за уровнем, закрытие обратно
      var q;
      for (q = Math.max(k0, lFrom); q < a; q++) if (pierce(q, p)) return false; // уровень снят раньше окна
      for (q = s + 1; q <= i; q++) if (dir === 1 ? c[q].c < p : c[q].c > p) return false; // возврат не удержан
      return true;
    }
    var best = null;
    function consider(p, type, k0, rank) {
      if (!test(p, k0)) return;
      if (!best || rank > best.rank || (rank === best.rank && (p - best.p) * dir < 0)) best = { p: p, type: type, rank: rank };
    }
    var sw = swingsIn(dir === 1 ? L.lows : L.highs, lFrom, s - 1);
    for (k = 0; k < sw.length; k++) consider(sw[k].p, 'swing', sw[k].conf + 1, 1);
    var atr = L.atr[s];
    var tolF = function (p) { return Math.max(cfg.liquidity.eqTolPct * p, cfg.liquidity.eqTolAtr * (atr > 0 ? atr : 0)); };
    var eqs = equalLevels(sw, tolF, -dir);
    for (k = 0; k < eqs.length; k++) {
      var q2 = eqs[k], clean = true;
      for (var y = q2.first; y <= q2.conf; y++) if (pierce(y, q2.p)) { clean = false; break; }
      if (clean) consider(q2.p, 'eq', q2.conf + 1, 3);
    }
    var pd = prevDay(ctx.M, c[s].t);
    if (pd) {
      var kDay = firstIndexFrom(c, pd.day0);
      if (kDay <= s) consider(dir === 1 ? pd.l : pd.h, 'pd', kDay, 2);
    }
    if (best) { res.level = best.p; res.type = best.type; }
    return res;
  }

  // ---------- зона интереса 1H ----------
  function mtfZones(ctx, dir) {
    var M = ctx.M, im = ctx.im, cfg = ctx.cfg;
    return memo(ctx.memo, 'zM' + dir + ':' + im, function () {
      var from = Math.max(0, im - cfg.windows.mtf + 1);
      return { obs: findOBs(M, from, im, dir, cfg), fvgs: findFVGs(M, from, im, dir, cfg) };
    });
  }
  // Свежий бычий (медвежий) OB или FVG на 1H в Discount (Premium), сформированный до sweep,
  // с экстремумом sweep внутри зоны или не дальше 0.5×ATR(1H) от неё. Недействительность — закрытие тела 1H за зоной.
  function findPOI(ctx, dir, ext, sweepT, eq) {
    var M = ctx.M, im = ctx.im, cfg = ctx.cfg;
    var atrM = M.atr[im];
    if (!(atrM > 0)) return null;
    var tol = cfg.poi.maxDistAtr * atrM;
    var zs = mtfZones(ctx, dir);
    function check(z, isFvg) {
      var formedClose = M.c[z.formed].t + M.ms;
      if (formedClose > sweepT) return null;
      var st = zoneState(M, z, im, dir, cfg.poi.maxDistAtr);
      if (st.invalid || st.runs > 1) return null;
      var fill = 0;
      if (isFvg) {
        fill = fvgFill(z, st.deep, dir);
        if (fill > cfg.fvg.maxFill) return null;
      }
      var mid = (z.bot + z.top) / 2;
      if (dir === 1 ? !(mid < eq) : !(mid > eq)) return null;
      if (ext < z.bot - tol || ext > z.top + tol) return null;
      return { z: z, runs: st.runs, fill: fill };
    }
    var obs = [], fvgs = [], k, v;
    for (k = 0; k < zs.obs.length; k++) { v = check(zs.obs[k], false); if (v) obs.push(v); }
    for (k = 0; k < zs.fvgs.length; k++) { v = check(zs.fvgs[k], true); if (v) fvgs.push(v); }
    var cands = [];
    obs.forEach(function (o) {
      var best = null, bestOv = 0;
      fvgs.forEach(function (f) {
        var ov = intersect(o.z, f.z);
        if (ov && ov.top - ov.bot > bestOv) { bestOv = ov.top - ov.bot; best = f; }
      });
      cands.push({ quality: best ? 3 : 2, ob: o, fvg: best, bot: o.z.bot, top: o.z.top, formed: o.z.formed });
    });
    fvgs.forEach(function (f) {
      cands.push({ quality: 1, ob: null, fvg: f, bot: f.z.bot, top: f.z.top, formed: f.z.formed });
    });
    if (!cands.length) return null;
    function dist(x) { return ext < x.bot ? x.bot - ext : (ext > x.top ? ext - x.top : 0); }
    cands.sort(function (a, b) { return (b.quality - a.quality) || (dist(a) - dist(b)) || (b.formed - a.formed); });
    var b0 = cands[0];
    function pack(p) {
      return p ? { t: p.z.t, bot: p.z.bot, top: p.z.top, formedT: M.c[p.z.formed].t, runs: p.runs, fill: p.fill } : null;
    }
    return {
      bot: b0.bot, top: b0.top, quality: b0.quality,
      kind: b0.quality === 3 ? 'ob+fvg' : (b0.quality === 2 ? 'ob' : 'fvg'),
      ob: pack(b0.ob), fvg: pack(b0.fvg), t: b0.ob ? b0.ob.z.t : b0.fvg.z.t
    };
  }

  // ---------- зона входа 15m ----------
  function entryZone(ctx, lFrom, dir, sw, disp, poi) {
    var L = ctx.L, c = L.c, cfg = ctx.cfg, i = ctx.i, x, y;
    var dStart = disp ? disp.start : i;
    var ob = null, lim = Math.max(lFrom, dStart - cfg.ob.maxLookback);
    for (x = dStart - 1; x >= lim; x--) {
      if ((c[x].c - c[x].o) * dir < 0) {
        var z = obZone(c[x], cfg);
        ob = { bot: z.bot, top: z.top, t: c[x].t, i: x };
        break;
      }
    }
    if (ob) {
      for (y = ob.i + 1; y <= i; y++) {
        if (dir === 1 ? c[y].c < ob.bot : c[y].c > ob.top) { ob = null; break; }
      }
    }
    var fvgs = [];
    for (var k = Math.max(sw.s + 2, lFrom + 2); k <= i; k++) {
      var a = L.atr[k - 1];
      if (!(a > 0)) continue;
      var bot, top;
      if (dir === 1) { bot = c[k - 2].h; top = c[k].l; } else { bot = c[k].h; top = c[k - 2].l; }
      if (!(top > bot) || top - bot < cfg.fvg.minAtr * a) continue;
      var deep = NaN;
      for (y = k + 1; y <= i; y++) {
        var v = dir === 1 ? c[y].l : c[y].h;
        if (dir === 1 ? v <= top : v >= bot) {
          if (deep !== deep || (dir === 1 ? v < deep : v > deep)) deep = v;
        }
      }
      var fz = { bot: bot, top: top, t: c[k - 1].t, i: k - 1 };
      if (fvgFill(fz, deep, dir) > cfg.fvg.maxFill) continue;
      fvgs.push(fz);
    }
    // OTE 0.62–0.79 импульсной ноги: от экстремума sweep до крайней точки движения.
    var far = dir === 1 ? -Infinity : Infinity;
    for (x = sw.s; x <= i; x++) {
      var w = dir === 1 ? c[x].h : c[x].l;
      if (dir === 1 ? w > far : w < far) far = w;
    }
    var leg = (far - sw.ext) * dir, ote = null;
    if (leg > 0) {
      ote = dir === 1
        ? { bot: far - cfg.ote.hi * leg, top: far - cfg.ote.lo * leg }
        : { bot: far + cfg.ote.lo * leg, top: far + cfg.ote.hi * leg };
    }
    var zone = null, kind = '', usedFvg = null, f;
    if (ob && ote) {
      for (f = 0; f < fvgs.length; f++) {
        var i3 = intersect(intersect(ob, fvgs[f]), ote);
        if (i3 && (!zone || i3.top - i3.bot > zone.top - zone.bot)) { zone = i3; usedFvg = fvgs[f]; }
      }
      if (zone) kind = 'ob+fvg+ote';
    }
    if (!zone && ob) { zone = { bot: ob.bot, top: ob.top }; kind = 'ob'; }
    if (!zone && fvgs.length) {
      var bestOv = -1;
      for (f = 0; f < fvgs.length; f++) {
        var ov = ote ? intersect(fvgs[f], ote) : null;
        var sz = ov ? ov.top - ov.bot : 0;
        if (sz > bestOv || (sz === bestOv && fvgs[f].i > usedFvg.i)) { bestOv = sz; usedFvg = fvgs[f]; }
      }
      zone = { bot: usedFvg.bot, top: usedFvg.top }; kind = 'fvg';
    }
    // src — исходная зона (OB или FVG), закрытие тела за которой делает вход недействительным.
    var zoneT, src;
    if (!zone && !poi) return null; // нет ни OB/FVG на младшем ТФ, ни зоны среднего ТФ — входить негде
    if (!zone) { zone = { bot: poi.bot, top: poi.top }; kind = 'poi'; zoneT = poi.t; src = { bot: poi.bot, top: poi.top }; }
    else if (kind === 'fvg') { zoneT = usedFvg.t; src = { bot: usedFvg.bot, top: usedFvg.top }; }
    else { zoneT = ob.t; src = { bot: ob.bot, top: ob.top }; }
    var entry = cfg.entryMode === 'edge' ? (dir === 1 ? zone.top : zone.bot) : (zone.bot + zone.top) / 2;
    return {
      zone: { bot: zone.bot, top: zone.top, kind: kind, t: zoneT, src: src },
      entry: entry, ob: ob, fvg: usedFvg, ote: ote, far: far,
      inOte: !!ote && entry >= ote.bot && entry <= ote.top
    };
  }

  // ---------- цели ----------
  // Ближайшая противоположная цель: непробитый swing high/low 1H–4H, equal highs/lows, PDH/PDL,
  // нетронутый противоположный OB/FVG на 1H–4H.
  function findTargets(ctx, dir, entry) {
    var cfg = ctx.cfg, out = [];
    function add(p, type, tf) { if (isNum(p) && (p - entry) * dir > 0) out.push({ p: p, type: type, tf: tf }); }
    var tfs = [['M', ctx.M, ctx.im, cfg.windows.mtf], ['H', ctx.H, ctx.ih, cfg.windows.htf]];
    tfs.forEach(function (x) {
      var key = x[0], S = x[1], idx = x[2], W = x[3];
      if (idx < 0) return;
      var from = Math.max(0, idx - W + 1);
      var list = swingsIn(dir === 1 ? S.highs : S.lows, from, idx), unb = [];
      list.forEach(function (sv) {
        if (!((sv.p - entry) * dir > 0)) return;
        var ex = extremeSince(ctx, key, sv.i, dir);
        if (dir === 1 ? ex <= sv.p : ex >= sv.p) { unb.push(sv); add(sv.p, 'swing', key); }
      });
      var a = S.atr[idx];
      var tolF = function (p) { return Math.max(cfg.liquidity.eqTolPct * p, cfg.liquidity.eqTolAtr * (a > 0 ? a : 0)); };
      equalLevels(unb, tolF, dir).forEach(function (q) { add(q.p, 'eq', key); });
      var zs = memo(ctx.memo, 'zO' + key + dir + ':' + idx, function () {
        return { obs: findOBs(S, from, idx, -dir, cfg), fvgs: findFVGs(S, from, idx, -dir, cfg) };
      });
      zs.obs.concat(zs.fvgs).forEach(function (z) {
        var edge = dir === 1 ? z.bot : z.top;
        if (!((edge - entry) * dir > 0)) return;
        var ex = extremeSince(ctx, key, z.formed, dir);
        if (dir === 1 ? ex < z.bot : ex > z.top) add(edge, z.kind, key);
      });
    });
    var pd = prevDay(ctx.M, ctx.T);
    if (pd) {
      var lvl = dir === 1 ? pd.h : pd.l;
      var exd = extremeSinceTime(ctx, pd.day0, dir);
      if (dir === 1 ? exd <= lvl : exd >= lvl) add(lvl, 'pd', 'D');
    }
    var nearest = null;
    out.forEach(function (o) { if (!nearest || (o.p - nearest.p) * dir < 0) nearest = o; });
    return { list: out, nearest: nearest };
  }

  // ---------- волатильность ----------
  // ATR(14)/цена на 1H в нижних 20% за последние 30 дней.
  function lowVolatility(M, im, cfg) {
    var n = Math.round(cfg.lowVol.days * DAY / M.ms), from = im - n + 1;
    var cur = M.atr[im] / M.c[im].c;
    if (!isNum(cur) || from < 0) return { known: false, low: false, rank: NaN };
    var below = 0, cnt = 0;
    for (var k = from; k <= im; k++) {
      var v = M.atr[k] / M.c[k].c;
      if (!isNum(v)) continue;
      cnt++;
      if (v < cur) below++;
    }
    if (cnt < n * 0.8) return { known: false, low: false, rank: NaN };
    var rank = below / cnt;
    return { known: true, low: rank < cfg.lowVol.pct, rank: rank };
  }

  // ---------- уровни сделки ----------
  function levelsFrom(dir, entry, sl, roomR, cfg) {
    var R = (entry - sl) * dir;
    var tp3R = Math.min(roomR, cfg.tp.tp3MaxR);
    return {
      R: R,
      tp1: entry + dir * cfg.tp.r[0] * R,
      tp2: entry + dir * cfg.tp.r[1] * R,
      tp3: entry + dir * tp3R * R,
      tp3R: tp3R
    };
  }

  var LIQ_NAMES = { swing: 'свинг', eq: 'equal ', pd: 'предыдущих суток' };
  function liqLabel(type, dir) {
    if (type === 'eq') return dir === 1 ? 'equal lows' : 'equal highs';
    if (type === 'pd') return dir === 1 ? 'минимум предыдущих суток' : 'максимум предыдущих суток';
    if (type === 'swing') return dir === 1 ? 'swing low 15m' : 'swing high 15m';
    return LIQ_NAMES[type] || type;
  }
  var TARGET_NAMES = { swing: 'swing', eq: 'equal', pd: 'экстремум пред. суток', ob: 'OB', fvg: 'FVG' };

  // ---------- детектор ----------
  // Сигнал строится только на закрытой свече 15m с индексом ctx.i.
  function detect(ctx) {
    var cfg = ctx.cfg, L = ctx.L, M = ctx.M, H = ctx.H, i = ctx.i;
    var r = { cand: null, stage: 'data', code: 'data', reason: '', dir: 0, bias: null };
    function fail(stage, reason, code) { r.stage = stage; r.reason = reason; r.code = code || stage; return r; }
    if (i < 2 || ctx.im < 1 || ctx.ih < 1) return fail('data', 'мало данных');
    var lFrom = Math.max(0, i - cfg.windows.ltf + 1);
    if (i - lFrom + 1 < cfg.minBars.ltf) return fail('data', 'мало свечей ' + L.tf);
    if (ctx.im + 1 < cfg.minBars.mtf) return fail('data', 'мало свечей ' + M.tf);

    // 1. Быстрая проверка триггера: displacement на последней закрытой свече.
    var dUp = displacement(L, i, 1, cfg), dDn = displacement(L, i, -1, cfg);
    if (cfg.require.displacement && !dUp && !dDn) return fail('trigger', 'нет displacement', 'noDisp');

    // 2. Bias старшего ТФ.
    var bias = memo(ctx.memo, 'bH' + ctx.ih, function () {
      return computeBias(H, ctx.ih, cfg.windows.htf, cfg.minBars.htf, cfg);
    });
    r.bias = bias;
    if (bias.dir === 0) return fail('bias', 'bias ' + H.tf + ' флэт: ' + bias.why);
    var dir = bias.dir;
    r.dir = dir;
    if (dir === -1 && ctx.longOnly) return fail('bias', 'bias медвежий, включён режим «Только LONG»', 'longOnly');
    var rng = pdRangeFor(ctx, bias);
    if (!rng) return fail('bias', 'нет диапазона Premium/Discount (' + (cfg.pdRange === 'mtf' ? M.tf : H.tf) + ')');
    var disp = dir === 1 ? dUp : dDn;
    if (cfg.require.displacement && !disp) return fail('trigger', 'displacement против bias', 'dispDir');

    // 3. CHoCH/BOS по направлению bias на этой свече.
    var st = structure(L, lFrom, i), ev = null;
    for (var e = st.events.length - 1; e >= 0; e--) {
      if (st.events[e].k < i) break;
      if (st.events[e].k === i && st.events[e].dir === dir) { ev = st.events[e]; break; }
    }
    if (!ev) return fail('trigger', 'нет CHoCH/BOS по направлению bias', 'noBreak');

    // 4. Sweep ликвидности перед сломом.
    var sw = findSweep(ctx, lFrom, i, dir);
    if (!sw) return fail('sweep', 'нет экстремума движения');
    if (cfg.require.sweep && sw.level === null) return fail('sweep', 'нет sweep ликвидности перед ' + ev.type);

    // 5. Свежая зона интереса на 1H.
    var eq = rng.eq;
    var poi = findPOI(ctx, dir, sw.ext, L.c[sw.s].t, eq);
    if (!poi && !cfg.poi.optional) return fail('poi', 'нет свежей зоны ' + M.tf + ' в ' + (dir === 1 ? 'Discount' : 'Premium') + ' у sweep');

    // 6. Зона и цена входа на 15m.
    var ez = entryZone(ctx, lFrom, dir, sw, disp, poi);
    if (!ez) return fail('entry', 'нет зоны входа ' + L.tf + ' (OB/FVG)');
    var entry = ez.entry;
    if (dir === 1 ? !(entry < eq) : !(entry > eq)) return fail('pd', 'вход вне ' + (dir === 1 ? 'Discount' : 'Premium'));

    // 7. Стоп и риск.
    var atrL = L.atr[i];
    if (!(atrL > 0)) return fail('data', 'нет ATR');
    var sl = dir === 1
      ? Math.min(ez.zone.bot, sw.ext) - cfg.sl.bufferAtr * atrL
      : Math.max(ez.zone.top, sw.ext) + cfg.sl.bufferAtr * atrL;
    var R = (entry - sl) * dir;
    if (!(R > 0)) return fail('risk', 'стоп по неверную сторону');
    var riskPct = R / entry * 100;
    if (riskPct < cfg.sl.minRiskPct || riskPct > cfg.sl.maxRiskPct) {
      return fail('risk', 'риск ' + riskPct.toFixed(2) + '% вне ' + cfg.sl.minRiskPct + '–' + cfg.sl.maxRiskPct + '%');
    }

    // 8. Место для хода и TP3.
    var tg = findTargets(ctx, dir, entry);
    var roomR = tg.nearest ? (tg.nearest.p - entry) * dir / R : Infinity;
    if (roomR < cfg.tp.tp3MinR) return fail('room', 'до ближайшей цели ' + roomR.toFixed(2) + 'R < ' + cfg.tp.tp3MinR + 'R');
    var lv = levelsFrom(dir, entry, sl, roomR, cfg);

    // 9. Score.
    var W = cfg.weights, P = cfg.penalties;
    var vr = disp ? volumeRatio(L, disp.start, disp.end, cfg.displacement.volLookback) : NaN;
    var volOk = isNum(vr) && vr >= cfg.displacement.volMult;
    var zonePts = !poi ? 0 : (poi.quality === 3 ? W.zoneObFvg : (poi.quality === 2 ? W.zoneOb : W.zoneFvg));
    var zoneName = !poi ? 'нет свежей зоны у разворота (не обязательна)' : (poi.quality === 3 ? 'OB + FVG' : (poi.quality === 2 ? 'только OB' : 'только FVG'));
    var roomPts = roomR >= 4 ? W.room4 : W.room3;
    var factors = [
      { key: 'trend', label: 'Тренд ' + H.tf + ' по направлению (' + bias.struct + ', EMA50)', pts: W.trend, max: W.trend, ok: true },
      { key: 'ema200', label: 'EMA200 ' + H.tf + ' подтверждает', pts: bias.emaAlign ? W.ema200 : 0, max: W.ema200, ok: bias.emaAlign },
      { key: 'pd', label: (dir === 1 ? 'Вход в Discount (ниже 50% диапазона ' : 'Вход в Premium (выше 50% диапазона ') + rng.tf + ')', pts: W.pd, max: W.pd, ok: true },
      { key: 'sweep', label: sw.level !== null ? 'Sweep: ' + liqLabel(sw.type, dir) : 'Sweep ликвидности', pts: sw.level !== null ? W.sweep : 0, max: W.sweep, ok: sw.level !== null },
      { key: 'structure', label: ev.type + ' на ' + L.tf + (disp ? ' с displacement ×' + disp.mult.toFixed(1) + ' ATR' : ''), pts: disp ? W.structure : 0, max: W.structure, ok: !!disp },
      { key: 'zone', label: 'Зона ' + M.tf + ': ' + zoneName, pts: zonePts, max: W.zoneObFvg, ok: !!poi },
      { key: 'ote', label: 'Вход в OTE 0.62–0.79', pts: ez.inOte ? W.ote : 0, max: W.ote, ok: ez.inOte },
      { key: 'volume', label: 'Объём displacement' + (isNum(vr) ? ' ×' + vr.toFixed(2) : ''), pts: volOk ? W.volume : 0, max: W.volume, ok: volOk },
      { key: 'room', label: 'Место до цели: ' + (isFinite(roomR) ? roomR.toFixed(1) + 'R' : 'нет сопротивления в окне'), pts: roomPts, max: W.room4, ok: true }
    ];
    var penalties = [];
    if (ctx.coin !== cfg.btcCoin && ctx.btc && ctx.btc.ih >= 0 && ctx.btc.im >= 0) {
      var bm = ctx.btc.memo, bx = ctx.btc;
      var b4 = memo(bm, 'bH' + bx.ih, function () { return computeBias(bx.H, bx.ih, cfg.windows.htf, cfg.minBars.htf, cfg); });
      var b1 = memo(bm, 'bM' + bx.im, function () { return computeBias(bx.M, bx.im, cfg.windows.mtf, cfg.minBars.mtf, cfg); });
      var against = b4.dir === -dir && b1.dir === -dir;
      penalties.push({ key: 'btc', label: 'BTC против сделки (' + bx.H.tf + ' и ' + bx.M.tf + ')', pts: against ? -P.btc : 0, active: against });
    }
    var lowv = lowVolatility(M, ctx.im, cfg);
    penalties.push({
      key: 'lowVol',
      label: lowv.known ? 'Низкая волатильность ' + M.tf + ' (ранг ATR ' + Math.round(lowv.rank * 100) + '%)' : 'Волатильность: мало истории для оценки',
      pts: lowv.low ? -P.lowVol : 0, active: lowv.low
    });
    var score = 0;
    factors.forEach(function (f) { score += f.pts; });
    penalties.forEach(function (p) { score += p.pts; });
    score = clamp(Math.round(score), 0, 100);

    r.cand = {
      sym: ctx.sym, coin: ctx.coin, dir: dir, side: dir === 1 ? 'LONG' : 'SHORT',
      tf: { ltf: L.tf, mtf: M.tf, htf: H.tf },
      T: ctx.T, triggerT: L.c[i].t, triggerClose: L.c[i].c,
      entry: entry, sl: sl, tp1: lv.tp1, tp2: lv.tp2, tp3: lv.tp3, R: R, riskPct: riskPct,
      roomR: roomR, tp3R: lv.tp3R,
      zone: ez.zone,
      poi: poi,
      sweep: { t: sw.t, ext: sw.ext, level: sw.level, type: sw.type },
      structure: { type: ev.type, level: ev.level, t: L.c[i].t },
      disp: disp ? { mult: disp.mult, pair: disp.pair, vr: vr } : null,
      ote: ez.ote, inOte: ez.inOte,
      target: tg.nearest ? { p: tg.nearest.p, type: tg.nearest.type, tf: tg.nearest.tf, name: TARGET_NAMES[tg.nearest.type] || tg.nearest.type } : null,
      bias: { struct: bias.struct, e50: bias.e50, e200: bias.e200, emaAlign: bias.emaAlign, eq: eq, lo: rng.lo, hi: rng.hi, pdTf: rng.tf },
      mode: cfg.strategy || 'strict',
      score: score, factors: factors, penalties: penalties
    };
    r.stage = 'ok';
    r.code = 'ok';
    r.reason = '';
    return r;
  }

  // Обзор для таблицы монет: bias старшего ТФ и наличие зоны интереса у текущей цены.
  function overview(ctx, price) {
    var cfg = ctx.cfg;
    var bias = computeBias(ctx.H, ctx.ih, cfg.windows.htf, cfg.minBars.htf, cfg);
    var o = { bias: bias, stage: 'flat', text: 'флэт ' + ctx.H.tf };
    if (bias.dir === 0) return o;
    if (bias.dir === -1 && ctx.longOnly) { o.stage = 'off'; o.text = 'только LONG'; return o; }
    var rng = pdRangeFor(ctx, bias);
    if (!rng) { o.stage = 'wait'; o.text = 'нет диапазона ' + (cfg.pdRange === 'mtf' ? ctx.M.tf : ctx.H.tf); return o; }
    var p = isNum(price) ? price : ctx.L.c[ctx.i].c;
    var inZone = bias.dir === 1 ? p < rng.eq : p > rng.eq;
    var poi = findPOI(ctx, bias.dir, p, ctx.T + 1, rng.eq);
    if (poi) { o.stage = 'poi'; o.text = 'у зоны ' + ctx.M.tf + ', ждём ' + (cfg.require.sweep ? 'sweep и CHoCH' : 'CHoCH/BOS'); o.poi = poi; }
    else if (inZone) { o.stage = 'wait'; o.text = 'в ' + (bias.dir === 1 ? 'Discount' : 'Premium') + ', нет зоны'; }
    else { o.stage = 'wait'; o.text = 'ждём ' + (bias.dir === 1 ? 'Discount' : 'Premium'); }
    return o;
  }

  return {
    TF_MS: TF_MS, DAY: DAY, tfMs: tfMs, isNum: isNum, clamp: clamp,
    lastClosedIndex: lastClosedIndex, firstIndexFrom: firstIndexFrom, indexOfTime: indexOfTime,
    emaArr: emaArr, atrArr: atrArr, trueRange: trueRange, findSwings: findSwings, swingsIn: swingsIn,
    buildSeries: buildSeries, structure: structure, displacement: displacement, volumeRatio: volumeRatio,
    findOBs: findOBs, findFVGs: findFVGs, zoneState: zoneState, fvgFill: fvgFill, intersect: intersect,
    equalLevels: equalLevels, prevDay: prevDay, computeBias: computeBias, swingRange: swingRange, makeContext: makeContext,
    findSweep: findSweep, findPOI: findPOI, entryZone: entryZone, findTargets: findTargets,
    lowVolatility: lowVolatility, levelsFrom: levelsFrom, detect: detect, overview: overview, obZone: obZone
  };
})();
