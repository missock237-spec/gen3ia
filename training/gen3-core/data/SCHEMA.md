# Schéma unifié gen3-core

Chaque ligne est un objet JSON (« JSONL »). Les fichiers `.gz` sont compressés en gzip.

## Champs

| Champ         | Type   | Requis | Description |
|---------------|--------|--------|-------------|
| `id`          | string | oui    | Identifiant unique de l'exemple |
| `task_family` | string | oui    | Famille : `text_instruction`, `image_prompt_engineering`, `cross_modal_text_proxy`, `audio_task_specification`, `video_storyboard_specification` |
| `task`        | string | oui    | Tâche précise (ex. `plan`, `résumé`, `brief_synthese_vocale`) |
| `instruction` | string | oui    | Consigne adressée à gen3 |
| `input_text`  | string | non    | Contexte/texte source fourni à gen3 |
| `response`    | string | oui    | Réponse cible attendue |
| `image`       | string | non    | Chemin relatif vers `data/` (ex. `images/ui_login_demo.png`) |

## Fichiers

| Fichier                    | Contenu |
|----------------------------|---------|
| `train_core.jsonl.gz`      | 12 000 exemples — corpus 792k curaté (dédupliqué, équilibré : 2 400/famille) |
| `validation_core.jsonl.gz` | 600 exemples — 120 par famille, jamais vus à l'entraînement |
| `golden_bench.jsonl.gz`    | 60 exemples — jeu de benchmark (12 par famille, pour `bench_multimodal.py`) |
| `train_images.jsonl`       | 116 exemples ancrés image (analyse d'UI, tests logiciels) |
| `validation_images.jsonl`  | 13 exemples image de validation |

## Provenance et limites (honnêteté)

- Corpus issu du jeu synthétique procédural `gen3_multimodal_792k_v0_3` (792 080 lignes,
  100 % textuel, français) : il apprend à gen3 les **formats de spécification**
  (prompts image, briefs audio, storyboards vidéo) — il ne contient aucun média binaire.
- 89 628 doublons exacts retirés lors de la curation (11,3 %).
- `quality_status: synthetic_needs_review` pour les exemples image : à vérifier
  puis augmenter avec des données réelles avant usage commercial.
