/* SMC Signals — калькулятор прибыли. Чистые функции без DOM.
   Пример проверки: депозит 100 USDT, риск 1% = 1 USDT, вход 100, SL 98 → риск на монету 2 USDT,
   позиция 0.5 монеты = 50 USDT, при плече 5x маржа 10 USDT, убыток на SL без комиссий ровно 1 USDT. */
'use strict';

var Calc = (function () {
  function pos(x) { return typeof x === 'number' && isFinite(x) && x > 0; }
  function num(x) { return typeof x === 'number' && isFinite(x); }

  // p: {deposit, riskPct, dir (1|-1), entry, sl, tp:[tp1,tp2,tp3], fr:[%,%,%], leverage, feePct, slipPct,
  //     minOrder, mode:'risk'|'amount', amount, mmrPct, prob (0..1)}
  function compute(p) {
    var warn = [], res = { ok: false, warnings: warn };
    function W(level, text) { warn.push({ level: level, text: text }); }
    if (!pos(p.deposit)) { W('error', 'Укажите депозит больше нуля'); return res; }
    if (!pos(p.entry) || !pos(p.sl)) { W('error', 'Укажите вход и SL'); return res; }
    if (!pos(p.leverage) || p.leverage < 1) { W('error', 'Плечо должно быть не меньше 1x'); return res; }
    var dir = p.dir === -1 ? -1 : 1;
    var riskPerUnit = (p.entry - p.sl) * dir;
    if (!(riskPerUnit > 0)) { W('error', 'SL по неверную сторону от входа: для ' + (dir === 1 ? 'LONG стоп ниже входа' : 'SHORT стоп выше входа')); return res; }
    var tps = (p.tp || []).slice(0, 3);
    while (tps.length < 3) tps.push(NaN);
    var tpOk = tps.every(pos);
    if (!tpOk) W('warn', 'Не все TP заполнены — сценарии с TP посчитаны частично');
    if (tpOk) {
      var ordered = dir === 1 ? (p.entry < tps[0] && tps[0] < tps[1] && tps[1] < tps[2]) : (p.entry > tps[0] && tps[0] > tps[1] && tps[1] > tps[2]);
      if (!ordered) W('warn', 'TP должны идти по порядку дальше от входа: ' + (dir === 1 ? 'вход < TP1 < TP2 < TP3' : 'вход > TP1 > TP2 > TP3'));
    }
    var fr = (p.fr || [40, 30, 30]).map(function (x) { return num(x) && x >= 0 ? x : 0; });
    var frSum = fr[0] + fr[1] + fr[2];
    if (!(frSum > 0)) { W('error', 'Доли закрытия должны быть больше нуля'); return res; }
    if (Math.abs(frSum - 100) > 0.01) W('warn', 'Сумма долей ' + frSum.toFixed(1) + '% — доли нормированы к 100%');
    fr = fr.map(function (x) { return x / frSum; });
    var fee = (num(p.feePct) && p.feePct >= 0 ? p.feePct : 0) / 100;
    var slip = (num(p.slipPct) && p.slipPct >= 0 ? p.slipPct : 0) / 100;
    var mmr = (num(p.mmrPct) && p.mmrPct >= 0 ? p.mmrPct : 0.5) / 100;

    var qty, riskUsd;
    if (p.mode === 'amount') {
      if (!pos(p.amount)) { W('error', 'Укажите сумму в сделке'); return res; }
      qty = p.amount * p.leverage / p.entry;
      riskUsd = qty * riskPerUnit;
    } else {
      if (!pos(p.riskPct)) { W('error', 'Укажите риск на сделку'); return res; }
      riskUsd = p.deposit * p.riskPct / 100;
      qty = riskUsd / riskPerUnit;
    }
    var notional = qty * p.entry;
    var margin = notional / p.leverage;

    // Оценка цены ликвидации для изолированной маржи (без учёта комиссий и фондирования).
    var liq = dir === 1 ? p.entry * (1 - 1 / p.leverage) / (1 - mmr) : p.entry * (1 + 1 / p.leverage) / (1 + mmr);
    if (dir === 1 && liq <= 0) liq = null;

    function scenario(exits) {
      var gross = 0, fees = notional * fee;
      for (var k = 0; k < exits.length; k++) {
        var e = exits[k];
        if (!pos(e.price)) return null;
        var px = e.stop ? (dir === 1 ? e.price * (1 - slip) : e.price * (1 + slip)) : e.price;
        gross += qty * e.frac * (px - p.entry) * dir;
        fees += qty * e.frac * px * fee;
      }
      var net = gross - fees;
      return { usd: net, gross: gross, fees: fees, pct: net / p.deposit * 100, r: net / riskUsd };
    }
    var be = dir === 1 ? p.entry * (1 + 2 * fee) : p.entry * (1 - 2 * fee);
    // Куда переносится стоп после TP1 и TP2 — как в сопровождении CONFIG.tp.moveStop ('be', 'tp1' или null — не двигать).
    var mv = Array.isArray(p.moveStop) ? p.moveStop : CONFIG.tp.moveStop;
    function stopAfter(kind, prev) { return kind === 'be' ? be : (kind === 'tp1' ? tps[0] : prev); }
    var stop1 = stopAfter(mv[0], p.sl), stop2 = stopAfter(mv[1], stop1);
    var sc = {
      sl: scenario([{ price: p.sl, frac: 1, stop: true }]),
      tp1stop: scenario([{ price: tps[0], frac: fr[0] }, { price: stop1, frac: 1 - fr[0], stop: true }]),
      tp12: scenario([{ price: tps[0], frac: fr[0] }, { price: tps[1], frac: fr[1] }, { price: stop2, frac: 1 - fr[0] - fr[1], stop: true }]),
      all: scenario([{ price: tps[0], frac: fr[0] }, { price: tps[1], frac: fr[1] }, { price: tps[2], frac: fr[2] }])
    };
    sc.tp1be = sc.tp1stop; // прежнее имя — для совместимости
    res.moveStop = [mv[0] || null, mv[1] || null];
    var rr = tps.map(function (t) { return pos(t) ? (t - p.entry) * dir / riskPerUnit : NaN; });
    var rrAvg = tpOk ? fr[0] * rr[0] + fr[1] * rr[1] + fr[2] * rr[2] : NaN;
    var prob = num(p.prob) && p.prob >= 0 && p.prob <= 1 ? p.prob : null;
    // Осторожная оценка: при успехе (TP1) остаток закрывается по стопу после TP1, при неуспехе — по SL.
    var ev = (prob !== null && sc.sl && sc.tp1stop) ? prob * sc.tp1stop.usd + (1 - prob) * sc.sl.usd : null;

    if (pos(p.minOrder) && notional < p.minOrder) W('warn', 'Позиция ' + notional.toFixed(2) + ' USDT меньше минимального ордера ' + p.minOrder + ' USDT');
    if (margin > p.deposit) W('error', 'Требуемая маржа ' + margin.toFixed(2) + ' USDT больше депозита');
    if (p.leverage > CONFIG.calculator.leverageWarn) W('warn', 'Плечо выше ' + CONFIG.calculator.leverageWarn + 'x — высокий риск ликвидации');
    if (liq !== null && p.leverage > 1 && (dir === 1 ? liq >= p.sl : liq <= p.sl)) W('error', 'Оценка ликвидации (' + liq.toPrecision(6) + ') наступит раньше стопа — снизьте плечо');
    if (p.mode === 'amount' && riskUsd > p.deposit * 0.05) W('warn', 'Риск сделки ' + (riskUsd / p.deposit * 100).toFixed(1) + '% депозита — это много');

    res.ok = true;
    res.dir = dir;
    res.qty = qty;
    res.notional = notional;
    res.margin = margin;
    res.riskUsd = riskUsd;
    res.riskPerUnit = riskPerUnit;
    res.liq = liq;
    res.be = be;
    res.scenarios = sc;
    res.rr = rr;
    res.rrAvg = rrAvg;
    res.prob = prob;
    res.ev = ev;
    res.fr = fr;
    return res;
  }

  return { compute: compute };
})();
