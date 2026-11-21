/* SMC Signals — данные: хранилища (localStorage, IndexedDB), сетевой слой с лимитами и повторами,
   адаптеры бирж (Binance Futures, Binance Spot, Bybit v5) и live-лента с REST-опросом.
   Только публичные эндпоинты без ключей. Никаких ордеров. */
'use strict';

var Data = (function () {
  var C = CONFIG;
  var clockOffset = 0;
  function now() { return Date.now() + clockOffset; }
  function setClock(serverT) {
    if (typeof serverT === 'number' && isFinite(serverT) && serverT > 1e12) clockOffset = serverT - Date.now();
  }
  function msOf(tf) { return SMC.tfMs(tf); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // ---------- localStorage ----------
  var Store = {
    get: function (key, def) {
      try {
        var s = localStorage.getItem(key);
        if (s === null || s === undefined) return def;
        var v = JSON.parse(s);
        return (v === null || v === undefined) ? def : v;
      } catch (e) { return def; }
    },
    set: function (key, val) {
      try { localStorage.setItem(key, JSON.stringify(val)); return true; } catch (e) { return false; }
    },
    remove: function (key) {
      try { localStorage.removeItem(key); } catch (e) { /* хранилище недоступно */ }
    }
  };

  // ---------- IndexedDB: кэш истории для бэктеста ----------
  var Cache = (function () {
    var dbp = null, mem = new Map();
    function open() {
      if (dbp) return dbp;
      dbp = new Promise(function (resolve) {
        try {
          if (typeof indexedDB === 'undefined' || !indexedDB) { resolve(null); return; }
          var req = indexedDB.open(C.storage.idbName, 1);
          req.onupgradeneeded = function () {
            try {
              var db = req.result;
              if (!db.objectStoreNames.contains(C.storage.idbStore)) db.createObjectStore(C.storage.idbStore, { keyPath: 'key' });
            } catch (e) { /* без кэша */ }
          };
          req.onsuccess = function () { resolve(req.result); };
          req.onerror = function () { resolve(null); };
          req.onblocked = function () { resolve(null); };
        } catch (e) { resolve(null); }
      });
      return dbp;
    }
    function get(key) {
      return open().then(function (db) {
        if (!db) return mem.get(key) || null;
        return new Promise(function (resolve) {
          try {
            var tx = db.transaction(C.storage.idbStore, 'readonly');
            var r = tx.objectStore(C.storage.idbStore).get(key);
            r.onsuccess = function () { resolve(r.result || null); };
            r.onerror = function () { resolve(mem.get(key) || null); };
          } catch (e) { resolve(mem.get(key) || null); }
        });
      }).catch(function () { return null; });
    }
    function put(rec) {
      mem.set(rec.key, rec);
      return open().then(function (db) {
        if (!db) return false;
        return new Promise(function (resolve) {
          try {
            var tx = db.transaction(C.storage.idbStore, 'readwrite');
            tx.objectStore(C.storage.idbStore).put(rec);
            tx.oncomplete = function () { resolve(true); };
            tx.onerror = function () { resolve(false); };
            tx.onabort = function () { resolve(false); };
          } catch (e) { resolve(false); }
        });
      }).catch(function () { return false; });
    }
    function clear() {
      mem.clear();
      return open().then(function (db) {
        if (!db) return true;
        return new Promise(function (resolve) {
          try {
            var tx = db.transaction(C.storage.idbStore, 'readwrite');
            tx.objectStore(C.storage.idbStore).clear();
            tx.oncomplete = function () { resolve(true); };
            tx.onerror = function () { resolve(false); };
          } catch (e) { resolve(false); }
        });
      }).catch(function () { return false; });
    }
    return { get: get, put: put, clear: clear };
  })();

  // ---------- сеть ----------
  function NetError(kind, message, status) {
    var e = new Error(message);
    e.kind = kind;
    e.status = status || 0;
    return e;
  }
  function short(t) { t = String(t || ''); return t.length > 120 ? t.slice(0, 120) + '…' : t; }

  var Net = (function () {
    var active = 0, queue = [], wlog = [], hostPause = {}, hostGen = {}, timer = null;
    var stats = { requests: 0, errors: 0, retries: 0 };
    function hostOf(url) { var m = /^https?:\/\/([^\/?#]+)/i.exec(url); return m ? m[1] : ''; }
    function usedWeight(host) {
      var lim = Date.now() - 60000, s = 0;
      while (wlog.length && wlog[0].t < lim) wlog.shift();
      for (var k = 0; k < wlog.length; k++) if (wlog[k].host === host) s += wlog[k].w;
      return s;
    }
    function backoff(n) {
      var b = Math.min(C.network.backoffMaxMs, C.network.backoffBaseMs * Math.pow(2, Math.max(0, n - 1)));
      return Math.round(b * (0.8 + 0.4 * Math.random()));
    }
    function later(ms) {
      if (timer) return;
      timer = setTimeout(function () { timer = null; pump(); }, Math.max(50, ms));
    }
    function pump() {
      while (active < C.network.maxParallel && queue.length) {
        var nowT = Date.now(), pick = -1, wait = Infinity;
        for (var k = 0; k < queue.length; k++) {
          var j = queue[k];
          var w = 0;
          if (j.notBefore > nowT) w = j.notBefore - nowT;
          else if (hostPause[j.host] && hostPause[j.host] > nowT) w = hostPause[j.host] - nowT;
          else if (usedWeight(j.host) + j.weight > j.budget) w = 1000;
          if (w === 0) { pick = k; break; }
          if (w < wait) wait = w;
        }
        if (pick < 0) { later(wait); return; }
        var job = queue.splice(pick, 1)[0];
        active++;
        run(job);
      }
    }
    function finish(job, err, val) {
      active--;
      if (err) job.reject(err); else job.resolve(val);
      pump();
    }
    function retry(job, err, minDelay) {
      job.attempt++;
      stats.retries++;
      if (job.hgen !== (hostGen[job.host] || 0)) { finish(job, NetError('cancel', 'запрос отменён')); return; }
      if (job.attempt > job.retries || err.status === 418) { stats.errors++; finish(job, err); return; }
      active--;
      job.notBefore = Date.now() + Math.max(minDelay || 0, backoff(job.attempt));
      queue.push(job);
      pump();
    }
    function run(job) {
      stats.requests++;
      wlog.push({ t: Date.now(), host: job.host, w: job.weight });
      var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      var to = setTimeout(function () { if (ctrl) ctrl.abort(); }, C.network.timeoutMs);
      var init = { method: 'GET', cache: 'no-store', credentials: 'omit', mode: 'cors' };
      if (ctrl) init.signal = ctrl.signal;
      fetch(job.url, init).then(function (res) {
        clearTimeout(to);
        if (res.ok) {
          return res.json().then(function (j) { finish(job, null, j); }, function () {
            retry(job, NetError('parse', 'некорректный ответ сервера'));
          });
        }
        if (res.status === 429 || res.status === 418) {
          var ra = Number(res.headers.get('Retry-After'));
          var pause = res.status === 418 ? C.network.banPauseMs : (ra > 0 ? ra * 1000 : backoff(job.attempt + 1));
          hostPause[job.host] = Date.now() + pause;
          return retry(job, NetError('rate', (res.status === 418 ? 'IP временно заблокирован биржей (418)' : 'лимит запросов (429)'), res.status), pause);
        }
        if (res.status >= 500) return retry(job, NetError('http', 'ошибка сервера ' + res.status, res.status));
        return res.text().then(function (t) {
          stats.errors++;
          finish(job, NetError('bad', 'HTTP ' + res.status + (t ? ': ' + short(t) : ''), res.status));
        }, function () {
          stats.errors++;
          finish(job, NetError('bad', 'HTTP ' + res.status, res.status));
        });
      }, function (err) {
        clearTimeout(to);
        retry(job, NetError('net', err && err.name === 'AbortError' ? 'таймаут запроса' : 'нет связи с биржей (сеть недоступна или запрос заблокирован)'));
      });
    }
    function getJSON(url, o) {
      o = o || {};
      var host = hostOf(url);
      return new Promise(function (resolve, reject) {
        queue.push({
          url: url, host: host, weight: o.weight || 1, budget: o.budget || 1000,
          retries: o.retries === undefined || o.retries === null ? C.network.retries : o.retries,
          attempt: 0, notBefore: 0, resolve: resolve, reject: reject, hgen: hostGen[host] || 0
        });
        pump();
      });
    }
    // Отмена очереди запросов к хосту (при переключении источника), чтобы не занимать слоты.
    function cancelHost(host) {
      hostGen[host] = (hostGen[host] || 0) + 1;
      var keep = [];
      queue.forEach(function (j) {
        if (j.host === host) j.reject(NetError('cancel', 'запрос отменён'));
        else keep.push(j);
      });
      queue = keep;
    }
    return { getJSON: getJSON, cancelHost: cancelHost, hostOf: hostOf, stats: stats };
  })();

  // ---------- адаптеры бирж ----------
  function parseBinanceKlines(json) {
    if (!Array.isArray(json)) throw NetError('parse', 'неожиданный формат свечей');
    return json.map(function (k) { return { t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }; });
  }
  function parseBinanceTickers(json) {
    if (!Array.isArray(json)) throw NetError('parse', 'неожиданный формат цен');
    var out = {};
    json.forEach(function (x) { var p = +x.price; if (x && typeof x.symbol === 'string' && p > 0) out[x.symbol] = p; });
    return out;
  }
  function bybitCheck(json) {
    if (!json || typeof json !== 'object') throw NetError('parse', 'Bybit: пустой ответ');
    if (json.retCode !== 0) throw NetError(json.retCode === 10001 ? 'bad' : 'api', 'Bybit: ' + short(json.retMsg || ('код ' + json.retCode)));
    return json.result || {};
  }
  var BYBIT_IV = { '1m': '1', '5m': '5', '15m': '15', '30m': '30', '1h': '60', '2h': '120', '4h': '240', '1d': 'D' };

  var ADAPTERS = {
    binanceFutures: {
      id: 'binanceFutures', name: 'Binance Futures', market: 'futures',
      bases: ['https://fapi.binance.com'], maxLimit: 1500, budget: 1900,
      klines: function (base, sym, tf, o) {
        var u = base + '/fapi/v1/klines?symbol=' + encodeURIComponent(sym) + '&interval=' + tf + '&limit=' + o.limit;
        if (o.start != null) u += '&startTime=' + o.start;
        if (o.end != null) u += '&endTime=' + o.end;
        return u;
      },
      klinesWeight: function (limit) { return limit < 100 ? 1 : (limit < 500 ? 2 : (limit <= 1000 ? 5 : 10)); },
      parseKlines: parseBinanceKlines,
      tickers: function (base) { return [base + '/fapi/v2/ticker/price', base + '/fapi/v1/ticker/price']; },
      tickersWeight: 2,
      parseTickers: parseBinanceTickers,
      time: function (base) { return base + '/fapi/v1/time'; },
      parseTime: function (j) { return Number(j && j.serverTime); }
    },
    binanceSpot: {
      id: 'binanceSpot', name: 'Binance Spot', market: 'spot',
      bases: ['https://api.binance.com', 'https://data-api.binance.vision'], maxLimit: 1000, budget: 4800,
      klines: function (base, sym, tf, o) {
        var u = base + '/api/v3/klines?symbol=' + encodeURIComponent(sym) + '&interval=' + tf + '&limit=' + o.limit;
        if (o.start != null) u += '&startTime=' + o.start;
        if (o.end != null) u += '&endTime=' + o.end;
        return u;
      },
      klinesWeight: function () { return 2; },
      parseKlines: parseBinanceKlines,
      tickers: function (base, syms) {
        var u = base + '/api/v3/ticker/price';
        if (syms && syms.length) u += '?symbols=' + encodeURIComponent(JSON.stringify(syms));
        return [u];
      },
      tickersWeight: 4,
      parseTickers: parseBinanceTickers,
      time: function (base) { return base + '/api/v3/time'; },
      parseTime: function (j) { return Number(j && j.serverTime); }
    },
    bybit: {
      id: 'bybit', name: 'Bybit (USDT perp)', market: 'futures',
      bases: ['https://api.bybit.com'], maxLimit: 1000, budget: 1200,
      klines: function (base, sym, tf, o) {
        var iv = BYBIT_IV[tf];
        if (!iv) throw NetError('bad', 'Bybit: нет интервала ' + tf);
        var u = base + '/v5/market/kline?category=linear&symbol=' + encodeURIComponent(sym) + '&interval=' + iv + '&limit=' + o.limit;
        if (o.start != null) u += '&start=' + o.start;
        if (o.end != null) u += '&end=' + o.end;
        return u;
      },
      klinesWeight: function () { return 1; },
      parseKlines: function (json) {
        var r = bybitCheck(json);
        if (!Array.isArray(r.list)) throw NetError('parse', 'Bybit: нет списка свечей');
        return r.list.map(function (k) { return { t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }; });
      },
      tickers: function (base) { return [base + '/v5/market/tickers?category=linear']; },
      tickersWeight: 1,
      parseTickers: function (json) {
        var r = bybitCheck(json), out = {};
        (Array.isArray(r.list) ? r.list : []).forEach(function (x) { var p = +x.lastPrice; if (x && typeof x.symbol === 'string' && p > 0) out[x.symbol] = p; });
        return out;
      },
      time: function (base) { return base + '/v5/market/time'; },
      parseTime: function (j) {
        bybitCheck(j);
        if (j.time) return Number(j.time);
        return Number(j.result && j.result.timeSecond) * 1000;
      }
    }
  };

  // Приведение к единому формату {t,o,h,l,c,v,closed}. Пропускает NaN и нулевые цены, сортирует, убирает дубли.
  function normalize(rows, ms) {
    var out = [], nowT = now();
    for (var k = 0; k < rows.length; k++) {
      var r = rows[k];
      if (!r) continue;
      var t = r.t, o = r.o, h = r.h, l = r.l, c = r.c, v = r.v;
      if (!(isFinite(t) && t > 0 && isFinite(o) && isFinite(h) && isFinite(l) && isFinite(c))) continue;
      if (!(o > 0 && h > 0 && l > 0 && c > 0)) continue;
      if (!(isFinite(v) && v >= 0)) v = 0;
      var hh = Math.max(o, h, l, c), ll = Math.min(o, h, l, c);
      out.push({ t: t, o: o, h: hh, l: ll, c: c, v: v, closed: t + ms + C.network.closeGraceMs <= nowT });
    }
    out.sort(function (a, b) { return a.t - b.t; });
    var dedup = [];
    for (k = 0; k < out.length; k++) {
      if (dedup.length && dedup[dedup.length - 1].t === out[k].t) dedup[dedup.length - 1] = out[k];
      else dedup.push(out[k]);
    }
    return dedup;
  }

  function fetchTime(ad, base) {
    return Net.getJSON(ad.time(base), { weight: 1, budget: ad.budget, retries: 1 }).then(ad.parseTime);
  }
  var tickerUrlIdx = {};
  function fetchTickers(ad, base, syms, retries) {
    var urls = ad.tickers(base, syms);
    var start = tickerUrlIdx[ad.id] || 0;
    function attempt(k) {
      if (k >= urls.length) return Promise.reject(NetError('bad', 'нет эндпоинта цен'));
      return Net.getJSON(urls[k], { weight: ad.tickersWeight, budget: ad.budget, retries: retries }).then(function (j) {
        tickerUrlIdx[ad.id] = k;
        return ad.parseTickers(j);
      }, function (e) {
        if (e.kind === 'bad' && e.status === 404 && k + 1 < urls.length) return attempt(k + 1);
        throw e;
      });
    }
    return attempt(Math.min(start, urls.length - 1));
  }
  function fetchKlines(ad, base, sym, tf, limit, extra, retries) {
    var lim = Math.max(1, Math.min(ad.maxLimit, limit));
    var o = { limit: lim };
    if (extra) { o.start = extra.start; o.end = extra.end; }
    return Net.getJSON(ad.klines(base, sym, tf, o), { weight: ad.klinesWeight(lim), budget: ad.budget, retries: retries })
      .then(function (j) { return normalize(ad.parseKlines(j), msOf(tf)); });
  }
  // Постраничная загрузка истории [startT, endT] (время открытия свечей), только закрытые свечи.
  function fetchRange(ad, base, sym, tf, startT, endT, onPage) {
    var ms = msOf(tf), lim = ad.maxLimit, out = [], cur = startT, guard = 0;
    function next() {
      if (cur > endT || guard++ > 400) return Promise.resolve(out);
      var extra = ad.id === 'bybit' ? { start: cur, end: Math.min(endT, cur + lim * ms - 1) } : { start: cur, end: endT };
      return fetchKlines(ad, base, sym, tf, lim, extra).then(function (cds) {
        var got = cds.filter(function (c) { return c.t >= cur && c.t <= endT && c.closed; });
        if (!got.length) {
          if (ad.id === 'bybit') { cur += lim * ms; return next(); }
          return out;
        }
        for (var k = 0; k < got.length; k++) out.push(got[k]);
        cur = got[got.length - 1].t + ms;
        if (onPage) onPage(out.length);
        return next();
      });
    }
    return next();
  }
  // Последние count свечей (с незакрытой). Больше лимита биржи — старшая часть докачивается постранично.
  function fetchLatest(ad, base, sym, tf, count, retries) {
    var lim = Math.max(3, Math.min(count, ad.maxLimit));
    return fetchKlines(ad, base, sym, tf, lim, null, retries).then(function (latest) {
      if (count <= ad.maxLimit || !latest.length) return latest;
      var ms = msOf(tf), firstT = latest[0].t, startT = firstT - (count - latest.length) * ms;
      return fetchRange(ad, base, sym, tf, startT, firstT - ms).then(function (older) {
        return mergeSorted(older, latest);
      });
    });
  }
  function toRow(c) { return [c.t, c.o, c.h, c.l, c.c, c.v]; }
  function fromRow(r) { return { t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5], closed: true }; }
  function mergeSorted(a, b) {
    var map = new Map();
    a.forEach(function (c) { map.set(c.t, c); });
    b.forEach(function (c) { map.set(c.t, c); });
    var out = Array.from(map.values());
    out.sort(function (x, y) { return x.t - y.t; });
    return out;
  }
  // История с кэшем в IndexedDB: докачиваются только недостающие участки.
  function loadHistory(ad, base, sym, tf, startT, endT, onPage) {
    var ms = msOf(tf), key = ad.id + '|' + sym + '|' + tf;
    return Cache.get(key).then(function (rec) {
      var have = (rec && Array.isArray(rec.rows)) ? rec.rows.map(fromRow) : [];
      var coveredFrom = rec && isFinite(rec.coveredFrom) ? rec.coveredFrom : (have.length ? have[0].t : Infinity);
      var tasks = [];
      if (!have.length) tasks.push([startT, endT]);
      else {
        if (startT < coveredFrom) tasks.push([startT, have[0].t - ms]);
        if (have[have.length - 1].t < endT) tasks.push([have[have.length - 1].t + ms, endT]);
      }
      var fetched = 0;
      var chain = Promise.resolve();
      tasks.forEach(function (rg) {
        chain = chain.then(function () {
          if (rg[1] < rg[0]) return null;
          return fetchRange(ad, base, sym, tf, rg[0], rg[1], function (n) { if (onPage) onPage(fetched + n); }).then(function (rows) {
            fetched += rows.length;
            have = mergeSorted(have, rows);
          });
        });
      });
      return chain.then(function () {
        var cutoff = now();
        have = have.filter(function (c) { return c.t + ms + C.network.closeGraceMs <= cutoff; });
        var maxKeep = 60000;
        if (have.length > maxKeep) have = have.slice(have.length - maxKeep);
        // coveredFrom: до этого момента история уже запрашивалась (раньше листинга монеты свечей нет).
        var cf = Math.min(coveredFrom, startT);
        if (tasks.length) Cache.put({ key: key, rows: have.map(toRow), coveredFrom: cf, updated: Date.now() });
        return have.filter(function (c) { return c.t >= startT && c.t <= endT; });
      });
    });
  }

  // =====================================================================================
  // LIVE-ЛЕНТА: REST-опрос каждые 20 с, свечи всех монет и цены одним запросом.
  // =====================================================================================
  // План данных символа задаёт приложение (hooks.getPlan): {tf: {count, ltf}} — какие таймфреймы держать,
  // сколько свечей и какие из них младшие (по ним сигналы и сопровождение, опрос на каждом цикле).
  function Feed(hooks) {
    this.hooks = hooks;           // {getSettings, getPlan, onStatus, onReady, onUpdate, onLog}
    this.gen = 0;
    this.adapter = null;
    this.base = '';
    this.coins = [];              // [{coin, sym, replaces}]
    this.extra = [];              // символы только для сопровождения открытых сигналов
    this.raw = {};                // sym → {c: {tf: свечи}, form: {tf: незакрытая}, plan, full}
    this.prices = {};
    this.btcSym = C.btcCoin + C.quote;
    this.hasBtc = false;
    this.failCycles = 0;
    this.timer = null;
    this.order = [];
    this.orderIdx = 0;
    this.status = { state: 'idle', source: '', sourceId: '', market: '', lastUpdate: 0, error: '', notes: [] };
  }
  Feed.prototype.planOf = function (sym, full) {
    var p = this.hooks.getPlan ? this.hooks.getPlan(sym, !!full) : null;
    if (p && Object.keys(p).length) return p;
    var t = C.timeframes, out = {};
    out[t.ltf] = { count: C.live.load.ltf, ltf: true };
    if (full) { out[t.mtf] = { count: C.live.load.mtf, ltf: false }; out[t.htf] = { count: C.live.load.htf, ltf: false }; }
    return out;
  };
  // Самый мелкий младший ТФ среди загруженных символов — под его закрытия подстраивается опрос.
  Feed.prototype.finestMs = function () {
    var best = Infinity, raw = this.raw;
    Object.keys(raw).forEach(function (sym) {
      var p = raw[sym].plan || {};
      Object.keys(p).forEach(function (tf) { if (p[tf].ltf) best = Math.min(best, msOf(tf)); });
    });
    return isFinite(best) ? best : msOf(C.timeframes.ltf);
  };
  Feed.prototype.setStatus = function (state, error) {
    this.status.state = state;
    if (error !== undefined) this.status.error = error;
    if (this.hooks.onStatus) this.hooks.onStatus(this.status);
  };
  Feed.prototype.log = function (level, text) { if (this.hooks.onLog) this.hooks.onLog(level, text); };
  Feed.prototype.stop = function () {
    this.gen++;
    this.busy = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  };
  Feed.prototype.cancelRequests = function (ad) {
    if (ad) ad.bases.forEach(function (b) { Net.cancelHost(Net.hostOf(b)); });
  };
  Feed.prototype.start = function (fromIdx) {
    this.stop();
    this.cancelRequests(this.adapter);
    var s = this.hooks.getSettings();
    this.order = s.source === 'auto' ? C.sourceOrder.slice() : [s.source];
    this.orderIdx = fromIdx || 0;
    this.tryInit(this.gen);
  };
  Feed.prototype.tryInit = function (gen) {
    var self = this;
    if (gen !== this.gen) return;
    if (this.orderIdx >= this.order.length) {
      var last = this.status.error ? ' (последняя ошибка — ' + this.status.error + ')' : '';
      this.setStatus('error', 'Все источники недоступны' + last + '. Повтор через 30 с');
      this.timer = setTimeout(function () { if (gen === self.gen) { self.orderIdx = 0; self.tryInit(gen); } }, 30000);
      return;
    }
    var id = this.order[this.orderIdx];
    this.init(id, gen).then(function (ok) {
      if (!ok || gen !== self.gen) return;
      self.failCycles = 0;
      self.schedule(gen);
    }, function (e) {
      if (gen !== self.gen) return;
      var nm = ADAPTERS[id] ? ADAPTERS[id].name : id;
      self.log('warn', 'Источник ' + nm + ' недоступен: ' + e.message);
      self.status.error = nm + ': ' + e.message;
      self.cancelRequests(ADAPTERS[id]);
      self.adapter = null;
      self.orderIdx++;
      self.tryInit(gen);
    });
  };
  Feed.prototype.init = function (id, gen) {
    var self = this, ad = ADAPTERS[id];
    if (!ad) return Promise.reject(new Error('неизвестный источник'));
    this.status.source = ad.name;
    this.status.sourceId = ad.id;
    this.status.market = ad.market;
    this.status.notes = [];
    this.status.progress = '';
    this.setStatus('loading'); // последняя ошибка остаётся видна, пока перебираем источники
    var bases = ad.bases.slice(), lastErr = null;
    function pickBase(k) {
      if (k >= bases.length) return Promise.reject(lastErr || new Error('нет связи'));
      return fetchTime(ad, bases[k]).then(function (t) { setClock(t); return bases[k]; }, function (e) { lastErr = e; return pickBase(k + 1); });
    }
    return pickBase(0).then(function (base) {
      if (gen !== self.gen) return false;
      self.adapter = ad;
      self.base = base;
      return fetchTickers(ad, base, null, 2).then(function (all) {
        if (gen !== self.gen) return false;
        return self.resolveAndLoad(all, gen);
      });
    });
  };
  // Подбор монет: если пары нет на источнике — следующая из CONFIG.reserveSymbols.
  Feed.prototype.resolveAndLoad = function (all, gen) {
    var self = this, s = this.hooks.getSettings();
    var want = (s.symbols && s.symbols.length ? s.symbols : C.symbols).slice();
    var reserve = C.reserveSymbols.filter(function (c) { return want.indexOf(c) < 0; });
    var used = {}, coins = [], notes = [];
    function nextReserve() {
      for (var k = 0; k < reserve.length; k++) {
        var r = reserve[k];
        if (!used[r] && all[r + C.quote] != null) { used[r] = true; return r; }
      }
      return null;
    }
    want.forEach(function (coin) {
      var sym = coin + C.quote;
      if (all[sym] != null && !used[coin]) { used[coin] = true; coins.push({ coin: coin, sym: sym }); return; }
      var rep = nextReserve();
      if (rep) { coins.push({ coin: rep, sym: rep + C.quote, replaces: coin }); notes.push(coin + ' нет на источнике → ' + rep); }
      else notes.push(coin + ' нет на источнике, замены нет');
    });
    this.hasBtc = all[this.btcSym] != null;
    if (!this.hasBtc) notes.push('BTC недоступен — фильтр по BTC отключён');
    this.raw = {};
    this.prices = {};
    var load = coins.map(function (c) { return c.sym; });
    if (this.hasBtc && load.indexOf(this.btcSym) < 0) load.push(this.btcSym);
    var extraSyms = this.extra.filter(function (x) { return load.indexOf(x) < 0 && all[x] != null; });
    var done = 0;
    function tick() {
      done++;
      self.status.progress = 'загрузка ' + Math.min(done, load.length) + '/' + load.length;
      self.setStatus('loading');
    }
    // При старте — мало повторов: если источник не отвечает, быстрее переходим к следующему.
    return Promise.all(load.map(function (sym) {
      return self.loadSym(sym, true, 1).then(function () { tick(); return null; }, function (e) { tick(); return e; });
    }).concat(extraSyms.map(function (sym) {
      return self.loadSym(sym, false, 1).then(function () { return null; }, function () { return null; });
    }))).then(function (errs) {
      if (gen !== self.gen) return false;
      function isNet(e) { return e && e.kind !== 'bad' && e.kind !== 'stale'; }
      var netFails = 0;
      load.forEach(function (sym, k) { if (isNet(errs[k])) netFails++; });
      if (netFails >= Math.max(1, Math.ceil(load.length / 3))) {
        throw new Error('источник не отвечает: не загрузились ' + netFails + ' из ' + load.length + ' монет');
      }
      // Нет свежих свечей или ошибка символа — заменить запасной монетой; сетевая ошибка — догрузить позже.
      var tasks = [];
      coins.forEach(function (c, k) {
        var e = errs[load.indexOf(c.sym)];
        if (!e) return;
        if (isNet(e)) { c.pending = true; notes.push(c.coin + ': ' + e.message + ' — догружу позже'); return; }
        delete self.raw[c.sym];
        var rep = nextReserve();
        notes.push(c.coin + ': ' + e.message + (rep ? ' → ' + rep : ''));
        if (rep) {
          var nc = { coin: rep, sym: rep + C.quote, replaces: c.replaces || c.coin };
          coins[k] = nc;
          tasks.push(self.loadSym(nc.sym, true, 1).then(function () { return null; }, function (e2) {
            if (isNet(e2)) { nc.pending = true; notes.push(rep + ': ' + e2.message + ' — догружу позже'); }
            else { coins[k] = null; notes.push(rep + ': ' + e2.message); delete self.raw[nc.sym]; }
          }));
        } else coins[k] = null;
      });
      var btcErr = errs[load.indexOf(self.btcSym)];
      if (self.hasBtc && btcErr && !isNet(btcErr) && !coins.some(function (c) { return c && c.sym === self.btcSym; })) {
        self.hasBtc = false;
        notes.push('BTC не загрузился — фильтр по BTC отключён');
      }
      return Promise.all(tasks).then(function () {
        if (gen !== self.gen) return false;
        coins = coins.filter(function (c) { return !!c; });
        if (!coins.some(function (c) { return !c.pending; })) throw new Error('ни одна монета не загрузилась');
        self.coins = coins;
        self.status.progress = '';
        Object.keys(all).forEach(function (sym) { if (self.raw[sym]) self.prices[sym] = all[sym]; });
        self.status.notes = notes;
        notes.forEach(function (n) { self.log('info', n); });
        self.lastProbe = Date.now();
        self.status.lastUpdate = now();
        self.setStatus('ok', '');
        if (self.hooks.onReady) self.hooks.onReady();
        return true;
      });
    });
  };
  Feed.prototype.loadSym = function (sym, full, retries) {
    var self = this, ad = this.adapter, base = this.base;
    var plan = this.planOf(sym, full);
    var r = { c: {}, form: {}, plan: plan, full: !!full };
    return Promise.all(Object.keys(plan).map(function (tf) {
      return fetchLatest(ad, base, sym, tf, plan[tf].count, retries).then(function (cds) {
        var closed = cds.filter(function (c) { return c.closed; });
        var form = cds.filter(function (c) { return !c.closed; });
        if (!closed.length) throw NetError('stale', 'нет свечей ' + tf);
        var last = closed[closed.length - 1].t, ms = msOf(tf);
        if (now() - (last + ms) > 3 * ms + C.network.closeGraceMs) throw NetError('stale', 'нет свежих свечей ' + tf + ' (пара не торгуется)');
        r.c[tf] = closed;
        r.form[tf] = form.length ? form[form.length - 1] : null;
      });
    })).then(function () { self.raw[sym] = r; return r; });
  };
  Feed.prototype.allSyms = function () {
    var out = this.coins.map(function (c) { return c.sym; });
    if (this.hasBtc && out.indexOf(this.btcSym) < 0) out.push(this.btcSym);
    var self = this;
    this.extra.forEach(function (x) { if (out.indexOf(x) < 0 && self.raw[x]) out.push(x); });
    return out;
  };
  // Символы, которые нужно сопровождать только по 15m (открытые сигналы по монетам вне списка).
  Feed.prototype.setExtra = function (syms) {
    var self = this;
    var add = syms.filter(function (s) { return self.extra.indexOf(s) < 0; });
    this.extra = syms.slice();
    add.forEach(function (sym) {
      if (!self.adapter || self.raw[sym]) return;
      self.loadSym(sym, false).then(null, function (e) { self.log('warn', sym + ': ' + e.message); });
    });
  };
  // Обновление одного ТФ символа. Возвращает число новых закрытых свечей.
  Feed.prototype.refresh = function (sym, tf) {
    var r = this.raw[sym], ms = msOf(tf), arr = r.c[tf] || [];
    var lastT = arr.length ? arr[arr.length - 1].t : null;
    var expected = Math.floor((now() - C.network.closeGraceMs) / ms) * ms - ms;
    var loadN = r.plan[tf] ? r.plan[tf].count : C.live.load.ltf;
    var gap = lastT === null || expected - lastT > 2 * ms;
    var req = gap ? fetchLatest(this.adapter, this.base, sym, tf, loadN) : fetchKlines(this.adapter, this.base, sym, tf, 3);
    return req.then(function (cds) {
      var added = 0, form = null, cur = r.c[tf] || [];
      if (gap) {
        var closed = cds.filter(function (c) { return c.closed; });
        added = lastT === null ? closed.length : closed.filter(function (c) { return c.t > lastT; }).length;
        r.c[tf] = closed;
        var f = cds.filter(function (c) { return !c.closed; });
        form = f.length ? f[f.length - 1] : null;
      } else {
        cds.forEach(function (c) {
          if (!c.closed) { form = c; return; }
          if (!cur.length || c.t > cur[cur.length - 1].t) { cur.push(c); added++; }
          else {
            var k = SMC.indexOfTime(cur, c.t);
            if (k >= 0) cur[k] = c;
          }
        });
        r.c[tf] = cur;
      }
      var keep = loadN + 200;
      if (r.c[tf].length > keep) r.c[tf].splice(0, r.c[tf].length - keep);
      r.form[tf] = form;
      return added;
    });
  };
  Feed.prototype.refreshIfDue = function (sym, tf) {
    var r = this.raw[sym], ms = msOf(tf), arr = r.c[tf] || [];
    var expected = Math.floor((now() - C.network.closeGraceMs) / ms) * ms - ms;
    if (arr.length && arr[arr.length - 1].t >= expected) return Promise.resolve(0);
    return this.refresh(sym, tf);
  };
  Feed.prototype.tickerSyms = function () {
    return this.adapter && this.adapter.id === 'binanceSpot' ? this.allSyms() : null;
  };
  Feed.prototype.schedule = function (gen) {
    var self = this;
    if (gen !== this.gen) return;
    if (this.timer) clearTimeout(this.timer);
    var ms = this.finestMs(), t = now();
    var nextClose = Math.floor(t / ms) * ms + ms + C.network.closeGraceMs + 400;
    var delay = Math.max(1000, Math.min(C.network.pollMs, nextClose - t));
    this.timer = setTimeout(function () { self.cycle(gen); }, delay);
  };
  // Догрузка монет, которые не загрузились при старте из-за сети (не больше двух за цикл).
  Feed.prototype.loadPending = function (closedNew) {
    var self = this, todo = [];
    this.coins.forEach(function (c) {
      if ((c.pending || !self.raw[c.sym]) && (c.tries || 0) < 10) todo.push(c);
    });
    if (this.hasBtc && !this.raw[this.btcSym] && !todo.some(function (c) { return c.sym === self.btcSym; })) {
      todo.push({ sym: this.btcSym, coin: C.btcCoin, context: true });
    }
    return Promise.all(todo.slice(0, 2).map(function (c) {
      c.tries = (c.tries || 0) + 1;
      return self.loadSym(c.sym, true, 1).then(function () {
        c.pending = false;
        closedNew[c.sym] = { _reload: true }; // приложение прогонит догрузку последних свечей
        self.log('info', c.coin + ': данные догружены');
      }, function (e) { self.log('warn', c.coin + ': ' + e.message); });
    }));
  };
  // В режиме «Авто» после сбоя лента работает на резервном источнике. Раз в 10 минут проверяем,
  // ответил ли более приоритетный источник, и если да — возвращаемся к нему.
  Feed.prototype.probePreferred = function (gen) {
    var self = this, s = this.hooks.getSettings();
    if (s.source !== 'auto' || !this.adapter) return;
    var curIdx = C.sourceOrder.indexOf(this.adapter.id);
    if (curIdx <= 0) return;
    var t = Date.now();
    if (this.lastProbe && t - this.lastProbe < C.network.preferProbeMs) return;
    this.lastProbe = t;
    var pref = ADAPTERS[C.sourceOrder[0]];
    Net.getJSON(pref.time(pref.bases[0]), { weight: 1, budget: pref.budget, retries: 0 }).then(function (j) {
      if (gen !== self.gen || !(pref.parseTime(j) > 0)) return;
      self.log('info', 'Источник ' + pref.name + ' снова доступен — возвращаюсь к нему');
      self.start(0);
    }, function () { /* приоритетный источник всё ещё недоступен — остаёмся на текущем */ });
  };
  // Внеочередной опрос (например, при возврате на вкладку).
  Feed.prototype.kick = function () {
    if (!this.adapter || this.busy) return;
    if (this.timer) clearTimeout(this.timer);
    this.cycle(this.gen);
  };
  Feed.prototype.cycle = function (gen) {
    var self = this;
    if (gen !== this.gen || !this.adapter) return;
    if (this.busy) { this.schedule(gen); return; }
    this.busy = true;
    var syms = this.allSyms(), errors = [], closedNew = {};
    fetchTickers(this.adapter, this.base, this.tickerSyms()).then(function (tick) {
      Object.keys(tick).forEach(function (sym) { if (self.raw[sym]) self.prices[sym] = tick[sym]; });
    }, function (e) { errors.push('цены: ' + e.message); }).then(function () {
      // Младшие ТФ плана опрашиваются каждый цикл (новые закрытия и незакрытая свеча), старшие — когда пора.
      return Promise.all(syms.map(function (sym) {
        var r = self.raw[sym];
        if (!r) return null;
        var plan = r.plan || {}, out = {};
        closedNew[sym] = out;
        var tfs = Object.keys(plan).sort(function (a, b) { return msOf(a) - msOf(b); });
        var chain = Promise.resolve();
        tfs.forEach(function (tf) {
          chain = chain.then(function () {
            return (plan[tf].ltf ? self.refresh(sym, tf) : self.refreshIfDue(sym, tf)).then(function (n) { out[tf] = n; });
          });
        });
        return chain.then(null, function (e) { errors.push(sym + ': ' + e.message); });
      }));
    }).then(function () {
      return self.loadPending(closedNew);
    }).then(function () {
      self.busy = false;
      if (gen !== self.gen) return;
      var total = syms.length + 1;
      if (errors.length >= total) throw new Error(errors[0]);
      self.failCycles = 0;
      self.status.lastUpdate = now();
      self.setStatus(errors.length ? 'warn' : 'ok', errors.length ? errors.slice(0, 3).join('; ') : '');
      try {
        if (self.hooks.onUpdate) self.hooks.onUpdate({ closedNew: closedNew });
      } catch (e2) { self.log('error', 'Ошибка обработки данных: ' + e2.message); }
      self.schedule(gen);
      self.probePreferred(gen);
    }).then(null, function (e) {
      self.busy = false;
      if (gen !== self.gen) return;
      self.failCycles++;
      self.setStatus('error', e.message || String(e));
      var s = self.hooks.getSettings();
      if (s.source === 'auto' && self.failCycles >= C.network.failCyclesToSwitch) {
        self.log('warn', 'Источник ' + self.status.source + ' не отвечает ' + self.failCycles + ' цикла подряд — переключаюсь на следующий.');
        var idx = C.sourceOrder.indexOf(self.status.sourceId);
        self.start(idx + 1 < C.sourceOrder.length ? idx + 1 : 0);
        return;
      }
      self.schedule(gen);
    });
  };

  return {
    now: now, sleep: sleep, Store: Store, Cache: Cache, Net: Net, NetError: NetError, ADAPTERS: ADAPTERS,
    normalize: normalize, fetchKlines: fetchKlines, fetchRange: fetchRange, fetchLatest: fetchLatest, fetchTickers: fetchTickers,
    fetchTime: fetchTime, loadHistory: loadHistory, Feed: Feed, setClock: setClock
  };
})();
