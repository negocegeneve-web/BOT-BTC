/* ============================================================
 *  SERVEUR 3.12c - CHAMPION  (moteur allege — strategie 3.12b INTACTE)
 *  ------------------------------------------------------------
 *  AUCUN parametre ni logique de strategie modifie : parite SHA-256
 *  verifiee sur toutes les fonctions de decision (computeSignal,
 *  sizing, bollinger, rsi, adx, tryOpen, closePos, stops natifs...).
 *  Optimisations MOTEUR uniquement :
 *   1. Telemetrie coupee a la source quand AUCUN dashboard n'est
 *      connecte (overview 5s, positions 2s, snapshot 5min, logs) :
 *      zero construction d'objets + zero JSON.stringify pour personne.
 *      A la (re)connexion, le client recoit le snapshot complet -> rien
 *      n'est perdu. Gain CPU principal en fonctionnement autonome 24/7.
 *   2. refreshLiveIndicators : fenetre bornee (20 valeurs au lieu de
 *      copier ~100 closes a chaque tick x40 symboles). Memes fenetres
 *      de calcul, memes valeurs — parite numerique testee.
 *   3. tradesLastHour : purge en place (zero allocation par evaluation).
 *   4. symbolsOverview : sparkline construite directement (40 au lieu
 *      de 60+slice).
 *  ------------------------------------------------------------
 *  HISTORIQUE 3.12b (SL -4.5% + bonus loterie + fix -4120)
 *  ------------------------------------------------------------
 *  Base = 3.12 Champion. Evolutions :
 *
 *  1. SL -5% -> -4.5% : OPTIMUM mesure (moteur backtest reproductible,
 *     mai). Portefeuille reel 1000$ : +33.4% (vs +19.5% a -5%), DD
 *     -15.5%, WR 68.7%. Coupe un peu plus tot -> libere la marge ->
 *     capture plus de trades (195 vs 165) sans perdre en qualite.
 *
 *  2. BONUS LOTERIE (spec Calvin, ON) : 1x/h, mise 25-50$, levier
 *     x15, AUCUN SL (liquidation ~-1/levier = plancher, perte max =
 *     la mise). TP s'arme a +100% de la mise puis TRAILING large
 *     (rend 30% du pic, laisse courir). Compteur SEPARE + bouton.
 *     ATTENTION backtest mai : perdant (-270$/mois) et il bride le
 *     moteur principal (portefeuille complet +33.4% -> -18%). Pari
 *     pour marches AGITES ; coupable d'un tap si les chiffres decoivent.
 *
 *  3. CORRECTIF -4120 (migration Binance 09/12/2025) : les stops
 *     natifs (STOP_MARKET/TAKE_PROFIT_MARKET) sont desormais REJETES
 *     sur /fapi/v1/order et doivent passer par le service ALGO
 *     (/fapi/v1/algoOrder). placeExchangeStops corrige + fallback
 *     ancien endpoint + annulation via /fapi/v1/algoOrder. Si l'algo
 *     echoue (testnet incomplet), le SL LOGICIEL (tick ~1s) protege
 *     en secours -> une position n'est jamais totalement nue tant
 *     que le bot tourne.
 *
 *  Reste identique : seuils +15%, trailing +1%/-1.5%, x2-5, plancher
 *  4/h togglable, anti-actifs-bloques, 2-taps Fermer, TS OFF/24h.
 *  Valide sur MAI uniquement — validation JUIN = juge de paix.
 * ============================================================ */
/**
 * ITACHI MULTI — Bot multi-crypto Binance Futures (testnet/mainnet)
 * -----------------------------------------------------------------
 * Swing mean-reversion multi-régime : 4 voies d'entrée (Bollinger, VWAP,
 * Support/Résistance, Points Pivot), sortie par SL -5% + trailing large
 * (+1% arme / -1.5% du pic) + scaling out ; les gagnants courent jusqu'à 24h.
 *
 * Principes :
 *   - Binance = source de vérité (réconciliation ~9s, vérif après timeout -1007)
 *   - 1 position par symbole (One-Way), jusqu'à 25 positions en parallèle
 *   - Exposition notionnelle bornée par MAX_EXPOSURE_PCT (garde-fou, levier inclus)
 *   - Frais Binance intégrés dans le P&L (maker à l'entrée si possible, taker en sortie)
 *   - Bougies 1h (analyse) + 2h (régime ADX), indicateurs réactifs recalculés au tick
 *
 * Tous les paramètres ajustables sont en haut du fichier.
 */

'use strict';

const http = require('http');
const crypto = require('crypto');
const WebSocket = require('ws');

// ==================================================================
// CONFIG GÉNÉRALE
// ==================================================================
const MODE = (process.env.BINANCE_MODE || 'testnet').toLowerCase();
const IS_TESTNET = MODE !== 'mainnet';
const API_KEY = process.env.BINANCE_API_KEY || '';
const API_SECRET = process.env.BINANCE_API_SECRET || '';
const CAPITAL_START = parseFloat(process.env.CAPITAL || '1000');
const PORT = parseInt(process.env.PORT || '8080', 10);

const REST_BASE = IS_TESTNET ? 'https://demo-fapi.binance.com' : 'https://fapi.binance.com';
const WS_BASE = IS_TESTNET ? 'wss://demo-fstream.binance.com' : 'wss://fstream.binance.com';
const KLINE_BASE = 'https://fapi.binance.com'; // bougies depuis mainnet (testnet pauvre en historique)

// ==================================================================
// PARAMÈTRES STRATÉGIE (ajustables ici)
// ==================================================================
const STRAT = {
  // ============================================================
  //  SERVEUR 3.5 - TRADE 1J  (swing mean-reversion 1h/4h)
  //  Indicateurs accordes a l'horizon : analyse 1h, confirmation 4h,
  //  positions tenues plusieurs heures (time-stop conditionnel 2h30/5h30).
  //  le funding rate devient un signal de retournement (filtre souple).
  // ============================================================

  // --- Timeframes (accordes a l'horizon de detention) ---
  TF_MAIN: '1h',        // analyse principale : bougies 1h
  TF_CONFIRM: '2h',     // confirmation de regime : bougies 2h (proche du 1h30 voulu, natif Binance)
  KLINE_LIMIT: 100,     // 100 bougies 1h (~4 jours d'historique)
  CONFIRM_LIMIT: 60,    // 60 bougies 2h (~5 jours)

  // --- Indicateurs mean-reversion (sur 1h) ---
  BB_PERIOD: 20,        // Bandes de Bollinger 20 periodes (1h)
  BB_STDDEV: 2.0,       // 2 ecarts-types
  RSI_PERIOD: 14,       // RSI 14 (standard, adapte au swing)
  RSI_OVERSOLD: 37.25,  // survente -> LONG (assoupli +15% : 35->37.25)
  RSI_OVERBOUGHT: 62.75, // surachat -> SHORT (assoupli +15% : 65->62.75)

  // --- Assouplissement d'entrée en RANGE (togglable à chaud) ---
  RELAX_RANGE_ENTRY: true,
  RSI_EXTREME_LOW: 25,     // RSI <= 25 -> LONG même sans toucher la bande basse
  RSI_EXTREME_HIGH: 75,    // RSI >= 75 -> SHORT même sans toucher la bande haute
  ATR_PERIOD: 14,       // ATR 1h (volatilite, calibrage sorties)

  // --- VWAP glissant (seconde voie d'entrée, non-redondant : valeur juste pondérée volume) ---
  VWAP_PERIOD: 24,      // 24 bougies 1h = VWAP glissant sur ~1 jour (horizon swing)
  VWAP_TOUCH: 0.001725, // "toucher" le VWAP (assoupli +15% : 0.15%->0.1725%)
  VWAP_DEV_BAND: 1.3043, // fade déviation (assoupli +15% : 1.5σ->1.30σ)

  // --- Filtre de regime : ADX sur 4h ---
  ADX_PERIOD: 14,
  ADX_RANGE_MAX: 40.25, // ADX 2h (assoupli +15% : 35->40.25)

  // --- Filtre FUNDING (souple) : ajuste le score, ne bloque pas ---
  //  Funding tres positif = trop de longs -> bonus aux SHORT, malus aux LONG.
  //  Funding tres negatif = trop de shorts -> bonus aux LONG (short squeeze).
  FUNDING_SOFT: true,
  FUNDING_EXTREME: 0.0005, // |funding| >= 0.05% (8h) = extreme -> influence le score
  FUNDING_WEIGHT: 15,      // points de qualite ajoutes/retires selon l'alignement funding

  // --- Filtres d'entree ---
  ATR_FLOOR_1H: 0.004,  // ATR 1h min 0.4% : assez de mouvement pour viser 1-2%
  VOL_CONFIRM: false,   // gate binaire RETIRÉ (backtest mai : il coûtait -96 pts de net et
                        // -46 trades/mois pour +1.6 pt de WR ; en live le biais intra-bougie
                        // le rendait pire encore). Le volume module désormais la MISE via
                        // volScore (signal confirmé par volume -> mise plus grosse), sans jeter.

  // --- Sorties (swing : trailing LARGE, on laisse courir vers 1-4%) ---
  SL_PCT: 0.045,        // -4.5% : optimum mesure (moteur reproductible mai) : indice +388%, WR 70.2%, gain/trade +1.38% (vs -5%: +266%). Libere la marge plus vite -> +trades captes.
                        // backtest). Courbe mesurée (mai, indice) : -2%->+421 · -2.5%->+433 ·
                        // -4%->+598 · -5%->+599 (optimum) · -6%->+482. En PORTEFEUILLE réel 1000$
                        // avec plancher ON : +77.1%/mois, DD -9.0%, WR 68.9%, 33 stops (vs 135 à -2%).
                        // Le stop large ne se fait toucher que par les VRAIS retournements, pas le bruit.
  TRAIL_ARM: 0.010,     // trailing s'arme a +1.0%
  TRAIL_PCT: 0.015,     // suiveur -1.5% du pic (LARGE : laisse courir vers 2-4%)
  TP_SOFT_CAP: 0.35,    // borne haute indicative +35% (securite, rarement atteinte)
  // Time-stop CONDITIONNEL (Option B) :
  //  - trade qui STAGNE (trailing jamais armé) -> fermé à 2h30 (libère le capital)
  //  - trade qui TRAVAILLE (trailing armé, +1% atteint) -> court jusqu'à 5h30 max
  // TIME-STOP révisé suite au BACKTEST (mai 2026, ~1100 trades réels) :
  //  - Le time-stop 2h30 sur trade stagnant DÉTRUISAIT la rentabilité (couper avant le
  //    retournement) -> DÉSACTIVÉ (0). Un trade stagnant est désormais géré par le seul
  //    stop-loss seul, qui suffit. Enseignement solide : ne pas couper un trade qui a
  //    besoin de temps pour revenir à la moyenne.
  //  - Laisser courir les GAGNANTS est le moteur du rendement -> time-stop working allongé
  //    à 24h (le backtest montrait "plus c'est long, mieux c'est" ; 24h borne la durée max
  //    par prudence en réel sans brider les trades productifs).
  TIME_STOP_STALE_MS: 0,          // 0 = désactivé (stagnant géré par le stop-loss seul)
  TIME_STOP_WORKING_MS: 86400000, // 24h pour un gagnant qui travaille (laisser courir)

  // --- SCALING OUT : prise de profit PARTIELLE, on laisse courir le reste ---
  SCALE_OUT: [
    { at: 0.10, frac: 0.34 }, // a +10% : ferme 34% de la position
    { at: 0.20, frac: 0.50 }, // a +20% : ferme 50% du RESTE
    // le solde court sur le trailing large (capture les +20-35% comme NFPUSDT)
  ],

  // --- Frais & execution ---
  FEE_MAKER: 0.0002, FEE_TAKER: 0.0005,
  USE_MAKER_ENTRY: true, MAKER_WAIT_MS: 7000, MAKER_OFFSET: 0.0005, // maker d'abord (fenêtre 7s)
  // Taker autorisé SEULEMENT si le prix n'a pas fui de plus de ce seuil pendant l'attente maker.
  // Au-delà, le signal mean-reversion est dégradé -> on ABANDONNE plutôt que courir en taker.
  TAKER_MAX_DRIFT: 0.003, // 0.3% d'écart max pour tolérer un fallback taker

  // --- Levier x2 -> x5 indexe sur la qualite ---
  LEV_BY_Q: [
    { q: 75, lev: 5 },
    { q: 60, lev: 4 },
    { q: 45, lev: 3 },
    { q: 0,  lev: 2 },
  ],
  LEV_MAX: 5,

  // --- Mise variable 80-280$ selon la qualite ---
  STAKE_MIN_USD: 80,
  STAKE_MAX_USD: 280,
  Q_FOR_MAX_STAKE: 80,  // Q>=80 -> mise max 280$ ; interpolation lineaire depuis 80$

  // --- Positions & risque ---
  MAX_POSITIONS_CAP: 25, // jusqu'a 25 positions simultanees
  MAX_EXPOSURE_PCT: 6.0, // exposition relevee a 600% (garde-fou)

  // --- ROTATION DE CAPITAL : fermer un mini-perdant essouffle pour un slot EXCELLENT ---
  ROTATION_ENABLED: true,
  ROTATION_MAX_LOSS: 0.005,     // trade a fermer entre 0 et -0.5%
  ROTATION_MIN_AGE_MS: 1800000, // ouvert >= 30 min
  ROTATION_STALE_PEAK: 0.005,   // n'a jamais depasse +0.5%
  ROTATION_MIN_Q: 68,           // signal candidat Q >= 68
  ROTATION_COOLDOWN_MS: 1800000,// 1 rotation/symbole/30 min
  KILL_PCT: 0.25,        // kill switch -25%
  MAX_CONSEC_LOSSES: 5,  // coupe-circuit apres 5 pertes consecutives
  COOLDOWN_AFTER_STOP_MS: 3600000, // cooldown 1h sur un symbole apres un stop

  // --- Univers dynamique : cryptos les plus volatiles ET liquides de Binance ---
  CORE_SYMBOLS: ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'DOGEUSDT'], // noyau TOUJOURS présent
  DYNAMIC_SIZE: 35,         // univers élargi (compense le filtre liquidité, garde du choix)
  UNIVERSE_REFRESH_MS: 3600000, // re-scan de l'univers toutes les heures
  UNIVERSE_MIN_VOL_USDT: 100000000, // 100M$ : élargi 150->100M (plus de candidats = plus d'opportunités) ;
                                    // la protection fine est désormais le SPREAD du carnet réel, mesure
                                    // directe du coût de liquidité, plus fiable que le volume 24h (les
                                    // pièges type SUSDT/BSB ont un spread qui les trahit avant toute mise).

  // --- Support / Résistance horizontaux (nouvelle voie d'entrée) ---
  // Détectés comme les plus hauts/bas récents où le prix a réagi (swing highs/lows).
  SR_LOOKBACK: 50,          // fenêtre de bougies 1h pour repérer les niveaux
  SR_TOUCH: 0.0046,         // "près" d'un niveau (assoupli +15% : 0.4%->0.46%)
  SR_PIVOT_STRENGTH: 2,     // un swing = plus haut/bas que N bougies de chaque côté

  // --- Points Pivot classiques (nouvelle voie d'entrée) ---
  // P = (H+L+C)/3 de la période précédente ; S1/R1/S2/R2 dérivés. Niveaux objectifs.
  PIVOT_TOUCH: 0.0046,      // "près" d'un pivot (assoupli +15% : 0.4%->0.46%)

  // (Plancher de cadence + trades de comblement SUPPRIMÉS suite au backtest :
  //  forcer des entrées dégradait le rendement, et le bridage résiduel pénalisait
  //  les meilleurs signaux — un Q80 misait 85$ x3 au lieu de 280$ x5.)

  // --- Tradabilité : ne JAMAIS miser sur un actif "bloqué" ---
  // Un actif est bloqué quand son carnet d'ordres n'a pas de contrepartie
  // exploitable : on peut parfois y ENTRER (un reste de liquidité), mais plus
  // en SORTIR (rejet -4131 PERCENT_PRICE) -> position zombie (cas BSBUSDT).
  // Le juge : le spread bid/ask du carnet réel (/fapi/v1/ticker/bookTicker).
  BOOK_MAX_SPREAD_PCT: 0.01, // spread > 1% (ou carnet vide) = actif BLOQUÉ (badge ILLIQUIDE, zéro mise)
  // Seuil de QUALITÉ D'EXÉCUTION pour ouvrir (plus strict que l'anti-bloqué) :
  // un spread de 0.3% à levier 3x = ~1% de slippage potentiel aller-retour sur la
  // mise, rédhibitoire pour viser +1-2%. Testnet plus tolérant (carnets moins denses).
  BOOK_ENTRY_SPREAD_MAINNET: 0.0015, // mainnet : spread <= 0.15% requis pour OUVRIR
  BOOK_ENTRY_SPREAD_TESTNET: 0.005,  // testnet : <= 0.5% (validation mécanique, pas d'argent réel)

  // --- PLANCHER de trades (réintroduit 02/07 sur décision Calvin — VERSION CORRIGÉE) ---
  // Objectif : de l'activité même en marché calme. Correction majeure vs l'ancienne
  // version : SEULS les trades de COMBLEMENT sont bridés ; un vrai signal sous le
  // plancher garde ses PLEINES mises (l'ancien code bridait tout, y compris les Q80).
  // Backtest mai (7 sym, pondéré mises) : +8 tr/mois, WR comblement 63%, coût -49 pts.
  // JAMAIS d'entrée au hasard : le comblement exige un signal (seuils élargis +15% add.)
  // et respecte TOUTES les protections (spread, exclusions, MIN_GAP, expo, cooldown).
  FLOOR_ENABLED: true,        // togglable à chaud (bouton dashboard)
  MIN_TRADES_PER_HOUR: 4,     // objectif d'entrées par heure glissante (tous symboles)
  CADENCE_WINDOW_MS: 3600000,
  FILLER_RELAX_ADD: 1.15,     // élargissement ADDITIONNEL des seuils, réservé au comblement
  FILLER_STAKE_MIN_USD: 65,   // mise bridée 65-85$ (vs 80-280$ normal)
  FILLER_STAKE_MAX_USD: 85,

  // --- TRADE BONUS LOTERIE (spec Calvin) : petit ticket a fort levier, 1x/heure.
  //     Mise 25-50$, levier x15, AUCUN stop-loss (la LIQUIDATION ~-1/levier de prix
  //     est le plancher naturel -> perte max = la mise). Un TP s'arme a +100% de la
  //     mise (= +1/levier de prix), PUIS un trailing large laisse courir (ferme si le
  //     gain rend 30% de son pic). Backtest mai : perdant (-65$/mois a x15) -> pari
  //     pour marches AGITES uniquement, COMPTEUR SEPARE, bouton dashboard, OFF possible.
  BONUS_ENABLED: true,
  BONUS_INTERVAL_MS: 3600000,   // 1 bonus par heure maximum
  BONUS_STAKE_MIN_USD: 25,
  BONUS_STAKE_MAX_USD: 50,
  BONUS_STAKE_PCT: 0.03,        // ~3% du capital, borne 25-50$
  BONUS_LEV: 15,                // x15 (le moins destructeur du range x12-20 au backtest)
  BONUS_TP_ARM_STAKE: 1.00,     // le trailing s'arme quand le gain atteint +100% de la mise
  BONUS_TRAIL_GIVEBACK: 0.30,   // apres armement : ferme si le gain rend 30% de son pic (laisse courir)
  FILLER_LEV: 2,              // levier fixe x2 (minimal)
  FILLER_MIN_QUALITY: 30,     // garde-fou : sous Q30, même le comblement n'entre pas

  // --- Cadence ---
  MIN_GAP_MS: 1800000,  // 30 min minimum entre 2 entrees sur le meme symbole (assoupli 1h->30min)
  SIGNAL_REFRESH_MS: 300000, // rechargement klines REST toutes les 5 min (les bougies 1h changent 1x/h ; les indicateurs réactifs sont déjà recalculés au tick) — divise le trafic REST par 5
};


// ==================================================================
// UNIVERS DYNAMIQUE — rempli au démarrage par le scan des perpétuels
// USDT les plus volatils de Binance (voir scanUniverse).
// ==================================================================
// Liste de repli si le scan échoue (majeurs + volatils connus).
const FALLBACK_SYMBOLS = ['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','DOGEUSDT','AVAXUSDT','NEARUSDT','APTUSDT','ARBUSDT','OPUSDT','INJUSDT','SEIUSDT','SUIUSDT','WIFUSDT','PEPEUSDT'];
let ALL_SYMBOLS = []; // peuplé dynamiquement

// ==================================================================
// ÉTAT GLOBAL
// ==================================================================
const state = {
  running: false,
  mode: MODE,
  capital: CAPITAL_START,
  capitalStart: CAPITAL_START,
  peakCapital: CAPITAL_START,
  maxDrawdown: 0,
  killed: false,
  sym: {},
  trades: [],
  stats: { wins: 0, losses: 0, gross: 0, fees: 0, net: 0 },
  bonusStats: { wins: 0, losses: 0, net: 0, count: 0 }, // COMPTEUR SEPARE du bonus loterie
  lastBonusAt: 0,
  log: [],
  consecLosses: 0, // pertes consécutives (coupe-circuit)
  activeSymbols: null,
  universe: [], // univers courant (pour le dashboard)
};

// Initialise (ou réinitialise) l'état d'un symbole. Idempotent.
function ensureSymbolState(s) {
  if (state.sym[s]) return;
  state.sym[s] = {
    symbol: s, price: 0, priceBuf: null, priceBufIdx: 0,
    indicators: { rsi: null, bias: 'NEUTRE', quality: null, breakdown: null },
    swing: { bb: null, rsi: null, atrPct: null, adx: null, volRatio: null, regime: null, funding: null, closedCloses: null, vwap: null, sr: null, pivot: null },
    position: null, lastEntryAt: 0, busy: false, lastStopAt: 0,
  };
}

let _logQueue = [];
let _logFlushTimer = null;
function flushLogs() {
  _logFlushTimer = null;
  if (_logQueue.length === 0) return;
  const lines = _logQueue;
  _logQueue = [];
  broadcast({ type: 'logs', lines }); // envoi groupé (une seule trame pour N lignes)
}
function logLine(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  state.log.unshift(line);
  if (state.log.length > 250) state.log.pop();
  // Groupage : au lieu d'un broadcast par ligne (rafale au démarrage), on accumule
  // et on envoie par paquets toutes les 500ms. Allège fortement le trafic WebSocket.
  _logQueue.push(line);
  if (!_logFlushTimer) _logFlushTimer = setTimeout(flushLogs, 500);
}

// ==================================================================
// SIGNATURE + REQUÊTES BINANCE
// ==================================================================
function sign(query) {
  return crypto.createHmac('sha256', API_SECRET).update(query).digest('hex');
}

async function signedRequest(method, path, params = {}) {
  const timestamp = Date.now() + Math.round(TIME_OFFSET); // horloge alignée sur Binance (anti -1021)
  const query = new URLSearchParams({ ...params, timestamp, recvWindow: 10000 }).toString();
  const signature = sign(query);
  const url = `${REST_BASE}${path}?${query}&signature=${signature}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, { method, headers: { 'X-MBX-APIKEY': API_KEY }, signal: controller.signal });
    // Le testnet renvoie parfois une page HTML d'erreur au lieu du JSON attendu
    // ("Unexpected token <") : on lit le texte brut et on parse prudemment.
    const text = await res.text();
    let data = null; try { data = JSON.parse(text); } catch (_) {}
    if (!res.ok) {
      const err = new Error(`Binance ${res.status}: ${data ? JSON.stringify(data) : ('réponse non-JSON: ' + text.slice(0, 100))}`);
      err.binanceCode = data && data.code;
      throw err;
    }
    if (data == null) throw new Error(`Binance ${res.status}: réponse non-JSON (testnet instable): ${text.slice(0, 100)}`);
    return data;
  } catch (e) {
    if (e.name === 'AbortError') {
      const err = new Error('timeout réseau (8s)');
      err.binanceCode = -1007;
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function publicGet(base, path, params = {}, retries = 2) {
  const query = new URLSearchParams(params).toString();
  const url = `${base}${path}${query ? '?' + query : ''}`;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      clearTimeout(timer);
      if (attempt === retries) throw e;
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
}

// ==================================================================
// HORLOGE BINANCE + CONNEXION CHAUDE
// ==================================================================
// Double rôle, un seul ping léger (/fapi/v1/time, poids 1, toutes les 3s) :
//  1. TIME_OFFSET : aligne les timestamps signés sur l'horloge Binance
//     (élimine les rejets -1021 si l'horloge du conteneur dérive).
//  2. KEEP-WARM : le pool de connexions du fetch Node (undici) ferme les
//     connexions inactives après ~4s ; nos requêtes critiques (ordres, stops)
//     repayaient donc un handshake TCP+TLS complet. Le ping maintient la
//     connexion établie -> les ordres partent immédiatement.
let TIME_OFFSET = 0; // serverTime - horloge locale (ms), lissé
async function syncTimeAndWarm() {
  try {
    const t0 = Date.now();
    const data = await publicGet(REST_BASE, '/fapi/v1/time', {}, 0);
    const rtt = Date.now() - t0;
    const offset = data.serverTime + rtt / 2 - Date.now();
    TIME_OFFSET = TIME_OFFSET === 0 ? offset : TIME_OFFSET * 0.8 + offset * 0.2; // lissage
  } catch (e) { /* silencieux : le prochain ping réessaie */ }
}

// ==================================================================
// PRÉCISIONS SYMBOLES
// ==================================================================
const SYMBOL_INFO = {};

async function loadSymbolInfo() {
  try {
    const info = await publicGet(REST_BASE, '/fapi/v1/exchangeInfo');
    for (const sym of info.symbols) {
      if (sym.symbol && sym.symbol.endsWith('USDT')) {
        const lot = sym.filters.find((f) => f.filterType === 'LOT_SIZE');
        // MARKET_LOT_SIZE borne la quantité d'un ordre MARKET (souvent < LOT_SIZE).
        const mlot = sym.filters.find((f) => f.filterType === 'MARKET_LOT_SIZE');
        // On prend la borne la plus restrictive entre les deux filtres.
        const maxLot = lot ? parseFloat(lot.maxQty) : Infinity;
        const maxMarket = mlot ? parseFloat(mlot.maxQty) : Infinity;
        const minLot = lot ? parseFloat(lot.minQty) : 0;
        SYMBOL_INFO[sym.symbol] = {
          qtyPrecision: sym.quantityPrecision,
          pricePrecision: sym.pricePrecision,
          stepSize: lot ? parseFloat(lot.stepSize) : 0.001,
          maxQty: Math.min(maxLot, maxMarket), // borne dure par ordre
          minQty: minLot,
        };
      }
    }
    logLine(`Précisions chargées pour ${Object.keys(SYMBOL_INFO).length} symboles`);
  } catch (e) {
    logLine(`⚠️ loadSymbolInfo: ${e.message}`);
  }
}

function roundQty(symbol, q) {
  const p = SYMBOL_INFO[symbol] ? SYMBOL_INFO[symbol].qtyPrecision : 3;
  return parseFloat(q.toFixed(p));
}
function maxQtyFor(symbol) {
  const info = SYMBOL_INFO[symbol];
  return info && isFinite(info.maxQty) ? info.maxQty : Infinity;
}
function minQtyFor(symbol) {
  const info = SYMBOL_INFO[symbol];
  return info ? info.minQty : 0;
}

// Ferme une quantité donnée en la DÉCOUPANT en plusieurs ordres MARKET reduceOnly
// si elle dépasse le maxQty autorisé par Binance (corrige le -4005). Garde-fou anti-boucle.
async function closeQtyInChunks(symbol, closeSide, totalQty) {
  const maxQ = maxQtyFor(symbol);
  let remaining = totalQty;
  let guard = 0;
  const MAX_CHUNKS = 20; // anti-boucle : jamais plus de 20 ordres
  while (remaining > 0 && guard < MAX_CHUNKS) {
    guard++;
    let chunk = isFinite(maxQ) ? Math.min(remaining, maxQ) : remaining;
    chunk = roundQty(symbol, chunk);
    if (chunk <= 0) break;
    await marketOrder(symbol, closeSide, chunk, true);
    remaining = roundQty(symbol, remaining - chunk);
  }
  if (remaining > 0) {
    logLine(`⚠️ ${symbol} : fermeture partielle (reste ${remaining} après ${guard} tranches).`);
    return false;
  }
  return true;
}
function roundPrice(symbol, price) {
  const p = SYMBOL_INFO[symbol] && SYMBOL_INFO[symbol].pricePrecision != null ? SYMBOL_INFO[symbol].pricePrecision : 4;
  return parseFloat(price.toFixed(p));
}

// ==================================================================
// INDICATEURS
function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let g = 0, l = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) g += d; else l -= d;
  }
  const ag = g / period, al = l / period;
  if (al === 0) return 100;
  return 100 - 100 / (1 + ag / al);
}
// ATR normalisé (en % du prix) sur des bougies {high,low,close} — mesure de volatilité
function atrPct(klines, period = 14) {
  if (!klines || klines.length < period + 1) return null;
  let sum = 0;
  for (let i = klines.length - period; i < klines.length; i++) {
    const h = klines[i].high, l = klines[i].low, pc = klines[i - 1].close;
    const tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    sum += tr;
  }
  const atr = sum / period;
  const lastClose = klines[klines.length - 1].close;
  return lastClose > 0 ? atr / lastClose : null;
}

function sma(values, period) {
  if (values.length < period) return null;
  return values.slice(-period).reduce((a, b) => a + b, 0) / period;
}
function bollinger(closes, period, mult) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mid = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + (b - mid) * (b - mid), 0) / period;
  const sd = Math.sqrt(variance);
  return { mid, upper: mid + mult * sd, lower: mid - mult * sd, sd };
}
function adx(klines, period = 14) {
  if (!klines || klines.length < period * 2 + 1) return null;
  const tr = [], plusDM = [], minusDM = [];
  for (let i = 1; i < klines.length; i++) {
    const h = klines[i].high, l = klines[i].low, pc = klines[i - 1].close;
    const ph = klines[i - 1].high, pl = klines[i - 1].low;
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    const up = h - ph, down = pl - l;
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
  }
  const wilder = (arr, p) => {
    let s = arr.slice(0, p).reduce((a, b) => a + b, 0);
    const out = [s];
    for (let i = p; i < arr.length; i++) { s = s - s / p + arr[i]; out.push(s); }
    return out;
  };
  const trS = wilder(tr, period), pS = wilder(plusDM, period), mS = wilder(minusDM, period);
  const dx = [];
  let lastP = 0, lastM = 0;
  for (let i = 0; i < trS.length; i++) {
    const pDI = 100 * (pS[i] / trS[i]), mDI = 100 * (mS[i] / trS[i]);
    lastP = pDI; lastM = mDI;
    const sum = pDI + mDI;
    dx.push(sum === 0 ? 0 : 100 * Math.abs(pDI - mDI) / sum);
  }
  if (dx.length < period) return null;
  let adxVal = dx.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dx.length; i++) adxVal = (adxVal * (period - 1) + dx[i]) / period;
  // Direction : +1 tendance haussière (DI+ > DI-), -1 baissière.
  const dir = lastP >= lastM ? 1 : -1;
  return { adx: adxVal, dir, plusDI: lastP, minusDI: lastM };
}
function volumeRatio(klines, period, curFraction = 1) {
  if (!klines || klines.length < period + 1) return null;
  const vols = klines.map((k) => k.vol);
  const avg = sma(vols.slice(0, -1), period);
  // BIAIS INTRA-BOUGIE corrigé : la bougie EN COURS n'a accumulé qu'une fraction de
  // son volume final (à 15 min de l'heure : ~25%). On la proratise au temps écoulé
  // ("à ce rythme, sur l'heure complète, ça donnerait combien ?") avant de comparer.
  const cur = vols[vols.length - 1] / Math.min(1, Math.max(0.1, curFraction));
  return avg && avg > 0 ? cur / avg : null;
}

// VWAP GLISSANT (rolling) sur les N dernières bougies.
// Formule standard : Σ(prix_typique × volume) / Σ(volume), prix_typique = hlc3 = (H+L+C)/3.
// Version glissante (et non "de séance") car adaptée au 24/7 crypto et à l'horizon swing :
// fournit une "valeur juste pondérée volume" continue sur une fenêtre de plusieurs heures.
// Renvoie aussi l'écart-type pondéré pour situer les déviations (bandes VWAP ±σ).
function rollingVWAP(klines, period) {
  if (!klines || klines.length < period) return null;
  const slice = klines.slice(-period);
  // Une seule passe : accumule Σ(pv), Σ(v), Σ(p²v) -> VWAP et écart-type pondéré.
  // Var = Σ(p²v)/Σv - VWAP²  (identité mathématique, résultat identique à la double passe).
  let sumPV = 0, sumV = 0, sumP2V = 0;
  for (const k of slice) {
    const typical = (k.high + k.low + k.close) / 3;
    const pv = typical * k.vol;
    sumPV += pv;
    sumV += k.vol;
    sumP2V += typical * pv;
  }
  if (sumV <= 0) return null;
  const vwap = sumPV / sumV;
  const variance = Math.max(0, sumP2V / sumV - vwap * vwap); // max(0,...) pour la robustesse numérique
  return { vwap, sd: Math.sqrt(variance) };
}

// SUPPORT / RÉSISTANCE horizontaux : repère les swing highs (résistances) et swing lows
// (supports) sur la fenêtre. Un swing = un sommet/creux local plus extrême que N bougies
// de chaque côté. Renvoie les niveaux les plus proches du prix courant (au-dessus/dessous).
function supportResistance(klines, price) {
  const n = STRAT.SR_LOOKBACK, k = STRAT.SR_PIVOT_STRENGTH;
  if (!klines || klines.length < n) return null;
  const slice = klines.slice(-n);
  const resistances = [], supports = [];
  for (let i = k; i < slice.length - k; i++) {
    let isHigh = true, isLow = true;
    for (let j = 1; j <= k; j++) {
      if (slice[i].high <= slice[i - j].high || slice[i].high <= slice[i + j].high) isHigh = false;
      if (slice[i].low >= slice[i - j].low || slice[i].low >= slice[i + j].low) isLow = false;
    }
    if (isHigh) resistances.push(slice[i].high);
    if (isLow) supports.push(slice[i].low);
  }
  // Niveau de support le plus proche SOUS le prix, résistance la plus proche AU-DESSUS
  const support = supports.filter((s) => s < price).sort((a, b) => b - a)[0] || null;
  const resistance = resistances.filter((r) => r > price).sort((a, b) => a - b)[0] || null;
  return { support, resistance };
}

// POINTS PIVOT classiques : calculés sur la DERNIÈRE bougie de confirmation (période précédente).
// P = (H+L+C)/3 ; R1 = 2P-L ; S1 = 2P-H ; R2 = P+(H-L) ; S2 = P-(H-L). Niveaux objectifs
// largement suivis par les traders -> zones de réaction fréquentes.
function pivotPoints(prevCandle) {
  if (!prevCandle) return null;
  const H = prevCandle.high, L = prevCandle.low, C = prevCandle.close;
  const P = (H + L + C) / 3;
  return {
    P,
    R1: 2 * P - L, S1: 2 * P - H,
    R2: P + (H - L), S2: P - (H - L),
  };
}

// ==================================================================
// UNIVERS DYNAMIQUE : scan des perpétuels USDT les plus VOLATILS
// via /fapi/v1/ticker/24hr. Classe par amplitude (high-low)/low sur 24h,
// filtré par volume 24h minimum (liquidité). Renvoie noyau fixe + DYNAMIC_SIZE volatils.
// ==================================================================
async function scanUniverse() {
  try {
    const tickers = await publicGet(REST_BASE, '/fapi/v1/ticker/24hr');
    if (!Array.isArray(tickers)) throw new Error('réponse inattendue');
    const core = STRAT.CORE_SYMBOLS;
    const scored = tickers
      .filter((t) => t.symbol && t.symbol.endsWith('USDT'))
      .filter((t) => !/(UPUSDT|DOWNUSDT|BULLUSDT|BEARUSDT)$/.test(t.symbol))
      .filter((t) => !core.includes(t.symbol))
      .map((t) => {
        const high = parseFloat(t.highPrice), low = parseFloat(t.lowPrice);
        const quoteVol = parseFloat(t.quoteVolume);
        const amplitude = low > 0 ? (high - low) / low : 0;
        return { symbol: t.symbol, amplitude, quoteVol };
      })
      .filter((t) => t.quoteVol >= STRAT.UNIVERSE_MIN_VOL_USDT)
      .sort((a, b) => b.amplitude - a.amplitude);
    const volatile = scored.slice(0, STRAT.DYNAMIC_SIZE).map((t) => t.symbol);
    const top = [...core, ...volatile];
    if (top.length === 0) throw new Error('aucun symbole après filtres');
    for (const s of Object.keys(state.sym)) {
      if (state.sym[s].position && !top.includes(s)) top.push(s);
    }
    return top;
  } catch (e) {
    logLine(`⚠️ scanUniverse: ${e.message} — repli sur noyau + statique`);
    return [...STRAT.CORE_SYMBOLS, ...FALLBACK_SYMBOLS.filter((s) => !STRAT.CORE_SYMBOLS.includes(s))];
  }
}

// Funding rate courant d'un symbole (dernier point). Signe : + = longs paient shorts.
async function fetchFunding(symbol) {
  try {
    const data = await publicGet(REST_BASE, '/fapi/v1/fundingRate', { symbol, limit: 1 });
    if (Array.isArray(data) && data.length) return parseFloat(data[0].fundingRate);
  } catch (e) { /* ignore */ }
  return null;
}

// ==================================================================
// LECTURE DES 50 DERNIÈRES BOUGIES + ANALYSE MTF PAR SYMBOLE
// ==================================================================
async function refreshKlines(symbol) {
  const S = state.sym[symbol];
  if (!S) return;
  try {
    // Bougies 1h (analyse principale)
    const raw1h = await publicGet(KLINE_BASE, '/fapi/v1/klines', {
      symbol, interval: STRAT.TF_MAIN, limit: STRAT.KLINE_LIMIT,
    });
    const kl = raw1h.map((c) => ({ time: c[0], open: +c[1], high: +c[2], low: +c[3], close: +c[4], vol: +c[5] }));
    const closes = kl.map((c) => c.close);
    // Closes des bougies FERMÉES (hors dernière en formation) pour le recalcul live sur tick.
    S.swing.closedCloses = closes.slice(0, -1);
    // Queue bornee pour le recalcul live au tick : bollinger(BB_PERIOD) lit les
    // (BB_PERIOD-1) dernieres closes fermees + le prix courant ; rsi(RSI_PERIOD)
    // en lit encore moins. Memes fenetres, memes valeurs — on evite simplement de
    // copier ~100 closes a chaque tick x40 symboles dans refreshLiveIndicators.
    S.swing.liveTail = S.swing.closedCloses.slice(-(Math.max(STRAT.BB_PERIOD, STRAT.RSI_PERIOD + 1) - 1));

    S.swing.bb = bollinger(closes, STRAT.BB_PERIOD, STRAT.BB_STDDEV);
    S.swing.rsi = rsi(closes, STRAT.RSI_PERIOD);
    S.swing.atrPct = atrPct(kl, STRAT.ATR_PERIOD);
    const candleFrac = kl.length ? (Date.now() - kl[kl.length - 1].time) / 3600000 : 1; // fraction écoulée de la bougie 1h en cours
    S.swing.volRatio = volumeRatio(kl, STRAT.ATR_PERIOD, candleFrac);
    S.swing.sr = supportResistance(kl, kl[kl.length - 1].close); // support/résistance horizontaux
    S.swing.vwap = rollingVWAP(kl, STRAT.VWAP_PERIOD); // VWAP glissant (valeur juste pondérée volume)
    S.indicators.rsi = S.swing.rsi;

    // Bougies 2h (confirmation de régime via ADX)
    const raw2h = await publicGet(KLINE_BASE, '/fapi/v1/klines', {
      symbol, interval: STRAT.TF_CONFIRM, limit: STRAT.CONFIRM_LIMIT,
    });
    const kl2 = raw2h.map((c) => ({ time: c[0], high: +c[2], low: +c[3], close: +c[4], vol: +c[5] }));
    // Points pivot : sur la dernière bougie 2h FERMÉE (avant-dernière du tableau).
    S.swing.pivot = pivotPoints(kl2.length >= 2 ? kl2[kl2.length - 2] : null);
    const adxObj = adx(kl2, STRAT.ADX_PERIOD);
    S.swing.adx = adxObj ? adxObj.adx : null;
    S.swing.adxDir = adxObj ? adxObj.dir : 0; // +1 haussier, -1 baissier
    // Régime à 3 états (jamais de pause) :
    //  RANGE (ADX bas) -> mean-reversion 2 sens
    //  UP  (ADX haut + DI+>DI-) -> tendance haussière : on ne prend que des LONG
    //  DOWN(ADX haut + DI->DI+) -> tendance baissière : on ne prend que des SHORT
    if (S.swing.adx == null) S.swing.regime = null;
    else if (S.swing.adx < STRAT.ADX_RANGE_MAX) S.swing.regime = 'RANGE';
    else S.swing.regime = S.swing.adxDir > 0 ? 'UP' : 'DOWN';

    // Funding rate (signal de retournement, filtre souple).
    // Rafraîchi toutes les ~2.5 min seulement : le funding évolue très lentement
    // (Binance le calcule sur 8h), donc l'appeler chaque minute était du gaspillage réseau.
    // Impact décisionnel nul en pratique — la valeur reste fraîche à l'échelle du funding.
    const nowF = Date.now();
    if (S.swing.funding == null || !S._fundingAt || nowF - S._fundingAt > 150000) {
      S.swing.funding = await fetchFunding(symbol);
      S._fundingAt = nowF;
    }

    // Biais affiché
    if (S.swing.bb && S.price > 0) {
      if (S.price <= S.swing.bb.lower) S.indicators.bias = 'LONG';
      else if (S.price >= S.swing.bb.upper) S.indicators.bias = 'SHORT';
      else S.indicators.bias = 'NEUTRE';
    }
  } catch (e) { /* on garde l'ancien */ }
}

// ==================================================================
// SCORING (qualité du signal 0-100 : module la mise et le levier)
// ==================================================================
// Recalcule Bollinger + RSI EN DIRECT avec le prix live comme close de la bougie 1h en cours.
// Rend les bandes/RSI réactifs à la seconde (au lieu d'attendre le refresh 60s). Throttle ~1s.
function refreshLiveIndicators(S) {
  const cc = S.swing.closedCloses;
  if (!cc || cc.length < STRAT.BB_PERIOD || S.price <= 0) return;
  const now = Date.now();
  if (S._liveAt && now - S._liveAt < 1000) return; // throttle 1s
  S._liveAt = now;
  const live = (S.swing.liveTail || cc).concat(S.price); // fenetre bornee : memes valeurs lues par bollinger/rsi, ~5x moins de copies
  const bb = bollinger(live, STRAT.BB_PERIOD, STRAT.BB_STDDEV);
  if (bb) S.swing.bb = bb;
  const r = rsi(live, STRAT.RSI_PERIOD);
  if (r != null) { S.swing.rsi = r; S.indicators.rsi = r; }
}

function computeSignal(symbol, relaxAdd) {
  // relaxAdd > 1 = mode COMBLEMENT : seuils d'entrée élargis (le RÉGIME reste inchangé).
  const RX = relaxAdd || 1;
  const T_OS = STRAT.RSI_OVERSOLD + (50 - STRAT.RSI_OVERSOLD) * (RX - 1);
  const T_OB = STRAT.RSI_OVERBOUGHT - (STRAT.RSI_OVERBOUGHT - 50) * (RX - 1);
  const T_VWT = STRAT.VWAP_TOUCH * RX, T_SRT = STRAT.SR_TOUCH * RX, T_PVT = STRAT.PIVOT_TOUCH * RX;
  const T_DEVB = STRAT.VWAP_DEV_BAND / RX;
  const S = state.sym[symbol];
  const sw = S.swing;
  const px = S.price;
  if (!sw.bb || sw.rsi == null || sw.atrPct == null || px <= 0 || !sw.regime) return null;

  // Volatilité minimale (assez de mouvement pour viser 1-4%)
  if (sw.atrPct < STRAT.ATR_FLOOR_1H) { S.indicators.quality = null; return null; }
  if (STRAT.VOL_CONFIRM && sw.volRatio != null && sw.volRatio < 1.0) { S.indicators.quality = null; return null; }

  const belowLower = px <= sw.bb.lower, aboveUpper = px >= sw.bb.upper;
  const belowMid = px < sw.bb.mid, aboveMid = px > sw.bb.mid;
  const rsiLow = sw.rsi <= T_OS, rsiHigh = sw.rsi >= T_OB;

  let side = null;
  let mode = sw.regime;

  // ================= LOGIQUE MULTI-RÉGIME (jamais de pause) =================
  if (sw.regime === 'RANGE') {
    // Mean-reversion : fade les extrêmes (base stricte).
    if (belowLower && rsiLow) side = 'BUY';
    else if (aboveUpper && rsiHigh) side = 'SELL';
    // Assouplissement (togglable) : RSI TRÈS extrême suffit, même sans toucher la bande.
    else if (STRAT.RELAX_RANGE_ENTRY) {
      if (sw.rsi <= STRAT.RSI_EXTREME_LOW && belowMid) side = 'BUY';
      else if (sw.rsi >= STRAT.RSI_EXTREME_HIGH && aboveMid) side = 'SELL';
    }
  } else if (sw.regime === 'UP') {
    // Tendance HAUSSIÈRE : on ne prend QUE des LONG, sur repli (buy the dip).
    // Entrée quand le prix corrige vers/sous la médiane sans être en survente extrême,
    // et que le RSI se redresse (>= oversold). On suit la tendance, on ne la contrarie pas.
    if (belowMid && sw.rsi <= 50 && sw.rsi >= T_OS) side = 'BUY';
  } else if (sw.regime === 'DOWN') {
    // Tendance BAISSIÈRE : on ne prend QUE des SHORT, sur rebond (sell the rally).
    // C'est le régime qui fait gagner les shorts en marché baissier (cf. positions réelles).
    if (aboveMid && sw.rsi >= 50 && sw.rsi <= T_OB) side = 'SELL';
  }

  // ============= SECONDE VOIE D'ENTRÉE : VWAP (si Bollinger n'a rien donné) =============
  // Le VWAP capte des retours à la "valeur juste pondérée volume" que Bollinger rate.
  // Même philosophie multi-régime, mêmes sorties -> augmente la fréquence sans dégrader.
  let via = side ? 'BB' : null;
  if (!side && sw.vwap) {
    const v = sw.vwap.vwap, sd = sw.vwap.sd || 1;
    const distToVwap = Math.abs(px - v) / v;
    const nearVwap = distToVwap <= T_VWT;         // prix "touche" le VWAP
    const dev = (px - v) / sd;                               // déviation en σ pondérés
    if (sw.regime === 'UP') {
      // Repli vers le VWAP en tendance haussière -> LONG (buy the dip sur la valeur juste)
      if (px <= v && nearVwap && sw.rsi >= T_OS && sw.rsi <= 55) { side = 'BUY'; via = 'VWAP'; }
    } else if (sw.regime === 'DOWN') {
      // Rebond vers le VWAP en tendance baissière -> SHORT (sell the rally sur la valeur juste)
      if (px >= v && nearVwap && sw.rsi <= T_OB && sw.rsi >= 45) { side = 'SELL'; via = 'VWAP'; }
    } else if (sw.regime === 'RANGE') {
      // Fade d'une déviation extrême qui doit revenir vers le VWAP (mean-reversion sur la valeur juste)
      if (dev <= -T_DEVB && sw.rsi <= 50) { side = 'BUY'; via = 'VWAP'; }
      else if (dev >= T_DEVB && sw.rsi >= 50) { side = 'SELL'; via = 'VWAP'; }
    }
  }

  // ============= 3e VOIE : SUPPORT / RÉSISTANCE horizontaux =============
  // Rebond sur support (achat) ou rejet sous résistance (vente) — niveaux où le prix a
  // historiquement réagi. Cohérent multi-régime : on ne contrarie pas la tendance.
  if (!side && sw.sr) {
    const { support, resistance } = sw.sr;
    const nearSup = support && Math.abs(px - support) / px <= T_SRT;
    const nearRes = resistance && Math.abs(px - resistance) / px <= T_SRT;
    if (sw.regime !== 'DOWN' && nearSup && sw.rsi <= 55) { side = 'BUY'; via = 'S/R'; }       // achat sur support (sauf tendance baissière)
    else if (sw.regime !== 'UP' && nearRes && sw.rsi >= 45) { side = 'SELL'; via = 'S/R'; }   // vente sur résistance (sauf tendance haussière)
  }

  // ============= 4e VOIE : POINTS PIVOT classiques =============
  // Rebond sur un support pivot (S1/S2) -> LONG ; rejet sur une résistance pivot (R1/R2) -> SHORT.
  // Niveaux objectifs très suivis -> zones de réaction fréquentes.
  if (!side && sw.pivot) {
    const pv = sw.pivot;
    const near = (lvl) => lvl && Math.abs(px - lvl) / px <= T_PVT;
    if (sw.regime !== 'DOWN' && (near(pv.S1) || near(pv.S2)) && sw.rsi <= 55) { side = 'BUY'; via = 'PIVOT'; }
    else if (sw.regime !== 'UP' && (near(pv.R1) || near(pv.R2)) && sw.rsi >= 45) { side = 'SELL'; via = 'PIVOT'; }
  }
  if (!side) { S.indicators.quality = null; return null; }

  // --- Score de qualité (0-100) ---
  const dist = side === 'BUY' ? (sw.bb.mid - px) / (sw.bb.sd || 1) : (px - sw.bb.mid) / (sw.bb.sd || 1);
  const distScore = Math.min(35, Math.max(0, Math.abs(dist) * 17));
  let rsiScore;
  if (mode === 'RANGE') {
    rsiScore = side === 'BUY'
      ? Math.min(30, (T_OS - sw.rsi + 5) * 2)
      : Math.min(30, (sw.rsi - T_OB + 5) * 2);
  } else {
    // En tendance, un RSI proche de 50 (momentum sain) vaut mieux qu'un extrême.
    rsiScore = 30 - Math.min(30, Math.abs(sw.rsi - 50));
  }
  const volScore = sw.volRatio != null ? Math.min(20, (sw.volRatio - 1) * 20) : 10;

  // Bonus d'alignement tendance : en UP/DOWN, trader dans le sens du marché est un +.
  const trendBonus = (mode === 'UP' && side === 'BUY') || (mode === 'DOWN' && side === 'SELL') ? 10 : 0;

  // --- Filtre FUNDING souple ---
  let fundingScore = 0;
  if (STRAT.FUNDING_SOFT && sw.funding != null) {
    const f = sw.funding;
    if (Math.abs(f) >= STRAT.FUNDING_EXTREME) {
      const favorsShort = f > 0;
      if ((side === 'SELL' && favorsShort) || (side === 'BUY' && !favorsShort)) fundingScore = STRAT.FUNDING_WEIGHT;
      else fundingScore = -STRAT.FUNDING_WEIGHT;
    }
  }

  const quality = Math.round(Math.max(0, distScore + Math.max(0, rsiScore) + Math.max(0, volScore) + trendBonus + fundingScore));
  S.indicators.quality = quality;
  S.indicators.bias = side === 'BUY' ? 'LONG' : 'SHORT';
  S.indicators.breakdown = { mode, via, dist: Math.round(distScore), rsi: Math.round(Math.max(0, rsiScore)), vol: Math.round(Math.max(0, volScore)), trend: trendBonus, funding: Math.round(fundingScore) };

  return { side, quality, midBand: sw.bb.mid, symbol, mode, via };
}


// Calcule les niveaux SL/TP en % selon l'ATR du symbole (volatilité réelle).
// Si l'ATR est indisponible ou USE_ATR_EXITS=false, on retombe sur SL_PCT/TP_PCT fixes.
// Le TP ATR est borné [ATR_TP_FLOOR, ATR_TP_CAP] pour rester atteignable ET sûr.
function computeExits(symbol) {
  // Swing : SL fixe (STRAT.SL_PCT). Le TP est géré par le trailing large (pas de plafond dur).
  return { slPct: STRAT.SL_PCT, tpPct: STRAT.TP_SOFT_CAP, source: 'swing' };
}

// Levier progressif 2x -> 7x selon Q (premier palier atteint).
// Mise exceptionnelle -> toujours le levier max (la conviction du timing la valide).
function levForQuality(quality) {
  for (const tier of STRAT.LEV_BY_Q) if (quality >= tier.q) return tier.lev;
  return STRAT.LEV_BY_Q[STRAT.LEV_BY_Q.length - 1].lev;
}

// Compte les OUVERTURES (tous symboles) de la dernière heure glissante.
function tradesLastHour() {
  const ts = state.openTimestamps;
  if (!ts) return 0;
  const cut = Date.now() - STRAT.CADENCE_WINDOW_MS;
  // Purge EN PLACE par l'avant (timestamps croissants par construction : push a
  // l'ouverture) : meme resultat que l'ancien filter(), zero tableau alloue.
  while (ts.length && ts[0] < cut) ts.shift();
  return ts.length;
}

// Décide mise + levier, proportionnels à la qualité du signal (pleines mises :
// le bridage "comblement" a été supprimé, il pénalisait les meilleurs signaux).
function sizing(signal) {
  if (signal.bonus) {
    // BONUS LOTERIE : mise petite (25-50$), levier x15.
    const s = Math.max(STRAT.BONUS_STAKE_MIN_USD, Math.min(STRAT.BONUS_STAKE_MAX_USD, state.capital * STRAT.BONUS_STAKE_PCT));
    return { stake: Math.round(s), lev: STRAT.BONUS_LEV };
  }
  const q = Math.max(0, Math.min(STRAT.Q_FOR_MAX_STAKE, signal.quality));
  const frac = q / STRAT.Q_FOR_MAX_STAKE;
  if (signal.filler) {
    // COMBLEMENT : mise bridée 65-85$ + levier x2 fixe. Un signal NORMAL, même sous
    // le plancher, garde ses pleines mises (correction du défaut de l'ancienne version).
    const stake = STRAT.FILLER_STAKE_MIN_USD + frac * (STRAT.FILLER_STAKE_MAX_USD - STRAT.FILLER_STAKE_MIN_USD);
    return { stake: Math.round(stake), lev: STRAT.FILLER_LEV };
  }
  const stake = STRAT.STAKE_MIN_USD + frac * (STRAT.STAKE_MAX_USD - STRAT.STAKE_MIN_USD);
  const lev = levForQuality(signal.quality);
  return { stake: Math.round(stake), lev };
}

function currentExposure() {
  let total = 0;
  for (const s of ALL_SYMBOLS) if (state.sym[s].position) total += state.sym[s].position.stake;
  return total;
}
function openPositionsCount() {
  return ALL_SYMBOLS.filter((s) => state.sym[s].position).length;
}

// ==================================================================
// ORDRES
// ==================================================================
async function setLeverage(symbol, lev) {
  const S = state.sym[symbol];
  if (S && S._levSet === lev) return; // levier déjà posé pour ce symbole -> zéro appel réseau (entrée ~100ms plus rapide)
  try { await signedRequest('POST', '/fapi/v1/leverage', { symbol, leverage: lev }); if (S) S._levSet = lev; }
  catch (e) { /* non bloquant */ }
}
async function marketOrder(symbol, side, qty, reduceOnly = false) {
  const params = { symbol, side, type: 'MARKET', quantity: qty };
  if (reduceOnly) params.reduceOnly = 'true';
  return signedRequest('POST', '/fapi/v1/order', params);
}

// Ordre LIMITE post-only (maker) : ne s'exécute QUE comme maker (frais réduits).
// Si le prix devait le rendre taker, Binance le rejette (timeInForce GTX = post-only).
async function limitMakerOrder(symbol, side, qty, price) {
  const p = roundPrice(symbol, price);
  const params = { symbol, side, type: 'LIMIT', quantity: qty, price: p, timeInForce: 'GTX' };
  return signedRequest('POST', '/fapi/v1/order', params);
}
async function cancelOrder(symbol, orderId) {
  try { return await signedRequest('DELETE', '/fapi/v1/order', { symbol, orderId }); }
  catch (e) { return null; }
}
async function getOrder(symbol, orderId) {
  try { return await signedRequest('GET', '/fapi/v1/order', { symbol, orderId }); }
  catch (e) { return null; }
}

// Entrée maker-first : tente un post-only (frais maker), et si pas exécuté en
// MAKER_WAIT_MS, on annule et on passe en market (taker). Renvoie 'maker'|'taker'|null.
async function openWithMaker(symbol, side, qty, refPrice) {
  if (!STRAT.USE_MAKER_ENTRY) {
    await marketOrder(symbol, side, qty);
    return 'taker';
  }
  const offset = STRAT.MAKER_OFFSET;
  const limitPx = side === 'BUY' ? refPrice * (1 - offset) : refPrice * (1 + offset);

  // Décide si un fallback TAKER est justifié : seulement si le prix n'a pas trop fui
  // (au-delà de TAKER_MAX_DRIFT, le signal est dégradé -> on abandonne).
  // Un taker "défavorable" (prix parti dans le sens du trade) coûte ; un taker "favorable"
  // (prix revenu vers nous) est même une aubaine. On mesure la dérive DÉFAVORABLE.
  const takerStillWorth = () => {
    const S = state.sym[symbol];
    const now = S ? S.price : refPrice;
    if (now <= 0) return false;
    // dérive défavorable = le prix est monté pour un BUY, ou descendu pour un SELL
    const drift = side === 'BUY' ? (now - refPrice) / refPrice : (refPrice - now) / refPrice;
    return drift <= STRAT.TAKER_MAX_DRIFT; // au-delà, on n'y va pas
  };

  let order;
  try {
    order = await limitMakerOrder(symbol, side, qty, limitPx);
  } catch (e) {
    // post-only rejeté : le marché voulait déjà nous rendre taker.
    if (takerStillWorth()) { await marketOrder(symbol, side, qty); return 'taker'; }
    logLine(`⏭️ ${symbol} : maker rejeté et prix parti (>${(STRAT.TAKER_MAX_DRIFT*100).toFixed(1)}%) — trade abandonné.`);
    return null;
  }
  const orderId = order && order.orderId;
  if (!orderId) {
    if (takerStillWorth()) { await marketOrder(symbol, side, qty); return 'taker'; }
    return null;
  }

  // Attendre l'exécution du post-only
  await new Promise((r) => setTimeout(r, STRAT.MAKER_WAIT_MS));
  const st = await getOrder(symbol, orderId);
  if (st && st.status === 'FILLED') return 'maker';

  // Pas (entièrement) rempli -> on annule
  await cancelOrder(symbol, orderId);
  const partial = st && parseFloat(st.executedQty || 0) > 0;
  if (partial) {
    // Une partie est passée en maker : on complète le reste en taker seulement si ça vaut le coup.
    const remaining = roundQty(symbol, qty - parseFloat(st.executedQty));
    if (remaining > 0 && takerStillWorth()) await marketOrder(symbol, side, remaining);
    return 'maker'; // majorité en maker
  }
  // Rien passé : taker seulement si le prix n'a pas fui, sinon on abandonne.
  if (takerStillWorth()) { await marketOrder(symbol, side, qty); return 'taker'; }
  logLine(`⏭️ ${symbol} : maker non rempli et prix parti — trade abandonné (pas de taker défavorable).`);
  return null;
}
async function fetchPosition(symbol) {
  try {
    const data = await signedRequest('GET', '/fapi/v2/positionRisk', { symbol });
    const pos = Array.isArray(data) ? data.find((x) => x.symbol === symbol) : null;
    if (!pos) return null;
    const amt = parseFloat(pos.positionAmt);
    const step = SYMBOL_INFO[symbol] ? SYMBOL_INFO[symbol].stepSize : 0.001;
    if (Math.abs(amt) < step) return null;
    return { side: amt > 0 ? 'BUY' : 'SELL', qty: Math.abs(amt), entry: parseFloat(pos.entryPrice) };
  } catch (e) { return null; }
}

// ==================================================================
// OUVERTURE / FERMETURE
// ==================================================================
// Cherche un trade essoufflé à fermer pour libérer un slot vers un signal excellent.
function findRotationCandidate(exclude) {
  const now = Date.now();
  let worst = null, worstPnl = Infinity;
  for (const s of Object.keys(state.sym)) {
    if (s === exclude) continue;
    const S = state.sym[s];
    const pos = S.position;
    if (!pos || pos.closingManual || pos.adopted) continue;
    if (S.lastRotationAt && now - S.lastRotationAt < STRAT.ROTATION_COOLDOWN_MS) continue;
    const px = S.price;
    if (px <= 0) continue;
    const dir = pos.side === 'BUY' ? 1 : -1;
    const pnlPct = ((px - pos.entry) / pos.entry) * dir;
    const age = now - (pos.openedAt || now);
    const peak = pos.peakPnl != null ? pos.peakPnl : 0;
    const miniLoss = pnlPct <= 0 && pnlPct >= -STRAT.ROTATION_MAX_LOSS;
    const oldEnough = age >= STRAT.ROTATION_MIN_AGE_MS;
    const staled = peak < STRAT.ROTATION_STALE_PEAK;
    if (miniLoss && oldEnough && staled && pnlPct < worstPnl) { worstPnl = pnlPct; worst = s; }
  }
  return worst;
}

async function tryOpen(symbol, signal) {
  const S = state.sym[symbol];
  const now = Date.now();
  if (!S || S.position || S.disabled) return;
  // ACTIF BLOQUÉ : carnet sans contrepartie exploitable -> on ne mise pas sur un
  // symbole dont on ne pourrait pas SORTIR (le prix indexé continue d'exister et de
  // générer des signaux même quand le carnet est mort — seul le spread dit la vérité).
  if (S.book && S.book.spreadPct > STRAT.BOOK_MAX_SPREAD_PCT) return;
  // Qualité d'exécution : spread d'entrée maximal (mainnet strict, testnet tolérant).
  const entrySpreadMax = MODE === 'mainnet' ? STRAT.BOOK_ENTRY_SPREAD_MAINNET : STRAT.BOOK_ENTRY_SPREAD_TESTNET;
  if (S.book && S.book.spreadPct > entrySpreadMax) return;
  if (state.activeSymbols && !state.activeSymbols.includes(symbol)) return;
  if (now - S.lastEntryAt < STRAT.MIN_GAP_MS) return;
  // Cooldown après un stop sur ce symbole
  if (S.lastStopAt && now - S.lastStopAt < STRAT.COOLDOWN_AFTER_STOP_MS) return;

  const { stake, lev } = sizing(signal);
  if (openPositionsCount() >= STRAT.MAX_POSITIONS_CAP) {
    if (STRAT.ROTATION_ENABLED && signal.quality >= STRAT.ROTATION_MIN_Q) {
      const victim = findRotationCandidate(symbol);
      if (victim) {
        logLine(`🔁 ROTATION : fermeture ${victim} (essoufflé) pour libérer un slot -> ${symbol} Q${signal.quality}.`);
        state.sym[victim].lastRotationAt = Date.now();
        await closePos(victim, 'ROTATION');
      } else { return; }
    } else { return; }
  }
  if (currentExposure() + stake > state.capital * STRAT.MAX_EXPOSURE_PCT) return;

  let qty = roundQty(symbol, (stake * lev) / S.price);
  if (qty <= 0) return;
  // Garde-fou -4005 : si la quantité dépasse le max autorisé par ordre, on plafonne.
  // Si même le max autorisé représente une part dérisoire de la mise voulue, on skip
  // (token trop bon marché pour notre taille : source de trades ingérables).
  const maxQ = maxQtyFor(symbol);
  if (isFinite(maxQ) && qty > maxQ) {
    const coverage = (maxQ * S.price) / (stake * lev); // fraction de la mise réellement plaçable
    if (coverage < 0.5) {
      logLine(`⏭️ ${symbol} @ ${S.price} : quantité voulue ${qty} > max ${maxQ} (couvre ${(coverage*100).toFixed(0)}%) — skip (token trop bon marché pour la mise).`);
      return;
    }
    qty = roundQty(symbol, maxQ); // sinon on plafonne au max plaçable
  }
  if (qty < minQtyFor(symbol)) return;

  // GARDE-FOU D'EXÉCUTION : vérifier que le carnet d'ordres de CE mode (testnet ou
  // mainnet) a une vraie contrepartie. Le filtre 150M$ mesure le volume MAINNET ;
  // sur testnet, certains carnets sont VIDES -> ordres market rejetés (-4131),
  // positions infermables. Règle : on n'ouvre pas ce qu'on ne peut pas fermer.
  try {
    const bt = await publicGet(REST_BASE, '/fapi/v1/ticker/bookTicker', { symbol });
    const bid = parseFloat(bt.bidPrice), ask = parseFloat(bt.askPrice);
    const spread = (bid > 0 && ask > 0) ? (ask - bid) / ((ask + bid) / 2) : Infinity;
    if (!(bid > 0) || !(ask > 0) || spread > 0.01) {
      S.disabled = true;
      logLine(`🚫 ${symbol} exclu : carnet ${MODE} sans contrepartie exploitable (bid=${bt.bidPrice||'-'} ask=${bt.askPrice||'-'}, spread ${isFinite(spread)?(spread*100).toFixed(2)+'%':'∞'}) — position serait infermable.`);
      return;
    }
  } catch (e) { return; } // carnet illisible -> on n'ouvre pas, on retentera au prochain signal

  await setLeverage(symbol, lev);

  let entryFill = 'taker';
  try {
    entryFill = await openWithMaker(symbol, signal.side, qty, S.price);
  } catch (e0) {
    // 5xx passerelle (502/503/504) = panne TRANSITOIRE côté Binance (quelques secondes) :
    // une re-tentative unique à 2.5s récupère l'opportunité au lieu de perdre 30 min.
    let e = e0;
    if (/\b50[234]\b/.test(e0.message || '')) {
      await new Promise((r) => setTimeout(r, 2500));
      try {
        entryFill = await openWithMaker(symbol, signal.side, qty, S.price);
        logLine(`🔁 ${symbol} : passerelle Binance rétablie, ouverture réussie au 2e essai.`);
        e = null;
      } catch (e1) { e = e1; }
    }
    if (e) {
    // -4411 : contrat "TradFi Perps" (perp sur actif traditionnel : action, métal, indice)
    // exigeant la signature d'un accord Binance dédié -> EXCLUSION définitive du symbole
    // (session) : sans l'accord, TOUT ordre sera rejeté ; réessayer serait du spam d'API.
    // -1121 : symbole invalide -> même traitement.
    if (e.binanceCode === -4411 || e.binanceCode === -1121 || e.binanceCode === -4131) { // -4131 : carnet mort dès l'entrée
      S.disabled = true;
      logLine(`🚫 ${symbol} EXCLU définitivement : contrat non tradable sur ce compte (code ${e.binanceCode} — accord Binance non signé ou symbole restreint).`);
      return;
    }
    // Erreur transitoire : cooldown MIN_GAP (30 min) pour ne PAS re-tenter à chaque tick.
    S.lastEntryAt = now;
    logLine(`❌ ${symbol} ouverture: ${e.message} — nouvel essai dans ${Math.round(STRAT.MIN_GAP_MS/60000)} min.`);
    return;
    }
  }
  if (!entryFill) return;

  const entry = S.price;
  const exits = computeExits(symbol);
  S.position = {
    side: signal.side, entry, qty, stake, lev, quality: signal.quality,
    entryFill, slPct: exits.slPct, tpPct: exits.tpPct,
    sl: signal.side === 'BUY' ? entry * (1 - exits.slPct) : entry * (1 + exits.slPct),
    tp: signal.side === 'BUY' ? entry * (1 + exits.tpPct) : entry * (1 - exits.tpPct),
    openedAt: now, peakPnl: 0, scaleDone: [],
  };
  S.lastEntryAt = now;
  if (!state.openTimestamps) state.openTimestamps = [];
  state.openTimestamps.push(now); // compteur du plancher (heure glissante, tous symboles)
  if (signal.bonus) { S.position.bonus = true; state.lastBonusAt = now; }
  const f = S.swing.funding != null ? ` funding=${(S.swing.funding*100).toFixed(3)}%` : '';
  const fTag = signal.filler ? ' [comblement]' : '';
  logLine(`🟢 ${symbol} ${signal.side} qty=${qty} @ ${entry.toFixed(4)} x${lev} Q=${signal.quality} via=${signal.via || 'BB'} SL-${(exits.slPct*100).toFixed(1)}%${f} [${entryFill}]${fTag}`);
  // Poser le SL + TP natifs sur Binance (protection 24/7) — SAUF le bonus loterie,
  // qui n'a PAS de SL (spec Calvin) : la liquidation Binance est son plancher.
  if (!signal.bonus) await placeExchangeStops(symbol);
  broadcast({ type: 'positions', positions: livePositions() });
}

async function closePos(symbol, reason, qtyToClose = null) {
  const S = state.sym[symbol];
  const pos = S.position;
  if (!pos) return;
  // Backoff après un rejet -4131 (carnet testnet vide) : inutile de marteler le
  // market, un LIMIT reduceOnly a été posé ; on retente le market au plus 1x/min.
  if (pos._closeBackoffUntil && Date.now() < pos._closeBackoffUntil) return;
  // VERROU anti-concurrence : closePos (async, REST) peut durer >1s ; sans verrou,
  // les ticks suivants relanceraient des fermetures concurrentes sur la même position
  // (ordres en doublon, voire double comptabilité). closing=true bloque toute ré-entrée ;
  // il n'est relâché QUE si la fermeture échoue et doit être retentée au tick suivant.
  if (pos.closing) return;
  pos.closing = true;
  const closeSide = pos.side === 'BUY' ? 'SELL' : 'BUY';
  // Quantité à fermer : tout par défaut, ou une part (scaling out).
  const qty = qtyToClose != null ? roundQty(symbol, qtyToClose) : pos.qty;
  if (qty <= 0) { pos.closing = false; return; }
  try {
    // Fermeture DÉCOUPÉE en tranches <= maxQty (corrige l'erreur -4005).
    const ok = await closeQtyInChunks(symbol, closeSide, qty);
    if (!ok) { pos.closing = false; logLine(`↩️ ${symbol} : fermeture incomplète, réessai au prochain tick.`); return; }
  } catch (e) {
    if (e.binanceCode === -1007) {
      await new Promise((r) => setTimeout(r, 1500));
      const after = await fetchPosition(symbol);
      if (after) { pos.closing = false; logLine(`↩️ ${symbol} : fermeture non confirmée, réessai.`); return; }
    } else if (e.binanceCode === -4131) {
      // Carnet d'ordres SANS contrepartie (typique testnet sur les petits symboles) :
      // le MARKET ne peut pas s'exécuter (filtre PERCENT_PRICE). Fallback : on purge
      // les anciens ordres du symbole puis on pose un LIMIT reduceOnly GTC tout près
      // du prix -> il se remplira dès qu'une contrepartie passe. La position fermée
      // sera détectée par la réconciliation (Binance = source de vérité).
      try {
        await signedRequest('DELETE', '/fapi/v1/allOpenOrders', { symbol });
        const px = roundPrice(symbol, S.price * (closeSide === 'SELL' ? 0.998 : 1.002));
        await signedRequest('POST', '/fapi/v1/order', {
          symbol, side: closeSide, type: 'LIMIT', timeInForce: 'GTC',
          quantity: qty, price: px, reduceOnly: 'true',
        });
        logLine(`⏳ ${symbol} : carnet sans contrepartie (-4131, testnet) — LIMIT reduceOnly posé @ ${px}. Fermeture dès qu'un ordre passe en face.`);
      } catch (e2) {
        logLine(`❌ ${symbol} fallback LIMIT: ${e2.message}`);
      }
      pos.closing = false;
      pos._closeBackoffUntil = Date.now() + 60000; // retente le market dans 60s max
      if (!S.disabled) { S.disabled = true; logLine(`🚫 ${symbol} : actif BLOQUÉ (carnet sans contrepartie) — plus aucune nouvelle mise dessus. La position en cours reste gérée.`); }
      return;
    } else {
      pos.closing = false;
      logLine(`❌ ${symbol} fermeture: ${e.message}`);
      return;
    }
  }

  // --- SCALING OUT : fermeture PARTIELLE (on garde le reste ouvert) ---
  if (qtyToClose != null && qty < pos.qty) {
    const exitPx = S.price;
    const dir = pos.side === 'BUY' ? 1 : -1;
    const pnlPct = ((exitPx - pos.entry) / pos.entry) * dir;
    const gross = pnlPct * (qty / pos.qty) * pos.stake * pos.lev;
    const fees = (qty / pos.qty) * pos.stake * pos.lev * (STRAT.FEE_MAKER + STRAT.FEE_TAKER);
    const net = gross - fees;
    state.capital += net;
    state.stats.gross += gross; state.stats.fees += fees; state.stats.net += net;
    pos.qty = roundQty(symbol, pos.qty - qty);      // réduit la position restante
    pos.stake = pos.stake * (pos.qty / (pos.qty + qty)); // ajuste la mise résiduelle
    logLine(`💰 ${symbol} PRISE PARTIELLE ${reason} : ${(pnlPct*100).toFixed(1)}% sur ${qty} — net ${net.toFixed(2)}$ — reste ${pos.qty}.`);
    pos.closing = false; // la position CONTINUE : on relâche le verrou pour la suite de sa gestion
    broadcast({ type: 'positions', positions: livePositions() });
    return;
  }

  const exit = S.price;
  const dir = pos.side === 'BUY' ? 1 : -1;
  const pnlPct = ((exit - pos.entry) / pos.entry) * dir;
  const gross = pnlPct * pos.stake * pos.lev;
  // Frais : leg d'entrée maker (0.02%) si l'ordre est passé en post-only, sinon taker.
  // Leg de sortie toujours taker (fermeture au market).
  const entryFeeRate = pos.entryFill === 'taker' ? STRAT.FEE_TAKER : STRAT.FEE_MAKER;
  const fees = pos.stake * pos.lev * (entryFeeRate + STRAT.FEE_TAKER); // sortie au market = taker
  const net = gross - fees;

  state.capital += net;
  state.stats.gross += gross;
  state.stats.fees += fees;
  state.stats.net += net;
  if (net >= 0) { state.stats.wins++; state.consecLosses = 0; }
  else { state.stats.losses++; state.consecLosses++; }
  if (pos.bonus) { // COMPTEUR SEPARE du bonus loterie
    state.bonusStats.count++; state.bonusStats.net += net;
    if (net >= 0) state.bonusStats.wins++; else state.bonusStats.losses++;
  }
  if (reason === 'STOP-LOSS') S.lastStopAt = Date.now();
  if (state.capital > state.peakCapital) state.peakCapital = state.capital;
  const dd = (state.peakCapital - state.capital) / state.peakCapital;
  if (dd > state.maxDrawdown) state.maxDrawdown = dd;

  state.trades.unshift({
    symbol, side: pos.side, entry: pos.entry, exit, lev: pos.lev, quality: pos.quality,
    investi: pos.stake.toFixed(2), pnlPct: (pnlPct * 100).toFixed(2),
    gross: gross.toFixed(2), fees: fees.toFixed(2), net: net.toFixed(2),
    reason, durationMs: Date.now() - pos.openedAt,
  });
  if (state.trades.length > 100) state.trades.pop();

  logLine(`🔴 ${symbol} ${reason} @ ${exit.toFixed(4)} | net=${net.toFixed(2)}$ | capital=${state.capital.toFixed(2)}$`);
  try { await cancelAlgoStops(symbol); } catch (e) {} S.position = null;
  broadcast({ type: 'trade', stats: state.stats, capital: state.capital, positions: livePositions() });

  if (state.capital <= state.capitalStart * (1 - STRAT.KILL_PCT)) {
    state.running = false;
    state.killed = true;
    logLine(`🛑 KILL SWITCH -${STRAT.KILL_PCT*100}% — capital ${state.capital.toFixed(2)}$. Bot arrêté.`);
    broadcast({ type: 'status', running: false });
  }
  if (state.consecLosses >= STRAT.MAX_CONSEC_LOSSES) {
    state.running = false;
    logLine(`⛔ COUPE-CIRCUIT : ${state.consecLosses} pertes consécutives — bot en pause.`);
    state.consecLosses = 0;
    broadcast({ type: 'status', running: false });
  }
}

// ==================================================================
// STOP-LOSS / TAKE-PROFIT NATIFS SUR BINANCE (protection 24/7)
// ==================================================================
// Pose les ordres SL (STOP_MARKET) et TP (TAKE_PROFIT_MARKET) DIRECTEMENT sur
// Binance, avec closePosition:true. Ils vivent sur les serveurs de Binance et se
// declenchent SEULS meme si le bot est en pause, crashe, deconnecte, ou si l'API
// renvoie un 502 au mauvais moment. C'est la difference entre "mon programme
// essaiera d'envoyer un ordre" et "Binance garde mon stop et l'executera".
// (Un STOP_MARKET ne protege PAS d'un gap qui saute le seuil -> execution au 1er
//  prix dispo ; seule la liquidite protege des gaps.)
// Annule les ordres conditionnels (algo) d'un symbole. Depuis la migration Binance
// du 09/12/2025, les stops vivent dans le service ALGO -> /fapi/v1/allOpenOrders ne
// les touche PAS. On liste les algo ouverts et on les annule un par un.
async function cancelAlgoStops(symbol) {
  try {
    const open = await signedRequest('GET', '/fapi/v1/openAlgoOrders', { symbol });
    const arr = Array.isArray(open) ? open : (open && open.orders) || [];
    for (const o of arr) {
      const id = o.algoId || o.clientAlgoId;
      if (id != null) { try { await signedRequest('DELETE', '/fapi/v1/algoOrder', { algoId: o.algoId }); } catch (e) {} }
    }
  } catch (e) { /* endpoint absent (vieux testnet) : non bloquant */ }
  // Filet : purge aussi les ordres classiques éventuels (anciennes versions).
  try { await signedRequest('DELETE', '/fapi/v1/allOpenOrders', { symbol }); } catch (e) {}
}

// STOP-LOSS / TAKE-PROFIT NATIFS via le NOUVEL endpoint ALGO (/fapi/v1/algoOrder).
// CORRECTIF -4120 (migration Binance 09/12/2025) : les ordres conditionnels
// (STOP_MARKET/TAKE_PROFIT_MARKET) sont REJETES sur /fapi/v1/order et doivent passer
// par le service Algo. Structure : orderType conditionnel + triggerPrice + closePosition.
// Fallback : si l'endpoint algo echoue (testnet incomplet), pos.exchangeStops reste
// false -> le SL LOGICIEL (managePosition, tick ~1s) continue de proteger. Jamais nu.
async function placeExchangeStops(symbol) {
  const S = state.sym[symbol];
  const pos = S && S.position;
  if (!pos) return 0;
  if (pos.bonus) return 0; // le bonus loterie n'a PAS de SL natif (spec : liquidation seule)
  const closeSide = pos.side === 'BUY' ? 'SELL' : 'BUY';
  await cancelAlgoStops(symbol); // purge anti-doublon (au trailing, pos.sl a pu bouger)
  const slPrice = roundPrice(symbol, pos.sl);
  const tpPrice = roundPrice(symbol, pos.tp);
  const placeAlgo = async (orderType, triggerPrice) => {
    // Essai 1 : nouvel endpoint Algo (post-migration).
    try {
      await signedRequest('POST', '/fapi/v1/algoOrder', {
        symbol, side: closeSide, orderType, triggerPrice,
        closePosition: 'true', workingType: 'MARK_PRICE', timeInForce: 'GTE_GTC',
      });
      return true;
    } catch (e1) {
      // Essai 2 (repli) : ancien endpoint, pour les environnements pas encore migres.
      try {
        await signedRequest('POST', '/fapi/v1/order', {
          symbol, side: closeSide, type: orderType, stopPrice: triggerPrice,
          closePosition: 'true', workingType: 'MARK_PRICE', timeInForce: 'GTE_GTC',
        });
        return true;
      } catch (e2) {
        logLine(`\u26A0\uFE0F ${symbol} ${orderType} natif non posé (algo: ${e1.binanceCode || e1.message} / classique: ${e2.binanceCode || e2.message}) — SL logiciel actif en secours.`);
        return false;
      }
    }
  };
  let ok = 0;
  if (await placeAlgo('STOP_MARKET', slPrice)) ok++;
  if (await placeAlgo('TAKE_PROFIT_MARKET', tpPrice)) ok++;
  pos.exchangeStops = ok > 0; // true seulement si au moins le SL est posé côté Binance
  if (ok) pos.exchangeSlPrice = slPrice;
  return ok;
}

function managePosition(symbol) {
  const S = state.sym[symbol];
  const pos = S.position;
  if (!pos) return;
  if (pos.closing) return; // une fermeture est déjà en cours : ne pas empiler d'ordres
  const px = S.price;
  const dir = pos.side === 'BUY' ? 1 : -1;
  const pnlPct = ((px - pos.entry) / pos.entry) * dir;
  const age = Date.now() - pos.openedAt;

  // Pic de profit (pour le trailing)
  if (pos.peakPnl == null || pnlPct > pos.peakPnl) pos.peakPnl = pnlPct;

  // BONUS LOTERIE (spec Calvin) : AUCUN stop-loss (liquidation = plancher naturel).
  // Un trailing s'arme quand le gain atteint +100% de la mise, puis laisse courir
  // (ferme quand le gain rend 30% de son pic). Pas de time-stop : on laisse filer.
  if (pos.bonus) {
    const stakeGain = pnlPct * pos.lev; // gain en fraction de la mise (prix * levier)
    if (pos.bonusPeakGain == null || stakeGain > pos.bonusPeakGain) pos.bonusPeakGain = stakeGain;
    if (pos.bonusPeakGain >= STRAT.BONUS_TP_ARM_STAKE) {
      pos.bonusArmed = true; // doublement atteint -> trailing actif
      if (stakeGain <= pos.bonusPeakGain * (1 - STRAT.BONUS_TRAIL_GIVEBACK)) { closePos(symbol, 'BONUS-TRAIL'); return; }
    }
    return; // tant que non armé : on laisse vivre (la liquidation Binance gere le pire cas)
  }

  // 1) Stop-loss fixe (STRAT.SL_PCT)
  if (pnlPct <= -pos.slPct) { closePos(symbol, 'STOP-LOSS'); return; }

  // 2) SCALING OUT : prise de profit partielle aux paliers, on garde le reste.
  if (STRAT.SCALE_OUT && !pos.scaleDone) pos.scaleDone = [];
  if (STRAT.SCALE_OUT) {
    for (let i = 0; i < STRAT.SCALE_OUT.length; i++) {
      const step = STRAT.SCALE_OUT[i];
      if (!pos.scaleDone.includes(i) && pnlPct >= step.at && pos.qty > 0) {
        pos.scaleDone.push(i);
        const chunk = roundQty(symbol, pos.qty * step.frac);
        if (chunk > 0 && chunk < pos.qty) { closePos(symbol, `SCALE+${(step.at*100).toFixed(0)}%`, chunk); return; }
      }
    }
  }

  // 3) Trailing LARGE : armé à +1%, sort si on recule de 1.5% sous le pic (laisse courir)
  if (pos.peakPnl >= STRAT.TRAIL_ARM) {
    if (pos.peakPnl - pnlPct >= STRAT.TRAIL_PCT) { closePos(symbol, 'TRAILING'); return; }
  }
  // 4) Borne haute de sécurité (rarement atteinte)
  if (pnlPct >= STRAT.TP_SOFT_CAP) { closePos(symbol, 'TAKE-PROFIT'); return; }
  // Time-stop révisé (backtest) : le time-stop "stagnant" est DÉSACTIVÉ (0 = le SL seul gère) ;
  // un trade qui travaille (trailing armé) est borné à 24h pour laisser courir les gagnants.
  const trailingArmed = pos.peakPnl != null && pos.peakPnl >= STRAT.TRAIL_ARM;
  const timeLimit = trailingArmed ? STRAT.TIME_STOP_WORKING_MS : STRAT.TIME_STOP_STALE_MS;
  // timeLimit=0 -> time-stop DÉSACTIVÉ pour cet état (le trade n'est pas coupé par le temps).
  if (timeLimit > 0 && age >= timeLimit) { closePos(symbol, trailingArmed ? 'TIME-STOP-24H' : 'TIME-STOP-STALE'); return; }

  // Affichage fluide : pousse le P&L live des positions au dashboard (throttle 2s global).
  // Seulement si un dashboard est connecte : sinon on ne construit meme pas la liste.
  if (clients.size) {
    const nowMs = Date.now();
    if (!state._lastPosBroadcast || nowMs - state._lastPosBroadcast > 2000) {
      state._lastPosBroadcast = nowMs;
      broadcast({ type: 'positions', positions: livePositions() });
    }
  }
}

// ==================================================================
// BOUCLE PAR TICK
// ==================================================================
async function symbolTick(symbol) {
  const S = state.sym[symbol];
  if (!state.running || S.price <= 0) return;
  // GESTION DES SORTIES : à chaque tick (vital, une position doit réagir vite au stop).
  managePosition(symbol);
  if (S.busy || S.position || S.disabled) return;
  // DÉTECTION D'ENTRÉE : throttlée à ~1s par symbole. Sur horizon swing 1h, évaluer le
  // signal 28x/s serait du gaspillage CPU pur — 1x/s est rigoureusement équivalent en
  // résultat. Le recalcul live des indicateurs est intégré ici (même cadence).
  const now = Date.now();
  if (S._detectAt && now - S._detectAt < 1000) return;
  S._detectAt = now;
  refreshLiveIndicators(S); // bandes/RSI réactifs au prix courant
  let signal = computeSignal(symbol);
  // BONUS LOTERIE (spec Calvin) : 1x/heure, sur un signal NORMAL de qualite (Q>=50).
  if (signal && !signal.filler && STRAT.BONUS_ENABLED && signal.quality >= 50 &&
      (Date.now() - state.lastBonusAt) >= STRAT.BONUS_INTERVAL_MS) {
    signal = { ...signal, bonus: true };
  }
  // PLANCHER : pas de signal normal ET moins de 4 entrées dans l'heure -> tenter un
  // COMBLEMENT (seuils élargis +15% add., mise bridée). Jamais d'entrée sans signal.
  if (!signal && STRAT.FLOOR_ENABLED && tradesLastHour() < STRAT.MIN_TRADES_PER_HOUR) {
    const relaxed = computeSignal(symbol, STRAT.FILLER_RELAX_ADD);
    if (relaxed && relaxed.quality >= STRAT.FILLER_MIN_QUALITY) signal = { ...relaxed, filler: true };
  }
  if (signal) {
    S.busy = true;
    try { await tryOpen(symbol, signal); }
    finally { S.busy = false; }
  }
}

async function reconcile() {
  if (!API_KEY || !API_SECRET) return;
  if (reconcile._busy) return; // idem : un seul cycle de réconciliation à la fois
  reconcile._busy = true;
  try {
    // UN SEUL appel : toutes les positions réelles du compte (source de vérité).
    const data = await signedRequest('GET', '/fapi/v2/positionRisk', {});
    if (!Array.isArray(data)) return;

    // Index des positions réelles non nulles.
    const real = {};
    for (const p of data) {
      const amt = parseFloat(p.positionAmt);
      const step = SYMBOL_INFO[p.symbol] ? SYMBOL_INFO[p.symbol].stepSize : 0.000001;
      if (Math.abs(amt) >= step) {
        real[p.symbol] = {
          side: amt > 0 ? 'BUY' : 'SELL',
          qty: Math.abs(amt),
          entry: parseFloat(p.entryPrice),
          lev: parseFloat(p.leverage) || STRAT.LEV_MAX,
        };
      }
    }

    // 1) Positions FANTÔMES : l'état interne dit "ouvert", Binance dit "fermé" -> on nettoie.
    for (const symbol of Object.keys(state.sym)) {
      const S = state.sym[symbol];
      if (S.position && S.position.closingManual) continue; // fermeture manuelle en cours
      if (S.position && !real[symbol]) {
        // Position fermée cote Binance (par le SL/TP NATIF, un stop manuel Binance, ou
        // une liquidation) alors que le bot ne l'a pas fermee lui-meme -> on COMPTABILISE
        // le P&L realise (au dernier prix connu) pour que les stats restent justes, puis
        // on nettoie. Sans ca, les trades fermes par ordre natif seraient invisibles.
        const pos = S.position;
        const exitPx = S.price || pos.sl || pos.entry;
        const dir = pos.side === 'BUY' ? 1 : -1;
        const pnlPct = ((exitPx - pos.entry) / pos.entry) * dir;
        const gross = pnlPct * pos.stake * pos.lev;
        const fees = pos.stake * pos.lev * (STRAT.FEE_MAKER + STRAT.FEE_TAKER);
        const net = gross - fees;
        state.capital += net;
        state.stats.gross += gross; state.stats.fees += fees; state.stats.net += net;
        if (net >= 0) state.stats.wins++; else state.stats.losses++;
        state.trades.unshift({ symbol, side: pos.side, lev: pos.lev, entry: pos.entry,
          exit: exitPx, stake: pos.stake, pnlPct: pnlPct * 100, gross, fees, net,
          reason: 'SL/TP NATIF', at: Date.now(), durationMs: Date.now() - (pos.openedAt || Date.now()) });
        if (state.trades.length > 100) state.trades.pop();
        S.position = null;
        logLine(`🛡️ ${symbol} : fermé par ordre natif Binance (SL/TP) — net ${net.toFixed(2)}$ comptabilisé.`);
      }
    }

    // 2) Positions ORPHELINES : Binance a une position que l'état interne ignore -> on l'ADOPTE.
    //    (C'est LE correctif : le bot reprend la main sur des positions qu'il ne suivait plus,
    //    pour les gérer — stop, trailing, scaling out — au lieu de les laisser flotter.)
    for (const symbol of Object.keys(real)) {
      ensureSymbolState(symbol);
      const S = state.sym[symbol];
      const r = real[symbol];
      if (S.position && S.position.closingManual) continue; // fermeture manuelle en cours
      if (!S.position) {
        const exits = computeExits(symbol);
        // On estime la mise à partir de la marge réelle (qty*entry/levier).
        const stake = (r.qty * r.entry) / (r.lev || 1);
        S.position = {
          side: r.side, entry: r.entry, qty: r.qty, stake, lev: r.lev,
          quality: 0, entryFill: 'taker',
          slPct: exits.slPct, tpPct: exits.tpPct,
          sl: r.side === 'BUY' ? r.entry * (1 - exits.slPct) : r.entry * (1 + exits.slPct),
          tp: r.side === 'BUY' ? r.entry * (1 + exits.tpPct) : r.entry * (1 - exits.tpPct),
          openedAt: Date.now(), peakPnl: 0, scaleDone: [], adopted: true,
        };
        // S'assurer que le symbole est surveillé (flux prix) même hors univers courant.
        if (!ALL_SYMBOLS.includes(symbol)) { ALL_SYMBOLS.push(symbol); reconnectPriceStreamsSoon(); }
        logLine(`🩹 ${symbol} : position réelle ADOPTÉE (${r.side} ${r.qty} @ ${r.entry}, x${r.lev}) — désormais gérée.`);
      } else {
        // Position connue : on resynchronise qty/entry sur la réalité Binance.
        S.position.qty = r.qty;
        S.position.entry = r.entry;
      }
    }
    if (clients.size) broadcast({ type: 'positions', positions: livePositions() });
  } catch (e) {
    logLine(`⚠️ reconcile: ${e.message}`);
  } finally { reconcile._busy = false; }
}

// Reconnexion du flux prix (débounce léger) quand l'univers change via adoption.
let _reconnectTimer = null;
function reconnectPriceStreamsSoon() {
  if (_reconnectTimer) return;
  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null;
    if (priceWs) { const old = priceWs; priceWs = null; try { old.close(); } catch (e) {} connectPriceStreams(); }
  }, 2000);
}

// ==================================================================
// WEBSOCKET PRIX (multi-stream)
// ==================================================================
let priceWs = null;
function connectPriceStreams() {
  if (!ALL_SYMBOLS.length) { setTimeout(connectPriceStreams, 2000); return; }
  const streams = ALL_SYMBOLS.map((s) => `${s.toLowerCase()}@markPrice@1s`).join('/');
  const url = `${WS_BASE}/stream?streams=${streams}`;
  const ws = new WebSocket(url);
  priceWs = ws;
  ws.on('open', () => logLine(`🔌 WebSocket prix connecté (${MODE}) — ${ALL_SYMBOLS.length} symboles`));
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      const d = msg.data || msg;
      const sym = (d.s || '').toUpperCase();
      const p = parseFloat(d.p || d.markPrice);
      if (sym && state.sym[sym] && p > 0) {
        const S = state.sym[sym];
        S.price = p;
        // Buffer circulaire (évite shift() O(n) répété à chaque tick).
        if (!S.priceBuf) { S.priceBuf = new Array(60).fill(p); S.priceBufIdx = 0; }
        S.priceBuf[S.priceBufIdx] = p;
        S.priceBufIdx = (S.priceBufIdx + 1) % S.priceBuf.length;
        symbolTick(sym);
      }
    } catch (e) { /* ignore */ }
  });
  ws.on('close', () => { if (priceWs === ws) { logLine('⚠️ WS prix fermé — reconnexion 3s'); setTimeout(connectPriceStreams, 3000); } });
  ws.on('error', (e) => logLine(`⚠️ WS error: ${e.message}`));
}

// Applique un nouvel univers : met à jour ALL_SYMBOLS, initialise les états,
// et reconnecte le flux de prix. Appelé au démarrage et à chaque re-scan.
async function applyUniverse(symbols) {
  const changed = symbols.slice().sort().join(',') !== ALL_SYMBOLS.slice().sort().join(',');
  ALL_SYMBOLS = symbols;
  state.universe = symbols;
  for (const s of symbols) ensureSymbolState(s);
  if (changed && priceWs) {
    const old = priceWs; priceWs = null;
    try { old.close(); } catch (e) {}
    connectPriceStreams();
  }
  logLine(`🌍 Univers : ${symbols.length} cryptos les plus volatiles — ${symbols.slice(0, 8).join(', ')}...`);
}

// Re-scan périodique de l'univers volatil.
async function refreshUniverse() {
  const top = await scanUniverse();
  await applyUniverse(top);
}

async function refreshAllKlines() {
  if (refreshAllKlines._busy) return; // ne pas empiler si le cycle précédent n'est pas fini (réseau lent)
  refreshAllKlines._busy = true;
  try {
  // Carnets d'ordres RÉELS (bid/ask) de tous les symboles en UN appel (poids 5).
  // Sert de filtre de tradabilité : spread énorme ou carnet vide = actif bloqué.
  try {
    const books = await publicGet(REST_BASE, '/fapi/v1/ticker/bookTicker', {});
    for (const b of (Array.isArray(books) ? books : [])) {
      const S = state.sym[b.symbol]; if (!S) continue;
      const bid = +b.bidPrice, ask = +b.askPrice, mid = (bid + ask) / 2;
      S.book = { bid, ask, spreadPct: (bid > 0 && ask > 0 && mid > 0) ? (ask - bid) / mid : Infinity };
    }
  } catch (e) { /* silencieux : prochain cycle */ }
  const BATCH = 4;
  for (let i = 0; i < ALL_SYMBOLS.length; i += BATCH) {
    const slice = ALL_SYMBOLS.slice(i, i + BATCH);
    await Promise.all(slice.map((s) => refreshKlines(s)));
  }
  rankActiveSymbols();
  if (clients.size) broadcast({ type: 'snapshot', data: snapshot() }); // snapshot construit seulement s'il y a un spectateur
  } finally { refreshAllKlines._busy = false; }
}

// Tous les symboles de l'univers (déjà filtré volatilité + liquidité 100M+spread) sont tradables ;
// le filtrage fin (régime, extrêmes, funding) se fait dans computeSignal.
function rankActiveSymbols() {
  // L'univers est déjà les N plus volatils ; tous sont actifs. Le filtrage fin
  // (régime, extrême, funding) se fait dans computeSignal.
  state.activeSymbols = ALL_SYMBOLS.slice();
}

// ==================================================================
// SERVEUR HTTP + WS DASHBOARD
// ==================================================================
const clients = new Set();
function broadcast(obj) {
  if (clients.size === 0) return; // personne ne regarde -> zero serialisation, zero envoi
  const msg = JSON.stringify(obj);
  for (const c of clients) if (c.readyState === WebSocket.OPEN) c.send(msg);
}

function livePositions() {
  const out = [];
  for (const symbol of ALL_SYMBOLS) {
    const S = state.sym[symbol];
    const pos = S.position;
    if (!pos) continue;
    const px = S.price || pos.entry;
    const dir = pos.side === 'BUY' ? 1 : -1;
    const pnlPct = ((px - pos.entry) / pos.entry) * dir;
    const gross = pnlPct * pos.stake * pos.lev;
    const fees = pos.stake * pos.lev * (STRAT.FEE_MAKER + STRAT.FEE_TAKER);
    out.push({
      symbol, side: pos.side, entry: pos.entry, current: px, lev: pos.lev,
      quality: pos.quality, investi: pos.stake, sl: pos.sl, tp: pos.tp,
      pnlPct: pnlPct * 100, netLive: gross - fees,
      ageMs: Date.now() - (pos.openedAt || Date.now()), timeStopMs: (pos.peakPnl != null && pos.peakPnl >= STRAT.TRAIL_ARM) ? STRAT.TIME_STOP_WORKING_MS : (STRAT.TIME_STOP_STALE_MS || STRAT.TIME_STOP_WORKING_MS),
      adopted: !!pos.adopted,
    });
  }
  return out;
}

function symbolsOverview() {
  return ALL_SYMBOLS.map((symbol) => {
    const S = state.sym[symbol];
    // Reconstitue la mini-courbe (40 pts) depuis le buffer circulaire, dans l'ordre.
    const spark = [];
    if (S.priceBuf) {
      const n = S.priceBuf.length;
      const take = Math.min(40, n);
      // Directement les `take` points les plus recents, en ordre chronologique :
      // strictement identique a l'ancienne reconstruction complete + slice(-40).
      for (let i = n - take; i < n; i++) spark.push(S.priceBuf[(S.priceBufIdx + i) % n]);
    }
    return {
      symbol, price: S.price, bias: S.indicators.bias, quality: S.indicators.quality,
      rsi: S.indicators.rsi, regime: S.swing.regime, adx: S.swing.adx, funding: S.swing.funding, hasPosition: !!S.position,
      disabled: !!S.disabled,
      illiquid: !!(S.book && S.book.spreadPct > STRAT.BOOK_MAX_SPREAD_PCT),
      spark,
    };
  });
}

function snapshot() {
  const tot = state.stats.wins + state.stats.losses;
  return {
    mode: state.mode, running: state.running, killed: state.killed,
    capital: state.capital, capitalStart: state.capitalStart,
    maxDrawdown: state.maxDrawdown * 100,
    exposure: currentExposure(), maxExposure: state.capital * STRAT.MAX_EXPOSURE_PCT,
    openPositions: openPositionsCount(),
    maxPositions: STRAT.MAX_POSITIONS_CAP,
    wins: state.stats.wins, losses: state.stats.losses,
    stats: state.stats, winRate: tot ? (state.stats.wins / tot) * 100 : null,
    positions: livePositions(), symbols: symbolsOverview(),
    trades: state.trades.slice(0, 40), log: state.log.slice(0, 50),
    strat: { sl: STRAT.SL_PCT * 100, trailArm: STRAT.TRAIL_ARM * 100, trailPct: STRAT.TRAIL_PCT * 100, lev: '2-5', universe: state.universe.length, relaxOn: STRAT.RELAX_RANGE_ENTRY, floorOn: STRAT.FLOOR_ENABLED, bonusOn: STRAT.BONUS_ENABLED },
    bonusStats: state.bonusStats,
  };
}

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/dashboard') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(DASHBOARD_HTML);
    return;
  }
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, mode: MODE, running: state.running }));
    return;
  }
  if (req.url === '/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(snapshot()));
    return;
  }
  res.writeHead(404);
  res.end('Not found');
});

// Filets de sécurité process : une promesse non gérée ou une exception isolée
// est LOGGÉE au lieu de tuer le process en silence (Railway redémarrerait, mais
// on perdrait le diagnostic et quelques secondes de gestion des positions).
process.on('unhandledRejection', (e) => { try { logLine(`⚠️ Promesse non gérée : ${(e && e.message) || e}`); } catch (_) {} });
process.on('uncaughtException', (e) => { try { logLine(`⚠️ Exception non capturée : ${e.message}`); } catch (_) {} });

// Compression WS (permessage-deflate) : réduit ~70% la bande passante du
// dashboard (JSON très compressible) — sensible sur mobile 4G/5G.
const wss = new WebSocket.Server({ server, perMessageDeflate: true });
wss.on('connection', (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'snapshot', data: snapshot() }));
  ws.on('message', async (raw) => {
    let cmd;
    try { cmd = JSON.parse(raw); } catch { return; }
    if (cmd.action === 'start') {
      if (state.killed) { logLine('⚠️ Kill switch actif — redémarrage refusé.'); return; }
      state.running = true; logLine('▶️ Bot LANCÉ'); broadcast({ type: 'status', running: true });
    } else if (cmd.action === 'stop') {
      state.running = false; logLine('⏸️ Bot EN PAUSE'); broadcast({ type: 'status', running: false });
    } else if (cmd.action === 'closeAll') {
      for (const s of Object.keys(state.sym)) if (state.sym[s].position) await closePos(s, 'MANUEL');
      logLine('🧹 Fermeture manuelle de TOUTES les positions');
    } else if (cmd.action === 'closeManual') {
      const sym = cmd.symbol;
      const S = sym && state.sym[sym];
      if (!S || !S.position) { logLine(`⚠️ closeManual: pas de position sur ${sym}`); return; }
      const pct = cmd.pct != null ? Math.max(1, Math.min(100, parseFloat(cmd.pct))) : 100;
      const qtyToClose = pct >= 100 ? null : roundQty(sym, S.position.qty * (pct / 100));
      S.position.closingManual = true;
      logLine(`👤 CLÔTURE MANUELLE ${sym} — ${pct}%`);
      await closePos(sym, pct >= 100 ? 'MANUEL' : `MANUEL-${pct}%`, qtyToClose);
      if (state.sym[sym] && state.sym[sym].position) state.sym[sym].position.closingManual = false;
    } else if (cmd.action === 'toggleBonus') {
      STRAT.BONUS_ENABLED = !STRAT.BONUS_ENABLED;
      logLine(`🎰 Bonus loterie : ${STRAT.BONUS_ENABLED ? 'ACTIVÉ (25-50$, x15, sans SL, TP+100% puis trailing)' : 'DÉSACTIVÉ'}`);
      broadcast({ type: 'snapshot', data: snapshot() });
    } else if (cmd.action === 'toggleFloor') {
      STRAT.FLOOR_ENABLED = !STRAT.FLOOR_ENABLED;
      logLine(`🎯 Plancher 4 trades/h : ${STRAT.FLOOR_ENABLED ? 'ACTIVÉ (comblements bridés 65-85$ x2)' : 'DÉSACTIVÉ'}`);
      broadcast({ type: 'snapshot', data: snapshot() });
    } else if (cmd.action === 'toggleRelax') {
      STRAT.RELAX_RANGE_ENTRY = !STRAT.RELAX_RANGE_ENTRY;
      logLine(`🔧 Assouplissement RANGE : ${STRAT.RELAX_RANGE_ENTRY ? 'ACTIVÉ' : 'DÉSACTIVÉ'}`);
      broadcast({ type: 'snapshot', data: snapshot() });
    }
  });
  ws.on('close', () => clients.delete(ws));
});

// ==================================================================
// DASHBOARD
// ==================================================================
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#00F5C8">
<title>Itachi Multi — CryptoSignal AI</title>
<style>
  button,input{touch-action:manipulation} /* mobile : 2 taps rapprochés = 2 clics (pas de double-tap zoom) */
  :root{--bg:#070b10;--card:#101820;--card2:#0e151d;--cyan:#00F5C8;--cyan-dim:rgba(0,245,200,.12);
    --green:#22e58a;--red:#ff5470;--amber:#ffb547;--txt:#e7f0ef;--mut:#7c8b95;--line:#1a2530}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:radial-gradient(1200px 600px at 50% -200px,rgba(0,245,200,.06),transparent),var(--bg);
    color:var(--txt);font-family:'Segoe UI',system-ui,sans-serif;padding:14px;max-width:1200px;margin:0 auto}
  .head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .logo{font-size:19px;font-weight:800}.logo .c{color:var(--cyan)}
  .badge{padding:3px 9px;border-radius:6px;font-size:11px;font-weight:700;letter-spacing:.5px}
  .badge.net{background:var(--cyan-dim);color:var(--cyan);border:1px solid rgba(0,245,200,.3)}
  .badge.on{background:rgba(34,229,138,.15);color:var(--green)}
  .badge.off{background:rgba(124,139,149,.15);color:var(--mut)}
  .sub{color:var(--mut);font-size:12px;margin:4px 0 14px}
  .controls{display:flex;gap:8px;margin:14px 0;flex-wrap:wrap}
  button{border:0;border-radius:9px;padding:11px 20px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit}
  .btn-go{background:var(--cyan);color:#04221d}.btn-stop{background:#1c2630;color:var(--txt)}
  .btn-kill{background:rgba(255,84,112,.15);color:var(--red);border:1px solid rgba(255,84,112,.3)}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-bottom:14px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:13px 15px}
  .card .k{color:var(--mut);font-size:11px;text-transform:uppercase;letter-spacing:.5px}
  .card .v{font-size:20px;font-weight:800;margin-top:5px;font-variant-numeric:tabular-nums}
  .green{color:var(--green)}.red{color:var(--red)}.cyan{color:var(--cyan)}.mut{color:var(--mut)}
  .sec{font-size:13px;font-weight:700;margin:18px 0 8px;display:flex;align-items:center;gap:8px}
  .sec .dot{width:6px;height:6px;border-radius:50%;background:var(--cyan)}
  .table-wrap{border:1px solid var(--line);border-radius:12px;overflow-x:auto;background:var(--card2)}
  table{width:100%;border-collapse:collapse;font-size:12.5px;min-width:640px}
  th,td{text-align:right;padding:8px 11px;border-bottom:1px solid var(--line);white-space:nowrap;font-variant-numeric:tabular-nums}
  th:first-child,td:first-child{text-align:left}
  th{color:var(--mut);font-size:10.5px;text-transform:uppercase;letter-spacing:.5px;background:var(--card)}
  .pill{padding:2px 8px;border-radius:5px;font-size:11px;font-weight:700}
  .pill.long{background:rgba(34,229,138,.15);color:var(--green)}
  .pill.short{background:rgba(255,84,112,.15);color:var(--red)}
  .pill.flat{background:rgba(124,139,149,.15);color:var(--mut)}
  .tag{padding:1px 6px;border-radius:5px;font-size:10px;font-weight:800;margin-left:4px}
  .tag.exc{background:rgba(255,181,71,.18);color:var(--amber)}
  .tag.exp{background:rgba(0,245,200,.16);color:var(--cyan)}
  .log{background:var(--card2);border:1px solid var(--line);border-radius:12px;padding:12px;
    font-family:Consolas,monospace;font-size:11px;max-height:200px;overflow:auto;color:#8aa0a0;line-height:1.7;margin-top:8px}
  .qbadge{font-weight:800}
</style></head>
<body>
  <div class="head">
    <span class="logo">CryptoSignal<span class="c">AI</span> · Multi</span>
    <span class="badge" style="background:rgba(0,245,200,.12);color:#00F5C8;border:1px solid rgba(0,245,200,.3)">3.12c - Champion · 40 sym <span style="opacity:.6;font-weight:600">· WR ~70%</span></span>
    <span id="mode" class="badge net">TESTNET</span>
    <span id="run" class="badge off">PAUSE</span>
  </div>
  <div class="sub" id="stratline">3.12c-Champion (moteur allégé) · SL -4.5% (optimisé) · trailing +1%/-1.5% · bonus loterie · multi-régime</div>

  <div class="controls">
    <button id="start" class="btn-go">▶ Démarrer</button>
    <button id="stop" class="btn-stop">⏸ Pause</button>
    <button id="closeAll" class="btn-kill">⏹ Tout fermer</button>
    <button id="toggleRelax" class="btn-stop">🔧 Assoupli: —</button>
    <button id="toggleFloor" class="btn-stop">🎯 Plancher 4/h: —</button>
    <button id="toggleBonus" class="btn-stop">🎰 Bonus: —</button>
  </div>

  <div class="grid">
    <div class="card"><div class="k">Capital</div><div class="v" id="cap">—</div></div>
    <div class="card"><div class="k">P&L Net</div><div class="v" id="net">—</div></div>
    <div class="card"><div class="k">Win Rate</div><div class="v" id="wr">—</div></div>
    <div class="card"><div class="k">Trades</div><div class="v" id="ntr">0</div></div>
    <div class="card"><div class="k">Gagnants (net)</div><div class="v green" id="wins">0</div></div>
    <div class="card"><div class="k">Perdants (net)</div><div class="v red" id="losses">0</div></div>
    <div class="card"><div class="k">Positions</div><div class="v" id="pos">0/0</div></div>
    <div class="card"><div class="k">Mises 9% actives</div><div class="v cyan" id="exc">0/0</div></div>
    <div class="card"><div class="k">Exposition</div><div class="v" id="exp">—</div></div>
    <div class="card"><div class="k">Drawdown</div><div class="v" id="dd">0%</div></div>
    <div class="card"><div class="k">Frais</div><div class="v mut" id="fees">—</div></div>
  </div>

  <div class="sec"><span class="dot"></span>Positions ouvertes</div>
  <div class="table-wrap"><table>
    <thead><tr><th>Symbole</th><th>Sens</th><th>Lev·Q</th><th>Entrée</th><th>Actuel</th><th>Investi</th><th>SL</th><th>TP</th><th>⏱ Durée</th><th>P&L live</th><th>Action</th></tr></thead>
    <tbody id="positions"><tr><td colspan="11" class="mut" style="text-align:center;padding:14px">Aucune position</td></tr></tbody>
  </table></div>

  <div class="sec"><span class="dot"></span>Surveillance des symboles</div>
  <div class="table-wrap"><table>
    <thead><tr><th>Symbole</th><th>Prix</th><th>Courbe</th><th>Biais</th><th>Q</th><th>RSI</th><th>Funding</th><th>Régime</th><th>Statut</th></tr></thead>
    <tbody id="symbols"></tbody>
  </table></div>

  <div class="sec"><span class="dot"></span>Historique des trades</div>
  <div class="table-wrap"><table>
    <thead><tr><th>Symbole</th><th>Sens</th><th>Lev</th><th>Entrée</th><th>Sortie</th><th>Investi</th><th>P&L%</th><th>Brut</th><th>Frais Binance</th><th>Net retirable</th><th>⏱ Durée</th><th>Raison</th></tr></thead>
    <tbody id="trades"></tbody>
  </table></div>

  <div class="sec"><span class="dot"></span>Journal</div>
  <div class="log" id="log"></div>

<script>
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  let ws = null;
  let wsReady = false;
  // Confirmation de fermeture en 2 taps : sym -> échéance (ms). Remplace confirm()
  // natif, que Chrome peut bloquer définitivement ("ne plus afficher de dialogues")
  // après des fermetures manuelles répétées -> bouton Fermer qui ne répond plus.
  var pendingClose = {};
  function wsSend(obj){
    // Envoi sûr : si la connexion n'est pas prête, on ne perd pas le clic silencieusement.
    if(ws && ws.readyState === WebSocket.OPEN){ ws.send(JSON.stringify(obj)); }
    else { console.warn('WS pas prêt, action ignorée:', obj); }
  }
  function connect(){
    ws = new WebSocket(proto + '://' + location.host);
    ws.onopen = ()=>{ wsReady=true; console.log('WS connecté'); };
    ws.onmessage = onWsMessage;
    ws.onclose = ()=>{
      wsReady=false;
      $('run').textContent='RECONNEXION…'; $('run').className='badge off';
      setTimeout(connect, 1500); // reconnexion automatique (Railway peut couper les WS inactifs)
    };
    ws.onerror = ()=>{ try{ ws.close(); }catch(e){} };
  }
  const $ = id => document.getElementById(id);
  const num = (n,d=2) => Number(n).toLocaleString('fr-FR',{minimumFractionDigits:d,maximumFractionDigits:d});
  const sign = n => n>=0?'+':'';
  const cls = n => n>=0?'green':'red';
  function px(v){ const n=Number(v); return n>=100?num(n,2):n>=1?num(n,3):num(n,5); }
  function dur(ms){ if(ms==null)return '—'; let s=Math.floor(ms/1000); const h=Math.floor(s/3600); s%=3600; const m=Math.floor(s/60); const r=s%60; return (h>0?h+'h':'')+(m<10&&h>0?'0':'')+m+':'+(r<10?'0':'')+r; }

  function renderStats(s){
    $('mode').textContent=(s.mode||'testnet').toUpperCase();
    $('run').textContent=s.killed?'KILL -45%':(s.running?'EN MARCHE':'PAUSE');
    $('run').className='badge '+(s.running?'on':'off');
    if($('toggleRelax'))$('toggleRelax').textContent='🔧 Assoupli: '+(s.strat&&s.strat.relaxOn?'ON':'OFF');
    if($('toggleFloor'))$('toggleFloor').textContent='🎯 Plancher 4/h: '+(s.strat&&s.strat.floorOn?'ON':'OFF');
    if($('toggleBonus')){var bs=s.bonusStats||{count:0,wins:0,losses:0,net:0};$('toggleBonus').textContent='🎰 Bonus: '+(s.strat&&s.strat.bonusOn?'ON':'OFF')+(bs.count?' ('+bs.wins+'W/'+bs.losses+'L '+(bs.net>=0?'+':'')+bs.net.toFixed(0)+'$)':'');}
    $('stratline').textContent='3.12c-Champion (moteur allégé) · SL -'+(s.strat?s.strat.sl.toFixed(1):4.5)+'% (optimisé backtest) · trailing +'+(s.strat?s.strat.trailArm:1)+'%/-'+(s.strat?s.strat.trailPct:1.5)+'% · bonus loterie 25-50$ x15 · laisse courir 24h · multi-régime (RANGE→MR / UP→long / DOWN→short) · x2-5';
    $('cap').textContent='$'+num(s.capital);
    $('net').textContent=sign(s.stats.net)+'$'+num(s.stats.net); $('net').className='v '+cls(s.stats.net);
    $('wr').textContent=s.winRate!=null?Math.round(s.winRate)+'%':'—';
    $('wr').className='v '+(s.winRate>=50?'green':s.winRate!=null?'red':'mut');
    $('ntr').textContent=s.stats.wins+s.stats.losses;
    $('wins').textContent=s.stats.wins;
    $('losses').textContent=s.stats.losses;
    $('pos').textContent=s.openPositions+'/'+s.maxPositions;
    if($('exc')) $('exc').textContent=(s.excOpen!=null?s.excOpen:0)+'/'+(s.excMax!=null?s.excMax:2);
    $('exp').textContent='$'+num(s.exposure)+' / '+num(s.maxExposure);
    $('dd').textContent=(s.maxDrawdown||0).toFixed(1)+'%';
    $('fees').textContent='$'+num(s.stats.fees);
  }

  function renderPositions(list){
    const tb=$('positions');
    // FIX clavier mobile : si l'utilisateur est en train de taper un % (champ focus),
    // on ne reconstruit PAS le tableau (sinon l'input est détruit -> le clavier se ferme).
    const ae=document.activeElement;
    if(ae&&ae.id&&ae.id.indexOf('pct_')===0)return;
    // Préserver les % déjà saisis entre deux rafraîchissements (sinon retour à 100 avant le clic Fermer)
    const saved={};
    tb.querySelectorAll('input[id^="pct_"]').forEach(el=>{saved[el.id]=el.value;});
    if(!list||!list.length){tb.innerHTML='<tr><td colspan="11" class="mut" style="text-align:center;padding:14px">Aucune position</td></tr>';return;}
    tb.innerHTML=list.map(p=>{
      const sc=p.side==='BUY'?'long':'short',st=p.side==='BUY'?'LONG':'SHORT';
      return '<tr><td>'+p.symbol+'</td><td><span class="pill '+sc+'">'+st+'</span></td>'+
        '<td>'+p.lev+'x·Q'+p.quality+'</td><td>'+px(p.entry)+'</td><td>'+px(p.current)+'</td>'+
        '<td>$'+num(p.investi)+'</td><td class="red">'+px(p.sl)+'</td><td class="green">'+px(p.tp)+'</td>'+
        '<td class="'+((p.timeStopMs&&p.ageMs>p.timeStopMs*0.8)?'red':'mut')+'">'+dur(p.ageMs)+(p.adopted?' <span style="color:var(--amber);font-size:9px">adopté</span>':'')+'</td>'+
        '<td class="'+cls(p.netLive)+'">'+sign(p.netLive)+'$'+num(p.netLive)+' ('+sign(p.pnlPct)+p.pnlPct.toFixed(2)+'%)</td>'+
        '<td style="white-space:nowrap"><input id="pct_'+p.symbol+'" type="number" min="1" max="100" value="'+(saved['pct_'+p.symbol]||'100')+'" style="width:42px;background:#0e151d;border:1px solid var(--line);color:var(--txt);border-radius:5px;padding:3px;font-size:11px"/>%'+
        ' <button data-sym="'+p.symbol+'" class="closeBtn" style="background:'+((pendingClose[p.symbol]&&Date.now()<pendingClose[p.symbol])?'rgba(255,84,112,.5)':'rgba(255,84,112,.15)')+';color:var(--red);border:1px solid rgba(255,84,112,.3);border-radius:6px;padding:4px 8px;font-size:11px;font-weight:700;cursor:pointer">'+((pendingClose[p.symbol]&&Date.now()<pendingClose[p.symbol])?'Confirmer ?':'Fermer')+'</button></td></tr>';
    }).join('');
  }

  function sparkline(data){
    if(!data || data.length < 2) return '<span class="mut">—</span>';
    const w=72, h=22, n=data.length;
    const min=Math.min(...data), max=Math.max(...data);
    const range=(max-min)||1;
    const pts=data.map((v,i)=>{
      const x=(i/(n-1))*w;
      const y=h-((v-min)/range)*h;
      return x.toFixed(1)+','+y.toFixed(1);
    }).join(' ');
    const up=data[data.length-1]>=data[0];
    const col=up?'#22e58a':'#ff5470';
    return '<svg width="'+w+'" height="'+h+'" viewBox="0 0 '+w+' '+h+'" style="vertical-align:middle">'+
      '<polyline points="'+pts+'" fill="none" stroke="'+col+'" stroke-width="1.5"/></svg>';
  }

  function renderSymbols(list){
    const tb=$('symbols');
    tb.innerHTML=(list||[]).map(s=>{
      const b=s.bias||'NEUTRE';
      const bc=b==='LONG'?'long':b==='SHORT'?'short':'flat';
      const q=s.quality!=null?s.quality:'—';
      const qcol=s.quality>=49?'cyan':'mut';
      const fnd=s.funding!=null?(s.funding>=0?'+':'')+(s.funding*100).toFixed(3)+'%':'—';
      const fndCol=s.funding!=null&&Math.abs(s.funding)>=0.0005?(s.funding>0?'red':'green'):'mut';
      const regTxt=s.regime==='UP'?'<span style="color:var(--green)">▲ UP</span>':s.regime==='DOWN'?'<span style="color:var(--red)">▼ DOWN</span>':s.regime==='RANGE'?'<span style="color:var(--cyan)">↔ RANGE</span>':'—';
      return '<tr><td>'+s.symbol+'</td><td>'+(s.price?px(s.price):'—')+'</td>'+
        '<td>'+sparkline(s.spark)+'</td>'+
        '<td><span class="pill '+bc+'">'+b+'</span></td>'+
        '<td class="qbadge '+qcol+'">'+q+'</td>'+
        '<td>'+(s.rsi!=null?s.rsi.toFixed(0):'—')+'</td>'+
        '<td class="'+fndCol+'">'+fnd+'</td>'+
        '<td>'+regTxt+'</td>'+
        '<td>'+(s.hasPosition?'<span class="pill long">EN POSITION</span>':(s.disabled?'<span class="pill short">EXCLU</span>':(s.illiquid?'<span class="pill short" style="opacity:.7">ILLIQUIDE</span>':'<span class="mut">-</span>')))+'</td></tr>';
    }).join('');
  }

  function renderTrades(list){
    const tb=$('trades');
    if(!list||!list.length){tb.innerHTML='<tr><td colspan="12" class="mut" style="text-align:center;padding:14px">Aucun trade</td></tr>';return;}
    tb.innerHTML=list.map(t=>{
      const net=Number(t.net),gross=Number(t.gross!=null?t.gross:net),sc=t.side==='BUY'?'long':'short',st=t.side==='BUY'?'LONG':'SHORT';
      return '<tr><td>'+t.symbol+'</td><td><span class="pill '+sc+'">'+st+'</span></td><td>'+t.lev+'x</td>'+
        '<td>'+px(t.entry)+'</td><td>'+px(t.exit)+'</td><td>$'+num(t.investi)+'</td>'+
        '<td class="'+cls(Number(t.pnlPct))+'">'+sign(Number(t.pnlPct))+t.pnlPct+'%</td>'+
        '<td class="'+cls(gross)+'">'+sign(gross)+'$'+num(gross)+'</td>'+
        '<td class="mut">-$'+num(t.fees)+'</td>'+
        '<td class="'+cls(net)+'" style="font-weight:700">'+sign(net)+'$'+num(net)+'</td>'+
        '<td class="mut">'+dur(t.durationMs)+'</td>'+
        '<td class="mut">'+t.reason+'</td></tr>';
    }).join('');
  }

  let snap=null;
  function onWsMessage(e){
    const m=JSON.parse(e.data);
    if(m.type==='snapshot'){snap=m.data;renderStats(snap);renderPositions(snap.positions);renderSymbols(snap.symbols);renderTrades(snap.trades);$('log').innerHTML=(snap.log||[]).join('<br>');}
    else if(snap){
      if(m.type==='status'){snap.running=m.running;renderStats(snap);}
      if(m.type==='symbols'){snap.symbols=m.symbols;renderSymbols(m.symbols);}
      if(m.type==='positions'){snap.positions=m.positions;renderPositions(m.positions);}
      if(m.type==='trade'){snap.stats=m.stats;snap.capital=m.capital;snap.positions=m.positions;renderStats(snap);renderPositions(m.positions);}
      if(m.type==='log'){snap.log.unshift(m.line);if(snap.log.length>50)snap.log.pop();$('log').innerHTML=snap.log.join('<br>');}
      if(m.type==='logs'){for(let i=m.lines.length-1;i>=0;i--)snap.log.unshift(m.lines[i]);while(snap.log.length>50)snap.log.pop();$('log').innerHTML=snap.log.join('<br>');}
    }
  }
  document.addEventListener('click', function(ev){
    const btn = ev.target.closest && ev.target.closest('.closeBtn');
    if(!btn) return;
    const sym = btn.getAttribute('data-sym');
    const now = Date.now();
    if(!pendingClose[sym] || now > pendingClose[sym]){
      // 1er tap : ARMER pendant 4s (aucun dialogue natif -> fiable sur mobile)
      pendingClose[sym] = now + 8000; // 8s pour confirmer
      btn.textContent = 'Confirmer ?';
      btn.style.background = 'rgba(255,84,112,.5)';
      setTimeout(function(){
        if(Date.now() > (pendingClose[sym]||0)){
          delete pendingClose[sym];
          const b = document.querySelector('.closeBtn[data-sym="'+sym+'"]');
          if(b){ b.textContent='Fermer'; b.style.background='rgba(255,84,112,.15)'; }
        }
      }, 8200);
      return;
    }
    // 2e tap dans les 4s : ENVOI réel
    delete pendingClose[sym];
    const inp = document.getElementById('pct_'+sym);
    const pct = inp ? Math.max(1, Math.min(100, Number(inp.value)||100)) : 100;
    wsSend({action:'closeManual', symbol:sym, pct:pct});
    btn.textContent = '⏳ envoi…';
  });
  $('toggleRelax').onclick=()=>wsSend({action:'toggleRelax'});
  $('toggleFloor').onclick=()=>wsSend({action:'toggleFloor'});
  if($('toggleBonus'))$('toggleBonus').onclick=()=>wsSend({action:'toggleBonus'});
  $('start').onclick=()=>wsSend({action:'start'});
  $('stop').onclick=()=>wsSend({action:'stop'});
  $('closeAll').onclick=()=>wsSend({action:'closeAll'});
  connect(); // établit la connexion + reconnexion auto
</script>
</body></html>`;

// ==================================================================
// DÉMARRAGE
// ==================================================================
async function start() {
  logLine(`\u{1F680} Itachi — SERVEUR 3.12c-Champion (moteur allege — strategie 3.12b intacte) — ${MODE.toUpperCase()} — capital $${CAPITAL_START}`);
  logLine(`\u{1F4C8} 3.12c-Champion — SL -4.5% (optimise) / trailing +1%/-1.5% — bonus loterie 25-50$ x15 sans SL — x2-5 — mise 80-280$ — 25 pos — seuils +15%`);
  if (!API_KEY || !API_SECRET) logLine('\u26A0\uFE0F Cles API manquantes — lecture seule (pas d ordres).');

  // 0) LE SERVEUR HTTP DÉMARRE EN PREMIER : le dashboard s'affiche tout de suite,
  //    avant tout appel réseau. Il se remplit de données ensuite (arrière-plan).
  server.listen(PORT, '0.0.0.0', () => {
    const source = process.env.PORT ? 'Railway' : "fallback 8080 - Railway n'injecte pas PORT";
    logLine(`\u{1F310} Dashboard sur le port ${PORT} [${source}] — pret.`);
  });

  // Initialisation NON BLOQUANTE en arrière-plan.
  (async () => {
    try {
      await loadSymbolInfo();
      const uni = await scanUniverse();
      await applyUniverse(uni);
      await refreshAllKlines();
      connectPriceStreams();
      logLine('\u2705 Initialisation complete — bot pret a demarrer.');
    } catch (e) {
      logLine(`\u26A0\uFE0F Init arriere-plan: ${e.message} — dashboard actif, reessai auto.`);
    }
    syncTimeAndWarm(); // premier alignement d'horloge immédiat
    setInterval(syncTimeAndWarm, 3000); // puis toutes les 3s (poids API : 1 -> négligeable)
    setInterval(refreshAllKlines, STRAT.SIGNAL_REFRESH_MS);
    setInterval(refreshUniverse, STRAT.UNIVERSE_REFRESH_MS);
    setInterval(reconcile, 9000);
    setInterval(() => {
      if (clients.size === 0) return; // dashboard ferme -> ne pas meme construire l'overview
      // N'envoie l'overview que si son contenu a changé (évite de répéter le même
      // gros paquet toutes les 5s pour rien). Empreinte légère sur les champs utiles.
      const ov = symbolsOverview();
      const sig = ov.map((s) => `${s.symbol}${s.price}${s.bias}${s.quality}${s.regime}`).join('|');
      if (sig !== state._lastOvSig) { state._lastOvSig = sig; broadcast({ type: 'symbols', symbols: ov }); }
    }, 5000);
  })();
}

start();
