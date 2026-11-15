#!/usr/bin/env python3
"""Benchmark gen3 — performances et temps de réponse en conditions réelles.

Simule le fonctionnement réel du projet : charge le modèle (base seule ou
base + adaptateur), exécute le jeu golden (60 tâches équilibrées sur les 5
familles), mesure les temps de réponse (préremplissage, génération, jetons/s,
p50/p95) et calcule des scores de qualité automatiques par famille :

  - couverture lexicale   : part des mots-clés de la référence retrouvés ;
  - validité JSON         : pour les tâches d'extraction structurée ;
  - structure attendue    : numérotations/listes pour plans, storyboards… ;
  - respect de la consigne: pas d'affirmation de génération de média réel.

Rapport : console + ``bench_report.json`` (lisible par la plateforme).

Exemples :
  python bench_multimodal.py --adapter outputs/gen3-core-lora/final_adapter
  python bench_multimodal.py --comparer  # base seule VS base+adaptateur
"""
import argparse
import gzip
import json
import re
import time
from pathlib import Path

import torch
from transformers import AutoProcessor, BitsAndBytesConfig, Gemma3ForConditionalGeneration
from peft import PeftModel

GOLDEN = Path(__file__).parent / "data" / "golden_bench.jsonl.gz"
MAX_NEW_TOKENS = 400


def charger_golden():
    op = gzip.open if GOLDEN.suffix == ".gz" else open
    with op(GOLDEN, "rt", encoding="utf-8") as f:
        return [json.loads(l) for l in f if l.strip()]


def score_exemple(rec: dict, sortie: str) -> dict:
    """Scores heuristiques d'un exemple (aucune donnée externe requise)."""
    ref = rec.get("response") or ""
    famille = rec.get("task_family", "?")
    mots_ref = {m for m in re.findall(r"\w{5,}", ref.lower())} - STOP_MOTS
    mots_sortie = set(re.findall(r"\w{5,}", sortie.lower()))
    couverture = len(mots_ref & mots_sortie) / max(len(mots_ref), 1)

    json_valide = None
    if famille == "text_instruction" and "extraction" in (rec.get("task") or ""):
        m = re.search(r"[\[{].*[\]}]", sortie, re.DOTALL)
        if m:
            try:
                json.loads(m.group(0))
                json_valide = True
            except Exception:
                json_valide = False
        else:
            json_valide = False

    structure = None
    if famille in ("text_instruction", "video_storyboard_specification"):
        marqueurs = len(re.findall(r"(?:^|\n)\s*(?:\d+[).]|[-*•])", sortie))
        structure = marqueurs >= 3

    honnetete = not re.search(
        r"(voici (?:l'?)?(?:image|vidéo|audio) (?:générée|créée)|fichier (?:vidéo|audio) joint)",
        sortie, re.IGNORECASE)

    return {
        "task_family": famille,
        "task": rec.get("task", ""),
        "couverture_lexicale": round(couverture, 3),
        "json_valide": json_valide,
        "structure_ok": structure,
        "honnetete_ok": honnetete,
    }


STOP_MOTS = {"propose", "devrait", "permet", "exemple", "besoin", "besoins", "avant",
             "après", "entre", "aussi", "ainsi", "donc", "toutefois", "ensuite"}


def charger_modele(base, adapter=None):
    compute_dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
    qconfig = BitsAndBytesConfig(
        load_in_4bit=True, bnb_4bit_quant_type="nf4",
        bnb_4bit_use_double_quant=True, bnb_4bit_compute_dtype=compute_dtype,
    )
    t0 = time.time()
    model = Gemma3ForConditionalGeneration.from_pretrained(
        base, quantization_config=qconfig, torch_dtype=compute_dtype, device_map="auto",
    )
    if adapter:
        model = PeftModel.from_pretrained(model, adapter)
    model.eval()
    processor = AutoProcessor.from_pretrained(adapter or base)
    print(f"Modèle prêt en {time.time() - t0:.1f} s ({base}{' + adaptateur' if adapter else ''}).")
    return model, processor


@torch.no_grad()
def executer_jeu(model, processor, golden, etiquete=""):
    latences, vitesses, resultats = [], [], []
    for i, rec in enumerate(golden, 1):
        blocs = [f"Tâche: {rec['task']}", f"Instruction: {rec['instruction']}"]
        if rec.get("input_text"):
            blocs.append(f"Entrée: {rec['input_text']}")
        msgs = [{"role": "user", "content": [{"type": "text", "text": "\n".join(blocs)}]}]
        prompt = processor.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True)
        inputs = processor(text=[prompt], return_tensors="pt").to(model.device)

        torch.cuda.synchronize()
        t1 = time.time()
        _ = model(**inputs)
        torch.cuda.synchronize()
        t2 = time.time()
        sortie_ids = model.generate(**inputs, max_new_tokens=MAX_NEW_TOKENS,
                                    do_sample=True, temperature=0.7, top_p=0.9)
        torch.cuda.synchronize()
        t3 = time.time()
        nouvelle = sortie_ids[0][inputs["input_ids"].shape[1]:]
        n_tokens = int(nouvelle.shape[0])
        latences.append((t2 - t1, t3 - t2))
        vitesses.append(n_tokens / max(t3 - t2, 1e-6))
        sortie = processor.decode(nouvelle, skip_special_tokens=True)
        resultats.append(score_exemple(rec, sortie))
        if i % 10 == 0 or i == len(golden):
            print(f"  {etiquete} {i}/{len(golden)} tâches évaluées…", flush=True)
    return latences, vitesses, resultats


def resumer(latences, vitesses, resultats, etiquete) -> dict:
    pref = sorted(l[0] for l in latences)
    gen = sorted(l[1] for l in latences)
    vit = sorted(vitesses)

    def pct(v, p):
        return v[min(len(v) - 1, max(0, int(round(p / 100 * len(v))) - 1))] if len(v) > 1 else (v[0] if v else 0.0)

    familles = {}
    for r in resultats:
        f = familles.setdefault(r["task_family"], {"n": 0, "couverture": [], "json": [], "structure": [], "honnetete": []})
        f["n"] += 1
        f["couverture"].append(r["couverture_lexicale"])
        if r["json_valide"] is not None:
            f["json"].append(1.0 if r["json_valide"] else 0.0)
        if r["structure_ok"] is not None:
            f["structure"].append(1.0 if r["structure_ok"] else 0.0)
        f["honnetete"].append(1.0 if r["honnetete_ok"] else 0.0)

    par_famille = {
        k: {
            "n": v["n"],
            "couverture_lexicale": round(sum(v["couverture"]) / max(len(v["couverture"]), 1), 3),
            "json_valide": round(sum(v["json"]) / max(len(v["json"]), 1), 3) if v["json"] else None,
            "structure_ok": round(sum(v["structure"]) / max(len(v["structure"]), 1), 3) if v["structure"] else None,
            "honnetete": round(sum(v["honnetete"]) / max(len(v["honnetete"]), 1), 3),
        }
        for k, v in familles.items()
    }
    return {
        "configuration": etiquete,
        "n_exemples": len(resultats),
        "latence_preremplissage_p50_s": round(pct(pref, 50), 3),
        "latence_preremplissage_p95_s": round(pct(pref, 95), 3),
        "latence_generation_p50_s": round(pct(gen, 50), 3),
        "latence_generation_p95_s": round(pct(gen, 95), 3),
        "debit_p50_jetons_s": round(pct(vit, 50), 1),
        "debit_p95_jetons_s": round(pct(vit, 95), 1),
        "scores_par_famille": par_famille,
        "couverture_globale": round(
            sum(f["couverture_lexicale"] for f in par_famille.values()) / max(len(par_famille), 1), 3),
    }


def afficher(r: dict):
    print(f"\n=== Rapport : {r['configuration']} ===")
    print(f"  Temps de réponse (n={r['n_exemples']}) :")
    print(f"    préremplissage  p50 {r['latence_preremplissage_p50_s']:.2f} s | p95 {r['latence_preremplissage_p95_s']:.2f} s")
    print(f"    génération      p50 {r['latence_generation_p50_s']:.2f} s | p95 {r['latence_generation_p95_s']:.2f} s")
    print(f"    débit           p50 {r['debit_p50_jetons_s']:.1f} jetons/s | p95 {r['debit_p95_jetons_s']:.1f} jetons/s")
    print(f"  Couverture lexicale globale : {r['couverture_globale']*100:.1f}%")
    print("  Par famille :")
    for fam, s in r["scores_par_famille"].items():
        extra = f" | JSON {s['json_valide']*100:.0f}%" if s["json_valide"] is not None else ""
        print(f"    {fam:32s} couv. {s['couverture_lexicale']*100:5.1f}%{extra} "
              f"| honnêteté {s['honnetete']*100:.0f}%")


def main():
    ap = argparse.ArgumentParser(description="Benchmark gen3 — temps de réponse + qualité")
    ap.add_argument("--adapter", default=None)
    ap.add_argument("--base_model", default="google/gemma-3-4b-it")
    ap.add_argument("--comparer", action="store_true",
                    help="Évalue base seule PUIS base+adaptateur, et compare")
    ap.add_argument("--sortie", default="bench_report.json")
    args = ap.parse_args()

    if not torch.cuda.is_available():
        raise RuntimeError("GPU CUDA requis pour le benchmark (L4/A100).")
    golden = charger_golden()
    print(f"Jeu golden : {len(golden)} tâches équilibrées sur 5 familles.")

    rapports = []
    if args.comparer and args.adapter:
        m, p = charger_modele(args.base_model)
        rapports.append(resumer(*executer_jeu(m, p, golden, "[base]"), "base seule (sans adaptateur)"))
        afficher(rapports[-1])
        del m, p
        torch.cuda.empty_cache()
        m, p = charger_modele(args.base_model, args.adapter)
        rapports.append(resumer(*executer_jeu(m, p, golden, "[adapte]"), "base + adaptateur gen3"))
        afficher(rapports[-1])
    else:
        m, p = charger_modele(args.base_model, args.adapter)
        rapports.append(resumer(*executer_jeu(m, p, golden, "[gen3]"), "gen3 (base + adaptateur)"))
        afficher(rapports[-1])

    Path(args.sortie).write_text(json.dumps({"date": time.strftime("%Y-%m-%d %H:%M:%S"),
                                             "goldens": len(golden), "rapports": rapports},
                                            ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nRapport enregistré : {args.sortie}")


if __name__ == "__main__":
    main()
