#!/usr/bin/env python3
"""Audit + migration chromatique exhaustive — contrat 2 couleurs gen3ia (Task 125).

Balaye app/ components/ lib/ (tsx/ts/css, hors tests) : tout hex chromatique
hors allowlist canonique est soit mappé via COULEURS_HORS_CONTRAT, soit signalé.
Les neutres (blancs, noirs, gris) sont autorisés.
"""
import pathlib
import re
import sys

RACINE = pathlib.Path("/home/z/my-project/gen3ia")
SCANNER = re.compile(r"#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b")

# Allowlist canonique (thème sombre + clair + neutres) — Task 125 globals.css
CANONIQUES = {
    # violets sombres
    "7c5cff", "9e85ff", "b9a6ff", "b18aff", "c9aeff",
    # cyans sombres
    "2ad4e8", "7fe9f5",
    # violets clairs
    "6c48ff", "5633e8", "5b2be0", "3f22c4", "40159e",
    # cyans clairs
    "0899b4", "0e5f73", "0a6e82", "095e6f",
    # fonds/textes sombres
    "05060c", "0b0d17", "f4f5fb", "c7cbe4", "9aa0c2", "6b7194",
    "0a0714", "0b0716", "e2e8f0",
    # porcelaine bleutée
    "eff7fb", "ffffff", "e3eef5", "d9e6ef", "b7d8e8",
    "101b26", "1f4e5f", "3e6478", "6e8a9b",
}

# Mapping hérité → canonique (famille la plus proche)
COULEURS_HORS_CONTRAT = {
    # violets Tailwind / hérités → violet canonique
    "8b5cf6": "#7C5CFF", "7c3aed": "#7C5CFF", "a78bfa": "#9E85FF",
    "c4b5fd": "#9E85FF", "ddd6fe": "#C9AEFF", "6d28d9": "#6C48FF",
    "5b21b6": "#5633E8", "4c1d95": "#3F22C4", "7e22ce": "#6C48FF",
    # cyans Tailwind / hérités → cyan canonique
    "22d3ee": "#2AD4E8", "67e8f9": "#7FE9F5", "a5f3fc": "#7FE9F5",
    "06b6d4": "#2AD4E8", "0891b2": "#0899B4", "155e75": "#0E5F73",
    "0e7490": "#0A6E82", "cffafe": "#7FE9F5",
    # ambre/jaune → famille violette claire (warning du contrat)
    "fde047": "#9E85FF", "f59e0b": "#9E85FF", "fbbf24": "#9E85FF",
    "facc15": "#9E85FF", "eab308": "#9E85FF", "fcd34d": "#B9A6FF",
    # verts → famille cyan claire (success du contrat)
    "34d399": "#7FE9F5", "10b981": "#2AD4E8", "059669": "#0A6E82",
    "047857": "#0A6E82", "6ee7b7": "#7FE9F5", "a7f3d0": "#7FE9F5",
    "4ade80": "#7FE9F5", "22c55e": "#2AD4E8", "16a34a": "#0A6E82",
    # roses/rouges → danger violet du contrat
    "fb7185": "#B18AFF", "f472b6": "#C9AEFF", "f43f5e": "#B18AFF",
    "e11d48": "#B18AFF", "ef4444": "#B18AFF", "dc2626": "#B18AFF",
    "fda4af": "#C9AEFF", "fecdd3": "#C9AEFF", "f87171": "#B18AFF",
    "b91c1c": "#B18AFF", "991b1b": "#B18AFF", "7f1d1d": "#B18AFF",
    "ec4899": "#B18AFF", "db2777": "#B18AFF", "f9a8d4": "#C9AEFF",
    "d64545": "#B18AFF", "fb8e96": "#B18AFF", "e0453a": "#B18AFF",
    "c94f44": "#B18AFF", "c6527a": "#B18AFF", "ef6ba0": "#C9AEFF",
    "9e4a6b": "#B18AFF", "f79aa0": "#C9AEFF", "039": "#0E5F73",
    # bleus → cyan/violet (le bleu n'existe pas dans le contrat)
    "60a5fa": "#7FE9F5", "3b82f6": "#2AD4E8", "2563eb": "#0899B4",
    "1d4ed8": "#0E5F73", "93c5fd": "#7FE9F5", "bfdbfe": "#7FE9F5",
    "dbeafe": "#7FE9F5", "6366f1": "#7C5CFF", "818cf8": "#9E85FF",
    "a5b4fc": "#9E85FF", "c7d2fe": "#C9AEFF", "e0e7ff": "#C9AEFF",
    "4f46e5": "#6C48FF", "4338ca": "#5633E8", "3730a3": "#5633E8",
    # limes → cyan
    "a3e635": "#7FE9F5", "84cc16": "#2AD4E8", "65a30d": "#0A6E82",
    "bef264": "#7FE9F5", "d9f99d": "#7FE9F5",
    # oranges → violet clair
    "fb923c": "#9E85FF", "f97316": "#9E85FF", "ea580c": "#9E85FF",
    "fed7aa": "#B9A6FF", "ffedd5": "#B9A6FF",
    # jaunes/orangés métier (billing, graphes) → famille violette
    "ffcc00": "#9E85FF", "d97706": "#9E85FF", "c8a26a": "#B9A6FF",
    "d9a441": "#9E85FF", "f2c94c": "#9E85FF", "f5a623": "#9E85FF",
    "f5d76e": "#B9A6FF", "b5543b": "#B18AFF", "f07c54": "#9E85FF",
    "f08a3c": "#9E85FF", "ffb56b": "#B9A6FF", "8a6a50": "#6E8A9B",
    "6b4a2f": "#6E8A9B", "7a4a2b": "#6E8A9B", "5a3a22": "#6E8A9B",
    "2a1b0e": "#101B26", "e8d5a8": "#B9A6FF", "e8dcc8": "#B9A6FF",
    "fff3b0": "#B9A6FF", "ffd27d": "#B9A6FF", "ffd9c0": "#B9A6FF",
    "ffb88c": "#B9A6FF",
    # verts métier → famille cyan (success du contrat)
    "1a944a": "#0A6E82", "2e9e6b": "#2AD4E8", "3fa35c": "#0A6E82",
    "2e5e4e": "#0E5F73", "9fbf7a": "#7FE9F5", "2ec4b6": "#2AD4E8",
    "5eead4": "#7FE9F5",
    # bleus métier → cyan/violet
    "2d7dd2": "#2AD4E8", "2c6fb5": "#0899B4", "4a9fe0": "#2AD4E8",
    "7ec4f2": "#7FE9F5", "8fd4f2": "#7FE9F5", "bfd9ec": "#7FE9F5",
    "bfe3ff": "#7FE9F5", "cfe8ff": "#7FE9F5", "b9d9f2": "#7FE9F5",
    "afc6de": "#7FE9F5", "c9dee8": "#7FE9F5", "8fa6c9": "#9AA0C2",
    "47526a": "#6B7194", "5a6478": "#6B7194", "3d4a6b": "#6B7194",
    "334155": "#6B7194", "475569": "#6B7194", "64748b": "#9AA0C2", "8b90ab": "#9AA0C2",
    "2e3a67": "#6B7194", "232b52": "#0B0D17", "1a2140": "#0B0D17",
    "1b4582": "#0E5F73",
    # violets proches du contrat → valeurs canoniques exactes
    "4a1fb8": "#5633E8", "7b4fd8": "#7C5CFF", "6b3fa0": "#7C5CFF",
    "a78bff": "#9E85FF", "f0abfc": "#C9AEFF", "9d8cff": "#9E85FF",
    "38bdf8": "#2AD4E8",
}

# Beiges porcelaine chaude → tokens porcelaine bleutée (thème clair global)
BEIGES_VERS_TOKENS = {
    "#e5e1d5": "var(--g3-border)",
    "#eae5d9": "var(--g3-elevated)",
    "#faf9f5": "var(--g3-bg)",
    "#f5f3ec": "var(--g3-elevated)",
    "#f0eee6": "var(--g3-elevated)",
    "#edeae0": "var(--g3-elevated)",
    "#83817a": "var(--g3-muted)",
    "#a9a79e": "var(--g3-faint)",
    "#6b695f": "var(--g3-muted)",
    "#3d3b34": "var(--g3-text-secondary)",
    "#1f1e1a": "var(--g3-deep)",
    "#d3cdbb": "var(--g3-border-strong)",
    "#ded9cb": "var(--g3-border)",
    "#c9c2ae": "var(--g3-border-strong)",
    "rgba(59,56,45,0.35)": "rgba(16,27,38,0.35)",
}

EXTENSIONS = {".tsx", ".ts", ".css"}
EXCLUS = ("__tests__", ".test.", "__fixtures__")

# Dossiers NON-UI (backend/infra) : hors contrat interface.
DOSSIERS_HORS_UI = ("/services/", "/infra/", "/training/", "/scripts/")

# Palettes de CONTENU GÉNÉRÉ (moteurs média gen3) : ce sont les couleurs de
# la PEINTURE des images/scènes produites (peaux, natures, objets), pas de
# l'interface — exemptées du contrat 2 couleurs par nature.
CONTENU_EXEMPT = (
    "/lib/neural/generation/visual-scene.ts",
    "/lib/neural/generation/snapshot.ts",
    "/lib/neural/generation/video-storyboard.ts",
    "/lib/domain/conversations/artefact-apps.ts",
    # Marque EXTERNE : le code d'embed officiel Chariow impose sa couleur
    # de marque (#ffcc00) — identité du prestataire, pas l'UI gen3ia.
    "/components/billing/chariow-widget.tsx",
)

modifies = []
for chemin in RACINE.rglob("*"):
    if chemin.suffix not in EXTENSIONS:
        continue
    s = str(chemin)
    if any(x in s for x in EXCLUS) or any(x in s for x in DOSSIERS_HORS_UI) or any(x in s for x in CONTENU_EXEMPT):
        continue
    if "node_modules" in s or "/.next/" in s:
        continue
    texte = chemin.read_text()
    original = texte
    for hexa in set(SCANNER.findall(texte)):
        cle = hexa[1:].lower()
        if cle in CANONIQUES:
            continue
        # étendre 3 → 6 pour lookup
        cle6 = cle * 3 if len(cle) == 3 else cle
        if cle6 in CANONIQUES:
            continue
        remplacement = COULEURS_HORS_CONTRAT.get(cle6)
        if remplacement is None:
            continue
        texte = texte.replace(hexa, remplacement)
    for beige, token in BEIGES_VERS_TOKENS.items():
        texte = re.sub(re.escape(beige), token, texte, flags=re.IGNORECASE)
    if texte != original:
        chemin.write_text(texte)
        modifies.append(str(chemin.relative_to(RACINE)))

print(f"{len(modifies)} fichiers migrés :")
for m in sorted(modifies):
    print(f"  - {m}")

# Second passage : signale ce qui reste hors allowlist (chromatique uniquement)
NEUTRES_OK = re.compile(r"^#(?:[0-9a-fA-F](?:[0-9a-fA-F]{5})?)$", re.I)
restants = {}
for chemin in RACINE.rglob("*"):
    if chemin.suffix not in EXTENSIONS or any(x in str(chemin) for x in EXCLUS):
        continue
    s = str(chemin)
    if any(x in s for x in DOSSIERS_HORS_UI) or any(x in s for x in CONTENU_EXEMPT):
        continue
    if "node_modules" in s or "/.next/" in s:
        continue
    for hexa in set(SCANNER.findall(chemin.read_text())):
        cle = hexa[1:].lower()
        if len(cle) == 3:
            cle = "".join(c * 2 for c in cle)
        if cle in CANONIQUES:
            continue
        r, g, b = (int(cle[i:i+2], 16) for i in (0, 2, 4))
        mx, mn = max(r, g, b), min(r, g, b)
        if mx - mn < 32:  # neutre / quasi-neutre (gris, navy très sombre) : autorisé
            continue
        restants.setdefault(hexa, []).append(str(chemin.relative_to(RACINE)))

if restants:
    print("\nHEX CHROMATIQUES RESTANTS HORS ALLOWLIST :")
    for hexa, fichiers in sorted(restants.items()):
        print(f"  {hexa} → {', '.join(sorted(set(fichiers))[:3])}")
    sys.exit(1)
print("\nCONFORMITÉ : zéro hex chromatique hors contrat.")
