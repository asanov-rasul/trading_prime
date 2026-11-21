/* SMC Signals — единый объект параметров.
   Все правила стратегии читают значения только отсюда. Параметры фиксированы и не подгоняются под историю. */
'use strict';

var CONFIG = (function () {
  var cfg = {
    version: '1.6.1',

    // Монеты (пары к USDT, без стейблкоинов). Первые восемь — крупнейшие не-стейблкоины по капитализации
    // на 16.11.2026 (Coinfomania по данным CoinMarketCap); DOGE и ADA — популярные ликвидные монеты.
    symbols: ['BTC', 'ETH', 'BNB', 'XRP', 'SOL', 'TRX', 'HYPE', 'ZEC', 'DOGE', 'ADA'],
    // Запасные монеты на случай, если пары нет на источнике.
    reserveSymbols: ['LINK', 'AVAX', 'SUI', 'LTC'],
    // Расширенный список (29 ликвидных пар) — больше рынков при тех же правилах. TON убран 21.11.2026: его нет
    // ни на фьючерсах, ни на споте Binance.
    extendedSymbols: ['BTC', 'ETH', 'BNB', 'XRP', 'SOL', 'TRX', 'HYPE', 'ZEC', 'DOGE', 'ADA',
      'LINK', 'AVAX', 'SUI', 'LTC', 'DOT', 'BCH', 'NEAR', 'APT', 'UNI', 'AAVE',
      'XLM', 'HBAR', 'ETC', 'FIL', 'ATOM', 'ARB', 'OP', 'INJ', 'WLD'],
    // Широкий список (60): расширенный и 31 монета, отобранная 21.11.2026 заранее заданным правилом: наибольший
    // объём за 24 ч на Binance Futures, торгуется и на споте Binance, на бирже не меньше 200 дней, без стейблкоинов
    // и токенов золота. На этих 31 монетах мягкий профиль на истории терял (180 дней: −6.1R), поэтому в
    // качественный режим они не вошли; список оставлен для наблюдения.
    wideSymbols: ['BTC', 'ETH', 'BNB', 'XRP', 'SOL', 'TRX', 'HYPE', 'ZEC', 'DOGE', 'ADA',
      'LINK', 'AVAX', 'SUI', 'LTC', 'DOT', 'BCH', 'NEAR', 'APT', 'UNI', 'AAVE',
      'XLM', 'HBAR', 'ETC', 'FIL', 'ATOM', 'ARB', 'OP', 'INJ', 'WLD',
      'KERNEL', 'MMT', 'ENA', 'CYBER', 'TAO', 'PUMP', 'TRUMP', 'ENSO', 'HUMA', 'RARE',
      'ASTER', 'ONDO', 'BARD', 'QNT', 'FET', 'PROM', 'ZRO', 'PENGU', 'WLFI', 'ICP',
      'XPL', 'BREV', 'JUP', 'STRK', 'CRV', 'YB', 'TIA', 'DASH', 'BLUR', 'HMSTR', 'ETHFI'],
    maxSymbols: 60,
    quote: 'USDT',
    btcCoin: 'BTC',

    // Связка таймфреймов live-режима.
    timeframes: { htf: '4h', mtf: '1h', ltf: '15m' },

    // Пресеты бэктеста.
    presets: {
      main: { id: 'main', name: 'Основной 4H/1H/15m', short: 'основной', htf: '4h', mtf: '1h', ltf: '15m' },
      swing: { id: 'swing', name: 'Свинг 1D/4H/1H', short: 'свинг', htf: '1d', mtf: '4h', ltf: '1h' },
      scalp: { id: 'scalp', name: 'Скальп 1H/15m/5m', short: 'скальп', htf: '1h', mtf: '15m', ltf: '5m' }
    },
    defaultPreset: 'main',

    // Окна анализа (количество свечей).
    windows: { ltf: 300, mtf: 200, htf: 200 },
    // Минимум свечей в окне, чтобы анализ имел смысл.
    minBars: { ltf: 120, mtf: 80, htf: 60 },
    // Доп. история перед окном старшего ТФ для прогрева EMA200.
    emaWarmupBars: 300,

    // Индикаторы.
    swingN: 3,              // фрактал: N свечей слева и справа
    atrPeriod: 14,
    ema: { fast: 50, slow: 200 },

    // Ликвидность.
    liquidity: {
      eqTolPct: 0.001,      // equal highs/lows: max(0.1% цены, 0.15×ATR)
      eqTolAtr: 0.15,
      sweepLookback: 20     // sweep ищем среди последних N свечей 15m перед триггером
    },

    // Displacement.
    displacement: {
      single: 1.5,          // тело ≥ 1.5×ATR(14)
      double: 2.0,          // две свечи подряд с суммарным телом ≥ 2×ATR
      volMult: 1.5,         // объём ≥ 1.5× среднего за 20 свечей
      volLookback: 20
    },

    // Order Block.
    ob: { zone: 'body', maxLookback: 10 },   // zone: 'body' | 'wick'

    // FVG.
    fvg: { minAtr: 0.1, maxFill: 0.5 },

    // Зона интереса 1H: цена внутри или не дальше 0.5×ATR(1H). optional — зона даёт баллы, но не обязательна.
    poi: { maxDistAtr: 0.5, optional: false },

    // OTE.
    ote: { lo: 0.62, hi: 0.79 },

    // Вход: 'mid' — середина зоны, 'edge' — ближайшая к цене граница.
    entryMode: 'mid',

    // Стоп.
    sl: { bufferAtr: 0.25, minRiskPct: 0.25, maxRiskPct: 3 },

    // Тейки: множители R, доли закрытия и перенос стопа.
    tp: {
      r: [1, 2],              // TP1 = 1R, TP2 = 2R
      tp3MinR: 3,             // TP3 не ближе 3R
      tp3MaxR: 5,             // и не дальше 5R
      fractions: [0.4, 0.3, 0.3],
      // Перенос стопа: после TP1 — не двигаем, после TP2 → безубыток (вход + комиссии). В промпте было
      // ['be', 'tp1']. Сменено 21.11.2026 по правилу, заданному до проверки (вариант должен быть лучше на обоих
      // отрезках): мягкий профиль, основной + свинг, 29 монет, свечи Binance Spot — последние 180 дней −6.2R → +1.9R,
      // предыдущие 180 дней −16.1R → −10.4R. Стратегия на независимом отрезке в минусе при любом варианте.
      moveStop: [null, 'be']
    },

    // Жизненный цикл сигнала.
    lifecycle: {
      expiryBars: 12,                // вход не случился за 12 свечей 15m → просрочен (по промпту)
      expiryOptions: [12, 24, 48, 96], // варианты настройки «Ожидание входа»: 3, 6, 12, 24 ч на 15m
      cooldownBars: 8,               // пауза после SL
      cancelIfTp1BeforeEntry: false, // true — отменять ожидающий вход, если цена дошла до TP1 раньше входа
      // true — отменять ожидающий вход, если цена дошла до TP3 раньше входа. Выключено: на истории основного
      // пресета это убирало большинство прибыльных поздних входов (12 сделок → 3, +2.4R → −0.47R за 180 дней).
      cancelIfTp3BeforeEntry: false
    },

    // Валидатор. Правило «цена уже прошла TP1»:
    //  'retest'  — для лимитного входа на ретесте проверяется только, что цена не прошла вход
    //              (импульс-триггер обычно уже выше 1R от входа в OB/OTE — это нормальная геометрия ретеста);
    //  'literal' — буквально: на момент публикации цена не должна быть за TP1 (отсекает почти все сетапы).
    validator: { tp1Rule: 'retest' },

    // Обязательные условия сценария входа.
    require: { sweep: true, displacement: true },

    // Диапазон Premium/Discount: 'htf' — от swing low до swing high на 4H (по промпту), 'mtf' — на 1H.
    pdRange: 'htf',

    // Профили стратегии. strict — строго по промпту. soft — ослабленный профиль, заданный заранее
    // (параметры не подбирались по истории):
    //  1) sweep не обязателен — как в таблице score, где он фактор на 15 баллов, а не обязательное условие;
    //  2) Premium/Discount по диапазону 1H (откат внутри тренда 4H), а не по большому диапазону 4H;
    //  3) вход у ближней к цене границы зоны (entryMode 'edge') — его чаще достигает ретест.
    // Остальные правила (тренд 4H, свежая зона 1H, CHoCH/BOS с displacement, риск, 3R, валидатор) те же.
    // frequent — для частых сигналов, тоже задан заранее: всё из мягкого, плюс
    //  4) зона среднего ТФ желательна (+баллы за качество зоны), но не обязательна, и допускается дальше — до 1×ATR;
    //  5) импульс слабее: тело от 1.2×ATR (пара свечей — от 1.6×ATR);
    //  6) место для хода от 2.5R (TP3 всё равно дальше TP2).
    // Тренд старшего ТФ, Premium/Discount, слом CHoCH/BOS, риск 0.25–3% и двойная проверка остаются.
    defaultStrategy: 'strict',
    strategyModes: {
      strict: { name: 'Строгий (по промпту)', short: 'строгий' },
      soft: { name: 'Мягкий', short: 'мягкий', require: { sweep: false }, pdRange: 'mtf', entryMode: 'edge' },
      frequent: {
        name: 'Частый', short: 'частый', require: { sweep: false }, pdRange: 'mtf', entryMode: 'edge',
        poi: { optional: true, maxDistAtr: 1.0 }, displacement: { single: 1.2, double: 1.6 }, tp: { tp3MinR: 2.5 }
      }
    },
    // Профиль по пресету: в частом профиле скальп работает по мягким правилам. На 5m ослабленные фильтры дают
    // слишком много шума: 30 монет × 30 дней — частый на скальпе −15.6R (контроль −11.6R), мягкий +2.2R.
    profileByPreset: { frequent: { scalp: 'soft' } },
    // Режим «3+ сигнала в день» (частый профиль, все пресеты) убран 21.11.2026: на 90 днях (23.08–21.11, 30 монет)
    // он дал −14.6R, в плюсе был только последний месяц из трёх.
    // Качественный режим — его же использует Telegram-бот (bot/run.js). Профиль, пресеты, ожидание входа,
    // minScore и монеты. Состав выбран по проверке на истории по правилу, заданному до прогона (см. отчёт 21.11).
    // Проверка 21.11.2026 (180 дней, мягкий профиль, minScore 60, 96 свечей): основной на 29 монетах +2.9R
    // (40 сделок, 4 из 6 месяцев в плюсе); на 31 новой монете −6.1R — не взяты; свинг +0.03R на 8 сделках —
    // формально прошёл правило; ожидание 192 свечи хуже (−2.3R) — не взято.
    // source — свечи Binance Spot: их же получает Telegram-бот на серверах GitHub (фьючерсы оттуда недоступны),
    // поэтому приложение и бот видят одни и те же сигналы. Комиссия при этом считается по рынку, где вы торгуете.
    qualityPreset: { strategy: 'soft', presets: ['main', 'swing'], expiryBars: 96, minScore: 60, symbols: 'extended', source: 'binanceSpot' },
    // «Стоп-кран»: предупредить, если реальные сделки идут заметно хуже истории — lossStreak неуспешных подряд
    // или итог за windowDays дней ниже −lossR. Пороги заданы заранее (не по истории).
    guard: { lossStreak: 5, windowDays: 30, lossR: 5 },
    // Варианты сопровождения сделки для сравнения в бэктесте (заданы до проверки). base — как в промпте.
    // moveStop[k] — куда перенести стоп после TP(k+1): 'be' — безубыток, 'tp1' — на TP1, null — не двигать.
    managementVariants: {
      base: { name: 'Как в промпте: 40/30/30, после TP1 — безубыток', fractions: [0.4, 0.3, 0.3], moveStop: ['be', 'tp1'] },
      beAfterTp2: { name: 'Безубыток только после TP2', fractions: [0.4, 0.3, 0.3], moveStop: [null, 'be'] },
      half: { name: '50% на TP1, затем безубыток', fractions: [0.5, 0.25, 0.25], moveStop: ['be', 'tp1'] }
    },

    // Веса score (сумма максимумов = 100).
    weights: {
      trend: 15, ema200: 5,          // тренд 4H (обязательно) + бонус за EMA200 = 20
      pd: 10,                        // верная зона Premium/Discount (обязательно)
      sweep: 15,
      structure: 15,                 // CHoCH/BOS на 15m с displacement
      zoneObFvg: 15, zoneOb: 8, zoneFvg: 6,
      ote: 5,
      volume: 10,
      room4: 10, room3: 6            // место для хода: ≥4R → 10, 3–4R → 6
    },
    penalties: { btc: 15, lowVol: 10 },
    lowVol: { days: 30, pct: 0.2 },  // ATR(14) 1H в нижних 20% за 30 дней

    minScore: 70,

    // Калибровка точности.
    // minTotal — меньше этого числа сделок во всей калибровке точность не показывается (выборка мала).
    calibration: { buckets: [60, 70, 80, 90], smoothK: 10, minN: 30, minTotal: 30, days: 60 },

    // Сеть.
    network: {
      pollMs: 20000,
      maxParallel: 4,
      timeoutMs: 12000,
      retries: 4,
      backoffBaseMs: 1500,
      backoffMaxMs: 60000,
      banPauseMs: 120000,          // код 418
      closeGraceMs: 3000,          // свеча считается закрытой через 3 с после окончания
      failCyclesToSwitch: 3,       // столько неудачных циклов подряд → следующий источник
      preferProbeMs: 600000        // раз в 10 мин проверять, вернулся ли приоритетный источник
    },

    // Источники данных в порядке автопереключения.
    sourceOrder: ['binanceFutures', 'binanceSpot', 'bybit'],

    // Сколько свечей держать в live-режиме.
    live: {
      load: { ltf: 400, mtf: 760, htf: 520 },
      keep: { ltf: 600, mtf: 900, htf: 700 },
      catchUpBars: 12,
      replayMaxBars: 3000
    },

    // Комиссии и проскальзывание по умолчанию (в процентах).
    fees: { futures: 0.05, spot: 0.1 },
    slippagePct: 0.03,

    // Бэктест.
    backtest: {
      days: [30, 60, 90, 180],
      defaultDays: 90,
      chunkMs: 14,
      splitIn: 0.7,          // первые 70% — основная часть, последние 30% — контрольная
      minTrades: 30,
      spreadIters: 2000      // повторов бутстрэпа для «разброса итога»
    },

    // Проверка текущих настроек live на истории (Настройки): сигналы в день и итог по месяцам.
    // 30 дней мало: один удачный месяц выглядит как рабочая стратегия, поэтому период — 90 или 180 дней.
    // «180 дней до них» — независимый отрезок (181–360 дней назад): на нём состав режима не выбирался.
    liveCheck: {
      defaultPeriod: 'd90',
      periods: [
        { id: 'd90', days: 90, offset: 0, label: '90 дней' },
        { id: 'd180', days: 180, offset: 0, label: '180 дней' },
        { id: 'prev180', days: 180, offset: 180, label: '180 дней до них' }
      ]
    },

    // Калькулятор.
    calculator: {
      deposit: 100,
      riskPct: 1,
      leverage: 3,
      leverageWarn: 5,
      mmrPct: 0.5,
      minOrder: 5
    },

    // Хранилище.
    storage: {
      settings: 'smc.settings.v1',
      journal: 'smc.journal.v1',
      calib: 'smc.calib.v1',
      log: 'smc.log.v1',
      presets: 'smc.presetcmp.v1',
      liveCheck: 'smc.livecheck.v1',
      idbName: 'smc-signals-cache',
      idbStore: 'candles'
    },
    journalMax: 500,
    logMax: 300,

    disclaimer: 'Не финансовая рекомендация. Прошлые результаты не гарантируют будущих. Точность — оценка, а не гарантия.'
  };

  function deepFreeze(o) {
    Object.keys(o).forEach(function (k) {
      if (o[k] && typeof o[k] === 'object') deepFreeze(o[k]);
    });
    return Object.freeze(o);
  }
  // Список монет качественного режима задан ссылкой ('extended' → extendedSymbols): здесь он раскрывается в массив.
  if (typeof cfg.qualityPreset.symbols === 'string') cfg.qualityPreset.symbols = cfg[cfg.qualityPreset.symbols + 'Symbols'].slice();
  return deepFreeze(cfg);
})();

// Эффективные параметры профиля стратегии: CONFIG + переопределения из CONFIG.strategyModes[mode].
// Детектор, валидатор и бэктест получают этот объект — одни и те же функции для live и истории.
var configFor = (function () {
  var cache = {};
  function clone(v) {
    if (Array.isArray(v)) return v.map(clone);
    if (v && typeof v === 'object') {
      var o = {};
      Object.keys(v).forEach(function (k) { o[k] = clone(v[k]); });
      return o;
    }
    return v;
  }
  function merge(dst, src) {
    Object.keys(src).forEach(function (k) {
      if (k === 'name' || k === 'short') return;
      var s = src[k];
      if (s && typeof s === 'object' && !Array.isArray(s) && dst[k] && typeof dst[k] === 'object') merge(dst[k], s);
      else dst[k] = clone(s);
    });
    return dst;
  }
  function freeze(o) {
    Object.keys(o).forEach(function (k) { if (o[k] && typeof o[k] === 'object') freeze(o[k]); });
    return Object.freeze(o);
  }
  return function (mode) {
    var m = CONFIG.strategyModes[mode] ? mode : CONFIG.defaultStrategy;
    if (!cache[m]) {
      var o = merge(clone(CONFIG), CONFIG.strategyModes[m]);
      o.strategy = m;
      cache[m] = freeze(o);
    }
    return cache[m];
  };
})();

// Фактический профиль для пресета: выбранный профиль или его замена для этого пресета (CONFIG.profileByPreset).
function profileFor(mode, presetId) {
  var m = CONFIG.strategyModes[mode] ? mode : CONFIG.defaultStrategy;
  var o = CONFIG.profileByPreset[m];
  return (o && o[presetId] && CONFIG.strategyModes[o[presetId]]) ? o[presetId] : m;
}
