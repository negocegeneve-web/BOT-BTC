// ═══════════════════════════════════════════════════════════════
//  server.js — Proxy Binance Futures autonome (Railway)
//  Écoute le PORT fourni par Railway. Route /api/binance :
//  reçoit POST { path, method, params } + headers clés,
//  signe en HMAC-SHA256, relaie vers Binance testnet/mainnet.
//  Résout le CORS (restriction navigateur, pas serveur).
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
  testnet: 'https://demo-fapi.binance.com',   // base REST officielle testnet Futures
  mainnet: 'https://fapi.binance.com'
};

// Racine + health-check
app.get('/', (req, res) => {
  res.status(200).json({ ok: true, service: 'Itachi Proxy Binance', endpoint: '/api/binance' });
});
app.get('/api/binance', (req, res) => {
  res.status(200).json({ ok: true, msg: 'Proxy Railway vivant — utiliser POST', modes: Object.keys(BN_BASES) });
});

// Endpoint principal
app.post('/api/binance', async (req, res) => {
  try {
    const apiKey    = req.headers['x-api-key'];
    const apiSecret = req.headers['x-api-secret'];
    const mode      = req.headers['x-bn-mode'] === 'mainnet' ? 'mainnet' : 'testnet';

    if (!apiKey || !apiSecret) {
      return res.status(200).json({ code: -2014, msg: 'Cles API manquantes dans les headers' });
    }

    const body   = req.body || {};
    const path   = body.path || '/fapi/v2/balance';
    const method = (body.method || 'GET').toUpperCase();
    const params = body.params || {};

    // Signature HMAC-SHA256 — doit clore la query string
    params.timestamp  = Date.now();
    params.recvWindow = 5000;
    const qs = Object.entries(params)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&');
    const signature = crypto.createHmac('sha256', apiSecret).update(qs).digest('hex');
    const url = `${BN_BASES[mode]}${path}?${qs}&signature=${signature}`;

    // Relais vers Binance
    const bn   = await fetch(url, { method, headers: { 'X-MBX-APIKEY': apiKey } });
    const text = await bn.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { code: -1, msg: 'Reponse non-JSON', raw: text.slice(0, 200) }; }

    return res.status(200).json(data);   // corps Binance brut, HTTP 200

  } catch (e) {
    return res.status(200).json({ code: -1, msg: 'Proxy Railway: ' + e.message });
  }
});

app.listen(PORT, () => console.log(`Proxy Binance en ecoute sur le port ${PORT}`));
