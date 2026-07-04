// ═══════════════════════════════════════════════════════════════
//  ROUTE PROXY BINANCE — à ajouter dans server.js (Railway)
//  Le bot PWA appelle cette route ; Railway signe en HMAC-SHA256
//  et relaie vers Binance (testnet ou mainnet). Résout le CORS.
//
//  ── INSTALLATION ──
//  1. Colle le bloc ci-dessous dans ton server.js, APRÈS la ligne
//     `const app = express();` (et après `app.use(express.json())`
//     si tu l'as ; sinon la ligne est incluse ici).
//  2. Rien d'autre : `crypto` et `fetch` sont natifs Node 18+.
//  3. Commit → Railway redéploie tout seul.
// ═══════════════════════════════════════════════════════════════

const crypto = require('crypto');

// S'assure que le JSON du body est parsé (sans écraser si déjà présent)
app.use(express.json());

// ── CORS pour la route proxy (autorise la PWA Vercel + tests locaux) ──
app.use('/api/binance', (req, res, next) => {
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

// Health-check : GET /api/binance dans un navigateur → JSON de vie
app.get('/api/binance', (req, res) => {
  res.status(200).json({ ok: true, msg: 'Proxy Railway vivant — utiliser POST', modes: Object.keys(BN_BASES) });
});

// Endpoint principal : POST { path, method, params }
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

    // Signature HMAC-SHA256 — la signature doit clore la query string
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

    // Corps Binance brut, toujours HTTP 200 → la PWA lit orderId / balance / code d'erreur
    return res.status(200).json(data);

  } catch (e) {
    return res.status(200).json({ code: -1, msg: 'Proxy Railway: ' + e.message });
  }
});

// ═══════════════════════════════════════════════════════════════
//  FIN DU BLOC PROXY BINANCE
// ═══════════════════════════════════════════════════════════════
