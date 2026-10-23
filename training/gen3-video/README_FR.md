# Pack vidéo gen3 — génération de clips Wan 2.1 + entraînement Gemma 3

Ce pack ferme la boucle multimodale de gen3 : il **génère de vraies séquences
vidéo** avec Wan 2.1 (Hugging Face) puis **entraîne gen3 à comprendre des
vidéos** (analyse, résumé, questions-réponses visuelles) sur Gemma 3.

## Pipeline complet

```
prompts_gen3.json (48 scènes FR/EN)
        │  gen3_video_dataset.py  (GPU requis : Colab L4 / A100)
        ▼
gen3_dataset/videos/*.mp4  +  metadata.jsonl   ← Wan2.1-T2V-1.3B, 832x480, 16 fps
        │  prepare_video_dataset.py  (ffmpeg, sans GPU)
        ▼
data/train_video.jsonl · validation_video.jsonl · golden_video.jsonl
   (images clés 512 px + exemples video_understanding au schéma gen3)
        │  train_video.py  (GPU requis, QLoRA Gemma 3, profils l4 / a100_40g)
        ▼
outputs/gen3-video-lora/final_adapter   → bench → intégration plateforme
```

## 1. Génération des clips — `gen3_video_dataset.py`

Amélioration du script fourni par l'utilisateur, conservant son design
(metadata.jsonl, IDs sha256, normalisation ffmpeg) :

- **Poids HF automatiques** : `Wan-AI/Wan2.1-T2V-1.3B` (~11 Go) téléchargé
  via `huggingface_hub` dans `WAN_CKPT_DIR` (token `HF_TOKEN`) ;
- **Reprise multi-sessions** : les clips `status=ok` déjà présents sont
  sautés — chaque session Colab complète le stock ;
- **Résilience** : 3 tentatives/clip, timeout 45 min/clip, vérification GPU
  (plancher 14 Go VRAM) et espace disque (20 Go) ;
- **`--limit N`** pour fractionner (≈ 6–10 min/clip sur L4) ;
- **`--dry-run`** : plan de génération sans GPU (développement).

```bash
export WAN_REPO_DIR=/content/Wan2.1        # dépôt cloné Wan-Video/Wan2.1
export WAN_CKPT_DIR=/content/Wan2.1-T2V-1.3B
export HF_TOKEN=...                         # ou Colab Secret HF_TOKEN
python gen3_video_dataset.py --limit 10     # ~1,5 h sur L4
```

Honnêteté technique : Wan t2v-1.3B produit nativement ≈ 5 s (81 images) ;
les clips 10 s sont obtenus par **bouclage fluide ffmpeg** du rendu natif
(``--duration 5`` pour éviter le bouclage). La qualité est celle d'un modèle
1,3 B en 480p — les scènes avec du texte à l'écran sont à éviter.

## 2. Préparation du dataset — `prepare_video_dataset.py`

Sans GPU (ffmpeg seul) : extraction de K images clés par clip (défaut 6,
512 px), puis génération d'exemples au schéma unifié gen3 — réponses ancrées
dans les métadonnées françaises de `prompts_gen3.json` (sujet, action,
décor, ambiance, caméra), donc **sans hallucination par construction** :

| task_family           | task             | Entrée                       | Sortie                    |
|-----------------------|------------------|------------------------------|---------------------------|
| `video_understanding` | `video_analysis` | 6 images clés (ordre chrono) | analyse structurée + résumé |
| `video_understanding` | `video_summary`  | 6 images clés                | résumé en 2 phrases        |
| `video_understanding` | `video_scene_qa` | 6 images clés                | 4 Q/R visuelles            |
| `video_understanding` | `frame_caption`  | 1 image                      | description (mono-frame)   |

Splits **par vidéo** (aucune fuite train/validation/golden) : ~10 % des
vidéos en validation, 2 en golden, le reste en train.

```bash
python prepare_video_dataset.py --dataset_dir gen3_dataset --frames_per_video 6
python scripts/validate_video_dataset.py data
```

## 3. Entraînement vidéo — `train_video.py`

Décliné de `gen3-core/train_multimodal.py` : QLoRA NF4 + double quant,
Gemma 3 (lignée Google), champ `images` multi-frames (max 8 par exemple),
collator batch_size=1, checkpoints + reprise, budget temps `--max_hours`
avec arrêt propre, sync Drive.

```bash
python train_video.py --data_dir data --profil auto --epochs 3 --max_hours 5.5
```

| Profil      | GPU            | Base           | LoRA    | VRAM min |
|-------------|----------------|----------------|---------|----------|
| `l4`        | L4 24 Go       | gemma-3-4b-it  | r16/a32 | 22 Go    |
| `a100_40g`  | A100 40 Go     | gemma-3-12b-it | r32/a64 | 36 Go    |

## 4. Ce que ce pack permet — et ne permet pas (honnêteté)

- **Permet** : gen3 apprend à **analyser, résumer et répondre à des questions
  sur des clips courts** (compréhension vidéo), et à décrire des frames
  isolées. C'est un vrai chaînon multimodal mesurable (golden_video.jsonl
  sert de benchmark).
- **Ne permet pas** : générer des vidéos au niveau Veo (Wan sert à produire
  le *corpus d'entraînement*, pas les sorties de gen3), ni atteindre le
  niveau Gemini. Avec 48 scènes × ~8 exemples = ~380 exemples par série
  complète, c'est une **base de compréhension vidéo** ; l'échelle réelle
  demande des milliers de clips variés (sessions successives, puis données
  sous licence).

## Dossier de travail

Le dossier `gen3_dataset/` (clips, frames, metadata) est **généré à
l'exécution** et ne doit pas être commité. `data/*.jsonl` produits à partir
de clips réels peuvent être commités une fois validés.
