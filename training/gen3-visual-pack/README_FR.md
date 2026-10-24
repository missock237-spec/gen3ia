# Pack visuel gen3 — l'école visuelle (images, voix off, vidéos)

Ce pack met gen3 **à l'école visuelle** : gen3ia joue le professeur, gen3 est
l'élève. Le cours n'est **plus textuel mais visuel** : six vraies leçons
illustrées, chacune avec son image générée et vérifiée, sa **voix off** et sa
**mini-leçon vidéo**. L'élève apprend à **décrire ce qui est visible** — pas à
inventer.

## Le principe du professeur (anti-hallucination par construction)

Chaque image a été **regardée** avant d'être décrite : la description de la
leçon correspond strictement à ce qui est visible dans l'image (éléments,
positions, couleurs, ambiance). Aucune annotation n'affirme ce que l'image ne
montre pas. Lorsque le générateur a ajouté du texte parasite (un faux titre
chinois sur la leçon 1), l'image a été **régénérée** jusqu'à propreté — un
corpus d'entraînement sale produit un élève qui divague.

## Le programme visuel

| Leçon | Titre | Matière | Image | Voix off | Vidéo |
|---|---|---|---|---|---|
| lecon01 | Le cycle de l'eau | sciences | 1344x768 | 86 s | 88 s |
| lecon02 | Le système solaire | sciences | 1344x768 | 86 s | 88 s |
| lecon03 | La forêt tropicale | nature | 1344x768 | 86 s | 87 s |
| lecon04 | Le marché africain | culture | 1344x768 | 90 s | 91 s |
| lecon05 | L'atelier du développeur | technologie | 1344x768 | 86 s | 88 s |
| lecon06 | Les énergies renouvelables | sciences | 1344x768 | 90 s | 92 s |

Trois modules, un seul dataset :

- **voir** (images) — `task=decrire_image` : une image → sa description
  détaillée en français. Cœur de l'adaptateur vision-langage.
- **écouter** (voix off) — `task=expliquer_lecon` : le transcript du professeur
  devient un exemple pédagogique texte (Gemma 3 n'entend pas : le lien audio →
  texte passe par un ASR externe, voir « Frontières honnêtes » plus bas).
- **comprendre** (vidéos) — `task=decrire_video` : 4 frames extraites de la
  mini-leçon (512 px, ffmpeg) → la même description vérifiée.

Le fichier `programme_visuel.json` (écrit par `professeur.py plan`) est la
référence du cours : leçons, durées réelles des médias, étapes.

## Pipeline complet

```
assets/images/*.jpg  (6 leçons générées + vérifiées visuellement)
assets/audio/*.mp3   (voix off TTS, voice xiaochen, speed 0.9)
assets/videos/*.mp4  (Ken Burns 960x540 + narration, H.264/AAC)
        │  professeur.py verifier    — contrôles (dimensions, durées, poids)
        │  prepare_visual_dataset.py — frames vidéo + fusion des 3 modules
        ▼
data/train_visual.jsonl (18 exemples) · data/validation_visual.jsonl (2)
        │  train_gen3_visuel.py  (GPU requis, QLoRA Gemma 3, l4 / a100_40g)
        ▼
outputs/gen3-visual-lora/final_adapter
        │  infer_gen3_visuel.py  — gen3 décrit une nouvelle image
        │  bench_gen3_visuel.py  — couverture des mots-clés, latence, tokens/s
        ▼
bench_visual_results.json
```

## 1. Le professeur vérifie son programme — `professeur.py`

100 % bibliothèque standard (dimensions PNG/JPEG sans PIL, durées via ffprobe,
avertissement propre si ffprobe est absent).

```bash
python professeur.py verifier   # contrôles complets des médias
python professeur.py plan       # écrit programme_visuel.json
python professeur.py stats      # matières, volumes, mots-clés
```

Contrôles effectués : présence des 3 médias par leçon, dimensions d'image
(plancher 512 px), durée des vidéos (plancher 20 s), narrations ≤ 1024
caractères (limite TTS), poids ≤ 8 Mo par média.

## 2. Préparer le dataset — `prepare_visual_dataset.py`

Sans GPU. ffmpeg requis (extraction des frames).

```bash
python prepare_visual_dataset.py           # extrait 4 frames/vidéo + fusionne
python prepare_visual_dataset.py --pas-extraire   # réutilise les frames existantes
```

Sortie : `data/train_visual.jsonl` (18 exemples : 6 images, 6 vidéos
multi-frames, 6 textes) et `data/validation_visual.jsonl` (2 questions). Le
schéma est celui des packs gen3 (`task`/`instruction`/`response`) : le dataset
est directement consommable par `train_video.py` du pack vidéo également.

## 3. Entraîner l'élève — `train_gen3_visuel.py`

QLoRA Gemma 3, 4 bits NF4, GPU **obligatoire** (CPU n'est jamais une capacité
d'IA gen3). Deux niveaux officiels :

| Profil | GPU | Base | LoRA r/α | accum | lr | VRAM requise |
|---|---|---|---|---|---|---|
| `l4` | L4 24 Go | Gemma 3 4B | 16/32 | 8 | 1e-4 | ≥ 22 Go |
| `a100_40g` | A100 40 Go | Gemma 3 12B | 32/64 | 4 | 1.5e-4 | ≥ 36 Go |

```bash
python train_gen3_visuel.py --profil auto            # choisit selon la VRAM
python train_gen3_visuel.py --profil l4 --max_hours 3.5
python train_gen3_visuel.py --resume_from_checkpoint outputs/gen3-visual-lora/checkpoint-30
python train_gen3_visuel.py --dry_run                # plan sans GPU
```

- Checkpoints automatiques (`save_steps`), `--resume_from_checkpoint` pour les
  sessions Colab interrompues ;
- `--max_hours` : arrêt propre avec checkpoint quand le budget est atteint ;
- sync Google Drive si `/content/drive/.../gen3ia-entrainement` est monté ;
- sur OOM : réduire d'abord `--epochs`/frames (4 max), sinon passer au profil
  `l4` (4B au lieu de 12B) — l'inverse (monter de 4B vers 12B) ne se fait pas
  sur un GPU plus petit.

Dataset visuel volontairement petit : 18 exemples × 4 passages
(`--epochs 4`) suffisent à ancrer le **style de description** du professeur ;
c'est un cours, pas un corpus de fondation.

## 4. L'élève décrit — `infer_gen3_visuel.py`

```bash
python infer_gen3_visuel.py --image mon_image.jpg
python infer_gen3_visuel.py --image mon_image.jpg --question "Combien d'aras voit-on ?"
python infer_gen3_visuel.py --interactif     # session : image: <chemin> puis questions
```

Sans adaptateur, `--modele google/gemma-3-4b-it` permet de comparer la base
et l'élève entraîné sur la même image.

## 5. Mesurer honnêtement — `bench_gen3_visuel.py`

```bash
python bench_gen3_visuel.py --adaptateur outputs/gen3-visual-lora/final_adapter
python bench_gen3_visuel.py --modele google/gemma-3-4b-it   # référence base
```

Pour chaque leçon : couverture des 8 mots-clés attendus (rappel d'éléments,
après normalisation des accents), longueur, latence, tokens/s →
`bench_visual_results.json`. Les limites sont écrites dans le fichier de
résultats lui-même : 6 leçons, mesure indicative, aucune comparaison valable
sans le même modèle de base.

## Frontières honnêtes

- **Audio** : Gemma 3 ne consomme pas d'onde sonore. Les voix off servent
  (1) au cours vidéo, (2) de transcripts (`expliquer_lecon`). Pour apprendre à
  gen3 à **écouter**, brancher un ASR (ex. Whisper/F5) en amont — le pack
  multimédia couvre le TTS, la couverture ASR reste à venir.
- **Vidéos** : les mini-leçons sont des plans fixes animés (Ken Burns) —
  c'est un cours visuel, pas du cinéma. La compréhension vidéo temporelle
  (mouvement) requiert le pack vidéo (Wan 2.1 + multi-frames).
- **Voix off** : la voix « xiaochen » est un TTS générique ; son français est
  compréhensible mais son accent n'est pas natif. Remplaçable par n'importe
  quel TTS (les narrations `assets/audio/narrations/*.txt` sont la source).
- **Poids** : ~28 Mo de médias dans le dépôt, pour que le cours soit
  **reproductible de bout en bout** (images, sons, vidéos, transcripts).

## Réutiliser la méthode (nouvelles leçons)

1. Générer l'image (n'importe quel générateur), la **regarder**, écrire la
   description de ce qui est VISIBLE uniquement ;
2. ajouter la leçon dans `scripts/` du dépôt (source du dataset) ou éditer
   `data/lecons_images.jsonl` directement (task/instruction/response/image/
   mots_cles) ;
3. régénérer la voix off (TTS ≤ 1024 chars) et la vidéo (Ken Burns + ffmpeg) ;
4. `python professeur.py verifier` doit rester VERT ;
5. relancer prepare → train → bench : l'école grandit leçon par leçon.
