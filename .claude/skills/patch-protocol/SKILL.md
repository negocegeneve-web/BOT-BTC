---
name: patch-protocol
description: Protocole obligatoire pour toute modification de server.js (bot trading BOT-BTC). Utiliser ce skill dès qu'une modification de code du bot est demandée — patch par ancres Python, vérification syntaxe, parity check SHA-256 au niveau fonction, boot test. Jamais de diff, jamais d'édition sans ancre unique.
---

# Patch Protocol — BOT-BTC

## Quand l'utiliser
À CHAQUE modification de `server.js`, sans exception, même pour un changement d'une ligne.

## Étapes

### 1. Écrire `patch.py`
- Une fonction `rep(old, new, label)` avec `assert src.count(old) == 1` — ancre unique obligatoire.
- Les ancres reprennent le texte source EXACT (attention : le fichier mélange
  emojis littéraux et escapes `\u{...}` — vérifier avec `grep -n | cat -A` en cas de doute).
- Afficher le SHA-256 avant/après du fichier complet.
- Incrémenter la version 3.12x partout : header (+ bloc décrets daté), badge
  dashboard (garder « numéro serveur · WR ~xx% »), stratline statique, stratline
  dynamique (renderStats), les deux logs de boot (start).

### 2. Chaîne de validation (tout doit être vert)
```bash
cp <original> server.js
python3 patch.py
node --check server.js
python3 scripts/parity_check.py <original> server.js
node scripts/boot_test.js
```

### 3. Parity check
- Parser brace-balancing (conscient des strings, template literals, `${}`, commentaires).
  JAMAIS de regex pour délimiter les fonctions.
- SHA-256 par fonction. Sortie : identiques / modifiées / ajoutées / supprimées.
- Chaque fonction modifiée doit correspondre à un décret explicite. Une modification
  non listée = échec, on recommence.

### 4. Boot test
- Démarrer `node server.js` sans clés API, réseau potentiellement coupé.
- Critères : zéro crash, HTTP 200 sur `/`, bannière de la nouvelle version dans stdout.
- `npm install ws` si absent de l'environnement de test (présent sur Railway).

### 5. Livraison
- Fichier `server.js` COMPLET (jamais de diff), taille vérifiée (`wc -c`).
- CV : liste des décrets appliqués + résultats de la chaîne + compte
  identiques/modifiées/ajoutées du parity check.

## Interdits
- Modifier un paramètre stratégique décrété sans instruction explicite.
- `stopPrice` sur `/fapi/v1/algoOrder` (c'est `triggerPrice`).
- Toute référence à `/fapi/v2/order` ou `/fapi/v2/allOpenOrders` (inexistants).
- Parse numérique de réponse Binance sans `Number.isFinite`.
