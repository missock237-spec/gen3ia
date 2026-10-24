#!/usr/bin/env python3
"""Validateur sandbox du pack gen3-visual-pack (aucun GPU requis).

Groupes de contrôles :
  1. Syntaxe AST des 6 scripts Python du pack ;
  2. Dataset curriculum (6 leçons + 2 validations, champs gen3 obligatoires) ;
  3. Médias présents, dimensions d'image ≥ 512, narrations ≤ 1024 chars ;
  4. Dataset fusionné train_visual.jsonl (18 exemples, 3 tâches, frames) ;
  5. GPU forcé : sans CUDA → RuntimeError (jamais CPU) ;
  6. Profils l4 / a100_40g : planchers VRAM, pas d'entrée CPU ;
  7. dry_run sans GPU : OK (plan sans exécution) ;
  8. professeur.py : les 3 modes s'exécutent (verifier/plan/stats) ;
  9. Anti-hallucination : chaque description ne mentionne pas « texte »
     affiché (les 6 images sont vérifiées sans écriture visible) ;
 10. Anti-fuite de tokens (ghp_/hf_/sk-) dans tout le pack.
"""
from __future__ import annotations

import ast
import json
import re
import subprocess
import sys
import types
from pathlib import Path

PACK = Path(__file__).resolve().parent.parent
SCRIPTS = [PACK / "professeur.py", PACK / "prepare_visual_dataset.py",
           PACK / "train_gen3_visuel.py", PACK / "infer_gen3_visuel.py",
           PACK / "bench_gen3_visuel.py", PACK / "scripts" / "stub_import.py"]

RESULTATS: list = []


def check(nom: str, condition: bool, detail: str = "") -> None:
    statut = "VERT" if condition else "ROUGE"
    RESULTATS.append((nom, statut, detail))
    print(f"[{statut}] {nom}" + (f" — {detail}" if detail else ""))


def lire_jsonl(chemin: Path) -> list:
    rows = []
    for i, ligne in enumerate(chemin.read_text(encoding="utf-8").splitlines(), 1):
        ligne = ligne.strip()
        if ligne:
            try:
                rows.append(json.loads(ligne))
            except json.JSONDecodeError as exc:
                raise ValueError(f"{chemin}:{i}: JSON invalide ({exc})")
    return rows


def stub_torch() -> None:
    """Importe le module de stubs du pack (torch factice, CUDA absent)."""
    chemin_stubs = PACK / "scripts"
    if str(chemin_stubs) not in sys.path:
        sys.path.insert(0, str(chemin_stubs))
    import stub_import  # noqa: E402

    stub_import.installer_stubs()


def main() -> int:
    print(f"=== Validateur gen3-visual-pack — {PACK} ===\n")

    # 1. AST ----------------------------------------------------------------
    for script in SCRIPTS:
        try:
            ast.parse(script.read_text(encoding="utf-8"))
            check(f"AST {script.name}", True)
        except SyntaxError as exc:
            check(f"AST {script.name}", False, str(exc))

    # 2. Curriculum ----------------------------------------------------------
    try:
        lecons = lire_jsonl(PACK / "data" / "lecons_images.jsonl")
        validation = lire_jsonl(PACK / "data" / "validation_visuelle.jsonl")
        check("6 leçons + 2 validations", len(lecons) == 6 and len(validation) == 2,
              f"{len(lecons)}/{len(validation)}")
        champs = ("id", "task", "instruction", "response", "image", "audio",
                  "video", "mots_cles")
        manquants = [l["id"] for l in lecons for c in champs if not l.get(c)]
        check("champs gen3 obligatoires", not manquants, ", ".join(manquants) or "6/6")
        ids = [l["id"] for l in lecons]
        check("ids uniques", len(set(ids)) == len(ids))
        vides = [l["id"] for l in lecons if len(l["response"]) < 200]
        check("descriptions riches (>200 chars)", not vides, ", ".join(vides) or "6/6")
        mc = [l["id"] for l in lecons if len(l["mots_cles"]) != 8]
        check("8 mots-clés par leçon", not mc, ", ".join(mc) or "6/6")
    except Exception as exc:  # noqa: BLE001
        check("curriculum", False, str(exc))
        return 1

    # 3. Médias ----------------------------------------------------------------
    tout_ok = True
    for l in lecons:
        for champ in ("image", "audio", "video"):
            chemin = PACK / l[champ]
            if not chemin.exists() or chemin.stat().st_size < 10_000:
                tout_ok = False
    check("18 médias présents (>10 Ko)", tout_ok)

    sys.path.insert(0, str(PACK))
    try:
        from professeur import dimensions_image  # noqa: E402
        dims_ok = True
        for l in lecons:
            w, h = dimensions_image(PACK / l["image"])
            if w < 512 or h < 512:
                dims_ok = False
        check("images ≥ 512 px (PNG/JPEG stdlib)", dims_ok, "1344x768")
    except Exception as exc:  # noqa: BLE001
        check("dimensions_image", False, str(exc))

    narr = list((PACK / "assets" / "audio" / "narrations").glob("*.txt"))
    check("6 narrations ≤ 1024 chars",
          len(narr) == 6 and all(len(n.read_text(encoding="utf-8")) <= 1024 for n in narr))

    # 4. Dataset fusionné ------------------------------------------------------
    try:
        train = lire_jsonl(PACK / "data" / "train_visual.jsonl")
        tasks = {}
        for ex in train:
            tasks[ex["task"]] = tasks.get(ex["task"], 0) + 1
        check("train_visual.jsonl 18 exemples / 3 tâches",
              len(train) == 18 and tasks == {"decrire_image": 6,
                                             "decrire_video": 6,
                                             "expliquer_lecon": 6},
              str(tasks))
        frames_manquantes = [
            ex["id"] for ex in train if ex["task"] == "decrire_video"
            for f in ex["images"] if not (PACK / f).exists()
        ]
        check("24 frames vidéo présentes", not frames_manquantes)
        valid = lire_jsonl(PACK / "data" / "validation_visual.jsonl")
        check("validation fusionnée", len(valid) == 2)
    except Exception as exc:  # noqa: BLE001
        check("dataset fusionné", False, str(exc))

    # 5-7. GPU forcé, profils, dry_run ------------------------------------------
    stub_torch()
    try:
        import train_gen3_visuel as trainer  # noqa: E402
        check("import trainer (stub torch)", True)
        try:
            trainer.select_profile("auto")
            check("sans CUDA → refus", False, "aucune erreur levée")
        except RuntimeError as exc:
            check("sans CUDA → refus", "GPU CUDA requis" in str(exc))
        profils = trainer.PROFILS_PERFORMANCE
        check("profils l4 + a100_40g uniquement",
              set(profils) == {"l4", "a100_40g"})
        check("planchers VRAM (22/36 Go)",
              profils["l4"]["vram_min_gb"] == 22
              and profils["a100_40g"]["vram_min_gb"] == 36)
        check("jamais de CPU dans les profils",
              all("cpu" not in json.dumps(p).lower() for p in profils.values()))
    except Exception as exc:  # noqa: BLE001
        check("trainer", False, str(exc))

    try:
        r = subprocess.run(
            [sys.executable, str(PACK / "scripts" / "stub_import.py"),
             str(PACK / "train_gen3_visuel.py"), "--dry_run"],
            capture_output=True, text=True, timeout=60, cwd=PACK)
        check("dry_run sans GPU OK", r.returncode == 0 and "DRY RUN OK" in r.stdout,
              (r.stdout + r.stderr).strip().splitlines()[-1] if (r.stdout or r.stderr) else "")
    except Exception as exc:  # noqa: BLE001
        check("dry_run", False, str(exc))

    # 8. professeur.py -----------------------------------------------------------
    for mode in ("verifier", "plan", "stats"):
        try:
            r = subprocess.run([sys.executable, str(PACK / "professeur.py"), mode],
                               capture_output=True, text=True, timeout=120, cwd=PACK)
            check(f"professeur.py {mode}", r.returncode == 0,
                  (r.stderr.strip().splitlines()[-1] if r.returncode else ""))
        except Exception as exc:  # noqa: BLE001
            check(f"professeur.py {mode}", False, str(exc))

    # 9. Anti-hallucination ---------------------------------------------------------
    sus = [l["id"] for l in lecons
           if re.search(r"(?i)\b(écrit|inscrit|titré|légendé)\b", l["response"])]
    check("descriptions sans « texte écrit » fantôme", not sus, ", ".join(sus) or "6/6")

    # 10. Anti-fuite de tokens -----------------------------------------------------
    fuite = []
    for f in PACK.rglob("*"):
        if f.is_file() and f.suffix in (".py", ".md", ".json", ".txt", ".sh"):
            contenu = f.read_text(encoding="utf-8", errors="ignore")
            if re.search(r"ghp_[A-Za-z0-9]{20,}|hf_[A-Za-z0-9]{30,}|sk-[A-Za-z0-9]{20,}",
                         contenu):
                fuite.append(str(f.relative_to(PACK)))
    check("aucun token en clair", not fuite, ", ".join(fuite) or "0 fuite")

    # Synthèse ------------------------------------------------------------------------
    rouges = [r for r in RESULTATS if r[1] == "ROUGE"]
    print(f"\n=== {len(RESULTATS) - len(rouges)}/{len(RESULTATS)} contrôles VERT ===")
    if rouges:
        for nom, _, detail in rouges:
            print(f"  x {nom}: {detail}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
