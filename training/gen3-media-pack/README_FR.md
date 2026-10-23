# Gen3 Media Pack — entraînement multimédia photoréaliste (image / TTS parlé / vidéo)

Ce pack donne à **gen3** des capacités de génération **réelles** de médias : images
photoréalistes (SDXL), parole humaine en français (F5-TTS), vidéo réaliste (LTX-Video),
plus la piste expérimentale AV-DiT « ondes » (`train_av_neural.py`, architecture propre
de gen3). Tout est conçu pour **GPU uniquement** (Colab / L4 / A100), avec deux niveaux
de performance identiques à ceux du pack image (`profils.py`).

---

## 1. Ce que ce pack fait VRAIMENT (et ce qu'il ne fait pas)

Honnêteté totale, comme pour le reste du projet :

| Voie | Base pré-entraînée | Ce que l'adaptation apporte | Ce qu'elle N'apporte PAS |
|---|---|---|---|
| **Image** `train_image_sdxl.py` | SDXL 1.0 (OpenRAIL++-XL) | LoRA sur vos données → rendu photoréaliste de qualité production | Ni l'édition conversationnelle type Nano Banana, ni la compréhension d'intentions complexes |
| **TTS parlé** `train_tts_f5.py` | F5-TTS v1 (⚠️ CC-BY-NC-4.0) | Voix FR naturelle avec clonage (6 s de référence), fine-tunée sur vos enregistrements | Usage **commercial** interdit tant que la base est F5 → alternative Apache fournie (Kokoro) |
| **Vidéo** `train_video_ltx.py` | LTX-Video 0.9.7 (LTXV Open Weights) | Clips 2-5 s réalistes, style/domaine adaptés à votre dataset | Ni durée Veo (minutes), ni cohérence multi-scènes à long terme |
| **AV neural** `train_av_neural.py` | **Aucune (from scratch)** | Architecture gen3 « ondes » : AV-DiT + flow matching, audio+vidéo synchronisés (lip-sync) | Résultats **expérimentaux** : des heures de GPU ne suffisent pas pour du photoréalisme from scratch |

**Comparaison honnête avec Gemini / Veo / Nano Banana** : ces modèles ont été entraînés
sur des centaines de milliers d'heures GPU avec des données propriétaires. Ce pack les
rapproche par l'ARCHITECTURE (diffusion + flow matching + adaptation paramétrique), pas
par l'ÉCHELLE. Avec 1-2 jours de Colab L4/A100 et quelques milliers d'exemples, on obtient
une image photoréaliste convaincante, une voix française parlée fluide et des clips vidéo
de 3-5 s crédibles — c'est déjà un bond de ~2/10 à ~6/10 en génération multimédia pour gen3.

## 2. Pipeline complet

```
1) datasets        prepare_image_dataset.py   (images + légendes → JSONL dédoublonné)
                   prepare_audio_dataset.py   (audio + transcriptions → JSONL + CSV F5)
                   prepare_video_dataset.py   (vidéos + captions → JSONL sondé ffprobe)
2) entraînement    train_image_sdxl.py   --profil auto|l4|a100_40g
                   train_tts_f5.py       --profil auto|l4|a100_40g
                   train_video_ltx.py    --profil auto|l4|a100_40g
                   train_av_neural.py    (vae_v → vae_a → cache → dit → sample)
3) benchmark       bench_media.py  → bench_media.json (latence/RTF RÉELS mesurés)
4) inférence       infer_media.py  (image|tts|video|av)
5) intégration     bridge/gen3_media_bridge.py → API REST pour gen3ia.online
```

## 3. Niveaux de performance (GPU obligatoire)

| | `l4` (plancher 22 Go) | `a100_40g` (plancher 36 Go) |
|---|---|---|
| Image | SDXL 768 px, LoRA r16, bs1×4 | SDXL 1024 px, LoRA r32, bs2×2 |
| TTS | F5 bs1, accum 2 | F5 bs2, accum 1 |
| Vidéo | LTX 480×288, 41 frames, r16 | LTX 704×448, 57 frames, r32 |
| AV neural | preset `small` (0,1 B) 192 px | preset `base` (0,8 B) 256 px |

`--profil auto` détecte la VRAM réelle. **Sans CUDA → refus propre** : gen3 ne
s'entraîne pas et ne génère pas sur CPU, par conception.

## 4. Licences — LIRE AVANT COMMERCIALISATION

- **SDXL 1.0** : OpenRAIL++-XL — usage commercial autorisé avec restrictions d'usage.
- **LTX-Video 0.9.7** : LTXV Open Weights License — commercial sous plafond de revenus.
- **F5-TTS (poids)** : **CC-BY-NC-4.0 — NON COMMERCIAL.** Un adaptateur entraîné dessus
  hérite de cette restriction. Pour du commercial : utiliser la voie `kokoro` (Apache-2.0)
  en inférence, ou re-fine-tuner une base commercialement autorisée.
- **Datasets conseillés** (notebook) : COCO val-2014 (CC-BY, images), Multilingual
  LibriSpeech « french » (CC-BY, parole). Vos propres médias restent sous VOS droits.
- Le dataset `gen3_multimodal_792k` (texte FR synthétique, sans médias binaires) sert au
  volet storyboard/instructions — il ne contient aucun média et ne sert PAS au photoréalisme.

## 5. Intégration à gen3ia.online (VPS 2 Go, sans GPU)

Le VPS ne peut pas héberger SDXL (~7 Go) ni LTX (~10 Go). L'intégration honnête :

1. Héberger ce pont sur la machine GPU : `MEDIA_BRIDGE_API_KEY=... python bridge/gen3_media_bridge.py`
2. Sur gen3ia.online, configurer `MEDIA_BRIDGE_URL` + `MEDIA_BRIDGE_API_KEY` ; le backend
   appelle `POST /v1/image | /v1/tts | /v1/video`, reçoit le média en base64, l'archive
   en R2 (chemin permanent utilisateur) et le sert au client.
3. `GET /capabilities` sur le pont ne déclare que ce qui tourne réellement (convention
   honnêteté du training-worker : GPU réel uniquement).

## 6. Colab

Notebook : `colab-entrainement-gen3-media.ipynb` (à la racine du dépôt / livré avec le zip).
Secrets Colab requis : `HF_TOKEN` (votre token Hugging Face), `GITHUB_TOKEN` (lecture du dépôt).
Il enchaîne : datasets → 3 entraînements → tests d'inférence → benchmarks → sauvegarde
Drive (+ push optionnel des adaptateurs sur le Hub HF).

## 7. Arborescence

```
gen3-media-pack/
├── profils.py                  # 2 niveaux GPU, refus propre sans CUDA
├── prepare_image_dataset.py    # manifest + dédoublonnage SHA-256 + split
├── prepare_audio_dataset.py    # durées réelles + garde-fou alignement + CSV F5
├── prepare_video_dataset.py    # sondage ffprobe + captions + split
├── train_image_sdxl.py         # LoRA SDXL (reprise checkpoint, val_loss)
├── train_tts_f5.py             # wrapper finetune F5-TTS (CLI officiel)
├── train_video_ltx.py          # LoRA LTX-Video (flow matching diffusers)
├── train_av_neural.py          # AV-DiT gen3 « ondes » (expérimental)
├── infer_media.py              # CLI unifié image|tts|video|av
├── bench_media.py              # latence/RTF réels → JSON
├── bridge/gen3_media_bridge.py # API REST GPU-only pour gen3ia.online
├── requirements.txt            # versions épinglées
└── README_FR.md                # ce fichier
```
