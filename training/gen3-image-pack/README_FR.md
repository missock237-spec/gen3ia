# Gen3ia — pack d'entraînement image (gen3 vision + code)

Kit officiel pour apprendre à gen3 à travailler à partir d'images : analyse
visuelle prudente, génération de tests logiciels et génération de tests
dérivés de captures d'interface. Base : Qwen3-VL-4B-Instruct adapté en QLoRA
(seul l'adaptateur gen3 est entraîné — les poids de base restent gelés).

## Conception gen3 : les ressources GPU à sa disposition

gen3 est conçue pour fonctionner avec les ressources GPU qu'elle a à sa
disposition — **le CPU n'est pas une cible supportée**, ni pour
l'entraînement ni pour l'inférence. Le script refuse de démarrer sans CUDA.

### Les 2 niveaux de performance

| Niveau | GPU de référence | LoRA r/alpha | max_pixels | Accumulation | LR    |
|--------|------------------|--------------|------------|--------------|-------|
| `l4` (Niveau 1) | **NVIDIA L4 24 Go** | 16 / 32 | 401 408 (~512×784) | 8 | 1e-4 |
| `a100_40g` (Niveau 2) | **NVIDIA A100 40 Go** | 32 / 64 | 786 432 (~768×1024) | 4 | 1.5e-4 |

- `--profil auto` (défaut) : la VRAM réelle du GPU détecté choisit le niveau
  (≥ 36 Go → `a100_40g`, ≥ 22 Go → `l4`).
- GPU de transition (ex. T4 16 Go) : le niveau `l4` s'exécute en mode économe ;
  en dessous de 14 Go de VRAM, l'entraînement refuse de démarrer.
- Un paramètre passé explicitement sur la ligne de commande prime sur le niveau.

## Contenu

- `train_multimodal.py` — entraînement QLoRA, 2 niveaux de performance, détection auto de la VRAM.
- `infer_multimodal.py` — inférence avec l'adaptateur entraîné.
- `scripts/validate_dataset.py` — validation structurelle du corpus.
- `data/train.jsonl` (116 exemples) / `data/validation.jsonl` (13) — 3 tâches :
  `software_test_generation` (52), `image_analysis` (34), `image_based_test_generation` (30) ;
  21 exemples d'entraînement ancrés sur une image.
- `data/images/ui_login_demo.png` — image de démonstration synthétique.
- `data/SCHEMA.md` — schéma des lignes JSONL.

## Transparence sur le niveau

Ce pack est un pipeline de départ et un corpus de démonstration — il ne place
pas automatiquement gen3 au niveau des géants actuels. Les exemples portent
`quality_status=synthetic_needs_review` : ils doivent être vérifiés,
diversifiés et augmentés avec des données autorisées avant un usage sérieux.
Par ailleurs, gen3 ici apprend des tâches **à partir** d'images (analyse,
génération de tests) : ce n'est pas un modèle de synthèse d'images de type
diffusion — le script enseigne au VLM à produire du contenu fiable à partir
des visuels qu'on lui montre.

## Installation (runtime GPU requis)

Linux, Python 3.10/3.11, GPU NVIDIA CUDA. Le niveau `l4` vise 24 Go (L4) ;
le niveau `a100_40g` vise 40 Go (A100). Installer PyTorch compatible CUDA
depuis le sélecteur officiel PyTorch, puis :

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
pip install -r requirements.txt
```

## Validation structurelle (fonctionne sur tout hôte)

```bash
python scripts/validate_dataset.py --train data/train.jsonl --validation data/validation.jsonl --data-dir data
python train_multimodal.py --dry_run --train_file data/train.jsonl --eval_file data/validation.jsonl --data_dir data
```

## Entraînement (GPU obligatoire)

```bash
# Niveau choisi automatiquement selon la VRAM détectée
python train_multimodal.py --model_name Qwen/Qwen3-VL-4B-Instruct \
  --train_file data/train.jsonl --eval_file data/validation.jsonl \
  --data_dir data --output_dir outputs/gen3ia-vlm-lora --epochs 3

# Ou niveau imposé
python train_multimodal.py --profil a100_40g ...
python train_multimodal.py --profil l4 ...

# Reprendre après une coupure (Colab)
python train_multimodal.py --resume_from_checkpoint outputs/gen3ia-vlm-lora/checkpoint-40
```

Commencer par un petit essai et vérifier la sortie du processor, les champs
visuels et la perte avant un entraînement long. Les champs tensoriels
multimodaux changent selon les versions des bibliothèques ; une adaptation du
collator peut être nécessaire (le collator de référence exige batch_size=1).

## Inférence

```bash
python infer_multimodal.py --adapter_dir outputs/gen3ia-vlm-lora/final_adapter \
  --task image_analysis --image data/images/ui_login_demo.png \
  --instruction "Analyse cette capture : observations, anomalies, incertitudes."
```

## Évaluation sérieuse

- Séparer train/validation/test par projet ou source, et dédupliquer avant le split.
- Exécuter les tests générés dans une sandbox : taux d'exécution, taux de
  réussite sur code correct, mutation score.
- Pour les images : exactitude des observations, taux d'hallucinations,
  transcription OCR, gestion des incertitudes.
- Conserver un jeu de test final verrouillé ; faire contrôler les réponses de
  référence par tests automatisés et/ou revue humaine.
- Respecter licences, confidentialité et suppression des secrets.

## Architecture maison

Ce code adapte un modèle pré-entraîné. Il ne peut pas entraîner une
architecture Gen3ia créée de zéro sans connaître sa classe de modèle, son
tokenizer, son encodeur visuel, sa fusion multimodale et sa fonction de perte.
