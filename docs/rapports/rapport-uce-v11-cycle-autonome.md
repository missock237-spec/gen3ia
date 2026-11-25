# LIVRABLE 6 — DOCUMENTATION DU CYCLE AUTONOME (V1.1 Phases 5-7)

**Date** : 2026-11-25 · **Fichiers** : `autonomy/capability-gap-analyzer.ts`, `autonomy/capability-improvement-planner.ts`, `core/cycle-persistant.ts` (tous NOUVEAUX) · **Statut** : IMPLEMENTED + INTEGRATED + TESTED (22 tests autonomie verts + scénarios A/C/D/E/F réels).

## 1. Moteur d'identification des capacités manquantes (Phase 5)

`analyserManques({besoinsNonSatisfaits, options})` compare les **7 sources mission** : santé des capacités (monitoring mesuré), demandes/besoins remontés, tâches échouées (cap_executions catégorisées), performances (p95 mesuré > 10 s), besoins des agents, décisions `discover` non planifiées du cerveau, seuils explicites (fiabilité ≥ 90 %). Chaque insuffisance porte : `id`, `description`, `categorie` (6 catégories dont `fonctionnalite-absente`, `outil-defaillant`, `outil-lent`, `fiabilite-insuffisante`, `amelioration-possible`), `priorite`, `justification`, `mesureReference` (mesure réelle citée), `objectifMesurable`, `ressourcesEstimees`, `source`. **Règle anti-doublon codée et testée** : une capacité défaillante n'est jamais catégorisée « fonctionnalité absente » (amélioration d'abord). Persistance `cap_gaps`.

## 2. Planification autonome (Phase 6)

`elaborerPlans(insuffisances)` → plans `PlanAmelioration` complets : `objectif`, `etapes` (avec moteur UCE exécutant), `dependances`, `coutEstime`, `ressourcesRequises`, `niveauRisque`, `testsNecessaires`, `criteresReussite`, `strategieRetourArriere`, `verdictPolitique` (évalué RÉELLEMENT par la politique). 9 actions (`reutiliser`, `adapter`, `decouvrir-bibliotheque/api/modele`, `generer-competence`, `construire-outil`, `optimiser`, `remplacer`) mappées déterministement depuis les catégories. **Le planificateur ne décide pas** : `choisirPlan(planId, {par, decisionId})` exige une autorité explicite (le cerveau, identifié par sa décision persistée) — testé (refus sans autorité). Remplacement = risque « élevé » = approbation toujours exigée.

## 3. Orchestration automatique du cycle (Phase 7)

`OrchestrateurCyclePersistant` (`core/cycle-persistant.ts`) — le cycle mission complet, **persistant** :

**États obligatoires (14)** : `pending → analyzing → planned → discovering → evaluating → building → testing → awaiting_approval → integrating → verifying → completed` ; terminaux : `failed`, `cancelled`, `rolled_back`. Chaque transition est écrite dans le repository (Firestore, repli journal local versionné) avec historique complet (≥60 entrées conservées).

**Garanties (toutes testées)** :
- **Reprise après redémarrage** : `reprendreCyclesInterrompus()` restaure les cycles non terminaux depuis la persistance, trace « reprise après redémarrage », aucune double exécution (scénario F réel : état testing restauré, historique conservé).
- **Verrous distribués** : collection `cap_locks` (TTL 5 min, propriétaire) — double exécution REFUSÉE avec raison (testé). Écart stack honnête : Redis n'existe pas dans ce dépôt (cache process-local documenté V1) — le repository joue le rôle de verrou partagé ; Firestore en production, journal local hors ligne.
- **Idempotence** : clé de déduplication (sha256 du besoin) — un cycle actif sur le même besoin est RETOURNÉ, jamais dupliqué (testé).
- **Timeout** : par cycle (15 min défaut), échec `failed` avec cause persistée.
- **Retries limités** : `maxTentatives = 2` — au-delà, relance refusée honnêtement (testé).
- **Annulation** : `annuler(cycleId, {raison, par})` — identifiant humain requis, état `cancelled` tracé (testé).
- **GATE d'autorisation (mission §9)** : sans autorisant humain, le cycle s'arrête en `awaiting_approval` ; l'intégration n'est franchie qu'avec `reprendre(cycleId, {autorisePar})` (testé : capacité restée « proposee » sans autorisant, « integree » avec).
- **Rollback** : `annulerParRollback` → version précédente la plus récente, tracé `cap_rollbacks`, état `rolled_back` (cible absente → refus honnête, jamais de cible inventée).

**Moteur d'exécution** : les étapes discovering→testing délèguent au moteur 14 étapes V1 (`executerCycleEvolution` — découverte multi-sources réelle, compatibilité, benchmarks sandbox, comparaison mesurée, sortie max « proposee ») ; integrating applique la machine à états avec l'autorisant humain ; verifying clôt avec mesure et apprentissage.

**PostgreSQL/Redis (écart stack documenté)** : le dépôt réel n'a ni PostgreSQL ni Redis (Firebase/Firestore + cache process-local, écart documenté depuis la V1 et repris au rapport final) — les 12 entités et garanties mission sont conservées, seule la technologie s'adapte.

**Preuves** : `autonomie.test.ts` (22 tests) + scénarios A/C/D/E/F réels avec preuves JSON (`docs/rapports/mesures/uce-v11-scenarios.json`).
