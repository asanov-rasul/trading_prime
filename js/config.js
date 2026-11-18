/* SMC Signals — единый объект параметров.
   Все правила стратегии читают значения только отсюда. Параметры фиксированы и не подгоняются под историю. */
'use strict';

var CONFIG = (function () {
  var cfg = {
    version: '1.0.0',

    // Монеты (пары к USDT, без стейблкоинов). Первые восемь — крупнейшие не-стейблкоины по капитализации
    // на 16.11.2026 (Coinfomania по данным CoinMarketCap); DOGE и ADA — популярные ликвидные монеты.
    symbols: ['BTC', 'ETH', 'BNB', 'XRP', 'SOL', 'TRX', 'HYPE', 'ZEC', 'DOGE', 'ADA'],
    // Запасные монеты на случай, если пары нет на источнике.
    reserveSymbols: ['LINK', 'AVAX', 'SUI', 'LTC'],
    quote: 'USDT',
    btcCoin: 'BTC',

    // Связка таймфреймов live-режима.
    timeframes: { htf: '4h', mtf: '1h', ltf: '15m' },

    // Пресеты бэктеста.
    presets: {
      main: { id: 'main', name: 'Основной 4H/1H/15m', htf: '4h', mtf: '1h', ltf: '15m' },
      swing: { id: 'swing', name: 'Свинг 1D/4H/1H', htf: '1d', mtf: '4h', ltf: '1h' },
      scalp: { id: 'scalp', name: 'Скальп 1H/15m/5m', htf: '1h', mtf: '15m', ltf: '5m' }
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

    // Зона интереса 1H: цена внутри или не дальше 0.5×ATR(1H).
    poi: { maxDistAtr: 0.5 },

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
      moveStop: ['be', 'tp1'] // после TP1 → безубыток (вход + комиссии), после TP2 → на TP1
    },

    // Жизненный цикл сигнала.
    lifecycle: {
      expiryBars: 12,                // вход не случился за 12 свечей 15m → просрочен
      cooldownBars: 8,               // пауза после SL
      cancelIfTp1BeforeEntry: false  // true — отменять ожидающий вход, если цена дошла до TP1 раньше входа
    },

    // Валидатор. Правило «цена уже прошла TP1»:
    //  'retest'  — для лимитного входа на ретесте проверяется только, что цена не прошла вход
    //              (импульс-триггер обычно уже выше 1R от входа в OB/OTE — это нормальная геометрия ретеста);
    //  'literal' — буквально: на момент публикации цена не должна быть за TP1 (отсекает почти все сетапы).
    validator: { tp1Rule: 'retest' },

    // Обязательные условия сценария входа.
    require: { sweep: true, displacement: true },

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
      failCyclesToSwitch: 3        // столько неудачных циклов подряд → следующий источник
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
      minTrades: 30
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
  return deepFreeze(cfg);
})();
