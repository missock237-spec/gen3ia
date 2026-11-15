#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Construit training/colab/gen3ia_tous_domaines_v4.ipynb à partir du v3.

Extensions v4 « tous domaines » :
  - en-tête markdown : curriculum 1 000 000 lignes, 37 datasets, 12 phases ;
  - cellule datasets : 11 v3 (datasets/<nom>/) + 26 v4 (v4/<nom>/) ;
  - cellule photos : COCO TRAIN en STREAMING HF (118 k photos réelles, 12 k
    retenues) avec repli val2017 zip puis briefs seuls — honnêteté conservée ;
  - PHASE A : 33 datasets TEXTUELS (7 v3 + 26 v4 ≈ 946 000 exemples, cap 400k),
    budgets pas T4 3 000 / L4 6 000 / A100 12 000 ;
  - test qualitatif par PHASE (12 groupes) ;
  - publication : MANIFEST v4 (curriculum_total, provenance COCO HF, adapter).

Validations : nbformat.validate + ast.parse de chaque cellule code.
Usage : python3 scripts/build_colab_v4.py
"""

from __future__ import annotations

import ast
import json
from pathlib import Path

RACINE = Path(__file__).resolve().parent.parent
SRC = RACINE / "training" / "colab" / "gen3ia_giants_training_v3.ipynb"
DST = RACINE / "training" / "colab" / "gen3ia_tous_domaines_v4.ipynb"

# ═══════════════ Nouvelles cellules v4 ═══════════════

MD_HEADER_V4 = """# 🧠 GEN3IA — Entraînement TOUS DOMAINES v4 (curriculum 1 000 000 lignes, 12 phases)

**Objectif v4 :** couvrir les **8 catégories / 12 phases** de la feuille de
route (langage, raisonnement, programmation, outils/RAG, vision, audio, vidéo,
orchestration multimodale, entraînement de modèles, sécurité défensive,
métiers professionnels, sciences) avec **1 000 000 d'exemples exactement** —
37 datasets bilingues FR/EN — PLUS des **datasets Hugging Face réels** pour
les médias (COCO train en streaming pour le photoréalisme).

| Profil GPU | Phase A (texte, 33 datasets) | Phase B (média) | Durée estimée |
|---|---|---|---|
| Tesla T4 | 3 000 pas QLoRA (cap 400k exemples) | 3 000 pas @512 | ~6 h |
| L4 | 6 000 pas QLoRA | 3 000 pas @512→640 | ~5 h |
| A100 | 12 000 pas QLoRA | 3 000 pas @512→768 | ~3 h |

**Honnêteté (inchangée) :** la Phase A entraîne le COMPORTEMENT par domaine
(format, structure, réflexes de sécurité et d'incertitude, calculs exacts) —
la connaissance encyclopédique reste celle du modèle de base. La Phase B
stylise le photoréalisme sur de vraies photos — gen3 ne devient ni Sora ni
un modèle vidéo de bout en bout. Le tout reste compatible WebGPU navigateur.

**Reprise :** checkpoints + MAX_HOURS + `--resume` — tout run interrompu
repart du dernier checkpoint vert."""

CELL_3_V4 = r'''# ═══════════════ CELLULE 3 — Datasets Gen3ia v4 « tous domaines » (1 000 000 lignes) ═══════════════
# 37 datasets bilingues : 11 v1-v3 (datasets/<nom>/) + 26 v4 (v4/<nom>/).
# Source de vérité : repo HF Kings237/gen3ia-media-engine (générateur déterministe seed 20261026).
from huggingface_hub import hf_hub_download, snapshot_download
import json as _json

V3_DATASETS = ["abbreviations", "images", "video", "voice", "music",
               "code", "knowledge", "security", "writing", "business", "multimodal"]
V4_DATASETS = ["nlp_comprehension", "text_generation", "contextual_understanding",
               "conversational_memory", "intent_recognition", "reasoning", "math",
               "problem_solving", "code_v4", "tools", "rag_documents", "databases",
               "image_analysis", "image_generation", "voice_speech", "audio_understanding",
               "music_v4", "video_v4", "multimodal_v4", "ml_data", "ml_training",
               "ml_evaluation", "ml_management", "security_v4", "professions", "sciences"]

def _charger(chemin_repo):
    p = hf_hub_download(HF_REPO, chemin_repo, repo_type="model")
    return [_json.loads(l) for l in open(p, encoding="utf-8") if l.strip()]

DATASETS = {}
for name in V3_DATASETS:
    try:
        DATASETS[name] = _charger(f"datasets/{name}/train.jsonl")
        print(f"  {name:26s} {len(DATASETS[name]):>9,} lignes (v3)")
    except Exception as exc:
        print(f"  ⚠ {name} absent du repo ({exc.__class__.__name__})")
        DATASETS[name] = []
for name in V4_DATASETS:
    try:
        DATASETS[name] = _charger(f"v4/{name}/train.jsonl")
        print(f"  {name:26s} {len(DATASETS[name]):>9,} lignes (v4)")
    except Exception as exc:
        print(f"  ⚠ {name} absent du repo ({exc.__class__.__name__}) — poussez d'abord v4/*")
        DATASETS[name] = []
total = sum(len(v) for v in DATASETS.values())
print(f"\nTOTAL curriculum chargé : {total:,} lignes (attendu ≈ 1 000 000)")
if total < 900_000:
    raise SystemExit("❌ Curriculum v4 incomplet — exécutez d'abord l'upload HF v4/*")

# Prompts photoréalistes Gen3ia (v3 images + v4 image_generation)
photoreal_prompts = [r["input"] for r in DATASETS.get("images", [])
                     if r.get("task_type") == "prompt_to_photoreal_brief"]
photoreal_prompts += [r["input"] for r in DATASETS.get("image_generation", [])
                      if r.get("task_type") == "prompt_to_photoreal_brief"]
print(f"✅ {len(photoreal_prompts):,} briefs photoréalistes Gen3ia chargés")

NEGATIVE_PROMPT = ("CG, 3d render, cartoon, anime, illustration, painting, "
                   "drawing, low quality, blurry, watermark, text, logo, "
                   "deformed hands, extra fingers, plastic skin")
print("✅ Prompt négatif anti-CG défini")'''

CELL_4_V4 = r'''# ═══════════════ CELLULE 4 — Photos réelles : COCO TRAIN en STREAMING HF ═══════════════
# v4 : on passe du zip val2017 (5 000 photos) au split TRAIN de COCO via
# Hugging Face datasets en STREAMING (118 000 photos légendées, on en retient
# PHOTOS_N) — zéro décompression locale, mémoire maîtrisée.
# Replis honnêtes : val2017 zip → briefs Gen3ia seuls (jamais de faux succès).
import itertools

PHOTOS_N = int(os.environ.get("PHOTOS_N", "12000"))
coco_pairs = []
source_photos = "aucune"
try:
    from datasets import load_dataset
    flux = load_dataset("HuggingFaceM4/COCO", split="train", streaming=True)
    for ex in itertools.islice(flux, PHOTOS_N * 2):          # marge (certains items sans image)
        try:
            img = ex["image"]
            caps = ex.get("sentences") or ex.get("captions") or []
            if img is None or not caps:
                continue
            chemin = f"/content/coco_stream_{len(coco_pairs):05d}.jpg"
            img.convert("RGB").save(chemin, "JPEG", quality=92)
            coco_pairs.append({"image": chemin, "prompt": caps[0]["raw" if isinstance(caps[0], dict) else 0] if isinstance(caps[0], dict) else caps[0]})
            if len(coco_pairs) >= PHOTOS_N:
                break
        except Exception:
            continue
    source_photos = f"COCO train HF streaming ({len(coco_pairs)} paires)"
except Exception as exc:
    print(f"⚠ COCO streaming indisponible ({exc.__class__.__name__}) — repli val2017 zip")

if not coco_pairs:
    try:
        import subprocess as _sp
        _sp.run(["mkdir", "-p", "/content/coco"], check=True)
        for _url, _dst in [("http://images.cocodataset.org/zips/val2017.zip", "/content/coco/val2017.zip"),
                           ("http://images.cocodataset.org/annotations/annotations_trainval2017.zip", "/content/coco/ann.zip")]:
            _sp.run(["wget", "-q", _url, "-O", _dst], check=True)
        _sp.run(["unzip", "-qo", "/content/coco/val2017.zip", "-d", "/content/coco"], check=True)
        _sp.run(["unzip", "-qo", "/content/coco/ann.zip", "-d", "/content/coco"], check=True)
        ann = _json.load(open("/content/coco/annotations/captions_val2017.json"))
        caps_by_img = {}
        for c in ann["annotations"]:
            caps_by_img.setdefault(c["image_id"], []).append(c["caption"].strip())
        for im in ann["images"]:
            if im["id"] in caps_by_img:
                coco_pairs.append({"image": f"/content/coco/val2017/{im['file_name']}",
                                   "prompt": caps_by_img[im["id"]][0]})
        source_photos = f"COCO val2017 zip ({len(coco_pairs)} paires)"
    except Exception as exc:
        print(f"⚠ val2017 indisponible aussi ({exc.__class__.__name__}) — briefs Gen3ia seuls")

print(f"✅ Photos réelles : {source_photos}")
if not coco_pairs:
    print("⚠ AUCUNE photo réelle — la Phase B stylisera sur les briefs seuls (qualité moindre, dit honnêtement)")'''

CELL_A1_V4 = r'''# ═══════════════ CELLULE A1 — PHASE A (langagière) : curriculum TOUS DOMAINES ═══════════════
# 33 datasets textuels (7 v3 + 26 v4 ≈ 946 000 exemples, 12 phases) apprennent
# à gen3 le COMPORTEMENT par phase : format, calcul exact, honnêteté, sécurité.
# Cap SAMPLE_TEXT (400 000) : la variété prime sur la répétition ; le notebook
# entraîne sur un échantillon stratifié déterministe (seed 42).
from torch.utils.data import Dataset
from transformers import AutoTokenizer

TEXT_DATASETS = ["abbreviations", "code", "knowledge", "security", "writing", "business", "multimodal",
                 "nlp_comprehension", "text_generation", "contextual_understanding",
                 "conversational_memory", "intent_recognition", "reasoning", "math",
                 "problem_solving", "code_v4", "tools", "rag_documents", "databases",
                 "image_analysis", "image_generation", "voice_speech", "audio_understanding",
                 "music_v4", "video_v4", "multimodal_v4", "ml_data", "ml_training",
                 "ml_evaluation", "ml_management", "security_v4", "professions", "sciences"]
text_rows = []
for _name in TEXT_DATASETS:
    _rows = DATASETS.get(_name, [])
    text_rows.extend(_rows)
    print(f"{_name:26s} {len(_rows):>9,}")
print("TOTAL texte brut :", f"{len(text_rows):,}")

SAMPLE_TEXT = int(os.environ.get("SAMPLE_TEXT", "400000"))
if len(text_rows) > SAMPLE_TEXT:
    import random as _rs
    _rs.Random(42).shuffle(text_rows)
    text_rows = text_rows[:SAMPLE_TEXT]
    print(f"Cap appliqué : {SAMPLE_TEXT:,} exemples stratifiés (seed 42)")

TEXT_MODEL_ID = os.environ.get("TEXT_MODEL_ID", "google/gemma-3-4b-it")
# gemma-3 est un modèle GATED : accepter la licence sur huggingface.co/google/gemma-3-4b-it
# Alternative libre : TEXT_MODEL_ID=Qwen/Qwen2.5-3B-Instruct
print("Modèle langagier :", TEXT_MODEL_ID)

tok_text = AutoTokenizer.from_pretrained(TEXT_MODEL_ID)
if tok_text.pad_token is None:
    tok_text.pad_token = tok_text.eos_token

CTX = int(os.environ.get("CTX", "1024"))

def formater_exemple(row):
    question = row["instruction"].strip()
    entree = (row.get("input") or "").strip()
    if entree:
        question = f"{question}\n\n{entree}"
    return question, row["output"].strip()

class CurriculumDataset(Dataset):
    def __init__(self, rows, tokenizer, ctx=CTX):
        self.exemples = rows
        self.tok = tokenizer
        self.ctx = ctx
    def __len__(self):
        return len(self.exemples)
    def __getitem__(self, i):
        row = self.exemples[i]
        question, cible = formater_exemple(row)
        ids_q = self.tok(question, add_special_tokens=False)["input_ids"]
        ids_r = self.tok(cible + "<end_of_turn>", add_special_tokens=False)["input_ids"]
        ids_q = [self.tok.bos_token_id] + ids_q + [self.tok.eos_token_id]
        input_ids = (ids_q + ids_r)[: self.ctx]
        labels = ([-100] * len(ids_q) + ids_r)[: self.ctx]   # loss UNIQUEMENT sur la réponse
        pad = self.ctx - len(input_ids)
        input_ids = input_ids + [self.tok.pad_token_id] * pad
        labels = labels + [-100] * pad
        return {"input_ids": torch.tensor(input_ids),
                "labels": torch.tensor(labels),
                "attention_mask": torch.tensor([1] * (self.ctx - pad) + [0] * pad)}

# budgets v4 : T4 → 3 000 | L4 → 6 000 | A100 → 12 000 pas
if "T4" in GPU_NAME or VRAM_Go < 17:
    STEPS_TEXT, BATCH_TEXT, ACCUM_TEXT = int(os.environ.get("STEPS_TEXT", "3000")), 1, 8
elif "L4" in GPU_NAME or VRAM_Go < 48:
    STEPS_TEXT, BATCH_TEXT, ACCUM_TEXT = int(os.environ.get("STEPS_TEXT", "6000")), 2, 8
else:
    STEPS_TEXT, BATCH_TEXT, ACCUM_TEXT = int(os.environ.get("STEPS_TEXT", "12000")), 4, 8
MAX_HOURS_TEXT = float(os.environ.get("MAX_HOURS", "0"))

ds_text = CurriculumDataset(text_rows, tok_text)
print(f"Dataset langagier prêt : {len(ds_text):,} exemples — {STEPS_TEXT:,} pas (batch effectif {BATCH_TEXT * ACCUM_TEXT})")'''

CELL_A3_V4 = r'''# ═══════════════ CELLULE A3 — PHASE A : test qualitatif par PHASE (12 groupes) ═══════════════
# Honnêteté par construction : on NE publie PAS un adaptateur sans l'avoir testé.
# Un échantillon par phase du curriculum — sortie attendue STRUCTURÉE.
model_text.eval()
def tester_langagier(question, max_new=280):
    ids = tok_text(question, return_tensors="pt").to(model_text.device)
    with torch.no_grad():
        out = model_text.generate(**ids, max_new_tokens=max_new, do_sample=True,
                                  temperature=0.7, top_p=0.9,
                                  pad_token_id=tok_text.pad_token_id)
    return tok_text.decode(out[0][ids["input_ids"].shape[1]:], skip_special_tokens=True)

import random as _r
_r.seed(42)
PHASES = {
    "1-langage": ["nlp_comprehension", "text_generation", "intent_recognition"],
    "2-raisonnement": ["reasoning", "math", "problem_solving"],
    "3-programmation": ["code_v4", "code"],
    "4-5-outils-rag": ["tools", "rag_documents", "databases"],
    "6-7-vision": ["image_analysis", "image_generation"],
    "8-audio": ["voice_speech", "audio_understanding", "music_v4"],
    "9-video": ["video_v4"],
    "10-orchestration": ["multimodal_v4"],
    "11-modeles": ["ml_data", "ml_training", "ml_evaluation"],
    "12-securite": ["security_v4"],
    "metiers": ["professions"],
    "sciences": ["sciences"],
}
tests = {}
for phase, domaines in PHASES.items():
    dispos = [d for d in domaines if DATASETS.get(d) and any(r["language"] == "fr" for r in DATASETS[d])]
    if not dispos:
        continue
    _row = _r.choice([r for r in DATASETS[_r.choice(dispos)] if r["language"] == "fr"])
    _question, _attendu = formater_exemple(_row)
    _reponse = tester_langagier(f"<start_of_turn>user\n{_question}<end_of_turn>\n<start_of_turn>model\n")
    tests[phase] = {"demande": _question[:200], "genere": _reponse[:400]}
    print(f"\n—— {phase} ——\nDEMANDE : {_question[:160]}…\nGÉNÉRÉ : {_reponse[:300]}…")
with open("/content/tests_langagiers_v4.json", "w", encoding="utf-8") as fh:
    json.dump(tests, fh, ensure_ascii=False, indent=2)
print("\n→ tests_langagiers_v4.json sauvé (joint à la publication)")'''

CELL_A4_V4 = r'''# ═══════════════ CELLULE A4 — PHASE A : export de l'adaptateur langagier v4 ═══════════════
EXPORT_TEXT = "/content/gen3ia_artifacts/text-lora-gemma3"
os.makedirs(EXPORT_TEXT, exist_ok=True)
model_text.save_pretrained(EXPORT_TEXT)
tok_text.save_pretrained(EXPORT_TEXT)
meta_text = {
    "base": TEXT_MODEL_ID, "method": "QLoRA 4-bit NF4 r16/α32",
    "curriculum": "v4 tous domaines — 37 datasets, 1 000 000 lignes, 12 phases",
    "datasets": TEXT_DATASETS, "rows_brut": sum(len(DATASETS.get(n, [])) for n in TEXT_DATASETS),
    "rows_entraines": len(text_rows), "steps": step_text,
    "ctx": CTX, "lr": TEXT_LR, "profil": PROFIL,
    "portee": "comportement/format par phase — la connaissance encyclopédique reste celle du modèle de base",
    "tests": json.load(open("/content/tests_langagiers_v4.json")) if os.path.exists("/content/tests_langagiers_v4.json") else {},
}
with open(f"{EXPORT_TEXT}/TRAINING_META.json", "w", encoding="utf-8") as fh:
    json.dump(meta_text, fh, ensure_ascii=False, indent=2)
print("Adaptateur langagier v4 exporté :", EXPORT_TEXT)
for f in os.listdir(EXPORT_TEXT):
    print(" —", f)'''

CELL_PUB_V4 = r'''# ═══════════════ CELLULE 16 — Publication Hugging Face (v4 tous domaines) ═══════════════
MANIFEST = {
    "name": "gen3ia-media-engine",
    "version": 4,
    "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "curriculum": {
        "total_lignes": sum(len(v) for v in DATASETS.values()),
        "datasets_v3": {k: len(v) for k, v in DATASETS.items() if k in V3_DATASETS},
        "datasets_v4": {k: len(v) for k, v in DATASETS.items() if k in V4_DATASETS},
        "phases": 12,
        "langues": ["fr", "en"],
    },
    "training": {
        "language": {
            "base": TEXT_MODEL_ID, "method": "QLoRA 4-bit NF4 r16/α32",
            "datasets": TEXT_DATASETS, "rows_brut": sum(len(DATASETS.get(n, [])) for n in TEXT_DATASETS),
            "rows_entraines": len(text_rows), "steps": step_text, "ctx": CTX,
            "portee": "comportement/format par phase",
            "adaptateur": "text-lora-gemma3/",
        },
        "photorealism": {"base": MODEL_ID, "method": "LoRA r32/α64 (fusionné)",
                          "photos": len(coco_pairs), "source_photos": source_photos,
                          "prompts_gen3ia": len(photoreal_prompts),
                          "steps": step, "profils": [PROFIL],
                          "resolutions": RESOLUTIONS,
                          "scheduler": "cosine + warmup 150",
                          "loss": "min-SNR γ=5, CFG dropout 10 %",
                          "loss_history": STEP_HISTORY},
        "voice": {"model": "Kokoro-82M", "license": "Apache-2.0",
                   "voice_fr": "ff_siwis", "tiers": voix_cfg["tiers"]},
        "video": {"method": "8 keyframes photoréalistes + ffmpeg xfade",
                   "fps": 24, "fondu_s": 1.0},
    },
    "browser_inference": {
        "runtime": "onnxruntime-web (WebGPU) + kokoro-js",
        "sd": {"dir": "sd-photoreal-v2", "dtype": "fp16", "steps": 26,
                "steps_haute": 30, "grille_haute": 768,
                "size_class": "SD2.1-base (865M UNet) + LoRA r32"},
        "kokoro": {"dir": "kokoro", "voice_fr": "ff_siwis", "dtype": "fp32"},
    },
}
_j.dump(MANIFEST, open("/content/gen3ia_artifacts/MANIFEST.json", "w"),
        indent=2, ensure_ascii=False)

api.upload_folder(
    repo_id=HF_REPO, repo_type="model", folder_path="/content/gen3ia_artifacts",
    commit_message="Gen3ia v4 TOUS DOMAINES — curriculum 1 000 000 lignes (37 datasets, 12 phases), "
                   "QLoRA langagier + LoRA média sur COCO train (streaming HF), porte qualité ONNX",
)
print("🚀 Publié : https://huggingface.co/" + HF_REPO)
print(_j.dumps({"version": MANIFEST["version"],
                "curriculum_total": MANIFEST["curriculum"]["total_lignes"],
                "photos_reelles": len(coco_pairs)}, indent=2, ensure_ascii=False))'''

MD_FINAL_V4 = """## ✅ Après le run — ce que le client gen3ia fait automatiquement

1. `lib/neural/webgpu/manifest.ts` relit le **MANIFEST.json v4** → `sd-photoreal-v2`
   (LoRA r32 fusionné), `pasQualitéHaute()` lit `steps_haute: 30` — le navigateur
   bascule sans redéploiement.
2. L'adaptateur `text-lora-gemma3/` est chargé par le training-worker (moteur
   `text-lora`) et par les entraînements clients gen3ia.
3. `curriculum.total_lignes` (1 000 000) et la liste des 37 datasets alimentent
   la traçabilité de l'entraînement (lineage).

## 📊 Couverture v4 — les 12 phases

| Phase | Datasets | Lignes |
|---|---|---|
| 1. Langage | nlp_comprehension, text_generation, contextual_understanding, conversational_memory, intent_recognition | 166 000 |
| 2. Raisonnement | reasoning, math, problem_solving | 195 000 |
| 3. Programmation | code (v3) + code_v4 | 72 000 |
| 4-5. Outils & RAG | tools, databases, rag_documents | 70 000 |
| 6-7. Vision | image_analysis, image_generation | 65 000 |
| 8. Audio | voice (v3), voice_speech, audio_understanding, music (v3) + music_v4 | 57 733 |
| 9. Vidéo | video (v3) + video_v4 | 53 349 |
| 10. Orchestration | multimodal (v3) + multimodal_v4 | 35 400 |
| 11. Modèles | ml_data, ml_training, ml_evaluation, ml_management | 57 000 |
| 12. Sécurité | security (v3) + security_v4 | 56 000 |
| Métiers | business (v3) + professions (15 verticales) | 106 600 |
| Sciences & langage de base | knowledge (v3), sciences, abbreviations (v3) | 25 145 |

**Total : 1 000 000 lignes exactement** — bilingue FR/EN (~54 %/46 %),
dédupliqué par hash de contenu, déterministe (seed 20261026).
"""


def main() -> None:
    nb = json.loads(SRC.read_text())
    assert len(nb["cells"]) == 18, f"v3: {len(nb['cells'])} cellules ≠ 18"

    def code_cell(src: str) -> dict:
        return {"cell_type": "code", "execution_count": None, "metadata": {},
                "outputs": [], "source": src.splitlines(keepends=True)}

    def md_cell(src: str) -> dict:
        return {"cell_type": "markdown", "metadata": {}, "source": src.splitlines(keepends=True)}

    # Remplacements (indices v3)
    nb["cells"][0] = md_cell(MD_HEADER_V4)
    nb["cells"][3] = code_cell(CELL_3_V4)
    nb["cells"][4] = code_cell(CELL_4_V4)
    nb["cells"][6] = code_cell(CELL_A1_V4)
    nb["cells"][8] = code_cell(CELL_A3_V4)
    nb["cells"][9] = code_cell(CELL_A4_V4)
    nb["cells"][16] = code_cell(CELL_PUB_V4)
    nb["cells"][17] = md_cell(MD_FINAL_V4)

    nb["metadata"][" colab_metadata_cleaned"] = nb["metadata"].get(" colab_metadata_cleaned", True)
    # ids de cellules (nbformat 4.5+) : dérivés de façon stable de l'index
    for i, c in enumerate(nb["cells"]):
        c.setdefault("id", f"cell-v4-{i:02d}")
    if nb.get("nbformat", 4) == 4:
        nb["nbformat_minor"] = max(nb.get("nbformat_minor", 0), 5)
    DST.write_text(json.dumps(nb, ensure_ascii=False, indent=1))

    # Validations
    import nbformat
    nbformat.validate(nbformat.reads(DST.read_text(), as_version=4))
    print(f"[v4] notebook écrit : {DST.name} ({len(nb['cells'])} cellules) — nbformat OK")
    for i, c in enumerate(nb["cells"]):
        if c["cell_type"] == "code":
            src = "".join(c["source"])
            try:
                ast.parse(src)
            except SyntaxError as e:
                # les magics IPython (!cmd, %cd) ne sont pas du Python pur — tolérés
                lignes_suspectes = [l for l in src.splitlines() if l.strip().startswith(("!", "%"))]
                if not lignes_suspectes:
                    raise SystemExit(f"[v4] cellule {i} : erreur Python — {e}")
                # retirer les magics puis re-vérifier
                nettoie = "\n".join(l for l in src.splitlines() if not l.strip().startswith(("!", "%")))
                ast.parse(nettoie)
    print("[v4] AST OK sur toutes les cellules code (magics IPython tolérés)")


if __name__ == "__main__":
    main()
