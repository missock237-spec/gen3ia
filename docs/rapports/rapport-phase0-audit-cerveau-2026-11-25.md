# RAPPORT PHASE 0 — AUDIT TECHNIQUE DU CERVEAU GEN3IA EXISTANT

**Date : 2026-11-25 · PLAN DIRECTEUR « GEN3IA AUTONOMOUS BRAIN » · Lot 1 (Phase 0 + Phase 1) · base `d0f8419`**

Ce rapport établit la cartographie du cerveau existant avant toute modification,
conformément à la Phase 0 : composants fonctionnels, incomplets, manquants,
duplications, points d'intégration et dépendances. Il détermine ce que le
futur Autonomous Core doit **réutiliser** (et non reconstruire).

## 1. Cartographie d'ensemble

Dépôt Next.js 15.5 / TypeScript (~280 fichiers TS dans `lib/neural/`). Le
cerveau est un **singleton process** assemblé par `lib/neural/runtime.ts`
(`getNeuralRuntime()`, slot `globalThis.__gen3NeuralRuntime`), chargé au
premier appel, persisté sur disque (`var/neural/brain-v1.json` pour le SNN
v1, `var/neural/cortex-v2.bin` pour le cortex columnnaire v2 — écriture
atomique tmp+rename, mutex, rotation `.bak`, repli au `.bak`).

| Couche | Composants | État |
|---|---|---|
| Noyau SNN v1 | `core/network.ts`, `neuron.ts`, `synapse.ts`, `resonant-space.ts`, `central-core.ts`, `auto-oscillation.ts`, `couche-rpia.ts` | fonctionnel, testé |
| Cortex v2 columnnaire | `core/v2/cortex-columnnaire.ts` (262 144 colonnes CSR), `champ-cortical.ts` (1 Md adressables), `energie.ts` + profils eco/téléphone | fonctionnel, gardes de tests |
| Encodage | `encoding/text-encoder.ts` (registre neuronal), `encoding/lexical-embedding.ts` (hashing trick, « similarité lexicale honnête ») | fonctionnel |
| Génération | `generation/language.ts` (cortex langagier), corpus commis dev-web, moteurs locaux SVG/WAV/SMIL | fonctionnel ; ~30 fichiers `multimodal-itXX.ts` = strates historiques (ne pas imiter) |
| Solveurs exacts | `solveurs/moteur-calcul.ts`, `moteur-couleurs.ts` | fonctionnels, 100 % vérifiés |
| Effecteurs | `effectors/tool-os.ts` (outils à métriques réelles), skills-engine, moteurs locaux ; `media-bridge.ts` → `PONT_NON_CONFIGURE` sans pont GPU | fonctionnel sauf pont photoréaliste (déclaré honnête) |
| Mémoires | `memory/hippocampus.ts` (fenêtre 10 tours + `CentralSupervisor`), `generation/memoire-*.ts` (domaines/ondes/réflexion), `lib/memory/` (R2 utilisateur), `lib/studio/memoire-utilisateur.ts` | multiples, non unifiés (§4) |
| Raisonnement | `compartiments/` (moteur-math, monde-virtuel, terminal-virtuel, orchestrateur-raisonnement) | fonctionnel |
| Entraînement | `training/` (trainer, job, domaines, webdev, ondes, persistence), `lib/entrainement-auto/` (boucle boot), `lib/training/` (Studio GPU), `lib/ondes/` (RPIA/arene), `services/orchestrator-24h/` (Python) | fonctionnel mais fragmenté (§3, §4) |

## 2. Les deux fichiers nommés par le plan — verdict précis

### 2.1 `lib/neural/training/entrainement-ondes.ts` (291 lignes)

**Ce que c'est** : la méthode d'entraînement propriétaire it.57/it.63 « par
ondes » — module PUR (zéro I/O, zéro dépendance Node, déterministe) :
(1) analyse des ondes — chaque token devient un paquet
[fréquence, phase, amplitude] (FNV-1a, porteur ∈ [0.25, 1.75] rad/cycle) ;
(2) traitement — la signature pilote l'injection corticale (colonne =
f(sin(phase), fréquence), balayage dans la BANDE-PORTEUSE du domaine) ;
(3) consolidation ondulaire — plasticité supervisée vers la bande du domaine,
punition ×0.95 des bandes concurrentes, propagation par le bus inter-régions.

**Ce que ce n'est PAS** : un mécanisme d'apprentissage continu. C'est une
**fonction de session** (`entrainerDomainesParOndes(cortex, champ, exemples,
options) → RapportEntrainementOndes`), invoquée par `job.ts` quand
`source === "ondes"`. Elle n'a ni horloge autonome, ni file, ni reprise, ni
mémoire des sessions précédentes (une continuité de phase `horlogeInitiale`
permet seulement le fractionnement bit-à-bit d'une session en lots).

**Décision d'architecture** : le système neuronal par ondes est **conservé
tel quel** et devient l'un des moteurs invoqués par le pipeline continu
(Lot 3/7) — le Continual Learning Engine l'appellera par lots avec
`horlogeInitiale` pour la continuité. Aucune refactorisation : module pur
déjà testé (`entrainement-ondes.test.ts`).

### 2.2 `lib/neural/training/job.ts` (533 lignes)

**Ce que c'est** : le gestionnaire de job d'entraînement — **en mémoire du
process** (`globalThis.__gen3NeuralTrainingJob`), un seul entraînement à la
fois (second lancement refusé, 409), exécution asynchrone chunkée
(setImmediate tous les 25 échantillons), progression via GET
`/api/neural/train`, sources `corpus | domaines | complet | ondes`
(+ mémoire ondes multimodales synthétiques tracée honnêtement), mesure
vérifiable avant/après par thème (AXE 4), persistance finale via
`sauvegarderCerveauRuntime()`.

**Limites mesurées face au plan** :
1. **Non persistant** — le job est perdu au redémarrage du process (slot
   globalThis) ; aucune reprise après crash, aucun checkpoint.
2. **Pas une file** — refus explicite en cas de concurrence ; pas d'attente,
   pas de priorités, pas d'idempotence entre lots.
3. **Pas de traçabilité durable** — le rapport du job vit en mémoire (et
   l'historique est borné à 20 entrées dans `runtime.historiqueEntrainement`).

**Décision d'architecture** : `job.ts` reste le chemin d'entraînement
**manuel/admin** (API `/api/neural/train`). Le pipeline autonome (Phase 2/3)
crée une **file persistante séparée** qui déclenchera des sessions
d'entraînement bornées (dont des sessions « ondes ») — sans toucher au
contrat existant, pour ne jamais dégrader la production.

## 3. Ce qui existe déjà (à réutiliser — inventaire anti-doublon)

1. **File persistante at-least-once** : `lib/queue/tick-queue.ts` (tickets
   JSON sur R2, PUT conditionnel, dead-letters, reprise) +
   `lib/queue/dispatch-loop.ts` (boucle auto-perpétuelle 5 min,
   « exactement-un successeur » transactionnel) + worker VPS
   `scripts/worker-ticks.mjs` (PM2, POST signé toutes les 10 s) — **la
   contrainte « collecte jamais bloquée par le traitement » a déjà son
   moteur de distribution**.
2. **File mission avec bail** : `lib/queue/mission-queue.ts` (r2fs, bail
   transactionnel 330 s, checkpoints, fail-soft).
3. **Boucle d'auto-apprentissage au boot** : `lib/entrainement-auto/boucle.ts`
   armée par `instrumentation.ts` (`demarrerAutoApprentissage()`,
   `AUTO_APPRENTISSAGE=0` pour désactiver) — cycle découvrir (HF/Kaggle via
   `lib/training/hub`) → ingérer → entraîner → persister → rapporter ; état
   `var/entrainement-auto/etat.json`. **Squelette du collecteur 24/7
   existant, aujourd'hui borné** (fenêtre d'absorption 2 h puis clôturée).
4. **Coordination d'agents** : `lib/agents-os/dispatch/` (tâches natives
   typées OU scripts isolés en processus enfant, timeout, cleanup — jamais
   de shell arbitraire) ; `lib/neural/effectors/tool-os.ts` (registre
   d'outils à métriques d'usage réelles) ; `lib/agents/scheduler.ts`
   (planifications cron-like, budget tranche 50 s, catch-up) ;
   `lib/essaim-agents/` (essaim P2P navigateur, tout agent connecté au
   cortex) ; `services/orchestrator-24h/` (Python, Redis Streams, 4 workers
   multimodaux avec xautoclaim/dead-letters — service séparé).
5. **Persistance des connaissances** : `lib/r2fs/` (Firestore-compatible
   sur R2, transactions, cap 256 Ko/doc) ; `lib/storage/user-data-store.ts`
   (`users/{uid}/...`) ; `lib/memory/vector-store.ts` (Qdrant best-effort,
   repli parcours R2 + cosinus) ; `lib/knowledge/` (ingestion, hybrid-search).
6. **Verrous et gardes** : `lib/training/verrou.ts` (`acquerirVerrou`),
   `lib/queue/firestore-guard.ts` (quota 6 s, disjoncteur), mutex interne de
   `persistence.ts`, pattern « sweep opportuniste » de `lib/training/orchestrator.ts`.
7. **Surveillance** : `instrumentation.ts` (seul hook de boot serveur),
   `/api/public/health` (sonde légère, ne vérifie RIEN du cerveau),
   `/api/neural/state|public-stats`, workflow `surveillance-production.yml`
   (cron 7,37 * * * *, 10 endpoints, TTFB < 3 000 ms, issues auto).

## 4. Duplications et fragments (risques pour l'architecture cible)

- **Orchestrateurs ×5+ sans bus commun** : `lib/agents/orchestrator-actions.ts`
  (missions utilisateur), `lib/essaim-agents/orchestrateur.ts` (P2P),
  `lib/essaim-media/orchestrateur.ts`, `lib/training/orchestrator.ts` +
  `arene-orchestrator.ts` (Studio GPU), `lib/orchestrator/team-coordination.ts`,
  `services/orchestrator-24h` (Python) — le « centre de coordination » du
  plan ne doit PAS en créer un sixième parallèle : il doit **superviser les
  existants** par contrats (registre de modules-agents + état partagé).
- **Files ×4** : tick-queue R2, missionQueue r2fs, job d'entraînement en
  mémoire, Redis Streams du service Python — Phase 3 doit s'appuyer sur les
  deux files persistantes existantes plutôt que d'en ajouter une cinquième.
- **Encodages ×3** (text-encoder, lexical-embedding, encodeur ondes) et
  **mémoires ×6** (hippocampe, mémoires ondes/domaines/réflexion, mémoire R2
  utilisateur, mémoire Studio, compteurs auto) — la Phase 6 (mémoire
  permanente) devra unifier par-dessus, pas ajouter une septième mémoire.
- **Deux cortex coexistants** (v1 SNN + v2 columnnaire) — assumé par le
  runtime, à préserver (aucune migration imposée).

## 5. Trous majeurs vis-à-vis du cerveau autonome 24/7

1. **Pas de centre de coordination** : aucun composant ne démarre/supervise/
   relance l'ensemble des modules avec priorités, traçabilité et reprise —
   c'est l'objet de la Phase 1 (Autonomous Core), à armer dans
   `instrumentation.ts` comme le fait déjà la boucle d'auto-apprentissage.
2. **Pas de file d'entraînement persistante** : `job.ts` en mémoire, job
   perdu au redémarrage (§2.2).
3. **Pas de collecteur d'événements continu** : `lib/neural/evolution.ts` ne
   consolide que pendant les requêtes chat ; la fenêtre d'absorption des
   hubs est clôturée après 2 h ; aucun cycle 5 min permanent (Phase 2).
4. **Pas de mémoire longue unifiée du cerveau** : hippocampe = fenêtre 10
   tours process ; index sémantique serveur best-effort (Phase 6).
5. **Pas de supervision du pipeline d'apprentissage** : aucun health du
   cerveau (fraîcheur de `brain-v1.json`, âge du dernier entraînement, taux
   d'échec de sauvegarde), aucune reprise post-crash (Phases 1 & 12).

## 6. Contraintes techniques non négociables détectées

1. **Serverless Vercel** : maxDuration 300 s, cold starts (cache process
   vide), crons Hobby — **le cerveau ne peut vivre que sur le VPS PM2**
   (singleton, une instance, pas de scale horizontal du cerveau) ;
   `worker-ticks.mjs` et `genapi-daemon` sont déjà des process PM2 dédiés.
2. **RAM serrée** : `max_memory_restart 1G` ; profils énergie eco/téléphone ;
   tout module du core doit être borné (caps, fenêtres) et paresseux
   (imports dynamiques).
3. **Redis supprimé** (Task 108) : cache = accélération process-local,
   jamais une dépendance dure ; interdiction déclarée d'ajouter une
   « deuxième source de vérité » — l'état du core doit être persisté en
   JSON atomique disque (`var/autonomous/`) et/ou r2fs, en cohérence avec
   les patterns existants.
4. **r2fs** : cap 256 Ko/doc, garde quota 6 s — écritures fréquentes
   interdites hors batch ; l'état du core est écrit périodiquement, pas à
   chaque tick.
5. **`server-only`** : le core importe le runtime en paresseux ; les
   workers tsx exigent `NODE_OPTIONS=--conditions=react-server`.
6. **Sandbox** : aucune exécution de code arbitraire — la voie existante
   (`agents-os/dispatch/executeur-sandbox.ts`) est la seule autorisée pour
   les exécutions futures (Phase 8).

## 7. Points d'intégration retenus pour la Phase 1

| Point d'intégration | Usage dans l'Autonomous Core |
|---|---|
| `instrumentation.ts` → `register()` (nodejs) | armement du core au boot (comme `demarrerAutoApprentissage()`), désactivable par `AUTO_CORE=0` |
| `getNeuralRuntime()` (import paresseux) | connexion des modules-agents au cerveau (lectures bornées, jamais le runtime complet en mémoire de chaque agent) |
| `var/neural/brain-v1.json` (mtime, taille, version) | santé du cerveau : fraîcheur de la persistance |
| patterns `persistence.ts` (tmp+rename) et `etat.json` de `lib/entrainement-auto/` | persistance de l'état du core (`var/autonomous/etat.json`) et reprise après redémarrage |
| contrat des modules-agents | chaque Phase suivante (collecteur, file, intelligence, mémoire…) s'ajoute comme module — pas comme un système à côté |

## 8. Verdict et passage à la Phase 1

Le cerveau est **fonctionnel et testé** dans son périmètre actuel (SNN v1 +
cortex v2 + cortex langagier + solveurs + effecteurs + entraînement manuel +
boucle d'auto-apprentissage bornée), mais il ne dispose d'aucun centre de
coordination autonome : cinq orchestrateurs parallèles sans bus commun, un
job d'entraînement volatil, aucun cycle permanent, aucune supervision du
pipeline cognitif. Le plan est confirmé : la priorité n'est pas « plus
d'intelligence » mais **la capacité de devenir plus intelligent** — un
Autonomous Core qui arme et supervise des modules-agents connectés au
runtime existant, sans jamais remplacer ce qui fonctionne.

Livrable Phase 1 : `lib/autonomous/core/` (orchestrator, scheduler,
process-manager, task-manager, lifecycle-manager, monitoring, config) +
contrat de module-agent + premier agent câblé (santé du cerveau) + tests.
