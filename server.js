// ═══════════════════════════════════════════════════════════════
//  server.js — Proxy Binance Futures (Railway) — v2.1
//  Reprise automatique des erreurs -1007 du testnet :
//  « Binance = source de vérité » — sur -1007 (exécution inconnue)
//  on VÉRIFIE l'ordre chez Binance via son identifiant client ;
//  s'il n'existe pas → 1 retry ; si le retry timeout aussi →
//  re-vérification finale avant de conclure.
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const crypto  = require('crypto');

const app  = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());

// ── CORS : autorise la PWA Vercel + tests locaux ──
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

// Signe et appelle Binance ; renvoie le JSON brut
async function bnCall(base, path, method, params, apiKey, apiSecret) {
  const p = { ...params, timestamp: Date.now(), recvWindow: 5000 };
  const qs = Object.entries(p)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  const signature = crypto.createHmac('sha256', apiSecret).update(qs).digest('hex');
  const url = `${base}${path}?${qs}&signature=${signature}`;
  const r = await fetch(url, { method, headers: { 'X-MBX-APIKEY': apiKey } });
  const text = await r.text();
  try { return JSON.parse(text); }
  catch { return { code: -1, msg: 'Reponse non-JSON', raw: text.slice(0, 200) }; }
}

// Vérifie si un ordre existe chez Binance (par identifiant client)
async function orderExists(base, symbol, clientId, apiKey, apiSecret) {
  const check = await bnCall(base, '/fapi/v1/order', 'GET',
    { symbol, origClientOrderId: clientId }, apiKey, apiSecret);
  return (check && check.orderId) ? check : null;
}

// Health-checks
app.get('/', (req, res) => {
  res.status(200).json({ ok: true, service: 'Itachi Proxy Binance', version: 'v2.1-reprise-1007', endpoint: '/api/binance' });
});
app.get('/api/binance', (req, res) => {
  res.status(200).json({ ok: true, msg: 'Proxy Railway vivant (v2.1, reprise -1007) — utiliser POST', modes: Object.keys(BN_BASES) });
});

// Endpoint principal
app.post('/api/binance', async (req, res) => {
  try {
    const apiKey    = req.headers['x-api-key'];
    const apiSecret = req.headers['x-api-secret'];
    const mode      = req.headers['x-bn-mode'] === 'mainnet' ? 'mainnet' : 'testnet';
    const base      = BN_BASES[mode];

    if (!apiKey || !apiSecret) {
      return res.status(200).json({ code: -2014, msg: 'Cles API manquantes dans les headers' });
    }

    const body   = req.body || {};
    const path   = body.path || '/fapi/v2/balance';
    const method = (body.method || 'GET').toUpperCase();
    const params = { ...(body.params || {}) };

    // Identifiant client unique sur chaque ordre → rend la reprise -1007 possible
    const isOrder = method === 'POST' && path.includes('/order');
    if (isOrder && !params.newClientOrderId) {
      params.newClientOrderId = 'itachi' + Date.now() + Math.floor(Math.random() * 1000);
    }
    const id1 = params.newClientOrderId;

    let data = await bnCall(base, path, method, params, apiKey, apiSecret);

    // ── REPRISE -1007 : exécution inconnue → Binance = source de vérité ──
    if (isOrder && data && data.code === -1007) {
      await sleep(2500);
      const found1 = await orderExists(base, params.symbol, id1, apiKey, apiSecret);

      if (found1) {
        data = { ...found1, recovered: true };            // l'ordre existait malgré le timeout
      } else {
        // L'ordre n'existe pas → UNE nouvelle tentative
        await sleep(1000);
        const id2 = id1 + 'r';
        const retry = await bnCall(base, path, method,
          { ...params, newClientOrderId: id2 }, apiKey, apiSecret);

        if (retry && retry.orderId) {
          data = { ...retry, retried: true };
        } else if (retry && retry.code === -1007) {
          // Retry timeout aussi → vérification finale avant de conclure
          await sleep(2500);
          const found2 = await orderExists(base, params.symbol, id2, apiKey, apiSecret);
          data = found2 ? { ...found2, recovered: true, onRetry: true } : retry;
        } else {
          data = retry;                                    // autre erreur : on la remonte telle quelle
        }
      }
    }

    return res.status(200).json(data);

  } catch (e) {
    return res.status(200).json({ code: -1, msg: 'Proxy Railway: ' + e.message });
  }
});

app.listen(PORT, () => console.log(`Proxy Binance v2.1 (reprise -1007) en ecoute sur le port ${PORT}`));
