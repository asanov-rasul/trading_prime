/* SMC Signals — запуск приложения: настройки, live-цикл (лента → детектор → валидатор → журнал),
   догрузка пропущенных свечей, бэктест и калибровка, звук, самотесты. */
'use strict';

var App = (function () {
  var C = CONFIG, Store = Data.Store;
  var LOG_STAGES = { sweep: 1, poi: 1, pd: 1, entry: 1, risk: 1, room: 1 };

  var app = {
    settings: null, feed: null, series: {}, overview: {}, logs: [], selfTest: null, ready: false,
    calc: null, bt: null
  };
  var feed = null;

  // ---------- настройки ----------
  function defaults() {
    return {
      source: 'auto', mode: 'both', minScore: C.minScore, riskPct: C.calculator.riskPct,
      feeFutures: C.fees.futures, feeSpot: C.fees.spot, slipPct: C.slippagePct,
      symbols: C.symbols.slice(), sound: true
    };
  }
  function numIn(v, lo, hi, def) { return (typeof v === 'number' && isFinite(v) && v >= lo && v <= hi) ? v : def; }
  function sanitize(s) {
    var d = defaults(), o = {};
    o.source = (s.source === 'auto' || Data.ADAPTERS[s.source]) ? s.source : d.source;
    o.mode = s.mode === 'long' ? 'long' : 'both';
    o.minScore = Math.round(numIn(s.minScore, 60, 100, d.minScore));
    o.riskPct = numIn(s.riskPct, 0.05, 20, d.riskPct);
    o.feeFutures = numIn(s.feeFutures, 0, 1, d.feeFutures);
    o.feeSpot = numIn(s.feeSpot, 0, 1, d.feeSpot);
    o.slipPct = numIn(s.slipPct, 0, 2, d.slipPct);
    o.symbols = Array.isArray(s.symbols) ? s.symbols.filter(function (x) { return typeof x === 'string' && /^[A-Z0-9]{2,15}$/.test(x); }) : d.symbols;
    if (!o.symbols.length) o.symbols = d.symbols;
    o.sound = s.sound !== false;
    return o;
  }
  function loadSettings() {
    var s = Store.get(C.storage.settings, {});
    return sanitize(s && typeof s === 'object' ? s : {});
  }
  function saveSettings() { Store.set(C.storage.settings, app.settings); }
  function marketFee() {
    var m = feed && feed.status.market;
    return m === 'spot' ? app.settings.feeSpot : app.settings.feeFutures;
  }

  // ---------- лог ----------
  function log(level, text) {
    app.logs.push({ t: Date.now(), level: level, text: String(text) });
    if (app.logs.length > C.logMax) app.logs.splice(0, app.logs.length - C.logMax);
    Store.set(C.storage.log, app.logs.slice(-200));
    if (typeof console !== 'undefined' && level !== 'debug') console.log('[SMC] ' + text);
  }
  app.clearLog = function () { app.logs = []; Store.remove(C.storage.log); };

  // ---------- серии и контекст ----------
  function coinOf(sym) { return sym.slice(0, sym.length - C.quote.length); }
  function isActive(sym) { return !!feed && feed.coins.some(function (c) { return c.sym === sym; }); }
  function buildAllSeries() {
    var out = {};
    Object.keys(feed.raw).forEach(function (sym) {
      var r = feed.raw[sym];
      if (!r || !r.L || !r.L.length) return;
      out[sym] = {
        L: SMC.buildSeries(r.L, C.timeframes.ltf, C),
        M: r.M && r.M.length ? SMC.buildSeries(r.M, C.timeframes.mtf, C) : null,
        H: r.H && r.H.length ? SMC.buildSeries(r.H, C.timeframes.htf, C) : null
      };
    });
    app.series = out;
  }
  function makeCtx(sym, idx) {
    var S = app.series[sym], B = feed.hasBtc ? app.series[feed.btcSym] : null;
    return SMC.makeContext({
      sym: sym, coin: coinOf(sym), L: S.L, M: S.M, H: S.H, i: idx,
      btc: (B && B.M && B.H) ? { M: B.M, H: B.H } : null,
      cfg: C, longOnly: app.settings.mode === 'long', memo: null
    });
  }
  function updateOverviews() {
    var out = {};
    feed.coins.forEach(function (c) {
      var S = app.series[c.sym];
      if (!S || !S.M || !S.H || S.L.c.length < 3) return;
      try { out[c.sym] = SMC.overview(makeCtx(c.sym, S.L.c.length - 1), app.priceOf(c.sym)); } catch (e) { /* обзор не критичен */ }
    });
    app.overview = out;
  }

  // ---------- обработка закрытых свечей ----------
  // Для каждой новой закрытой свечи: сопровождение открытых сигналов, затем детектор и валидатор.
  function processSymbol(sym, newCount, live) {
    var S = app.series[sym];
    if (!S || !S.L) return [];
    var Lc = S.L.c, n = Lc.length, created = [];
    var start = Math.max(0, n - newCount);
    var canDetect = isActive(sym) && S.M && S.H;
    var detectFrom = Math.max(start, n - C.live.catchUpBars);
    var coin = coinOf(sym);
    for (var idx = start; idx < n; idx++) {
      var cd = Lc[idx];
      Signals.Journal.openFor(sym).forEach(function (sig) {
        var before = sig.status;
        Signals.step(sig, cd, C);
        if (before === 'pending' && sig.status === 'active') log('info', coin + ' ' + sig.side + ': вход по ' + UI.fP(sig.entry));
        if (!Signals.isOpen(sig)) {
          Signals.Journal.noteClosed(sig);
          log('info', coin + ' ' + sig.side + ': ' + Signals.statusText(sig) + (sig.resultR !== null ? ' (' + (sig.resultR >= 0 ? '+' : '') + sig.resultR.toFixed(2) + 'R)' : ''));
        }
      });
      if (!canDetect || idx < detectFrom) continue;
      var ctx = makeCtx(sym, idx), res;
      try { res = SMC.detect(ctx); } catch (e) { log('error', coin + ': ошибка детектора — ' + e.message); continue; }
      var when = UI.fDT(ctx.T);
      if (!res.cand) {
        if (LOG_STAGES[res.code]) log('debug', coin + ' ' + when + ': кандидат ' + (res.dir === 1 ? 'LONG' : 'SHORT') + ' отброшен детектором — ' + res.reason);
        continue;
      }
      var cand = res.cand;
      if (cand.score < app.settings.minScore) {
        log('debug', coin + ' ' + when + ': ' + cand.side + ' score ' + cand.score + ' ниже порога ' + app.settings.minScore);
        continue;
      }
      var latest = live && idx === n - 1;
      var raw = {
        L: Lc, M: S.M.c, H: S.H.c, ms: { L: S.L.ms, M: S.M.ms, H: S.H.ms }, evalT: ctx.T,
        price: latest ? app.priceOf(sym) : cd.c
      };
      var v;
      try { v = Signals.validate(cand, raw, Signals.Journal); } catch (e2) { v = { ok: false, reason: 'ошибка валидатора: ' + e2.message }; }
      if (!v.ok) {
        log('reject', coin + ' ' + when + ': ' + cand.side + ' (score ' + cand.score + ') отклонён валидатором — ' + v.reason);
        continue;
      }
      var sig = Signals.create(cand, {
        fee: marketFee() / 100, slip: app.settings.slipPct / 100, ltfMs: S.L.ms,
        source: feed.status.source, preset: 'main', late: !latest
      });
      if (Signals.Journal.add(sig)) {
        created.push(sig);
        log('signal', coin + ' ' + when + ': новый сигнал ' + sig.side + ', score ' + sig.score + ', вход ' + UI.fP(sig.entry) + ', SL ' + UI.fP(sig.sl) + ', TP3 ' + UI.fP(sig.tp3));
      }
    }
    return created;
  }
  // Сигналы, найденные задним числом и уже завершившиеся до показа, в журнал не попадают.
  function dropFinishedLate(created) {
    var fresh = [];
    created.forEach(function (sig) {
      if (sig.late && !Signals.isOpen(sig)) {
        Signals.Journal.remove(sig.id);
        log('info', sig.coin + ': сигнал от ' + UI.fDT(sig.createdT) + ' найден при догрузке, но уже завершился (' + Signals.statusText(sig) + ') — не показан');
      } else fresh.push(sig);
    });
    return fresh;
  }
  function announce(list) {
    list.forEach(function (sig) {
      if (sig.late) return;
      UI.toast('Новый сигнал: ' + sig.coin + ' ' + sig.side + ' · score ' + sig.score, 'good');
      if (app.settings.sound) app.beep();
    });
  }

  // Сопровождение сигналов из прошлых сессий по пропущенным свечам.
  function replayOpen() {
    var open = Signals.Journal.openFor(null);
    var chain = Promise.resolve();
    open.forEach(function (sig) {
      chain = chain.then(function () {
        var S = app.series[sig.sym];
        if (!S || !S.L || !S.L.c.length) return null;
        var Lc = S.L.c, ms = S.L.ms;
        var stopIdx = Math.max(0, Lc.length - C.live.catchUpBars) - 1; // дальше свечи обработает догрузка
        var firstT = Lc[0].t;
        var pre = Promise.resolve([]);
        if (sig.lastT + ms < firstT) {
          var bars = (firstT - sig.lastT) / ms;
          if (bars > C.live.replayMaxBars) {
            sig.status = 'expired'; sig.outcome = 'expired'; sig.closedT = Data.now();
            sig.note = 'сопровождение прервано: нет истории за ' + Math.round(bars) + ' свечей';
            log('warn', sig.coin + ': ' + sig.note);
            return null;
          }
          pre = Data.fetchRange(feed.adapter, feed.base, sig.sym, C.timeframes.ltf, sig.lastT + ms, firstT - ms).then(null, function (e) {
            log('warn', sig.coin + ': не удалось догрузить историю для сопровождения — ' + e.message);
            return [];
          });
        }
        return pre.then(function (older) {
          older.forEach(function (cd) { if (Signals.isOpen(sig)) Signals.step(sig, cd, C); });
          for (var k = 0; k <= stopIdx && Signals.isOpen(sig); k++) Signals.step(sig, Lc[k], C);
          if (!Signals.isOpen(sig)) {
            Signals.Journal.noteClosed(sig);
            log('info', sig.coin + ' ' + sig.side + ' (из прошлой сессии): ' + Signals.statusText(sig));
          }
        });
      });
    });
    return chain;
  }

  // ---------- хуки ленты ----------
  var hooks = {
    getSettings: function () { return app.settings; },
    onStatus: function (st) { UI.renderStatus(st); },
    onLog: function (level, text) { log(level, text); },
    onReady: function () {
      buildAllSeries();
      replayOpen().then(function () {
        var created = [];
        Object.keys(app.series).forEach(function (sym) {
          created = created.concat(processSymbol(sym, C.live.catchUpBars, true));
        });
        created = dropFinishedLate(created);
        updateOverviews();
        Signals.Journal.save();
        app.ready = true;
        announce(created);
        UI.update();
      }).then(null, function (e) { log('error', 'Ошибка запуска: ' + e.message); });
    },
    onUpdate: function (info) {
      if (!app.ready) return;
      buildAllSeries();
      var created = [];
      Object.keys(info.closedNew || {}).forEach(function (sym) {
        var n = info.closedNew[sym];
        if (n > 0) created = created.concat(processSymbol(sym, n, true));
      });
      created = dropFinishedLate(created);
      updateOverviews();
      Signals.Journal.save();
      announce(created);
      if (UI.current() === 'best' || UI.current() === 'signals') UI.update();
    }
  };

  // ---------- данные для интерфейса ----------
  app.feedStatus = function () { return feed ? feed.status : { state: 'idle', notes: [] }; };
  app.activeCoins = function () { return feed ? feed.coins.slice() : []; };
  app.priceOf = function (sym) {
    if (feed && feed.prices[sym] > 0) return feed.prices[sym];
    var r = feed && feed.raw[sym];
    if (r && r.formL) return r.formL.c;
    if (r && r.L && r.L.length) return r.L[r.L.length - 1].c;
    return NaN;
  };
  app.candlesFor = function (sym) {
    var r = feed && feed.raw[sym];
    if (!r || !r.L) return [];
    var arr = r.L.slice(-120);
    if (r.formL) arr.push(r.formL);
    return arr;
  };
  app.provisionalOf = function (sig) {
    var r = feed && feed.raw[sig.sym];
    return r && r.formL ? Signals.provisional(sig, r.formL) : sig;
  };
  app.openSignals = function () {
    return Signals.Journal.openFor(null).filter(function (s) { return Signals.isOpen(app.provisionalOf(s)); })
      .sort(function (a, b) { return (b.score - a.score) || ((b.roomR === Infinity ? 99 : b.roomR) - (a.roomR === Infinity ? 99 : a.roomR)); });
  };
  app.bestSignal = function () { var l = app.openSignals(); return l.length ? l[0] : null; };
  app.coinRows = function () {
    if (!feed) return [];
    var nowT = Data.now(), ms = SMC.tfMs(C.timeframes.ltf);
    return feed.coins.map(function (c) {
      var ov = app.overview[c.sym], open = Signals.Journal.openFor(c.sym)[0];
      var row = { coin: c.coin, replaces: c.replaces, price: app.priceOf(c.sym), bias: ov ? ov.bias.dir : 0, status: '—', statusCls: 'muted', score: null };
      var ls = Signals.Journal.lastSlT(c.sym);
      if (open) {
        row.status = Signals.statusText(app.provisionalOf(open));
        row.statusCls = open.status === 'active' ? 'live' : 'wait';
        row.score = open.score;
      } else if (ls !== null && nowT - ls <= C.lifecycle.cooldownBars * ms) {
        row.status = 'пауза после SL';
      } else if (ov) {
        row.status = ov.text;
        row.statusCls = ov.stage === 'poi' ? 'mid' : 'muted';
      } else if (!app.ready) row.status = 'загрузка…';
      return row;
    });
  };

  // ---------- навигация ----------
  app.navigate = function (name) { UI.show(name); };

  // ---------- калькулятор ----------
  function calcDefaults() {
    return {
      sigId: '', mode: 'risk', deposit: C.calculator.deposit, riskPct: app.settings.riskPct, amount: 20, dir: 1,
      entry: NaN, sl: NaN, tp1: NaN, tp2: NaN, tp3: NaN,
      fr1: C.tp.fractions[0] * 100, fr2: C.tp.fractions[1] * 100, fr3: C.tp.fractions[2] * 100,
      leverage: C.calculator.leverage, feePct: C.fees.futures, slipPct: app.settings.slipPct,
      minOrder: C.calculator.minOrder, mmrPct: C.calculator.mmrPct, probPct: NaN, coin: ''
    };
  }
  app.calcSignals = function () {
    var open = Signals.Journal.openFor(null), rest = Signals.Journal.list.filter(function (s) { return !Signals.isOpen(s); });
    return open.concat(rest.slice(0, 30));
  };
  app.calcSignalCoin = function () { return app.calc.coin; };
  app.fillCalcFromSignal = function (id) {
    var sig = Signals.Journal.list.filter(function (s) { return s.id === id; })[0];
    if (!sig) return;
    var s = app.calc, rp = UI.roundP;
    s.sigId = id; s.dir = sig.dir; s.coin = sig.coin;
    s.entry = rp(sig.entry); s.sl = rp(sig.sl); s.tp1 = rp(sig.tp1); s.tp2 = rp(sig.tp2); s.tp3 = rp(sig.tp3);
    s.feePct = sig.fee * 100;
    s.slipPct = sig.slip * 100;
    var acc = Signals.Calib.accuracy(sig.coin, sig.score);
    s.probPct = acc ? Math.round(acc.value * 1000) / 10 : NaN;
  };
  app.toCalc = function (id) { app.fillCalcFromSignal(id); UI.show('calc'); };

  // ---------- бэктест ----------
  function btDefaults() {
    return {
      params: { coin: 'all', days: C.backtest.defaultDays, presetId: C.defaultPreset, minScore: app.settings.minScore, feePct: C.fees.futures, slipPct: app.settings.slipPct },
      running: false, progress: { frac: 0, text: '' }, result: null, error: ''
    };
  }
  app.runBacktest = function () {
    var bt = app.bt, p = bt.params;
    if (bt.running) return;
    if (!feed || !feed.adapter || !feed.coins.length) { UI.toast('Нет подключения к источнику данных', 'bad'); return; }
    if (!(p.minScore >= 60 && p.minScore <= 100)) p.minScore = app.settings.minScore;
    if (!(p.feePct >= 0)) p.feePct = marketFee();
    if (!(p.slipPct >= 0)) p.slipPct = app.settings.slipPct;
    var coins = p.coin === 'all' ? feed.coins.slice() : feed.coins.filter(function (c) { return c.coin === p.coin; });
    if (!coins.length) coins = feed.coins.slice();
    bt.running = true; bt.error = ''; bt.progress = { frac: 0, text: 'Старт…' };
    if (UI.current() === 'backtest') UI.update('backtest', true);
    log('info', 'Бэктест: ' + C.presets[p.presetId].name + ', ' + p.days + ' дн, монет ' + coins.length + ', minScore ' + p.minScore);
    Backtest.run({
      adapter: feed.adapter, base: feed.base, coins: coins, hasBtc: feed.hasBtc, days: p.days, presetId: p.presetId,
      minScore: p.minScore, feePct: p.feePct, slipPct: p.slipPct, longOnly: app.settings.mode === 'long'
    }, function (pr) {
      bt.progress = pr;
      if (UI.current() === 'backtest') UI.updateBtProgress();
    }).then(function (res) {
      bt.running = false; bt.result = res; bt.progress = { frac: 1, text: 'Готово: сигналов ' + res.summary.signals + ', сделок ' + res.summary.n };
      log('info', 'Бэктест завершён: сигналов ' + res.summary.signals + ', сделок ' + res.summary.n + (res.summary.n ? ', успешных ' + Math.round(res.summary.winRate * 100) + '%, средний ' + res.summary.avgR.toFixed(2) + 'R' : ''));
      UI.toast('Бэктест завершён', 'good');
      UI.update(UI.current(), true);
    }, function (e) {
      bt.running = false; bt.error = e.message || String(e); bt.progress = { frac: 0, text: '' };
      log('warn', 'Бэктест остановлен: ' + bt.error);
      if (UI.current() === 'backtest') UI.update('backtest', true);
    });
  };
  app.cancelBacktest = function () { Backtest.cancel(); };
  app.calibrate = function () {
    var p = app.bt.params;
    p.coin = 'all'; p.days = C.calibration.days; p.presetId = 'main'; p.minScore = app.settings.minScore;
    p.feePct = marketFee(); p.slipPct = app.settings.slipPct;
    UI.show('backtest');
    app.runBacktest();
  };
  app.exportCSV = function () {
    var res = app.bt.result;
    if (!res) return;
    try {
      var blob = new Blob([Backtest.toCSV(res.signals)], { type: 'text/csv;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      var d = new Date();
      a.href = url;
      a.download = 'smc-backtest-' + res.meta.presetId + '-' + res.meta.days + 'd-' + d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0') + '.csv';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1000);
    } catch (e) { UI.toast('Не удалось сохранить CSV: ' + e.message, 'bad'); }
  };

  // ---------- настройки ----------
  app.updateSettings = function (patch, restart) {
    var next = {};
    Object.keys(app.settings).forEach(function (k) { next[k] = app.settings[k]; });
    Object.keys(patch).forEach(function (k) { next[k] = patch[k]; });
    app.settings = sanitize(next);
    saveSettings();
    if (restart) restartFeed();
    else if (feed && app.ready) { updateOverviews(); }
  };
  app.setCoins = function (text) {
    var list = String(text || '').toUpperCase().split(/[\s,;]+/).map(function (x) {
      x = x.trim();
      if (x.length > C.quote.length && x.slice(-C.quote.length) === C.quote) x = x.slice(0, -C.quote.length);
      return x;
    }).filter(function (x, k, arr) { return /^[A-Z0-9]{2,15}$/.test(x) && arr.indexOf(x) === k; });
    if (!list.length) { UI.toast('Список монет пуст', 'bad'); return; }
    app.updateSettings({ symbols: list.slice(0, 20) }, true);
    UI.toast('Список монет применён', 'good');
  };
  function restartFeed() {
    app.ready = false;
    app.series = {};
    app.overview = {};
    feed.setExtra(Signals.Journal.openFor(null).map(function (s) { return s.sym; }));
    feed.start(0);
  }
  app.resetJournal = function () { Signals.Journal.clear(); UI.toast('Журнал очищен'); UI.update(UI.current(), true); };
  app.clearCache = function () { Data.Cache.clear().then(function () { UI.toast('Кэш истории очищен'); }); };
  app.resetAll = function () {
    Object.keys(C.storage).forEach(function (k) { if (k !== 'idbName' && k !== 'idbStore') Store.remove(C.storage[k]); });
    Data.Cache.clear().then(function () { location.reload(); });
  };

  // ---------- звук ----------
  var actx = null;
  function audio() {
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      if (!actx) actx = new AC();
      if (actx.state === 'suspended') actx.resume();
      return actx;
    } catch (e) { return null; }
  }
  app.beep = function () {
    var a = audio();
    if (!a) return;
    try {
      [0, 0.18].forEach(function (off, k) {
        var o = a.createOscillator(), g = a.createGain(), t = a.currentTime + off;
        o.type = 'sine';
        o.frequency.value = k ? 1175 : 880;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
        o.connect(g); g.connect(a.destination);
        o.start(t); o.stop(t + 0.18);
      });
    } catch (e) { /* звук не критичен */ }
  };

  // =====================================================================================
  // САМОТЕСТЫ на синтетических свечах (console.assert). Итог: «Self-test: OK».
  // =====================================================================================
  function runSelfTests() {
    var results = [];
    function test(name, fn) {
      var ok = false, err = '';
      try { ok = !!fn(); } catch (e) { ok = false; err = e.message; }
      console.assert(ok, 'Self-test FAILED: ' + name + (err ? ' — ' + err : ''));
      results.push({ name: name, ok: ok });
    }
    var M15 = 900000, H1 = 3600000;
    function mk(rows, step, t0) {
      return rows.map(function (r, k) { return { t: (t0 || 0) + k * (step || M15), o: r[0], h: r[1], l: r[2], c: r[3], v: r[4] === undefined ? 100 : r[4], closed: true }; });
    }
    function series(cds, atrVal) {
      var a = new Float64Array(cds.length);
      for (var k = 0; k < a.length; k++) a[k] = atrVal;
      return { c: cds, atr: a, ms: M15 };
    }
    function rnd(seed) { var x = seed; return function () { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; }; }
    function walk(n, seed) {
      var r = rnd(seed), p = 100, out = [];
      for (var k = 0; k < n; k++) {
        var o = p, c = p * (1 + (r() - 0.5) * 0.02);
        var hi = Math.max(o, c) * (1 + r() * 0.006), lo = Math.min(o, c) * (1 - r() * 0.006);
        out.push([o, hi, lo, c, 50 + r() * 100]);
        p = c;
      }
      return mk(out);
    }
    function sig(dir) {
      var e = 100, sl = dir === 1 ? 98 : 102, lv = SMC.levelsFrom(dir, e, sl, 4, C);
      return Signals.create({
        sym: 'TESTUSDT', coin: 'TEST', dir: dir, side: dir === 1 ? 'LONG' : 'SHORT', tf: C.timeframes, T: M15, triggerT: 0,
        entry: e, sl: sl, tp1: lv.tp1, tp2: lv.tp2, tp3: lv.tp3, R: 2, riskPct: 2, roomR: 4, tp3R: lv.tp3R,
        zone: { bot: 99, top: 101, kind: 'ob', t: 0 }, poi: null, sweep: null, structure: null, ote: null, inOte: false,
        target: null, bias: null, disp: null, score: 80, factors: [], penalties: []
      }, { fee: 0.0005, slip: 0.0003, ltfMs: M15 });
    }

    test('Свинг подтверждается только после N свечей справа (нет заглядывания в будущее)', function () {
      var hs = [2, 3, 4, 6, 5.5, 5, 4, 3];
      var c = mk(hs.map(function (x) { return [x - 0.5, x, x - 2, x - 0.8]; }));
      var a = SMC.findSwings(c.slice(0, 6), 3).highs.length === 0;
      var b = SMC.findSwings(c.slice(0, 7), 3).highs;
      return a && b.length === 1 && b[0].i === 3 && b[0].conf === 6;
    });
    test('Свинги на префиксе совпадают с полной историей (без перерисовки)', function () {
      var c = walk(400, 7), full = SMC.findSwings(c, 3), ok = true;
      [60, 123, 250, 399].forEach(function (cut) {
        var pre = SMC.findSwings(c.slice(0, cut + 1), 3);
        var fh = full.highs.filter(function (s) { return s.conf <= cut; }), fl = full.lows.filter(function (s) { return s.conf <= cut; });
        if (pre.highs.length !== fh.length || pre.lows.length !== fl.length) ok = false;
        pre.highs.forEach(function (s, k) { if (s.i !== fh[k].i || s.p !== fh[k].p) ok = false; });
        pre.lows.forEach(function (s, k) { if (s.i !== fl[k].i || s.p !== fl[k].p) ok = false; });
      });
      return ok && full.highs.length > 10;
    });
    test('Бычий FVG: максимум 1-й свечи ниже минимума 3-й', function () {
      var c = mk([[10, 11, 9.5, 10.8], [10.8, 13, 10.7, 12.9], [12.9, 13.5, 11.6, 13.2]]);
      var f = SMC.findFVGs(series(c, 0.5), 0, 2, 1, C);
      return f.length === 1 && f[0].bot === 11 && f[0].top === 11.6 && f[0].formed === 2;
    });
    test('Медвежий FVG: минимум 1-й свечи выше максимума 3-й', function () {
      var c = mk([[13, 13.5, 12, 12.2], [12.2, 12.3, 10, 10.1], [10.1, 11.4, 9.8, 10]]);
      var f = SMC.findFVGs(series(c, 0.5), 0, 2, -1, C);
      return f.length === 1 && f[0].bot === 11.4 && f[0].top === 12 && SMC.findFVGs(series(c, 0.5), 0, 2, 1, C).length === 0;
    });
    test('FVG меньше 0.1×ATR отбрасывается, заполнение > 50% считается верно', function () {
      var c = mk([[10, 11, 9.5, 10.8], [10.8, 13, 10.7, 12.9], [12.9, 13.5, 11.01, 13.2]]);
      var small = SMC.findFVGs(series(c, 0.5), 0, 2, 1, C).length === 0;
      var fill = SMC.fvgFill({ bot: 11, top: 11.6 }, 11.2, 1);
      return small && Math.abs(fill - 2 / 3) < 1e-9 && fill > C.fvg.maxFill && SMC.fvgFill({ bot: 11, top: 11.6 }, NaN, 1) === 0;
    });
    test('LONG: SL < вход < TP1 < TP2 < TP3, TP3 ограничен 5R', function () {
      var a = SMC.levelsFrom(1, 100, 98, 4, C), b = SMC.levelsFrom(1, 100, 98, 10, C);
      return 98 < 100 && 100 < a.tp1 && a.tp1 < a.tp2 && a.tp2 < a.tp3 && a.tp1 === 102 && a.tp2 === 104 && a.tp3 === 108 && b.tp3 === 110;
    });
    test('SHORT зеркален LONG: SL > вход > TP1 > TP2 > TP3', function () {
      var a = SMC.levelsFrom(-1, 100, 102, 3.5, C);
      return 102 > 100 && 100 > a.tp1 && a.tp1 > a.tp2 && a.tp2 > a.tp3 && a.tp1 === 98 && a.tp2 === 96 && a.tp3 === 93;
    });
    test('Валидатор отклоняет неверный порядок цен', function () {
      var T0 = 10 * H1;
      var L = mk([[100, 101, 99, 100], [100, 101, 99, 100], [100, 101, 99, 100], [100, 101, 99, 100], [100, 101, 99, 100], [100, 101, 99, 100], [100, 101, 99, 100], [100, 101, 99, 100]], M15, T0);
      var M = mk([[100, 101, 99, 100], [100, 101, 99, 100], [100, 101, 99, 100], [100, 101, 99, 100]], H1, T0 - 2 * H1);
      var Hh = mk([[100, 101, 99, 100], [100, 101, 99, 100], [100, 101, 99, 100]], 4 * H1, T0 - 12 * H1);
      var raw = { L: L, M: M, H: Hh, ms: { L: M15, M: H1, H: 4 * H1 }, evalT: T0 + 8 * M15, price: 101 };
      var base = { sym: 'TESTUSDT', dir: 1, triggerT: L[7].t, entry: 100, sl: 98, tp1: 99, tp2: 104, tp3: 108 };
      var bad = Signals.validate(base, raw, null);
      var good = Signals.validate(Object.assign({}, base, { tp1: 102 }), raw, null);
      var shortBad = Signals.validate(Object.assign({}, base, { dir: -1, sl: 102, tp1: 98, tp2: 99, tp3: 92 }), raw, null);
      return !bad.ok && bad.code === 'order' && good.code !== 'order' && shortBad.code === 'order';
    });
    test('Правило «SL первым»: SL и TP в одной свече — засчитывается SL', function () {
      var s = sig(1);
      Signals.step(s, { t: M15, o: 100.5, h: 100.8, l: 99.9, c: 100.2 }, C);
      Signals.step(s, { t: 2 * M15, o: 100.2, h: 103, l: 97.5, c: 101 }, C);
      return s.status === 'closed' && s.outcome === 'sl' && !s.tpHit[0] && s.resultR < -1;
    });
    test('TP1, затем безубыток: результат с комиссиями и проскальзыванием', function () {
      var s = sig(1);
      Signals.step(s, { t: M15, o: 100.5, h: 100.8, l: 99.9, c: 100.2 }, C);
      Signals.step(s, { t: 2 * M15, o: 100.2, h: 102.5, l: 99.5, c: 100 }, C);
      var be = 100 * (1 + 2 * 0.0005), ex = be * (1 - 0.0003);
      var gross = 0.4 * 2 + 0.6 * (ex - 100), fees = 100 * 0.0005 + 0.4 * 102 * 0.0005 + 0.6 * ex * 0.0005;
      return s.outcome === 'be' && s.tpHit[0] && !s.tpHit[1] && Math.abs(s.resultR - (gross - fees) / 2) < 1e-9;
    });
    test('Просрочка: нет входа за 12 свечей 15m', function () {
      var s = sig(1), ok11 = false;
      for (var k = 1; k <= 12; k++) {
        Signals.step(s, { t: k * M15, o: 100.8, h: 101.2, l: 100.6, c: 100.9 }, C);
        if (k === 11) ok11 = s.status === 'pending';
      }
      return ok11 && s.status === 'expired' && s.filledT === null;
    });
    test('Калькулятор: 100 USDT, риск 1%, вход 100, SL 98, плечо 5x → 0.5 монеты, 50 USDT, маржа 10, убыток на SL 1 USDT', function () {
      var r = Calc.compute({ deposit: 100, riskPct: 1, dir: 1, entry: 100, sl: 98, tp: [102, 104, 108], fr: [40, 30, 30], leverage: 5, feePct: 0, slipPct: 0, minOrder: 5, mode: 'risk', mmrPct: 0.5 });
      return r.ok && Math.abs(r.qty - 0.5) < 1e-12 && Math.abs(r.notional - 50) < 1e-9 && Math.abs(r.margin - 10) < 1e-9 && Math.abs(r.scenarios.sl.usd + 1) < 1e-9 && Math.abs(r.scenarios.all.usd - (0.5 * (0.4 * 2 + 0.3 * 4 + 0.3 * 8))) < 1e-9;
    });
    test('Калькулятор: ликвидация LONG ниже входа, SHORT выше; SL не с той стороны — ошибка', function () {
      var l = Calc.compute({ deposit: 100, riskPct: 1, dir: 1, entry: 100, sl: 98, tp: [102, 104, 108], leverage: 5, feePct: 0.05, slipPct: 0, mode: 'risk', mmrPct: 0.5 });
      var s = Calc.compute({ deposit: 100, riskPct: 1, dir: -1, entry: 100, sl: 102, tp: [98, 96, 92], leverage: 5, feePct: 0.05, slipPct: 0, mode: 'risk', mmrPct: 0.5 });
      var w = Calc.compute({ deposit: 100, riskPct: 1, dir: 1, entry: 100, sl: 101, tp: [102, 104, 108], leverage: 5, mode: 'risk' });
      return l.liq > 0 && l.liq < 98 && Math.abs(l.liq - 100 * 0.8 / 0.995) < 1e-9 && s.liq > 102 && !w.ok;
    });
    test('Сглаживание точности: (успехи + 10p) / (n + 10)', function () {
      return Math.abs(Signals.smooth(10, 20, 0.5, 10) - 0.5) < 1e-12 && Math.abs(Signals.smooth(18, 20, 0.5, 10) - 23 / 30) < 1e-12 &&
        Signals.Calib.bucketOf(84) === 80 && Signals.Calib.bucketOf(100) === 90 && Signals.Calib.bucketOf(59) === null;
    });
    test('EMA, ATR и выравнивание таймфреймов по закрытию', function () {
      var flat = mk(new Array(60).fill(0).map(function () { return [10, 11, 9, 10]; }));
      var e = SMC.emaArr(flat, 50), a = SMC.atrArr(flat, 14);
      var hc = mk([[1, 1, 1, 1], [1, 1, 1, 1], [1, 1, 1, 1]], H1, 0);
      return Math.abs(e[59] - 10) < 1e-12 && isNaN(e[48]) && Math.abs(a[59] - 2) < 1e-12 &&
        SMC.lastClosedIndex(hc, H1, 2 * H1) === 1 && SMC.lastClosedIndex(hc, H1, 2 * H1 - 1) === 0 && SMC.lastClosedIndex(hc, H1, H1 - 1) === -1;
    });

    var failed = results.filter(function (r) { return !r.ok; }).map(function (r) { return r.name; });
    var out = { ok: failed.length === 0, passed: results.length - failed.length, total: results.length, failed: failed };
    if (out.ok) console.log('Self-test: OK (' + out.total + ' тестов)');
    else console.log('Self-test: FAILED — ' + failed.join('; '));
    return out;
  }

  // ---------- запуск ----------
  function start() {
    app.settings = loadSettings();
    var savedLog = Store.get(C.storage.log, []);
    app.logs = Array.isArray(savedLog) ? savedLog.filter(function (l) { return l && typeof l.text === 'string'; }) : [];
    Signals.Journal.load();
    Signals.Calib.load();
    app.calc = calcDefaults();
    app.bt = btDefaults();
    UI.init(app);
    app.selfTest = runSelfTests();
    if (!app.selfTest.ok) log('error', 'Самопроверка не пройдена: ' + app.selfTest.failed.join('; '));
    feed = new Data.Feed(hooks);
    app.feed = feed;
    UI.renderStatus(feed.status);
    UI.show('best');
    feed.setExtra(Signals.Journal.openFor(null).map(function (s) { return s.sym; }));
    feed.start(0);
    document.addEventListener('pointerdown', function () { audio(); }, { once: true });
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && feed && feed.adapter && Data.now() - feed.status.lastUpdate > C.network.pollMs * 2) feed.kick();
    });
    setInterval(function () {
      if (app.ready && (UI.current() === 'best' || UI.current() === 'signals') && Data.now() - feed.status.lastUpdate > 25000) UI.update();
    }, 30000);
  }

  app.start = start;
  return app;
})();

document.addEventListener('DOMContentLoaded', function () { App.start(); });
