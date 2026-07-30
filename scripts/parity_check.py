# -*- coding: utf-8 -*-
# Parity check 3.12h -> 3.12i : extraction des fonctions par brace-balancing
# (les regex cassent sur les template literals), SHA-256 par fonction.
import hashlib, re

def extract_functions(src):
    """Extrait {nom: corps} pour les declarations `function X(` et `async function X(`.
    Brace-balancing conscient des strings, template literals et commentaires."""
    funcs = {}
    pat = re.compile(r'(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(')
    for m in pat.finditer(src):
        name = m.group(1)
        i = src.find('{', m.end() - 1)
        if i < 0: continue
        depth = 0; j = i; n = len(src)
        in_s = None  # ' " ` ou None
        while j < n:
            c = src[j]
            if in_s:
                if c == '\\': j += 2; continue
                if in_s == '`' and c == '$' and j + 1 < n and src[j+1] == '{':
                    # ${ } dans un template : balance separement
                    d2 = 1; j += 2
                    while j < n and d2 > 0:
                        if src[j] == '\\': j += 2; continue
                        if src[j] == '{': d2 += 1
                        elif src[j] == '}': d2 -= 1
                        j += 1
                    continue
                if c == in_s: in_s = None
                j += 1; continue
            if c in ('"', "'", '`'): in_s = c; j += 1; continue
            if c == '/' and j + 1 < n:
                if src[j+1] == '/':
                    j = src.find('\n', j)
                    if j < 0: j = n
                    continue
                if src[j+1] == '*':
                    j = src.find('*/', j + 2)
                    j = n if j < 0 else j + 2
                    continue
            if c == '{': depth += 1
            elif c == '}':
                depth -= 1
                if depth == 0:
                    funcs[name] = src[m.start():j+1]
                    break
            j += 1
    return funcs

import sys
if len(sys.argv) != 3:
    print('Usage: python3 parity_check.py <original.js> <patched.js>'); sys.exit(2)
orig = open(sys.argv[1], encoding='utf-8').read()
new  = open(sys.argv[2], encoding='utf-8').read()

fo = extract_functions(orig)
fn = extract_functions(new)

h = lambda s: hashlib.sha256(s.encode()).hexdigest()[:12]

identical, modified, added, removed = [], [], [], []
for name in sorted(set(fo) | set(fn)):
    if name in fo and name in fn:
        (identical if h(fo[name]) == h(fn[name]) else modified).append(name)
    elif name in fn: added.append(name)
    else: removed.append(name)

print(f"Fonctions 3.12h : {len(fo)} | 3.12i : {len(fn)}")
print(f"\nIDENTIQUES ({len(identical)}/{len(fn)}) — SHA-256 egaux")
print(f"\nMODIFIEES ({len(modified)}) :")
for x in modified: print(f"  ~ {x}   {h(fo[x])} -> {h(fn[x])}")
print(f"\nAJOUTEES ({len(added)}) :")
for x in added: print(f"  + {x}   {h(fn[x])}")
if removed:
    print(f"\nSUPPRIMEES ({len(removed)}) :")
    for x in removed: print(f"  - {x}")


print("\nPARITY CHECK : revue requise — chaque fonction MODIFIEE/AJOUTEE/SUPPRIMEE")
print("doit correspondre a un decret explicite (voir CLAUDE.md, protocole patch).")
import sys as _s
_s.exit(0 if not removed else 1)
