# AI Training Studio — documentation technique

> Section Gen3ia permettant de créer, entraîner, évaluer et exporter des modèles IA.
> Introduit par la branche `feat/training-studio` (v1 — socle fonctionnel complet).

## 1. Positionnement et honnêteté technique

Le studio est conçu autour d'une règle absolue : **aucune simulation d'entraînement en production**.

- Une tâche (`TrainingJob`) ne passe jamais à `completed` sans exécution réelle rapportée par un fournisseur GPU.
- Sans fournisseur GPU configuré, la tâche reste `queued` avec `waitingReason = "no-gpu-provider"` et un événement explicite dans son journal.
- La progression (`progressPercent`, `trainLoss`, métriques) provient **exclusivement** du fournisseur — jamais calculée côté plateforme.
- Les estimations (VRAM, durée) sont toujours étiquetées comme telles dans l'UI et l'API.
- Le fournisseur `mock` (simulation) est réservé aux tests : double condition `TRAINING_ALLOW_MOCK=true` **et** `NODE_ENV != production`, chaque tâche porte `simulated: true`, chaque événement est préfixé `[SIMULATION]`.

## 2. Architecture

```
app/workspace/training/                 UI (7 étapes, 3 modes, thème AURORA OS)
  page.tsx                              liste des projets + création
  [projectId]/page.tsx                  espace projet (Projet→Modèle→Données→Analyse→Entraînement→Évaluation→Export)
  training.css                          styles spécifiques (stepper, journal, cartes plan)

components/training/
  project-workspace.tsx                 composant client principal (7 étapes)
  studio-bits.tsx                       briques partagées (chips, progression, journal, erreurs)

app/api/training/
  projects/                             GET liste, POST création (+ [id] GET/PATCH/DELETE)
  projects/[id]/models/                 GET, POST upload multipart + validation, DELETE
  projects/[id]/datasets/               GET, POST upload multipart + analyse, PATCH split, DELETE
  projects/[id]/analysis/               POST — analyse IA → plan proposé
  projects/[id]/plans/                  GET historique, PATCH paramètres (mode avancé)
  projects/[id]/jobs/                   GET liste + sweep opportuniste
  plans/[planId]/accept/                POST — acceptation → création de tâche + dispatch
  jobs/[jobId]/                         GET détail (rafraîchi si en cours)
  jobs/[jobId]/cancel/                  POST — annulation propagée au fournisseur
  catalog/                              GET — moteurs, modèles de base, fournisseurs sondés, quotas
  exports/                              POST préparation ZIP, GET [exportId] lien signé

lib/training/
  types.ts                              schémas zod (projet, assets, plan, job, export)
  repository.ts                         persistance R2 (user-data-store, clés users/{uid}/training/…)
  quotas.ts                             limites serveur (env-configurables)
  validation/model-files.ts             validation octet par octet (safetensors, GGUF, ZIP)
  validation/dataset-files.ts           analyse réelle des datasets (CSV/JSON/JSONL/TXT, RGPD)
  engines/registry.ts                   moteurs déclarés + cohérence des plans
  providers/types.ts                    abstraction GpuProvider (capabilities/submit/status/cancel)
  providers/worker-http.ts              worker GPU distant (TRAINING_WORKER_URL)
  providers/mock.ts                     simulation tests/dev (double garde-fou)
  orchestrator.ts                       machine à états, dispatch, sweep opportuniste
  assistant.ts                          analyse IA (generate) + repli heuristique étiqueté
  exports.ts                            archives ZIP + liens signés temporaires
  catalog.ts                            catalogue (références HF publiques)
```

### Persistance

Aucune nouvelle base : le studio réutilise le magasin R2 existant (`lib/storage/user-data-store`).

- Documents JSON : `users/{uid}/training/projects/{projectId}[/models|datasets|plans|jobs|exports]/{id}.json`
- Fichiers binaires : `users/{uid}/training-files/{projectId}/{assetId}`
- Exports ZIP : `users/{uid}/training-exports/{projectId}/{exportId}.zip`

Chaque lecture est préfixée par l'uid de l'appelant : le projet d'un autre utilisateur est indiscernable d'un projet inexistant (anti-énumération).

### Orchestration

Machine à états explicite : `queued → running → completed | failed | cancelled` (+ `scheduled`, relance `failed → queued`). Les transitions sont validées par `canTransition()` avant chaque écriture.

Le dispatch est **opportuniste** (pattern dispatch-loop du projet) : les routes de listing (`GET /projects/[id]`, `GET /projects/[id]/jobs`) déclenchent `sweepUserJobs()` — dispatch des tâches en attente, rafraîchissement des tâches en cours. Aucune boucle permanente n'est requise sur le VPS mono-process ; l'UI pole toutes les 5 secondes pendant une tâche active.

### Assistant IA

`generateTrainingPlan()` construit le contexte **réel** du projet (statuts de validation, statistiques de datasets, audit des splits, capacités des moteurs) et appelle le routeur IA de la plateforme (`lib/ai/router`). La réponse doit être un JSON contraint, revalidé et borné par les capacités déclarées du moteur. Si l'IA est indisponible ou répond hors format, un **repli heuristique déterministe** produit un plan étiqueté `heuristic-fallback` — jamais présenté comme une analyse IA.

## 3. Sécurité

- Formats pickle (`.pt`, `.pth`, `.ckpt`, `.pkl`) refusés à l'import : désérialisation = exécution de code potentielle.
- `.safetensors` : header JSON réellement lu et vérifié. `.gguf` : magic vérifié. `.zip` : structure inspectée (path-traversal rejeté).
- Datasets : analyse serveur (doublons, lignes vides, détection emails/téléphones → avertissement RGPD).
- Uploads plafonnés (`TRAINING_MAX_UPLOAD_MB`, défaut 200 Mo) ; taille vérifiée avant lecture complète.
- Liens d'export signés et temporaires (défaut 30 min, `TRAINING_EXPORT_TTL_MINUTES`) ; propriété vérifiée avant signature.
- Rate limits : 5 analyses IA/min, 10 exports/heure, en plus du quota global `requireUser` (100 req/min).
- Aucun secret n'est exposé aux tâches : le worker GPU reçoit des clés de stockage, jamais les variables d'environnement de la plateforme.

## 4. Variables d'environnement

Voir `.env.example` (section AI TRAINING STUDIO). Toutes facultatives. Sans `TRAINING_WORKER_URL`, aucun entraînement réel ne démarre — c'est le comportement attendu et affiché honnêtement dans l'UI.

## 5. Limites connues (v1)

1. **Aucun worker GPU déployé à ce jour** : l'exécution réelle exige le service Python `training-worker/` (FastAPI + PyTorch/Transformers/PEFT, contrat conforme à `lib/training/providers/worker-http.ts` : capabilities/submit/status/cancel), exposé par `TRAINING_WORKER_URL` et protégé par `TRAINING_WORKER_TOKEN`. Son déploiement (GPU dédié — RunPod, Modal, Vast.ai, machine locale) reste une décision utilisateur : aucun hébergement payant n'est activé sans autorisation explicite. Un hôte CPU ne sert honnêtement que le moteur `rag-index` (entrée `cpu` déclarée à `vramGb` 0).
   Par ailleurs, `GET /api/cron/training-sweep` (protégée par `CRON_SECRET`) balaye les tâches actives de tous les utilisateurs — dispatch et rafraîchissement même onglet fermé.
2. Moteurs image/audio/vidéo : non implémentés — le catalogue n'affiche que les capacités réelles (`available`), les familles non supportées sont déclarées mais marquées indisponibles.
3. Uploads en une seule requête multipart (jusqu'à 200 Mo par défaut) : le téléversement reprenable (multipart R2 natif) est une évolution prévue.
4. L'évaluation post-entraînement affiche les métriques rapportées par le moteur ; les benchmarks automatisés (jeux de tests standardisés) sont une évolution.
5. La fusion adaptateur→modèle complet (merge LoRA) et la conversion de formats sont à la charge du worker GPU (v2).

## 6. Tests

- `lib/training/validation/model-files.test.ts` — safetensors (header valide/invalide/tronqué/léger), GGUF, refus pickle, ZIP, .bin.
- `lib/training/validation/dataset-files.test.ts` — CSV/JSONL/JSON/TXT, doublons, PII, refus, audit des splits.
- `lib/training/rules.test.ts` — quotas, machine à états, cohérence plans/moteurs.
- `lib/training/orchestrator.test.ts` — honnêteté sans fournisseur, cycle simulé étiqueté, annulation, garde-fous de création.
- `lib/training/assistant.test.ts` — contexte réel, repli heuristique, bornage des paramètres.
- `app/api/training/projects/route.test.ts` — 401, validation des champs, création, transmission des quotas.
- `lib/training/hub/*.test.ts` (v1.1) — connecteurs HF/Kaggle (normalisation, aperçus, plafonds), sélection de fichiers, audit, budget de minutes.
- `lib/training/sweep.test.ts` — balayage global (recensement des uid, plafonds, isolation des erreurs, propagation des pannes de stockage).
- Worker Python : `training-worker/tests/` (contrat API, auth Bearer, schémas, hygiène des imports — exécutables sans torch ni boto3 via `requirements-dev.txt`).

## 7. v1.1 — Import de datasets depuis les hubs

### Connecteurs (lib/training/hub/)

- **Hugging Face** : recherche (`/api/datasets?search=`), inspection (`/api/datasets/{id}` + `datasets-server` `/info` et `/first-rows` pour les splits déclarés et un échantillon de lignes réelles), téléchargement (`/resolve/main/{fichier}`). La taille exacte des fichiers n'est pas exposée par l'API de listing — note honnête affichée, plafond appliqué au téléchargement.
- **Kaggle** : recherche (`/api/v1/datasets/list?search=`), inspection (`/datasets/view` + `/datasets/list` pour les fichiers avec tailles), aperçu (téléchargement du plus petit fichier ingérable ≤ 2 Mo), téléchargement par fichier (`/datasets/download/{owner}/{slug}/{fichier}`). Authentification Bearer via `KAGGLE_API_TOKEN` (serveur uniquement). Kaggle ne déclare pas de splits : note explicite, affectation train/validation/test à la charge de l'utilisateur après import.
- Sécurité : hôtes fixes (aucune URL client résolue — anti-SSRF), références validées par regex stricte, timeouts `AbortController`, plafonds de réponse (5 Mo JSON) et de fichiers, jetons jamais exposés au client.
- Import (`POST /api/training/projects/[id]/datasets/import`) : sélection des fichiers ingérables (.csv/.json/.jsonl/.txt) sous plafonds serveur, téléchargement réel, validation par le MÊME pipeline que les téléversements, stockage R2. Les fichiers écartés sont retournés avec leur raison. Les métadonnées d'origine (lignes totales déclarées, splits, licence, échantillon) sont conservées sur l'asset et alimentent l'assistant IA.

### Quotas étendus (v1.1)

- `TRAINING_MAX_STORAGE_MB` (défaut 2048) : stockage total (datasets + modèles + exports) vérifié à chaque écriture (`assertStorageQuota`).
- `TRAINING_MAX_MINUTES_PER_MONTH` (défaut 60) : budget de minutes d'entraînement par mois civil ; l'estimation de durée du plan sert de réservation prudente à l'acceptation (`assertTrainingMinutesBudget`), la consommation réelle est calculée depuis les jobs démarrés. Estimation ≠ mesure : sans estimation, rien n'est bloqué.
- `TRAINING_MAX_HUB_IMPORT_MB` (défaut 500) : taille totale maximale d'un import hub.
- Le plafond de durée déclaré par un fournisseur GPU (`maxDurationMinutes`) écarte désormais honnêtement les fournisseurs trop courts pour l'estimation du plan (le job reste en file avec la raison).

### Journal d'audit (v1.1)

`lib/training/audit.ts` — entrées par préfixe mensuel `users/{uid}/training-audit/{aaaa-mm}/`, écrites en fire-and-forget (jamais bloquantes). Actions tracées : cycle de vie des projets, imports (upload ET hub, avec source/tailles/compteurs), analyses, acceptations de plans, création/annulation de jobs, exports (préparation + téléchargement), refus de quota projet. Les détails sont sanitisés (identifiants et compteurs uniquement — aucun contenu, aucun secret).
