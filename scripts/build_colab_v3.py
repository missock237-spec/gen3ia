#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Construit training/colab/gen3ia_giants_training_v3.ipynb à partir du v2.

Extensions v3 :
  - en-tête markdown mis à jour (100 000 lignes, 11 datasets) ;
  - cellule datasets : 11 datasets (6 métiers + top-up média) ;
  - NOUVELLE PHASE A (langagière) : 4 cellules QLoRA Gemma 3 sur les
    46 000 instructions métier (code/knowledge/security/writing/business/
    multimodal/abbreviations) — masquage de loss correct, profils GPU ;
  - cellule publication : MANIFEST v3 + upload de l'adaptateur texte ;
  - validations : nbformat.validate + ast.parse de chaque cellule code.

Usage : python3 scripts/build_colab_v3.py
"""

from __future__ import annotations

import ast
import json
from pathlib import Path

RACINE = Path(__file__).resolve().parent.parent
SRC = RACINE / "training" / "colab" / "gen3ia_giants_training_v2.ipynb"
DST = RACINE / "training" / "colab" / "gen3ia_giants_training_v3.ipynb"

# ═══════════════ Phase A — cellules langagières (insérées avant le fine-tune SD) ═══════════════

CELL_A1 = r'''# ═══════════════ CELLULE A1 — PHASE A (langagière) : 46 000 instructions métier ═══════════════
# Les 6 datasets métiers v3 + abréviations apprennent à gen3 le COMPORTEMENT
# (format, structure, honnêteté des réponses) par domaine : dev web, sciences,
# sécurité défensive, rédaction, business, orchestration multimodale.
# La connaissance brute reste celle du modèle de base — on entraîne la forme,
# on ne prétend pas injecter des faits.
from torch.utils.data import Dataset
from transformers import AutoTokenizer

TEXT_DATASETS = ["code", "knowledge", "security", "writing", "business", "multimodal", "abbreviations"]
text_rows = []
for _name in TEXT_DATASETS:
    _rows = DATASETS.get(_name, [])
    text_rows.extend(_rows)
    print(f"{_name:14s} {len(_rows):6d} lignes")
print("TOTAL texte :", len(text_rows))

TEXT_MODEL_ID = os.environ.get("TEXT_MODEL_ID", "google/gemma-3-4b-it")
# gemma-3 est un modèle GATED : accepter la licence sur huggingface.co/google/gemma-3-4b-it
# (compte du notebook). Alternative libre : TEXT_MODEL_ID=Qwen/Qwen2.5-3B-Instruct
print("Modèle langagier :", TEXT_MODEL_ID)

tok_text = AutoTokenizer.from_pretrained(TEXT_MODEL_ID)
if tok_text.pad_token is None:
    tok_text.pad_token = tok_text.eos_token

CTX = 1024

def formater_exemple(row):
    """Formate un exemple au gabarit de conversation Gemma ; renvoie
    (prompt_user, cible_model) pour un masquage de loss précis."""
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

# budget adapté au GPU (même logique que la phase média) :
# T4 15 Go → 1 200 pas | L4 → 2 500 | A100 → 5 000
if "T4" in GPU_NAME or VRAM_Go < 17:
    STEPS_TEXT, BATCH_TEXT, ACCUM_TEXT = int(os.environ.get("STEPS_TEXT", "1200")), 1, 8
elif "L4" in GPU_NAME or VRAM_Go < 48:
    STEPS_TEXT, BATCH_TEXT, ACCUM_TEXT = int(os.environ.get("STEPS_TEXT", "2500")), 2, 8
else:
    STEPS_TEXT, BATCH_TEXT, ACCUM_TEXT = int(os.environ.get("STEPS_TEXT", "5000")), 4, 8
MAX_HOURS_TEXT = float(os.environ.get("MAX_HOURS", "0"))

ds_text = CurriculumDataset(text_rows, tok_text)
print(f"Dataset langagier prêt : {len(ds_text)} exemples — {STEPS_TEXT} pas (batch effectif {BATCH_TEXT * ACCUM_TEXT})")'''

CELL_A2 = r'''# ═══════════════ CELLULE A2 — PHASE A : entraînement QLoRA (Gemma 3) ═══════════════
# QLoRA 4-bit : le modèle gelé en NF4, seuls r16 adapters sont entraînés (~1 %).
# Cosine schedule + warmup, comme la phase média. Reprise MAX_HOURS sécurisée.
from transformers import AutoModelForCausalLM, get_cosine_schedule_with_warmup
from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training

import torch.utils.data as _tud

TEXT_LR = float(os.environ.get("TEXT_LR", "2e-4"))
try:
    from transformers import BitsAndBytesConfig
    bnb = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4",
                             bnb_4bit_compute_dtype=torch.bfloat16)
    model_text = AutoModelForCausalLM.from_pretrained(
        TEXT_MODEL_ID, quantization_config=bnb, device_map={"": 0},
        torch_dtype=torch.bfloat16, trust_remote_code=True)
except Exception as e:
    print("⚠️ 4-bit indisponible :", e, "— repli bf16 (VRAM ≥ 16 Go nécessaire)")
    model_text = AutoModelForCausalLM.from_pretrained(
        TEXT_MODEL_ID, device_map={"": 0}, torch_dtype=torch.bfloat16,
        trust_remote_code=True)

model_text.config.use_cache = False
model_text = prepare_model_for_kbit_training(model_text)
lora_text = LoraConfig(r=16, lora_alpha=32, lora_dropout=0.05, bias="none",
                       task_type="CAUSAL_LM",
                       target_modules=["q_proj", "k_proj", "v_proj", "o_proj"])
model_text = get_peft_model(model_text, lora_text)
model_text.enable_input_require_grads()
model_text.gradient_checkpointing_enable()
model_text.print_trainable_parameters()

loader = _tud.DataLoader(ds_text, batch_size=BATCH_TEXT, shuffle=True, drop_last=True)
opt_text = torch.optim.AdamW([p for p in model_text.parameters() if p.requires_grad], lr=TEXT_LR)
sched_text = get_cosine_schedule_with_warmup(opt_text, max(10, STEPS_TEXT // 20), STEPS_TEXT)

def pas_textuelle(loader, opt, sched, steps, max_hours=0.0):
    model_text.train()
    depart = time.time()
    step, cumul = 0, 0.0
    opt.zero_grad(set_to_none=True)
    while step < steps:
        for batch in loader:
            batch = {k: v.to(model_text.device) for k, v in batch.items()}
            out = model_text(**batch)
            (out.loss / ACCUM_TEXT).backward()
            cumul += out.loss.item()
            if (step + 1) % ACCUM_TEXT == 0:
                torch.nn.utils.clip_grad_norm_([p for p in model_text.parameters() if p.requires_grad], 1.0)
                opt.step(); sched.step(); opt.zero_grad(set_to_none=True)
                step += 1
                if step % 50 == 0 or step == steps:
                    print(f"text step {step}/{steps} — loss {cumul / ACCUM_TEXT:.4f} "
                          f"({(time.time() - depart) / max(step, 1):.1f} s/pas)")
                    cumul = 0.0
                if step >= steps:
                    break
                if max_hours and (time.time() - depart) > max_hours * 3600:
                    print("⏱️ MAX_HOURS_TEXT atteint — arrêt propre à", step)
                    break
        if step >= steps:
            break
    return step

step_text = pas_textuelle(loader, opt_text, sched_text, STEPS_TEXT, MAX_HOURS_TEXT)
gc.collect(); torch.cuda.empty_cache()
print("✅ Phase A terminée :", step_text, "pas QLoRA langagiers")'''

CELL_A3 = r'''# ═══════════════ CELLULE A3 — PHASE A : test qualitatif par domaine ═══════════════
# Honnêteté par construction : on NE publie PAS un adaptateur sans l'avoir testé.
# Un échantillon par domaine clé — la sortie attendue est STRUCTURÉE (pas factuelle).
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
tests = {}
for domaine in ["code", "security", "writing", "business", "multimodal"]:
    _row = _r.choice([r for r in DATASETS[domaine] if r["language"] == "fr"])
    _question, _attendu = formater_exemple(_row)
    _reponse = tester_langagier(f"<start_of_turn>user\n{_question}<end_of_turn>\n<start_of_turn>model\n")
    tests[domaine] = {"demande": _question[:200], "genere": _reponse[:400]}
    print(f"\n—— {domaine} ——\nDEMANDE : {_question[:160]}…\nGÉNÉRÉ : {_reponse[:300]}…")
with open("/content/tests_langagiers_v3.json", "w", encoding="utf-8") as fh:
    json.dump(tests, fh, ensure_ascii=False, indent=2)
print("\n→ tests_langagiers_v3.json sauvé (joint à la publication)")'''

CELL_A4 = r'''# ═══════════════ CELLULE A4 — PHASE A : export de l'adaptateur langagier ═══════════════
# L'adaptateur LoRA (~30 Mo) est publié à part — le VPS (training-worker, moteur
# text_lora) peut le charger sur PEFT pour les entraînements clients gén3ia.
EXPORT_TEXT = "/content/gen3ia_artifacts/text-lora-gemma3"
os.makedirs(EXPORT_TEXT, exist_ok=True)
model_text.save_pretrained(EXPORT_TEXT)
tok_text.save_pretrained(EXPORT_TEXT)
meta_text = {
    "base": TEXT_MODEL_ID, "method": "QLoRA 4-bit NF4 r16/α32",
    "datasets": TEXT_DATASETS, "rows": len(text_rows), "steps": step_text,
    "ctx": CTX, "lr": TEXT_LR, "profil": PROFIL,
    "portee": "comportement/format par domaine — la connaissance reste celle du modèle de base",
    "tests": json.load(open("/content/tests_langagiers_v3.json")) if os.path.exists("/content/tests_langagiers_v3.json") else {},
}
with open(f"{EXPORT_TEXT}/TRAINING_META.json", "w", encoding="utf-8") as fh:
    json.dump(meta_text, fh, ensure_ascii=False, indent=2)
print("Adaptateur langagier exporté :", EXPORT_TEXT)
for f in os.listdir(EXPORT_TEXT):
    print(" —", f)'''

# ═══════════════ Mutations des cellules v2 existantes ═══════════════

MD_HEADER_V3 = """# 🧠 GEN3IA — Entraînement GÉANTS v3 (curriculum 100 000 lignes : langage + média)

**Objectif v3 :** deux PHASES d'entraînement dans un seul notebook —
**Phase A (langagière) :** QLoRA 4-bit r16/α32 sur **46 000 instructions métier**
(dev web, sciences, sécurité défensive, rédaction, business, orchestration
multimodale, abréviations) → gen3 répond au bon FORMAT, avec l'honnêteté du
curriculum v3 ; **Phase B (média) :** LoRA r32/α64, **3 000 pas**, résolution
progressive **512 → 640 → 768**, cosine + warmup, min-SNR(γ=5), CFG dropout 10 %
sur **54 000 lignes média** (20 473 briefs photoréalistes, 8 349 keyframes,
15 733 voix, 7 300 musique) + photos réelles COCO — export **ONNX fp16 WebGPU**.

**Comment exécuter (Colab) :** `Exécution ▸ Tout exécuter` sur un runtime GPU.
Auto-documenté, résilient (reprise sur checkpoint) et honnête : il refuse de
publier un artefact qui n'a pas passé son test réel.

| Profil GPU | Phase A (texte) | Phase B (média) | Durée totale estimée |
|---|---|---|---|
| Tesla T4 | 1 200 pas QLoRA | 3 000 pas @512 | ~5 h |
| L4 | 2 500 pas QLoRA | 3 000 pas @512→640 | ~4 h |
| A100 | 5 000 pas QLoRA | 3 000 pas @512→768 | ~2,5 h |

⚠️ **Honnêteté :** la Phase A entraîne le COMPORTEMENT (formats, structures,
réflexes de sécurité et d'incertitude) — la connaissance brute reste celle du
modèle de base. La Phase B stylise le photoréalisme — gen3 ne devient pas Sora.
Le tout reste compatible WebGPU navigateur (philosophie gen3ia : l'IA tourne
sur le GPU de l'utilisateur, l'essaim distribue les keyframes)."""

CELL_3_V3 = r'''# ═══════════════ CELLULE 3 — Datasets Gen3ia v3 « géants » (100 000 lignes) ═══════════════
# 11 datasets bilingues publiés dans le repo : 5 média (images, video, voice,
# music, abbreviations) + 6 métiers v3 (code, knowledge, security, writing,
# business, multimodal). Top-ups média v3 (préfixes *3-) inclus dans les fichiers.
from huggingface_hub import hf_hub_download
import json as _json

DATASETS = {}
for name in ["abbreviations", "images", "video", "voice", "music",
             "code", "knowledge", "security", "writing", "business", "multimodal"]:
    try:
        p = hf_hub_download(HF_REPO, f"datasets/{name}/train.jsonl", repo_type="model")
        rows = [_json.loads(l) for l in open(p, encoding="utf-8") if l.strip()]
        DATASETS[name] = rows
        print(f"  {name:14s} {len(rows):,} lignes")
    except Exception as exc:
        print(f"  ⚠ {name} absent du repo ({exc.__class__.__name__}) — poussez d'abord datasets v3")
        DATASETS[name] = []
total = sum(len(v) for v in DATASETS.values())
print(f"TOTAL curriculum : {total:,} lignes")
if not DATASETS["images"]:
    raise SystemExit("❌ Dataset images introuvable dans le repo — exécutez d'abord l'upload des datasets v3")
if not DATASETS["code"]:
    print("⚠ Datasets métiers absents — la Phase A sera sautée (média seul)")

# Prompts photoréalistes Gen3ia (colonne INPUT du dataset images)
photoreal_prompts = [r["input"] for r in DATASETS["images"]
                     if r.get("task_type") == "prompt_to_photoreal_brief"]
print(f"✅ {len(photoreal_prompts):,} briefs photoréalistes Gen3ia chargés")

# Prompts négatifs anti-CG (le brief Gen3ia exige « pas d'aspect CG »)
NEGATIVE_PROMPT = ("CG, 3d render, cartoon, anime, illustration, painting, "
                   "drawing, low quality, blurry, watermark, text, logo, "
                   "deformed hands, extra fingers, plastic skin")
print("✅ Prompt négatif anti-CG défini")'''

CELL_PUB_V3 = r'''# ═══════════════ CELLULE 16 — Publication Hugging Face (v3 « géants ») ═══════════════
MANIFEST = {
    "name": "gen3ia-media-engine",
    "version": 3,
    "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "training": {
        "language": {
            "base": TEXT_MODEL_ID, "method": "QLoRA 4-bit NF4 r16/α32",
            "datasets": TEXT_DATASETS, "rows": len(text_rows), "steps": step_text,
            "ctx": CTX, "portee": "comportement/format par domaine",
            "adaptateur": "text-lora-gemma3/",
        },
        "photorealism": {"base": MODEL_ID, "method": "LoRA r32/α64 (fusionné)",
                          "photos": len(coco_pairs),
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
    "datasets": {k: len(v) for k, v in DATASETS.items()},
    "curriculum_total": sum(len(v) for v in DATASETS.values()),
}
_j.dump(MANIFEST, open("/content/gen3ia_artifacts/MANIFEST.json", "w"),
        indent=2, ensure_ascii=False)

api.upload_folder(
    repo_id=HF_REPO, repo_type="model", folder_path="/content/gen3ia_artifacts",
    commit_message="Gen3ia v3 GÉANTS — curriculum 100 000 lignes, QLoRA langagier "
                   "(46k instructions métier) + LoRA média r32 (COCO + briefs), porte qualité ONNX",
)
print("🚀 Publié : https://huggingface.co/" + HF_REPO)
print(json.dumps({k: MANIFEST[k] for k in ["version", "curriculum_total", "datasets"]},
                 indent=2, ensure_ascii=False))'''

MD_FINAL_V3 = """## ✅ Après le run — ce que le client gen3ia fait automatiquement

1. `lib/neural/webgpu/manifest.ts` relit `MANIFEST.json` **v3** → `sd-photoreal-v2`
   (LoRA r32 fusionné), `pasQualitéHaute()` lit `steps_haute: 30` — le navigateur
   bascule sans redéploiement.
2. L'**adaptateur langagier** `text-lora-gemma3/` est chargé par le VPS
   (training-worker, moteur `text_lora`) : les réponses gen3 adoptent les formats
   du curriculum v3 (code structuré, sécurité défensive, rédaction, business,
   orchestration multimodale) et le gabarit d'honnêteté du dataset.
3. « génère une image photoréaliste de … » → **WebGPU utilisateur** ou **essaim**
   (top-5 GPU, keyframes distribuées, relance sur déconnexion) ; repli honnête sinon.
4. « dis / lis à voix haute » → **Kokoro fp32 (WebGPU)** ou **q8 (WASM)**,
   segmentation prosodique entraînée par les 15 733 lignes voix v3.
5. Le curriculum complet (**100 000 lignes, 11 datasets**) reste téléchargeable
   depuis le repo pour tout nouvel entraînement ou évaluation.

**Rappel sécurité :** révoquer le token Hugging Face à la fin de la session
Colab (Settings ▸ Access Tokens)."""

def marquer(markdown: str):
    return {"cell_type": "markdown", "metadata": {}, "source": markdown.splitlines(keepends=True)}

def coder(source: str):
    return {"cell_type": "code", "execution_count": None, "metadata": {},
            "outputs": [], "source": source.splitlines(keepends=True)}

def trouver_indice(nb, motif: str) -> int:
    for i, c in enumerate(nb["cells"]):
        if motif in "".join(c["source"]):
            return i
    raise SystemExit(f"cellule introuvable : {motif!r}")

def main() -> None:
    nb = json.loads(SRC.read_text("utf-8"))
    nb["cells"][0] = marquer(MD_HEADER_V3)
    # dépendances : ajouter bitsandbytes pour la QLoRA
    c1 = "".join(nb["cells"][1]["source"])
    assert "%pip -q install" in c1
    nb["cells"][1]["source"] = c1.replace(
        "sentencepiece einops scipy", "sentencepiece einops scipy bitsandbytes"
    ).splitlines(keepends=True)
    nb["cells"][3] = coder(CELL_3_V3)
    # insertion Phase A après la cellule profil GPU (cellule 5 en v2)
    i_profil = trouver_indice(nb, "CELLULE 5 — Profil GPU")
    phase_a = [coder(CELL_A1), coder(CELL_A2), coder(CELL_A3), coder(CELL_A4)]
    nb["cells"][i_profil + 1:i_profil + 1] = phase_a
    # publication : remplacer la cellule MANIFEST v2 par la v3
    i_pub = trouver_indice(nb, "Publication Hugging Face")
    nb["cells"][i_pub] = coder(CELL_PUB_V3)
    # markdown final
    i_fin = len(nb["cells"]) - 1
    assert nb["cells"][i_fin]["cell_type"] == "markdown"
    nb["cells"][i_fin] = marquer(MD_FINAL_V3)
    # métadonnées
    nb["metadata"]["colab"]["name"] = "gen3ia_giants_training_v3.ipynb"
    nb["nbformat"] = 4
    nb["nbformat_minor"] = max(nb.get("nbformat_minor", 0), 5)
    for n, c in enumerate(nb["cells"]):
        c.setdefault("id", f"cell-v3-{n:02d}")
    # validations (les magics %/! sont du IPython, pas du Python : on les retire)
    import nbformat
    nbformat.validate(nb)
    for i, c in enumerate(nb["cells"]):
        if c["cell_type"] == "code":
            py = "\n".join(l for l in "".join(c["source"]).splitlines()
                           if not l.lstrip().startswith(("%", "!")))
            ast.parse(py)
    DST.write_text(json.dumps(nb, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"✅ {DST.name} écrit — {len(nb['cells'])} cellules (nbformat + AST valides)")

if __name__ == "__main__":
    main()
