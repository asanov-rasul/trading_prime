/* SMC Signals — бэктест. Прогоняет по истории те же SMC.detect() и Signals.validate(), что и live-режим,
   и тот же симулятор Signals.step(). На шаге t используются только свечи, закрытые к моменту t.
   Расчёт идёт чанками через setTimeout и не блокирует интерфейс. */
'use strict';

var Backtest = (function () {
  var C = CONFIG, DAY = 86400000;
  var job = null;

  function yieldUI() { return new Promise(function (r) { setTimeout(r, 0); }); }

  // Воронка отбора: порядок стадий и подписи.
  var FUNNEL = [
    { key: 'steps', label: 'Закрытых свечей проверено' },
    { key: 'disp', label: 'с displacement', drop: ['noDisp'] },
    { key: 'bias', label: 'bias старшего ТФ по направлению', drop: ['bias', 'longOnly', 'dispDir'] },
    { key: 'break', label: 'со сломом CHoCH/BOS', drop: ['noBreak'] },
    { key: 'sweep', label: 'со sweep ликвидности', drop: ['sweep'] },
    { key: 'poi', label: 'у свежей зоны 1H в Discount/Premium', drop: ['poi'] },
    { key: 'entry', label: 'вход в Discount/Premium', drop: ['pd', 'entry'] },
    { key: 'risk', label: 'риск 0.25–3%', drop: ['risk'] },
    { key: 'room', label: 'место для хода ≥ 3R', drop: ['room'] },
    { key: 'score', label: 'score ≥ minScore', drop: ['score'] },
    { key: 'valid', label: 'прошли валидатор (опубликованы)', drop: ['validator'] }
  ];
  var REASON_TEXT = {
    sweep: 'нет sweep ликвидности перед сломом',
    poi: 'нет свежей зоны 1H у sweep',
    pd: 'вход вне Discount/Premium',
    risk: 'риск вне 0.25–3%',
    room: 'до ближайшей цели меньше 3R',
    score: 'score ниже порога'
  };

  function cancel() { if (job) job.cancel = true; }
  function isRunning() { return !!job; }

  // opts: {adapter, base, coins:[{coin,sym}], hasBtc, days, presetId, minScore, feePct, slipPct, longOnly}
  function run(opts, onProgress) {
    if (job) return Promise.reject(new Error('бэктест уже идёт'));
    job = { cancel: false };
    var my = job;
    return runInner(opts, onProgress, my).then(function (res) { job = null; return res; }, function (e) { job = null; throw e; });
  }

  function runInner(opts, onProgress, my) {
    var P = C.presets[opts.presetId] || C.presets.main;
    var ms = { L: SMC.tfMs(P.ltf), M: SMC.tfMs(P.mtf), H: SMC.tfMs(P.htf) };
    var nowT = Data.now();
    var endT = Math.floor((nowT - C.network.closeGraceMs) / ms.L) * ms.L - ms.L; // открытие последней закрытой свечи
    var startT = endT + ms.L - opts.days * DAY;
    var warm = {
      L: (C.windows.ltf + 60) * ms.L,
      M: Math.max((C.windows.mtf + 60) * ms.M, C.lowVol.days * DAY + 60 * ms.M),
      H: (C.windows.htf + C.emaWarmupBars) * ms.H
    };
    var btcSym = C.btcCoin + C.quote;
    var coins = opts.coins.slice();
    var tasks = [];
    coins.forEach(function (c) {
      ['L', 'M', 'H'].forEach(function (k) { tasks.push({ sym: c.sym, key: k }); });
    });
    var needBtc = opts.hasBtc && !coins.some(function (c) { return c.sym === btcSym; });
    if (needBtc) ['M', 'H'].forEach(function (k) { tasks.push({ sym: btcSym, key: k }); });
    var store = {}, done = 0, candles = 0, warnings = [];
    function prog(phase, frac, text) { if (onProgress) onProgress({ phase: phase, frac: frac, text: text }); }
    prog('load', 0, 'Загрузка истории…');

    var loads = tasks.map(function (t) {
      var tf = P[t.key === 'L' ? 'ltf' : (t.key === 'M' ? 'mtf' : 'htf')];
      var from = startT - warm[t.key];
      var to = endT + ms.L - SMC.tfMs(tf); // последняя свеча ТФ, закрытая к концу периода
      to = Math.floor(to / SMC.tfMs(tf)) * SMC.tfMs(tf);
      return Data.loadHistory(opts.adapter, opts.base, t.sym, tf, from, to, function () {
        if (my.cancel) throw new Error('отменено');
      }).then(function (rows) {
        if (my.cancel) throw new Error('отменено');
        store[t.sym] = store[t.sym] || {};
        store[t.sym][t.key] = rows;
        done++;
        candles += rows.length;
        prog('load', done / tasks.length, 'История: ' + done + '/' + tasks.length + ' рядов, ' + candles.toLocaleString('ru-RU') + ' свечей');
      }, function (e) {
        if (my.cancel) throw new Error('отменено');
        store[t.sym] = store[t.sym] || {};
        store[t.sym][t.key] = null;
        done++;
        warnings.push(t.sym + ' ' + tf + ': ' + e.message);
        prog('load', done / tasks.length, 'История: ' + done + '/' + tasks.length);
      });
    });

    return Promise.all(loads).then(function () {
      if (my.cancel) throw new Error('отменено');
      var btc = null, btcMemo = new Map();
      var bs = store[btcSym];
      if (opts.hasBtc && bs && bs.M && bs.H && bs.M.length && bs.H.length) {
        btc = { M: SMC.buildSeries(bs.M, P.mtf, C), H: SMC.buildSeries(bs.H, P.htf, C) };
      } else if (opts.hasBtc) warnings.push('нет истории BTC — фильтр по BTC отключён в прогоне');
      var all = [], funnel = {}, rejects = {}, covered = [];
      FUNNEL.forEach(function (f) { funnel[f.key] = 0; });
      var totalSteps = 0;
      var series = coins.map(function (c) {
        var s = store[c.sym];
        if (!s || !s.L || !s.M || !s.H || s.L.length < C.windows.ltf || s.M.length < C.minBars.mtf || s.H.length < C.minBars.htf) {
          warnings.push(c.coin + ': мало истории для прогона');
          return null;
        }
        var L = SMC.buildSeries(s.L, P.ltf, C);
        var i0 = Math.max(SMC.firstIndexFrom(s.L, startT), C.windows.ltf - 1);
        var i1 = SMC.lastClosedIndex(s.L, ms.L, endT + ms.L);
        if (i1 >= i0) totalSteps += i1 - i0 + 1;
        return { coin: c.coin, sym: c.sym, L: L, M: SMC.buildSeries(s.M, P.mtf, C), H: SMC.buildSeries(s.H, P.htf, C), i0: i0, i1: i1 };
      });
      var stepsDone = 0, lastYield = Date.now();
      var btcForCtx = btc;
      var coinIdx = 0;

      function simulateCoin(S) {
        var memo = new Map(), st = { open: null, lastSl: null }, sigs = [];
        var state = {
          hasOpen: function () { return !!st.open; },
          lastSlT: function () { return st.lastSl; }
        };
        var feeF = opts.feePct / 100, slipF = opts.slipPct / 100;
        var i = S.i0;
        var btcHere = btcForCtx; // для самого BTC штраф не применяется (проверка в detect)
        function rej(key, text) {
          rejects[key] = rejects[key] || { text: text, n: 0 };
          rejects[key].n++;
        }
        function loop() {
          while (i <= S.i1) {
            if (my.cancel) return Promise.reject(new Error('отменено'));
            var cd = S.L.c[i];
            if (st.open) {
              Signals.step(st.open, cd, C);
              if (!Signals.isOpen(st.open)) {
                if (st.open.outcome === 'sl') st.lastSl = st.open.closedT;
                sigs.push(st.open);
                st.open = null;
              }
            }
            var ctx = SMC.makeContext({
              sym: S.sym, coin: S.coin, L: S.L, M: S.M, H: S.H, i: i, btc: btcHere, cfg: C,
              longOnly: opts.longOnly, memo: memo, btcMemo: btcMemo
            });
            var res = SMC.detect(ctx);
            if (res.code !== 'data') funnel.steps++;
            if (!res.cand) {
              var code = res.code;
              if (code !== 'data') {
                funnelDrop(code);
                if (REASON_TEXT[code]) rej(code, REASON_TEXT[code]);
              }
            } else if (res.cand.score < opts.minScore) {
              funnelDrop('score');
              rej('score', REASON_TEXT.score);
            } else {
              var raw = { L: S.L.c, M: S.M.c, H: S.H.c, ms: ms, evalT: ctx.T, price: cd.c };
              var v = Signals.validate(res.cand, raw, state);
              if (!v.ok) {
                funnelDrop('validator');
                rej('v:' + v.code + ':' + v.reason, 'валидатор: ' + v.reason);
              } else {
                st.open = Signals.create(res.cand, { fee: feeF, slip: slipF, ltfMs: ms.L, source: opts.adapter.id, preset: P.id });
              }
            }
            i++;
            stepsDone++;
            if ((stepsDone & 63) === 0 && Date.now() - lastYield > C.backtest.chunkMs) {
              lastYield = Date.now();
              prog('sim', totalSteps ? stepsDone / totalSteps : 1, 'Прогон ' + S.coin + ': ' + Math.round(100 * stepsDone / Math.max(1, totalSteps)) + '%');
              return yieldUI().then(loop);
            }
          }
          if (st.open) sigs.push(st.open);
          return Promise.resolve(sigs);
        }
        return loop();
      }
      // Учёт отсева: стадия code «выбывает» на соответствующем шаге воронки.
      var dropCount = {};
      function funnelDrop(code) { dropCount[code] = (dropCount[code] || 0) + 1; }

      function nextCoin() {
        if (coinIdx >= series.length) return Promise.resolve();
        var S = series[coinIdx++];
        if (!S || S.i1 < S.i0) return nextCoin();
        covered.push(S.coin);
        return simulateCoin(S).then(function (sigs) {
          sigs.forEach(function (s) { all.push(s); });
          return yieldUI().then(nextCoin);
        });
      }
      prog('sim', 0, 'Прогон стратегии…');
      return nextCoin().then(function () {
        // Воронка: от общего числа шагов последовательно вычитаем отсев по стадиям.
        var left = funnel.steps, fun = [], mtfName = P.mtf.toUpperCase();
        function tfText(t) { return t.replace(/1H/g, mtfName); }
        FUNNEL.forEach(function (f, k) {
          if (k > 0) (f.drop || []).forEach(function (code) { left -= (dropCount[code] || 0); });
          fun.push({ label: tfText(f.label), n: left });
        });
        Object.keys(rejects).forEach(function (key) { rejects[key].text = tfText(rejects[key].text); });
        var meta = {
          presetId: P.id, presetName: P.name, days: opts.days, startT: startT, endT: endT + ms.L,
          minScore: opts.minScore, feePct: opts.feePct, slipPct: opts.slipPct, longOnly: !!opts.longOnly,
          coins: covered, source: opts.adapter.name, ts: Date.now(), tf: P
        };
        var result = aggregate(all, meta);
        result.funnel = fun;
        result.rejects = Object.keys(rejects).map(function (k) { return { text: rejects[k].text, n: rejects[k].n }; })
          .sort(function (a, b) { return b.n - a.n; });
        result.warnings = warnings;
        if (P.id === 'main' && covered.length) {
          Signals.Calib.update(all, covered, { ts: meta.ts, days: opts.days, minScore: opts.minScore, preset: P.id });
          result.calibrated = true;
        }
        savePresetCompare(result);
        prog('done', 1, 'Готово');
        return result;
      });
    });
  }

  function aggregate(all, meta) {
    all.sort(function (a, b) { return a.createdT - b.createdT; });
    var summary = Signals.stats(all);
    var byCoin = meta.coins.map(function (coin) {
      return { coin: coin, s: Signals.stats(all.filter(function (x) { return x.coin === coin; })) };
    });
    var byBucket = C.calibration.buckets.map(function (b) {
      return { bucket: b, label: Signals.Calib.bucketLabel(b), s: Signals.stats(all.filter(function (x) { return Signals.Calib.bucketOf(x.score) === b; })) };
    });
    var splitT = meta.startT + C.backtest.splitIn * (meta.endT - meta.startT);
    var split = {
      splitT: splitT,
      inS: Signals.stats(all.filter(function (x) { return x.createdT < splitT; })),
      outS: Signals.stats(all.filter(function (x) { return x.createdT >= splitT; }))
    };
    return { meta: meta, signals: all, summary: summary, byCoin: byCoin, byBucket: byBucket, split: split };
  }

  function savePresetCompare(result) {
    var list = Data.Store.get(C.storage.presets, []);
    if (!Array.isArray(list)) list = [];
    var o = result.split.outS, m = result.meta;
    list = list.filter(function (x) { return !(x && x.presetId === m.presetId && x.days === m.days); });
    list.push({
      presetId: m.presetId, presetName: m.presetName, days: m.days, ts: m.ts, minScore: m.minScore,
      n: o.n, winRate: o.winRate, avgR: o.avgR, pf: o.pf, sumR: o.sumR
    });
    list.sort(function (a, b) { return b.ts - a.ts; });
    Data.Store.set(C.storage.presets, list.slice(0, 12));
  }

  // CSV со всеми проверенными сигналами.
  function toCSV(signals) {
    function q(v) {
      var s = v === null || v === undefined ? '' : String(v);
      return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }
    function num(x, d) { return (typeof x === 'number' && isFinite(x)) ? x.toFixed(d) : ''; }
    var head = ['created_local', 'coin', 'side', 'score', 'entry', 'sl', 'tp1', 'tp2', 'tp3', 'status', 'outcome', 'success', 'result_R', 'filled_local', 'closed_local'];
    var rows = [head.join(',')];
    function dt(t) { return t ? new Date(t).toLocaleString('ru-RU') : ''; }
    signals.forEach(function (s) {
      var dec = s.entry >= 100 ? 2 : (s.entry >= 1 ? 4 : 6);
      rows.push([
        q(dt(s.createdT)), q(s.coin), s.side, s.score,
        num(s.entry, dec), num(s.sl, dec), num(s.tp1, dec), num(s.tp2, dec), num(s.tp3, dec),
        s.status, q(Signals.OUTCOME[s.outcome] || ''), s.status === 'closed' ? (s.tpHit[0] ? '1' : '0') : '',
        num(s.resultR, 3), q(dt(s.filledT)), q(dt(s.closedT))
      ].join(','));
    });
    return '﻿' + rows.join('\n');
  }

  return { run: run, cancel: cancel, isRunning: isRunning, toCSV: toCSV, aggregate: aggregate, FUNNEL: FUNNEL };
})();
