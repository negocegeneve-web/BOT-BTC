# -*- coding: utf-8 -*-
# patch.py — 3.12i -> 3.12j : fix course bonus loterie (decret Calvin 30/07)
# Le verrou 1x/heure (state.lastBonusAt) est RESERVE des la retenue du signal
# bonus (symbolTick), plus a l'ouverture (tryOpen) — anti-course au demarrage.
import hashlib, io, sys

PATH = 'server.js'

def sha(b): return hashlib.sha256(b).hexdigest()

# Lecture en universal newlines (le checkout Windows est en CRLF, le canon git en LF)
with io.open(PATH, 'r', encoding='utf-8') as f:
    src = f.read()
print('SHA-256 avant :', sha(src.encode('utf-8')))

count_applied = 0
def rep(old, new, label):
    global src, count_applied
    n = src.count(old)
    assert n == 1, f'ANCRE NON UNIQUE ({label}) : {n} occurrence(s)'
    src = src.replace(old, new)
    count_applied += 1
    print(f'OK  [{label}]')

# ---- 1. Header : version + bloc decret 3.12j date, historique 3.12i conserve ----
rep(
""" *  SERVEUR 3.12i - CHAMPION  (stops natifs algoOrder / bonus x9 / garde marge)
 *  ------------------------------------------------------------
 *  Quatre decrets Calvin du 30/07 vs 3.12h :""",
""" *  SERVEUR 3.12j - CHAMPION  (fix course bonus / stops natifs algoOrder / garde marge)
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
 *  Quatre decrets Calvin du 30/07 vs 3.12h :""",
'header + decret 3.12j')

# ---- 2. symbolTick : reservation du verrou des la retenue du signal ----
rep(
"""  if (signal && !signal.filler && STRAT.BONUS_ENABLED && signal.quality >= STRAT.BONUS_MIN_Q &&
      (Date.now() - state.lastBonusAt) >= STRAT.BONUS_INTERVAL_MS) {
    signal = { ...signal, bonus: true };
  }""",
"""  if (signal && !signal.filler && STRAT.BONUS_ENABLED && signal.quality >= STRAT.BONUS_MIN_Q &&
      (Date.now() - state.lastBonusAt) >= STRAT.BONUS_INTERVAL_MS) {
    // 3.12j (decret Calvin 30/07) : verrou RESERVE ICI, avant tout await —
    // pose a l'ouverture, plusieurs symboles passaient le test simultanement.
    state.lastBonusAt = Date.now();
    signal = { ...signal, bonus: true };
  }""",
'symbolTick : reservation verrou')

# ---- 3. tryOpen : suppression de la pose redondante (verrou deja reserve) ----
rep(
"    S.position.bonus = true; state.lastBonusAt = now;",
"    S.position.bonus = true; // 3.12j : lastBonusAt deja reserve a la retenue (symbolTick)",
'tryOpen : pose redondante retiree')

# ---- 4. Badge dashboard (numero serveur + WR estime conserves) ----
rep(
"3.12i - Champion · 40 sym <span style=\"opacity:.6;font-weight:600\">· WR ~70%</span>",
"3.12j - Champion · 40 sym <span style=\"opacity:.6;font-weight:600\">· WR ~70%</span>",
'badge dashboard')

# ---- 5. Stratline statique ----
rep(
"id=\"stratline\">3.12i-Champion · bonus Q70+ x9 · mises x2 · garde marge",
"id=\"stratline\">3.12j-Champion · bonus Q70+ x9 · mises x2 · garde marge",
'stratline statique')

# ---- 6. Stratline dynamique (renderStats) ----
rep(
"$('stratline').textContent='3.12i-Champion · SL -'",
"$('stratline').textContent='3.12j-Champion · SL -'",
'stratline dynamique')

# ---- 7. Log de boot 1 ----
rep(
r"logLine(`\u{1F680} Itachi — SERVEUR 3.12i-Champion (stops natifs algoOrder / bonus x9 / garde marge — decrets Calvin 30/07)",
r"logLine(`\u{1F680} Itachi — SERVEUR 3.12j-Champion (fix course bonus / stops natifs algoOrder / garde marge — decrets Calvin 30/07)",
'log boot 1')

# ---- 8. Log de boot 2 ----
rep(
r"logLine(`\u{1F4C8} 3.12i-Champion — SL -4.5% (optimise)",
r"logLine(`\u{1F4C8} 3.12j-Champion — SL -4.5% (optimise)",
'log boot 2')

with io.open(PATH, 'w', encoding='utf-8', newline='\n') as f:
    f.write(src)

print(f'{count_applied}/8 ancres appliquees')
print('SHA-256 apres :', sha(src.encode('utf-8')))
