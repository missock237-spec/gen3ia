# MLOps Gen3ia — registre de modèles, pipeline à porte d'évaluation, détection de dérive

> Pilier 2 « MLOps industrialisé », transposé **localement** (VPS 2 Go, 100 % moteur SNN interne).
> Migration Vertex AI en Phase 3 : cf. [§ Migration Vertex AI](#migration-vertex-ai-phase-3).
>
> Modules : `lib/mlops/registry.ts`, `lib/mlops/pipeline.ts`, `lib/mlops/drift.ts`
> (tests colocatés `*.test.ts`, suite vitest).

---

## 1. Registre de modèles (`lib/mlops/registry.ts`)

### 1.1 Stockage

```
var/neural/registry/            ← var/ est HORS git (.gitignore « État neuronal persistant »)
└── <modelId>/                  ex. gen3-cortex-v2/
    ├── 1.0.0.json              ← manifeste de la version (JSON, écriture ATOMIQUE)
    ├── 1.1.0.json
    ├── 20261023T101500Z.json   ← version horodatée acceptée aussi
    └── production.json         ← POINTEUR du canal de production (FAIT FOI)
```

**Règle d'or : les binaires ne sont JAMAIS copiés dans le registre.** Un artefact
(`var/neural/cortex-v2.bin`, artefact pré-entraîné `assets/neural-pretrained/…`
ou futur objet R2) est **référencé** par chemin/URL + empreinte SHA-256 (`node:crypto`)
+ taille. Le registre ne contient que des JSON de métadonnées : léger, diffable,
sans risque de duplication des 12 Mo du cortex.

Garanties (même convention que `lib/neural/training/persistence.ts`) :

- écritures **atomiques** `.tmp` unique (pid + uuid) → `rename` : un crash ne laisse
  jamais un manifeste/pointeur tronqué, un lecteur concurrent ne voit jamais un fichier partiel ;
- **validation stricte** à l'enregistrement (`ErreurRegistre` avec code machine :
  `MANIFESTE_INVALIDE`, `VERSION_EXISTANTE`, `INTROUVABLE`, `CANAL_INVALIDE`) ;
- **idempotence** : ré-enregistrer un manifeste strictement identique est un no-op ;
  un contenu différent pour une même version est refusé (l'historique est immuable —
  incrémenter la version) ;
- le **pointeur `production.json` fait foi** pour la version servie : `latest(modelId, "production")`
  le résout en priorité (c'est lui qui suit les rollbacks), le champ `channel` des
  manifestes n'étant qu'un historique (« a déjà servi »).

### 1.2 Schéma du manifeste (`ManifestModele`)

```jsonc
{
  "modelId": "gen3-cortex-v2",              // kebab-case [a-z0-9-]{2,63}
  "version": "1.2.0",                       // X.Y.Z (suffixe -pre/+build optionnel) OU AAAAMMJJTHHMMSSZ
  "createdAt": "2026-10-23T10:15:00.000Z",  // date ISO
  "gitSha": "cfc052a6",                     // 7..40 hex ; 0000000 = sha indisponible
  "auteur": "pipeline-mlops",               // déclaratif (opérateur, script…)
  "artefact": {                             // RÉFÉRENCE — jamais le binaire
    "chemin": "var/neural/cortex-v2.bin",   // chemin local OU https://… (R2)
    "sha256": "000ff807…",                  // 64 hex (node:crypto)
    "bytes": 12586950
  },
  "datasets": [
    { "nom": "corpus-llms",  "reference": "sha256:9f2c…", "echantillons": 320 },
    { "nom": "amorcage-canonique", "reference": "lib/neural/training/dataset.ts#SEED_EXAMPLES", "echantillons": 54 }
  ],
  "hyperparams": {                          // objet LIBRE (pipeline : + corpusSha256,
    "epochs": 4,                            // + distributionEntrainement — cf. § 3.3)
    "lrBoost": 0.15,
    "cyclesParEchantillon": 4
  },
  "metrics": [
    { "nom": "accuracy_test",  "valeur": 0.82, "seuilMin": 0.7 },  // seuilMin = plancher
    { "nom": "accuracy_train", "valeur": 0.91 }                     // d'acceptation (option)
  ],
  "lineage": {
    "parentVersion": "1.1.0",               // absent pour une racine
    "source": "pipeline"                    // "training-worker" | "manuel" | "pipeline"
  },
  "channel": "production"                   // "experimental" | "production"
}
```

### 1.3 API

| Méthode | Rôle |
|---|---|
| `register(manifest)` | Validation stricte + écriture atomique. Idempotent si identique, `VERSION_EXISTANTE` sinon. |
| `list(modelId)` | Versions triées de la plus récente à la plus ancienne. |
| `get(modelId, version)` | Manifeste précis (null si absent/illisible — avertissement loggé). |
| `latest(modelId, canal)` | `production` → **résout le pointeur** d'abord (repli : balayage `channel`) ; `experimental` → balayage du champ `channel`. |
| `promouvoir(modelId, version, canal)` | `production` : met à jour le canal du manifeste **et** réécrit `production.json` (origine `promotion`) ; `experimental` : démotion du canal seul (retour `null`, pointeur intact). |
| `rollback(modelId, version)` | Re-pointe la production vers une version **existante** (origine `rollback`). Aucune suppression, historique intact. |
| `lineage(modelId, depuis?)` | Remonte la chaîne `parentVersion` (du plus récent au plus ancien). S'arrête proprement sur racine, parent absent ou cycle (garde anti-boucle). |
| `empreinteArtefact(chemin)` | Aide : calcule `{ sha256, bytes }` d'un fichier (pour produire les manifestes). |

### 1.4 Lignage

Chaque version déclare sa `parentVersion` (la version dont elle dérive) et sa
`source` (`pipeline` = pipeline MLOps, `training-worker` = worker GPU distant,
`manuel` = opération opérateur). `lineage(modelId)` part de la production pointée
et remonte jusqu'à la racine — c'est la généalogie complète du modèle servi, y
compris à travers les rollbacks (le pointeur ne détruit rien). Un cycle
anormal est détecté et tronque la chaîne (jamais de boucle infinie).

```
1.0.0 (racine, pipeline) ← 1.1.0 (pipeline) ← 1.2.0 (training-worker)
                                   ↑
                     production.json pointe ici après rollback
```

---

## 2. Pipeline à porte d'évaluation (`lib/mlops/pipeline.ts`)

### 2.1 Diagramme des 4 étapes

```
 ┌───────────────────────────────────────────────────────────────────────────┐
 │  executerPipeline(options) — 4 étapes IDEMPOTENTES, rapport JSON en sortie │
 └───────────────────────────────────────────────────────────────────────────┘

  Étape 0 — REPRISE (idempotence)
      la version existe déjà dans le registre ?
      ├── oui → étapes (a)(b) RELUES du manifeste (statut « reprise »),
      │         porte (c)(d) réévaluée avec l'état ACTUEL (jamais de
      │         re-entraînement, jamais de réécriture de la version)  ──► (c)
      └── non ▼
  (a) INGESTION ── stats RÉELLES du corpus existant
      │            public/llms.txt + public/llms-full.txt (lib/neural/training/dataset.ts)
      │            + amorçage canonique SEED_EXAMPLES (54)
      │            ► distribution par intention = RÉFÉRENCE de la dérive
      │            ► sha256 du corpus (identité immuable du jeu)
      ▼
  (b) ENTRAÎNEMENT ── DÉLÉGATION à un mécanisme injectable (AdaptateurEntrainement)
      │              défaut : creerAdaptateurNeuralLocal() → job existant
      │              lancerEntrainement (NeuralTrainer sur le cerveau singleton,
      │              import DYNAMIQUE — le pipeline ne construit jamais le cerveau)
      │              ► métriques mesurées (accuracy_test, accuracy_train…)
      │              ► empreinte sha256 de l'artefact produit (var/neural/cortex-v2.bin)
      ▼
  (c) ÉVALUATION ── baseline = latest(modelId, "production") du registre
      │            règle 1 : métrique connue de la baseline → non-régression (valeur ≥ baseline)
      │            règle 2 : métrique nouvelle → plancher déclaré (valeur ≥ seuilMin)
      │            + score de dérive PSI : référence (a) vs usage observé (§ 3)
      ▼
  (d) PORTE CONDITIONNELLE
      ├── métriques OK  ET  psi ≤ 0,25  ──► register (experimental) → PROMOTION
      │                                     production.json réécrit (canal production)
      └── sinon                          ──► QUARANTAINE : version enregistrée en
                                           canal « experimental », raisons loggées
                                           (pino `[MLOPS-PIPELINE]`) et portées par
                                           le rapport
```

### 2.2 Rapport exécutable (`RapportPipeline`)

Le pipeline retourne un rapport JSON **sérialisable tel quel** (route, cron,
script) : horodatages, détail des 4 étapes (`ingestion`, `entrainement`,
`evaluation`, `porte`), comparaisons métrique par métrique (`ComparaisonMetrique`),
score de dérive complet, `decision` (`promotion` | `quarantaine`), `raisons` FR
et le manifeste enregistré. Les échecs durs (corpus absent, entraînement en
erreur, artefact introuvable) produisent un rapport de **quarantaine argumenté**,
pas d'exception : l'appelant peut toujours le journaliser.

### 2.3 Idempotence

| Situation au 2ᵉ lancement | Comportement |
|---|---|
| version déjà **quarantainée**, porte désormais passée | **PROMOTION** sans re-entraîner (re-gate) |
| version déjà **en production**, porte passée | NO-OP strict (pointeur inchangé, `promuLe` intact) |
| version déjà **en production**, porte fermée | AVERTISSEMENT — la démotion reste une opération opérateur (`rollback`), jamais automatique |
| version inexistante | exécution complète (a)→(d) |

### 2.4 Branchement du mécanisme d'entraînement

- **Local (défaut, prêt)** : `creerAdaptateurNeuralLocal()` délègue au job
  existant `lancerEntrainement` (`lib/neural/training/job.ts`) et attend la fin
  (polling borné, défaut 15 min). Le cerveau est le singleton PM2 habituel.
- **Worker GPU (prêt à écrire)** : écrire un `AdaptateurEntrainement` qui soumet
  le job via `lib/training` (providers `worker-http`, `TRAINING_WORKER_URL`)
  puis traduit son résultat en `ResultatEntrainement` — **zéro modification du
  pipeline**.
- **Routes `/api/training/*`** : inchangées (contrat « system-only » respecté).
  Une future route opérateur pourra appeler `executerPipeline` après garde admin.

---

## 3. Détection de dérive (`lib/mlops/drift.ts`)

### 3.1 Score PSI

Le **Population Stability Index** mesure l'écart entre la distribution de
RÉFÉRENCE (répartition des intentions du corpus d'entraînement, embarquée dans
le manifeste) et la distribution OBSERVÉE en production (comptages d'usage par
intention) :

```
PSI = Σᵢ (pᵢ − qᵢ) · ln(pᵢ / qᵢ)        pᵢ = proportion référence, qᵢ = proportion observée
```

- contribution toujours ≥ 0 ; détail par catégorie (`parCategorie`, union triée
  des clés — déterministe) ;
- bucket vide d'un seul côté : substitution d'un epsilon (1e-6) — contribution
  finie et pénalisante (catégorie apparue/disparue) ;
- **aucune donnée d'un côté → PSI = 0 / « stable »** : pas de preuve de dérive
  sans observation (un collecteur vide ne doit jamais fermer la porte).

**Seuils conventionnels :**

| PSI | Statut | Action |
|---|---|---|
| `< 0,1` | `stable` | aucune action |
| `0,1 … 0,25` | `surveillance` | promotion possible, avertissement loggé, à observer |
| `> 0,25` | `derive` | **porte du pipeline fermée** (quarantaine), investiguer |

### 3.2 Sources de données (état réel)

Il n'existe pas encore de log d'interactions persisté côté production. Le module
fournit donc une **interface propre** + un **accumulateur de comptages par
catégorie** (`AccumulateurDerive`) : `enregistrer(categorie, poids?)`,
`snapshot()` (copie défensive), `total()`, `fusionner()`, `reinitialiser()`,
`persistance atomique var/neural/stats/derive-comptages.json` (var/ hors git,
échec non fatal, tolérant à la corruption) et `accumulateurDeriveGlobal()`
(singleton HMR-safe). Cap mémoire : au-delà de 500 catégories, regroupement
dans `__autres`.

### 3.3 Branchement du collecteur (découplé — volontairement non câblé)

Le point d'alimentation naturel est l'intention détectée de chaque requête :

1. dans le runtime neuronal (`lib/neural/engine.ts` / `predireIntention`),
   appeler `accumulateurDeriveGlobal().enregistrer(intention)` après chaque
   cycle — + `sauvegarder()` périodique (fire-and-forget, comme la sauvegarde
   du cerveau) ;
2. le pipeline lit `snapshot()` via `options.collecteurDerive` ;
3. le futur **endpoint métriques** (autre chantier, découplé) réutilisera le
   même singleton pour exposer l'usage et le PSI courant — ce module
   ne l'importe pas et ne le précède pas.

La distribution de référence est **embarquée dans chaque manifeste**
(`hyperparams.distributionEntrainement` + `hyperparams.corpusSha256`) : toute
comparaison ultérieure (endpoint métriques, audit) relit le manifeste de
production sans ré-ingérer le corpus.

---

## 4. Runbook promotion / rollback

### 4.1 Promotion (canal production)

```ts
import { RegistreModeles } from "@/lib/mlops/registry";

const registre = new RegistreModeles();          // var/neural/registry
const pointeur = await registre.promouvoir("gen3-cortex-v2", "1.2.0", "production");
// → { modelId, version: "1.2.0", promuLe: "…", origine: "promotion" }
```

1. Vérifier la version : `await registre.get("gen3-cortex-v2", "1.2.0")`
   (métriques ≥ baseline, `seuilMin` respectés, dérive `stable`/`surveillance`).
2. La voie normale est le **pipeline** (porte automatique) — la promotion
   manuelle est réservée aux cas exceptionnels documentés.
3. Contrôles post-promotion :
   `await registre.latest("gen3-cortex-v2", "production")` → la version pointée ;
   fichier `var/neural/registry/gen3-cortex-v2/production.json` (origine `promotion`).

### 4.2 Rollback (retour arrière immédiat)

```ts
await registre.rollback("gen3-cortex-v2", "1.1.0");   // la version DOIT exister
```

- **Aucune suppression, aucune réécriture** : seul `production.json` change
  (origine `rollback`) — `latest(modelId, "production")` suit immédiatement ;
- la version retirée conserve son manifeste et son canal (« a déjà servi ») ;
- si le chargement de l'artefact côté runtime est impliqué, le repli existant
  s'applique (artefact absent → amorçage propre, cf. `lib/neural/runtime.ts`) ;
- journalisation : noter l'incident + le pointeur avant/après dans le ticket.

### 4.3 Quarantaine

Une version refusée par la porte reste **inventoriée** en canal `experimental`
(décision + raisons dans le rapport et les logs pino). Elle peut être promue
plus tard par simple **reprise** (relancer le pipeline sur la même version
quand l'usage redevient conforme) — sans re-entraînement.

---

## 5. Migration Vertex AI (Phase 3)

Déclenchement (conditions cumulatives) :

- **Charge dépassant le VPS 2 Go** : entraînements réguliers perturbant la
  latence prod (le trainer in-process est chunké, mais le corpus/cortex grandit),
  ou artefacts > 100 Mo rendant le stockage local/R2 artisanal coûteux ;
- **Budget** : abonnement Vertex AI (calc + stockage + monitoring) assumé ;
- **Besoin multi-régions / multi-serveurs** : registry partagé et pipelines
  planifiés deviennent nécessaires (un seul serveur = stockage local suffisant).

| Local (aujourd'hui) | Vertex AI (Phase 3) | Notes de migration |
|---|---|---|
| `RegistreModeles` (`var/neural/registry/*.json` + pointeur `production.json`) | **Vertex AI Model Registry** (`aiplatform.v1.ModelRegistry`) | 1 `ManifestModele` → 1 version de modèle Registry ; `artefact` passe d'un chemin local à un URI `gs://` (R2 → Cloud Storage) ; le pointeur de production devient le **traffic split** de l'Endpoint (0/100 %), le rollback = répartition du trafic ; `gitSha`/`datasets`/`hyperparams` migrent dans `model.labels`/`explanation_metadata` ou un manifeste frère versionné GCS. |
| `executerPipeline` (4 étapes, injectable) | **Vertex AI Pipelines** (Kubeflow Pipelines) | (a) ingestion → composant GCS/BigQuery ; (b) entraînement → composant `CustomJob` (container training-worker existant — le Python `services/training-worker/` est déjà packagé Dockerfile) ; (c) évaluation → composant métriques (`metrics.log_metric`) comparé à la baseline Registry ; (d) porte → step conditionnel (`dsl.Condition`) promouvant ou étiquetant « quarantaine ». Le contrat `AdaptateurEntrainement` est le point de couture : le composant Kubeflow implémente la même signature. |
| `calculerScorePsi` + `AccumulateurDerive` (var/neural/stats) | **Vertex AI Model Monitoring** (prediction drift + feature skew) | PSI natif dans Model Monitoring (seuils configurables : alerte à 0,25, surveillance 0,1) ; l'accumulateur local reste utile en dev/edge ; exporter les comptages vers BigQuery/Cloud Logging pour alimenter le monitoring. |
| Pointeur `production.json` (fait foi) | Endpoint Vertex (traffic split) + aliases Registry | Le runbook promotion/rollback (§ 4) devient des commandes `gcloud` équivalentes — même logique, même ordre d'opérations. |

**Invariant à préserver pendant la migration** : l'API TypeScript
(`RegistreModeles`, `executerPipeline`, `calculerScorePsi`) sert de façade —
on remplace l'implémentation derrière la façade, les appelants (futures routes,
cron) ne changent pas. Les tests vitest actuels (valeurs PSI exactes, garde de
porte, idempotence) deviennent les tests de non-régression du pont Vertex.

---

## 6. Intégration & limites connues

- **Périmètre respecté** : aucune modification de `lib/neural/runtime.ts` ni
  des routes `/api/training/*` ; le pipeline les consomme/les évite par
  injection, sans les coupler.
- **`.gitignore`** : `var/` est déjà intégralement exclu (« État neuronal
  persistant ») — `var/neural/registry/` et `var/neural/stats/` en découlent ;
  aucune ligne supplémentaire nécessaire.
- **Le pipeline ne construit jamais le cerveau** : le module n'importe pas
  `lib/neural/runtime.ts` ; seul l'adaptateur local (exécuté) charge le job
  d'entraînement dynamiquement.
- **Limites honnêtes** : pas encore de collecteur branché (PSI = 0 tant que
  personne n'appelle `enregistrer`) ; `gitSha` = `0000000` hors dépôt git ;
  pas d'endpoint HTTP MLOps dans ce chantier (décision de découplage — la
  façade est prête) ; la promesse « entraînement reproductible » reste bornée
  par la nature du SNN (seed fixe, mais état du cerveau singleton évolue).
