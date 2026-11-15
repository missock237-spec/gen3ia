# gen3-core — Entraînement de gen3 (Gemma 3, GPU uniquement)

Version 3 du pack d'entraînement gen3. **Qwen3 est supprimé du projet** :
le modèle de base est désormais la lignée Google **Gemma 3** (`google/gemma-3-4b-it`,
`google/gemma-3-12b-it`), alignée sur l'orientation « IA de Google » du projet.

## Ce que ce pack contient

| Fichier | Rôle |
|---------|------|
| `train_multimodal.py` | QLoRA Gemma 3 — 2 niveaux (l4 / a100_40g), **longue durée** (budget temps, reprise, sync Drive) |
| `infer_multimodal.py` | Inférence + mesure des temps de réponse (préremplissage, génération, jetons/s, p50/p95) |
| `bench_multimodal.py` | **Benchmark de fonctionnement réel** : latences + qualité sur 60 tâches golden équilibrées |
| `train_av_ameliore.py` | Génération vidéo+audio from scratch (AV-DiT) — version longue durée (budget temps, smoke test) |
| `scripts/validate_dataset.py` | Validation du corpus (schéma unifié) |
| `data/` | Corpus unifié : 12 000 train / 600 validation / 60 golden + 129 exemples image (voir `data/SCHEMA.md`) |

## Les 2 niveaux de performance gen3

| | Niveau 1 — `l4` | Niveau 2 — `a100_40g` |
|---|---|---|
| GPU | NVIDIA L4 (24 Go) | NVIDIA A100 (40 Go) |
| Modèle de base | Gemma 3 **4B** IT | Gemma 3 **12B** IT |
| LoRA r / alpha | 16 / 32 | 32 / 64 |
| Accumulation | 8 | 4 |
| Learning rate | 1e-4 | 1.5e-4 |
| VRAM minimale | 22 Go | 36 Go |

`--profil auto` (défaut) lit la VRAM réelle et choisit. Sous 14 Go : refus.
**Sans GPU CUDA, gen3 refuse de s'entraîner** — conception GPU-uniquement, jamais CPU.

## Entraînement longue durée (sessions Colab successives)

```bash
python train_multimodal.py --profil auto \
  --max_hours 6 \            # arrêt propre au bout de 6 h, adaptateur final enregistré
  --save_steps 100 \         # checkpoint toutes les 100 étapes (sync Drive automatique)
  --max_train_samples 6000 \ # fractionner le corpus en sessions (0 = tout)
  --resume_from_checkpoint outputs/gen3-core-lora/checkpoint-500
```

- **Reprise après coupure** : repassez la même commande avec
  `--resume_from_checkpoint outputs/gen3-core-lora/checkpoint-XXXX` ;
- **Sync Drive** : si `/content/drive/MyDrive` est monté (Colab), chaque
  checkpoint et l'adaptateur final sont copiés vers
  `MyDrive/gen3ia-entrainement/` — une coupure Colab ne perd que quelques minutes ;
- **Budget temps** : `--max_hours` arrête proprement à l'échéance (checkpoint + adaptateur).

## Benchmark de fonctionnement réel (obligatoire après entraînement)

```bash
python bench_multimodal.py --adapter outputs/gen3-core-lora/final_adapter --comparer
```

Mesure : latences p50/p95 (préremplissage + génération), débit (jetons/s),
couverture lexicale par famille, validité JSON (extraction structurée),
honnêteté des réponses (pas de faux médias générés). Rapport → `bench_report.json`.
**Le mode `--comparer` évalue la base seule PUIS la base + adaptateur : c'est la
preuve chiffrée du gain gen3.**

## Positionnement honnête — ce que gen3 peut et ne peut pas atteindre

Ce que la communauté appelle « IA de Google » (Gemini, Veo, Nano Banana) est
entraîné sur des milliers d'accélérateurs TPU pendant des mois, avec des
trillions de jetons et des bibliothèques de médias sous licence. **Aucun
entraînement LoRA sur Colab — quel que soit le jeu de données — n'atteint ce
niveau**, et ce pack ne le prétend pas. Ce que ce pack atteint, de façon
mesurable :

1. **Spécialisation** : gen3 exécute les formats gen3 (plans, résumés,
   extraction JSON, prompts image, briefs audio, storyboards vidéo) avec la
   structure et les garde-fous attendus — mesuré par `bench_multimodal.py` ;
2. **Multimodal texte** : compréhension image + génération de **spécifications**
   de médias (le corpus 792k est textuel : gen3 écrit les prompts/briefs/storyboards,
   il ne génère pas les fichiers image/audio/vidéo eux-mêmes) ;
3. **Media AV (expérimental)** : `train_av_ameliore.py` entraîne une vraie
   génération vidéo+audio from scratch, mais il exige des **vidéos réelles avec
   piste audio** (dossier + `metadata.csv`) — des dizaines d'heures GPU minimum,
   qualité inévitablement très loin de Veo ;
4. **Chemin de montée en intelligence** : plus de données réelles validées →
   ré-entraînement → bench `--comparer` → itérer. C'est la seule boucle honnête.

### Note sur le « système neuronal à base d'ondes »

La partie du pipeline qui travaille réellement sur des **ondes** est le VAE
audio de `train_av_ameliore.py` : il compresse la **waveforme** sonore brute
(1D) en latents — c'est le sens technique réaliste de « basé sur les ondes »
dans gen3-av. En revanche, aucun réseau de neurones « à ondes » fonctionnel ne
peut remplacer aujourd'hui l'architecture transformeur du cœur langagier —
toute annonce contraire serait fausse. Le cœur gen3 est donc Gemma 3
(transformeur), choisi pour sa lignée Google et son rapport qualité/taille.

## Licence Gemma (obligatoire avant le premier entraînement)

1. Ouvrez https://huggingface.co/google/gemma-3-4b-it (et `-12b-it` si niveau 2) ;
2. Acceptez la licence Google (compte HF requis) ;
3. Colab : ajoutez votre token HF dans les Secrets (`HF_TOKEN`) — le notebook s'en charge.

## Commandes de référence

```bash
pip install -r requirements.txt
python scripts/validate_dataset.py data            # valider le corpus
python train_multimodal.py --profil auto --dry_run # vérifier la configuration
python train_multimodal.py --profil auto --max_hours 6
python infer_multimodal.py --adapter outputs/gen3-core-lora/final_adapter \
    --task plan --instruction "Prépare un plan pour une cantine scolaire" \
    --repetitions 5                                # temps de réponse p50/p95
python bench_multimodal.py --adapter outputs/gen3-core-lora/final_adapter --comparer
python train_av_ameliore.py smoke --out runs/smoke # test sante pipeline AV (GPU)
```
