# RAPPORT PHASE 1 — GEN3IA AUTONOMOUS CORE (Lot 1 du plan « GEN3IA AUTONOMOUS BRAIN »)

**Date : 2026-11-25 · branche `main` · base `d0f8419` · Lot 1 = Phase 0 (audit) + Phase 1 (core)**

## 1. Ce qui a été construit

Le centre de coordination que l'audit Phase 0 a identifié comme le trou n°1
est en place : `lib/autonomous/` — un cœur qui arme, supervise, trace et
relance des **modules-agents** connectés au cerveau existant, sans jamais
faire leur travail à leur place ni dupliquer les systèmes existants
(tick-queue, mission-queue, orchestrateurs spécialisés restent en place et
deviendront des modules supervisés dans les lots suivants).

| Fichier | Rôle |
|---|---|
| `core/types.ts` | contrats : `ModuleAgent` (le contrat d'un module-agent), `Tache` traçable (id unique, cycle, historique), `EvenementModule` (bus inter-modules), `EtatModule` (mesures réelles), `GestionTaches` |
| `core/config/autonomous-config.ts` | config bornée par env : `AUTO_CORE` (armement), `AUTO_CORE_CYCLE_MS` (défaut **300 000 ms = 5 min**, plan Phase 2), timeout tick, concurrence, seuils de suspension, journaux |
| `core/task-manager.ts` | traçabilité 100 % : id `T-<cycle>-<8hex>`, statuts COLLECTED-style (EN_ATTENTE→EN_COURS→TERMINEE/ECHEC/REPRISE), historique borné 20 événements, idempotence (une tâche close ne se referme pas), journal borné par module |
| `core/process-manager.ts` | ISOLATION d'un tick : timeout de sécurité, capture exhaustive, pas d'empilement (tick déjà en cours → « occupe »), comptage honnête des échecs (exception, timeout ET rapport `echec` du module), suspension après N échecs consécutifs |
| `core/scheduler.ts` | heartbeat : cycle immédiat au démarrage puis un cycle par intervalle ; le callback n'est PAS attendu — « les cycles ne dépendent pas du traitement des cycles précédents » ; le compteur de cycles CONTINUE après redémarrage (reprise du plan) |
| `core/lifecycle-manager.ts` | persistance atomique tmp+rename de `var/autonomous/etat.json` (versionnée), lecture défensive (corrompu → null, jamais de crash au boot) |
| `core/orchestrator.ts` | `Gen3iaCoeurAutonome` : enregistre les modules, démarre (reprise de l'état persisté), exécute les cycles (dispatch non bloquant + plafond de concurrence + modules « pas_dû » sautés honnêtement), bus d'événements inter-modules, journal de cycles borné, snapshot santé ; singleton `getCoeurAutonome()` |
| `monitoring/error-monitor.ts` | anneau borné (5) des dernières erreurs PAR module + taux d'erreur réel |
| `monitoring/recovery-manager.ts` | suspension par module après N échecs consécutifs (cause tracée), réarmement automatique après `suspensionMs` |
| `monitoring/health-check.ts` | instantané de santé : ok / degrade (échecs consécutifs ou suspension) / hors_service, par module et global — le premier health qui vérifie RÉELLEMENT le pipeline cognitif |
| `modules/agent-sante-cerveau.ts` | PREMIER module-agent connecté à gen3 : fraîcheur réelle de la persistance du cerveau (`var/neural/brain-v1.json`, `cortex-v2.bin`, pré-entraînement commis) — lectures `stat()` bornées, ne charge JAMAIS le runtime (RAM) |
| `index.ts` | `demarrerCoeurAutonome()` : armement fail-soft (import dynamique, `AUTO_CORE=0`, jamais d'échec bloquant) — appelé par `instrumentation.ts` |

## 2. Conditions de validation du plan — couvertes par tests

| Condition | Implémentation | Test |
|---|---|---|
| Le système démarre automatiquement | `instrumentation.ts` (hook nodejs) + idempotence `demarrer()` | « condition 1 » + config AUTO_CORE |
| Les modules peuvent communiquer | bus `emettreEvenement` → livraison au prochain tick des autres modules (files pré-créées pour tout le registre — aucun événement perdu au premier cycle) | « condition 2 » |
| Une panne d'un module ne bloque pas les autres | isolation par tick (try/catch + timeout + « occupe » + suspension par module), health `degrade` honnête | « condition 3 » + 3 tests process-manager |
| Les opérations interrompues peuvent reprendre | tâches ouvertes persistées ; au redémarrage : `REPRISE` puis ré-ouverture EN_ATTENTE ; compteur de cycles restauré et continué | « condition 4 » + tests lifecycle |
| Les tâches restent traçables | id unique, transitions idempotentes, historique borné, journal de cycles | « condition 5 » + 2 tests task-manager |

**Validation : 20/20 tests verts** (`lib/autonomous/core/coeur.test.ts`),
`npm run typecheck` 0 erreur, `eslint` 0 erreur sur `lib/autonomous/` +
`instrumentation.ts`, **suite complète : 7 507 verts / 14 ignorés /
0 échec (7 521 tests)** avant push.

## 3. Bugs réels trouvés et corrigés pendant la validation (mesurés par les tests)

1. `nombreEnv` lisait `process.env` au lieu de l'objet `env` injecté — la
   surcharge de configuration par variable d'environnement était ignorée.
2. `GestionnaireTaches.demarrer` refusait toute transition EN_ATTENTE →
   EN_COURS (source de transition erronée).
3. Un module rapportant `statut: "echec"` honnêtement n'était pas compté
   comme échec (compteur, anneau d'erreurs, suspension) — seul une exception
   ou un timeout comptait ; les trois sont désormais des échecs réels.
4. Le bus d'événements perdait les émissions du premier cycle (files créées
   après le dispatch) — files pré-créées pour tout le registre avant chaque
   cycle.

## 4. Décisions d'architecture (fidèles aux contraintes non négociables)

1. **La collecte ne sera jamais bloquée par le traitement** : le scheduler
   déclenche les cycles sans les attendre ; un module lent est sauté
   (« occupe » / « pas_dû » / « reporte »), jamais empilé.
2. **Traçabilité** : toute tâche porte id + cycle + historique ; l'état du
   core est persisté atomiquement et relisible.
3. **Le cerveau évolue sans être remplacé** : zéro modification du cerveau
   existant — l'agent santé lit les artefacts de persistance ; les phases
   suivantes s'ajouteront comme modules (contrat `ModuleAgent`), le
   système par ondes et `job.ts` restent les moteurs d'entraînement
   (cf. rapport Phase 0 §2).
4. **Isolation des données utilisateurs** : le core ne touche à aucune base
   utilisateur ; la Phase 7 (Privacy Firewall) s'ajoutera comme module dédié.
5. **Pas de dépendance externe** : Redis supprimé respecté (état disque JSON
   atomique, même mécanique que `persistence.ts`), zéro API d'IA externe,
   bibliothèques limitées à Node stdlib.
6. **RAM** : un seul timer Node pour tout le core (`unref`), journaux bornés,
   ticks concurrents plafonnés (défaut 2), agent santé en `stat()` only.

## 5. Ce que la Phase 1 n'est PAS (limites honnêtes)

1. Le core arme aujourd'hui **un seul** module (santé du cerveau) — c'est la
   preuve d'intégration du contrat ; le collecteur 5 min (Lot 2), la file
   persistante (Lot 3) et les suivants s'enregistreront via
   `coeur.enregistrerModule(...)`.
2. L'état du core vit sur le disque de l'hôte qui exécute (VPS) — sur Vercel
   (serverless), le core repart d'un état vide à chaque cold start : le
   fonctionnement 24/7 réel suppose le VPS PM2 (contrainte détectée à
   l'audit §6, traitée au Lot 10 / Phase 12).
3. La suspension automatique ne redémarre pas le PROCESS d'un module — elle
   coupe/réarme le module dans le process du core (l'isolation hors-process
   via `agents-os/dispatch` est la voie des exécutions lourdes, Phase 8).
4. Pas d'interface dashboard encore — le snapshot `etat()` est prêt pour le
   tableau de supervision de la Phase 12 (indicateurs demandés couverts :
   cycles, tâches par statut, modules actifs/suspendus, erreurs).

## 6. Comment rejouer

```bash
npm run typecheck && npm run test          # suite complète
npx vitest run lib/autonomous/core/coeur.test.ts   # tests du core (20)
AUTO_CORE=1 npm run dev                    # le core s'arme au boot (log « Cœur autonome »)
```

Configuration : `AUTO_CORE=0` (désactiver), `AUTO_CORE_CYCLE_MS` (défaut
300 000), `AUTO_CORE_TIMEOUT_TICK_MS`, `AUTO_CORE_TICKS_CONCURRENTS`,
`AUTO_CORE_ECHECS_SUSPENSION`, `AUTO_CORE_SUSPENSION_MS`,
`AUTO_CORE_DOSSIER` (défaut `var/autonomous`).

## 7. Conclusion

Le Lot 1 est livré : l'audit a cartographié le cerveau existant (composants
fonctionnels à conserver, duplications à ne pas étendre, trous à combler) et
le Gen3ia Autonomous Core fournit l'infrastructure de coordination —
modules-agents connectés au cerveau, cycles 5 minutes non bloquants,
traçabilité complète, reprise après panne, supervision honnête. Le socle est
prêt pour le Lot 2 (Acquisition + Scheduler : collecteur 24/7 par cycles de
5 minutes) qui s'enregistrera comme module sans toucher au cœur.
