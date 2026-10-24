# Pack visuel gen3 — l'école visuelle + l'école des métiers (vague 2)

Ce pack met gen3 **à l'école** : gen3ia joue le professeur, gen3 est
l'élève. Le cours n'est **plus textuel mais visuel** : quinze vraies leçons
illustrées, chacune avec son image générée et vérifiée, sa **voix off** et sa
**mini-leçon vidéo**. L'élève apprend à **décrire ce qui est visible** — pas à
inventer — puis à **exécuter des métiers réels**.

## Le principe du professeur (anti-hallucination par construction)

Chaque image a été **regardée** avant d'être décrite : la description de la
leçon correspond strictement à ce qui est visible dans l'image (éléments,
positions, couleurs, ambiance). Aucune annotation n'affirme ce que l'image ne
montre pas. Lorsque le générateur a ajouté du texte parasite (un faux titre
chinois sur la leçon 1), l'image a été **régénérée** jusqu'à propreté — un
corpus d'entraînement sale produit un élève qui divague.

## Le programme visuel

Vague 1 — apprendre à voir, écouter, comprendre :

| Leçon | Titre | Matière | Image | Voix off | Vidéo |
|---|---|---|---|---|---|
| lecon01 | Le cycle de l'eau | sciences | 1344x768 | 86 s | 88 s |
| lecon02 | Le système solaire | sciences | 1344x768 | 86 s | 88 s |
| lecon03 | La forêt tropicale | nature | 1344x768 | 86 s | 87 s |
| lecon04 | Le marché africain | culture | 1344x768 | 90 s | 91 s |
| lecon05 | L'atelier du développeur | technologie | 1344x768 | 86 s | 88 s |
| lecon06 | Les énergies renouvelables | sciences | 1344x768 | 90 s | 92 s |

Vague 2 — l'école des métiers (leçons 07 → 15) : chaque métier demandé au
professeur devient une leçon visuelle, puis des **tâches à exécuter** :

| Leçon | Métier enseigné | Tâches exécutées (exemples) |
|---|---|---|
| lecon07 | Rédiger des documents | ordre du jour, compte rendu modèle |
| lecon08 | Analyser des données | ventes de Yaoundé, étals comparés |
| lecon09 | Répondre aux questionnaires | réponse polie et honnête, clarification |
| lecon10 | Créer des vidéos réalistes | storyboard marché à l'aube (4 plans) |
| lecon11 | Générer des images photoréalistes | description pêcheur à l'aube |
| lecon12 | Copier/créer des voix humaines | fiche de voix, refus éthique argumenté |
| lecon13 | Web en temps réel | suivi du prix du maïs à Douala |
| lecon14 | Rédiger des rapports | résumé/constats/preuves/recommandations |
| lecon15 | Contrôler la cohérence | domaine FICTIF de Zanbara corrigé, île de Kanouma validée |

La leçon 15 apprend le point le plus subtil : **mélanger des données même sur
un domaine qui n'existe pas** (pays imaginaire, marché fictif) tout en restant
**parfaitement cohérent** — unités, dates, ordres de grandeur, sources — et
signaler honnêtement toute incohérence plutôt que de la laisser passer.

Quatre modules, un seul dataset :

- **voir** (images) — `task=decrire_image` : une image → sa description
  détaillée en français. Cœur de l'adaptateur vision-langage.
- **écouter** (voix off) — `task=expliquer_lecon` : le transcript du professeur
  devient un exemple pédagogique texte (Gemma 3 n'entend pas : le lien audio →
  texte passe par un ASR externe, voir « Frontières honnêtes » plus bas).
- **comprendre** (vidéos) — `task=decrire_video` : 4 frames extraites de la
  mini-leçon (512 px, ffmpeg) → la même description vérifiée.
- **métiers** (vague 2) — 9 nouvelles tâches (`rediger_document`,
  `analyser_donnees`, `repondre_questionnaire`, `planifier_video`,
  `creer_image_photorealiste`, `creer_voix`, `analyser_web_temps_reel`,
  `rediger_rapport`, `controler_coherence`) : exemples dans
  `data/metiers_taches.jsonl`, textes purs consommés tels quels par
  `prepare_visual_dataset.py`.

Le fichier `programme_visuel.json` (écrit par `professeur.py plan`) est la
référence du cours : leçons, durées réelles des médias, étapes.

## Pipeline complet

```
assets/images/*.jpg  (15 leçons générées + vérifiées visuellement)
assets/audio/*.mp3   (voix off TTS, voice xiaochen, speed 0.9 — 20 min)
assets/videos/*.mp4  (Ken Burns 960x540 + narration, H.264/AAC — 20 min)
        │  professeur.py verifier    — contrôles (dimensions, durées, poids)
        │  prepare_visual_dataset.py — frames vidéo + fusion des 4 modules
        ▼
data/train_visual.jsonl (59 exemples) · data/validation_visual.jsonl (6)
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

Sortie : `data/train_visual.jsonl` (59 exemples : 15 images, 15 vidéos
multi-frames, 15 textes, 14 tâches métiers) et `data/validation_visual.jsonl`
(6 questions). Le schéma reste celui des packs gen3
(`task`/`instruction`/`response`) : le dataset est directement consommable par
`train_video.py` du pack vidéo également.

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

Dataset de cours volontairement compact : 59 exemples × 4 passages
(`--epochs 4`) suffisent à ancrer le **style du professeur** (décrire sans
inventer, exécuter un métier méthode par méthode) ; c'est un cours, pas un
corpus de fondation.

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
résultats lui-même : 15 leçons, mesure indicative, aucune comparaison valable
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
  La leçon 12 enseigne l'éthique correspondante : reproduire la voix d'une
  personne réelle exige son **consentement** — jamais sans accord.
- **Poids** : ~50 Mo de médias dans le dépôt, pour que le cours soit
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
