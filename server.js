// ═══════════════════════════════════════════════════════════════
//  server.js — Itachi BOT-BTC v6.0 « Srv 4.0 » — PROXY v3.5 + MOTEUR SERVEUR
//  PARTIE 1/2 : transport & endpoints proxy v3.5 (INCHANGES, compatibilite PWA totale)
//  Transport transplanté du serveur 3.13-Champion (qui trade avec
//  succès sur le même demo-fapi, depuis le même Railway EU West) :
//   1. KEEP-WARM 3s  : le pool undici ferme les connexions après ~4s
//      → sans ping, les ordres partent à froid et échouent (-1007).
//   2. TIME_OFFSET   : horloge alignée sur Binance (anti -1021).
//   3. recvWindow 10000, abort 8s, parse prudent (testnet renvoie
//      parfois du HTML/vide au lieu du JSON).
//   4. SL/TP → /fapi/v1/algoOrder (migration Binance 09/12/2025,
//      correctif -4120) avec repli ancien endpoint.
//   5. Reprise -1007 conservée (vérif par identifiant client).
//   6. GET /api/diag : IP/pays de sortie, horloge, lecture, écriture.
//  Clés du diag : variables Railway BN_TEST_KEY / BN_TEST_SECRET.
//
//  ─── CHANGEMENTS v3.2 (uniquement /api/diag) ───
//   A. /api/diag accepte ?mode=mainnet|testnet (défaut: mainnet).
//   B. Lecture d'IP de sortie fiabilisée : api.ipify.org en premier.
//   C. Le diag indique quel 'base' (serveur) a réellement été testé.
//
//  ─── CHANGEMENTS v3.3 (PLOMBERIE D'EXÉCUTION — stratégie INCHANGÉE) ───
//   D. CORRECTIF -1102 : placeConditional() ajoute algoType:'CONDITIONAL',
//      paramètre obligatoire de /fapi/v1/algoOrder (doc Binance). Sans lui,
//      les STOP_MARKET/TAKE_PROFIT_MARKET étaient rejetés → stops non posés.
//   E. CORRECTIF -2022 : nouvelle fonction getRealPosition() lit la position
//      RÉELLE via GET /fapi/v2/positionRisk (champ positionAmt) AVANT toute
//      fermeture. Toute requête reduceOnly/closePosition est réconciliée
//      avec Binance = source de vérité :
//        • si Binance montre 0 → la fermeture est ANNULÉE proprement
//          (renvoie {code:0, reconciled:true}), plus de -2022 sur fantôme ;
//        • si la quantité demandée > quantité réelle → elle est PLAFONNÉE
//          à la quantité réelle (on ne ferme jamais plus qu'il n'existe).
//      Détection d'une fermeture : reduceOnly=true OU closePosition=true,
//      OU un ordre MARKET dont le side est opposé à la position ouverte.
//   F. Le sizing d'OUVERTURE n'est PAS touché : la PWA envoie sa quantité,
//      le proxy la transmet telle quelle. On ne réconcilie qu'à la fermeture,
//      là où la divergence PWA/Binance est dangereuse.
//   Aucune touche à : cadence, seuils Q, mises, levier, EMA, SL/TP %.
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const crypto  = require('crypto');

const app  = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());

// ── CORS ──
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-api-key, x-api-secret, x-bn-mode');
  res.header('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.status(200).end();
  next();
});

const BN_BASES = {
  testnet: 'https://demo-fapi.binance.com',
  mainnet: 'https://fapi.binance.com'
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ══ 1+2. SYNCHRO HORLOGE + KEEP-WARM (recette Champion, lignes 381-398) ══
let TIME_OFFSET = 0; // serverTime - horloge locale (ms), lissé
let WARM_BASE = BN_BASES.mainnet;   // hote a garder chaud (bascule sur l'hote moteur apres la config)
async function syncTimeAndWarm() {
  try {
    if (!Number.isFinite(TIME_OFFSET)) TIME_OFFSET = 0;   // v8.2.1 : auto-guerison si jamais corrompu
    const t0 = Date.now();
    const r  = await fetch(WARM_BASE + '/fapi/v1/time', { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return;                                    // v8.2.1 : erreur HTTP → echantillon ignore
    const d  = await r.json();
    if (!d || !Number.isFinite(d.serverTime)) return;     // v8.2.1 : reponse sans serverTime → ignore
    const rtt = Date.now() - t0;
    const offset = d.serverTime + rtt / 2 - Date.now();
    if (!Number.isFinite(offset)) return;                 // v8.2.1 : jamais de NaN dans le lissage
    TIME_OFFSET = TIME_OFFSET === 0 ? offset : TIME_OFFSET * 0.8 + offset * 0.2; // lissage
  } catch (e) { /* silencieux : le prochain ping réessaie */ }
}

// ══ 3. TRANSPORT SIGNÉ — clone exact du signedRequest Champion ══
// Renvoie TOUJOURS un objet (jamais de throw) : JSON Binance brut,
// ou { code:-1007 } sur timeout réseau, ou { code:-1, raw } sur non-JSON.
async function bnCall(base, path, method, params, apiKey, apiSecret) {
  const timestamp = Date.now() + (Number.isFinite(TIME_OFFSET) ? Math.round(TIME_OFFSET) : 0);   // v8.2.1 : ceinture
  const query = new URLSearchParams({ ...params, timestamp, recvWindow: 10000 }).toString();
  const signature = crypto.createHmac('sha256', apiSecret).update(query).digest('hex');
  const url = `${base}${path}?${query}&signature=${signature}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  const t0 = Date.now();
  try {
    const res  = await fetch(url, { method, headers: { 'X-MBX-APIKEY': apiKey }, signal: controller.signal });
    const text = await res.text();
    let data = null; try { data = JSON.parse(text); } catch (_) {}
    if (data == null) return { code: -1, msg: 'Reponse non-JSON', httpStatus: res.status, ms: Date.now() - t0, raw: text.slice(0, 300) };
    return data;
  } catch (e) {
    if (e.name === 'AbortError' || e.name === 'TimeoutError')
      return { code: -1007, msg: 'timeout reseau proxy (8s)', ms: Date.now() - t0 };
    return { code: -1, msg: 'Proxy fetch: ' + e.message, ms: Date.now() - t0 };
  } finally { clearTimeout(timer); }
}

async function orderExists(base, symbol, clientId, apiKey, apiSecret) {
  const check = await bnCall(base, '/fapi/v1/order', 'GET', { symbol, origClientOrderId: clientId }, apiKey, apiSecret);
  return (check && check.orderId) ? check : null;
}

// ══ E. RÉCONCILIATION — Binance = source de vérité (correctif -2022) ══
// Lit la position RÉELLE d'un symbole via /fapi/v2/positionRisk.
// Retourne { amt, side } : amt = |positionAmt| (>=0), side = 'BUY'|'SELL'|null.
//  - positionAmt > 0  → position LONG   (se ferme par un SELL)
//  - positionAmt < 0  → position SHORT  (se ferme par un BUY)
//  - positionAmt = 0  → aucune position réelle
async function getRealPosition(base, symbol, apiKey, apiSecret) {
  const r = await bnCall(base, '/fapi/v2/positionRisk', 'GET', { symbol }, apiKey, apiSecret);
  if (!Array.isArray(r)) return { amt: 0, side: null, raw: r }; // erreur : on renvoie 0 (prudent)
  const row = r.find(p => p && p.symbol === symbol) || r[0];
  if (!row) return { amt: 0, side: null };
  const net = parseFloat(row.positionAmt || '0');
  if (!isFinite(net) || net === 0) return { amt: 0, side: null };
  return { amt: Math.abs(net), side: net > 0 ? 'SELL' : 'BUY', net };
}

// Détermine si une requête d'ordre est une FERMETURE (à réconcilier).
function isCloseRequest(path, params, realSide) {
  if (!path.includes('/order')) return false;
  const ro = params.reduceOnly === true || params.reduceOnly === 'true';
  const cp = params.closePosition === true || params.closePosition === 'true';
  if (ro || cp) return true;
  // Ordre MARKET dont le side ferme la position réelle (ex : position LONG → SELL MARKET)
  if ((params.type === 'MARKET') && realSide && params.side === realSide) return true;
  return false;
}

// ══ 4. SL/TP conditionnels → service ALGO (migration 09/12/2025), repli ancien ══
// Structure copiée de placeExchangeStops du Champion.
// v3.4 : correctifs -1102 CONFIRMÉS PAR LA DOC officielle /fapi/v1/algoOrder :
//   • algoType:'CONDITIONAL' (obligatoire).
//   • le type d'ordre s'envoie sous le nom 'type' (PAS 'orderType' ; orderType
//     est le nom du champ dans la RÉPONSE, mais 'type' dans la REQUÊTE).
//   • timeInForce doit valoir IOC|GTC|FOK|GTX ('GTE_GTC' était invalide) → GTC.
async function placeConditional(base, params, apiKey, apiSecret) {
  const algoParams = {
    algoType: 'CONDITIONAL',                                   // obligatoire (doc)
    symbol: params.symbol,
    side: params.side,
    type: params.type,                                        // STOP_MARKET | TAKE_PROFIT_MARKET | TRAILING_STOP_MARKET
    workingType: params.workingType || 'MARK_PRICE',
  };
  if (params.type === 'TRAILING_STOP_MARKET') {
    // v3.5 — trailing NATIF Binance : suivi du pic cote exchange, gain non plafonne.
    if (params.callbackRate    != null) algoParams.callbackRate    = params.callbackRate;    // en % (0.1 a 10)
    if (params.activationPrice != null) algoParams.activationPrice = params.activationPrice; // niveau d'armement (= ancien TP)
  } else {
    algoParams.triggerPrice = params.stopPrice;
    algoParams.timeInForce  = params.timeInForce || 'GTC';    // GTC (valeur valide doc)
  }
  // Stops PAR TRADE : si une quantité est fournie, le stop ne ferme que SA part
  if (params.quantity != null && params.quantity !== '') {
    algoParams.quantity   = params.quantity;
    algoParams.reduceOnly = params.reduceOnly || 'true';
  } else {
    algoParams.closePosition = params.closePosition || 'true';
  }
  const a = await bnCall(base, '/fapi/v1/algoOrder', 'POST', algoParams, apiKey, apiSecret);
  if (a && (a.algoId || a.orderId || a.clientAlgoId)) {
    return { orderId: a.algoId || a.orderId, algo: true, ...a };
  }
  // Repli : ancien endpoint (environnements pas encore migrés)
  const b = await bnCall(base, '/fapi/v1/order', 'POST', params, apiKey, apiSecret);
  if (b && b.orderId) return b;
  return { code: (a && a.code) || (b && b.code) || -1, msg: 'algo: ' + JSON.stringify(a).slice(0,120) + ' / classique: ' + JSON.stringify(b).slice(0,120) };
}

// ── Health (le GET / est desormais le DASHBOARD, defini plus bas ; JSON -> /api/health) ──
app.get('/api/binance', (req, res) => res.status(200).json({ ok: true, msg: 'Proxy Railway vivant (v6.0 : moteur serveur + trailing natif + stops type + reconciliation fermeture + PnL reel + keep-warm)', clockOffsetMs: Math.round(TIME_OFFSET), modes: Object.keys(BN_BASES) }));

// ══ POINT 2 — P&L NET RÉEL + FRAIS depuis Binance (source de vérité comptable) ══
// La PWA interroge cet endpoint (POST, clés dans headers comme /api/binance)
// pour afficher le NET RÉEL à côté de sa simulation. Agrège /fapi/v1/income :
//   • REALIZED_PNL  : profit/perte réalisé réel des trades fermés
//   • COMMISSION    : frais Binance réels payés (négatifs)
//   • FUNDING_FEE   : frais de financement perpétuel (peut être +/-)
// net_reel = somme(REALIZED_PNL) + somme(COMMISSION) + somme(FUNDING_FEE).
// Optionnel body: { symbol, startTime, limit }. Défaut: lignes récentes.
app.post('/api/pnl-reel', async (req, res) => {
  try {
    const apiKey    = req.headers['x-api-key'];
    const apiSecret = req.headers['x-api-secret'];
    const mode      = req.headers['x-bn-mode'] === 'mainnet' ? 'mainnet' : 'testnet';
    const base      = BN_BASES[mode];
    if (!apiKey || !apiSecret) return res.status(200).json({ code: -2014, msg: 'Cles API manquantes dans les headers' });

    const body = req.body || {};
    const p = { limit: body.limit || 1000 };
    if (body.symbol)    p.symbol = body.symbol;
    if (body.startTime) p.startTime = body.startTime;

    const rows = await bnCall(base, '/fapi/v1/income', 'GET', p, apiKey, apiSecret);
    if (!Array.isArray(rows)) return res.status(200).json({ code: (rows && rows.code) || -1, msg: 'income non-array', raw: rows });

    let realizedPnl = 0, commission = 0, funding = 0;
    for (const r of rows) {
      const v = parseFloat(r.income || '0');
      if (!isFinite(v)) continue;
      if (r.incomeType === 'REALIZED_PNL') realizedPnl += v;
      else if (r.incomeType === 'COMMISSION') commission += v;
      else if (r.incomeType === 'FUNDING_FEE') funding += v;
    }
    const round = x => Math.round(x * 1e8) / 1e8;
    const net_reel = round(realizedPnl + commission + funding);

    return res.status(200).json({
      ok: true,
      source: 'Binance /fapi/v1/income (verite comptable)',
      mode,
      realized_pnl: round(realizedPnl),   // gains/pertes bruts realises
      frais_binance: round(commission),   // commissions reelles (negatif)
      funding_fee: round(funding),        // financement perpetuel
      net_reel,                           // ← LE net reel a afficher dans la PWA
      lignes: rows.length
    });
  } catch (e) {
    return res.status(200).json({ code: -1, msg: 'Proxy pnl-reel: ' + e.message });
  }
});

// ══ 6. DIAGNOSTIC ══
// v3.2 : ?mode=mainnet (défaut) ou ?mode=testnet. Le diag teste le
// serveur correspondant aux clés présentes dans BN_TEST_KEY/SECRET.
app.get('/api/diag', async (req, res) => {
  const mode = (req.query.mode === 'testnet') ? 'testnet' : 'mainnet';   // défaut MAINNET
  const base = BN_BASES[mode];
  const out = { version: 'v8.5-belock', date: new Date().toISOString(), mode_teste: mode, base_testee: base, clockOffsetMs: Math.round(TIME_OFFSET) };

  // ── Lecture IP de sortie : ipify d'abord (fiable), replis ensuite ──
  try {
    const r = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(6000) });
    const j = await r.json();
    out.sortie = { ip: j.ip };
  } catch (e) {
    try { const r2 = await fetch('https://ifconfig.co/json', { signal: AbortSignal.timeout(6000) }); const j2 = await r2.json(); out.sortie = { ip: j2.ip, pays: j2.country }; }
    catch (e2) {
      try { const r3 = await fetch('https://ipapi.co/json/', { signal: AbortSignal.timeout(6000) }); const j3 = await r3.json(); out.sortie = { ip: j3.ip, pays: j3.country_name, ville: j3.city, org: j3.org }; }
      catch (e3) { out.sortie = { erreur: e3.message }; }
    }
  }

  // ── Ping non signé du serveur testé ──
  { const t0 = Date.now();
    try { const r = await fetch(base + '/fapi/v1/time', { signal: AbortSignal.timeout(8000) }); const txt = await r.text();
      out.ping_binance = { httpStatus: r.status, ms: Date.now() - t0, extrait: txt.slice(0, 80) };
    } catch (e) { out.ping_binance = { erreur: e.message, ms: Date.now() - t0 }; } }

  const apiKey = process.env.BN_TEST_KEY, apiSecret = process.env.BN_TEST_SECRET;
  if (!apiKey || !apiSecret) { out.lecture_signee = out.test_ecriture = 'Variables BN_TEST_KEY / BN_TEST_SECRET absentes sur Railway'; return res.status(200).json(out); }

  // ── Lecture signée (solde) sur le serveur testé ──
  { const t0 = Date.now();
    const j = await bnCall(base, '/fapi/v2/balance', 'GET', {}, apiKey, apiSecret);
    out.lecture_signee = { ms: Date.now() - t0, verdict: Array.isArray(j) ? 'OK (' + j.length + ' actifs)' : ('code ' + j.code + ' — ' + (j.msg || '')), extrait: JSON.stringify(j).slice(0, 120) }; }

  // ── Test écriture (rejet instantané attendu : quantité 0) ──
  { const t0 = Date.now();
    const j = await bnCall(base, '/fapi/v1/order', 'POST',
      { symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: 0, newClientOrderId: 'diag' + Date.now() },
      apiKey, apiSecret);
    out.test_ecriture = { ms: Date.now() - t0,
      verdict: (j.code && j.code !== -1007 && j.code !== -1) ? ('JSON code ' + j.code + ' — chemin ECRITURE SAIN (rejet instantané attendu)') : ('PROBLEME: ' + JSON.stringify(j).slice(0, 200)),
      extrait: JSON.stringify(j).slice(0, 300) }; }

  res.status(200).json(out);
});

// ══ ENDPOINT PRINCIPAL ══
app.post('/api/binance', async (req, res) => {
  try {
    const apiKey    = req.headers['x-api-key'];
    const apiSecret = req.headers['x-api-secret'];
    const mode      = req.headers['x-bn-mode'] === 'mainnet' ? 'mainnet' : 'testnet';
    const base      = BN_BASES[mode];
    if (!apiKey || !apiSecret) return res.status(200).json({ code: -2014, msg: 'Cles API manquantes dans les headers' });

    const body   = req.body || {};
    const path   = body.path || '/fapi/v2/balance';
    const method = (body.method || 'GET').toUpperCase();
    const params = { ...(body.params || {}) };

    const isOrder = method === 'POST' && path.includes('/order');
    const isConditional = isOrder && (params.type === 'STOP_MARKET' || params.type === 'TAKE_PROFIT_MARKET' || params.type === 'TRAILING_STOP_MARKET');

    let data;

    if (isConditional) {
      // ── SL/TP : route ALGO (correctif -4120 + algoType -1102) avec repli ──
      data = await placeConditional(base, params, apiKey, apiSecret);
    } else if (isOrder) {
      // ══ E. RÉCONCILIATION AVANT FERMETURE (correctif -2022) ══
      // On lit la position réelle. Si la requête est une fermeture, on la
      // confronte à Binance : annulée si rien à fermer, plafonnée sinon.
      let real = { amt: 0, side: null };
      if (params.symbol) real = await getRealPosition(base, params.symbol, apiKey, apiSecret);

      if (isCloseRequest(path, params, real.side)) {
        if (real.amt === 0) {
          // Rien à fermer côté Binance → on n'envoie PAS l'ordre (évite -2022)
          console.log(`[FERMETURE ANNULEE] ${params.symbol} : aucune position reelle chez Binance (source de verite).`);
          return res.status(200).json({ code: 0, reconciled: true, msg: 'Aucune position reelle a fermer (reconcilie avec Binance).', requested: params.quantity });
        }
        // Plafonne la quantité fermée à la quantité réellement ouverte
        if (params.quantity != null && params.quantity !== '') {
          const q = parseFloat(params.quantity);
          if (isFinite(q) && q > real.amt) {
            console.log(`[FERMETURE PLAFONNEE] ${params.symbol} : demande ${q} > reel ${real.amt} → ferme ${real.amt}.`);
            params.quantity = String(real.amt);
          }
        }
        // Sécurité : une fermeture doit être reduceOnly (jamais ouvrir l'opposé)
        if (!(params.closePosition === true || params.closePosition === 'true')) {
          params.reduceOnly = 'true';
        }
      }

      if (!params.newClientOrderId) params.newClientOrderId = 'itachi' + Date.now() + Math.floor(Math.random() * 1000);
      const id1 = params.newClientOrderId;

      data = await bnCall(base, path, method, params, apiKey, apiSecret);

      // ── Reprise -1007 : Binance = source de vérité ──
      if (data && data.code === -1007) {
        await sleep(2500);
        const found1 = await orderExists(base, params.symbol, id1, apiKey, apiSecret);
        if (found1) data = { ...found1, recovered: true };
        else {
          await sleep(1000);
          const id2 = id1 + 'r';
          const retry = await bnCall(base, path, method, { ...params, newClientOrderId: id2 }, apiKey, apiSecret);
          if (retry && retry.orderId) data = { ...retry, retried: true };
          else if (retry && retry.code === -1007) {
            await sleep(2500);
            const found2 = await orderExists(base, params.symbol, id2, apiKey, apiSecret);
            data = found2 ? { ...found2, recovered: true, onRetry: true } : retry;
          } else data = retry;
        }
      }
    } else {
      // Requête non-ordre (lecture) : transmise telle quelle
      data = await bnCall(base, path, method, params, apiKey, apiSecret);
    }

    if (isOrder) {
      if (data && data.orderId) console.log(`[ORDER OK] ${params.symbol} ${params.side} ${params.type} → #${data.orderId}${data.algo ? ' (algo)' : ''}${data.recovered ? ' (recovered)' : ''}${data.retried ? ' (retried)' : ''}`);
      else if (data && data.reconciled) { /* déjà loggé */ }
      else console.log(`[ORDER FAIL] ${params.symbol} ${params.side} ${params.type} → ${JSON.stringify(data).slice(0, 400)}`);
    }

    return res.status(200).json(data);
  } catch (e) {
    return res.status(200).json({ code: -1, msg: 'Proxy Railway: ' + e.message });
  }
});

// ══ Synchro horloge immédiate puis keep-warm toutes les 3s (recette Champion) ══
syncTimeAndWarm();
setInterval(syncTimeAndWarm, 3000);

// ═══════════════════════════════════════════════════════════════
//  PARTIE 2/2 — MOTEUR DE TRADING SERVEUR v6.0 « Srv 4.0 »
//  Portage INTEGRAL du cerveau Itachi v5.1 REAL (PWA) vers Railway.
//  Decrets appliques (tous anterieurs, AUCUN nouveau parametre) :
//   • SL -0.8% fixe (STOP_MARKET natif, reduceOnly, par trade)
//   • TREND : trailing NATIF Binance — armement +1.6%, callback -0.5%
//   • RANGE : TP FIXE +0.7% (TAKE_PROFIT_MARKET natif)
//   • Mises 50 / 67.50 / 87.50 $ selon Q — Leviers 3x / 7x / 12x
//   • MIN_GAP 90s | MAX 2 positions meme sens | espacement 0.3%
//   • Kill switch : perte session reelle >= 20% du capital ref (500$ → -100$)
//   • Multi-regime ADX(14) Wilder sur 5m : UP=longs / DOWN=shorts /
//     RANGE=mean-reversion 2 sens (Bollinger 20/2σ + RSI 14 sur 1m)
//   • Decisions UNIQUEMENT sur clotures de bougies 1m officielles
//   • Binance = source de verite : reconciliation 9s, adoption au boot
//  Activation par variables Railway UNIQUEMENT (deploiement = no-op) :
//   ENGINE_MODE = off (defaut) | paper | live
//   BINANCE_API_KEY / BINANCE_API_SECRET (obligatoires en live)
//   ENGINE_NET = mainnet (defaut) | testnet
//   SYMBOL = BTCUSDT (defaut) | CAPITAL = 500 (defaut)
// ═══════════════════════════════════════════════════════════════

// ── CONFIGURATION MOTEUR (variables Railway) ──
let ENGINE_MODE = (process.env.ENGINE_MODE || 'off').toLowerCase();   // off | paper | live — passe a 'live' via /api/engine/start
const ENGINE_NET  = (process.env.ENGINE_NET  || 'mainnet').toLowerCase() === 'testnet' ? 'testnet' : 'mainnet';
let E_KEY       = process.env.BINANCE_API_KEY    || '';   // RAM uniquement via /api/engine/start
let E_SECRET    = process.env.BINANCE_API_SECRET || '';
const SYMBOL      = (process.env.SYMBOL || 'BTCUSDT').toUpperCase();
const E_BASE      = BN_BASES[ENGINE_NET];
WARM_BASE = E_BASE;                                // keep-warm + horloge sur l'hote reel des ordres
const KLINE_BASE  = BN_BASES.mainnet;              // klines toujours mainnet (testnet = historique pauvre)

// ── PARAMETRES STRATEGIQUES (decrets — IMMUABLES sans backtest/decret) ──
const P = {
  CAP: parseFloat(process.env.CAPITAL || '2000'),   // decret 06/07 soir : capital ref 2000 (kill -20% = -400$)
  STAKE: 750, STAKE_MID: 750, STAKE_MAX: 750,   // DECRET v8 SWING : mise unique 750$ (dynamique ±5%/100$)
  MAX_OP: 2,   // v8 : 2 positions max
  LEV_LOW: 12, LEV_MED: 17, LEV_HIGH: 23,   // v8 : levier selon qualite du signal
  KILL: 0.20,
  FEE_SIDE: 0.0005,            // taker mainnet 0.05% par cote (paper)
  EMA_F: 8, EMA_S: 21
};
const MIN_GAP_MS    = 90 * 1000;   // decret v5.1 : 1min30 entre deux entrees
const MAX_SAME_DIR  = 2;           // decret v5.1 : max 2 positions meme sens
const ENTRY_SPACING = 0.003;       // decret v5.1 : espacement >= 0.3% entre entrees meme sens
const ADX_PERIOD = 14, ADX_TREND = 20;
// ── DECRET 05/07 « marche calme, Q35 ok » ──
const RSI_LO = 38, RSI_HI = 62;    // bornes RSI assouplies en RANGE (etaient 32/68)
const QMR_MIN = 35;                // plancher de qualite mean-reversion decrete
// ── DECRET 05/07 « MODE RELANCE » : pas d'entree en 30 min → entree forcee ──
//  Geometrie EV-neutre a WR 50% : gagnant net +0.6%, perdant net -0.6% (frais 0.10% inclus)
//  Decret 11/07 : OFF par defaut (verdict live 0/4) — reactivable SANS redeploiement via FORCE_MODE=on
const FORCE_MODE     = (process.env.FORCE_MODE || 'off').toLowerCase() === 'on';
const FORCE_AFTER_MS = (parseInt(process.env.FORCE_AFTER_MIN || '30') || 30) * 60000;
const FORCE_LEV = 12;              // decret : haut levier
const FORCE_STAKE = 750;           // v8 : relance/manuel alignes sur la mise unique
// ── DECRET 07/07 soir : v8 SWING — sorties en % de MISE, UNIFIEES pour toutes les voies ──
const SWING_SL_M  = 0.30;   // SL = -30% de la mise
const SWING_ARM_M = 0.60;   // armement du trailing = +60% de la mise
const SWING_CB_M  = 0.20;   // callback = 20 points de mise sous le pic → plancher ~+40%
const BE_ARM_M    = 0.30;   // decret 13/07 : a +30% de mise, SL natif remonte a break-even+frais
const TIME_STOP_MS = 4 * 3600 * 1000;   // garde-temps 4h (decret) puis retour au cycle
const KILL_MODE = (process.env.KILL_MODE || 'off').toLowerCase();   // decret : kill OFF — SL seuls gardiens (KILL_MODE=on pour reactiver)
function cbRate(lev) { return Math.min(10, Math.max(0.1, Math.round((SWING_CB_M / lev) * 1000) / 10)); } // callbackRate Binance (%, pas 0.1)
const QTY_DEC = SYMBOL === 'BTCUSDT' ? 3 : 0;      // precision quantite
const PX_DEC  = SYMBOL === 'BTCUSDT' ? 1 : 2;      // precision prix

// ── ETAT MOTEUR ──
const S = {
  running: false, killed: false,
  price: 0, chg24: null, pnlLow: 0, forceReq: 0, paused: false,
  revPend: null,               // decret 11/07 : retournement Q>=75 en attente de confirmation 5m
  avail: 0, lastAdoptSig: '', lastAdoptAt: 0, pnlHigh: 0, lastMult: 1,
  candles1m: [],               // clotures 1m {t,h,l,c} (max 240)
  candles5m: [], cur5: null,   // bougies 5m {h,l,c} pour ADX
  lastClosed1m: 0,             // openTime de la derniere 1m traitee
  regime: 'WARMUP', adx: 0, pdi: 0, ndi: 0,
  sigQ: 0, sigDir: 'NEUT', ef: 0, es: 0,
  trades: [], closed: [],      // positions ouvertes / historique
  lastEntry: 0,
  walletStart: 0, walletNow: 0, unreal: 0, sessionPnl: 0,
  netReel: null,               // { net, brut, frais, funding } via /fapi/v1/income
  paperCap: parseFloat(process.env.CAPITAL || '500'),
  startedAt: 0, ticks: 0, lastHb: 0,
  levSet: 0,                   // dernier levier pousse a Binance (cache)
  journal: [],                 // { ts, type, msg } (max 400)
  diag: [],                    // TELEMETRIE : 1 snapshot par cloture 1m (max 240)
  funnel: {}                   // compteurs de verdicts depuis le demarrage
};

function jlog(type, msg) {
  const e = { ts: Date.now(), type, msg };
  S.journal.push(e);
  if (S.journal.length > 400) S.journal.shift();
  console.log(`[BOT ${type}] ${msg}`);
  sseBroadcast({ kind: 'log', e });
}

// ═════════════ INDICATEURS (portage exact v5.1 — fonctions pures) ═════════════
function calcEMA(prices, period) {
  if (prices.length < period) return null;
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) ema = prices[i] * k + ema * (1 - k);
  return ema;
}

function calcSignal(prices) {
  if (prices.length < P.EMA_F + 2) return { q: 0, dir: 'NEUT', ef: null, es: null, mom: 0 };
  const ef = calcEMA(prices, Math.min(P.EMA_F, prices.length));
  const es = prices.length >= P.EMA_S
    ? calcEMA(prices, P.EMA_S)
    : calcEMA(prices, Math.max(P.EMA_F + 1, Math.floor(prices.length * 0.7)));
  const n = prices.length;
  const lookback = Math.min(4, n - 1);
  const mom = (prices[n-1] - prices[n-1-lookback]) / prices[n-1-lookback];
  const momScore = Math.min(50, Math.abs(mom) * 50000);
  const emaDiff  = Math.abs(ef - es) / es;
  const emaScore = Math.min(30, emaDiff * 100000);
  const aligned  = (ef > es && mom > 0) || (ef < es && mom < 0);
  const q = Math.min(99, Math.round(momScore + emaScore + (aligned ? 20 : 0)));
  let dir = 'NEUT';
  if (mom > 0.00005 && ef >= es) dir = 'BULL';
  else if (mom < -0.00005 && ef <= es) dir = 'BEAR';
  return { q, dir, ef, es, mom };
}

// ADX de Wilder (New Concepts in Technical Trading Systems, 1978)
function calcADX(c5, period) {
  if (!c5 || c5.length < period * 2 + 2) return null;
  const trs = [], pdms = [], ndms = [];
  for (let i = 1; i < c5.length; i++) {
    const h = c5[i].h, l = c5[i].l, ph = c5[i-1].h, pl = c5[i-1].l, pc = c5[i-1].c;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    const up = h - ph, dn = pl - l;
    pdms.push(up > dn && up > 0 ? up : 0);
    ndms.push(dn > up && dn > 0 ? dn : 0);
  }
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0);
  let pdm = pdms.slice(0, period).reduce((a, b) => a + b, 0);
  let ndm = ndms.slice(0, period).reduce((a, b) => a + b, 0);
  let pdi = 0, ndi = 0;
  const dxs = [];
  for (let i = period; i < trs.length; i++) {
    atr = atr - atr / period + trs[i];
    pdm = pdm - pdm / period + pdms[i];
    ndm = ndm - ndm / period + ndms[i];
    pdi = atr > 0 ? 100 * pdm / atr : 0;
    ndi = atr > 0 ? 100 * ndm / atr : 0;
    dxs.push((pdi + ndi) > 0 ? 100 * Math.abs(pdi - ndi) / (pdi + ndi) : 0);
  }
  if (dxs.length < period) return null;
  let adx = dxs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dxs.length; i++) adx = (adx * (period - 1) + dxs[i]) / period;
  return { adx, pdi, ndi };
}

// RSI(14) de Wilder
function calcRSI(closes, period) {
  if (closes.length < period + 1) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i-1]; if (d >= 0) g += d; else l -= d; }
  let ag = g / period, al = l / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    ag = (ag * (period - 1) + (d > 0 ? d : 0)) / period;
    al = (al * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  if (al === 0) return 100;
  return 100 - 100 / (1 + ag / al);
}

// Bollinger (20, 2σ)
function calcBB(closes, period, mult) {
  if (closes.length < period) return null;
  const seg = closes.slice(-period);
  const m = seg.reduce((a, b) => a + b, 0) / period;
  const sd = Math.sqrt(seg.reduce((a, b) => a + (b - m) * (b - m), 0) / period);
  return { mid: m, up: m + mult * sd, lo: m - mult * sd, sd };
}

// Qualite d'un setup mean-reversion (0-99)
function calcQMR(dir, close, bb, rsi) {
  const rsiScore = dir === 'LONG'
    ? Math.min(40, Math.max(0, (RSI_LO - rsi) * 2.5))
    : Math.min(40, Math.max(0, (rsi - RSI_HI) * 2.5));
  const excess = dir === 'LONG' ? (bb.lo - close) : (close - bb.up);
  const bandScore = bb.sd > 0 ? Math.min(40, Math.max(0, (excess / bb.sd) * 40)) : 0;
  return Math.min(99, Math.round(20 + rsiScore + bandScore));
}

function getLev(q)   { return q < 45 ? P.LEV_LOW : q < 70 ? P.LEV_MED : P.LEV_HIGH; }
function getStake(q) { return q >= 70 ? P.STAKE_MAX : q >= 50 ? P.STAKE_MID : P.STAKE; }

// ── DECRET 07/07 : MISES DYNAMIQUES (anti-martingale) ──
// +5% de mise par palier de +100$ de P&L session, -5% par palier de -100$. Bornes [0.30 ; 2.00].
function sizeMultFor(pnl) { return Math.min(2, Math.max(0.3, 1 + 0.05 * Math.trunc(pnl / 100))); }
function sessionPnlNow() { return ENGINE_MODE === 'paper' ? (S.paperCap - P.CAP) : S.sessionPnl; }
function sizeMult() { return sizeMultFor(sessionPnlNow()); }

// ═════════════ REGIME (agregation 5m + classification) ═════════════
function aggregate5m(k) {
  const b = Math.floor(k.t / 300000);
  if (S.cur5 && b !== S.cur5.bucket) {
    S.candles5m.push({ h: S.cur5.h, l: S.cur5.l, c: S.cur5.c });
    if (S.candles5m.length > 300) S.candles5m.shift();
    S.cur5 = null;
    updateRegime();
  }
  if (!S.cur5) S.cur5 = { bucket: b, h: k.h, l: k.l, c: k.c };
  else { S.cur5.h = Math.max(S.cur5.h, k.h); S.cur5.l = Math.min(S.cur5.l, k.l); S.cur5.c = k.c; }
}

function classifyRegime(r) {
  if (!r) return 'WARMUP';
  if (r.adx >= ADX_TREND && r.pdi > r.ndi) return 'UP';
  if (r.adx >= ADX_TREND && r.ndi > r.pdi) return 'DOWN';
  return 'RANGE';
}

function updateRegime() {
  const r = calcADX(S.candles5m, ADX_PERIOD);
  if (!r) { S.regime = 'WARMUP'; S.adx = 0; return; }
  S.adx = r.adx; S.pdi = r.pdi; S.ndi = r.ndi;
  const prev = S.regime;
  S.regime = classifyRegime(r);
  if (prev !== S.regime) {
    const lbl = { RANGE: '◆ RANGE — mean-reversion 2 sens', UP: '▲ UP — longs seulement', DOWN: '▼ DOWN — shorts seulement' };
    jlog('sys', `🧭 REGIME ${lbl[S.regime]} | ADX ${r.adx.toFixed(1)} (+DI ${r.pdi.toFixed(1)} / -DI ${r.ndi.toFixed(1)})`);
  }
}

// ═════════════ WARM-UP (REST klines mainnet — donnees officielles) ═════════════
async function fetchKlines(interval, limit) {
  const r = await fetch(`${KLINE_BASE}/fapi/v1/klines?symbol=${SYMBOL}&interval=${interval}&limit=${limit}`,
                        { signal: AbortSignal.timeout(8000) });
  const rows = await r.json();
  if (!Array.isArray(rows)) throw new Error('klines non-array: ' + JSON.stringify(rows).slice(0, 120));
  return rows; // [openTime, open, high, low, close, volume, closeTime, ...]
}

async function seedCandles() {
  // 1m — moteur EMA / RSI / Bollinger
  const r1 = await fetchKlines('1m', 121);
  const done1 = r1.slice(0, -1); // derniere ligne = bougie en cours
  S.candles1m = done1.map(x => ({ t: x[0], h: parseFloat(x[2]), l: parseFloat(x[3]), c: parseFloat(x[4]) }));
  S.lastClosed1m = done1.length ? done1[done1.length - 1][0] : 0;
  S.price = parseFloat(r1[r1.length - 1][4]);
  jlog('sys', `✅ Warm-up 1m: ${S.candles1m.length} bougies reelles — EMA/RSI/Bollinger prets`);
  // 5m — ADX pret des la premiere minute
  const r5 = await fetchKlines('5m', 200);
  const done5 = r5.slice(0, -1);
  S.candles5m = done5.map(x => ({ h: parseFloat(x[2]), l: parseFloat(x[3]), c: parseFloat(x[4]) }));
  const last5 = r5[r5.length - 1];
  S.cur5 = { bucket: Math.floor(last5[0] / 300000), h: parseFloat(last5[2]), l: parseFloat(last5[3]), c: parseFloat(last5[4]) };
  updateRegime();
  jlog('sys', `✅ Warm-up 5m: ${S.candles5m.length} bougies — ADX(14) pret | regime initial: ${S.regime} (ADX ${S.adx.toFixed(1)})`);
}

// ═════════════ DECISION — uniquement sur cloture 1m (portage exact v5.1) ═════════════
// TELEMETRIE : verdict de CHAQUE cloture 1m (l'entonnoir de decision)
function recordDiag(k, sig, extra, verdict) {
  S.funnel[verdict] = (S.funnel[verdict] || 0) + 1;
  S.diag.push({ t: k.t, c: k.c, regime: S.regime, adx: +S.adx.toFixed(1),
                q: sig.q, dir: sig.dir, ...extra, verdict });
  if (S.diag.length > 240) S.diag.shift();
  if (!recordDiag._n) recordDiag._n = 0;
  if (++recordDiag._n % 15 === 0) {
    const top = Object.entries(S.funnel).sort((a, b) => b[1] - a[1]).slice(0, 4)
      .map(([v, n]) => `${v}:${n}`).join(' · ');
    jlog('info', `🔬 ENTONNOIR (${recordDiag._n} clotures) — ${top}`);
  }
}

function onCandleClose(k) {
  S.candles1m.push(k);
  if (S.candles1m.length > 240) S.candles1m.shift();
  aggregate5m(k);

  const closes = S.candles1m.map(x => x.c);
  const sig = calcSignal(closes);
  S.sigQ = sig.q; S.sigDir = sig.dir; S.ef = sig.ef || 0; S.es = sig.es || 0;

  const bb  = calcBB(closes, 20, 2);
  const rsi = calcRSI(closes.slice(-60), 14);
  const dx = { rsi: rsi == null ? null : +rsi.toFixed(1),
               bbLo: bb ? +((k.c - bb.lo) / bb.lo * 100).toFixed(3) : null,
               bbUp: bb ? +((k.c - bb.up) / bb.up * 100).toFixed(3) : null };

  if (!S.running || S.killed)        return recordDiag(k, sig, dx, S.killed ? 'KILL' : 'ARRETE');
  if (S.paused)                      return recordDiag(k, sig, dx, 'PAUSE');   // entrees bloquees, positions gerees
  if (S.trades.length >= P.MAX_OP)   return recordDiag(k, sig, dx, 'MAX_POSITIONS');

  const close = k.c;
  let wantDir = null, via = '', qEff = 0, mode = 'TREND', blocked = null;

  if (S.regime === 'WARMUP') blocked = 'ADX_WARMUP';
  else if (S.regime === 'UP' || S.regime === 'DOWN') {
    const trendDir = S.regime === 'UP' ? 'LONG' : 'SHORT';
    const sigDirWant = sig.dir === 'BULL' ? 'LONG' : sig.dir === 'BEAR' ? 'SHORT' : null;
    if (sigDirWant === trendDir && sig.q >= 50) {
      wantDir = trendDir; via = S.regime + '-cross'; qEff = sig.q;
    } else if (sig.ef && sig.es && closes.length >= 3) {
      const prev = closes[closes.length - 2];
      if (S.regime === 'UP' && sig.ef >= sig.es) {
        const pulled  = prev <= sig.es * 1.001;
        const resumed = close > prev && close > sig.ef * 0.999;
        if (pulled && resumed && sig.q >= 40) { wantDir = 'LONG'; via = 'UP-cont'; qEff = Math.max(50, sig.q); }
        else blocked = !pulled ? 'TREND_SANS_PULLBACK' : !resumed ? 'TREND_SANS_REPRISE' : 'TREND_Q<40';
      } else if (S.regime === 'DOWN' && sig.ef <= sig.es) {
        const pulled  = prev >= sig.es * 0.999;
        const resumed = close < prev && close < sig.ef * 1.001;
        if (pulled && resumed && sig.q >= 40) { wantDir = 'SHORT'; via = 'DOWN-cont'; qEff = Math.max(50, sig.q); }
        else blocked = !pulled ? 'TREND_SANS_PULLBACK' : !resumed ? 'TREND_SANS_REPRISE' : 'TREND_Q<40';
      } else blocked = 'TREND_EMA_CONTRE_REGIME';
      if (!wantDir && !blocked)
        blocked = sigDirWant === null ? 'TREND_DIR_NEUTRE' : sigDirWant !== trendDir ? 'TREND_DIR_OPPOSEE' : 'TREND_Q<50';
    } else blocked = sigDirWant === null ? 'TREND_DIR_NEUTRE' : sigDirWant !== trendDir ? 'TREND_DIR_OPPOSEE' : 'TREND_Q<50';
  } else if (S.regime === 'RANGE') {
    if (bb && rsi !== null) {
      // Decret « Q35 » : bornes RSI assouplies, le PLANCHER QMR>=35 devient le juge
      if (close <= bb.lo && rsi <= RSI_LO) {
        const qmr = calcQMR('LONG', close, bb, rsi);
        if (qmr >= QMR_MIN) { wantDir = 'LONG'; via = 'RANGE-MR'; mode = 'RANGE'; qEff = qmr; }
        else blocked = 'RANGE_QMR<' + QMR_MIN + '_(' + qmr + ')';
      } else if (close >= bb.up && rsi >= RSI_HI) {
        const qmr = calcQMR('SHORT', close, bb, rsi);
        if (qmr >= QMR_MIN) { wantDir = 'SHORT'; via = 'RANGE-MR'; mode = 'RANGE'; qEff = qmr; }
        else blocked = 'RANGE_QMR<' + QMR_MIN + '_(' + qmr + ')';
      }
      else if (close <= bb.lo || close >= bb.up) blocked = 'RANGE_BANDE_OK_RSI_TIEDE';
      else if (rsi <= RSI_LO || rsi >= RSI_HI)   blocked = 'RANGE_RSI_OK_DANS_BANDES';
      else                                       blocked = 'RANGE_CALME';
    } else blocked = 'RANGE_INDIC_PAS_PRETS';
  }
  // ── DECRET 11/07 : retournement confirme a la cloture 5m — gestion du flag ──
  if (S.revPend) {
    if (!S.trades.some(t => t.dir !== S.revPend.dir)) {
      S.revPend = null;                                        // plus aucune position opposee : flag caduc
    } else if (k.t + 60000 >= S.revPend.deadline) {            // la cloture 5m visee vient de tomber
      if (wantDir === S.revPend.dir && qEff >= 75) {
        let n = 0;
        for (const t of S.trades.filter(t => t.dir !== wantDir && t.pnl < 0)) { closePosition(t, S.price, `🔄 Retournement CONFIRME 5m Q:${qEff}`); n++; }
        jlog('sell', `🔄 Retournement ${wantDir} CONFIRME a la cloture 5m (flash Q:${S.revPend.q} → Q:${qEff}) — ${n} position(s) coupee(s)`);
        S.revPend = null;
        return recordDiag(k, sig, dx, 'RETOURNEMENT_CONFIRME');
      }
      jlog('info', `🛡 Retournement ${S.revPend.dir} ANNULE a la cloture 5m — fouet evite (flash Q:${S.revPend.q}, signal retombe)`);
      S.revPend = null;
    }
  }

  // 🖐 ENTREE FORCEE MANUELLE (bouton) — prioritaire sur la relance auto
  if (S.forceReq) {
    if (Date.now() - S.forceReq > 180000) {
      jlog('info', '🖐 Demande d entree forcee EXPIREE (3 min) — portes restees fermees'); S.forceReq = 0;
    } else if (wantDir) {
      jlog('info', '🖐 Demande forcee satisfaite par un signal naturel (' + via + ')'); S.forceReq = 0;
    } else if (S.regime !== 'WARMUP') {
      const dirM = S.pdi > S.ndi ? 'LONG' : S.ndi > S.pdi ? 'SHORT' : (close >= (sig.es || close) ? 'LONG' : 'SHORT');
      wantDir = dirM; via = 'FORCE-manuel'; mode = 'FORCE'; qEff = 0;
      jlog('buy', `🖐 ENTREE FORCEE (bouton) — ${dirM} (biais +DI ${S.pdi.toFixed(1)} / -DI ${S.ndi.toFixed(1)}) | $${FORCE_STAKE} | sorties v8: SL -30% mise · trail +60%→plancher +40% · garde 4h`);
    }
  }

  // ── DECRET MODE RELANCE : 30 min sans entree + a plat → entree forcee au micro-biais ──
  if (!wantDir && FORCE_MODE && S.regime !== 'WARMUP' && S.trades.length === 0
      && Date.now() - S.lastEntry >= FORCE_AFTER_MS) {
    const dirF = S.pdi > S.ndi ? 'LONG' : S.ndi > S.pdi ? 'SHORT' : (close >= (sig.es || close) ? 'LONG' : 'SHORT');
    jlog('buy', `⚡ MODE RELANCE — ${Math.round(FORCE_AFTER_MS/60000)} min sans entree → entree forcee ${dirF} (biais +DI ${S.pdi.toFixed(1)} / -DI ${S.ndi.toFixed(1)}) | $${FORCE_STAKE} | sorties v8: SL -30% mise · trail +60%→plancher +40% · garde 4h`);
    recordDiag(k, sig, dx, 'ENTREE_FORCE-30min');
    openPosition(dirF, close, FORCE_LEV, 0, 'FORCE-30min', 'FORCE');
    return;
  }
  if (!wantDir) return recordDiag(k, sig, dx, blocked || 'AUCUN_SETUP');

  // Decret MIN_GAP 1min30
  const gapLeft = MIN_GAP_MS - (Date.now() - S.lastEntry);
  if (gapLeft > 0) { jlog('info', `⏳ Signal ${via} ${wantDir} Q:${qEff} ignore — MIN_GAP 1min30 (reste ${Math.ceil(gapLeft/1000)}s)`); return recordDiag(k, sig, dx, 'MIN_GAP'); }

  // Jamais d'ouverture opposee — retournement Q>=75 : coupe APRES confirmation 5m (decret 11/07)
  const hasOpposite = S.trades.some(t => t.dir !== wantDir);
  if (hasOpposite) {
    if (qEff >= 75 && !S.revPend) {
      const dl = Math.floor((k.t + 60000) / 300000) * 300000 + 300000;
      S.revPend = { dir: wantDir, q: qEff, deadline: dl };
      jlog('info', `⏳ Retournement ${wantDir} Q:${qEff} detecte — coupe suspendue, confirmation exigee a la cloture 5m de ${new Date(dl).toISOString().slice(11, 16)} UTC (decret 11/07)`);
    }
    return recordDiag(k, sig, dx, 'POSITION_OPPOSEE');
  }

  // Decret v5.1 — anti-empilement : max 2 meme sens, espacees de 0.3%
  const sameDir = S.trades.filter(t => t.dir === wantDir);
  if (sameDir.length >= MAX_SAME_DIR) { jlog('info', `🚧 Signal ${via} ${wantDir} Q:${qEff} ignore — deja ${sameDir.length} position(s) ${wantDir} (plafond ${MAX_SAME_DIR})`); return recordDiag(k, sig, dx, 'PLAFOND_2'); }
  if (sameDir.length > 0) {
    const nearestPct = Math.min(...sameDir.map(t => Math.abs(close - t.entry) / t.entry));
    if (nearestPct < ENTRY_SPACING) { jlog('info', `🚧 Signal ${via} ${wantDir} Q:${qEff} ignore — trop proche de l'entree existante (${(nearestPct*100).toFixed(2)}% < 0.3%)`); return recordDiag(k, sig, dx, 'ESPACEMENT'); }
  }

  recordDiag(k, sig, dx, 'ENTREE_' + via);
  if (via === 'FORCE-manuel') S.forceReq = 0;   // demande consommee
  // Decret 11/07 : en RANGE-MR le levier est plafonne a 12x — la reversion a besoin
  // d'un stop large (2.5% prix) et paie le notionnel minimal en frais.
  openPosition(wantDir, close, mode === 'FORCE' ? FORCE_LEV : mode === 'RANGE' ? P.LEV_LOW : getLev(qEff), qEff, via, mode);
}

// ═════════════ EXECUTION ═════════════
async function ensureLeverage(lev) {
  if (S.levSet === lev) return;
  const r = await bnCall(E_BASE, '/fapi/v1/leverage', 'POST', { symbol: SYMBOL, leverage: lev }, E_KEY, E_SECRET);
  if (r && (r.leverage || r.maxNotionalValue)) { S.levSet = lev; }
  else jlog('sell', `⚠ Reglage levier ${lev}x refuse: ${JSON.stringify(r).slice(0, 120)}`);
}

async function openPosition(dir, price, lev, q, via, mode) {
  const mult = sizeMult();
  const stake = Math.round((mode === 'FORCE' ? FORCE_STAKE : getStake(q)) * mult * 100) / 100;   // mises dynamiques (decret 07/07)
  const qty = Math.floor((stake * lev / price) * Math.pow(10, QTY_DEC)) / Math.pow(10, QTY_DEC);
  if (qty <= 0) { jlog('sell', '⚠ Quantite nulle — entree annulee'); return; }
  // v8 SWING : distances prix = %mise / levier — memes regles pour TOUTES les voies
  const SL_PCT = SWING_SL_M / lev;                   // -30% de mise
  const TP_PCT = SWING_ARM_M / lev;                  // +60% de mise = armement du trailing
  const CB = cbRate(lev);                            // callback (%) ≈ 20 pts de mise sous le pic
  const sl = dir === 'LONG' ? price * (1 - SL_PCT) : price * (1 + SL_PCT);
  const tp = dir === 'LONG' ? price * (1 + TP_PCT) : price * (1 - TP_PCT);

  const t = {
    id: Date.now() + Math.random(), dir, entry: price, lev, qty, stake, q, via, mode,
    sl, tp, slPct: SL_PCT, tpPct: TP_PCT, cbPct: CB / 100, tpLocked: false, bestPricePct: 0,
    pnl: 0, openTime: Date.now(), bnIds: null
  };

  const exitTag = `SL:${sl.toFixed(PX_DEC)} (-30% mise) ARM:${tp.toFixed(PX_DEC)} (+60%) trail ${CB}% → plancher ~+40%`;

  if (ENGINE_MODE === 'paper') {
    S.trades.push(t); S.lastEntry = Date.now();
    jlog('buy', `📝 PAPER ${dir} x${lev} @ ${price.toFixed(PX_DEC)} | $${stake} | via=${via} | ${exitTag}`);
    sseState(); return;
  }

  // ── LIVE : MARKET (avec reprise -1007) puis SL + sortie native ──
  try {
    if (S.trades.length === 0) {      // v8.4 : position a plat → aucun conditionnel ne doit survivre
      await bnCall(E_BASE, '/fapi/v1/allOpenOrders', 'DELETE', { symbol: SYMBOL }, E_KEY, E_SECRET).catch(() => {});
      jlog('sys', '🧹 Purge des conditionnels residuels avant entree (position a plat)');
    }
    await ensureLeverage(lev);
    const side = dir === 'LONG' ? 'BUY' : 'SELL';
    const closeSide = dir === 'LONG' ? 'SELL' : 'BUY';
    const qtyStr = qty.toFixed(QTY_DEC);
    const cid = 'srv4' + Date.now();

    let order = await bnCall(E_BASE, '/fapi/v1/order', 'POST',
      { symbol: SYMBOL, side, type: 'MARKET', quantity: qtyStr, reduceOnly: 'false', newClientOrderId: cid }, E_KEY, E_SECRET);
    if (order && order.code === -1007) {                 // Binance = source de verite avant de re-tenter
      await sleep(2500);
      const found = await orderExists(E_BASE, SYMBOL, cid, E_KEY, E_SECRET);
      if (found) order = { ...found, recovered: true };
    }
    if (!order || !order.orderId) { jlog('sell', `⚠ Entree refusee: ${JSON.stringify(order).slice(0, 160)}`); return; }

    t.bnIds = { entry: order.orderId, sl: null, tp: null, slAlgo: false, tpAlgo: false };
    S.trades.push(t); S.lastEntry = Date.now();
    jlog('buy', `🔴 LIVE ${dir} x${lev} @ ~${price.toFixed(PX_DEC)} | $${stake} | via=${via} | #${order.orderId}${order.recovered ? ' (recovered)' : ''}`);

    // v8.2 : SL natif + sortie native poses EN PARALLELE (protection complete ~2x plus vite)
    const [slO, tpO] = await Promise.all([
      placeConditional(E_BASE, {
        symbol: SYMBOL, side: closeSide, type: 'STOP_MARKET',
        stopPrice: sl.toFixed(PX_DEC), quantity: qtyStr, reduceOnly: 'true'
      }, E_KEY, E_SECRET),
      placeConditional(E_BASE, { symbol: SYMBOL, side: closeSide, type: 'TRAILING_STOP_MARKET',
        activationPrice: tp.toFixed(PX_DEC), callbackRate: CB.toFixed(1),
        quantity: qtyStr, reduceOnly: 'true' }, E_KEY, E_SECRET)
    ]);
    if (slO && slO.orderId) { t.bnIds.sl = slO.orderId; t.bnIds.slAlgo = !!slO.algo; }
    if (tpO && tpO.orderId) { t.bnIds.tp = tpO.orderId; t.bnIds.tpAlgo = !!tpO.algo; }

    const exitLbl = `TRAILING natif (arm ${tp.toFixed(PX_DEC)}, cb ${CB}%)`;
    if (t.bnIds.sl && t.bnIds.tp) jlog('sys', `✅ SL ${sl.toFixed(PX_DEC)} + ${exitLbl} poses cote Binance`);
    else jlog('sell', `⚠ Protection PARTIELLE — SL:${t.bnIds.sl ? 'OK' : 'ECHEC'} SORTIE:${t.bnIds.tp ? 'OK' : 'ECHEC'}`);

    // REGLE D'OR : jamais de position LIVE sans SL → si le SL a echoue 1 fois, re-tente, sinon FERME
    if (!t.bnIds.sl) {
      const retry = await placeConditional(E_BASE, { symbol: SYMBOL, side: closeSide, type: 'STOP_MARKET',
        stopPrice: sl.toFixed(PX_DEC), quantity: qtyStr, reduceOnly: 'true' }, E_KEY, E_SECRET);
      if (retry && retry.orderId) { t.bnIds.sl = retry.orderId; t.bnIds.slAlgo = !!retry.algo; jlog('sys', '✅ SL pose au 2e essai'); }
      else { jlog('sell', '⛔ SL impossible a poser — FERMETURE IMMEDIATE (jamais de position nue)'); await closePosition(t, S.price, '⛔ SL impossible'); }
    }
    sseState();
  } catch (e) { jlog('sell', `⚠ openPosition: ${e.message}`); }
}

async function cancelTradeStops(t) {
  if (!t.bnIds) return;
  // v8.2 : annulations en parallele — la fermeture MARKET part plus tot
  await Promise.all([{ id: t.bnIds.sl, algo: t.bnIds.slAlgo }, { id: t.bnIds.tp, algo: t.bnIds.tpAlgo }]
    .filter(c => c.id)
    .map(c => bnCall(E_BASE, c.algo ? '/fapi/v1/algoOrder' : '/fapi/v1/order', 'DELETE',
      c.algo ? { algoId: c.id } : { symbol: SYMBOL, orderId: c.id }, E_KEY, E_SECRET).catch(() => {})));
}

// ── DECRET 13/07 : verrou break-even — a +BE_ARM_M de mise, le SL natif remonte a l'entree+frais.
// Le trade ne peut plus perdre ; le trailing (+60% → plancher +40%) reste seul juge du haut.
let beBusy = false;
async function manageBreakEven() {
  if (ENGINE_MODE !== 'live' || !S.running || !S.price || beBusy) return;
  beBusy = true;
  try {
    for (const t of S.trades) {
      if (t.beLocked || !t.bnIds) continue;
      const fav = t.dir === 'LONG' ? (S.price - t.entry) / t.entry : (t.entry - S.price) / t.entry;
      if (fav < BE_ARM_M / t.lev) continue;
      t.beLocked = true;
      const bePx = t.dir === 'LONG' ? t.entry * 1.001 : t.entry * 0.999;   // entree + ~frais
      const closeSide = t.dir === 'LONG' ? 'SELL' : 'BUY';
      const nu = await placeConditional(E_BASE, { symbol: SYMBOL, side: closeSide, type: 'STOP_MARKET',
        stopPrice: bePx.toFixed(PX_DEC), quantity: t.qty.toFixed(QTY_DEC), reduceOnly: 'true' }, E_KEY, E_SECRET);
      if (nu && nu.orderId) {
        const old = { id: t.bnIds.sl, algo: t.bnIds.slAlgo };
        t.bnIds.sl = nu.orderId; t.bnIds.slAlgo = !!nu.algo; t.sl = bePx;
        if (old.id) await bnCall(E_BASE, old.algo ? '/fapi/v1/algoOrder' : '/fapi/v1/order', 'DELETE',
          old.algo ? { algoId: old.id } : { symbol: SYMBOL, orderId: old.id }, E_KEY, E_SECRET).catch(() => {});
        jlog('buy', `🔒 Break-even verrouille ${t.dir} @ ${bePx.toFixed(PX_DEC)} (+${Math.round(BE_ARM_M * 100)}% de mise atteint) — ce trade ne peut plus perdre`);
      } else { t.beLocked = false; }
    }
  } catch (_) { /* re-tentera au prochain poll */ } finally { beBusy = false; }
}

// mirror=true → envoie la fermeture MARKET chez Binance ; false → deja fermee cote exchange
async function closePosition(t, price, reason, mirror = true) {
  const raw = t.dir === 'LONG' ? (price - t.entry) / t.entry * t.stake * t.lev
                               : (t.entry - price) / t.entry * t.stake * t.lev;
  const fee = t.stake * t.lev * P.FEE_SIDE * 2;
  t.pnl = raw - fee; t.exit = price; t.reason = reason; t.closeTime = Date.now();
  S.trades = S.trades.filter(x => x.id !== t.id);
  S.closed.push(t);
  if (ENGINE_MODE === 'paper') S.paperCap += t.pnl;
  jlog(t.pnl >= 0 ? 'buy' : 'sell', `${t.pnl >= 0 ? '✅' : '🔴'} ${t.dir} via=${t.via} | ${reason} | ${t.pnl >= 0 ? '+' : ''}$${t.pnl.toFixed(2)}`);

  if (ENGINE_MODE === 'live' && t.bnIds) {
    await cancelTradeStops(t);        // v8.4 : purge des stops freres MEME si Binance a deja ferme (anti-orphelin)
    if (mirror) {
      const closeSide = t.dir === 'LONG' ? 'SELL' : 'BUY';
      const r = await bnCall(E_BASE, '/fapi/v1/order', 'POST',
        { symbol: SYMBOL, side: closeSide, type: 'MARKET', quantity: t.qty.toFixed(QTY_DEC), reduceOnly: 'true' }, E_KEY, E_SECRET);
      if (r && r.orderId) jlog('sys', `Fermeture Binance #${r.orderId}`);
      else if (!(r && r.reconciled)) jlog('sell', `⚠ Fermeture: ${JSON.stringify(r).slice(0, 120)}`);
    }
  }
  sseState();
}

// ═════════════ SUIVI PAPER (exits locaux, memes regles que Binance natif) ═════════════
function paperManage() {
  if (ENGINE_MODE !== 'paper') return;
  const price = S.price;
  if (!price) return;
  for (const t of [...S.trades]) {
    const pct = t.dir === 'LONG' ? (price - t.entry) / t.entry : (t.entry - price) / t.entry;
    if (pct > t.bestPricePct) t.bestPricePct = pct;
    t.pnl = pct * t.stake * t.lev - t.stake * t.lev * P.FEE_SIDE * 2;
    if (Date.now() - t.openTime >= TIME_STOP_MS) { closePosition(t, price, '⏱ Garde-temps 4h', false); continue; }
    if (!t.tpLocked && pct >= t.tpPct) { t.tpLocked = true; jlog('info', `🟢 TRAIL ARME ${t.dir} (+60% mise atteints)`); }
    if (!t.tpLocked && pct <= -t.slPct) { closePosition(t, price, '🔴 SL -30% mise', false); continue; }
    if (t.tpLocked && pct <= t.bestPricePct - t.cbPct) {
      closePosition(t, price, `✅ Trailing (pic +${(t.bestPricePct*100).toFixed(2)}% px)`, false); continue;
    }
  }
}

// ═════════════ RECONCILIATION 9s — Binance = SOURCE DE VERITE (live) ═════════════
async function reconcile() {
  if (ENGINE_MODE !== 'live' || !S.running) return;
  try {
    const pr = await bnCall(E_BASE, '/fapi/v2/positionRisk', 'GET', { symbol: SYMBOL }, E_KEY, E_SECRET);
    const row = Array.isArray(pr) ? (pr.find(p => p.symbol === SYMBOL) || pr[0]) : null;
    const netAmt = row ? Math.abs(parseFloat(row.positionAmt || '0')) : 0;
    S.unreal = row ? (parseFloat(row.unRealizedProfit || '0') || 0) : 0;
    const localNet = S.trades.reduce((a, t) => a + t.qty, 0);

    // Un stop natif a tire cote Binance → fermer localement (sans miroir) + annuler le stop frere
    if (localNet - netAmt > 0.0005) {
      let toClose = localNet - netAmt;
      for (const t of [...S.trades].sort((a, b) => a.openTime - b.openTime)) {
        if (toClose <= 0.0005) break;
        jlog('sys', `⛔ Stop BINANCE declenche — ${t.dir} qty ${t.qty.toFixed(QTY_DEC)}`);
        await cancelTradeStops(t);
        await closePosition(t, S.price, '⛔ Stop Binance', false);
        toClose -= t.qty;
      }
    }
    // Position inconnue (redemarrage serveur) → ADOPTION + pose d'un SL
    else if (netAmt - localNet > 0.0005 && S.trades.length === 0) {
      const net = parseFloat(row.positionAmt);
      const dir = net > 0 ? 'LONG' : 'SHORT';
      const entry = parseFloat(row.entryPrice || S.price) || S.price;
      // GARDE ANTI-BOUCLE (bug des 164 fantomes) : jamais 2 adoptions de la meme position en < 120s
      const sig = dir + ':' + entry.toFixed(1);
      if (sig === S.lastAdoptSig && Date.now() - S.lastAdoptAt < 120000) {
        jlog('info', '🤝 Re-adoption ' + sig + ' bloquee (garde 120s) — position laissee aux stops natifs Binance');
        return;
      }
      S.lastAdoptSig = sig; S.lastAdoptAt = Date.now();
      // PURGE des ordres orphelins des sessions passees AVANT d'en poser un neuf (la source de la boucle)
      await bnCall(E_BASE, '/fapi/v1/allOpenOrders', 'DELETE', { symbol: SYMBOL }, E_KEY, E_SECRET);
      jlog('sys', '🧹 Ordres orphelins purges avant adoption (allOpenOrders)');
      const aLev = Math.max(1, parseInt(row.leverage || '12'));
      const t = { id: Date.now(), dir, entry, lev: aLev, qty: Math.abs(net),
                  stake: P.STAKE, q: 50, via: 'ADOPTE', mode: 'TREND',
                  sl: dir === 'LONG' ? entry * (1 - SWING_SL_M / aLev) : entry * (1 + SWING_SL_M / aLev),
                  tp: dir === 'LONG' ? entry * (1 + SWING_ARM_M / aLev) : entry * (1 - SWING_ARM_M / aLev),
                  slPct: SWING_SL_M / aLev, tpPct: SWING_ARM_M / aLev, cbPct: cbRate(aLev) / 100,
                  tpLocked: false, bestPricePct: 0, pnl: 0, openTime: Date.now(), bnIds: { entry: 0, sl: null, tp: null } };
      const closeSide = dir === 'LONG' ? 'SELL' : 'BUY';
      const slO = await placeConditional(E_BASE, { symbol: SYMBOL, side: closeSide, type: 'STOP_MARKET',
        stopPrice: t.sl.toFixed(PX_DEC), quantity: t.qty.toFixed(QTY_DEC), reduceOnly: 'true' }, E_KEY, E_SECRET);
      if (slO && slO.orderId) { t.bnIds.sl = slO.orderId; t.bnIds.slAlgo = !!slO.algo; }
      S.trades.push(t);
      jlog('sys', `🤝 Position ADOPTEE (${dir} ${t.qty}) apres redemarrage — SL ${slO && slO.orderId ? 'pose' : 'ECHEC'}`);
    }

    // KILL SWITCH sur le REEL : (wallet + latent) - depart <= -20% du capital ref
    const bal = await bnCall(E_BASE, '/fapi/v2/balance', 'GET', {}, E_KEY, E_SECRET);
    if (Array.isArray(bal)) {
      const usdt = bal.find(b => b.asset === 'USDT');
      S.walletNow = usdt ? parseFloat(usdt.balance) : 0;
      S.avail = usdt ? parseFloat(usdt.availableBalance || usdt.balance) : 0;
      if (S.walletStart > 0 && S.walletNow > 0) {
        S.sessionPnl = (S.walletNow + S.unreal) - S.walletStart;
        if (S.sessionPnl > S.pnlHigh) S.pnlHigh = S.sessionPnl;   // plus-haut de session (high-water mark)
        const killFloor = S.pnlHigh - (P.CAP * P.KILL);            // DECRET 07/07 : kill SUIVEUR = HWM - 400$
        if (KILL_MODE === 'on' && !S.killed && S.sessionPnl <= killFloor) {   // decret v8 : OFF par defaut
          S.killed = true;
          jlog('sell', `⛔ KILL SUIVEUR — P&L session ${S.sessionPnl.toFixed(2)}$ <= plancher ${killFloor.toFixed(2)}$ (plus-haut ${S.pnlHigh.toFixed(2)}$ - ${(P.CAP*P.KILL).toFixed(0)}$) — FERMETURE TOTALE + ARRET`);
          for (const t of [...S.trades]) await closePosition(t, S.price, '⛔ KILL REEL', true);
          await bnCall(E_BASE, '/fapi/v1/allOpenOrders', 'DELETE', { symbol: SYMBOL }, E_KEY, E_SECRET); // nettoyage best-effort
          S.running = false;
        }
      }
    }
  } catch (e) { jlog('sys', `⚠ Reconciliation: ${e.message}`); }
  sseState();
}

// NET REEL comptable (income) toutes les 30s
async function refreshNetReel() {
  if (ENGINE_MODE !== 'live' || !S.startedAt) return;
  try {
    const rows = await bnCall(E_BASE, '/fapi/v1/income', 'GET', { symbol: SYMBOL, startTime: S.startedAt, limit: 1000 }, E_KEY, E_SECRET);
    if (!Array.isArray(rows)) return;
    let pnl = 0, com = 0, fund = 0;
    for (const r of rows) {
      const v = parseFloat(r.income || '0'); if (!isFinite(v)) continue;
      if (r.incomeType === 'REALIZED_PNL') pnl += v;
      else if (r.incomeType === 'COMMISSION') com += v;
      else if (r.incomeType === 'FUNDING_FEE') fund += v;
    }
    S.netReel = { net: pnl + com + fund, brut: pnl, frais: com, funding: fund };
  } catch (_) {}
}

// ═════════════ BOUCLE PRIX — REST klines toutes les 4s (decisions sur clotures 1m) ═════════════
// Un sondage REST leger (poids 2, ~15 req/min sur endpoint public) suffit : la
// strategie ne decide QUE sur bougies 1m cloturees. Aucune dependance WebSocket,
// aucun throttling navigateur, survit nativement aux micro-coupures.
let pollBusy = false;
async function pollLoop() {
  if (pollBusy || !S.running) return;
  pollBusy = true;
  try {
    const rows = await fetchKlines('1m', 3);
    S.price = parseFloat(rows[rows.length - 1][4]);         // prix live = close de la bougie en cours
    for (let i = 0; i < rows.length - 1; i++) {             // toutes sauf la derniere = CLOTUREES
      const x = rows[i];
      if (x[0] > S.lastClosed1m) {
        S.lastClosed1m = x[0];
        onCandleClose({ t: x[0], h: parseFloat(x[2]), l: parseFloat(x[3]), c: parseFloat(x[4]) });
      }
    }
    paperManage();
    manageBreakEven().catch(() => {});   // v8.5 : verrou BE evalue a chaque poll (~1-4s)
    // Suivi PnL live affichage (les sorties LIVE sont executees par Binance)
    if (ENGINE_MODE === 'live') {
      for (const t of [...S.trades]) {
        const pct = t.dir === 'LONG' ? (S.price - t.entry) / t.entry : (t.entry - S.price) / t.entry;
        if (pct > t.bestPricePct) t.bestPricePct = pct;
        if (!t.tpLocked && pct >= t.tpPct) { t.tpLocked = true; jlog('info', `🟢 TRAIL ARME ${t.dir} (+60% mise — suivi par BINANCE natif)`); }
        t.pnl = pct * t.stake * t.lev - t.stake * t.lev * P.FEE_SIDE * 2;
        if (Date.now() - t.openTime >= TIME_STOP_MS) {
          await closePosition(t, S.price, '⏱ Garde-temps 4h', true);
        }
      }
    }
    S.ticks++;
    const now = Date.now();
    if (!pollLoop._t24 || now - pollLoop._t24 > 60000) {
      pollLoop._t24 = now;
      fetch(`${KLINE_BASE}/fapi/v1/ticker/24hr?symbol=${SYMBOL}`, { signal: AbortSignal.timeout(5000) })
        .then(r => r.json()).then(j => { const v = parseFloat(j.priceChangePercent); if (isFinite(v)) S.chg24 = v; })
        .catch(() => {});
    }
    if (now - S.lastHb >= 60000) {
      S.lastHb = now;
      jlog('sys', `💓 ${S.ticks} polls/min · ${SYMBOL} ${S.price.toFixed(PX_DEC)} · regime ${S.regime}${S.adx ? ' ADX ' + S.adx.toFixed(0) : ''} · ${S.trades.length} pos · ${ENGINE_MODE.toUpperCase()}`);
      S.ticks = 0;
    }
    sseState();
  } catch (e) { jlog('sys', `⚠ poll: ${e.message}`); }
  pollBusy = false;
}

// ── v8.2 TURBO : ordonnanceur aligne sur l'horloge des clotures 1m ──
// Croisiere 4s (affichage prix) ; a l'approche d'une cloture 1m, le poll est
// programme a cloture+400ms ; si Binance publie en retard, re-poll a 700ms
// (plafonne : retour a 4s au-dela de 10s de retard). Memes bougies, memes
// decisions — seulement detectees ~1.5s plus tot en moyenne.
function schedulePoll() {
  const now = Date.now();
  let delay = 4000;
  if (S.lastClosed1m) {
    const nextClose = S.lastClosed1m + 120000;          // fin de la bougie 1m suivante
    if (now >= nextClose + 400) delay = (now - nextClose > 10000) ? 4000 : 700;
    else delay = Math.max(400, Math.min(4000, nextClose + 400 - now));
  }
  setTimeout(async () => { try { await pollLoop(); } catch (_) {} schedulePoll(); }, delay);
}

// ═════════════ SSE — le dashboard est un SPECTATEUR pur ═════════════
const sseClients = new Set();
setInterval(() => { for (const r of sseClients) { try { r.write(': ping\n\n'); } catch (_) {} } }, 15000);
function sseBroadcast(obj) {
  const line = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of sseClients) { try { res.write(line); } catch (_) {} }
}
let lastStatePush = 0;
function sseState(force) {
  const now = Date.now();
  if (!force && now - lastStatePush < 1500) return;   // 1 push max / 1.5s
  lastStatePush = now;
  const m9 = sizeMult();
  if (m9 !== S.lastMult) {
    jlog('info', `📶 Palier de mise: ×${m9.toFixed(2)} (P&L session ${sessionPnlNow() >= 0 ? '+' : ''}${sessionPnlNow().toFixed(0)}$) — mises ${Math.round(P.STAKE*m9)}/${Math.round(P.STAKE_MID*m9)}/${Math.round(P.STAKE_MAX*m9)}$, forcee ${Math.round(FORCE_STAKE*m9)}$`);
    S.lastMult = m9;
  }
  const realClosed = S.closed.filter(t => t.via !== 'ADOPTE');   // ADOPTE = compta fantome, exclue des stats
  const pnlOpen = S.trades.reduce((a, t) => a + (t.pnl || 0), 0);
  const pnlClosed = realClosed.reduce((a, t) => a + t.pnl, 0);
  const pnlTot = pnlClosed + pnlOpen;
  if (pnlTot < S.pnlLow) S.pnlLow = pnlTot;
  if (!force && sseClients.size === 0) return;   // v8.2 : personne ne regarde → etat suivi, payload epargne
  const wins = realClosed.filter(t => t.pnl > 0).length;
  const viaStats = {};
  for (const t of S.closed) {
    if (!viaStats[t.via]) viaStats[t.via] = { n: 0, w: 0, pnl: 0 };
    viaStats[t.via].n++; if (t.pnl > 0) viaStats[t.via].w++; viaStats[t.via].pnl += t.pnl;
  }
  const s9 = {
    mode: ENGINE_MODE, net: ENGINE_NET, symbol: SYMBOL, running: S.running, killed: S.killed,
    armed: !!(E_KEY && E_SECRET), paused: S.paused,
    price: S.price, chg24: S.chg24, regime: S.regime, adx: S.adx, pdi: S.pdi, ndi: S.ndi,
    sigQ: S.sigQ, sigDir: S.sigDir,
    relance: { inMs: Math.max(0, (S.lastEntry + FORCE_AFTER_MS) - Date.now()),
               flat: S.trades.length === 0, pending: !!S.forceReq, on: FORCE_MODE },
    closes: S.candles1m.slice(-170).map(c => c.c),
    pnlOpen, pnlClosed, ddPct: S.pnlLow < 0 ? (-S.pnlLow / P.CAP * 100) : 0,
    Pp: { cap: P.CAP, stake: P.STAKE, fs: FORCE_STAKE, slM: SWING_SL_M, armM: SWING_ARM_M, cbM: SWING_CB_M,
          tsH: TIME_STOP_MS / 3600000, kill: P.CAP * P.KILL, killMode: KILL_MODE },
    cap: P.CAP, paperCap: S.paperCap, wallet: S.walletNow, sessionPnl: S.sessionPnl, unreal: S.unreal,
    avail: S.avail, inTrades: S.trades.reduce((a, t) => a + (t.stake || 0), 0),
    mult: m9, killFloor: S.pnlHigh - P.CAP * P.KILL,
    netReel: S.netReel,
    open: S.trades.map(t => ({ id: t.id, dir: t.dir, via: t.via, mode: t.mode, lev: t.lev, entry: t.entry, qty: t.qty,
      stake: t.stake, pnl: t.pnl, tpLocked: t.tpLocked, sl: t.sl, tp: t.tp,
      slOk: !!(t.bnIds && t.bnIds.sl) || ENGINE_MODE === 'paper', tpOk: !!(t.bnIds && t.bnIds.tp) || ENGINE_MODE === 'paper' })),
    closedN: realClosed.length, wins, wr: realClosed.length ? Math.round(100 * wins / realClosed.length) : null,
    viaStats,
    lastClosed: realClosed.slice(-100).reverse().map(t => ({ dir: t.dir, via: t.via, lev: t.lev, entry: t.entry,
      exit: t.exit, stake: t.stake, pnl: t.pnl, reason: t.reason, dur: (t.closeTime || 0) - (t.openTime || 0) })),
    lastDiag: S.diag.length ? S.diag[S.diag.length - 1] : null,
    funnelTop: Object.entries(S.funnel).sort((a, b) => b[1] - a[1]).slice(0, 3)
  };
  sseBroadcast({ kind: 'state', s: s9 });
  return s9;
}

app.get('/api/stream', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*', 'X-Accel-Buffering': 'no' });
  res.write(`data: ${JSON.stringify({ kind: 'hello', journal: S.journal.slice(-60) })}\n\n`);
  sseClients.add(res);
  sseState(true);
  req.on('close', () => sseClients.delete(res));
});

// DIAGNOSTIC : pourquoi le bot n'entre pas — entonnoir complet + 30 derniers verdicts
app.get('/api/why', (req, res) => {
  res.status(200).json({
    ok: true, mode: ENGINE_MODE, running: S.running, regime: S.regime, adx: +S.adx.toFixed(1),
    clotures_analysees: Object.values(S.funnel).reduce((a, b) => a + b, 0),
    entonnoir: Object.fromEntries(Object.entries(S.funnel).sort((a, b) => b[1] - a[1])),
    lexique: {
      RANGE_CALME: 'prix DANS les bandes de Bollinger, RSI moyen — aucun exces a inverser',
      RANGE_BANDE_OK_RSI_TIEDE: 'cloture HORS bande 2σ mais RSI hors bornes 38/62 (voir champ rsi)',
      'RANGE_QMR<35_(x)': 'setup present mais qualite x sous le plancher decrete Q35',
      RANGE_RSI_OK_DANS_BANDES: 'RSI extreme mais prix revenu DANS les bandes a la cloture',
      TREND_DIR_NEUTRE: 'momentum et EMA en desaccord — pas de direction franche',
      TREND_DIR_OPPOSEE: 'signal CONTRE le regime (ex: rebond haussier en regime DOWN) — refuse par design',
      'TREND_Q<50': 'direction alignee au regime mais qualite insuffisante',
      TREND_SANS_PULLBACK: 'tendance en extension — pas de retour sur EMA21 a jouer',
      TREND_SANS_REPRISE: 'pullback present mais la reprise dans le sens du regime manque encore',
      'ENTREE_FORCE-30min': 'MODE RELANCE (decret) : 30 min sans entree, a plat → entree forcee au biais DI, sorties v8 unifiees'
    },
    derniers_verdicts: S.diag.slice(-30).reverse()
  });
});

// ── ARMEMENT DEPUIS LA PAGE (decret : cles sur le bot, jamais en variables) ──
// Les cles arrivent en HTTPS, vivent en RAM du processus, ne sont NI loggees NI ecrites.
app.post('/api/engine/start', async (req, res) => {
  try {
    const { key, secret } = req.body || {};
    if (!key || !secret || String(key).length < 10 || String(secret).length < 10)
      return res.status(400).json({ ok: false, error: 'cles manquantes ou invalides' });
    if (S.running) return res.status(409).json({ ok: false, error: 'moteur deja en marche — arrete-le d abord' });
    // v8.4.1 : nettoyage agressif (espaces internes, retours ligne, caracteres invisibles) + diagnostic anti -2014
    const cleanKey = v => String(v).replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, '');
    E_KEY = cleanKey(key); E_SECRET = cleanKey(secret);
    const bad = [];
    if (!/^[A-Za-z0-9]{64}$/.test(E_KEY))    bad.push(`cle API: ${E_KEY.length} caracteres${/[^A-Za-z0-9]/.test(E_KEY) ? ', dont un caractere INVALIDE (masquage * ou \u2026 colle ?)' : ''} — attendu 64 alphanumeriques`);
    if (!/^[A-Za-z0-9]{64}$/.test(E_SECRET)) bad.push(`secret: ${E_SECRET.length} caracteres${/[^A-Za-z0-9]/.test(E_SECRET) ? ', dont un caractere INVALIDE' : ''} — attendu 64`);
    if (bad.length) jlog('sell', `⚠ Format des cles suspect: ${bad.join(' | ')}. Utilise le bouton COPIER de Binance (icone), jamais la selection du texte masque.`);
    ENGINE_MODE = 'live';
    jlog('sys', '🔐 Cles recues depuis la page — RAM uniquement, jamais ecrites. Armement LIVE...');
    await startEngine();
    res.status(200).json({ ok: S.running, running: S.running, mode: ENGINE_MODE,
      hint: S.running ? 'MOTEUR LIVE — tu peux fermer la page' : 'echec armement',
      detail: S.running ? undefined : S.journal.slice(-2).map(e => e.msg) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
// Arret protege : exige les premiers caracteres de la cle armee (personne d'autre ne peut arreter ton bot)
app.post('/api/engine/stop', (req, res) => {   // decret 07/07 : commande sans verification
  S.running = false; S.paused = false;
  E_KEY = ''; E_SECRET = '';   // ARRET total : cles effacees de la RAM — re-armer pour reprendre
  jlog('sys', '⏹ ARRET TOTAL — cles effacees de la RAM. Les SL/TP natifs des positions restent VIVANTS chez Binance.');
  sseState(true);
  res.status(200).json({ ok: true, running: false });
});

// ⏸/▶ PAUSE des entrees (les positions ouvertes restent gerees, flux et exits actifs)
app.post('/api/engine/pause', (req, res) => {
  const { pause } = req.body || {};   // decret 07/07 : commande sans verification
  if (!S.running) return res.status(409).json({ ok: false, error: 'moteur non arme' });
  S.paused = !!pause;
  jlog('sys', S.paused ? '⏸ PAUSE — nouvelles entrees bloquees (positions ouvertes toujours gerees)'
                       : '▶ REPRISE — nouvelles entrees reautorisees');
  sseState(true);
  res.status(200).json({ ok: true, paused: S.paused });
});

// ✋ Fermeture manuelle d'une position (protegee : prefixe de la cle armee)
app.post('/api/engine/close', async (req, res) => {
  try {
    const { id } = req.body || {};   // decret 07/07 : commande sans verification
    const t = S.trades.find(x => String(x.id) === String(id));
    if (!t) return res.status(404).json({ ok: false, error: 'position introuvable (deja fermee ?)' });
    jlog('sys', `✋ FERMETURE MANUELLE demandee — ${t.dir} ${t.qty} @ marche (stops natifs annules d'abord)`);
    await closePosition(t, S.price, '✋ Fermeture manuelle', true);
    res.status(200).json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/snapshot', (req, res) => {
  res.status(200).json({ ok: true, s: sseState(true) || null, journal: S.journal.slice(-80) });
});

// 🖐 Entree forcee a la demande (protegee : prefixe de la cle armee requis)
app.post('/api/engine/force', (req, res) => {   // decret 07/07 : commande sans verification
  if (!S.running) return res.status(409).json({ ok: false, error: 'moteur non arme' });
  if (S.forceReq) return res.status(200).json({ ok: true, note: 'demande deja en attente' });
  S.forceReq = Date.now();
  jlog('sys', '🖐 ENTREE FORCEE demandee depuis la page — execution a la prochaine cloture 1m (analyse biais DI), fenetre 1min30');
  sseState(true);
  res.status(200).json({ ok: true });
});

app.get('/api/state', (req, res) => { sseState(true); res.status(200).json({ ok: true, mode: ENGINE_MODE, running: S.running, regime: S.regime, adx: S.adx, price: S.price, open: S.trades.length, closed: S.closed.length }); });

// ═════════════ DASHBOARD INTEGRE (spectateur pur — AUCUNE cle, AUCUNE logique) ═════════════
const DASH_HTML = `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Itachi v8.5 BELOCK — Srv 4.0 · WR: à mesurer — CryptoSignal AI</title>
<style>
:root{--bg:#05070d;--panel:#0a0e17;--surface:#0e1420;--border:#1a2333;--text:#e6edf3;--muted:#7d8ba1;--muted2:#4a5568;--teal:#37e0b0;--blue:#7b87ff;--gold:#d9a441;--red:#ff3b5c;--yellow:#ffc94d}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:'JetBrains Mono',ui-monospace,Consolas,monospace;font-size:13px}
.topbar{display:flex;align-items:center;gap:14px;padding:12px 18px;border-bottom:1px solid var(--border);flex-wrap:wrap}
.logo{font-weight:700;font-size:17px;display:flex;align-items:center;gap:8px}
.logo b{color:var(--teal)}
.pulse{width:8px;height:8px;border-radius:50%;background:var(--teal);box-shadow:0 0 10px var(--teal);animation:pu 2s infinite}
@keyframes pu{50%{opacity:.35}}
.sub{color:var(--muted);font-weight:400;font-size:11px}
.tright{margin-left:auto;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.badge{padding:3px 12px;border-radius:20px;font-size:10px;font-weight:700;letter-spacing:1.5px;border:1px solid var(--border)}
.src{color:var(--muted);font-size:11px}.src i{color:var(--teal);font-style:normal}
#clock{color:var(--muted);font-size:12px}
.app{display:grid;grid-template-columns:330px 1fr;min-height:calc(100vh - 54px)}
.side{border-right:1px solid var(--border);padding:16px;background:var(--panel);overflow-y:auto}
.main{padding:0;display:flex;flex-direction:column;min-width:0}
h4{font-size:10px;color:var(--muted);letter-spacing:2.5px;margin:18px 0 8px}
h4:first-child{margin-top:0}
.row{display:flex;justify-content:space-between;padding:4px 0;font-size:12px}
.row .l{color:var(--muted)}
.hr{border-top:1px solid var(--border);margin:10px 0}
.warn{background:rgba(255,59,92,.08);border:1px solid rgba(255,59,92,.35);border-radius:8px;padding:8px 10px;font-size:11px;color:var(--red);margin:8px 0}
input{width:100%;background:#070b12;border:1px solid var(--border);border-radius:8px;color:var(--text);padding:9px 10px;font-family:inherit;font-size:12px;margin:5px 0}
input::placeholder{color:var(--muted2)}
.btn{width:100%;border:0;border-radius:8px;padding:11px;font-weight:700;font-family:inherit;font-size:13px;cursor:pointer;margin-top:8px;letter-spacing:.5px}
.btn.go{background:var(--teal);color:#03211a}
.btn.stop{background:transparent;color:var(--red);border:1px solid var(--red)}
#kMsg{font-size:11px;color:var(--muted);margin-top:8px;line-height:1.5}
.netbox{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:10px 12px;margin-top:10px;font-size:12px;line-height:1.9}
.chartwrap{position:relative;height:400px;border-bottom:1px solid var(--border);background:radial-gradient(ellipse at 50% 0%,rgba(55,224,176,.05),transparent 65%)}
canvas{width:100%;height:100%;display:block}
.phead{display:flex;align-items:baseline;gap:12px;padding:14px 18px 4px}
.pair{color:var(--muted);font-size:12px;letter-spacing:1px}
#bigpx{font-size:32px;font-weight:700;color:var(--teal)}
#bigpct{font-weight:700;font-size:14px}
.sigrow{display:flex;align-items:center;gap:14px;padding:12px 18px;border-bottom:1px solid var(--border);flex-wrap:wrap}
.siglbl{color:var(--muted);letter-spacing:2px;font-size:11px}
.gauge{width:200px;height:6px;background:var(--surface);border-radius:4px;overflow:hidden}
#gfill{height:100%;width:0%;border-radius:4px;transition:width .5s,background .5s}
#qval{font-weight:700;font-size:16px;min-width:34px}
.pill{padding:5px 16px;border-radius:8px;font-weight:700;font-size:12px;letter-spacing:1px;border:1px solid var(--border)}
#regTxt{font-weight:700;font-size:12px;letter-spacing:.5px}
#levNext{color:var(--muted);font-size:12px}
#levNext b{font-size:13px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(105px,1fr));border-bottom:1px solid var(--border)}
.st{padding:12px 10px;border-right:1px solid var(--border)}
.st .l{font-size:9px;color:var(--muted);letter-spacing:1.5px;margin-bottom:5px;display:flex;gap:4px;align-items:center}
.st .v{font-size:17px;font-weight:700}
section{padding:14px 18px}
.sechead{font-size:11px;color:var(--muted);letter-spacing:2.5px;margin-bottom:8px;display:flex;justify-content:space-between}
table{width:100%;border-collapse:collapse;font-size:11px}
th{color:var(--muted);font-size:9px;letter-spacing:1.2px;text-align:left;padding:7px 8px;border-bottom:1px solid var(--border);font-weight:600}
td{padding:7px 8px;border-bottom:1px solid rgba(26,35,51,.6)}
.mut{color:var(--muted)}.teal{color:var(--teal)}.red{color:var(--red)}.yel{color:var(--yellow)}.blue{color:var(--blue)}.gold{color:var(--gold)}
#journal{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:10px 12px;height:230px;overflow-y:auto;font-size:11.5px;line-height:1.9}
#journal div{white-space:pre-wrap}
.xbtn{background:transparent;color:var(--red);border:1px solid var(--red);border-radius:6px;padding:2px 9px;font-family:inherit;font-size:11px;font-weight:700;cursor:pointer}
.xbtn:hover{background:rgba(255,59,92,.12)}
.jl-sys{color:#8ea8ff}.jl-buy{color:var(--teal)}.jl-sell{color:var(--red)}.jl-info{color:var(--yellow)}
.ts{color:var(--muted2);margin-right:8px}
@media(max-width:900px){.app{grid-template-columns:1fr}.side{border-right:0;border-bottom:1px solid var(--border)}}
</style></head><body>
<div class="topbar">
  <span class="logo"><span class="pulse"></span>CryptoSignal<b>AI</b> <span class="sub">/ Itachi v8.5 BELOCK · Srv 4.0 · WR: à mesurer</span></span>
  <span class="tright">
    <span class="src"><i>●</i> Prix Binance live</span>
    <span class="badge" id="bMode">—</span>
    <span class="badge" id="bRun">—</span>
    <span id="clock"></span>
  </span>
</div>
<div class="app">
<div class="side">
  <h4>PARAMÈTRES BOT</h4>
  <div class="row"><span class="l">Capital référence</span><b class="teal" id="pCap">—</b></div>
  <div class="row"><span class="l">Mise (toutes voies)</span><b id="pS1">—</b></div>
  <div class="row"><span class="l">⚡ Relance 30min</span><b id="pFS">—</b></div>
  <div class="row"><span class="l">Max positions</span><b>2 (esp. 0.3%)</b></div>
  <div class="hr"></div>
  <div class="row"><span class="l">Levier Q &lt; 45</span><b class="teal">12×</b></div>
  <div class="row"><span class="l">Levier Q 45-69</span><b class="yel">17×</b></div>
  <div class="row"><span class="l">Levier Q ≥ 70</span><b class="red">23×</b></div>
  <div class="hr"></div>
  <div class="row"><span class="l">Stop-Loss</span><b class="red" id="pSL">−30% mise (Binance)</b></div>
  <div class="row"><span class="l">Trailing armé à</span><b class="teal" id="pTP">+60% mise (Binance)</b></div>
  <div class="row"><span class="l">Plancher après armement</span><b class="teal" id="pTR">~+40% mise</b></div>
  <div class="row"><span class="l">⏱ Garde-temps</span><b class="yel" id="pTPR">4h</b></div>
  <div class="row"><span class="l">Kill switch (suiveur)</span><b class="red" id="pKill">—</b></div>
  <div class="row"><span class="l">📶 Palier de mise</span><b class="teal" id="pMult">×1.00</b></div>
  <h4>🔗 BINANCE — CONNEXION</h4>
  <div class="warn">⚠ ARGENT RÉEL · Ton compte Binance<br>fapi.binance.com — clés en RAM, jamais stockées</div>
  <div class="l" style="font-size:10px;color:var(--muted);letter-spacing:1px;margin-top:6px">API KEY</div>
  <input id="kKey" type="password" placeholder="Colle ta clé API" autocomplete="off">
  <div class="l" style="font-size:10px;color:var(--muted);letter-spacing:1px">API SECRET</div>
  <input id="kSec" type="password" placeholder="Colle ton secret API" autocomplete="off">
  <button class="btn go" id="bStart">🔐 Connecter + ▶ ARMER LIVE</button>
  <button class="btn stop" id="bStop">⏹ ARRÊT total — efface les clés</button>
  <button class="btn" id="bForce" style="background:transparent;color:var(--yellow);border:1px solid var(--yellow)">🖐 Forcer l'entrée — exécute ≤ 1min30</button>
  <div id="kMsg">Moteur non armé — colle tes clés puis ▶ (à refaire après chaque redéploiement Railway)</div>
  <div class="netbox">💰 <b>NET RÉEL Binance (session)</b><br>
    Net: <b id="nNet" class="teal">—</b> · brut <span id="nBrut">—</span><br>
    frais <span id="nFrais">—</span> · funding <span id="nFund">—</span></div>
</div>
<div class="main">
  <div class="phead"><span class="pair">BTC/USDT · Binance réel</span><span id="bigpx">$—</span><span id="bigpct" class="teal">—</span></div>
  <div class="chartwrap"><canvas id="chart"></canvas></div>
  <div class="sigrow">
    <span class="siglbl">FORCE SIGNAL</span>
    <span class="gauge"><span id="gfill" style="display:block"></span></span>
    <span id="qval">—</span>
    <span class="pill" id="dirPill">— NEUTRE</span>
    <span id="regTxt">—</span>
    <span id="levNext">Levier prochain : <b>—</b></span>
  </div>
  <div class="stats">
    <div class="st"><div class="l">CAPITAL</div><div class="v teal" id="sCap">—</div></div>
    <div class="st"><div class="l">P&L TOTAL</div><div class="v" id="sTot">—</div></div>
    <div class="st"><div class="l">P&L OPEN</div><div class="v" id="sOpen">—</div></div>
    <div class="st"><div class="l">💵 DISPO</div><div class="v teal" id="sAvail">—</div></div>
    <div class="st"><div class="l">📦 EN TRADES</div><div class="v yel" id="sInT">—</div></div>
    <div class="st"><div class="l">📂 OUVERTS</div><div class="v yel" id="sN">0</div></div>
    <div class="st"><div class="l">📁 FERMÉS</div><div class="v" id="sF">0</div></div>
    <div class="st"><div class="l">✅ GAGNÉS</div><div class="v teal" id="sW">0</div></div>
    <div class="st"><div class="l">🔴 PERDUS</div><div class="v red" id="sL">0</div></div>
    <div class="st"><div class="l">WIN RATE</div><div class="v teal" id="sWR">—</div></div>
    <div class="st"><div class="l">DRAWDOWN MAX</div><div class="v red" id="sDD">0.00%</div></div>
    <div class="st"><div class="l">⏱ RELANCE DANS</div><div class="v yel" id="sRel">—</div></div>
    <div class="st"><div class="l">PRIX RÉEL</div><div class="v teal" id="sPx">—</div></div>
  </div>
  <section>
    <div class="sechead"><span>POSITIONS</span><span id="posN" class="mut">0 actives</span></div>
    <table><thead><tr><th>SENS</th><th>VIA</th><th>MODE</th><th>LEV</th><th>MISE</th><th>ENTRÉE</th><th>QTY</th><th>SL 🔒 perte max</th><th>TP ✓ · 🔒 gain min</th><th>P&L</th><th></th></tr></thead>
    <tbody id="tOpen"><tr><td colspan="11" class="mut">Aucune position</td></tr></tbody></table>
  </section>
  <section>
    <div class="sechead"><span>WIN RATE PAR VOIE (via=)</span></div>
    <table><thead><tr><th>VOIE</th><th>TRADES</th><th>WR</th><th>P&L NET</th></tr></thead>
    <tbody id="tVia"><tr><td colspan="4" class="mut">En attente des premiers trades</td></tr></tbody></table>
  </section>
  <section>
    <div class="sechead"><span>JOURNAL BOT</span><span id="jN" class="mut">0 événements</span></div>
    <div id="journal"></div>
  </section>
  <section>
    <div class="sechead"><span>HISTORIQUE — TRADES FERMÉS</span></div>
    <div style="max-height:340px;overflow-y:auto"><table><thead><tr><th>#</th><th>SENS</th><th>LEVIER</th><th>ENTRÉE</th><th>SORTIE</th><th>INVESTI</th><th>GAIN / PERTE</th><th>RENDEMENT</th><th>RAISON</th><th>DURÉE</th></tr></thead>
    <tbody id="tHist"><tr><td colspan="10" class="mut">Aucun trade fermé pour l'instant</td></tr></tbody></table></div>
  </section>
</div>
</div>
<script>
var $=function(id){return document.getElementById(id)};
var chartCloses=[],lastPrice=0,jCount=0;
setInterval(function(){var d=new Date();$('clock').textContent=('0'+d.getHours()).slice(-2)+':'+('0'+d.getMinutes()).slice(-2)+':'+('0'+d.getSeconds()).slice(-2)},1000);
function fp(x,d){return x==null?'—':Number(x).toLocaleString('fr-FR',{minimumFractionDigits:d,maximumFractionDigits:d})}
function money(x){if(x==null)return '—';return (x>=0?'+$':'-$')+Math.abs(x).toFixed(2)}
function dur(ms){var s=Math.round(ms/1000);return Math.floor(s/60)+'m'+('0'+s%60).slice(-2)+'s'}
function emaS(a,p){var k=2/(p+1),e=a[0];return a.map(function(v,i){e=i?v*k+e*(1-k):v;return e})}
function drawChart(){
  var cv=$('chart'),ctx=cv.getContext('2d');
  var W=cv.width=cv.clientWidth*2,H=cv.height=cv.clientHeight*2;
  ctx.clearRect(0,0,W,H);
  var data=chartCloses.slice();if(lastPrice)data.push(lastPrice);
  if(data.length<10)return;
  var view=data.slice(-160);
  var lo=Math.min.apply(null,view),hi=Math.max.apply(null,view),pad=(hi-lo)*0.18||1;
  function Y(v){return H-((v-(lo-pad))/((hi+pad)-(lo-pad)))*H}
  function X(i){return 14+i/(view.length-1)*(W-170)}
  ctx.font='19px JetBrains Mono,monospace';
  for(var g=1;g<5;g++){var vy=lo-pad+((hi+pad)-(lo-pad))*g/5,yy=Y(vy);
    ctx.strokeStyle='rgba(125,139,161,.10)';ctx.beginPath();ctx.moveTo(0,yy);ctx.lineTo(W,yy);ctx.stroke();
    ctx.fillStyle='#5a6a82';ctx.fillText(fp(vy,2),10,yy-6)}
  var e8=emaS(view,8),e21=emaS(view,21);
  function line(arr,color,w,glow){ctx.beginPath();for(var i=0;i<arr.length;i++){var px=X(i),py=Y(arr[i]);i?ctx.lineTo(px,py):ctx.moveTo(px,py)}
    ctx.strokeStyle=color;ctx.lineWidth=w;ctx.shadowBlur=glow?14:0;ctx.shadowColor=color;ctx.stroke();ctx.shadowBlur=0}
  line(e21,'#d9a441',2.5,false);line(e8,'#7b87ff',2.5,false);line(view,'#37e0b0',3,true);
  var cp=view[view.length-1],cy=Y(cp);
  ctx.setLineDash([7,7]);ctx.strokeStyle='rgba(55,224,176,.45)';ctx.beginPath();ctx.moveTo(0,cy);ctx.lineTo(W,cy);ctx.stroke();ctx.setLineDash([]);
  ctx.fillStyle='#37e0b0';ctx.fillRect(W-148,cy-19,142,38);
  ctx.fillStyle='#03211a';ctx.font='bold 22px JetBrains Mono,monospace';ctx.fillText(fp(cp,1),W-140,cy+8);
  ctx.font='20px JetBrains Mono,monospace';
  ctx.fillStyle='#7b87ff';ctx.fillText('— EMA 8',16,30);
  ctx.fillStyle='#d9a441';ctx.fillText('— EMA 21',140,30);
}
window.addEventListener('resize',drawChart);
var seenLog={};
function addLog(e){var kk=e.ts+'|'+e.msg;if(seenLog[kk])return;seenLog[kk]=1;jCount++;$('jN').textContent=jCount+' événements';
  var d=new Date(e.ts),t=('0'+d.getHours()).slice(-2)+':'+('0'+d.getMinutes()).slice(-2)+':'+('0'+d.getSeconds()).slice(-2);
  var div=document.createElement('div');div.className='jl-'+e.type;
  div.innerHTML='<span class="ts">'+t+'</span>'+e.msg.replace(/</g,'&lt;');
  var j=$('journal');j.prepend(div);while(j.children.length>250)j.lastChild.remove()}
function render(s){
  $('bMode').textContent=(s.mode==='live'?'🔴 LIVE · ':s.mode==='paper'?'📝 PAPER · ':'OFF · ')+s.net.toUpperCase();
  $('bMode').style.color=s.mode==='live'?'var(--red)':s.mode==='paper'?'var(--yellow)':'var(--muted)';
  $('bRun').textContent=s.killed?'⛔ KILL SWITCH':s.running?'● EN MARCHE':'⏸ ARRÊTÉ';
  $('bRun').style.color=s.killed?'var(--red)':s.running?'var(--teal)':'var(--muted)';
  if(s.Pp){$('pCap').textContent='$'+fp(s.Pp.cap,0);
    $('pS1').textContent='$'+s.Pp.stake+' · dyn ±5%/100$';
    $('pFS').textContent='$'+s.Pp.fs;
    $('pSL').textContent='-'+(s.Pp.slM*100).toFixed(0)+'% mise (Binance)';
    $('pTP').textContent='+'+(s.Pp.armM*100).toFixed(0)+'% mise (Binance)';
    $('pTR').textContent='~+'+((s.Pp.armM-s.Pp.cbM)*100).toFixed(0)+'% mise garanti';
    $('pTPR').textContent=s.Pp.tsH+'h · fermeture marché';
    $('pKill').textContent=(s.Pp.killMode==='on')?(((s.killFloor||0)>=0?'coupe à +$':'coupe à -$')+Math.abs(s.killFloor||0).toFixed(0)+' (HWM−'+fp(s.Pp.kill,0)+')'):'OFF (décret — SL seuls gardiens)'}
  if(s.mult!=null)$('pMult').textContent='×'+s.mult.toFixed(2);
  lastPrice=s.price||0;if(s.closes)chartCloses=s.closes;
  $('bigpx').textContent='$'+fp(s.price,2);$('sPx').textContent='$'+fp(s.price,2);
  if(s.chg24!=null){$('bigpct').textContent=(s.chg24>=0?'+':'')+s.chg24.toFixed(2)+'%';$('bigpct').className=s.chg24>=0?'teal':'red'}
  var q=s.sigQ||0;$('qval').textContent=q;
  $('qval').style.color=q>=70?'var(--teal)':q>=45?'var(--yellow)':'var(--red)';
  $('gfill').style.width=q+'%';$('gfill').style.background=q>=70?'var(--teal)':q>=45?'var(--yellow)':'var(--red)';
  var dp=$('dirPill');
  if(s.sigDir==='BULL'){dp.textContent='▲ HAUSSIER';dp.style.color='var(--teal)';dp.style.borderColor='var(--teal)'}
  else if(s.sigDir==='BEAR'){dp.textContent='▼ BAISSIER';dp.style.color='var(--red)';dp.style.borderColor='var(--red)'}
  else{dp.textContent='— NEUTRE';dp.style.color='var(--muted)';dp.style.borderColor='var(--border)'}
  var rl={RANGE:'◆ RANGE · MR 2 sens',UP:'▲ UP · longs',DOWN:'▼ DOWN · shorts',WARMUP:'⏳ WARM-UP'};
  var rc={RANGE:'var(--yellow)',UP:'var(--teal)',DOWN:'var(--red)',WARMUP:'var(--muted)'};
  $('regTxt').textContent=(rl[s.regime]||s.regime)+(s.adx?' · ADX '+s.adx.toFixed(0):'');
  $('regTxt').style.color=rc[s.regime]||'var(--muted)';
  var lev=s.regime==='RANGE'?12:(q<45?12:q<70?17:23);
  $('levNext').innerHTML='Levier prochain : <b style="color:'+(lev===12?'var(--teal)':lev===17?'var(--yellow)':'var(--red)')+'">'+lev+'×</b>'+(s.regime==='RANGE'?' <span style="color:var(--muted)">(plafond RANGE)</span>':'');
  $('sCap').textContent='$'+fp(s.Pp?s.Pp.cap:0,2);
  $('sTot').textContent=money(s.pnlClosed);$('sTot').className='v '+((s.pnlClosed||0)>=0?'teal':'red');
  $('sOpen').textContent=money(s.pnlOpen);$('sOpen').className='v '+((s.pnlOpen||0)>=0?'teal':'red');
  $('sAvail').textContent=s.avail!=null?'$'+fp(s.avail,0):'—';
  $('sInT').textContent='$'+fp(s.inTrades||0,0);
  $('sN').textContent=s.open.length;$('sF').textContent=s.closedN;$('sW').textContent=s.wins;$('sL').textContent=s.closedN-s.wins;
  $('sWR').textContent=s.wr==null?'—':s.wr+'%';
  $('sDD').textContent=(s.ddPct||0).toFixed(2)+'%';
  $('posN').textContent=s.open.length+' actives';
  $('tOpen').innerHTML=s.open.length?s.open.map(function(t){
    return '<tr><td class="'+(t.dir==='LONG'?'teal':'red')+'"><b>'+t.dir+'</b></td><td class="mut">'+t.via+'</td><td>'+(t.mode==='RANGE'?'◆ MR':t.mode==='FORCE'?'⚡':t.tpLocked?'🟢 TRAIL':'⏳')+'</td><td>×'+t.lev+'</td><td class="yel">$'+fp(t.stake,0)+'</td><td>'+fp(t.entry,1)+'</td><td>'+t.qty+'</td><td class="red">'+fp(t.sl,1)+(t.slOk?' <span class="teal">🔒</span>':' <span class="yel">⏳</span>')+'</td><td class="teal">'+fp(t.tp,1)+(t.tpOk?' <span class="teal">✓</span>':' <span class="yel">⏳</span>')+(t.tpLocked?' <span class="teal">🔒</span>':'')+'</td><td class="'+(t.pnl>=0?'teal':'red')+'"><b>'+money(t.pnl)+'</b></td><td><button class="xbtn" data-id="'+t.id+'" title="Fermer au marche">✕ Fermer</button></td></tr>'
  }).join(''):'<tr><td colspan="11" class="mut">Aucune position</td></tr>';
  var vs=Object.keys(s.viaStats||{});
  $('tVia').innerHTML=vs.length?vs.map(function(v){var x=s.viaStats[v];
    return '<tr><td>'+v+'</td><td>'+x.n+'</td><td>'+Math.round(100*x.w/x.n)+'%</td><td class="'+(x.pnl>=0?'teal':'red')+'">'+money(x.pnl)+'</td></tr>'
  }).join(''):'<tr><td colspan="4" class="mut">En attente des premiers trades</td></tr>';
  $('tHist').innerHTML=(s.lastClosed&&s.lastClosed.length)?s.lastClosed.map(function(t,i){
    var rdt=t.stake?(100*t.pnl/t.stake):0;
    return '<tr><td class="mut">'+(s.closedN-i)+'</td><td class="'+(t.dir==='LONG'?'teal':'red')+'">'+t.dir+'</td><td>×'+t.lev+'</td><td>'+fp(t.entry,1)+'</td><td>'+fp(t.exit,1)+'</td><td>$'+fp(t.stake,0)+'</td><td class="'+(t.pnl>=0?'teal':'red')+'"><b>'+money(t.pnl)+'</b></td><td class="'+(rdt>=0?'teal':'red')+'">'+(rdt>=0?'+':'')+rdt.toFixed(1)+'%</td><td class="mut">'+(t.reason||'')+'</td><td class="mut">'+dur(t.dur||0)+'</td></tr>'
  }).join(''):'<tr><td colspan="10" class="mut">Aucun trade fermé pour l&#39;instant</td></tr>';
  curPaused=!!s.paused;
  var b1=$('bStart');
  if(!s.armed||!s.running){btnMode='arm';b1.innerHTML='🔐 Connecter + ▶ ARMER LIVE';b1.style.background='var(--teal)';b1.style.color='#03211a';b1.style.border='0'}
  else if(s.paused){btnMode='resume';b1.innerHTML='▶ REPRENDRE — entrées en pause';b1.style.background='transparent';b1.style.color='var(--teal)';b1.style.border='1px solid var(--teal)'}
  else{btnMode='pause';b1.innerHTML='⏸ PAUSE — bloquer les nouvelles entrées';b1.style.background='transparent';b1.style.color='var(--yellow)';b1.style.border='1px solid var(--yellow)'}
  if(s.armed&&s.running&&!s.paused)$('kMsg').textContent='✅ Moteur ARMÉ et en marche — tu peux fermer cette page, le bot continue.';
  drawChart();
}
var btnMode='arm';
$('bStart').onclick=function(){
  if(btnMode==='arm'){
    var k=$('kKey').value.trim(),s2=$('kSec').value.trim();
    if(!k||!s2){$('kMsg').textContent='Clés manquantes';return}
    $('kMsg').textContent='Armement en cours...';
    fetch('/api/engine/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:k,secret:s2})})
    .then(function(r){return r.json()}).then(function(d){
      $('kMsg').textContent=d.ok?'✅ MOTEUR LIVE ARMÉ — tu peux fermer cette page, le bot continue.':'⚠ '+(d.error||d.hint||'échec')+(d.detail?' — '+d.detail.join(' · '):'');
      if(d.ok){$('kKey').value='';$('kSec').value=''}
    }).catch(function(e){$('kMsg').textContent='⚠ '+e.message});
    return;
  }
  var goPause=(btnMode==='pause');
  fetch('/api/engine/pause',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pause:goPause})})
  .then(function(r){return r.json()}).then(function(d){
    $('kMsg').textContent=d.ok?(goPause?'⏸ PAUSE — nouvelles entrees bloquees, positions toujours gerees.':'▶ REPRISE — entrees reautorisees.'):'⚠ '+(d.error||'refus')
  }).catch(function(e){$('kMsg').textContent='⚠ '+e.message})
};
$('bStop').onclick=function(){
  if(!confirm('ARRET TOTAL : stopper le moteur et effacer les cles de la RAM ?'))return;
  fetch('/api/engine/stop',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({})})
  .then(function(r){return r.json()}).then(function(d){
    $('kMsg').textContent=d.ok?'⏹ Moteur arrêté — les SL/TP natifs restent vivants chez Binance.':'⚠ '+(d.error||'refus')
  }).catch(function(e){$('kMsg').textContent='⚠ '+e.message})
};
var forceCd=0,FORCE_LBL='🖐 Forcer l&#39;entrée — exécute ≤ 1min30';
$('bForce').onclick=function(){
  fetch('/api/engine/force',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({})})
  .then(function(r){return r.json()}).then(function(d){
    if(d.ok){forceCd=90;$('kMsg').textContent='🖐 Entree forcee demandee — execution a la prochaine cloture 1m'}
    else{$('kMsg').textContent='⚠ '+(d.error||'refus')}
  }).catch(function(e){$('kMsg').textContent='⚠ '+e.message})
};
$('tOpen').addEventListener('click',function(ev){
  var b=ev.target&&ev.target.closest?ev.target.closest('button[data-id]'):null;
  if(!b)return;
  if(!confirm('Fermer cette position au marche, maintenant ?'))return;
  fetch('/api/engine/close',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:b.getAttribute('data-id')})})
  .then(function(r){return r.json()}).then(function(d){
    $('kMsg').textContent=d.ok?'✋ Position fermee au marche — stops natifs annules.':'⚠ '+(d.error||'refus')
  }).catch(function(e){$('kMsg').textContent='⚠ '+e.message})
});
var relIn=null,relFlat=true,relPend=false,relOn=true,relSync=0,curPaused=false;
setInterval(function(){
  if(forceCd>0){forceCd--;
    if(relPend){$('bForce').innerHTML='🖐 exécution dans ≤ '+('0'+Math.floor(forceCd/60)).slice(-2)+':'+('0'+forceCd%60).slice(-2)}
    else{forceCd=0;$('bForce').innerHTML=FORCE_LBL}
  } else if($('bForce').innerHTML.indexOf('exécution')>=0){$('bForce').innerHTML=FORCE_LBL}
  var el=$('sRel');if(!el)return;
  if(curPaused){el.textContent='⏸ pause';el.style.color='var(--muted)';return}
  if(!relOn){el.textContent='OFF';el.style.color='var(--muted)';return}
  if(relPend){el.textContent='🖐 demandée';el.style.color='var(--yellow)';return}
  if(!relFlat){el.textContent='position ouverte';el.style.color='var(--muted)';el.style.fontSize='13px';return}
  if(relIn==null){el.textContent='—';return}
  var rem=relIn-(Date.now()-relSync);
  el.style.fontSize='';
  if(rem<=0){el.textContent='≤ 1 clôture 1m';el.style.color='var(--teal)';return}
  var s2=Math.ceil(rem/1000);
  el.textContent=('0'+Math.floor(s2/60)).slice(-2)+':'+('0'+s2%60).slice(-2);
  el.style.color=s2<=120?'var(--teal)':'var(--yellow)';
},1000);
var lastStateAt=0;
var es=new EventSource('/api/stream');
es.onmessage=function(ev){var d=JSON.parse(ev.data);
  if(d.kind==='hello'&&d.journal)d.journal.slice().reverse().forEach(addLog);
  else if(d.kind==='log')addLog(d.e);
  else if(d.kind==='state'){lastStateAt=Date.now();
    if(d.s.relance){relIn=d.s.relance.inMs;relFlat=d.s.relance.flat;relPend=d.s.relance.pending;relOn=d.s.relance.on;relSync=Date.now()}
    render(d.s)}};
setInterval(function(){
  if(Date.now()-lastStateAt<6000)return;
  fetch('/api/snapshot').then(function(r){return r.json()}).then(function(d){
    if(d.journal)d.journal.forEach(addLog);
    if(d.s){lastStateAt=Date.now();
      if(d.s.relance){relIn=d.s.relance.inMs;relFlat=d.s.relance.flat;relPend=d.s.relance.pending;relOn=d.s.relance.on;relSync=Date.now()}
      render(d.s)}
  }).catch(function(){})
},4000);
</script></body></html>`;

app.get('/', (req, res) => {
  res.status(200).setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(DASH_HTML);
});
app.get('/api/health', (req, res) => res.status(200).json({ ok: true, service: 'Itachi BOT-BTC', version: 'v8.5-belock', armed: !!(E_KEY && E_SECRET), engine: ENGINE_MODE, net: ENGINE_NET, symbol: SYMBOL, running: S.running, clockOffsetMs: Math.round(TIME_OFFSET), endpoints: ['/api/binance', '/api/diag', '/api/pnl-reel', '/api/state', '/api/stream', '/api/why'] }));

// ═════════════ DEMARRAGE MOTEUR ═════════════
async function startEngine() {
  if (ENGINE_MODE === 'off') { console.log('[BOT] ENGINE_MODE=off — serveur en mode PROXY PUR (comportement v3.5). Regler ENGINE_MODE=paper|live + cles pour activer.'); return; }
  if (ENGINE_MODE === 'live' && (!E_KEY || !E_SECRET)) { console.log('[BOT] ⛔ ENGINE_MODE=live mais BINANCE_API_KEY/SECRET absentes — moteur NON demarre.'); return; }
  try {
    jlog('sys', `🚀 Itachi v8.5 BELOCK · Srv 4.0 · WR: a mesurer — verrou break-even a +30% de mise (decret 13/07) · FORCE off par decret (0/4 live) · purge anti-orphelin double verrou · RANGE-MR levier plafonne 12x · horloge blindee anti-1102 · poll aligne clotures 1m · SL+trail paralleles · keep-warm hote ordres · retournement Q>=75 confirme cloture 5m (decret 11/07) · ${ENGINE_MODE.toUpperCase()} ${ENGINE_NET.toUpperCase()} ${SYMBOL} — entrees MULTI-REGIME ADX 5m (Q35 range, MIN_GAP 1min30, max 2 pos) · MISE 750$ dyn ±5%/100$ · leviers 12/17/23 par Q · sorties natives UNIFIEES: SL -30% mise, trailing arme +60% → plancher ~+40%, garde-temps 4h · RELANCE 30min 750$ · KILL ${KILL_MODE === 'on' ? 'suiveur HWM-' + (P.CAP*P.KILL).toFixed(0) + '$' : 'OFF (decret — SL seuls gardiens)'}`);
    await seedCandles();
    if (ENGINE_MODE === 'live') {
      const bal = await bnCall(E_BASE, '/fapi/v2/balance', 'GET', {}, E_KEY, E_SECRET);
      const usdt = Array.isArray(bal) ? bal.find(b => b.asset === 'USDT') : null;
      if (!usdt) { jlog('sell', `⛔ Lecture solde impossible (${JSON.stringify(bal).slice(0, 120)}) — moteur NON demarre.`); return; }
      S.walletStart = parseFloat(usdt.balance); S.walletNow = S.walletStart;
      jlog('sys', `✅ 🔴 LIVE ${ENGINE_NET} — wallet depart: $${S.walletStart.toFixed(2)} | KILL a ${(-(P.CAP*P.KILL)).toFixed(0)}$ de perte session`);
    } else {
      jlog('sys', `📝 PAPER — capital simule $${S.paperCap.toFixed(2)}, prix reels, AUCUN ordre envoye`);
    }
    S.running = true; S.killed = false; S.startedAt = Date.now(); S.lastHb = Date.now();
    S.lastEntry = Date.now();   // arme l'horloge du MODE RELANCE a partir du demarrage
    if (!startEngine._timers) { // les boucles ne se creent qu'UNE fois (re-armement sans doublons)
      startEngine._timers = true;
      schedulePoll();                     // poll aligne sur les clotures 1m (v8.2)
      setInterval(reconcile, 9000);         // inerte hors mode live
      setInterval(refreshNetReel, 30000);   // idem
    }
    if (ENGINE_MODE === 'live') refreshNetReel();
    jlog('sys', '🔁 Boucle prix ALIGNEE clotures 1m (croisiere 4s, capture ~0.5s) | Binance = source de verite (9s)');
  } catch (e) {
    jlog('sell', `⛔ Demarrage moteur echoue: ${e.message} — nouvel essai dans 30s`);
    setTimeout(startEngine, 30000);
  }
}

// ═════════════ SELFTEST (node server.js --selftest : AUCUN reseau, AUCUN port) ═════════════
if (process.argv.includes('--selftest')) {
  (function selftest() {
    let ok = true;
    const assert = (cond, name) => { console.log((cond ? '✅' : '❌') + ' ' + name); if (!cond) ok = false; };
    // EMA : serie constante → EMA = constante
    assert(Math.abs(calcEMA(Array(50).fill(100), 21) - 100) < 1e-9, 'EMA constante = 100');
    // RSI : hausse pure → 100 ; baisse pure → ~0
    const up = Array.from({ length: 40 }, (_, i) => 100 + i);
    const dn = Array.from({ length: 40 }, (_, i) => 100 - i);
    assert(calcRSI(up, 14) === 100, 'RSI hausse pure = 100');
    assert(calcRSI(dn, 14) < 1, 'RSI baisse pure < 1');
    // Bollinger : serie constante → sd=0, bandes = mid
    const bb0 = calcBB(Array(30).fill(50), 20, 2);
    assert(bb0.sd === 0 && bb0.up === 50 && bb0.lo === 50, 'BB constante : bandes = mid');
    // ADX : tendance haussiere monotone → +DI > -DI et ADX eleve ; bruit plat → ADX faible
    const trendUp = Array.from({ length: 80 }, (_, i) => ({ h: 100 + i + 0.5, l: 100 + i - 0.5, c: 100 + i }));
    const rUp = calcADX(trendUp, 14);
    assert(rUp && rUp.pdi > rUp.ndi && rUp.adx > 60, `ADX tendance up : +DI>${rUp ? rUp.ndi.toFixed(1) : '?'} -DI, ADX=${rUp ? rUp.adx.toFixed(1) : '?'} > 60`);
    const flat = Array.from({ length: 80 }, (_, i) => ({ h: 100 + (i % 2 ? 0.4 : 0.5), l: 100 - (i % 2 ? 0.5 : 0.4), c: 100 + (i % 2 ? -0.1 : 0.1) }));
    const rFlat = calcADX(flat, 14);
    assert(rFlat && rFlat.adx < ADX_TREND, `ADX marche plat = ${rFlat ? rFlat.adx.toFixed(1) : '?'} < ${ADX_TREND} → RANGE`);
    assert(classifyRegime(rUp) === 'UP' && classifyRegime(rFlat) === 'RANGE', 'classifyRegime : UP / RANGE corrects');
    const trendDn = Array.from({ length: 80 }, (_, i) => ({ h: 200 - i + 0.5, l: 200 - i - 0.5, c: 200 - i }));
    assert(classifyRegime(calcADX(trendDn, 14)) === 'DOWN', 'classifyRegime : DOWN correct');
    // QMR : plus l extreme est marque, plus Q monte
    const bbT = { mid: 100, up: 102, lo: 98, sd: 1 };
    const qSeuil  = calcQMR('LONG', 98.0, bbT, 32);   // RSI 32 pile sur la bande → doit valoir EXACTEMENT le plancher
    const qRejet  = calcQMR('LONG', 98.0, bbT, 38);   // RSI 38 sans exces de bande → sous le plancher
    const qFort   = calcQMR('LONG', 97.0, bbT, 15);   // RSI 15 + 1σ sous la bande → maximal
    assert(qSeuil === QMR_MIN, `QMR : RSI 32 sur bande = ${qSeuil} = plancher ${QMR_MIN} (decret Q35)`);
    assert(qRejet < QMR_MIN, `QMR : RSI 38 sans exces = ${qRejet} < ${QMR_MIN} → refuse`);
    assert(qFort === 99, `QMR extreme = ${qFort}`);
    // Grille decrets
    assert(getLev(40) === 12 && getLev(60) === 17 && getLev(85) === 23, 'Leviers 12/17/23 par Q (v8)');
    assert(getStake(40) === 750 && getStake(85) === 750, 'Mise unique 750$ (v8)');
    // v8 SWING : distances prix = %mise / levier, callbacks arrondis au pas Binance 0.1
    assert(Math.abs(SWING_SL_M / 12 - 0.025) < 1e-12, 'SL 12x = -2.5% px');
    assert(cbRate(12) === 1.7 && cbRate(17) === 1.2 && cbRate(23) === 0.9, `Callbacks: ${cbRate(12)}/${cbRate(17)}/${cbRate(23)}`);
    const floor12 = SWING_ARM_M - (cbRate(12) / 100) * 12;
    assert(floor12 > 0.39 && floor12 <= 0.40, `Plancher apres armement 12x ≈ +${(floor12*100).toFixed(1)}% de mise`);
    assert(FORCE_STAKE === 750, 'Relance alignee 750$ (v8)');
    // DECRET 07/07 : mises dynamiques ±5%/100$ bornees [0.30;2.00]
    assert(sizeMultFor(0) === 1 && sizeMultFor(99) === 1 && sizeMultFor(150) === 1.05, `Paliers hausse: ${sizeMultFor(150)}`);
    assert(sizeMultFor(-99) === 1 && sizeMultFor(-150) === 0.95, `Paliers baisse: ${sizeMultFor(-150)}`);
    assert(sizeMultFor(999) === 1.45 && sizeMultFor(100000) === 2 && sizeMultFor(-100000) === 0.3, 'Bornes [0.30;2.00]');
    // DECRET 07/07 : kill suiveur — HWM 100 → plancher -300 ; HWM 500 → +100
    assert(100 - 2000*0.20 === -300 && 500 - 2000*0.20 === 100, 'Kill suiveur: HWM-400');
    console.log(ok ? '\n════ SELFTEST COMPLET : TOUT PASSE ════' : '\n════ SELFTEST : ECHECS DETECTES ════');
    process.exit(ok ? 0 : 1);
  })();
} else {
  startEngine();
}

// ══ ECOUTE (apres definition de TOUTES les routes) ══
if (!process.argv.includes('--selftest')) {
  app.listen(PORT, () => console.log(`Itachi BOT-BTC v6.0 (Srv 4.0 — proxy + moteur ${ENGINE_MODE.toUpperCase()}) en ecoute sur le port ${PORT}`));
}
