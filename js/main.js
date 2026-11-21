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
      // По умолчанию свечи Binance Spot — те же, что видит Telegram-бот на GitHub; комиссия — как на фьючерсах.
      source: 'binanceSpot', tradeMarket: 'futures', mode: 'both', minScore: C.minScore, riskPct: C.calculator.riskPct,
      feeFutures: C.fees.futures, feeSpot: C.fees.spot, slipPct: C.slippagePct,
      symbols: C.symbols.slice(), sound: true, strategy: C.defaultStrategy, expiryBars: C.lifecycle.expiryBars,
      notify: false, notifyStatus: false, livePreset: C.defaultPreset
    };
  }
  // Таймфреймы live-сигналов: один пресет или все три сразу.
  // 'quality' — набор пресетов качественного режима (CONFIG.qualityPreset.presets), если он из нескольких пресетов.
  var LIVE_PRESETS = ['main', 'swing', 'scalp', 'all', 'quality'];
  function numIn(v, lo, hi, def) { return (typeof v === 'number' && isFinite(v) && v >= lo && v <= hi) ? v : def; }
  function sanitize(s) {
    var d = defaults(), o = {};
    o.source = (s.source === 'auto' || Data.ADAPTERS[s.source]) ? s.source : d.source;
    o.tradeMarket = s.tradeMarket === 'spot' ? 'spot' : 'futures';
    o.mode = s.mode === 'long' ? 'long' : 'both';
    o.minScore = Math.round(numIn(s.minScore, 60, 100, d.minScore));
    o.riskPct = numIn(s.riskPct, 0.05, 20, d.riskPct);
    o.feeFutures = numIn(s.feeFutures, 0, 1, d.feeFutures);
    o.feeSpot = numIn(s.feeSpot, 0, 1, d.feeSpot);
    o.slipPct = numIn(s.slipPct, 0, 2, d.slipPct);
    o.symbols = Array.isArray(s.symbols) ? s.symbols.filter(function (x) { return typeof x === 'string' && /^[A-Z0-9]{2,15}$/.test(x); }) : d.symbols;
    if (!o.symbols.length) o.symbols = d.symbols;
    o.sound = s.sound !== false;
    o.notify = s.notify === true;
    o.notifyStatus = s.notifyStatus === true;
    o.strategy = C.strategyModes[s.strategy] ? s.strategy : d.strategy;
    o.expiryBars = C.lifecycle.expiryOptions.indexOf(s.expiryBars) >= 0 ? s.expiryBars : d.expiryBars;
    o.livePreset = LIVE_PRESETS.indexOf(s.livePreset) >= 0 ? s.livePreset : d.livePreset;
    return o;
  }
  // Окно догрузки при старте: сигнал старше срока ожидания входа уже не может ждать вход.
  function catchUpBars() { return Math.max(C.live.catchUpBars, app.settings.expiryBars); }
  // Активные пресеты live-режима. «Все сразу» — основной, свинг и скальп параллельно (основной первым).
  function activePresets() {
    var v = app.settings.livePreset;
    if (v === 'all') return ['main', 'swing', 'scalp'];
    if (v === 'quality') return C.qualityPreset.presets.slice();
    return [v];
  }
  function livePresetName(v) { return v === 'all' ? 'все пресеты сразу' : (v === 'quality' ? 'качественный набор' : C.presets[v].name); }
  function primaryPreset() { return activePresets()[0]; }
  // Сколько свечей держать по роли ТФ: младший — окно + догрузка; средний — окно и 30 дней для оценки
  // волатильности; старший — окно и прогрев EMA200.
  function loadCount(role, tf) {
    if (role === 'ltf') return Math.max(C.live.load.ltf, C.windows.ltf + catchUpBars() + 40);
    if (role === 'mtf') return Math.max(C.windows.mtf + 60, Math.ceil(C.lowVol.days * SMC.DAY / SMC.tfMs(tf)) + 60);
    return C.windows.htf + C.emaWarmupBars + 20;
  }
  // План данных: объединение таймфреймов пресетов (+ младшие ТФ открытых сигналов) с максимумом свечей.
  function tfPlanFor(presetIds, openLtfs) {
    var plan = {};
    function want(tf, role) {
      var x = plan[tf] || (plan[tf] = { count: 0, ltf: false });
      x.count = Math.max(x.count, loadCount(role, tf));
      if (role === 'ltf') x.ltf = true;
    }
    presetIds.forEach(function (pid) { var P = C.presets[pid]; want(P.ltf, 'ltf'); want(P.mtf, 'mtf'); want(P.htf, 'htf'); });
    (openLtfs || []).forEach(function (tf) { want(tf, 'ltf'); });
    return plan;
  }
  function openLtfsOf(sym) {
    return Signals.Journal.openFor(sym).map(function (s) { return s.tf && s.tf.ltf; }).filter(function (tf) { return !!SMC.TF_MS[tf]; });
  }
  function loadSettings() {
    var s = Store.get(C.storage.settings, {});
    return sanitize(s && typeof s === 'object' ? s : {});
  }
  function saveSettings() { Store.set(C.storage.settings, app.settings); }
  // Комиссия — по рынку, где пользователь торгует (настройка), а не по источнику свечей: данные можно брать
  // со спота, а торговать фьючерсами.
  function marketFee() {
    return app.settings.tradeMarket === 'spot' ? app.settings.feeSpot : app.settings.feeFutures;
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
  // Серии по каждому загруженному таймфрейму: app.series[sym][tf].
  function buildAllSeries() {
    var out = {};
    Object.keys(feed.raw).forEach(function (sym) {
      var r = feed.raw[sym];
      if (!r || !r.c) return;
      var S = {};
      Object.keys(r.c).forEach(function (tf) { if (r.c[tf] && r.c[tf].length) S[tf] = SMC.buildSeries(r.c[tf], tf, C); });
      out[sym] = S;
    });
    app.series = out;
  }
  function presetSeries(sym, pid) {
    var S = app.series[sym], P = C.presets[pid];
    if (!S) return null;
    return { L: S[P.ltf] || null, M: S[P.mtf] || null, H: S[P.htf] || null };
  }
  function makeCtx(sym, pid, idx) {
    var P = C.presets[pid], X = presetSeries(sym, pid), B = feed.hasBtc ? app.series[feed.btcSym] : null;
    return SMC.makeContext({
      sym: sym, coin: coinOf(sym), L: X.L, M: X.M, H: X.H, i: idx,
      btc: (B && B[P.mtf] && B[P.htf]) ? { M: B[P.mtf], H: B[P.htf] } : null,
      cfg: configFor(profileFor(app.settings.strategy, pid)), longOnly: app.settings.mode === 'long', memo: null
    });
  }
  // Обзор монет (тренд, стадия) — по главному из активных пресетов.
  function updateOverviews() {
    var out = {}, pid = primaryPreset();
    feed.coins.forEach(function (c) {
      var X = presetSeries(c.sym, pid);
      if (!X || !X.L || !X.M || !X.H || X.L.c.length < 3) return;
      try { out[c.sym] = SMC.overview(makeCtx(c.sym, pid, X.L.c.length - 1), app.priceOf(c.sym)); } catch (e) { /* обзор не критичен */ }
    });
    app.overview = out;
  }

  // ---------- обработка закрытых свечей ----------
  // Сопровождение открытых сигналов символа на свече cd их младшего ТФ (tf).
  // isNews — событие на последней свече обычного опроса: о нём можно уведомить.
  function stepSignalsOn(sym, tf, cd, isNews) {
    var coin = coinOf(sym);
    Signals.Journal.openFor(sym).forEach(function (sig) {
      if (!sig.tf || sig.tf.ltf !== tf) return;
      var before = sig.status, hitBefore = sig.tpHit.slice();
      Signals.step(sig, cd, C);
      if (before === 'pending' && sig.status === 'active') {
        log('info', coin + ' ' + sig.side + ': вход по ' + UI.fP(sig.entry));
        if (isNews) notifyStatus(sig, 'вход исполнен по ' + UI.fP(sig.entry));
      }
      if (Signals.isOpen(sig) && sig.tpHit[0] && !hitBefore[0] && isNews) notifyStatus(sig, 'TP1 взят, стоп перенесён в безубыток');
      if (Signals.isOpen(sig) && sig.tpHit[1] && !hitBefore[1] && isNews) notifyStatus(sig, 'TP2 взят, стоп перенесён на TP1');
      if (!Signals.isOpen(sig)) {
        Signals.Journal.noteClosed(sig);
        var resTxt = Signals.statusText(sig) + (sig.resultR !== null ? ' (' + (sig.resultR >= 0 ? '+' : '') + sig.resultR.toFixed(2) + 'R)' : '');
        log('info', coin + ' ' + sig.side + ': ' + resTxt);
        if (isNews && !sig.late) notifyStatus(sig, resTxt);
      }
    });
  }
  // Для каждой новой закрытой свечи младшего ТФ пресета: сопровождение сигналов на этом ТФ, затем детектор
  // и валидатор с таймфреймами пресета. fresh — вызов из обычного опроса.
  function processPreset(sym, pid, newCount, live, fresh) {
    var X = presetSeries(sym, pid), P = C.presets[pid];
    if (!X || !X.L) return [];
    var Lc = X.L.c, n = Lc.length, created = [];
    var start = Math.max(0, n - newCount);
    var canDetect = isActive(sym) && X.M && X.H;
    var detectFrom = Math.max(start, n - catchUpBars());
    var coin = coinOf(sym), tag = activePresets().length > 1 ? ' [' + P.short + ']' : '';
    for (var idx = start; idx < n; idx++) {
      var cd = Lc[idx];
      stepSignalsOn(sym, P.ltf, cd, !!fresh && idx === n - 1);
      if (!canDetect || idx < detectFrom) continue;
      var ctx = makeCtx(sym, pid, idx), res;
      try { res = SMC.detect(ctx); } catch (e) { log('error', coin + tag + ': ошибка детектора — ' + e.message); continue; }
      var when = UI.fDT(ctx.T);
      if (!res.cand) {
        if (LOG_STAGES[res.code]) log('debug', coin + tag + ' ' + when + ': кандидат ' + (res.dir === 1 ? 'LONG' : 'SHORT') + ' отброшен детектором — ' + res.reason);
        continue;
      }
      var cand = res.cand;
      if (cand.score < app.settings.minScore) {
        log('debug', coin + tag + ' ' + when + ': ' + cand.side + ' score ' + cand.score + ' ниже порога ' + app.settings.minScore);
        continue;
      }
      var latest = live && idx === n - 1;
      var raw = {
        L: Lc, M: X.M.c, H: X.H.c, ms: { L: X.L.ms, M: X.M.ms, H: X.H.ms }, evalT: ctx.T,
        price: latest ? app.priceOf(sym) : cd.c
      };
      var v;
      try { v = Signals.validate(cand, raw, Signals.Journal, ctx.cfg); } catch (e2) { v = { ok: false, reason: 'ошибка валидатора: ' + e2.message }; }
      if (!v.ok) {
        log('reject', coin + tag + ' ' + when + ': ' + cand.side + ' (score ' + cand.score + ') отклонён валидатором — ' + v.reason);
        continue;
      }
      var sig = Signals.create(cand, {
        fee: marketFee() / 100, slip: app.settings.slipPct / 100, ltfMs: X.L.ms,
        source: feed.status.source, preset: pid, late: !latest, mode: ctx.cfg.strategy,
        expiryBars: app.settings.expiryBars
      });
      if (Signals.Journal.add(sig)) {
        created.push(sig);
        log('signal', coin + ' ' + when + ': новый сигнал ' + sig.side + ' (пресет ' + P.short + ', ' + C.strategyModes[sig.mode].short + ' профиль), score ' + sig.score + ', вход ' + UI.fP(sig.entry) + ', SL ' + UI.fP(sig.sl) + ', TP3 ' + UI.fP(sig.tp3));
      }
    }
    return created;
  }
  // Сопровождение сигналов на младших ТФ, которые сейчас не ведёт ни один активный пресет
  // (например, сигнал скальпа после переключения на основной пресет).
  function processLeftovers(sym, newByTf, fresh) {
    var S = app.series[sym], used = {}, tfs = {};
    if (!S) return;
    activePresets().forEach(function (pid) { used[C.presets[pid].ltf] = true; });
    Signals.Journal.openFor(sym).forEach(function (sig) { if (sig.tf && !used[sig.tf.ltf]) tfs[sig.tf.ltf] = true; });
    Object.keys(tfs).forEach(function (tf) {
      var ser = S[tf], cnt = newByTf ? (newByTf[tf] || 0) : 0;
      if (!ser || cnt <= 0) return;
      var c = ser.c, n = c.length;
      for (var k = Math.max(0, n - cnt); k < n; k++) stepSignalsOn(sym, tf, c[k], !!fresh && k === n - 1);
    });
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
      if (app.settings.notify) {
        pushNotify('Новый сигнал: ' + sig.coin + ' ' + sig.side + ' · score ' + sig.score,
          'Лимит ' + UI.fP(sig.entry) + ' · SL ' + UI.fP(sig.sl) + ' · TP1 ' + UI.fP(sig.tp1) + ' · TP3 ' + UI.fP(sig.tp3) +
          '. Ждём вход до ' + UI.fTime(sig.expiresT) + '. Профиль: ' + C.strategyModes[sig.mode].short + '.',
          'smc-' + sig.id, false);
      }
    });
  }

  // ---------- системные уведомления ----------
  // Показываются, когда вкладка в фоне или окно не в фокусе; на открытой вкладке хватает плашки и звука.
  function notifySupported() { return typeof window.Notification === 'function'; }
  function inBackground() {
    return !!document.hidden || (typeof document.hasFocus === 'function' && !document.hasFocus());
  }
  function pushNotify(title, body, tag, force) {
    if (!notifySupported() || Notification.permission !== 'granted') return false;
    if (!force && !inBackground()) return false;
    try {
      var n = new Notification(title, { body: body, tag: tag, lang: 'ru' });
      n.onclick = function () {
        try { window.focus(); } catch (e) { /* фокус не обязателен */ }
        UI.show('best');
        n.close();
      };
      return true;
    } catch (e) {
      // Например, Chrome на Android требует service worker — без него уведомление недоступно.
      log('warn', 'Системное уведомление не показано: ' + e.message);
      return false;
    }
  }
  function notifyStatus(sig, text) {
    if (!app.settings.notify || !app.settings.notifyStatus) return;
    pushNotify(sig.coin + ' ' + sig.side + ': ' + text, 'Сигнал от ' + UI.fDT(sig.createdT) + ', вход ' + UI.fP(sig.entry) + ', SL ' + UI.fP(sig.sl) + '.', 'smc-st-' + sig.id, false);
  }
  app.notifyPermission = function () { return notifySupported() ? Notification.permission : 'unsupported'; };
  app.requestNotify = function () {
    return new Promise(function (resolve) {
      if (!notifySupported()) { resolve('unsupported'); return; }
      var done = false;
      function fin(res) { if (!done) { done = true; resolve(res || Notification.permission); } }
      try {
        var p = Notification.requestPermission(fin);
        if (p && typeof p.then === 'function') p.then(fin, function () { fin(Notification.permission); });
      } catch (e) { fin(Notification.permission); }
    });
  };
  app.testNotify = function () {
    return pushNotify('SMC Signals: проверка уведомлений', 'Так будет выглядеть уведомление о новом сигнале. Нажмите, чтобы открыть приложение.', 'smc-test', true);
  };

  // Сопровождение сигналов из прошлых сессий по пропущенным свечам.
  function replayOpen() {
    var open = Signals.Journal.openFor(null);
    var chain = Promise.resolve();
    open.forEach(function (sig) {
      chain = chain.then(function () {
        var tf = sig.tf && sig.tf.ltf ? sig.tf.ltf : C.timeframes.ltf;
        var S = app.series[sig.sym] && app.series[sig.sym][tf];
        if (!S || !S.c.length) return null;
        var Lc = S.c, ms = S.ms;
        var stopIdx = Math.max(0, Lc.length - catchUpBars()) - 1; // дальше свечи обработает догрузка
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
          pre = Data.fetchRange(feed.adapter, feed.base, sig.sym, tf, sig.lastT + ms, firstT - ms).then(null, function (e) {
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

  // Догрузка: прогон последних закрытых свечей (не меньше срока ожидания входа) по всем монетам —
  // при старте, смене профиля или срока. Сопровождение идемпотентно (свечи до lastT пропускаются),
  // дубли отсекает валидатор и id сигнала.
  function catchUpSym(sym) {
    var created = [], all = {};
    activePresets().forEach(function (pid) { created = created.concat(processPreset(sym, pid, catchUpBars(), true)); });
    Object.keys(app.series[sym] || {}).forEach(function (tf) { all[tf] = catchUpBars(); });
    processLeftovers(sym, all, false);
    return created;
  }
  function catchUpAll() {
    var created = [];
    Object.keys(app.series).forEach(function (sym) { created = created.concat(catchUpSym(sym)); });
    created = dropFinishedLate(created);
    updateOverviews();
    Signals.Journal.save();
    announce(created);
    return created;
  }

  // ---------- хуки ленты ----------
  var hooks = {
    getSettings: function () { return app.settings; },
    // План данных символа: монеты списка — все ТФ активных пресетов; остальные — только младшие ТФ их открытых сигналов.
    getPlan: function (sym, full) {
      var open = openLtfsOf(sym);
      return full ? tfPlanFor(activePresets(), open) : tfPlanFor([], open.length ? open : [C.presets[primaryPreset()].ltf]);
    },
    onStatus: function (st) {
      UI.renderStatus(st);
      // Пока нет данных или связь потеряна — главный экран показывает состояние подключения.
      if ((!app.ready || st.state === 'error') && UI.current() === 'best') UI.update('best');
    },
    onLog: function (level, text) { log(level, text); },
    onReady: function () {
      buildAllSeries();
      replayOpen().then(function () {
        catchUpAll();
        app.ready = true;
        UI.update();
      }).then(null, function (e) { log('error', 'Ошибка запуска: ' + e.message); });
    },
    onUpdate: function (info) {
      if (!app.ready) return;
      buildAllSeries();
      var created = [];
      Object.keys(info.closedNew || {}).forEach(function (sym) {
        var cn = info.closedNew[sym] || {};
        if (cn._reload) { created = created.concat(catchUpSym(sym)); return; } // монета догружена — прогнать догрузку
        activePresets().forEach(function (pid) {
          var n = cn[C.presets[pid].ltf] || 0;
          if (n > 0) created = created.concat(processPreset(sym, pid, n, true, true));
        });
        processLeftovers(sym, cn, true);
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
  // Самый мелкий загруженный ТФ символа — для текущей цены.
  function finestTf(r) {
    var best = null;
    Object.keys(r.c || {}).forEach(function (tf) { if (!best || SMC.tfMs(tf) < SMC.tfMs(best)) best = tf; });
    return best;
  }
  app.priceOf = function (sym) {
    if (feed && feed.prices[sym] > 0) return feed.prices[sym];
    var r = feed && feed.raw[sym], tf = r ? finestTf(r) : null;
    if (!tf) return NaN;
    if (r.form[tf]) return r.form[tf].c;
    var arr = r.c[tf];
    return arr && arr.length ? arr[arr.length - 1].c : NaN;
  };
  // Свечи для мини-графика: младший ТФ сигнала (последние 120 + незакрытая).
  app.candlesFor = function (sym, tf) {
    var r = feed && feed.raw[sym];
    if (!r || !r.c) return [];
    tf = tf || C.presets[primaryPreset()].ltf;
    var arr = (r.c[tf] || []).slice(-120);
    if (r.form[tf]) arr.push(r.form[tf]);
    return arr;
  };
  app.provisionalOf = function (sig) {
    var r = feed && feed.raw[sig.sym], tf = sig.tf && sig.tf.ltf;
    return r && r.form && tf && r.form[tf] ? Signals.provisional(sig, r.form[tf]) : sig;
  };
  app.activePresets = function () { return activePresets(); };
  app.primaryPreset = function () { return primaryPreset(); };
  app.openSignals = function () {
    return Signals.Journal.openFor(null).filter(function (s) { return Signals.isOpen(app.provisionalOf(s)); })
      .sort(function (a, b) { return (b.score - a.score) || ((b.roomR === Infinity ? 99 : b.roomR) - (a.roomR === Infinity ? 99 : a.roomR)); });
  };
  app.bestSignal = function () { var l = app.openSignals(); return l.length ? l[0] : null; };
  app.coinRows = function () {
    if (!feed) return [];
    var nowT = Data.now(), ms = SMC.tfMs(C.presets[primaryPreset()].ltf);
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
    var acc = Signals.Calib.accuracy(sig.coin, sig.score, sig.mode, sig.preset);
    s.probPct = acc ? Math.round(acc.value * 1000) / 10 : NaN;
  };
  app.toCalc = function (id) { app.fillCalcFromSignal(id); UI.show('calc'); };

  // ---------- бэктест ----------
  function btDefaults() {
    return {
      params: {
        coin: 'all', days: C.backtest.defaultDays, presetId: C.defaultPreset, minScore: app.settings.minScore, feePct: C.fees.futures, slipPct: app.settings.slipPct,
        mode: app.settings.strategy, expiryBars: app.settings.expiryBars, management: Backtest.currentManagement() || 'base', prev: false
      },
      running: false, progress: { frac: 0, text: '' }, result: null, error: ''
    };
  }
  app.runBacktest = function () {
    var bt = app.bt, p = bt.params;
    if (bt.running) return;
    if (!feed || !feed.adapter || !feed.coins.length) { UI.toast('Нет подключения к источнику данных', 'bad'); return; }
    if (app.lc && app.lc.running) { UI.toast('Идёт проверка на истории в Настройках — дождитесь её окончания', 'bad'); return; }
    if (!(p.minScore >= 60 && p.minScore <= 100)) p.minScore = app.settings.minScore;
    if (!(p.feePct >= 0)) p.feePct = marketFee();
    if (!(p.slipPct >= 0)) p.slipPct = app.settings.slipPct;
    var coins = p.coin === 'all' ? feed.coins.slice() : feed.coins.filter(function (c) { return c.coin === p.coin; });
    if (!coins.length) coins = feed.coins.slice();
    if (!C.strategyModes[p.mode]) p.mode = app.settings.strategy;
    if (C.lifecycle.expiryOptions.indexOf(p.expiryBars) < 0) p.expiryBars = app.settings.expiryBars;
    bt.running = true; bt.error = ''; bt.progress = { frac: 0, text: 'Старт…' };
    if (UI.current() === 'backtest') UI.update('backtest', true);
    if (!C.managementVariants[p.management]) p.management = Backtest.currentManagement() || 'base';
    log('info', 'Бэктест: ' + C.presets[p.presetId].name + ', профиль «' + C.strategyModes[p.mode].name + '», ' + p.days + ' дн' + (p.prev ? ' до последних ' + p.days : '') +
      ', монет ' + coins.length + ', minScore ' + p.minScore + ', ожидание входа ' + p.expiryBars + ' свечей, сопровождение «' + C.managementVariants[p.management].name + '»');
    Backtest.run({
      adapter: feed.adapter, base: feed.base, coins: coins, hasBtc: feed.hasBtc, days: p.days, presetId: p.presetId,
      minScore: p.minScore, feePct: p.feePct, slipPct: p.slipPct, longOnly: app.settings.mode === 'long', mode: p.mode,
      expiryBars: p.expiryBars, management: p.management, endOffsetDays: p.prev ? p.days : 0
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
  // Калибровка точности: бэктест 60 дней по указанному пресету (по умолчанию — главный из активных).
  app.calibrate = function (presetId) {
    var p = app.bt.params;
    p.management = Backtest.currentManagement() || 'base'; p.prev = false; // калибровка — по текущим настройкам на свежей истории
    p.coin = 'all'; p.days = C.calibration.days; p.presetId = C.presets[presetId] ? presetId : primaryPreset(); p.minScore = app.settings.minScore;
    p.feePct = marketFee(); p.slipPct = app.settings.slipPct; p.mode = app.settings.strategy; p.expiryBars = app.settings.expiryBars;
    UI.show('backtest');
    app.runBacktest();
  };
  // ---------- проверка текущих настроек live на истории: сколько сигналов в день ----------
  // Бэктест каждого активного пресета на всех монетах списка (без записи в калибровку), затем объединение
  // по правилам live (Backtest.mergeLive) и подсчёт по дням. Цифры на экране — только из этого расчёта.
  function lcSnapshot() {
    var s = app.settings;
    return { strategy: s.strategy, livePreset: s.livePreset, expiryBars: s.expiryBars, minScore: s.minScore, mode: s.mode, coins: s.symbols.join(',') };
  }
  function lcPeriod(id) {
    var ps = C.liveCheck.periods;
    for (var k = 0; k < ps.length; k++) if (ps[k].id === id) return ps[k];
    return null;
  }
  // Результаты хранятся по каждому периоду: свежий и независимый отрезок можно сравнить рядом.
  function lcDefaults() {
    var saved = Store.get(C.storage.liveCheck, null), byPeriod = {};
    if (saved && saved.v === 3 && saved.byPeriod && typeof saved.byPeriod === 'object') {
      Object.keys(saved.byPeriod).forEach(function (id) {
        var r = saved.byPeriod[id];
        if (lcPeriod(id) && r && Array.isArray(r.months) && Array.isArray(r.days) && r.snap && typeof r.ts === 'number') byPeriod[id] = r;
      });
    }
    var period = saved && lcPeriod(saved.last) ? saved.last : C.liveCheck.defaultPeriod;
    return { running: false, cancel: false, progress: { frac: 0, text: '' }, byPeriod: byPeriod, period: period, res: byPeriod[period] || null, error: '' };
  }
  // Период проверки: 90 дней, 180 дней или 180 дней до них (независимый отрезок).
  app.setLiveCheckPeriod = function (id) {
    if (!lcPeriod(id) || app.lc.running) return;
    app.lc.period = id;
    app.lc.res = app.lc.byPeriod[id] || null;
    app.lc.error = '';
  };
  app.liveCheckPeriod = lcPeriod;
  function numOrNull(x) { return (typeof x === 'number' && isFinite(x)) ? x : null; }
  // Настройки live изменились после последней проверки — её цифры относятся к другим настройкам.
  app.liveCheckStale = function () {
    var r = app.lc && app.lc.res, b = lcSnapshot();
    return !!r && Object.keys(b).some(function (k) { return r.snap[k] !== b[k]; });
  };
  app.runLiveCheck = function () {
    var lc = app.lc;
    if (lc.running) return;
    if (!feed || !feed.adapter || !feed.coins.length || !app.ready) { UI.toast('Данные ещё загружаются — запустите проверку чуть позже', 'bad'); return; }
    if (app.bt.running || Backtest.isRunning()) { UI.toast('Идёт бэктест — дождитесь его окончания', 'bad'); return; }
    var pids = activePresets(), coins = feed.coins.slice(), snap = lcSnapshot();
    var PER = lcPeriod(lc.period) || lcPeriod(C.liveCheck.defaultPeriod), days = PER.days;
    var base = {
      adapter: feed.adapter, base: feed.base, coins: coins, hasBtc: feed.hasBtc, days: days, endOffsetDays: PER.offset,
      minScore: app.settings.minScore, feePct: marketFee(), slipPct: app.settings.slipPct,
      longOnly: app.settings.mode === 'long', mode: app.settings.strategy, expiryBars: app.settings.expiryBars, readOnly: true
    };
    var results = [], k = 0;
    lc.running = true; lc.cancel = false; lc.error = ''; lc.progress = { frac: 0, text: 'Старт…' };
    UI.updateLiveCheck(true);
    log('info', 'Проверка на истории: ' + PER.label + (PER.offset ? ' (независимый отрезок)' : '') + ', пресеты ' + pids.map(function (p) { return C.presets[p].short; }).join(' + ') +
      ', профиль «' + C.strategyModes[snap.strategy].name + '», монет ' + coins.length + ', ожидание ' + snap.expiryBars + ' свечей, minScore ' + snap.minScore);
    function next() {
      if (lc.cancel) return Promise.reject(new Error('отменено'));
      if (k >= pids.length) return Promise.resolve();
      var P = C.presets[pids[k]];
      return Backtest.run(Object.assign({}, base, { presetId: P.id }), function (pr) {
        var f = pr.phase === 'load' ? 0.4 * (pr.frac || 0) : (pr.phase === 'sim' ? 0.4 + 0.6 * (pr.frac || 0) : 1);
        lc.progress = { frac: (k + f) / pids.length, text: (pids.length > 1 ? (k + 1) + '/' + pids.length + ' · ' : '') + P.name + ' — ' + (pr.text || '') };
        UI.updateLiveCheck(false);
      }).then(function (res) { results.push(res); k++; return next(); });
    }
    next().then(function () {
      // Общее окно всех пресетов; сигналы вне него не учитываются.
      var fromT = Math.max.apply(null, results.map(function (r) { return r.meta.startT; }));
      var toT = Math.min.apply(null, results.map(function (r) { return r.meta.endT; }));
      var lists = results.map(function (r) { return r.signals.filter(function (s) { return s.createdT >= fromT && s.createdT < toT; }); });
      var kept = Backtest.mergeLive(lists, pids, C.lifecycle.cooldownBars);
      var sum = Backtest.liveSummary(kept, fromT, toT), st = sum.summary, o = sum.split.outS;
      var warnings = [], covered = {};
      results.forEach(function (r) {
        (r.warnings || []).forEach(function (w) { if (warnings.indexOf(w) < 0) warnings.push(w); });
        r.meta.coins.forEach(function (c) { covered[c] = true; });
      });
      var sp = sum.spread;
      lc.res = {
        ts: Date.now(), period: PER.id, periodDays: PER.days, offset: PER.offset, snap: snap, fromT: fromT, toT: toT, presets: pids, source: feed.adapter.name,
        spread: sp ? { n: sp.n, iters: sp.iters, p5: sp.p5, p50: sp.p50, p95: sp.p95, pNeg: sp.pNeg, dd95: sp.dd95 } : null,
        months: sum.months.map(function (m) {
          return { from: m.from, to: m.to, days: m.days, signals: m.signals, entries: m.entries, n: m.n, wins: m.wins, losses: m.losses, sumR: m.sumR, pf: numOrNull(m.pf), pfInf: m.pf === Infinity };
        }),
        posMonths: sum.posMonths,
        modes: pids.map(function (p) { return profileFor(snap.strategy, p); }), coins: Object.keys(covered).length,
        days: sum.days, nDays: sum.nDays, avg: numOrNull(sum.avg), avgEntries: numOrNull(sum.avgEntries),
        ge3: sum.ge3, zero: sum.zero, min: numOrNull(sum.min), max: numOrNull(sum.max),
        signals: st.signals, entries: st.entries, n: st.n, wins: st.wins, losses: st.losses, winRate: numOrNull(st.winRate),
        sumR: st.sumR, pf: numOrNull(st.pf), pfInf: st.pf === Infinity, compPct: st.compPct, maxDD: st.maxDD,
        outN: o.n, outWins: o.wins, outSumR: o.sumR, warnings: warnings.slice(0, 10)
      };
      lc.byPeriod[PER.id] = lc.res;
      Store.set(C.storage.liveCheck, { v: 3, last: PER.id, byPeriod: lc.byPeriod });
      lc.running = false; lc.progress = { frac: 1, text: '' };
      log('info', 'Проверка на истории (' + PER.label + ') завершена: в среднем ' + (lc.res.avg === null ? '—' : lc.res.avg.toFixed(2)) +
        ' сигнала в день, сделок ' + st.n + ', итог ' + st.sumR.toFixed(2) + 'R, месяцев в плюсе ' + sum.posMonths + ' из ' + sum.months.length +
        (sp ? ', разброс 90%: ' + sp.p5.toFixed(1) + '…' + sp.p95.toFixed(1) + 'R, итог ≤ 0 в ' + Math.round(sp.pNeg * 100) + '% повторов' : ''));
      UI.toast('Проверка на истории завершена', 'good');
      UI.updateLiveCheck(true);
    }).then(null, function (e) {
      lc.running = false; lc.error = e.message || String(e); lc.progress = { frac: 0, text: '' };
      log('warn', 'Проверка на истории остановлена: ' + lc.error);
      UI.updateLiveCheck(true);
    });
  };
  app.cancelLiveCheck = function () { if (app.lc.running) { app.lc.cancel = true; Backtest.cancel(); } };

  // ---------- «стоп-кран» по журналу: реальные сделки идут заметно хуже истории ----------
  // lossStreak неуспешных сделок подряд или итог сделок, закрытых за windowDays дней, не больше −lossR.
  app.guardStatus = function () {
    var g = C.guard;
    var trades = Signals.Journal.list.filter(function (s) { return s.status === 'closed' && s.filledT != null && isFinite(s.resultR); });
    trades.sort(function (a, b) { return a.closedT - b.closedT; });
    var last = trades.slice(-g.lossStreak);
    var streak = last.length === g.lossStreak && last.every(function (s) { return !s.tpHit[0]; });
    var since = Data.now() - g.windowDays * 86400000, sum = 0, n = 0;
    trades.forEach(function (s) { if (s.closedT >= since) { sum += s.resultR; n++; } });
    var deep = n > 0 && sum <= -g.lossR;
    return { active: streak || deep, streak: streak, deep: deep, sumR: sum, n: n };
  };

  // ---------- ссылка из Telegram: #sig=<id сигнала> или #coin=<МОНЕТА> ----------
  // Открывает на экране «Сейчас» карточку этого сигнала с графиком; если сигнала в журнале нет — график монеты.
  app.focus = null;
  function readHash() {
    var raw = String(location.hash || '').replace(/^#/, ''), m, prev = app.focus;
    try { raw = decodeURIComponent(raw); } catch (e) { raw = ''; }
    if ((m = /^sig=([A-Za-z0-9._-]{3,80})$/.exec(raw))) {
      var sym = m[1].split('-')[0], coin = sym.length > C.quote.length && sym.slice(-C.quote.length) === C.quote ? sym.slice(0, -C.quote.length) : null;
      app.focus = { sig: m[1], coin: coin };
    } else if ((m = /^coin=([A-Za-z0-9]{2,15})$/.exec(raw))) {
      app.focus = { sig: null, coin: m[1].toUpperCase() };
    } else app.focus = null;
    return JSON.stringify(prev) !== JSON.stringify(app.focus);
  }
  app.focusSignal = function () {
    var f = app.focus;
    if (!f || !f.sig) return null;
    return Signals.Journal.list.filter(function (s) { return s.id === f.sig; })[0] || null;
  };
  app.clearFocus = function () {
    app.focus = null;
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { location.hash = ''; }
    UI.update('best', true);
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
    var next = {}, prevStrategy = app.settings.strategy, prevExpiry = app.settings.expiryBars, prevLive = app.settings.livePreset;
    Object.keys(app.settings).forEach(function (k) { next[k] = app.settings[k]; });
    Object.keys(patch).forEach(function (k) { next[k] = patch[k]; });
    app.settings = sanitize(next);
    saveSettings();
    if (app.settings.strategy !== prevStrategy) {
      app.bt.params.mode = app.settings.strategy;
      log('info', 'Профиль стратегии: ' + C.strategyModes[app.settings.strategy].name);
    }
    if (app.settings.expiryBars !== prevExpiry) {
      app.bt.params.expiryBars = app.settings.expiryBars;
      log('info', 'Ожидание входа: ' + app.settings.expiryBars + ' свечей младшего ТФ (для новых сигналов)');
    }
    if (app.settings.livePreset !== prevLive) {
      // Другие таймфреймы — другой набор данных: перезапуск ленты и догрузка по новым пресетам.
      log('info', 'Таймфреймы live: ' + livePresetName(app.settings.livePreset));
      if (C.presets[app.settings.livePreset]) app.bt.params.presetId = app.settings.livePreset;
      else if (app.settings.livePreset === 'quality') app.bt.params.presetId = C.qualityPreset.presets[0];
      restart = true;
    }
    if (restart) { restartFeed(); return; }
    if (feed && app.ready) {
      // Новый профиль или срок: сразу проверить последние закрытые свечи по новым правилам.
      if (app.settings.strategy !== prevStrategy || app.settings.expiryBars !== prevExpiry) catchUpAll();
      else updateOverviews();
    }
  };
  // Качественный режим: профиль, пресеты, ожидание входа, minScore и монеты — из CONFIG.qualityPreset
  // (его же использует Telegram-бот, поэтому бот и приложение выдают одни и те же сигналы).
  function qualityLive() { var p = C.qualityPreset.presets; return p.length === 1 ? p[0] : 'quality'; }
  app.livePresetName = livePresetName;
  app.applyQuality = function () {
    var q = C.qualityPreset;
    log('info', 'Включён качественный режим: профиль «' + C.strategyModes[q.strategy].name + '», ' +
      q.presets.map(function (p) { return C.presets[p].short; }).join(' + ') + ', монет ' + q.symbols.length + ', ожидание ' + q.expiryBars + ' свечей, minScore ' + q.minScore);
    var patch = { strategy: q.strategy, livePreset: qualityLive(), expiryBars: q.expiryBars, minScore: q.minScore, symbols: q.symbols.slice() };
    if (q.source) patch.source = q.source;
    app.updateSettings(patch, true);
  };
  app.isQuality = function () {
    var q = C.qualityPreset, s = app.settings;
    return s.strategy === q.strategy && s.livePreset === qualityLive() && s.expiryBars === q.expiryBars && s.minScore === q.minScore &&
      (!q.source || s.source === q.source) &&
      s.symbols.length === q.symbols.length && q.symbols.every(function (c) { return s.symbols.indexOf(c) >= 0; });
  };
  app.setCoins = function (text) {
    var list = String(text || '').toUpperCase().split(/[\s,;]+/).map(function (x) {
      x = x.trim();
      if (x.length > C.quote.length && x.slice(-C.quote.length) === C.quote) x = x.slice(0, -C.quote.length);
      return x;
    }).filter(function (x, k, arr) { return /^[A-Z0-9]{2,15}$/.test(x) && arr.indexOf(x) === k; });
    if (!list.length) { UI.toast('Список монет пуст', 'bad'); return; }
    app.updateSettings({ symbols: list.slice(0, C.maxSymbols) }, true);
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
    test('Сопровождение: TP1 → безубыток (как в промпте) и «безубыток только после TP2»; итог с комиссиями и проскальзыванием', function () {
      var s = sig(1), b0 = { tp: Object.assign({}, C.tp, { moveStop: ['be', 'tp1'] }), lifecycle: C.lifecycle };
      Signals.step(s, { t: M15, o: 100.5, h: 100.8, l: 99.9, c: 100.2 }, b0);
      Signals.step(s, { t: 2 * M15, o: 100.2, h: 102.5, l: 99.5, c: 100 }, b0);
      var be = 100 * (1 + 2 * 0.0005), ex = be * (1 - 0.0003);
      var gross = 0.4 * 2 + 0.6 * (ex - 100), fees = 100 * 0.0005 + 0.4 * 102 * 0.0005 + 0.6 * ex * 0.0005;
      // Вариант «безубыток только после TP2»: после TP1 стоп остаётся на SL — те же свечи, затем стоп по SL.
      var v1 = { tp: Object.assign({}, C.tp, { moveStop: [null, 'be'] }), lifecycle: C.lifecycle }, s1 = sig(1);
      Signals.step(s1, { t: M15, o: 100.5, h: 100.8, l: 99.9, c: 100.2 }, v1);
      Signals.step(s1, { t: 2 * M15, o: 100.2, h: 102.5, l: 99.5, c: 100 }, v1);
      var stillOpen = s1.status === 'active' && s1.tpHit[0] && s1.stop === 98;
      Signals.step(s1, { t: 3 * M15, o: 100, h: 100.5, l: 97.5, c: 98 }, v1);
      return s.outcome === 'be' && s.tpHit[0] && !s.tpHit[1] && Math.abs(s.resultR - (gross - fees) / 2) < 1e-9 &&
        stillOpen && s1.status === 'closed' && s1.outcome === 'tp1sl' && s1.resultR < 0 &&
        Signals.OUTCOME.tp1sl === 'TP1 → стоп по SL' && Backtest.currentManagement() === 'beAfterTp2';
    });
    test('Просрочка: нет входа за 12 свечей 15m; срок из настройки (24 свечи) фиксируется в сигнале', function () {
      var s = sig(1), ok11 = false;
      for (var k = 1; k <= 12; k++) {
        Signals.step(s, { t: k * M15, o: 100.8, h: 101.2, l: 100.6, c: 100.9 }, C);
        if (k === 11) ok11 = s.status === 'pending';
      }
      var s24 = Signals.create(Object.assign({}, s, { T: M15, triggerT: 0, mode: 'strict' }), { fee: 0.0005, slip: 0.0003, ltfMs: M15, expiryBars: 24 });
      var ok12 = true;
      for (var q = 1; q <= 24; q++) {
        Signals.step(s24, { t: q * M15, o: 100.8, h: 101.2, l: 100.6, c: 100.9 }, C);
        if (q === 12 && s24.status !== 'pending') ok12 = false;
      }
      // Флаг отмены по TP3: включён — цена дошла до TP3 без входа, сигнал отменяется (касание входа в той же
      // свече важнее); выключен (по умолчанию) — сигнал продолжает ждать вход.
      var onCfg = { tp: C.tp, lifecycle: { expiryBars: 12, cancelIfTp1BeforeEntry: false, cancelIfTp3BeforeEntry: true } };
      var candle3 = { t: M15, o: 100.6, h: 108.5, l: 100.5, c: 108 };
      var t3 = sig(1), t3b = sig(1), t3off = sig(1);
      Signals.step(t3, candle3, onCfg);
      Signals.step(t3b, { t: M15, o: 101, h: 108.5, l: 99.9, c: 108 }, onCfg);
      Signals.step(t3off, candle3, C);
      return ok11 && s.status === 'expired' && s.filledT === null && s.expiryBars === 12 &&
        ok12 && s24.status === 'expired' && s24.expiryBars === 24 && s24.expiresT === M15 + 24 * M15 &&
        t3.status === 'expired' && t3.outcome === 'target' && t3.filledT === null && t3b.status === 'active' &&
        C.lifecycle.cancelIfTp3BeforeEntry === false && t3off.status === 'pending';
    });
    test('Калькулятор: 100 USDT, риск 1%, вход 100, SL 98, 5x → 0.5 монеты, 50 USDT, маржа 10, убыток на SL 1 USDT; ликвидация и неверный SL', function () {
      var r = Calc.compute({ deposit: 100, riskPct: 1, dir: 1, entry: 100, sl: 98, tp: [102, 104, 108], fr: [40, 30, 30], leverage: 5, feePct: 0, slipPct: 0, minOrder: 5, mode: 'risk', mmrPct: 0.5 });
      var ok = r.ok && Math.abs(r.qty - 0.5) < 1e-12 && Math.abs(r.notional - 50) < 1e-9 && Math.abs(r.margin - 10) < 1e-9 && Math.abs(r.scenarios.sl.usd + 1) < 1e-9 && Math.abs(r.scenarios.all.usd - (0.5 * (0.4 * 2 + 0.3 * 4 + 0.3 * 8))) < 1e-9;
      var s = Calc.compute({ deposit: 100, riskPct: 1, dir: -1, entry: 100, sl: 102, tp: [98, 96, 92], leverage: 5, feePct: 0.05, slipPct: 0, mode: 'risk', mmrPct: 0.5 });
      var w = Calc.compute({ deposit: 100, riskPct: 1, dir: 1, entry: 100, sl: 101, tp: [102, 104, 108], leverage: 5, mode: 'risk' });
      return ok && r.liq > 0 && r.liq < 98 && Math.abs(r.liq - 100 * 0.8 / 0.995) < 1e-9 && s.liq > 102 && !w.ok;
    });
    test('Профили стратегии, план данных и объединение пресетов live', function () {
      var soft = configFor('soft'), strict = configFor('strict');
      var profiles = soft.require.sweep === false && soft.pdRange === 'mtf' && soft.entryMode === 'edge' && soft.strategy === 'soft' &&
        strict.require.sweep === true && strict.pdRange === 'htf' && strict.entryMode === 'mid' &&
        CONFIG.require.sweep === true && soft.sl.minRiskPct === CONFIG.sl.minRiskPct && soft.tp.tp3MinR === CONFIG.tp.tp3MinR &&
        soft.poi.maxDistAtr === CONFIG.poi.maxDistAtr && Object.isFrozen(soft.require) && configFor('nope').strategy === 'strict';
      // Частый: зона необязательна и дальше, импульс слабее, место от 2.5R; риск и тренд — как в CONFIG.
      var fr = configFor('frequent');
      profiles = profiles && fr.poi.optional === true && fr.poi.maxDistAtr === 1 && fr.displacement.single === 1.2 &&
        fr.displacement.double === 1.6 && fr.tp.tp3MinR === 2.5 && fr.tp.tp3MaxR === CONFIG.tp.tp3MaxR &&
        fr.require.sweep === false && fr.sl.minRiskPct === CONFIG.sl.minRiskPct && CONFIG.poi.optional === false &&
        Signals.modeOf({ mode: 'frequent' }) === 'frequent' && Signals.modeOf({ mode: 'x' }) === 'strict' &&
        profileFor('frequent', 'scalp') === 'soft' && profileFor('frequent', 'main') === 'frequent' &&
        profileFor('frequent', 'swing') === 'frequent' && profileFor('soft', 'scalp') === 'soft' && profileFor('strict', 'scalp') === 'strict';
      // «Все сразу»: 5 таймфреймов; младшие — 5m, 15m, 1h; 15m держит 30 дней (средний ТФ скальпа).
      var all = tfPlanFor(['main', 'swing', 'scalp']), main = tfPlanFor(['main']);
      var keys = Object.keys(all).sort().join(',');
      var plan = keys === '15m,1d,1h,4h,5m' && all['5m'].ltf && all['15m'].ltf && all['1h'].ltf && !all['4h'].ltf && !all['1d'].ltf &&
        all['15m'].count >= 30 * 96 && all['1h'].count >= 30 * 24 && all['1d'].count >= CONFIG.windows.htf &&
        Object.keys(main).sort().join(',') === '15m,1h,4h' && main['15m'].ltf && !main['1h'].ltf &&
        tfPlanFor([], ['5m'])['5m'].ltf === true;
      // Проверка «Сигналов в день»: по монете один открытый сигнал (при равном времени — основной пресет),
      // общая пауза 8 свечей после SL; по дням считаются только полные сутки.
      var D = 86400000, b0 = new Date(2026, 0, 5).getTime();
      function ms(coin, pid, c, cl, out, filled) {
        return { sym: coin, coin: coin, preset: pid, createdT: b0 + c * H1, closedT: cl === null ? null : b0 + cl * H1, outcome: out || null, filledT: filled ? b0 + c * H1 : null, ltfMs: M15 };
      }
      var kept = Backtest.mergeLive([
        [ms('A', 'main', 1, 5, 'tp1', true), ms('A', 'main', 6.5, 8), ms('B', 'main', 2, 4)],
        [ms('A', 'swing', 3, 9), ms('A', 'swing', 30, 31)],
        [ms('A', 'scalp', 5, 6, 'sl', true), ms('B', 'scalp', 2, null)]
      ], ['main', 'swing', 'scalp'], 8);
      var ids = kept.map(function (s) { return s.coin + s.preset + (s.createdT - b0) / H1; }).join(',');
      var days = Backtest.countByDay(kept, b0 - 1, b0 + 2 * D), part = Backtest.countByDay(kept, b0 + H1 / 2, b0 + 2 * D);
      var sm = Backtest.liveSummary(kept, b0, b0 + 2 * D);
      var merge = ids === 'Amain1,Bmain2,Ascalp5,Aswing30' && days.length === 2 && days[0].n === 3 && days[0].e === 2 && days[1].n === 1 &&
        part.length === 1 && part[0].n === 1 && sm.ge3 === 1 && sm.zero === 0 && sm.avg === 2 && sm.min === 1 && sm.max === 3;
      // Месяцы — блоки по 30 дней от конца; хвост короче недели присоединяется к самому раннему блоку.
      var m65 = Backtest.monthBlocks([], 0, 65 * D), m90 = Backtest.monthBlocks([], 0, 90 * D);
      var months = sm.months.length === 1 && sm.months[0].signals === 4 && sm.posMonths === 0 &&
        m65.length === 2 && m65[0].days === 35 && m65[1].days === 30 && m90.length === 3 && m90.every(function (m) { return m.days === 30; });
      // Качественный режим: список монет раскрыт в массив, без TON, все монеты есть в широком списке.
      var q = CONFIG.qualityPreset;
      var quality = Array.isArray(q.symbols) && q.symbols.length > 0 && q.symbols.indexOf('TON') < 0 &&
        q.symbols.every(function (c) { return CONFIG.wideSymbols.indexOf(c) >= 0; }) && CONFIG.wideSymbols.length <= CONFIG.maxSymbols &&
        q.presets.every(function (p) { return !!CONFIG.presets[p]; }) && !!CONFIG.strategyModes[q.strategy] &&
        CONFIG.lifecycle.expiryOptions.indexOf(q.expiryBars) >= 0;
      // Разброс итога: одинаковые сделки — разброса нет; повтор даёт те же цифры (фиксированное зерно).
      function tr(r) { return { status: 'closed', filledT: 1, resultR: r }; }
      var allWin = Backtest.spread([tr(1), tr(1), tr(1), tr(1)], 200);
      var mixed = [tr(2), tr(-1), tr(-1), tr(0.3), tr(1.5), tr(-1.2)];
      var sp1 = Backtest.spread(mixed, 300), sp2 = Backtest.spread(mixed, 300);
      var spreadOk = allWin.p5 === 4 && allWin.p95 === 4 && allWin.pNeg === 0 && allWin.dd95 === 0 &&
        sp1.p5 === sp2.p5 && sp1.p95 === sp2.p95 && sp1.pNeg === sp2.pNeg && sp1.p5 <= sp1.p50 && sp1.p50 <= sp1.p95 &&
        sp1.pNeg > 0 && sp1.pNeg < 1 && Backtest.spread([tr(1)]) === null;
      // Варианты сопровождения: доли в сумме 1, текущий CONFIG.tp совпадает с одним из вариантов.
      var mv = CONFIG.managementVariants;
      var mgmt = Object.keys(mv).every(function (k) {
        var v = mv[k];
        return v.fractions.length === 3 && Math.abs(v.fractions[0] + v.fractions[1] + v.fractions[2] - 1) < 1e-9 && v.moveStop.length === 2;
      }) && !!Backtest.currentManagement();
      return profiles && plan && merge && months && quality && spreadOk && mgmt;
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
    app.lc = lcDefaults();
    UI.init(app);
    app.selfTest = runSelfTests();
    if (!app.selfTest.ok) log('error', 'Самопроверка не пройдена: ' + app.selfTest.failed.join('; '));
    feed = new Data.Feed(hooks);
    app.feed = feed;
    UI.renderStatus(feed.status);
    readHash();
    window.addEventListener('hashchange', function () { if (readHash() && app.focus) UI.show('best'); });
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
