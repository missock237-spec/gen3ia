# Gen3 — entraînement multimodal d'images, audio et vidéo

Ce paquet fournit un orchestrateur Python pour les jobs d'entraînement des modèles appartenant aux utilisateurs de Gen3. Il centralise la validation, les ressources GPU, les journaux, la durée maximale, l'état du job et l'appel de scripts d'entraînement spécialisés.

## Limite importante

Il n'existe pas un algorithme unique compatible avec tous les modèles de génération d'images, d'audio et de vidéo. Ce script **orchestre** des trainers spécialisés; il ne remplace pas leurs algorithmes. Le script de trainer doit être installé et vérifié par l'administrateur sous `trainers/`. Ne laisse jamais un utilisateur téléverser un script Python arbitraire et demander au serveur de l'exécuter.

Exemples de familles de trainers :
- Images : un trainer LoRA Diffusers compatible avec l'architecture exacte du modèle.
- Audio : un trainer adapté au modèle (TTS, génération audio, speech-to-text, audio classification, etc.).
- Vidéo : un trainer vidéo compatible avec l'architecture et le format des clips.

Les options de ligne de commande ne sont pas universelles : elles doivent correspondre au trainer choisi.

## Arborescence

Sous `--root` (ex. `/srv/gen3`), crée :
```
models/<owner_id>/<model files>
datasets/<owner_id>/<job dataset>
trainers/<trusted trainer>.py
outputs/<owner_id>/<job_id>/
state/<owner_id>/<job_id>.json
state/<owner_id>/<job_id>.log
```

## Installation minimale

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install torch
# Installer ensuite les dépendances adaptées au trainer réellement utilisé :
# pip install transformers datasets accelerate peft diffusers
```

Il faut un PyTorch configuré pour le GPU CUDA utilisé par le serveur. La commande `pip install torch` seule peut installer une version CPU selon l'environnement; vérifier la compatibilité avec le driver CUDA du serveur.

## Exemple de configuration

Copie `job.image.example.json`, `job.audio.example.json` ou `job.video.example.json`, puis adapte :
1. `model_path` au chemin relatif du modèle déjà présent dans `models/<owner_id>/`.
2. `dataset_path` au dataset dans `datasets/<owner_id>/`.
3. `trainer_script` au trainer **déjà installé par l'administrateur** dans `trainers/`.
4. `training_args` aux arguments exigés par ce trainer.

Les chemins sont relatifs à chaque dossier autorisé. Les datasets doivent contenir au moins un fichier média avec l'extension attendue. Cela ne garantit pas que le dataset a le bon schéma; chaque trainer peut exiger captions, métadonnées JSONL/CSV, durées, fréquences d'échantillonnage ou annotations spécifiques.

## Lancer

```bash
python3 gen3_multimodal_trainer.py validate --config job.image.example.json --root /srv/gen3
python3 gen3_multimodal_trainer.py run --config job.image.example.json --root /srv/gen3
python3 gen3_multimodal_trainer.py status --owner user_123 --job image_lora_001 --root /srv/gen3
python3 gen3_multimodal_trainer.py cancel --owner user_123 --job image_lora_001 --root /srv/gen3
```

`validate` vérifie les chemins, les fichiers et le GPU. Il ne vérifie pas que les options fournies sont compatibles avec le modèle. Pour commencer, utilise des petits datasets de test, une faible résolution, un batch size de 1 et un nombre réduit de steps.

## Intégration dans Gen3ia en production

- Exécute chaque job dans un conteneur isolé et avec un utilisateur OS sans privilèges.
- Place les modèles, datasets et sorties de chaque utilisateur dans des chemins séparés.
- Ajoute une file de jobs et un planificateur GPU (par exemple une file Redis) pour plusieurs utilisateurs.
- Limite la VRAM, la RAM, le disque, la durée, le nombre de jobs et la taille des uploads.
- Valide les droits d'accès côté serveur; ne fais pas confiance à `owner_id` reçu du client.
- Garde les checkpoints, les journaux et les métriques hors de la mémoire du processus web.
- Ne charge jamais un modèle ou un checkpoint non fiable avec des options qui exécutent du code arbitraire.
- Prévois une politique de suppression des datasets, checkpoints et logs.

Le serveur Gen3ia avec 2 Go de RAM ne suffit pas à entraîner sérieusement des modèles génératifs image/audio/vidéo modernes. Utilise un GPU cloud approprié; le script peut être placé sur le serveur d'orchestration, mais le calcul doit se faire sur une machine GPU.

---

## Ajouts gen3ia — chaîne complète « plan → validate → run »

Le kit d'origine ORCHESTRAIT mais ne fournissait ni planificateur ni trainers.
gen3ia complète le kit avec les pièces manquantes, en respectant les mêmes
règles de sécurité (le trainer reste un script installé par l'administrateur) :

| Fichier | Rôle |
|---|---|
| `plan_gen3.py` | **Générateur de plans** : analyse réelle du dataset (dimensions d'images via PIL, durées d'audio via wave, vidéos via ffprobe, couverture des captions), choix du palier VRAM (convention gen3 `l4` / `a100_40g`), hyperparamètres recommandés, estimation de durée (ordre de grandeur affiché comme hypothèse), avertissements honnêtes, et écriture d'une **config de job prête** pour l'orchestrateur. |
| `trainers/image/train_model.py` | Trainer LoRA complet pour pipelines UNet (SD 1.5 / SD 2) : captions obligatoires (même nom .txt), loss bruit MSE, checkpoints + reprise `--resume`, GPU obligatoire. |
| `trainers/audio/train_model.py` | Trainer TTS complet (SpeechT5 + LoRA) : dataset `.wav` + `metadata.csv` (`file_name,text`), re-échantillonnage mono 16 kHz géré, checkpoints + reprise. |
| `trainers/video/train_model.py` | Trainer LoRA vidéo complet (LTX-Video, flow matching) : clips + captions `.txt`, frames ≡ 1 mod 8, normalisation latents (latents_mean/std), checkpoints + reprise. |

### Chaîne complète (image, idem audio/vidéo)

```bash
# 1) PLAN : analyser le dataset et produire le plan + la config de job
python3 plan_gen3.py --modality image --dataset datasets/user_123/portraits \
    --gpu-vram-gb 24 --owner user_123 --job-id img_001 \
    --output plan.img.json --write-config job.img_001.json

# 2) VALIDATE : l'orchestrateur vérifie chemins, médias, trainer, GPU
python3 gen3_multimodal_trainer.py validate --config job.img_001.json --root /srv/gen3

# 3) RUN : entraînement supervisé (timeout, état JSON, journal)
python3 gen3_multimodal_trainer.py run --config job.img_001.json --root /srv/gen3

# 4) SUIVRE / ARRÊTER
python3 gen3_multimodal_trainer.py status --owner user_123 --job img_001 --root /srv/gen3
python3 gen3_multimodal_trainer.py cancel --owner user_123 --job img_001 --root /srv/gen3

# Reprise après interruption : relancer run avec --resume côté trainer
# (ajouter "--resume" aux training_args du job ou relancer le trainer directement)
```

### Contrats des datasets (résumé)

- **image** : `dataset/` avec `<nom>.jpg` + `<nom>.txt` (caption) pour CHAQUE image.
- **audio** : `dataset/` avec `*.wav` (16 kHz recommandé) + `metadata.csv` (`file_name,text`).
- **video** : `dataset/` avec `<nom>.mp4` + `<nom>.txt` (caption) pour CHAQUE clip.

### Ce qui reste sous la responsabilité de l'administrateur

- Installer et vérifier les trainers (ce dépôt fournit ceux de gen3ia, ciblés
  UNet-SD / SpeechT5 / LTX-Video) et valider la compatibilité modèle↔trainer.
- Un conteneur isolé + utilisateur OS non privilégié par job, quotas VRAM/RAM/
  disque, file de jobs (cf. orchestrator-24h du dépôt gen3ia).
- Vérifier les LICENCES du modèle de base ET du dataset de l'utilisateur.
- Le calcul réel doit tourner sur une machine GPU ; ce kit peut être servi
  depuis le VPS gen3ia (2 Go) mais n'y exécutera pas d'entraînement sérieux.
