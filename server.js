// ═══════════════════════════════════════════════════════════════
//  server.js — Proxy Binance Futures (Railway) — v3 "Champion"
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
async function syncTimeAndWarm() {
  try {
    const t0 = Date.now();
    const r  = await fetch(BN_BASES.testnet + '/fapi/v1/time', { signal: AbortSignal.timeout(5000) });
    const d  = await r.json();
    const rtt = Date.now() - t0;
    const offset = d.serverTime + rtt / 2 - Date.now();
    TIME_OFFSET = TIME_OFFSET === 0 ? offset : TIME_OFFSET * 0.8 + offset * 0.2; // lissage
  } catch (e) { /* silencieux : le prochain ping réessaie */ }
}

// ══ 3. TRANSPORT SIGNÉ — clone exact du signedRequest Champion ══
// Renvoie TOUJOURS un objet (jamais de throw) : JSON Binance brut,
// ou { code:-1007 } sur timeout réseau, ou { code:-1, raw } sur non-JSON.
async function bnCall(base, path, method, params, apiKey, apiSecret) {
  const timestamp = Date.now() + Math.round(TIME_OFFSET);
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

// ══ 4. SL/TP conditionnels → service ALGO (migration 09/12/2025), repli ancien ══
// Structure copiée de placeExchangeStops du Champion.
async function placeConditional(base, params, apiKey, apiSecret) {
  const algoParams = {
    symbol: params.symbol,
    side: params.side,
    orderType: params.type,                                   // STOP_MARKET | TAKE_PROFIT_MARKET
    triggerPrice: params.stopPrice,
    closePosition: params.closePosition || 'true',
    workingType: params.workingType || 'MARK_PRICE',
    timeInForce: params.timeInForce || 'GTE_GTC',
  };
  const a = await bnCall(base, '/fapi/v1/algoOrder', 'POST', algoParams, apiKey, apiSecret);
  if (a && (a.algoId || a.orderId || a.clientAlgoId)) {
    return { orderId: a.algoId || a.orderId, algo: true, ...a };
  }
  // Repli : ancien endpoint (environnements pas encore migrés)
  const b = await bnCall(base, '/fapi/v1/order', 'POST', params, apiKey, apiSecret);
  if (b && b.orderId) return b;
  return { code: (a && a.code) || (b && b.code) || -1, msg: 'algo: ' + JSON.stringify(a).slice(0,120) + ' / classique: ' + JSON.stringify(b).slice(0,120) };
}

// ── Health ──
app.get('/', (req, res) => res.status(200).json({ ok: true, service: 'Itachi Proxy Binance', version: 'v3-champion-transport', clockOffsetMs: Math.round(TIME_OFFSET), endpoints: ['/api/binance', '/api/diag'] }));
app.get('/api/binance', (req, res) => res.status(200).json({ ok: true, msg: 'Proxy Railway vivant (v3 Champion : keep-warm + horloge + algo SL/TP + reprise -1007)', clockOffsetMs: Math.round(TIME_OFFSET), modes: Object.keys(BN_BASES) }));

// ══ 6. DIAGNOSTIC ══
app.get('/api/diag', async (req, res) => {
  const out = { version: 'v3-champion-transport', date: new Date().toISOString(), clockOffsetMs: Math.round(TIME_OFFSET) };
  const base = BN_BASES.testnet;

  try {
    const r = await fetch('https://ipapi.co/json/', { signal: AbortSignal.timeout(6000) });
    const j = await r.json();
    out.sortie = { ip: j.ip, pays: j.country_name, ville: j.city, org: j.org };
  } catch (e) {
    try { const r2 = await fetch('https://ifconfig.co/json', { signal: AbortSignal.timeout(6000) }); const j2 = await r2.json(); out.sortie = { ip: j2.ip, pays: j2.country }; }
    catch (e2) { out.sortie = { erreur: e2.message }; }
  }

  { const t0 = Date.now();
    try { const r = await fetch(base + '/fapi/v1/time', { signal: AbortSignal.timeout(8000) }); const txt = await r.text();
      out.ping_binance = { httpStatus: r.status, ms: Date.now() - t0, extrait: txt.slice(0, 80) };
    } catch (e) { out.ping_binance = { erreur: e.message, ms: Date.now() - t0 }; } }

  const apiKey = process.env.BN_TEST_KEY, apiSecret = process.env.BN_TEST_SECRET;
  if (!apiKey || !apiSecret) { out.lecture_signee = out.test_ecriture = 'Variables BN_TEST_KEY / BN_TEST_SECRET absentes sur Railway'; return res.status(200).json(out); }

  { const t0 = Date.now();
    const j = await bnCall(base, '/fapi/v2/balance', 'GET', {}, apiKey, apiSecret);
    out.lecture_signee = { ms: Date.now() - t0, verdict: Array.isArray(j) ? 'OK (' + j.length + ' actifs)' : ('code ' + j.code + ' — ' + (j.msg || '')), extrait: JSON.stringify(j).slice(0, 120) }; }

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
    const isConditional = isOrder && (params.type === 'STOP_MARKET' || params.type === 'TAKE_PROFIT_MARKET');

    let data;

    if (isConditional) {
      // ── SL/TP : route ALGO (correctif -4120) avec repli ──
      data = await placeConditional(base, params, apiKey, apiSecret);
    } else {
      if (isOrder && !params.newClientOrderId) params.newClientOrderId = 'itachi' + Date.now() + Math.floor(Math.random() * 1000);
      const id1 = params.newClientOrderId;

      data = await bnCall(base, path, method, params, apiKey, apiSecret);

      // ── Reprise -1007 : Binance = source de vérité ──
      if (isOrder && data && data.code === -1007) {
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
    }

    if (isOrder) {
      if (data && data.orderId) console.log(`[ORDER OK] ${params.symbol} ${params.side} ${params.type} → #${data.orderId}${data.algo ? ' (algo)' : ''}${data.recovered ? ' (recovered)' : ''}${data.retried ? ' (retried)' : ''}`);
      else console.log(`[ORDER FAIL] ${params.symbol} ${params.side} ${params.type} → ${JSON.stringify(data).slice(0, 400)}`);
    }

    return res.status(200).json(data);
  } catch (e) {
    return res.status(200).json({ code: -1, msg: 'Proxy Railway: ' + e.message });
  }
});

// ══ Démarrage : synchro immédiate puis keep-warm toutes les 3s (recette Champion) ══
syncTimeAndWarm();
setInterval(syncTimeAndWarm, 3000);

app.listen(PORT, () => console.log(`Proxy Binance v3 Champion (keep-warm 3s + horloge + algo) en ecoute sur le port ${PORT}`));
