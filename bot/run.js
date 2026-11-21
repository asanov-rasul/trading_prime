#!/usr/bin/env node
/* SMC Signals — Telegram-бот сигналов. Запускается GitHub Actions примерно раз в 10 минут
   (.github/workflows/telegram-signals.yml), можно запустить и вручную: node bot/run.js --state <папка>.

   Логика сигналов не дублируется: бот загружает те же файлы приложения (js/config.js, js/data.js,
   js/smc.js, js/signals.js) в изолированный контекст и повторяет live-цикл js/main.js: сопровождение
   открытых сигналов, детектор на последних закрытых свечах младшего ТФ, порог minScore, независимый
   валидатор, один открытый сигнал на монету по всем пресетам, пауза после SL. Настройки — CONFIG.qualityPreset.

   Секреты — только из переменных окружения: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID. Токен и chat id не
   выводятся в лог и не пишутся в состояние (ветка bot-state публичная). Без npm-зависимостей, Node 20+.

   Ключи: --state DIR (папка состояния), --source ID (binanceFutures | binanceSpot | bybit), --lookback N
   (свечей младшего ТФ для детектора), --block host1,host2 (имитация блокировки 451, как у раннеров в США),
   --dry (не отправлять в Telegram), --no-write (не сохранять состояние), --demo-messages (показать все
   виды сообщений). BOT_FAKE_TELEGRAM=1 — печатать сообщения вместо отправки. */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// =====================================================================================
// ПАРАМЕТРЫ ЗАПУСКА
// =====================================================================================
function parseArgs(argv) {
  const o = {};
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k];
    if (!a.startsWith('--')) continue;
    const next = argv[k + 1];
    if (next !== undefined && !next.startsWith('--')) { o[a.slice(2)] = next; k++; } else o[a.slice(2)] = true;
  }
  return o;
}
const ARGS = parseArgs(process.argv.slice(2));
const ROOT = path.resolve(typeof ARGS.root === 'string' ? ARGS.root : path.join(__dirname, '..'));
const STATE_DIR = path.resolve(typeof ARGS.state === 'string' ? ARGS.state : path.join(ROOT, 'state'));
const LOOKBACK = ARGS.lookback ? Math.max(1, parseInt(ARGS.lookback, 10) || 1) : 0;
const FORCED_SOURCE = typeof ARGS.source === 'string' ? ARGS.source : '';
const BLOCKED = typeof ARGS.block === 'string' ? ARGS.block.split(',').map(s => s.trim()).filter(Boolean) : [];
const NO_WRITE = !!ARGS['no-write'];
const DEMO = !!ARGS['demo-messages'];

const TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || '').trim();
const FAKE = process.env.BOT_FAKE_TELEGRAM === '1' || DEMO;
// off — пробный режим (нет токена или --dry); setup — есть токен, нет chat id; on — рассылка; fake — печать.
const MODE = FAKE ? 'fake' : (ARGS.dry || !TOKEN) ? 'off' : (!CHAT_ID ? 'setup' : 'on');
const CAN_SEND = MODE === 'on' || MODE === 'fake';

const CHECK_EVERY_MIN = 10;          // как в расписании workflow
const DETECT_WINDOW_MS = 4 * 3600000; // детектор: последние ~4 ч закрытых свечей младшего ТФ
const KEEP_CLOSED_DAYS = 365;        // закрытые сигналы для недельных сводок
const KEEP_SEEN_DAYS = 3;            // найденные, но не показанные (для защиты от дублей)
const STATE_V = 1;

// Секреты не должны попасть ни в лог, ни в состояние.
function mask(s) {
  let t = String(s === undefined || s === null ? '' : s);
  if (TOKEN) t = t.split(TOKEN).join('***');
  if (CHAT_ID) t = t.split(CHAT_ID).join('<chat>');
  return t;
}
function log(text) { console.log(mask(text)); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// =====================================================================================
// ПРИЛОЖЕНИЕ В ИЗОЛИРОВАННОМ КОНТЕКСТЕ
// =====================================================================================
let netRequests = 0;
function hostOf(u) { const m = /^https?:\/\/([^\/?#]+)/i.exec(String(u)); return m ? m[1] : ''; }
// fetch для кода приложения: только GET к публичным API бирж; --block имитирует ответ 451.
function appFetch(url, init) {
  netRequests++;
  if (BLOCKED.indexOf(hostOf(url)) >= 0) {
    return Promise.resolve(new Response('{"code":0,"msg":"Service unavailable from a restricted location (тест --block)"}',
      { status: 451, headers: { 'content-type': 'application/json' } }));
  }
  return fetch(url, { method: (init && init.method) || 'GET', signal: init && init.signal, headers: { accept: 'application/json' } });
}
function loadApp() {
  const mem = new Map();
  const storage = {
    getItem: k => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: k => { mem.delete(k); },
    clear: () => { mem.clear(); }
  };
  const sandbox = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    fetch: appFetch, AbortController, Response, URL, URLSearchParams, TextEncoder, TextDecoder,
    localStorage: storage, sessionStorage: storage,
    navigator: { onLine: true, userAgent: 'smc-signals-bot' },
    performance: { now: () => performance.now() }
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  ['config.js', 'data.js', 'smc.js', 'signals.js'].forEach(f => {
    const file = path.join(ROOT, 'js', f);
    vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  });
  return sandbox;
}
const APP = loadApp();
const C = APP.CONFIG, SMC = APP.SMC, Data = APP.Data, Signals = APP.Signals;
const configFor = APP.configFor, profileFor = APP.profileFor;
const Q = C.qualityPreset;
const PRESETS = (Q.presets || []).filter(p => C.presets[p]);
const BTC_SYM = C.btcCoin + C.quote;

// =====================================================================================
// ФОРМАТИРОВАНИЕ
// =====================================================================================
function isNum(x) { return typeof x === 'number' && isFinite(x); }
function decOf(p) {
  const a = Math.abs(p);
  if (a >= 100) return 2;
  if (a >= 10) return 3;
  if (a >= 1) return 4;
  if (a >= 0.1) return 5;
  if (a >= 0.01) return 6;
  return 8;
}
function fP(p) { return isNum(p) ? p.toFixed(decOf(p)) : '—'; }
function pad(n) { return String(n).padStart(2, '0'); }
function fUTC(t) {
  if (!isNum(t)) return '—';
  const d = new Date(t);
  return pad(d.getUTCDate()) + '.' + pad(d.getUTCMonth() + 1) + ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ' UTC';
}
function fDay(t) { const d = new Date(t); return pad(d.getUTCDate()) + '.' + pad(d.getUTCMonth() + 1); }
function fR(r) { return isNum(r) ? (r > 0 ? '+' : '') + r.toFixed(2) + 'R' : '—'; }
// Длительность: минуты, часы, а от 48 ч ровными сутками — дни (как hoursText в приложении).
function fHours(ms) {
  const h = ms / 3600000;
  if (h < 1) return Math.max(1, Math.round(ms / 60000)) + ' мин';
  if (h >= 48 && h % 24 === 0) return (h / 24) + ' дн';
  if (h >= 48) return (h / 24).toFixed(1) + ' дн';
  return (h % 1 === 0 ? String(h) : h.toFixed(1)) + ' ч';
}
// Срок ожидания входа по пресетам: «основной (15m): 24 ч · свинг (1h): 4 дн».
function waitByPreset() {
  return PRESETS.map(pid => { const P = C.presets[pid]; return P.short + ' (' + P.ltf + '): ' + fHours(Q.expiryBars * SMC.tfMs(P.ltf)); }).join(' · ');
}
function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function presetName(id) { return (C.presets[id] || C.presets.main).name; }
function modeShort(m) { return (C.strategyModes[m] || C.strategyModes.strict).short; }
function pagesUrl() {
  const repo = String(process.env.GITHUB_REPOSITORY || '');
  const m = /^([^/]+)\/(.+)$/.exec(repo);
  return m ? 'https://' + m[1].toLowerCase() + '.github.io/' + m[2] + '/' : '';
}
function pct(f) { return Math.round(f * 100) + '%'; }

// =====================================================================================
// СООБЩЕНИЯ
// =====================================================================================
function sourceNote(src) {
  if (!src || src.id === 'binanceFutures') return '';
  if (src.id === 'binanceSpot') return 'Данные: Binance Spot' + (src.host === 'data-api.binance.vision' ? ' (зеркало)' : '') +
    ' — фьючерсы Binance с сервера бота недоступны, уровни могут немного отличаться от приложения.';
  return 'Данные: ' + src.name + ' — уровни могут немного отличаться от приложения (Binance Futures).';
}
function msgNewSignal(sig, src, nowT) {
  const long = sig.dir === 1;
  const lines = [];
  lines.push((long ? '🟢' : '🔴') + ' <b>' + esc(sig.side + ' ' + sig.coin) + '</b> · ' + esc(presetName(sig.preset)));
  lines.push('Профиль: ' + esc(modeShort(sig.mode)) + ' · score ' + sig.score);
  lines.push('Лимитный вход: <b>' + fP(sig.entry) + '</b>');
  const risk = isNum(sig.riskPct) ? sig.riskPct : sig.R / sig.entry * 100;
  lines.push('SL: ' + fP(sig.sl) + ' (риск ' + risk.toFixed(2) + '%)');
  lines.push('TP1: ' + fP(sig.tp1) + ' · TP2: ' + fP(sig.tp2) + ' · TP3: ' + fP(sig.tp3) + (isNum(sig.tp3R) ? ' (' + sig.tp3R.toFixed(1) + 'R)' : ''));
  lines.push('Ждём вход ' + fHours(sig.expiryBars * sig.ltfMs) + ' — до ' + fUTC(sig.expiresT));
  lines.push('Сигнал по свече, закрывшейся ' + fUTC(sig.createdT));
  const lag = nowT - sig.createdT;
  if (lag > 20 * 60000) lines.push('⚠️ Найден с опозданием: ' + fHours(lag) + ' после закрытия свечи' + (lag < 2 * 3600000 ? ' (GitHub задержал запуск).' : '.'));
  if (sig.status === 'active') {
    lines.push('⚠️ Цена уже дошла до входа: сделка по сигналу идёт со свечи ' + fUTC(sig.filledT) + '.' +
      (sig.tpHit[0] ? ' TP1 уже взят, стоп в безубытке.' : ''));
  }
  const note = sourceNote(src);
  if (note) lines.push(note);
  const url = pagesUrl();
  if (url) lines.push('Приложение: ' + url);
  return lines.join('\n');
}
function tpMoveText(k, sig) {
  const mv = C.tp.moveStop[k];
  if (mv === 'be') return 'стоп в безубыток ' + fP(Signals.bePrice(sig));
  if (mv === 'tp1') return 'стоп на TP1 ' + fP(sig.tp1);
  return 'стоп без изменений';
}
// События по сигналу с прошлой отправки: вход, TP1, TP2, закрытие или отмена — одним сообщением.
function eventLines(sig, sent) {
  const head = esc(sig.coin + ' ' + sig.side), out = [];
  const fr = C.tp.fractions;
  if (sent.status === 'pending' && sig.filledT !== null && sig.filledT !== undefined) {
    out.push('✅ ' + head + ': вход исполнен по ' + fP(sig.entry) + ' (свеча ' + fUTC(sig.filledT) + '). Стоп ' + fP(sig.sl) + '.');
  }
  if (sig.tpHit[0] && !sent.tp[0]) out.push('🎯 ' + head + ': TP1 ' + fP(sig.tp1) + ' взят — закрыть ' + pct(fr[0]) + ', ' + tpMoveText(0, sig) + '.');
  if (sig.tpHit[1] && !sent.tp[1]) out.push('🎯 ' + head + ': TP2 ' + fP(sig.tp2) + ' взят — закрыть ещё ' + pct(fr[1]) + ', ' + tpMoveText(1, sig) + '.');
  if (!Signals.isOpen(sig) && (sent.status === 'pending' || sent.status === 'active')) {
    if (sig.status === 'closed') {
      const icon = sig.resultR > 0 ? '🏁' : '🛑';
      out.push(icon + ' ' + head + ' закрыт: ' + esc(Signals.statusText(sig)) + '. Итог ' + fR(sig.resultR) + '.');
    } else if (sig.status === 'expired' && sig.outcome === 'expired') {
      out.push('⌛ ' + head + ': вход не случился за ' + fHours(sig.expiryBars * sig.ltfMs) + ' — отмените лимитный ордер.');
    } else {
      out.push('🚫 ' + head + ': сигнал отменён (' + esc(sig.note || Signals.statusText(sig)) + ') — отмените лимитный ордер.');
    }
  }
  return out;
}
function msgWelcome(info) {
  const lines = [];
  lines.push('🤖 <b>SMC Signals: бот подключён</b>');
  lines.push('Монет: ' + info.coins + (info.skipped ? ' (без данных: ' + info.skipped + ')' : '') + ' · пресеты: ' + PRESETS.map(p => esc(presetName(p))).join(', '));
  lines.push('Профиль: ' + esc(modeShort(Q.strategy)) + ' · minScore ' + Q.minScore);
  lines.push('Ожидание входа ' + Q.expiryBars + ' ' + plural(Q.expiryBars, 'свеча', 'свечи', 'свечей') + ' младшего ТФ: ' + esc(waitByPreset()));
  lines.push('Проверка рынка — примерно раз в ' + CHECK_EVERY_MIN + ' минут (GitHub может задерживать запуски).');
  lines.push('Пришлю: новый сигнал, вход, TP1/TP2, закрытие или отмену; по понедельникам — итоги недели.');
  if (info.open) lines.push('Сейчас открыто ' + info.open + ' ' + plural(info.open, 'сигнал', 'сигнала', 'сигналов') + ' — о них не пишу, смотрите в приложении.');
  const note = sourceNote(info.src);
  if (note) lines.push(note);
  const url = pagesUrl();
  if (url) lines.push('Приложение: ' + url);
  lines.push('Бот только подсказывает: не торгует и не знает ваших ключей. Не финансовая рекомендация.');
  return lines.join('\n');
}
function statsLine(list) {
  const s = Signals.stats(list);
  return 'сигналов ' + s.signals + ', входов ' + s.entries + ', закрыто сделок ' + s.n +
    (s.n ? ' (✓ ' + s.wins + ' / ✗ ' + s.losses + '), итог ' + fR(s.sumR) : '');
}
function msgSummary(st, weekFrom, weekTo) {
  const ann = st.signals.filter(r => r.ann).map(r => r.sig);
  const created = ann.filter(s => s.createdT >= weekFrom && s.createdT < weekTo);
  const closed = ann.filter(s => s.status === 'closed' && s.filledT !== null && s.closedT >= weekFrom && s.closedT < weekTo);
  const sc = Signals.stats(closed);
  const open = ann.filter(s => Signals.isOpen(s)).length;
  const lines = [];
  lines.push('📊 <b>Итоги недели ' + fDay(weekFrom) + '–' + fDay(weekTo - 1) + '</b> (бумажная проверка)');
  lines.push('Новых сигналов: ' + created.length + ' · из них дошли до входа: ' + created.filter(s => s.filledT !== null).length);
  lines.push('Закрыто сделок: ' + sc.n + (sc.n ? ' — ✓ ' + sc.wins + ' / ✗ ' + sc.losses + ', итог ' + fR(sc.sumR) : ''));
  lines.push('С начала (' + fDay(st.startedT) + '): ' + statsLine(ann));
  lines.push('Открыто сейчас: ' + open);
  lines.push('✓ — сделка дошла до TP1. Итог в R — с комиссиями и проскальзыванием, как в приложении.');
  return lines.join('\n');
}
function msgChatId(chatId) {
  return 'Ваш chat id: <code>' + esc(chatId) + '</code>\n' +
    'Добавьте его в репозиторий на GitHub как секрет <b>TELEGRAM_CHAT_ID</b>: Settings → Secrets and variables → Actions → New repository secret. ' +
    'После этого я пришлю приветствие и начну отправлять сигналы.';
}

// =====================================================================================
// TELEGRAM
// =====================================================================================
async function tg(method, body) {
  if (FAKE) {
    if (method === 'sendMessage') {
      console.log('\n——— [Telegram, тест] ———\n' + String(body.text).replace(/<\/?(b|code)>/g, '') + '\n———————————————');
      return { ok: true, result: {} };
    }
    return { ok: true, result: [] };
  }
  let last = '';
  for (let attempt = 0; attempt < 4; attempt++) {
    let res, j = null;
    try {
      res = await fetch('https://api.telegram.org/bot' + TOKEN + '/' + method, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000)
      });
      try { j = await res.json(); } catch (e) { j = null; }
    } catch (e) {
      last = 'нет связи с Telegram (' + (e && e.name === 'TimeoutError' ? 'таймаут' : 'сеть') + ')';
      await sleep(1500 * (attempt + 1));
      continue;
    }
    if (j && j.ok) return j;
    const ra = j && j.parameters && j.parameters.retry_after;
    last = (j && j.description) ? j.description : 'HTTP ' + res.status;
    if (res.status === 429 && ra) { await sleep(Math.min(60, Number(ra)) * 1000 + 300); continue; }
    if (res.status >= 500) { await sleep(2000 * (attempt + 1)); continue; }
    break;
  }
  throw new Error('Telegram ' + method + ': ' + mask(last));
}
let lastSendT = 0;
async function send(text) {
  const wait = lastSendT + 400 - Date.now(); // не чаще ~2 сообщений в секунду в один чат
  if (wait > 0) await sleep(wait);
  lastSendT = Date.now();
  await tg('sendMessage', { chat_id: CHAT_ID || 'test', text: text, parse_mode: 'HTML', disable_web_page_preview: true });
}
// Есть токен, но нет chat id: ответить в последний личный чат его номером (в лог номер не выводится).
async function replyChatId() {
  const up = await tg('getUpdates', { timeout: 0, allowed_updates: ['message'] });
  const list = Array.isArray(up.result) ? up.result : [];
  let lastId = null, chat = null;
  list.forEach(u => {
    if (lastId === null || u.update_id > lastId) lastId = u.update_id;
    const m = u.message;
    if (m && m.chat && m.chat.type === 'private') chat = m.chat.id;
  });
  if (chat !== null) {
    await tg('sendMessage', { chat_id: chat, text: msgChatId(String(chat)), parse_mode: 'HTML' });
    log('Telegram: chat id отправлен в личный чат с ботом (номер в лог не пишется).');
  } else {
    log('Telegram: chat id не задан и боту ещё никто не написал — откройте бота в Telegram и нажмите «Старт».');
  }
  // Подтвердить обработанные обновления, чтобы не отвечать повторно.
  if (lastId !== null) await tg('getUpdates', { offset: lastId + 1, timeout: 0 });
  return chat !== null;
}

// =====================================================================================
// СОСТОЯНИЕ (ветка bot-state: state.json и status.json)
// =====================================================================================
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const STATUS_FILE = path.join(STATE_DIR, 'status.json');
function readJSON(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; } }
function writeJSON(file, obj) {
  if (NO_WRITE) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1) + '\n');
  fs.renameSync(tmp, file);
}
function newState(nowT) {
  return { v: STATE_V, startedT: nowT, chatReady: false, signals: [], seen: {}, summaryWeek: null, source: '' };
}
// Существенные изменения — повод записать state.json (а workflow — закоммитить). Сдвиг lastT открытых
// сигналов существенным не считается (сопровождение идемпотентно), кроме отставания больше суток.
function fingerprint(st) {
  return JSON.stringify({
    v: st.v, start: st.startedT, chat: st.chatReady, week: st.summaryWeek, src: st.source,
    s: st.signals.map(r => [r.sig.id, r.sig.status, r.sig.outcome, r.sig.tpHit, r.sig.filledT, r.sig.closedT,
      r.ann, r.want, r.sent.status, r.sent.tp, Math.floor((r.sig.lastT || 0) / 86400000)]),
    seen: Object.keys(st.seen).sort()
  });
}
const SLIM_KEYS = ['id', 'sym', 'coin', 'dir', 'side', 'tf', 'mode', 'preset', 'score', 'createdT', 'triggerT', 'expiresT', 'expiryBars',
  'ltfMs', 'entry', 'sl', 'tp1', 'tp2', 'tp3', 'R', 'riskPct', 'tp3R', 'fee', 'slip', 'late', 'status', 'outcome', 'tpHit', 'stop',
  'filledT', 'closedT', 'resultR', 'lastT', 'note', 'source'];
function slim(sig) { const o = {}; SLIM_KEYS.forEach(k => { if (sig[k] !== undefined) o[k] = sig[k]; }); return o; }
function pruneState(st, nowT) {
  st.signals = st.signals.filter(r => Signals.isOpen(r.sig) || !(r.sig.closedT < nowT - KEEP_CLOSED_DAYS * 86400000));
  st.signals.forEach(r => { if (!Signals.isOpen(r.sig) && r.sig.closedT < nowT - 2 * 86400000 && r.sig.zone) r.sig = slim(r.sig); });
  Object.keys(st.seen).forEach(id => { if (st.seen[id].T < nowT - KEEP_SEEN_DAYS * 86400000) delete st.seen[id]; });
}

// =====================================================================================
// ДАННЫЕ
// =====================================================================================
function catchUpBars() { return Math.max(C.live.catchUpBars, Q.expiryBars); }
function windowBars(tf) { return LOOKBACK || Math.max(1, Math.round(DETECT_WINDOW_MS / SMC.tfMs(tf))); }
// Как loadCount в js/main.js; для --lookback младший ТФ догружается под окно детектора.
function loadCount(role, tf) {
  if (role === 'ltf') return Math.max(C.live.load.ltf, C.windows.ltf + catchUpBars() + 40, C.windows.ltf + windowBars(tf) + 40);
  if (role === 'mtf') return Math.max(C.windows.mtf + 60, Math.ceil(C.lowVol.days * SMC.DAY / SMC.tfMs(tf)) + 60);
  return C.windows.htf + C.emaWarmupBars + 20;
}
function tfPlanFor(presetIds, openLtfs) {
  const plan = {};
  function want(tf, role) {
    const x = plan[tf] || (plan[tf] = { count: 0, ltf: false });
    x.count = Math.max(x.count, loadCount(role, tf));
    if (role === 'ltf') x.ltf = true;
  }
  presetIds.forEach(pid => { const P = C.presets[pid]; want(P.ltf, 'ltf'); want(P.mtf, 'mtf'); want(P.htf, 'htf'); });
  (openLtfs || []).forEach(tf => want(tf, 'ltf'));
  return plan;
}
async function pickSource() {
  const order = FORCED_SOURCE ? [FORCED_SOURCE] : C.sourceOrder.slice();
  const fails = [];
  for (const id of order) {
    const ad = Data.ADAPTERS[id];
    if (!ad) { fails.push(id + ': неизвестный источник'); continue; }
    for (const base of ad.bases) {
      try {
        const t = await Data.fetchTime(ad, base);
        if (!(t > 0)) throw new Error('нет времени сервера');
        Data.setClock(t);
        const all = await Data.fetchTickers(ad, base, null, 1);
        if (!all || all[BTC_SYM] == null) throw new Error('нет цен');
        return { ad, base, all, fails, id: ad.id, name: ad.name, market: ad.market, host: hostOf(base) };
      } catch (e) {
        fails.push(ad.name + ' · ' + hostOf(base) + ': ' + mask(e.message));
      }
    }
  }
  const err = new Error('все источники недоступны');
  err.fails = fails;
  throw err;
}
async function loadSymbol(src, sym, plan) {
  const S = {};
  await Promise.all(Object.keys(plan).map(async tf => {
    const cds = await Data.fetchLatest(src.ad, src.base, sym, tf, plan[tf].count, 2);
    const closed = cds.filter(c => c.closed);
    if (!closed.length) throw Object.assign(new Error('нет свечей ' + tf), { kind: 'stale' });
    const ms = SMC.tfMs(tf), last = closed[closed.length - 1].t;
    if (Data.now() - (last + ms) > 3 * ms + C.network.closeGraceMs) throw Object.assign(new Error('нет свежих свечей ' + tf + ' (пара не торгуется?)'), { kind: 'stale' });
    S[tf] = SMC.buildSeries(closed, tf, C);
  }));
  return S;
}

// =====================================================================================
// СИГНАЛЫ: сопровождение и детектор (как processPreset / stepSignalsOn / replayOpen в js/main.js)
// =====================================================================================
async function bringUpToDate(src, sig, S) {
  const tf = sig.tf && sig.tf.ltf ? sig.tf.ltf : C.timeframes.ltf;
  const ser = S && S[tf];
  if (!ser || !ser.c.length) return false;
  const Lc = ser.c, ms = ser.ms;
  if (sig.lastT + ms < Lc[0].t) {
    const bars = (Lc[0].t - sig.lastT) / ms;
    if (bars > C.live.replayMaxBars) {
      sig.status = 'expired'; sig.outcome = 'expired'; sig.closedT = Data.now();
      sig.note = 'сопровождение прервано: нет истории за ' + Math.round(bars) + ' свечей';
      return true;
    }
    const older = await Data.fetchRange(src.ad, src.base, sig.sym, tf, sig.lastT + ms, Lc[0].t - ms);
    for (const cd of older) { if (!Signals.isOpen(sig)) break; Signals.step(sig, cd, C); }
  }
  for (let k = 0; k < Lc.length && Signals.isOpen(sig); k++) Signals.step(sig, Lc[k], C);
  return true;
}
// Интервалы занятости монеты: [создан, закрыт) по сигналам состояния и найденным-но-не-показанным.
function intervalsOf(st, sym) {
  const iv = [];
  st.signals.forEach(r => { if (r.sig.sym === sym) iv.push({ T: r.sig.createdT, c: r.sig.closedT, sl: r.sig.outcome === 'sl' ? r.sig.closedT : null }); });
  Object.keys(st.seen).forEach(id => { const x = st.seen[id]; if (x.sym === sym) iv.push({ T: x.T, c: x.c, sl: x.sl }); });
  return iv;
}
function detectCoin(st, src, coin, sym, S, B, priceNow, found, errors) {
  const slots = [];
  PRESETS.forEach((pid, order) => {
    const P = C.presets[pid], L = S[P.ltf], M = S[P.mtf], H = S[P.htf];
    if (!L || !M || !H) return;
    const n = L.c.length, from = Math.max(0, n - windowBars(P.ltf));
    for (let idx = from; idx < n; idx++) slots.push({ pid, order, idx, T: L.c[idx].t + L.ms, P, L, M, H });
  });
  // Общий порядок по времени; при равном времени — порядок пресетов (как в live: основной первым).
  slots.sort((a, b) => (a.T - b.T) || (a.order - b.order));
  for (const sl of slots) {
    const iv = intervalsOf(st, sym);
    const lastKnownT = iv.reduce((m, x) => Math.max(m, x.T), -Infinity);
    if (sl.T < lastKnownT) continue; // участок до последнего известного сигнала уже обработан
    const cfg = configFor(profileFor(Q.strategy, sl.pid));
    const btc = (B && B[sl.P.mtf] && B[sl.P.htf]) ? { M: B[sl.P.mtf], H: B[sl.P.htf] } : null;
    const ctx = SMC.makeContext({ sym, coin, L: sl.L, M: sl.M, H: sl.H, i: sl.idx, btc, cfg, longOnly: false, memo: null });
    let res;
    try { res = SMC.detect(ctx); } catch (e) { errors.push(coin + ': ошибка детектора — ' + e.message); continue; }
    if (!res.cand || res.cand.score < Q.minScore) continue;
    const latest = sl.idx === sl.L.c.length - 1;
    const raw = {
      L: sl.L.c, M: sl.M.c, H: sl.H.c, ms: { L: sl.L.ms, M: sl.M.ms, H: sl.H.ms }, evalT: ctx.T,
      price: latest && priceNow > 0 ? priceNow : sl.L.c[sl.idx].c
    };
    // Состояние валидатора на момент свечи: занятость монеты и пауза после SL — только по прошлому.
    const vstate = {
      hasOpen: () => iv.some(x => x.T <= ctx.T && (x.c === null || x.c === undefined || ctx.T < x.c)),
      lastSlT: () => iv.reduce((m, x) => (x.sl !== null && x.sl !== undefined && x.sl <= ctx.T && (m === null || x.sl > m)) ? x.sl : m, null)
    };
    let v;
    try { v = Signals.validate(res.cand, raw, vstate, ctx.cfg); } catch (e2) { v = { ok: false, reason: 'ошибка валидатора: ' + e2.message }; }
    if (!v.ok) continue;
    const sig = Signals.create(res.cand, {
      fee: C.fees.futures / 100, slip: C.slippagePct / 100, ltfMs: sl.L.ms, source: src.name,
      preset: sl.pid, late: !latest, mode: ctx.cfg.strategy, expiryBars: Q.expiryBars
    });
    if (st.seen[sig.id] || st.signals.some(r => r.sig.id === sig.id)) continue;
    // Сопровождение по уже закрытым свечам после триггера — как догрузка в приложении.
    for (let k = sl.idx + 1; k < sl.L.c.length && Signals.isOpen(sig); k++) Signals.step(sig, sl.L.c[k], C);
    const rec = { sig, ann: false, want: false, sent: { status: sig.status, tp: sig.tpHit.slice() } };
    found.push({ sig: JSON.parse(JSON.stringify(sig)), kept: Signals.isOpen(sig) || !sig.late });
    if (sig.late && !Signals.isOpen(sig)) {
      // Найден задним числом и уже завершился — не показывается (как dropFinishedLate), но занимает монету.
      st.seen[sig.id] = { sym, T: sig.createdT, c: sig.closedT, sl: sig.outcome === 'sl' ? sig.closedT : null };
    } else {
      st.signals.push(rec);
      rec.isNew = true;
    }
  }
}

// =====================================================================================
// ЗАПУСК
// =====================================================================================
function weekStartUTC(t) {
  const d = new Date(t);
  const day = (d.getUTCDay() + 6) % 7; // 0 — понедельник
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day);
}
function writeStatus(prev, status, force) {
  const key = s => JSON.stringify([s.source && s.source.id, s.source && s.source.host, s.telegram, s.errors, s.coins && s.coins.skipped]);
  const due = !prev || !(status.ts - prev.ts < 55 * 60000) || key(prev) !== key(status);
  if (force || due) { writeJSON(STATUS_FILE, status); return true; }
  return false;
}
function sigLine(s, kept) {
  return [fUTC(s.createdT), s.coin, s.side, presetName(s.preset).split(' ')[0], 'score ' + s.score, 'вход ' + fP(s.entry), 'SL ' + fP(s.sl),
    'TP1 ' + fP(s.tp1), 'TP2 ' + fP(s.tp2), 'TP3 ' + fP(s.tp3), Signals.statusText(s) + (s.status === 'closed' ? ' ' + fR(s.resultR) : ''),
    kept ? '' : '(завершился до показа)', s.id].filter(Boolean).join(' · ');
}

async function main() {
  const t0 = Date.now();
  if (DEMO) return demoMessages();
  if (!PRESETS.length) throw new Error('в CONFIG.qualityPreset нет пресетов');
  const prevStatus = readJSON(STATUS_FILE);
  const loaded = readJSON(STATE_FILE);
  const existed = !!(loaded && loaded.v === STATE_V && Array.isArray(loaded.signals));
  const st = existed ? loaded : newState(Date.now());
  if (!st.seen || typeof st.seen !== 'object') st.seen = {};
  st.signals.forEach(r => { if (!r.sent) r.sent = { status: r.sig.status, tp: r.sig.tpHit.slice() }; });
  const fp0 = existed ? fingerprint(st) : '';
  const errors = [];
  const status = {
    ts: t0, time: new Date(t0).toISOString(), version: C.version, telegram: MODE,
    profile: Q.strategy, presets: PRESETS, expiryBars: Q.expiryBars, minScore: Q.minScore,
    source: null, sourceFails: [], coins: { want: Q.symbols.length, loaded: 0, skipped: [] },
    signals: { open: 0, new: 0, events: 0, messages: 0 }, errors: errors, requests: 0, durationMs: 0
  };
  log('SMC Signals бот · версия ' + C.version + ' · Telegram: ' + MODE + (existed ? '' : ' · новое состояние'));

  // 1. Источник данных.
  let src;
  try {
    src = await pickSource();
  } catch (e) {
    status.sourceFails = e.fails || [];
    errors.push('Нет данных: ' + e.message);
    log('Источник: ' + e.message + '\n  ' + (e.fails || []).join('\n  '));
    status.requests = netRequests; status.durationMs = Date.now() - t0;
    writeStatus(prevStatus, status, true);
    return 0; // временный сбой источников — не ошибка workflow (без писем о падении каждые 10 минут)
  }
  status.source = { id: src.id, name: src.name, market: src.market, host: src.host };
  status.sourceFails = src.fails;
  log('Источник: ' + src.name + ' (' + src.host + ')' + (src.fails.length ? ' · недоступны: ' + src.fails.join('; ') : ''));

  // 2. Монеты и свечи.
  const coins = [], skipped = [];
  Q.symbols.forEach(coin => {
    const sym = coin + C.quote;
    if (src.all[sym] != null) coins.push({ coin, sym }); else skipped.push({ coin, reason: 'нет на источнике' });
  });
  const hasBtc = src.all[BTC_SYM] != null;
  const openBySym = {};
  st.signals.forEach(r => { if (Signals.isOpen(r.sig)) (openBySym[r.sig.sym] = openBySym[r.sig.sym] || []).push(r); });
  const jobs = coins.map(c => ({ coin: c.coin, sym: c.sym, active: true }));
  Object.keys(openBySym).forEach(sym => { if (!jobs.some(j => j.sym === sym)) jobs.push({ coin: sym.slice(0, -C.quote.length), sym, active: false }); });
  if (hasBtc && !jobs.some(j => j.sym === BTC_SYM)) jobs.push({ coin: C.btcCoin, sym: BTC_SYM, active: false, context: true });
  const series = {};
  await Promise.all(jobs.map(async j => {
    const openLtfs = (openBySym[j.sym] || []).map(r => r.sig.tf && r.sig.tf.ltf).filter(tf => !!SMC.TF_MS[tf]);
    const plan = (j.active || j.context) ? tfPlanFor(PRESETS, openLtfs) : tfPlanFor([], openLtfs);
    try { series[j.sym] = await loadSymbol(src, j.sym, plan); } catch (e) {
      if (j.active) skipped.push({ coin: j.coin, reason: mask(e.message) });
      else if (!j.context) errors.push(j.coin + ' (открытый сигнал): ' + mask(e.message));
    }
  }));
  const active = coins.filter(c => series[c.sym]);
  status.coins.loaded = active.length;
  status.coins.skipped = skipped;
  log('Монет: ' + active.length + ' из ' + Q.symbols.length + (skipped.length ? ' · пропущены: ' + skipped.map(s => s.coin + ' (' + s.reason + ')').join(', ') : ''));
  if (!active.length) {
    errors.push('ни одна монета не загрузилась');
    status.requests = netRequests; status.durationMs = Date.now() - t0;
    writeStatus(prevStatus, status, true);
    return 0;
  }

  // 3. Сопровождение открытых сигналов по пропущенным свечам.
  for (const sym of Object.keys(openBySym)) {
    for (const r of openBySym[sym]) {
      try { await bringUpToDate(src, r.sig, series[sym]); } catch (e) { errors.push(r.sig.coin + ': сопровождение — ' + mask(e.message)); }
    }
  }

  // 4. Детектор и валидатор на последних закрытых свечах.
  const found = [];
  const B = hasBtc ? series[BTC_SYM] : null;
  for (const c of active) {
    try { detectCoin(st, src, c.coin, c.sym, series[c.sym], B, src.all[c.sym], found, errors); } catch (e) { errors.push(c.coin + ': ' + e.message); }
  }

  // 5. Telegram.
  const nowT = Data.now();
  const initialSync = !existed; // первый запуск: состояние наполняется без рассылки старых сигналов
  if (MODE === 'setup') {
    try { await replyChatId(); } catch (e) { errors.push(mask(e.message)); }
  }
  let messages = 0, events = 0;
  if (CAN_SEND) {
    try {
      if (!st.chatReady) {
        // До подключения чата сигналы не показывались: о текущих открытых — только упоминание в приветствии.
        const openNow = st.signals.filter(r => Signals.isOpen(r.sig) && !(r.isNew && !initialSync)).length;
        await send(msgWelcome({ coins: active.length, skipped: skipped.length, open: openNow, src }));
        st.chatReady = true;
        messages++;
      }
      // События по уже показанным сигналам.
      for (const r of st.signals) {
        if (!r.ann) continue;
        const lines = eventLines(r.sig, r.sent);
        if (!lines.length) continue;
        await send(lines.join('\n'));
        r.sent = { status: r.sig.status, tp: r.sig.tpHit.slice() };
        messages++; events += lines.length;
      }
      // Новые сигналы (и те, что не удалось отправить в прошлый раз).
      for (const r of st.signals) {
        if (r.ann) continue;
        if (r.isNew && !initialSync) r.want = true;
        if (!r.want) continue;
        if (!Signals.isOpen(r.sig)) { r.want = false; continue; }
        await send(msgNewSignal(r.sig, src, nowT));
        r.ann = true; r.want = false;
        r.sent = { status: r.sig.status, tp: r.sig.tpHit.slice() };
        messages++;
      }
      // Итоги недели — по понедельникам, если бот работал на прошлой неделе.
      const wk = weekStartUTC(nowT), wkKey = new Date(wk).toISOString().slice(0, 10);
      if (new Date(nowT).getUTCDay() === 1 && st.summaryWeek !== wkKey && st.startedT < wk) {
        await send(msgSummary(st, wk - 7 * 86400000, wk));
        st.summaryWeek = wkKey;
        messages++;
      }
    } catch (e) {
      errors.push(mask(e.message));
      log('Telegram: ' + mask(e.message));
    }
  }
  st.signals.forEach(r => { delete r.isNew; });

  // 6. Состояние и отчёт.
  st.source = src.id;
  pruneState(st, nowT);
  const changed = !existed || fingerprint(st) !== fp0;
  if (changed) writeJSON(STATE_FILE, st);
  const openList = st.signals.filter(r => Signals.isOpen(r.sig));
  status.signals = { open: openList.length, new: found.filter(f => f.kept).length, events, messages };
  status.requests = netRequests;
  status.durationMs = Date.now() - t0;
  const wroteStatus = writeStatus(prevStatus, status, changed);

  log('Пресеты: ' + PRESETS.map(presetName).join(', ') + ' · профиль «' + modeShort(Q.strategy) + '» · ожидание ' + Q.expiryBars + ' свечей (' + waitByPreset() + ') · minScore ' + Q.minScore);
  log('Открытых сигналов: ' + openList.length + ' · найдено в этом запуске: ' + found.length + ' · событий: ' + events + ' · сообщений: ' + messages);
  if (found.length) {
    log('Найдено в окне детектора' + (LOOKBACK ? ' (' + LOOKBACK + ' свечей младшего ТФ)' : '') + ':');
    found.sort((a, b) => a.sig.createdT - b.sig.createdT).forEach(f => log('  ' + sigLine(f.sig, f.kept)));
  }
  if (openList.length) {
    log('Открытые сейчас:');
    openList.forEach(r => log('  ' + sigLine(r.sig, true) + (r.ann ? ' · показан' : ' · без уведомления')));
  }
  if (errors.length) log('Ошибки: ' + errors.slice(0, 10).join(' | '));
  log('Состояние: ' + (changed ? (NO_WRITE ? 'изменилось (не записано: --no-write)' : 'записано') : 'без существенных изменений') +
    ' · status.json: ' + (wroteStatus && !NO_WRITE ? 'записан' : 'без изменений') +
    ' · запросов к бирже: ' + netRequests + ' · ' + ((Date.now() - t0) / 1000).toFixed(1) + ' с');
  return 0;
}

// Все виды сообщений на примере (проверка текстов): --demo-messages.
function demoMessages() {
  const nowT = Date.now();
  const ltfMs = SMC.tfMs('15m');
  const T = Math.floor(nowT / ltfMs) * ltfMs - 2 * ltfMs;
  const lv = SMC.levelsFrom(1, 100, 98, 4.5, C);
  const base = Signals.create({
    sym: 'ETHUSDT', coin: 'ETH', dir: 1, side: 'LONG', tf: { ltf: '15m', mtf: '1h', htf: '4h' }, T: T, triggerT: T - ltfMs,
    entry: 100, sl: 98, tp1: lv.tp1, tp2: lv.tp2, tp3: lv.tp3, R: 2, riskPct: 2, roomR: 4.5, tp3R: lv.tp3R,
    zone: { bot: 99, top: 100, kind: 'ob', t: T - 5 * ltfMs }, poi: null, sweep: null, structure: null, ote: null, inOte: false,
    target: null, bias: null, disp: null, score: 78, factors: [], penalties: []
  }, { fee: C.fees.futures / 100, slip: C.slippagePct / 100, ltfMs, preset: 'main', mode: Q.strategy, expiryBars: Q.expiryBars, source: 'Binance Futures' });
  const spot = { id: 'binanceSpot', name: 'Binance Spot', host: 'data-api.binance.vision' };
  const fut = { id: 'binanceFutures', name: 'Binance Futures', host: 'fapi.binance.com' };
  const msgs = [];
  msgs.push(msgWelcome({ coins: Q.symbols.length, skipped: 0, open: 2, src: spot }));
  msgs.push(msgChatId('123456789'));
  msgs.push(msgNewSignal(base, fut, T + 5 * 60000));
  const h1 = SMC.tfMs('1h'), Ts = Math.floor(nowT / h1) * h1;
  const swing = Signals.create({
    sym: 'SOLUSDT', coin: 'SOL', dir: -1, side: 'SHORT', tf: { ltf: '1h', mtf: '4h', htf: '1d' }, T: Ts, triggerT: Ts - h1,
    entry: 150, sl: 153, tp1: 147, tp2: 144, tp3: 135, R: 3, riskPct: 2, roomR: 5, tp3R: 5,
    zone: { bot: 149, top: 150, kind: 'ob', t: Ts - 6 * h1 }, poi: null, sweep: null, structure: null, ote: null, inOte: false,
    target: null, bias: null, disp: null, score: 84, factors: [], penalties: []
  }, { fee: C.fees.futures / 100, slip: C.slippagePct / 100, ltfMs: h1, preset: 'swing', mode: Q.strategy, expiryBars: Q.expiryBars, source: 'Binance Futures' });
  msgs.push(msgNewSignal(swing, fut, Ts + 4 * 60000));
  const late = JSON.parse(JSON.stringify(base));
  late.status = 'active'; late.filledT = T + ltfMs;
  msgs.push(msgNewSignal(late, spot, T + 50 * 60000));
  const pend = { status: 'pending', tp: [false, false, false] };
  function run(sig, cds) { const s = JSON.parse(JSON.stringify(sig)); cds.forEach(cd => Signals.step(s, cd, C)); return s; }
  const c = (k, o, h, l, cl) => ({ t: T + k * ltfMs, o, h, l, c: cl, v: 1, closed: true });
  // Свечи подобраны так, чтобы после TP1/TP2 цена не задевала новый стоп (иначе по правилу «SL первым»
  // сделка закрылась бы на той же свече).
  const k1 = c(1, 100.5, 100.6, 99.8, 100.2), k2 = c(2, 100.2, 102.3, 100.5, 102.1), k3 = c(3, 102.1, 104.3, 102.5, 104.1);
  const filled = run(base, [k1]);
  msgs.push(eventLines(filled, pend).join('\n'));
  const tp1 = run(base, [k1, k2]);
  msgs.push(eventLines(tp1, { status: 'active', tp: [false, false, false] }).join('\n'));
  const tp2 = run(base, [k1, k2, k3]);
  msgs.push(eventLines(tp2, { status: 'active', tp: [true, false, false] }).join('\n'));
  const tp3 = run(base, [k1, k2, k3, c(4, 104, 109.5, 103.9, 109)]);
  msgs.push(eventLines(tp3, { status: 'active', tp: [true, true, false] }).join('\n'));
  const slh = run(base, [k1, c(2, 100, 100.3, 97.5, 97.8)]);
  msgs.push(eventLines(slh, { status: 'active', tp: [false, false, false] }).join('\n'));
  const beh = run(base, [k1, k2, c(3, 102, 102.2, 99.9, 100)]);
  msgs.push(eventLines(beh, { status: 'active', tp: [true, false, false] }).join('\n'));
  const tp2stop = run(base, [k1, k2, k3, c(4, 104, 104.2, 101.8, 102)]);
  msgs.push(eventLines(tp2stop, { status: 'active', tp: [true, true, false] }).join('\n'));
  const exp = JSON.parse(JSON.stringify(base));
  exp.status = 'expired'; exp.outcome = 'expired'; exp.closedT = exp.expiresT;
  msgs.push(eventLines(exp, pend).join('\n'));
  const inv = JSON.parse(JSON.stringify(base));
  inv.status = 'invalidated'; inv.outcome = 'invalidated'; inv.closedT = T + 2 * ltfMs; inv.note = 'закрытие тела за зоной до входа';
  msgs.push(eventLines(inv, pend).join('\n'));
  const fastAll = run(base, [k1, k2]);
  msgs.push(eventLines(fastAll, pend).join('\n'));
  const st = newState(nowT - 20 * 86400000);
  const wk = weekStartUTC(nowT);
  [tp3, slh, beh, filled].forEach((s, k) => st.signals.push({ sig: Object.assign({}, s, { createdT: wk - (6 - k) * 86400000, closedT: s.closedT ? wk - (5 - k) * 86400000 : null }), ann: true, sent: pend }));
  msgs.push(msgSummary(st, wk - 7 * 86400000, wk));
  return (async () => { for (const m of msgs) await send(m); log('\nПоказано сообщений: ' + msgs.length); return 0; })();
}

main().then(code => { process.exitCode = code || 0; }, e => {
  console.error('Ошибка бота: ' + mask(e && e.stack ? e.stack : e));
  process.exitCode = 1;
});
