#!/usr/bin/env python3
"""Bench visuel de gen3 — mesure honnête de l'élève (GPU requis).

Pour chaque leçon du cours : gen3 produit une description de l'image, et le
bench calcule :
  - la couverture des mots-clés attendus (mots_cles de la leçon) ;
  - la longueur de la réponse (mots) ;
  - la latence et la vitesse de génération (tokens/s).

Résultats → bench_visual_results.json. AUCUN chiffre n'est inventé : tout
provient de l'exécution réelle. Sans adaptateur, passe --modele pour bencher
la base (comparaison avant/après entraînement).

Usage :
    python bench_gen3_visuel.py --adaptateur outputs/gen3-visual-lora/final_adapter
    python bench_gen3_visuel.py --modele google/gemma-3-4b-it   # base seule
"""
import argparse
import json
import time
import unicodedata
from pathlib import Path

from PIL import Image

from infer_gen3_visuel import charger, repondre  # même chargement GPU

PACK = Path(__file__).resolve().parent
INSTRUCTION = ("Décris cette image en français, de façon précise et organisée.")


def normaliser(texte: str) -> str:
    texte = unicodedata.normalize("NFD", texte.lower())
    texte = "".join(c for c in texte if unicodedata.category(c) != "Mn")
    for p in (",", ".", ";", ":", "!", "?", "«", "»", "(", ")", "'"):
        texte = texte.replace(p, " ")
    return " ".join(texte.split())


def couverture(reponse: str, mots_cles: list) -> tuple:
    rep = normaliser(reponse)
    trouves = [m for m in mots_cles if normaliser(m) in rep]
    return trouves, round(len(trouves) / max(1, len(mots_cles)), 3)


def main():
    ap = argparse.ArgumentParser(description="Bench visuel gen3")
    ap.add_argument("--adaptateur", default=None)
    ap.add_argument("--modele", default=None)
    ap.add_argument("--max_nouveaux", type=int, default=320)
    ap.add_argument("--sortie", default="bench_visual_results.json")
    args = ap.parse_args()

    if not args.adaptateur and not args.modele:
        raise SystemExit("Passe --adaptateur ... ou --modele ... (base).")

    model, processor = charger(args.adaptateur or "(aucun)", args.modele)

    lecons = []
    with (PACK / "data" / "lecons_images.jsonl").open(encoding="utf-8") as f:
        for ligne in f:
            if ligne.strip():
                lecons.append(json.loads(ligne))

    resultats = []
    total_couverture = 0.0
    total_latence = 0.0
    total_mots = 0

    print(f"\n=== Bench visuel — {len(lecons)} leçons ===")
    for lec in lecons:
        image = Image.open(PACK / lec["image"]).convert("RGB")
        t0 = time.time()
        reponse = repondre(model, processor, image, INSTRUCTION,
                           args.max_nouveaux)
        latence = time.time() - t0
        n_tokens = len(processor(text=[reponse], return_tensors="pt")["input_ids"][0])
        trouves, ratio = couverture(reponse, lec["mots_cles"])
        resultats.append({
            "id": lec["id"],
            "titre": lec["titre"],
            "mots_cles_attendus": lec["mots_cles"],
            "mots_cles_trouves": trouves,
            "couverture": ratio,
            "mots_reponse": len(reponse.split()),
            "latence_s": round(latence, 2),
            "tokens_par_s": round(n_tokens / max(latence, 1e-6), 1),
            "reponse": reponse,
        })
        total_couverture += ratio
        total_latence += latence
        total_mots += len(reponse.split())
        print(f"  {lec['id']}: couverture {ratio:.0%} "
              f"({len(trouves)}/{len(lec['mots_cles'])}), "
              f"{latence:.1f}s, {len(reponse.split())} mots")

    synthese = {
        "date": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "modele": args.modele or "adaptateur:" + str(args.adaptateur),
        "n_lecons": len(lecons),
        "couverture_moyenne": round(total_couverture / len(lecons), 3),
        "latence_moyenne_s": round(total_latence / len(lecons), 2),
        "mots_moyens_reponse": round(total_mots / len(lecons), 1),
        "limites": [
            "la couverture de mots-clés mesure le rappel d'éléments attendus, "
            "pas la qualité stylistique ;",
            "6 leçons = petite échelle ; les chiffres sont indicatifs ;",
            "aucune comparaison n'est valable sans le même modèle de base.",
        ],
        "resultats": resultats,
    }
    sortie = PACK / args.sortie
    sortie.write_text(json.dumps(synthese, ensure_ascii=False, indent=2),
                      encoding="utf-8")
    print(f"\nCouverture moyenne : {synthese['couverture_moyenne']:.0%} — "
          f"latence moyenne {synthese['latence_moyenne_s']}s")
    print(f"Résultats écrits : {sortie.name}")


if __name__ == "__main__":
    main()
