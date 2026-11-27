# Rapport GTIS Phase 1 — unification de l'orchestration d'entraînement

**Date :** 2026-11-28 · **Job :** 478451 (itération cron 01:10 +08:00) · **Branche :** main

## 1. Objet

Exécuter la Phase 1 de la feuille de route GTIS
(`docs/architecture/feuille-de-route-gtis.md`, issue des deux audits externes
vérifiés le 2026-11-27) : brancher le gestionnaire de runs UCE-013
(`lib/capabilities/training/model-training-manager.ts`) sur le moteur
d'entraînement RÉEL du dépôt — jusqu'ici le gestionnaire était une
infrastructure dormante (aucun consommateur, constat vérifié et documenté
dans son en-tête v2).

## 2. Livraison

### 2.1 Branchement réel (le gestionnaire ne dort plus)

| Élément | Contenu |
|---|---|
| Point de branchement | `lancerEntrainement` (`lib/neural/training/job.ts`) — l'unique point d'entrée du moteur vrai ; le pipeline MLOps (`lib/mlops/pipeline.ts` via `creerAdaptateurNeuralLocal`) et la route `/api/neural/train` héritent du branchement **par le même point**, sans chemin d'exécution supplémentaire (respect du constat audit « trop de chemins ») |
| Cycle de vie | score **AVANT** mesuré sur le cortex avant toute passe → `planifierRun` (datasets réels vérifiés, RAM mesurée) → `demarrerRun` (liaison jobId, statut `en_cours`) → entraînement réel → score **APRÈS** mesuré sur les MÊMES thèmes → `cloreRun` (delta réel, anti-régression −0.02, leçon enregistrée via `enregistrerLearning`) ; job échoué → `echouerRun` (cause réelle, **aucun** scoreApres fabriqué) |
| Fail-soft | Tout le branchement est try/catch + warn : un registre indisponible n'annule JAMAIS un entraînement (l'entraînement est prioritaire sur son instrumentation) |
| Traçabilité | `job.runUce` (id du run, scoreAvant, datasets réels) et `job.runUceCloture` (scoreApres, delta, statut, cause) exposés par `GET /api/neural/train` |

### 2.2 Nomenclature unique + reprise idempotente

- `statutJobVersRun()` : LA correspondance job ↔ run (en_cours/termine/echec),
  consommée par le branchement lui-même ; `planifie` et `annule` restent des
  états propres au gestionnaire (déclaration avant job).
- Confinement des datasets étendu aux **racines réelles** du dépôt :
  `datasets/`, `training/gen3-domain-datasets/data/`, `public/llms*.txt`
  (nom vérifié) — tout autre chemin reste refusé (traversées `../`, fichiers
  publics non corpus, racine du dépôt).
- Reprise après interruption : un job interrompu ne persiste rien (sauvegarde
  du cerveau uniquement en fin de job) → le cerveau recharge l'état persisté
  et un NOUVEAU job reprend de façon idempotente ; les runs `en_cours`
  orphelins (jobId disparu) sont clôturés honnêtement par
  `cloreRunsOrphelins()` — aucun run ne peut plus stagner.

### 2.3 Contenu des fichiers

| Fichier | Changement |
|---|---|
| `lib/capabilities/training/model-training-manager.ts` | + `jobId` sur `RunEntrainement`, `statutJobVersRun`, `demarrerRun`, `echouerRun`, `cloreRunsOrphelins`, allowlist racines réelles (`cheminAutorise`) ; en-tête mis à jour (dormant → branché) |
| `lib/neural/training/job.ts` | `mesurerScoresParTheme` exportée (une seule mesure partagée), `fichiersEntreeJob` (fichiers d'entrée RÉELS), branchement run (déclaration/clôture/échec fail-soft), champs `runUce`/`runUceCloture` |
| `tests/unit/phase1-gtis-orchestration.test.ts` | **11 invariants** : nomenclature, confinement (acceptation des 3 racines réelles + refus traversée/intrus/hors-racine), cycle complet, idempotence démarrage, un run = un job, anti-régression, échec honnête sans delta fabriqué, orphelins clos / vivant intact, gardes d'entrée (datasets vides/introuvables/score avant manquant), run introuvable |
| `scripts/valide-phase1-orchestration.mts` | Validation RÉELLE bout-en-bout (job + registre, verdicts durs, artefact JSON) |
| `docs/architecture/feuille-de-route-gtis.md` | Phase 1 cochée avec preuves |

## 3. Validation mesurée (run réel du 2026-11-27T17:22Z, sandbox)

| Verdict | Résultat |
|---|---|
| Job réel terminé | PASS — `statut=termine`, 6 s, accuracy test intentions 0.1818 |
| Run déclaré et lié au job | PASS — `run_texte_mwz91y93_lste` |
| scoreAvant mesuré | PASS — **28.6163** (moyenne des 12 thèmes du corpus, avant toute passe) |
| scoreApres + delta cohérent | PASS — **31.4084**, delta **+2.7921** (recalculé = enregistré à 1e-6) |
| Anti-régression | PASS — delta ≥ −0.02 |
| Zéro run orphelin | PASS — `en_cours` restants = 0 |

Datasets réels du run : `public/llms-full.txt`, `public/llms.txt` (vérifiés
SHA-256 par le gestionnaire). Le delta +2.79 est le **gain d'appariement réel
causé par le job** — la première mesure avant/après portée par un registre de
runs dans l'histoire du dépôt. Artefact brut :
`var-copie/phase1-gtis-orchestration.json`.

Qualité : `tsc --noEmit` 0 erreur ; eslint 0 sur les 4 fichiers touchés ;
tests unitaires Phase 1 **11/11 verts**.

## 4. Ce qui reste (GTIS — non livré ici, déclaré)

- **Phase 2 — datasets** : provenance par échantillon, dédoublonnage
  sémantique, séparation train/test PAR SOURCE, compteurs
  synthétique/réel distincts.
- **Phase 3 — représentations** : au-delà du hachage FNV-1a (embeddings
  d'usage du cortex), sous-bandes par domaine — chaque gain MESURÉ avant
  adoption (règle anti-régression).
- Orchestration MLOps : la porte d'évaluation du pipeline (baseline/PSI)
  continue de fonctionner indépendamment ; un test d'intégration
  pipeline→adaptateur→run complet reste à ajouter (le branchement passe par
  le même `lancerEntrainement`, déjà validé ici).

## 5. Production

`https://gen3ia.online` : HTTP 000 mesuré à 17:22 UTC (injoignable côté
propriétaire, cPanel sans runtime Node). `PRODUCTION_VERIFIED` reste
non revendicable pour cette livraison ; tout le reste est TESTED/INTEGRATED
en dépôt (CI à confirmer sur le push).
