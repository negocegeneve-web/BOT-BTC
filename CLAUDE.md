# CLAUDE.md — BOT-BTC (CryptoSignal AI · Champion 3.12x)

Constitution du repo. Claude Code lit ce fichier à chaque session. Tout ce qui est
marqué **DÉCRET** est immuable sans instruction explicite de Calvin (Itachi).

## Langue & registre
- Travailler **en français exclusivement**.
- Registre : rigueur mathématique, posture de trader expérimenté, réponses précises
  avec sources. "CV" = compte-rendu court. "Décret" = décision immuable.

## Architecture (vérités absolues)
- Bot Node.js **mono-fichier `server.js`**, zéro dépendance npm hors `ws` et modules natifs.
- Déployé sur **Railway EU West (Amsterdam)** — région obligatoire (blocage Binance sinon).
- **Binance = source de vérité absolue** : réconciliation toutes les 9 s via
  `/fapi/v2/positionRisk`. Ne JAMAIS supposer l'état interne juste.
- Clés API en **RAM uniquement** — re-saisie obligatoire après chaque redéploiement.
- IPs statiques Railway à whitelister : `152.55.184.240`, `208.77.244.240`, `208.77.244.241`.
- Node v18.20.8 sur Railway → syntaxe ES2022 max.

## DÉCRETS stratégie (immutables)
- Référence backtest : **Champion 3.12b** — SL −4.5%, +388% index, WR 70.2% (mai+juin 2026).
- SL −4.5% · trailing arm +1% / width −1.5% · time-stop OFF · MIN_GAP 30 min/symbole.
- Régime ADX 2h : RANGE→mean-reversion bidirectionnel / UP→longs / DOWN→shorts.
- Signaux BB + VWAP + S/R + Pivots, seuils +15%, bougies 1h + dérivés 2h.
- Levier ×2-5 selon qualité Q · cap **6 positions** · VOL_CONFIRM désactivé.
- Bonus loterie : Q≥70, mise 25-50$, **levier ×9** (décret 30/07), SL natif −5% prix.
- Garde marge anti -2019 : marge libre Binance ≥ stake × 1.35 avant toute ouverture.
- **Ne jamais** : forcer les entrées, assouplir les seuils en marché plat, SL −2%
  (tous démontrés inférieurs par backtest).

## Endpoints Binance (post-migration 09/12/2025)
- Ordres conditionnels (STOP_MARKET / TAKE_PROFIT_MARKET) : **POST /fapi/v1/algoOrder**
  avec `algoType:'CONDITIONAL'`, champ `type` (jamais `orderType`), **`triggerPrice`**
  (jamais `stopPrice`), `closePosition:'true'`, `workingType:'MARK_PRICE'`, SANS timeInForce.
- `/fapi/v1/order` rejette les conditionnels en -4120. **`/fapi/v2/order` N'EXISTE PAS** (404).
- Annulation algo : DELETE `/fapi/v1/algoOrder` (unitaire) + DELETE `/fapi/v1/algoOpenOrders`
  (globale par symbole). Liste : GET `/fapi/v1/openAlgoOrders`.
- Erreur -2015 → vérifier whitelist IP. -2014 → sanitizer cleanKey. -2019 → marge insuffisante.
- Tout parse numérique de réponse Binance : guard `Number.isFinite` obligatoire
  (pattern NaN-poisoning du TIME_OFFSET).

## Protocole de modification (OBLIGATOIRE)
1. Toute modification passe par un **patch Python anchor-replacement**
   (`str.replace` + `assert count == 1` par ancre). Jamais d'édition à la main sans ancre.
2. Chaîne de validation avant toute livraison / tout push :
   ```
   python3 patch.py && node --check server.js && python3 scripts/parity_check.py <orig> server.js && node scripts/boot_test.js
   ```
3. Parity check : SHA-256 **au niveau fonction** (parser brace-balancing, jamais de
   regex — les template literals cassent les regex). Chaque fonction modifiée doit
   être explicitement décrétée ; zéro modification collatérale tolérée.
4. Livraisons : **fichiers complets, jamais de diffs**.
5. Incrémenter la version (3.12x) dans : header, badge dashboard, stratlines
   (statique + dynamique), logs de boot. Le badge du dashboard affiche toujours
   **numéro de serveur + WR estimé**.
6. Historique des versions précédentes conservé dans le header (jamais supprimé).

## Déploiement
- Push sur `main` → Railway redéploie automatiquement.
- Si upload manuel : GitHub "Add file → Upload files" depuis **desktop uniquement**
  (mobile tronque à ~102 KB → SyntaxError).
- Après déploiement : re-saisir les clés API mainnet, vérifier dans le journal les
  lignes `🛡️ ... NATIF posé sur Binance @ ... (algo)`.
- Protocole d'évaluation : **~20 trades propres** (sans fermeture manuelle) avant
  tout jugement ou retouche de paramètres.

## Commandes utiles
- Vérif syntaxe : `node --check server.js`
- Validation complète : `bash scripts/validate.sh`
- Le kill switch Railway (redéploiement) laisse les ordres natifs Binance actifs :
  les positions restent protégées pendant la pause.
