# Gen3ia — Worker GPU d'entraînement

Service Python autonome (FastAPI + PyTorch/PEFT) qui exécute les tâches
d'entraînement du **AI Training Studio** de Gen3ia. Il implémente **exactement**
le contrat consommé par la plateforme Next.js dans
`lib/training/providers/worker-http.ts` (fournisseur « Worker GPU distant »).

> Règle absolue du studio : **aucune simulation d'entraînement en production**.
> Chaque progression, chaque perte, chaque métrique provient d'une exécution
> réelle. Le moteur `fake` (tests) n'est accepté que si
> `WORKER_ALLOW_FAKE_ENGINE=true`. gen3 est conçu pour exploiter les ressources
> GPU disponibles : `/capabilities` ne déclare que des GPU CUDA réels — le CPU
> n'est jamais une capacité de calcul pour l'IA.

## 1. Architecture

```
services/training-worker/
├── Dockerfile                  image de déploiement (+ variante CUDA commentée)
├── requirements.txt            dépendances de déploiement (torch, peft, boto3…)
├── requirements-dev.txt        dépendances de test (pytest, httpx — ni torch ni boto3)
├── pytest.ini                  testpaths=tests, -q
└── training_worker/
    ├── app.py                  routes du contrat, détection GPU (torch.cuda paresseux)
    ├── auth.py                 Bearer + hmac.compare_digest (503 si WORKER_TOKEN absent)
    ├── config.py               Settings (variables d'environnement uniquement)
    ├── schemas.py              miroir pydantic de SubmitJobPayload / ProviderJobState
    ├── job_manager.py          file à concurrence bornée, annulation, persistance d'état
    ├── storage.py              R2 (S3-compatible) via boto3 — import paresseux
    └── engines/
        ├── __init__.py         ENGINE_REGISTRY + resolve(engine_id, allow_fake)
        ├── base.py             EngineContext, BaseEngine, EngineError, bornage paramètres
        ├── dataset_io.py       lecture json/jsonl/csv/txt, paires de champs, chunking
        ├── model_loading.py    catalogue HF ou upload R2 (ZIP sécurisé, limites honnêtes)
        ├── text_lora.py        LoRA / QLoRA (torch + transformers + peft + Trainer)
        ├── text_eval.py        évaluation seule (perte + exactitude par token)
        ├── rag_index.py        indexation vectorielle (sentence-transformers + numpy)
        └── fake.py             moteur de TEST (gated par WORKER_ALLOW_FAKE_ENGINE)
```

Aucune bibliothèque lourde (torch, transformers, peft, sentence-transformers,
numpy, boto3) n'est importée au chargement du package : le service démarre et
répond sur un hôte CPU seul, et les tests tournent sans rien installer de lourd.

## 2. Contrat API

Toutes les routes sauf `/healthz` exigent `Authorization: Bearer <WORKER_TOKEN>`
(comparaison à temps constant). Sans `WORKER_TOKEN` configuré, elles répondent
**503** — jamais d'accès ouvert.

| Route | Réponse |
|---|---|
| `GET /healthz` | `200 {"ok": true}` — sans authentification (monitoring) |
| `GET /capabilities` | `200 {"gpus": [{"name","vramGb","available"}], "maxDurationMinutes": null}` |
| `POST /jobs` | `201 {"externalId": "…"}` — l'exécution démarre en arrière-plan |
| `GET /jobs/{externalId}` | `200` ProviderJobState complet — `404` si inconnu |
| `POST /jobs/{externalId}/cancel` | `200 {"ok": true}` — `404` si inconnu |

### Capacités

- Les GPU sont détectés **réellement** via `torch.cuda` (nom + VRAM). Sans
  torch ou sans CUDA : aucune entrée GPU — rien n'est inventé, et surtout pas
  de pseudo-entrée « cpu » : un hôte sans GPU n'a aucune capacité d'IA.
- `maxDurationMinutes` vient de `MAX_DURATION_MINUTES` (ou `null`). Cette durée
  est aussi **appliquée** par un watchdog : au bout du délai, la tâche échoue
  au prochain point de contrôle du moteur.

### Soumission (POST /jobs)

```json
{
  "jobId": "job_abc",
  "engineId": "text-lora",
  "method": "lora",
  "parameters": {"learningRate": 2e-4, "epochs": 3, "batchSize": 4, "loraRank": 16,
                 "loraAlpha": 32, "loraDropout": 0.05, "maxSequenceLength": 1024,
                 "gradientAccumulation": 2},
  "baseModel": {"kind": "catalog", "ref": "google/gemma-2-2b-it"},
  "datasets": [{"storageKey": "users/{uid}/training-files/{projectId}/{assetId}",
                 "split": "train", "format": "jsonl"}]
}
```

- Payload invalide → `422` (pydantic) ; moteur/méthode inconnu → `400`.
- Au-delà de `MAX_CONCURRENT_JOBS` (défaut 1), les tâches attendent en file :
  elles rapportent le statut `running` avec `progressPercent` à `null` jusqu'à
  leur démarrage réel.
- `baseModel.kind = "upload"` exige `storageKey` (archive ZIP d'un dossier de
  modèle **complet** : `config.json` + tokenizer + poids).

### État (GET /jobs/{externalId})

Miroir de `ProviderJobState` : `status` (`running|completed|failed`),
`progressPercent`, `currentStep`, `epochsDone/epochsTotal`, `trainLoss`,
`metrics`, `logs` (plafonnés à 500 lignes en mémoire — la plateforme garde les
50 dernières), `error`, `artifacts` (`label`/`storageKey`/`sizeBytes`).

Les artefacts sont téléversés vers
`users/{uid}/training-files/{projectId}/{jobId}/{safe_label}` — préfixe dérivé
du **premier** dataset de la tâche.

### Annulation

`POST /jobs/{id}/cancel` positionne un `threading.Event` ; le moteur interrompt
au prochain point de contrôle (callback Trainer, batch d'évaluation, chunk
RAG…) et la tâche devient `failed` avec l'erreur « Annulé par la plateforme. ».

## 3. Moteurs

| Moteur | Méthodes | Paramètres | Artefacts | Métriques |
|---|---|---|---|---|
| `text-lora` | `lora`, `qlora`, `adapter` | learningRate, epochs, batchSize, loraRank, loraAlpha, loraDropout, maxSequenceLength, gradientAccumulation | `adapter.safetensors`, `adapter-config.json`, `tokenizer.json` | `train_loss` |
| `text-eval` | `eval-only` | batchSize, maxSequenceLength | aucun (aucun poids modifié) | `eval_loss`, `token_accuracy`, `samples` |
| `rag-index` | `rag` | chunkSize, chunkOverlap | `index.npz`, `chunks.json`, `rag-config.json` | `chunks`, `dimensions` |
| `fake` | (toutes — tests) | — | artefact minuscule | `fake_metric` |

- **text-lora** : `AutoModelForCausalLM` + `AutoTokenizer` (float16 sur CUDA,
  float32 sur CPU), `LoraConfig` PEFT (`target_modules=["q_proj","v_proj"]`),
  `DataCollatorForLanguageModeling`, `Trainer` avec callback qui relaie
  progression/perte/annulation. QLoRA ajoute `BitsAndBytesConfig` 4 bits —
  **bitsandbytes et CUDA requis** (échec honnête sinon).
- **Champs de datasets reconnus** : `prompt`/`completion`, `instruction`/`output`,
  `text`/`label`, ou `text` seul (txt : un document par ligne).
- **rag-index** : modèle d'embedding fixe
  `sentence-transformers/all-MiniLM-L6-v2` — aucun poids de LLM n'est modifié.
- Les paramètres sont **bornés** comme dans le registre côté plateforme
  (refus clair si hors bornes — jamais d'acceptation en silence).

## 4. Variables d'environnement

| Variable | Défaut | Rôle |
|---|---|---|
| `WORKER_TOKEN` | — | Jeton Bearer partagé avec la plateforme (`TRAINING_WORKER_TOKEN` côté Next.js). **Absent → 503 sur les routes protégées.** |
| `WORKER_HOST` / `WORKER_PORT` | `0.0.0.0` / `8000` | Écoute (usage `python -m training_worker.app`) |
| `MAX_DURATION_MINUTES` | `null` | Durée max d'une tâche (annoncée + appliquée) |
| `MAX_CONCURRENT_JOBS` | `1` | Tâches réellement parallèles |
| `WORKER_ALLOW_FAKE_ENGINE` | `false` | Autoriser le moteur de test `fake` |
| `WORK_DIR` | `./work` | Téléchargements, artefacts locaux, une dir par tâche |
| `JOBS_STATE_FILE` | `./jobs-state/jobs.json` | État persistant (reprise après redémarrage) |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | — | Stockage R2 (endpoint `https://{account}.r2.cloudflarestorage.com`) |

Si R2 (ou boto3) manque alors qu'une tâche en a besoin → **échec honnête**
avec un message clair — jamais de succès simulé. Au redémarrage du worker,
les tâches interrompues (« running » persistées) deviennent des échecs :
« Worker redémarré pendant l'exécution. »

## 5. Déploiement

### Local (machine GPU)

```bash
cd training-worker
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt -r requirements-dev.txt

export WORKER_TOKEN="votre-jeton-partagé"
export R2_ACCOUNT_ID=… R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=… R2_BUCKET=…
uvicorn training_worker.app:app --host 0.0.0.0 --port 8000
```

Côté plateforme : `TRAINING_WORKER_URL=http://<hôte>:8000` et
`TRAINING_WORKER_TOKEN=<même jeton>`.

### Docker (développement — service et tests sans GPU)

```bash
docker build -t gen3ia-training-worker ./training-worker
docker run --rm -p 8000:8000 \
  -e WORKER_TOKEN=… -e R2_ACCOUNT_ID=… -e R2_ACCESS_KEY_ID=… \
  -e R2_SECRET_ACCESS_KEY=… -e R2_BUCKET=… \
  gen3ia-training-worker
```

Pour l'entraînement LoRA/QLoRA réel, utiliser la **variante CUDA** documentée
dans le Dockerfile (image `pytorch/pytorch:…-cuda…-runtime` + `bitsandbytes`),
et exposer le GPU (`--gpus all`).

### Hébergements GPU (choix de l'utilisateur — aucun n'est déployé par défaut)

- **RunPod / Vast.ai** (instances GPU à la demande) : lancer le conteneur CUDA
  ci-dessus, exposer le port 8000, renseigner les variables R2 et le jeton ;
  l'URL publique devient `TRAINING_WORKER_URL` côté plateforme. Vérifier
  `curl http://<hôte>:8000/healthz` avant de valider la configuration.
- **Modal** : `modal deploy` d'une fonction qui `uvicorn` ce package (image
  python 3.11 + `requirements.txt`, GPU `A10G`/`L4` conseillés pour LoRA).
- Bonnes pratiques : jeton long et aléatoire, TLS devant le worker (reverse
  proxy), `MAX_DURATION_MINUTES` aligné sur le budget de la plateforme.

## 6. Tests

```bash
python3 -m venv .venv-qa
.venv-qa/bin/pip install fastapi "uvicorn[standard]" pydantic pytest httpx
.venv-qa/bin/python -m pytest
```

Les tests (25) couvrent : authentification (401/503, /healthz libre), forme
exacte de `/capabilities` (GPU réels uniquement — jamais d'entrée CPU,
maxDurationMinutes), cycle complet
fake (201 → état ProviderJobState → artefacts), validation des payloads
(422/400, moteur fake refusé par défaut), annulation, redémarrage (tâches
interrompues marquées en échec) et **hygiène d'import** (aucun module lourd
tiré au chargement). Ils passent **sans torch ni boto3**.

## 7. Limites connues (honnêtes)

1. **Pas de GPU = aucune tâche d'IA** : gen3 exploite les ressources GPU
   disponibles (L4, A100…) — text-lora exige CUDA + bitsandbytes ; un hôte
   sans GPU déclare une liste vide et ne reçoit jamais d'entraînement.
   rag-index reste un utilitaire documentaire (chunking/embeddings) exécutable
   là où un hôte en dispose, sans jamais être annoncé comme calcul IA.
2. **Un fichier de poids seul ne suffit pas** : un upload `.safetensors`
   isolé n'a ni `config.json` ni tokenizer → refus explicite (fournir une
   archive ZIP du dossier de modèle complet). GGUF (llama.cpp) refusé.
3. **Pas de fusion adaptateur → modèle complet** en v1 : l'export adaptateur
   exige le modèle de base à l'inférence (merge = évolution v2, à la charge du
   worker).
4. **Modèle d'embedding RAG fixe** (`all-MiniLM-L6-v2`) — non paramétrable v1.
5. L'état persistant garde les 200 dernières tâches (fichier borné) ; les
   tâches plus anciennes ne sont plus sondables par le worker.
6. Aucun worker GPU n'est déployé par défaut : sans `TRAINING_WORKER_URL`
   côté plateforme, aucune tâche ne démarre — c'est le comportement attendu.
