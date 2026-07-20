# Itachi — Serveur 3.12c « Champion » (Binance USDⓈ-M Futures)

Bot de trading algorithmique **swing mean-reversion multi-régime**, 100 % côté serveur
(Node.js, fichier unique `server.js`, dashboard intégré). Déployé sur Railway,
connecté à Binance Futures (testnet ou mainnet).

> ⚠️ **Avertissement** — Trading à effet de levier sur cryptomonnaies : risque de
> perte totale du capital. Les performances passées (backtest ou live) ne préjugent
> pas des performances futures. Ce logiciel est fourni tel quel, sans aucune garantie.

---

## 1. Performance validée (origine du « Champion »)

| Mesure | Valeur | Nature |
|---|---|---|
| Indice (P&L par trade, non composé) | **+388 %** | Backtest **mai + juin 2026** (seule config validée sur 2 mois) |
| Win rate | **70,2 %** | idem |
| Gain moyen / trade | **+1,38 %** | idem |
| Portefeuille réel simulé 1 000 $ | ~+33 % /mois (SL −4,5 %) · +77,1 % /mois (SL −5 %, mai seul) | Marge limitée, frais inclus |

Courbe SL mesurée (mai, indice) : −2 % → +421 · −2,5 % → +433 · −4 % → +598 ·
**−4,5 % → optimum retenu** · −5 % → +599 · −6 % → +482. Le stop large n'est touché
que par les vrais retournements (33 stops vs 135 à −2 %).

## 2. Ce qu'est le 3.12c

**Stratégie 3.12b strictement intacte** — parité SHA-256 vérifiée sur les 27 fonctions
de décision et de calcul (computeSignal, sizing, bollinger, rsi, adx, tryOpen,
closePos, stops natifs…). Seul le **moteur** a été allégé :

1. **Télémétrie coupée à la source sans spectateur** : quand aucun dashboard n'est
   connecté, plus aucune construction d'objets ni `JSON.stringify` (overview 5 s,
   positions 2 s, snapshot 5 min, logs). À la (re)connexion, le client reçoit le
   snapshot complet — rien n'est perdu. Gain CPU principal en 24/7 autonome.
2. **`refreshLiveIndicators`** : fenêtre bornée à 20 valeurs au lieu de copier
   ~100 closes à chaque tick × 40 symboles. Parité numérique prouvée
   (5 000 cas aléatoires, égalité stricte `===`).
3. **`tradesLastHour`** : purge en place, zéro allocation par évaluation.
4. **Sparkline** : construction directe des 40 points (au lieu de 60 + slice).

## 3. Stratégie (résumé)

| Descriptif | Valeur |
|---|---|
| Type | Swing mean-reversion **multi-régime** |
| Horizon | Bougies 1h (analyse) + 2h dérivées (régime) |
| Régime | **ADX 2h** : RANGE → MR 2 sens · UP → longs seuls · DOWN → shorts seuls |
| Voies d'entrée | Bollinger 20/2 · VWAP glissant 24h ±σ · Support/Résistance · Points Pivots (seuils +15 %) |
| Stop-loss | **−4,5 %** prix (optimum backtest) — natif Binance (STOP_MARKET algo) |
| Trailing | Armé **+1 %**, largeur **−1,5 %** du pic (laisse courir, borne 24 h) |
| Scaling out | +10 % → ferme 34 % · +20 % → ferme 50 % du reste |
| Time-stop stagnant | **OFF** (le SL seul gère — enseignement backtest) |
| Mises | **80–280 $** proportionnelles à Q · comblement 65–85 $ ×2 |
| Levier | **×2 → ×5** selon qualité Q (75+→×5, 60+→×4, 45+→×3) |
| Positions | **25 max** · exposition ≤ 600 % · MIN_GAP 30 min/symbole · cooldown 1 h après stop |
| Univers | 5 noyau + 35 volatils · volume 24h ≥ 100 M$ · spread carnet réel ≤ 0,15 % (mainnet) |
| Protections | Kill −25 % · coupe-circuit 5 pertes consécutives · rotation de capital Q≥68 |
| Entrée | Maker-first (GTX, fenêtre 7 s) · taker seulement si dérive ≤ 0,3 % |
| Bonus loterie | **ON** — 1×/h, 25–50 $, ×15, sans SL, trailing après +100 % mise. ⚠️ Backtest mai : **perdant** (−65 $/mois à ×15 ; jusqu'à −270 $/mois selon config) — pari marchés agités, compteur séparé, toggle dashboard |
| Architecture | **Binance = source de vérité** (réconciliation 9 s, adoption des positions orphelines, fantômes comptabilisés) |

## 4. Déploiement Railway

**Fichiers** : `server.js` + `package.json` (dépendance unique `ws`). Région conseillée :
**EU West (Amsterdam)**. Whitelister les IP statiques sortantes du service sur la clé
API Binance (une IP manquante = erreur `-2015`).

**Variables d'environnement** :

| Variable | Défaut | Rôle |
|---|---|---|
| `BINANCE_MODE` | `testnet` | `testnet` ou `mainnet` |
| `BINANCE_API_KEY` / `BINANCE_API_SECRET` | vide | Clé API (permissions **Reading + Futures uniquement**, jamais retrait). Sans clés : lecture seule |
| `CAPITAL` | `1000` | Capital de référence ($) pour kill switch et stats |
| `PORT` | injecté par Railway | Port HTTP du dashboard |

**Compte Binance requis** : mode **One-way**, marge **Isolated**, **Single-Asset**.

**⚠️ Méthode de mise à jour du fichier** (~110 Ko) : GitHub **« Add file → Upload
files »** ou éditeur web **desktop** (Ctrl+A, Ctrl+V). **Jamais** de copier-coller
depuis mobile : troncature ~102 Ko → `SyntaxError` → crash loop Railway.

## 5. Utilisation

- **Dashboard** : URL Railway → boutons ▶ Démarrer / ⏸ Pause / ⏹ Tout fermer,
  toggles 🔧 Assoupli · 🎯 Plancher 4/h · 🎰 Bonus, clôture manuelle par position
  (champ %, confirmation 2 taps). Le bot démarre **en PAUSE** : cliquer ▶.
- **Endpoints** : `/` dashboard · `/health` sonde JSON · `/state` snapshot complet.
- **Protections natives** : SL + TP posés **sur Binance** (endpoint algo, repli
  ancien endpoint) — actifs même si le serveur tombe. SL logiciel en secours.

## 6. Décrets & protocole (immuables sans approbation)

- Aucun paramètre `STRAT` ne se modifie **sans backtest préalable** (sauf « Go code »).
- Mesurer **~20 trades** avant tout jugement ou ajustement.
- Titre du dashboard = **numéro de serveur + WR estimé** (ici : 3.12c · WR ~70 %).
- Livraison = **fichier complet**, jamais de diff ; chaîne : `node --check` →
  parité SHA fonctions stratégiques → boot réel + `/health`.

## 7. Empreintes (intégrité)

| Fichier | SHA-256 |
|---|---|
| `server.js` (3.12c) | `b86228677be82ed3be688ad899312da16ebe24880dfc1b8ce6c489a604463a32` |
| `server.js` (3.12b d'origine) | `b3e163f6b2a71b915418fdb34ba06cf6847d1fbdd41503d630760622d16ce971` — branche `main` du repo |
| `package.json` | `93f6a2adc6c2bc00a673b731aae1a09fc47995f08d3e80ffa9d623dec7982067` |

## 8. Historique

- **3.12c** (2026-07-20) — moteur allégé, stratégie intacte (parité prouvée).
- **3.12b** (2026-07-03) — SL −4,5 % (optimum), bonus loterie, fix −4120 (endpoint algo).
- **3.12** — Champion SL −5 %, plancher, SL/TP natifs.
- **3.11 → 3.5** — lignée swing multi-régime (VWAP, S/R, pivots, réconciliation).
