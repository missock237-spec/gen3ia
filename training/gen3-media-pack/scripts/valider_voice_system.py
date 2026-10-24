#!/usr/bin/env python3
"""Validateur du module voice_audio_system.py — 9/9 VERT attendu.

Vérifications (sans aucune dépendance ML — stdlib + AST uniquement) :
  1. Syntaxe AST du module complet ;
  2. Les 6 sous-commandes CLI (prepare/train/sample/sfx/memorize/clone) ;
  3. Garde GPU : `train` refuse sans CUDA (standard gen3, jamais de CPU) ;
  4. Bornes de config : sr 24 000, n_mels 80, hop 256 (HiFi-GAN v1) ;
  5. Anti-saturation : sortie Tanh bornée [-1, 1] + mel clip [0, 1] ;
  6. Stabilité numérique : clamp_min du log-mel (log 0 protégé) ;
  7. Empreintes voix : ECAPA-TDNN (speechbrain) référencé ;
  8. Vocodeur complet : Generator + MPD + ResBlock ;
  9. Anti-fuite : aucun token GitHub/HF en littéral.
"""
import ast
import re
import sys
from pathlib import Path

PACK = Path(__file__).resolve().parent.parent
MODULE = PACK / "voice_audio_system.py"

results = []


def check(nom, condition, detail=""):
    results.append((nom, bool(condition), detail))


def main():
    source = MODULE.read_text(encoding="utf-8")
    arbre = ast.parse(source)

    # 1 + 2 — structure et CLI
    fonctions = {n.name for n in ast.walk(arbre) if isinstance(n, ast.FunctionDef)}
    classes = {n.name for n in ast.walk(arbre) if isinstance(n, ast.ClassDef)}
    for cmd in ("cmd_prepare", "cmd_train", "cmd_sample", "cmd_sfx",
                "cmd_memorize", "cmd_clone"):
        check(f"commande {cmd}", cmd in fonctions)

    # 3 — garde GPU dans cmd_train
    train = next((n for n in ast.walk(arbre) if isinstance(n, ast.FunctionDef)
                  and n.name == "cmd_train"), None)
    garde = train is not None and "torch.cuda.is_available()" in ast.get_source_segment(source, train)
    check("garde GPU dans train (refus propre sans CUDA)", garde)

    # 4 — bornes de config
    check("sr 24000 (HiFi-GAN v1)", "sr=24000" in source)
    check("n_mels 80", "n_mels=80" in source)
    check("hop 256", "hop=256" in source)

    # 5 + 6 — bornes physiques présentes dans le code
    check("sortie Tanh bornée [-1, 1] (anti-saturation)", "nn.Tanh()" in source)
    check("mel normalisé clip [0, 1]", "np.clip((mel_db + 40) / 40, 0, 1)" in source)
    check("log-mel stable (clamp_min 1e-5)", "clamp_min(1e-5)" in source)

    # 7 — mémorisation ECAPA
    check("ECAPA-TDNN (speechbrain) référencé", "ecapa-voxceleb" in source)

    # 8 — vocodeur complet
    for classe in ("Generator", "MPD", "ResBlock", "DiscriminatorP"):
        check(f"classe {classe}", classe in classes)

    # 9 — anti-fuite de tokens
    fuites = re.findall(r"(ghp_[A-Za-z0-9]{20,}|hf_[A-Za-z0-9]{20,})", source)
    check("aucun token en littéral", not fuites, str(fuites[:2]))

    ok = sum(1 for _, r, _ in results if r)
    for nom, resultat, detail in results:
        statut = "VERT" if resultat else "ROUGE"
        print(f"[{statut}] {nom}" + (f" — {detail}" if detail and not resultat else ""))

    total = len(results)
    print(f"\n{ok}/{total} VERT")
    sys.exit(0 if ok == total else 1)


if __name__ == "__main__":
    main()
