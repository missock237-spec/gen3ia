# Pack code gen3 — apprendre à gen3 à créer des sites et du code

Ce pack entraîne un **adaptateur LoRA** pour que gen3 sache produire des sites
web complets (HTML, CSS, JavaScript), des composants React/Next.js et du code
backend (Python, SQL), à partir d'instructions en français.

**Cadrage honnête** : ce pack ne crée pas un « cerveau » gen3 à partir de zéro.
Il adapte un modèle de base open-weights chargeable par `AutoModelForCausalLM`
(par exemple `Qwen/Qwen2.5-Coder-7B-Instruct`, licence Apache-2.0) : le
produit final est un **adaptateur PEFT LoRA** (quelques dizaines de Mo) qui se
charge **sur la base d'origine**. C'est exactement le même schéma que les packs
image (`gen3-image-pack`) et média (`gen3-media-pack`) déjà intégrés.

## Contenu du pack

| Fichier | Rôle |
|---|---|
| `train_gen3_code.py` | Entraînement LoRA (profils `l4` / `a100_40g`, reprise checkpoint, eval optionnel, journal fichier, garde OOM, push Hub optionnel) |
| `infer_gen3_code.py` | Génération de code/sites à partir d'une instruction (fichier ou mode interactif) |
| `bench_gen3_code.py` | Benchmark réel : latence premier token (TTFT), tokens/s, taux de remplissage → JSON |
| `profils.py` | Les deux niveaux de performance gen3, GPU obligatoire, refus propre sans CUDA |
| `format_prompt.py` | Gabarit de prompt unique (train = inférence = bench) + langages supportés |
| `scripts/validate_dataset.py` | Validateur autonome des JSONL (doublons, fuite train/validation, stats) |
| `data/train.jsonl` | 1 015 exemples création de sites et de code : HTML 302, CSS 216, JS 215, TS/React 111, Python 94, SQL 53, Bash 24 |
| `data/validation.jsonl` | 75 exemples, **sans fuite** avec le train (vérifié) |

## Format des données

Une ligne JSONL = un objet :

```json
{"instruction": "Crée un formulaire de contact HTML accessible", "language": "html", "task": "web", "response": "<form ...>...</form>"}
```

`language` est normalisé automatiquement (`c++ → cpp`, `js → javascript`,
`react → javascript`, `nextjs → typescript`…). Le gabarit final inséré dans le
modèle est :

```
### Instruction
<instruction>

### Language
<langage normalisé>
### Task
<task>

### Response
<code>
```

Seule la **réponse** est entraînée (labels du prompt masqués à `-100`).

## Profils de performance (GPU obligatoire)

| Profil | GPU | max_length | batch × accum | LoRA | lr |
|---|---|---|---|---|---|
| `l4` | L4 24 Go / RTX 4090 / A10G (plancher 22 Go) | 4096 | 2 × 8 | r16/α32 | 2e-4 |
| `a100_40g` | A100 40-80 Go (plancher 36 Go) | 8192 | 4 × 4 | r32/α64 | 2.5e-4 |

`--profil auto` détecte la VRAM réelle. Sans GPU, l'entraînement est **refusé
par conception** (convention gen3 : le CPU n'est jamais une capacité d'IA).
`--dry-run` permet de valider données + prompt + réglages sans charger de
modèle. Les valeurs explicites de la ligne de commande l'emportent sur le profil.

## Utilisation rapide (Colab recommandé)

```bash
# 0) Valider les données sans GPU
python scripts/validate_dataset.py --dataset data/train.jsonl data/validation.jsonl
python train_gen3_code.py --model-path Qwen/Qwen2.5-Coder-7B-Instruct \
    --dataset data/train.jsonl --dry-run

# 1) Entraîner (L4 24 Go, base 7B en 4 bits)
python train_gen3_code.py --model-path Qwen/Qwen2.5-Coder-7B-Instruct \
    --dataset data/train.jsonl --eval-dataset data/validation.jsonl \
    --output-dir ./gen3-code-lora --profil auto --load-in-4bit --epochs 3 --resume

# 2) Interrompu ? Relancez la même commande avec --resume : dernier checkpoint repris.

# 3) Générer un site
python infer_gen3_code.py --model-path Qwen/Qwen2.5-Coder-7B-Instruct \
    --adapter ./gen3-code-lora \
    --instruction "Crée une landing page HTML avec hero et trois cartes" \
    --language html --output landing.html

# 4) Benchmark honnête (TTFT, tokens/s → JSON)
python bench_gen3_code.py --model-path Qwen/Qwen2.5-Coder-7B-Instruct \
    --adapter ./gen3-code-lora --output bench_code_results.json
```

Le notebook compagnon **`colab-entrainement-gen3-code.ipynb`** (livré dans
`download/`) enchaîne ces étapes sur Colab GPU, sauvegarde l'adaptateur dans
Google Drive et propose un push optionnel sur le Hub Hugging Face.

## Points de conception (hérités des packs précédents)

- **GPU obligatoire** : `--allow-cpu` du script d'origine a été remplacé par
  `--dry-run` (validation sans entraînement). Un entraînement LM sérieux sur
  CPU n'est ni réaliste ni dans la conception gen3.
- **Reprise** : `--resume` reprend le dernier checkpoint de `--output-dir`
  (utile aux déconnexions Colab) ; les checkpoints sont plafonnés par
  `--save-total-limit`.
- **Journal** : `output-dir/train_log.txt` reçoit chaque ligne de log avec
  horodatage — survit à la fermeture du navigateur.
- **OOM** : `torch.cuda.OutOfMemoryError` interceptée avec un plan d'action
  concret (réduire `--max-length`, puis batch, puis accum), et rappel de
  `--resume` (rien n'est perdu).
- **Licences** : vérifiez la licence du modèle de base choisi ET de vos
  données. `Qwen2.5-Coder-7B-Instruct` est Apache-2.0 ; d'autres bases codeuses
  sont plus restrictives.
- **Limites honnêtes** : 1 015+75 exemples couvrent un comportement de base
  solide (« style gen3 » de création de sites : structures complètes,
  composants accessibles, formulaires métiers, CSS moderne, JS vanilla,
  Flask/FastAPI, SQL) ; pour un niveau professionnel, continuez d'enrichir
  le dataset avec VOS projets réels et entraînez 3-5 epochs. Aucun chiffre
  de qualité n'est affirmé ici sans mesure : utilisez `bench_gen3_code.py`
  et vos propres essais.

## Intégration à gen3ia

- Le moteur `text-lora` de `training-worker/` peut piloter ce type d'entraînement
  (même famille PEFT/LoRA) ; les profils `l4`/`a100_40g` reprennent la
  convention des packs image/média.
- L'adaptateur produit (`adapter_model.safetensors` + `adapter_config.json`) se
  charge côté application avec `PeftModel.from_pretrained(base, adaptateur)`.
