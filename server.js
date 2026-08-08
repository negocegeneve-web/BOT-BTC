/* ============================================================
 *  SERVEUR 3.13e - CADRE R BIMODAL  (mode volatil / persistance / fraicheur / stats.csv)
 *  ------------------------------------------------------------
 *  Decrets Calvin du 08/08 :
 *  1. MODE VOLATIL — le cadre R devient BIMODAL. Si 1R > 5% (symbole sauvage) :
 *     partiel 60% a +0.4R, stop -0.6R, trailing 0.25R. C'est l'automatisation
 *     exacte des fermetures manuelles gagnantes de Calvin (encaisser +3-5% sans
 *     attendre un +13% improbable). Backtest chronologique : regime violent
 *     +1117$ vs +403$ et DD 9.7% vs 36.7% ; regime calme +1088$ vs +980$.
 *     Seule brique robuste sur les DEUX regimes (correlation et time-stop 12h
 *     testes et REJETES). Sous 5% de 1R : strictement rien ne change.
 *  2. PERSISTANCE state.json : capital, stats, historique et compteur de trades
 *     sauvegardes (60s + a chaque cloture), recharges au boot si MODE identique.
 *     Fini les paliers calcules sur un capital fictif apres redemarrage.
 *  3. GARDE FRAICHEUR PRIX : prix plus vieux que 15s -> aucune entree, aucun
 *     stop LOGICIEL (les stops natifs Binance couvrent). Un WebSocket gele ne
 *     fait plus decider le bot sur des prix morts.
 *  4. /stats.csv : export complet de l'historique (Excel / bilans / futur agent).
 *  5. LOGS DE REFUS (throttle 10 min/symbole) : friction, plafond de risque,
 *     prix gele — le bot dit desormais POURQUOI il n'entre pas.
 *  6. Labels natifs scindes : 'SL NATIF' / 'TP NATIF' (fini l'ambigu 'SL/TP').
 *  7. Trades NUMEROTES (#) + date/heure de fermeture dans l'historique.
 *
 *  HISTORIQUE 3.13d - CADRE R  (+ plafond de risque $ : le levier s'ajuste a la volatilite)
 *  ------------------------------------------------------------
 *  UN decret Calvin du 01/08, fix de la faille revelee par les 25 trades reels :
 *  PLAFOND DE RISQUE : mise x levier x 1R <= 1.2% du capital.
 *  Le bilan montrait TRAIL-R +35.7$ (7/7 verts) et STOP-1R -9$ (calibres), MAIS
 *  -121$ sur les stops natifs : des 1R de 7-15% (symboles ultra-volatils) pris a
 *  x3-x4 -> pertes de -24/-34/-45$ la ou un symbole calme risquait 1.20$.
 *  Rapport de risque 1:37 entre deux trades du meme bot = la promesse "chaque
 *  perte = 1R en dollars" etait cassee par le levier.
 *  La MISE reste fixee par les PALIERS (decret intact) ; c'est le LEVIER qui
 *  descend (x3 -> x2 -> x1) jusqu'a ce que le risque passe sous le plafond.
 *  Si meme x1 depasse : on ne trade pas ce signal (meme logique que la garde
 *  friction). BONUS loterie exclu du plafond (decret : bonus intouche).
 *
 *  HISTORIQUE 3.13c - CADRE R  (+ reactivite : user data stream / bookTicker WS / stops paralleles)
 *  ------------------------------------------------------------
 *  Trois ameliorations de PLOMBERIE (decret Calvin 31/07 : strategie intouchee,
 *  parity check : sizing/computeExits/managePosition SHA-256 identiques) :
 *  1. USER DATA STREAM : Binance pousse chaque execution (stops natifs inclus)
 *     en ~50ms -> reconciliation immediate (debounce 300ms) au lieu du cycle 9s.
 *     Zero logique comptable dupliquee : la reconciliation existante reste
 *     l'unique juge, on l'appelle juste plus tot. Le cycle 9s reste en filet.
 *  2. bookTicker WS : bid/ask en continu par symbole -> le garde-fou carnet a
 *     l'entree lit la memoire (0ms, flux < 5s) au lieu d'un REST ~100-300ms
 *     DANS la section a slot reserve. REST conserve en fallback.
 *  3. STOPS NATIFS SL+TP en PARALLELE : ~150-300ms gagnes par ouverture et par
 *     adoption ; la position est protegee des deux cotes plus tot.
 *
 *  HISTORIQUE 3.13b - CADRE R  (+ verrou d'entree anti-course / priorite Q / stops idempotents)
 *  ------------------------------------------------------------
 *  Trois decrets Calvin du 31/07 vs 3.13a (fix du 8/6 constate en reel) :
 *  1. VERROU D'ENTREE : cap et exposition testes AVEC les entrees "en vol",
 *     slot+mise reserves de facon SYNCHRONE avant le premier await, liberes en
 *     finally. 5 ouvertures a la meme seconde au boot avaient defonce le cap
 *     (8/6) et la garde marge (cache 10s aveugle aux mises deja parties -> -2019
 *     sur AKEUSDT malgre la garde). Meme pattern que le verrou bonus 3.12j.
 *  2. PRIORITE Q : a signaux simultanes, micro-delai (100-Q)x3 ms avant la
 *     course -> le meilleur signal reserve son slot en premier.
 *  3. STOPS NATIFS IDEMPOTENTS : deja poses au meme prix -> on ne re-pose pas
 *     (la 2e tentative post-adoption partait en -4130 sur ETHUSDT).
 *
 *  HISTORIQUE 3.13a - CADRE R  (stop ATR / partiel 1R / trail 0.5R / paliers / zero rotation)
 *  ------------------------------------------------------------
 *  Decrets Calvin du 31/07 — valides par backtest chronologique (+98% vs +0.3%,
 *  DD 10.2%, PF 1.35) ET par dissection de 40 trades reels :
 *
 *  1. STOP = 1.5 x ATR(14). Le SL -4.5% fixe valait 7.4 ATR sur BTC (jamais
 *     touche -> pourrissait en rotation) et 1.6 ATR sur DEXE (dans le bruit).
 *     Desormais 1R = "these invalidee", identique sur tous les symboles.
 *  2. PARTIEL 50% a +1R, stop du reste au BREAK-EVEN (+frais). Encaisse le
 *     mouvement reel, garantit qu'une position armee ne peut plus perdre.
 *  3. TRAILING 0.5R apres le partiel (< 1R par construction : fini les sorties
 *     "TRAILING" perdantes — 40% des sorties trailing reelles etaient negatives
 *     avec l'ancien couple arm +1% / width -1.5%, mathematiquement incoherent).
 *  4. ROTATION SUPPRIMEE : 7/10 rotations reelles declenchees entre 29.5 et
 *     31.0 min = un reveil, pas un signal. Les gagnants murissent en 96 min,
 *     la rotation les tuait a 30. En backtest : 253 rotations, 1% WR, -1108$.
 *  5. PALIERS DE MISE par capital (7 paliers, decret) + modulation ATR dans la
 *     fourchette (symbole calme -> haut de fourchette, volatil -> bas).
 *  6. GARDE FRICTION : 1R >= 6 x frais AR (0.12% mesure sur les fills reels).
 *     57% des trades reels vivaient sous 0.5% de mouvement : 2/23 gagnants,
 *     frais = 24% du resultat. On ne trade plus dans le bruit.
 *  7. JOURNAL EN R : chaque cloture logge son multiple de R.
 *
 *  HISTORIQUE 3.12j (fix course bonus / stops natifs algoOrder / garde marge)
 *  ------------------------------------------------------------
 *  Decret Calvin du 30/07 vs 3.12i :
 *
 *  1. FIX COURSE BONUS : au demarrage, plusieurs symboles pouvaient ouvrir
 *     un bonus x9 SIMULTANEMENT — le verrou 1x/heure (state.lastBonusAt)
 *     n'etait pose qu'a l'ouverture (tryOpen, apres les appels reseau),
 *     donc tous les symbolTick concurrents passaient le test d'intervalle
 *     avant la premiere pose. Desormais le verrou est RESERVE des qu'un
 *     signal bonus est retenu (symbolTick), avant tout await. Consequence
 *     assumee : bonus retenu mais ouverture echouee = slot horaire
 *     consomme (anti-course avant tout).
 *
 *  HISTORIQUE 3.12i (stops natifs algoOrder / bonus x9 / garde marge)
 *  ------------------------------------------------------------
 *  Quatre decrets Calvin du 30/07 vs 3.12h :
 *
 *  1. STOPS NATIFS ENFIN POSES : /fapi/v2/order n'existe PAS (404 non-JSON
 *     constate en reel le 30/07). Le VRAI endpoint post-migration 09/12/2025
 *     est POST /fapi/v1/algoOrder avec le schema officiel (doc "New Algo
 *     Order") : algoType:'CONDITIONAL' + champ `type` + `triggerPrice`
 *     (PAS stopPrice — c'etait la 2e cause du -1102 historique, apres
 *     `orderType`). Repli /fapi/v1/order (stopPrice) pour vieux testnet.
 *  2. PURGE ALGO COMPLETE : DELETE /fapi/v1/algoOpenOrders (annule TOUS les
 *     algo du symbole, poids 1) en filet apres l'annulation unitaire.
 *     /fapi/v2/allOpenOrders SUPPRIME (endpoint inexistant, 404).
 *  3. BONUS x15 -> x9 (decret) : trous max -40% (ONUSDT -27$ -> ~-16$ max),
 *     marge consommee -40% -> le bonus cesse d'affamer le moteur principal.
 *  4. GARDE MARGE anti -2019 : avant chaque ouverture, la marge libre REELLE
 *     du compte (GET /fapi/v2/balance, cache 10s, NaN-guard) doit couvrir
 *     stake x 1.35. Sinon : skip SANS cooldown 30 min (la marge peut se
 *     liberer a la prochaine fermeture). Fini les cascades "Margin is
 *     insufficient" qui bloquaient RIF/AKE/PEPE/ADA pendant que les x15
 *     monopolisaient le capital.
 *
 *  HISTORIQUE 3.12h (bonus Q70+ / mises x2 / fix double-comptage)
 *  ------------------------------------------------------------
 *  Trois decrets Calvin du 28/07 vs 3.12g :
 *
 *  1. BONUS ELITISTE : declenchement releve de Q>=50 a Q>=BONUS_MIN_Q (70).
 *     Moins de tickets, mieux choisis (le WR bonus constate a ~29% ne
 *     couvrait pas le seuil de rentabilite ~52% du couple SL-5%/trail).
 *  2. MISES NORMALES x2 : 80-280$ -> 160-560$ (meme moteur, meme WR 70%,
 *     gains en $ doubles). ATTENTION marge : a 6 positions pleines, le
 *     besoin peut depasser le capital -> des -2019 en serie = signal de
 *     renforcer le capital ou de redescendre les mises.
 *  3. FIX DOUBLE-COMPTAGE : la reconciliation ne comptabilise PLUS un trade
 *     dont la fermeture logicielle est en cours (pos.closing) — fini le
 *     doublon 'SL/TP NATIF'+'TRAILING'. La ligne native adopte le MEME
 *     format que closePos (investi/toFixed -> fini $NaN et % a 16 dec.),
 *     alimente le compteur bonus (BONUS-SL NATIF) et le drawdown.
 *
 *  HISTORIQUE 3.12g (BONUS avec SL -5% natif — decret Calvin 26/07)
 *  ------------------------------------------------------------
 *  Nouveau vs 3.12f (UNE seule regle changee, sur le BONUS uniquement) :
 *
 *  1. FIN DU BONUS "SANS SL" — constat reel du 26/07 : compte en marge CROSS,
 *     donc AUCUNE liquidation-plancher par position ; les bonus saignaient
 *     sans limite (EUL : -18.6% de prix = -106$ pour 38$ de mise, -2.8x).
 *     Bilan bonus sur l'echantillon : 5 pertes / 1 gain, ~-325$ net.
 *  2. NOUVELLE REGLE (decret) : SL BONUS -5% PRIX (BONUS_SL_PCT=0.05), pose
 *     NATIVEMENT sur Binance (STOP_MARKET closePosition) + doublure logicielle
 *     en secours (raison 'BONUS-SL'). A x15 : perte max ~75% de la mise
 *     (~19-37$). Le TP bonus reste le trailing logiciel (+100% de mise, rend
 *     30% du pic) — PAS de TP natif : le gain reste sans plafond.
 *  3. Moteur principal STRICTEMENT identique (SL -4.5%, trailing, cap 6).
 *
 *  HISTORIQUE 3.12f (SL/TP NATIFS Binance via /fapi/v2/order + cap 6 pos)
 *  ------------------------------------------------------------
 *  Nouveau vs 3.12e (ZERO strategie touchee — 3.12b INTACTE) :
 *
 *  1. STOPS NATIFS REPARES (enseignement v8 valide en reel) : les ordres
 *     conditionnels STOP_MARKET / TAKE_PROFIT_MARKET passent par
 *     /fapi/v2/order — champ `type` (jamais orderType), stopPrice,
 *     closePosition:'true', workingType MARK_PRICE, SANS timeInForce.
 *     L'essai /fapi/v1/algoOrder (qui echouait en -1102 : champ orderType)
 *     est abandonne ; repli /fapi/v1/order conserve (vieux testnet).
 *     Log 🛡️ a chaque pose reussie -> verification visuelle immediate.
 *  2. ADOPTION PROTEGEE : toute position reelle adoptee par la reconciliation
 *     (9s) recoit IMMEDIATEMENT son SL -4.5% + TP natifs sur Binance.
 *     Avant : seule la boucle logicielle la couvrait -> nue si le serveur
 *     tombait (cause directe des -17.6%/-9.2% du 20/07).
 *  3. PURGE ANTI-ORPHELINS etendue a /fapi/v2/allOpenOrders (pattern
 *     trade #10) — non bloquant si l'endpoint est absent.
 *  4. CAP POSITIONS 25 -> 6 (decret Calvin 20/07/2026).
 *
 *  HISTORIQUE 3.12e (fix FLUX PRIX Binance 2026 — strategie 3.12b INTACTE)
 *  ------------------------------------------------------------
 *  CORRECTIF CRITIQUE : migration WebSocket Binance Futures du 06/03/2026
 *  (routes /public /market /private ; legacy retire le 23/04/2026). L'URL
 *  legacy acceptait la connexion mais @markPrice ne poussait PLUS RIEN ->
 *  prix a zero, bot aveugle (aucune entree/sortie possible). Fix : route
 *  /market/stream + WATCHDOG 25s qui bascule de route et se reconnecte
 *  seul si le flux est muet (auto-reparation, testnet/demo inclus).
 *  ------------------------------------------------------------
 *  HISTORIQUE 3.12d (connexion DASHBOARD — strategie 3.12b INTACTE)
 *  ------------------------------------------------------------
 *  Nouveau vs 3.12c (zero strategie touchee) :
 *   - Onglets TESTNET / MAINNET + champs API Key/Secret + 🔐 Connecter
 *     DANS le dashboard (architecture v8) : plus besoin de variables
 *     d'environnement. BINANCE_MODE/CLES en env = simples defauts
 *     optionnels (reconnexion auto apres redeploiement Railway).
 *   - 🔄 Reset : remise a zero stats/trades/capital (Binance intact).
 *   - Chaque connexion remet la session a zero et repart en PAUSE.
 *   - Les cles ne quittent jamais le serveur (seul le prefixe s'affiche).
 *  ------------------------------------------------------------
 *  HISTORIQUE 3.12c (moteur allege — strategie 3.12b INTACTE)
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
 *   - 1 position par symbole (One-Way), jusqu'à 6 positions en parallèle (3.12f)
 *   - Exposition notionnelle bornée par MAX_EXPOSURE_PCT (garde-fou, levier inclus)
 *   - Frais Binance intégrés dans le P&L (maker à l'entrée si possible, taker en sortie)
 *   - Bougies 1h (analyse) + 2h (régime ADX), indicateurs réactifs recalculés au tick
 *
 * Tous les paramètres ajustables sont en haut du fichier.
 */

'use strict';

const http = require('http');
const fs = require('fs'); // 3.13e : persistance state.json
const crypto = require('crypto');
const WebSocket = require('ws');

// ==================================================================
// CONFIG GÉNÉRALE
// ==================================================================
// 3.12d : MODE + CLES choisis depuis le DASHBOARD (onglets TESTNET/MAINNET + champs
// cles + bouton Connecter). Les variables d'environnement sont OPTIONNELLES :
//  - BINANCE_MODE : pre-selectionne l'onglet au boot (defaut testnet)
//  - BINANCE_API_KEY / BINANCE_API_SECRET : si presentes, RECONNEXION AUTOMATIQUE
//    apres un redeploiement/crash Railway. Sinon : recoller les cles dans le
//    dashboard a chaque redemarrage (les stops NATIFS Binance protegent les
//    positions pendant ce temps — jamais nu).
let MODE = (process.env.BINANCE_MODE || 'testnet').toLowerCase();
if (MODE !== 'mainnet') MODE = 'testnet';
let API_KEY = process.env.BINANCE_API_KEY || '';
let API_SECRET = process.env.BINANCE_API_SECRET || '';
const CAPITAL_START = parseFloat(process.env.CAPITAL || '1000');
const PORT = parseInt(process.env.PORT || '8080', 10);

let REST_BASE, WS_BASE;
function applyMode(mode) {
  MODE = mode === 'mainnet' ? 'mainnet' : 'testnet';
  const isT = MODE !== 'mainnet';
  REST_BASE = isT ? 'https://demo-fapi.binance.com' : 'https://fapi.binance.com';
  WS_BASE = isT ? 'wss://demo-fstream.binance.com' : 'wss://fstream.binance.com';
  // NB : state.mode est mis a jour par l'APPELANT (init de `state` au chargement,
  // connectBinance au runtime) — toucher `state` ici leverait une TDZ au boot.
}
applyMode(MODE);
const KLINE_BASE = 'https://fapi.binance.com'; // bougies TOUJOURS mainnet (testnet pauvre en historique)

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
  TRAIL_ARM: 0.010,     // (3.13a : conserve pour compat affichage — la gestion passe au cadre R)
  TRAIL_PCT: 0.015,     // (3.13a : idem — voir ATR_SL_MULT/TRAIL_R ci-dessous)

  // --- 3.13a CADRE R (decrets Calvin 31/07) ---
  ATR_SL_MULT: 1.5,     // 1R = 1.5 x ATR(14) 1h — plage 1.0-2.5 toute rentable au backtest (pas d'optimum fragile)
  PARTIAL_AT_R: 1.0,    // prise partielle a +1R
  PARTIAL_FRAC: 0.5,    // 50% de la position encaissee au partiel
  TRAIL_R: 0.5,         // trailing 0.5R apres partiel (< 1R par construction)
  FRICTION_RT: 0.0012,  // frais aller-retour reels mesures (taker 2x0.045% + slippage ~0.03%)
  FRICTION_MIN_R: 6,    // 1R doit valoir >= 6x la friction, sinon on ne trade pas ce symbole
  STAKE_PALIERS: [      // [capital_max, mise_min, mise_max] — decret Calvin (7 paliers)
    [800, 50, 100], [2200, 100, 175], [4000, 175, 290], [5000, 290, 445],
    [12000, 445, 800], [35000, 1650, 3250], [Infinity, 1650, 5000],
  ],
  ATR_MOD_LO: 0.006, ATR_MOD_HI: 0.029, // bornes de modulation ATR dans la fourchette du palier
  RISK_CAP_PCT: 0.012,  // 3.13d : plafond de risque par trade = mise x levier x 1R <= 1.2% du capital
  // --- 3.13e MODE VOLATIL (decret 08/08, backtest bimodal valide) ---
  VOL_R_PCT: 0.05,        // seuil : 1R > 5% du prix => mode volatil
  VOL_PARTIAL_AT_R: 0.4,  // partiel des +0.4R (encaisse les +3-5% frequents)
  VOL_PARTIAL_FRAC: 0.6,  // 60% encaisses au partiel
  VOL_STOP_R: 0.6,        // stop initial -0.6R (on ne laisse pas courir -13%)
  VOL_TRAIL_R: 0.25,      // TP suiveur serre apres partiel
  PRICE_STALE_MS: 15000,  // 3.13e : prix plus vieux que 15s = gele -> pas de decision logicielle
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
  SCALE_OUT: null,              // 3.13a : remplace par le PARTIEL a +1R du cadre R

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
  STAKE_MIN_USD: 160, // decret Calvin 28/07 : mises normales x2 (etait 80)
  STAKE_MAX_USD: 560, // decret Calvin 28/07 : mises normales x2 (etait 280)
  Q_FOR_MAX_STAKE: 80,  // Q>=80 -> mise max 280$ ; interpolation lineaire depuis 80$

  // --- Positions & risque ---
  MAX_POSITIONS_CAP: 6, // decret Calvin 20/07/2026 : 6 positions simultanees MAX (etait 25)
  MAX_EXPOSURE_PCT: 6.0, // exposition relevee a 600% (garde-fou)

  // --- ROTATION DE CAPITAL : fermer un mini-perdant essouffle pour un slot EXCELLENT ---
  ROTATION_ENABLED: false,      // 3.13a : SUPPRIMEE (decret 31/07) — 7/10 rotations reelles = horloge 30 min, tuait les gagnants (96 min de maturation moyenne)
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
  //     Mise 25-50$, levier x9 (decret 30/07, etait x15), SL -5% prix (3.12g).
  //     Texte historique (pre-3.12g) : AUCUN stop-loss (la LIQUIDATION ~-1/levier de prix
  //     est le plancher naturel -> perte max = la mise). Un TP s'arme a +100% de la
  //     mise (= +1/levier de prix), PUIS un trailing large laisse courir (ferme si le
  //     gain rend 30% de son pic). Backtest mai : perdant (-65$/mois a x15) -> pari
  //     pour marches AGITES uniquement, COMPTEUR SEPARE, bouton dashboard, OFF possible.
  BONUS_ENABLED: true,
  BONUS_INTERVAL_MS: 3600000,   // 1 bonus par heure maximum
  BONUS_MIN_Q: 70,              // decret Calvin 28/07 : bonus reserve aux signaux d'elite (etait 50)
  BONUS_STAKE_MIN_USD: 25,
  BONUS_STAKE_MAX_USD: 50,
  BONUS_STAKE_PCT: 0.03,        // ~3% du capital, borne 25-50$
  BONUS_LEV: 9,                 // decret Calvin 30/07 : x15 -> x9 (trous et marge -40% ; etait 15, "moins destructeur du range x12-20 au backtest" mais saignait en reel)
  BONUS_SL_PCT: 0.05,           // decret Calvin 26/07 : SL -5% PRIX sur le bonus (= ~-45% de la mise a x9, etait ~-75% a x15). Fin du "sans SL" : en marge cross, pas de liquidation-plancher -> perte illimitee constatee.
  BONUS_TP_ARM_STAKE: 1.00,     // le trailing s'arme quand le gain atteint +100% de la mise
  BONUS_TRAIL_GIVEBACK: 0.30,   // apres armement : ferme si le gain rend 30% de son pic (laisse courir)
  MARGIN_GUARD: true,           // 3.12i : refuse d'ouvrir si la marge libre Binance < stake x buffer (stop aux -2019 en cascade)
  MARGIN_BUFFER: 1.35,          // marge initiale requise ~= stake (qty*px/lev = stake) ; on exige 35% d'air en plus
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

// 3.12d : remise a ZERO de la session (stats, trades, capital, compteurs, etat
// interne des symboles). NE TOUCHE PAS Binance : les positions reelles restent
// ouvertes avec leurs stops natifs, et la reconciliation (9s) les re-ADOPTE au
// cycle suivant si elles existent. Le bot repart en PAUSE.
function resetState(keepLog) {
  state.running = false;
  state.capital = CAPITAL_START;
  state.capitalStart = CAPITAL_START;
  state.peakCapital = CAPITAL_START;
  state.maxDrawdown = 0;
  state.killed = false;
  state.trades = [];
  state.tradeSeq = 0; // 3.13e : numerotation des trades (#N, persiste)
  state.stats = { wins: 0, losses: 0, gross: 0, fees: 0, net: 0 };
  state.bonusStats = { wins: 0, losses: 0, net: 0, count: 0 };
  state.lastBonusAt = 0;
  state.consecLosses = 0;
  state.openTimestamps = [];
  state._lastOvSig = null;
  if (!keepLog) state.log = [];
  for (const s of Object.keys(state.sym)) {
    const S = state.sym[s];
    S.position = null; S.busy = false; S.lastEntryAt = 0; S.lastStopAt = 0;
    S.disabled = false; S.lastRotationAt = 0; S._levSet = null;
  }
}

// 3.12d : connexion demandee depuis le dashboard — applique le mode, pose les
// cles, remet la session a zero et re-initialise tout sur les nouvelles bases.
let _connectBusy = false;
async function connectBinance(mode, key, secret) {
  if (_connectBusy) { logLine('⏳ Connexion deja en cours...'); return; }
  _connectBusy = true;
  try {
    state.running = false; // securite : on repart toujours en PAUSE
    applyMode(mode);
    state.mode = MODE;
    API_KEY = (key || '').trim();
    API_SECRET = (secret || '').trim();
    resetState(true);
    logLine(`🔐 Connexion ${MODE.toUpperCase()} — cle ${API_KEY ? API_KEY.slice(0, 8) + '…' : 'ABSENTE (lecture seule)'} — session remise a zero.`);
    await syncTimeAndWarm();
    await loadSymbolInfo();
    const uni = await scanUniverse();
    await applyUniverse(uni);
    // Reconnexion FORCEE du flux prix sur la base WS du nouveau mode :
    if (priceWs) { const old = priceWs; priceWs = null; try { old.close(); } catch (e) {} }
    connectPriceStreams();
    startUserDataStream(); // 3.13c : flux prive (non bloquant, no-op sans cles)
    await refreshAllKlines();
    logLine(`✅ ${MODE.toUpperCase()} pret — ${ALL_SYMBOLS.length} symboles — clique ▶ Demarrer pour armer.`);
  } catch (e) {
    logLine(`⚠️ connexion: ${e.message}`);
  } finally { _connectBusy = false; }
  broadcast({ type: 'snapshot', data: snapshot() });
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
  // 3.13a CADRE R : 1R = ATR_SL_MULT x ATR(14) du symbole. Le meme stop signifie
  // la meme chose partout (BTC 0.6%/h vs DEXE 2.8%/h : facteur 4.6x — un %
  // fixe etait soit dans le bruit, soit inatteignable). Fallback SL_PCT si ATR absent.
  const sw = state.sym[symbol] && state.sym[symbol].swing;
  const a = sw && Number.isFinite(sw.atrPct) ? sw.atrPct : null;
  if (a && a > 0) {
    const r = STRAT.ATR_SL_MULT * a;
    return { slPct: r, tpPct: STRAT.TP_SOFT_CAP, rPct: r, source: 'atr' };
  }
  return { slPct: STRAT.SL_PCT, tpPct: STRAT.TP_SOFT_CAP, rPct: STRAT.SL_PCT, source: 'swing-fallback' };
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
function sizing(signal, symbol) {
  if (signal.bonus) {
    // BONUS LOTERIE : mise petite (25-50$), levier x9 (decret 30/07).
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
  // 3.13a PALIERS (decret Calvin) : fourchette de mise selon le capital, puis
  // MODULATION ATR a l'interieur : symbole calme -> haut de fourchette, volatil -> bas.
  // (Compromis valide au backtest : +80% en respectant les paliers, DD -4 pts vs mise fixe.)
  let smin = 50, smax = 100;
  for (const [cmax, lo, hi] of STRAT.STAKE_PALIERS) {
    if (state.capital <= cmax) { smin = lo; smax = hi; break; }
  }
  const sw = symbol && state.sym[symbol] && state.sym[symbol].swing;
  const a = sw && Number.isFinite(sw.atrPct) ? sw.atrPct : null;
  let stake;
  if (a != null) {
    let z = (a - STRAT.ATR_MOD_LO) / (STRAT.ATR_MOD_HI - STRAT.ATR_MOD_LO);
    z = Math.max(0, Math.min(1, z));
    stake = smax - (smax - smin) * z;
  } else {
    stake = (smin + smax) / 2;
  }
  const lev = levForQuality(signal.quality);
  return { stake: Math.round(stake), lev };
}

// 3.12i : marge libre USDT REELLE du compte (Binance = source de verite), cache 10s
// pour ne pas marteler l'API a chaque tentative d'ouverture. NaN-guard obligatoire
// (pattern TIME_OFFSET : UNE reponse malformee ne doit jamais empoisonner l'etat).
// Retourne null si l'API est muette -> la garde se neutralise (non bloquant).
let _freeMarginCache = { at: 0, val: null };
async function freeMarginUSDT() {
  const now = Date.now();
  if (now - _freeMarginCache.at < 10000) return _freeMarginCache.val;
  try {
    const bals = await signedRequest('GET', '/fapi/v2/balance', {});
    const usdt = Array.isArray(bals) ? bals.find((b) => b && b.asset === 'USDT') : null;
    const v = usdt ? parseFloat(usdt.availableBalance) : NaN;
    _freeMarginCache = { at: now, val: Number.isFinite(v) ? v : null };
  } catch (e) { _freeMarginCache = { at: now, val: null }; }
  return _freeMarginCache.val;
}

// 3.13b : SLOTS & MISES RESERVES — entrees "en vol" entre la decision et la
// confirmation de l'ordre. symbolTick tourne en CONCURRENCE (appels sans await) :
// tout test cap/marge effectue avant un await reseau est perime a l'execution.
// Reservation SYNCHRONE (aucun await entre test et reservation) + liberation en
// finally : la fenetre de course est fermee par construction.
function reservedSlots() { return state._resSlots || 0; }
function reservedStakeUSD() { return state._resStake || 0; }
function reserveEntry(stake) {
  state._resSlots = (state._resSlots || 0) + 1;
  state._resStake = (state._resStake || 0) + stake;
}
function releaseEntry(stake) {
  state._resSlots = Math.max(0, (state._resSlots || 0) - 1);
  state._resStake = Math.max(0, (state._resStake || 0) - stake);
}

// ================== 3.13e : PERSISTANCE state.json ==================
// Capital, stats, historique et compteur survivent aux redemarrages du process.
// Ecriture atomique (tmp+rename), rechargement au boot si MODE identique.
// NaN-guard sur tout ce qui est numerique (pattern TIME_OFFSET).
const STATE_FILE = './state.json';
function saveState() {
  try {
    const snap = {
      v: '3.13e', mode: MODE, savedAt: Date.now(),
      capital: state.capital, peakCapital: state.peakCapital,
      maxDrawdown: state.maxDrawdown, tradeSeq: state.tradeSeq || 0,
      consecLosses: state.consecLosses || 0,
      stats: state.stats, bonusStats: state.bonusStats,
      trades: (state.trades || []).slice(0, 100),
    };
    fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(snap));
    fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
  } catch (e) { /* disque indisponible : non bloquant */ }
}
function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return false;
    const d = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (!d || d.mode !== MODE) return false; // testnet/mainnet : jamais melanges
    const num = (x, fb) => (Number.isFinite(x) ? x : fb);
    state.capital = num(d.capital, state.capital);
    state.peakCapital = num(d.peakCapital, state.peakCapital);
    state.maxDrawdown = num(d.maxDrawdown, 0);
    state.tradeSeq = num(d.tradeSeq, 0);
    state.consecLosses = num(d.consecLosses, 0);
    if (d.stats) state.stats = d.stats;
    if (d.bonusStats) state.bonusStats = d.bonusStats;
    if (Array.isArray(d.trades)) state.trades = d.trades.slice(0, 100);
    logLine(`\u{1F4BE} État restauré depuis state.json — capital $${state.capital.toFixed(2)}, ${state.trades.length} trades, compteur #${state.tradeSeq}.`);
    return true;
  } catch (e) { return false; }
}

// 3.13e : LOG DE REFUS throttle (10 min / symbole) — le bot dit pourquoi il n'entre pas.
function logSkip(S, symbol, msg) {
  const now = Date.now();
  if (!S._skipLogAt || now - S._skipLogAt > 600000) {
    S._skipLogAt = now;
    logLine(`\u23ED\uFE0F ${symbol} sauté : ${msg}`);
  }
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

  const sz = sizing(signal, symbol);
  const stake = sz.stake;
  let lev = sz.lev; // 3.13d : le levier peut etre reduit par le plafond de risque

  // 3.13a GARDE FRICTION : si 1R (stop ATR) ne vaut pas au moins 6x les frais
  // aller-retour, le trade est un pile-ou-face a esperance negative (57% des
  // trades reels vivaient sous 0.5% de mouvement : 2/23 gagnants). On skip.
  // 3.13e GARDE FRAICHEUR : prix gele (WS silencieux > 15s) -> aucune entree.
  if (!S.priceAt || Date.now() - S.priceAt > STRAT.PRICE_STALE_MS) {
    logSkip(S, symbol, `prix gelé depuis ${S.priceAt ? Math.round((Date.now() - S.priceAt) / 1000) : '?'}s — entrée refusée`);
    return;
  }
  const exitsPre = computeExits(symbol);
  if (exitsPre.rPct < STRAT.FRICTION_MIN_R * STRAT.FRICTION_RT) {
    logSkip(S, symbol, `friction (1R ${(exitsPre.rPct * 100).toFixed(2)}% < ${STRAT.FRICTION_MIN_R}× frais ${(STRAT.FRICTION_RT * 100).toFixed(2)}%)`);
    return;
  }

  // 3.13d PLAFOND DE RISQUE $ (decret 01/08) : mise x levier x 1R <= 1.2% du
  // capital. Les paliers fixent la mise ; le LEVIER s'ajuste a la volatilite.
  // Un 1R de 15% a x3 sur 100$ risquait 45$ quand un 1R de 1.2% a x2 sur 50$
  // risquait 1.20$ — rapport 1:37, promesse "perte = 1R" cassee. Bonus exclu.
  if (!signal.bonus) {
    const riskCap = state.capital * STRAT.RISK_CAP_PCT;
    while (lev > 1 && stake * lev * exitsPre.rPct > riskCap) lev--;
    if (stake * lev * exitsPre.rPct > riskCap) {
      logSkip(S, symbol, `plafond risque (1R ${(exitsPre.rPct * 100).toFixed(1)}% × mise ${stake}$ = ${(stake * exitsPre.rPct).toFixed(1)}$ > ${riskCap.toFixed(1)}$ même à ×1)`);
      return;
    }
  }

  // 3.13b PRIORITE Q : a signaux simultanes (typique au boot), le meilleur Q
  // attend le moins longtemps et reserve son slot en premier. Q85 -> 45ms,
  // Q50 -> 150ms. Douce, sans coordination centrale, suffisante pour ordonner.
  await new Promise((r) => setTimeout(r, Math.max(0, (100 - (signal.quality || 0)) * 3)));
  if (!state.running || S.position || S.disabled) return; // re-check post-delai

  // 3.13b : cap teste AVEC les entrees en vol (reservees, pas encore visibles
  // dans openPositionsCount) — c'est le trou par lequel le 8/6 est passe.
  if (openPositionsCount() + reservedSlots() >= STRAT.MAX_POSITIONS_CAP) {
    if (STRAT.ROTATION_ENABLED && signal.quality >= STRAT.ROTATION_MIN_Q) {
      const victim = findRotationCandidate(symbol);
      if (victim) {
        logLine(`🔁 ROTATION : fermeture ${victim} (essoufflé) pour libérer un slot -> ${symbol} Q${signal.quality}.`);
        state.sym[victim].lastRotationAt = Date.now();
        await closePos(victim, 'ROTATION');
      } else { return; }
    } else { return; }
  }
  if (currentExposure() + reservedStakeUSD() + stake > state.capital * STRAT.MAX_EXPOSURE_PCT) return;

  // 3.13b : RESERVATION SYNCHRONE (aucun await entre les tests ci-dessus et cette
  // ligne). Tout ce qui suit est couvert par le finally de liberation.
  reserveEntry(stake);
  try {

  // 3.12i GARDE MARGE : la marge initiale requise ~= stake (qty*px/lev = stake).
  // Si la marge libre REELLE du compte ne couvre pas stake x BUFFER, l'ordre
  // partirait en -2019 "Margin is insufficient" -> on skip SANS poser le cooldown
  // 30 min (la marge peut se liberer a la prochaine fermeture, inutile de punir le
  // symbole). Log throttle 60s pour ne pas inonder le journal.
  if (STRAT.MARGIN_GUARD && API_KEY && API_SECRET) {
    const free = await freeMarginUSDT();
    // 3.13b : la marge (cache 10s) doit couvrir TOUTES les mises en vol (la
    // notre incluse via reservedStakeUSD) — le cache ne voit pas les ordres
    // partis il y a <10s, la reservation comble cet angle mort (-2019 AKEUSDT).
    if (free != null && free < Math.max(stake, reservedStakeUSD()) * STRAT.MARGIN_BUFFER) {
      if (!state._marginLogAt || now - state._marginLogAt > 60000) {
        state._marginLogAt = now;
        logLine(`\u26D4 marge libre ${free.toFixed(0)}$ < requise ~${Math.round(stake * STRAT.MARGIN_BUFFER)}$ — ouverture ${symbol} sautée (garde anti--2019).`);
      }
      return;
    }
  }

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
    // 3.13c : lecture memoire si le flux bookTicker est frais (<5s) -> 0ms au lieu
    // d'un REST ~100-300ms DANS la section a slot reserve. Meme test, memes seuils.
    let bid, ask;
    if (S.book && S.book.at && Date.now() - S.book.at < 5000) {
      bid = S.book.bid; ask = S.book.ask;
    } else {
      const bt = await publicGet(REST_BASE, '/fapi/v1/ticker/bookTicker', { symbol });
      bid = parseFloat(bt.bidPrice); ask = parseFloat(bt.askPrice);
    }
    const spread = (bid > 0 && ask > 0) ? (ask - bid) / ((ask + bid) / 2) : Infinity;
    if (!(bid > 0) || !(ask > 0) || spread > 0.01) {
      S.disabled = true;
      logLine(`🚫 ${symbol} exclu : carnet ${MODE} sans contrepartie exploitable (bid=${bid||'-'} ask=${ask||'-'}, spread ${isFinite(spread)?(spread*100).toFixed(2)+'%':'∞'}) — position serait infermable.`);
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
    entryFill,
    // 3.13e MODE VOLATIL : 1R > 5% -> stop initial ressere a -0.6R (natif inclus).
    volMode: exits.rPct > STRAT.VOL_R_PCT,
    slPct: (exits.rPct > STRAT.VOL_R_PCT) ? exits.rPct * STRAT.VOL_STOP_R : exits.slPct,
    tpPct: exits.tpPct,
    rPct: exits.rPct, partialDone: false, // 3.13a cadre R
    sl: signal.side === 'BUY'
      ? entry * (1 - ((exits.rPct > STRAT.VOL_R_PCT) ? exits.rPct * STRAT.VOL_STOP_R : exits.slPct))
      : entry * (1 + ((exits.rPct > STRAT.VOL_R_PCT) ? exits.rPct * STRAT.VOL_STOP_R : exits.slPct)),
    tp: signal.side === 'BUY' ? entry * (1 + exits.tpPct) : entry * (1 - exits.tpPct),
    openedAt: now, peakPnl: 0, scaleDone: [],
  };
  S.lastEntryAt = now;
  if (!state.openTimestamps) state.openTimestamps = [];
  state.openTimestamps.push(now); // compteur du plancher (heure glissante, tous symboles)
  if (signal.bonus) {
    S.position.bonus = true; // 3.12j : lastBonusAt deja reserve a la retenue (symbolTick)
    // 3.12g (decret Calvin) : le bonus a desormais un SL -5% PRIX. Fini le "sans SL" :
    // en marge CROSS il n'y a pas de liquidation-plancher -> perte illimitee constatee.
    S.position.slPct = STRAT.BONUS_SL_PCT;
    S.position.sl = signal.side === 'BUY' ? entry * (1 - STRAT.BONUS_SL_PCT) : entry * (1 + STRAT.BONUS_SL_PCT);
  }
  const f = S.swing.funding != null ? ` funding=${(S.swing.funding*100).toFixed(3)}%` : '';
  const fTag = signal.filler ? ' [comblement]' : '';
  logLine(`🟢 ${symbol} ${signal.side} qty=${qty} @ ${entry.toFixed(4)} x${lev} Q=${signal.quality} via=${signal.via || 'BB'} SL-${(exits.slPct*100).toFixed(1)}%${f} [${entryFill}]${fTag}`);
  // Poser les stops natifs sur Binance (protection 24/7). 3.12g : le BONUS aussi
  // recoit son SL natif -5% (decret Calvin) — mais PAS de TP natif (son TP est le
  // trailing logiciel arme a +100% de la mise, sans plafond de gain).
  await placeExchangeStops(symbol);
  broadcast({ type: 'positions', positions: livePositions() });

  // 3.13b : fin du bloc reserve — liberation dans le finally ci-dessous.
  } finally {
    releaseEntry(stake);
  }
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
  if (reason === 'STOP-LOSS' || reason === 'STOP-1R') S.lastStopAt = Date.now();
  if (state.capital > state.peakCapital) state.peakCapital = state.capital;
  const dd = (state.peakCapital - state.capital) / state.peakCapital;
  if (dd > state.maxDrawdown) state.maxDrawdown = dd;

  state.tradeSeq = (state.tradeSeq || 0) + 1; // 3.13e : numerotation
  state.trades.unshift({
    n: state.tradeSeq, closedAt: Date.now(),
    symbol, side: pos.side, entry: pos.entry, exit, lev: pos.lev, quality: pos.quality,
    investi: pos.stake.toFixed(2), pnlPct: (pnlPct * 100).toFixed(2),
    gross: gross.toFixed(2), fees: fees.toFixed(2), net: net.toFixed(2),
    reason, durationMs: Date.now() - pos.openedAt,
  });
  if (state.trades.length > 100) state.trades.pop();
  try { saveState(); } catch (e) {} // 3.13e : persistance a chaque cloture

  const rMult = (pos.rPct && pos.rPct > 0) ? (pnlPct / pos.rPct) : null; // 3.13a journal en R
  logLine(`🔴 ${symbol} ${reason} @ ${exit.toFixed(4)} | ${rMult != null ? (rMult >= 0 ? '+' : '') + rMult.toFixed(2) + 'R | ' : ''}net=${net.toFixed(2)}$ | capital=${state.capital.toFixed(2)}$`);
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
  // 3.12i Filet 1 : annulation GLOBALE des algo du symbole via l'endpoint officiel
  // DELETE /fapi/v1/algoOpenOrders (poids 1) — attrape tout algo residuel que la
  // boucle unitaire ci-dessus aurait manque. Non bloquant si absent (vieux testnet).
  try { await signedRequest('DELETE', '/fapi/v1/algoOpenOrders', { symbol }); } catch (e) {}
  // Filet 2 : purge aussi les ordres classiques éventuels (anciennes versions).
  try { await signedRequest('DELETE', '/fapi/v1/allOpenOrders', { symbol }); } catch (e) {}
  // (3.12i) /fapi/v2/allOpenOrders SUPPRIME : endpoint inexistant (404 constate en reel le 30/07).
}

// STOP-LOSS / TAKE-PROFIT NATIFS via /fapi/v1/algoOrder (3.12i — fix definitif 30/07).
// Migration Binance 09/12/2025 : les conditionnels (STOP_MARKET/TAKE_PROFIT_MARKET)
// sont REJETES sur /fapi/v1/order (-4120) et /fapi/v2/order N'EXISTE PAS (404 non-JSON
// constate en reel — l'erreur de la 3.12f). Le VRAI endpoint est POST /fapi/v1/algoOrder,
// schema officiel (doc "New Algo Order") : algoType:'CONDITIONAL' + champ `type` (jamais
// orderType, cause du -1102 historique) + `triggerPrice` (PAS stopPrice, 2e cause du
// -1102) + closePosition:'true' + workingType:'MARK_PRICE', SANS timeInForce.
// Repli /fapi/v1/order (ancien schema stopPrice) conserve pour vieux testnet. Si tout
// echoue : SL LOGICIEL (managePosition, tick ~1s) en secours. Jamais nu tant que le bot tourne.
async function placeExchangeStops(symbol) {
  const S = state.sym[symbol];
  const pos = S && S.position;
  if (!pos) return 0;
  // 3.12g : le bonus a desormais un SL natif -5% (decret Calvin 26/07). Seul le TP
  // natif reste exclu pour lui (TP = trailing logiciel +100% de mise, sans plafond).
  const closeSide = pos.side === 'BUY' ? 'SELL' : 'BUY';
  const slPrice = roundPrice(symbol, pos.sl);
  const tpPrice = roundPrice(symbol, pos.tp);
  // 3.13b IDEMPOTENCE : stops deja poses a CE prix -> ne pas re-poser (la 2e
  // tentative post-adoption partait en -4130 sur ETHUSDT le 31/07). La purge et
  // la re-pose n'ont lieu que si le SL a effectivement bouge (BE, trailing).
  if (pos.exchangeStops && pos.exchangeSlPrice === slPrice) return 1;
  await cancelAlgoStops(symbol); // purge anti-doublon (au trailing, pos.sl a pu bouger)
  const placeNative = async (orderType, triggerPrice) => {
    // Essai 1 : /fapi/v1/algoOrder — endpoint OFFICIEL des conditionnels depuis la
    // migration 09/12/2025. Schema exact (doc "New Algo Order") : algoType CONDITIONAL,
    // champ `type`, `triggerPrice` (PAS stopPrice), closePosition, workingType MARK_PRICE.
    try {
      await signedRequest('POST', '/fapi/v1/algoOrder', {
        algoType: 'CONDITIONAL', symbol, side: closeSide, type: orderType,
        triggerPrice: triggerPrice, closePosition: 'true', workingType: 'MARK_PRICE',
      });
      logLine(`\u{1F6E1}\uFE0F ${symbol} ${orderType} NATIF posé sur Binance @ ${triggerPrice} (algo)`);
      return true;
    } catch (e1) {
      // Essai 2 (repli) : /fapi/v1/order, ANCIEN schema (stopPrice) — uniquement pour
      // les vieux environnements testnet pre-migration.
      try {
        await signedRequest('POST', '/fapi/v1/order', {
          symbol, side: closeSide, type: orderT
