# Feuille de route GTIS — Gen3 Training/Tool Intelligence System

**Provenance :** deux audits externes (système d'entraînement + outils internes), **vérifiés ligne par ligne contre le code** le 2026-11-27. Ce document fixe ce qui est exact, ce qui est corrigé, ce qui est adopté, et ce qui est refusé (avec raison) — puis la trajectoire.

**Vérification d'abord, application ensuite :** un audit externe reste une source à valider ; chaque affirmation ci-dessous renvoie à un fichier/ligne réels.

---

## 1. Verdict sur les audits (vérifié)

### Affirmations EXACTES (preuves vérifiées)
| Affirmation | Preuve |
|---|---|
| 78 outils au catalogue GEN3IA_TOOLS, 67 définitions de sécurité, 13 outils annoncés sans définition | `lib/tools/registry.ts`, `lib/security/tool-permissions.ts` — décomptes exacts, les 13 nommés correspondants |
| `authorizeTool()` rejette les outils sans définition (`Unknown tool security definition`) | `tool-permissions.ts:163` + appel par `lib/tools/executor.ts:92` et `lib/agents/runtime/secure-tool-executor.ts:77` |
| `plan-policy` plantait aussi sur définition manquante | `lib/agents/runtime/plan-policy.ts` (appel direct dans la boucle) |
| 8 exécuteurs réels hors catalogue (musique.creer, code.exec, code.inspect, web.http, web.dns, dev.fmt, dev.regex, artefacts.audit) | `lib/tools/default-registry.ts` — tous enregistrés, aucun au catalogue |
| Représentation lexicale par hachage FNV-1a ; 8 bandes porteuses pour 19 domaines | `lib/neural/training/entrainement-ondes.ts:11,53,60-68` (`BANDES_VOCABULAIRE_ONDES = 8`) |
| Étiquetage lexical déterministe (`labelText`) — risque d'apprendre l'étiqueteur | `lib/neural/training/dataset.ts:87` |
| Découverte MCP tronquée dans le prompt (20 outils, 8 propriétés, descriptions raccourcies) | `lib/integrations/mcp/service.ts:238,240,261` |
| Aucun worker GPU configuré par défaut (honnête) | `app/api/training/worker/route.ts:12,49` |
| Volumes PRO_MANIFEST déclarés ≠ fichiers réels disponibles | `datasets/PRO_MANIFEST.json` (déclaré vs détail — audit correct de séparer déclaré/appris) |
| Séparation train/test au niveau exemple insuffisante (fuites par source) | `lib/neural/training/trainer.ts` (séparation reproductible par exemple) |

### Affirmations INEXACTES ou À NUANCER
| Affirmation de l'audit | Réalité vérifiée |
|---|---|
| « Runs laissés au statut `planifie` » | AUCUN run n'est créé en production : le gestionnaire UCE-013 (`model-training-manager.ts` + `multimodal-training-manager.ts`) a **zéro consommateur** (grep dépôt). L'orchestration RÉELLE est `lib/neural/training/job.ts` (statuts en_cours→termine/echec) consommé par `lib/mlops/pipeline.ts` + `app/api/neural/train|state|brain`, et la boucle auto-apprentissage `lib/entrainement-auto/boucle.ts` (évaluations mesurées accuracyTrain/Test, maîtrise par domaine). Le gestionnaire est une infrastructure DORMANTE, pas un pipeline cassé. |
| 2 outils « sécurisés mais absents du catalogue » (artifact.convert, brain.train) | Exact — mais l'audit a MANQUÉ les vrais fantômes : `camera.capture` et `ads.publish` (annoncés + sécurisés, **aucun exécuteur** au registre ni surface dédiée — grep dépôt complet), et `file.modify`/`artifact.download` encore dans `PROJECT_SERVICE_TOOLS` (retirés du catalogue en it.58 mais oubliés dans la liste des services). |
| `INTERNAL_ACTION_TOOLS` « trop permissive » (file.delete, email.send, terminal.run sans validation) | Choix DE DESIGN documenté : directive propriétaire 10-10 (« aucune approbation pour un outil interne ; validation uniquement pour les secrets utilisateurs », `lib/agents/approval-policy.ts` en-tête + commentaires par outil, captures production citées). Refusé sans instruction contraire du propriétaire. |
| « Ne pas confondre outil enregistré et capacité réelle » | Exact et déjà la doctrine du dépôt (les exécuteurs échouent PROPREMENT en nommant la variable manquante — `default-registry.ts` commentaires). |

## 2. Corrigé le 2026-11-27 (P0 — capacité annoncée = capacité exécutable)

| Correctif | Contenu |
|---|---|
| 21 définitions de sécurité ajoutées | 13 outils du catalogue (code.simulate, knowledge.search, messaging.send, social.publish, webhook.emit, zendesk ×4, servicenow ×3, media.analyze) + 8 exécuteurs hors catalogue (code.exec, code.inspect, web.http, web.dns, dev.fmt, dev.regex, musique.creer, artefacts.audit) — conventions HITL/10-10 respectées |
| Catalogue synchronisé | +11 entrées réelles (les 8 ci-dessus + artifact.convert + brain.train + code.simulate détaillé) ; −2 fantômes (camera.capture, ads.publish — aucun exécuteur, doctrine it.58) |
| `code.simulate` branché | Nouvel exécuteur `lib/tools/code/simulate.ts` sur le moteur réel `lib/sandbox/simulation.ts` (analyse statique honnête, zéro effet de bord) — le fantôme annoncé devient capacité vraie |
| `PROJECT_SERVICE_TOOLS` purgé | file.modify, artifact.download retirés ; descripteur fichiers corrigé |
| `plan-policy` fail-closed | Une définition manquante ne plante PLUS la mission QStash entière : l'outil inconnu est excisé du plan (allowTools + permissions) avec `console.warn` — authorizeTool le rejetterait en aval de toute façon |
| Test de garde | `tests/unit/tool-registries-coherence.test.ts` — 7 invariants (unicité catalogue, catalogue↔sécurité dans les DEUX sens, registre↔sécurité, registre↔catalogue, services↔sécurité, zéro fantôme réintroduit) |
| Registre de conformité | `scripts/registre-conformite-outils.ts` → `docs/rapports/registre-conformite-outils.{json,md}` : **86 outils — 68 fonctionnels, 18 partiellement fonctionnels (exécuteur réel sous condition de configuration), 0 bloqués, 0 manquants** |

## 3. Trajectoire adoptée (phases GTIS)

### Phase 1 — Unification de l'orchestration (LIVRÉE 2026-11-28)
- [x] Brancher `planifierRun`/`cloreRun` (UCE-013) sur le moteur RÉEL `lib/neural/training/job.ts` (`lancerEntrainement`) : chaque job déclare maintenant un run (scoreAvant mesuré avant toute passe) et le clôt (scoreApres mesuré, anti-régression -0.02, leçon enregistrée) — le pipeline MLOps (`lib/mlops/pipeline.ts`) et `/api/neural/train` héritent du branchement par le même point d'entrée. **Vérifié** : `scripts/valide-phase1-orchestration.mts`, 6/6 PASS, delta réel +2.79 (rapport `docs/rapports/rapport-gtis-phase1-orchestration-2026-11-28.md`).
- [x] États unifiés partagés job.ts ↔ UCE-013 (`statutJobVersRun` — une seule nomenclature, un seul registre de persistance `cap_resources`).
- [x] Reprise après interruption : un job interrompu ne persiste RIEN (sauvegarde du cerveau en fin de job seulement) → reprise idempotente par nouveau job depuis l'état persisté ; les runs `en_cours` orphelins sont clôturés honnêtement par `cloreRunsOrphelins()` (jamais de run qui stagne).
- **Validation exigée** : FAITE — un run réel bout-en-bout (planifier → entraîner → clôturer) avec mesures avant/après : `var-copie/phase1-gtis-orchestration.json` + tests `tests/unit/phase1-gtis-orchestration.test.ts` (11 invariants).

### Phase 2 — Fiabilisation des datasets
- [ ] Provenance par échantillon (source, licence, date) dans `datasets/PRO_MANIFEST.json` + vérification à l'ingestion.
- [ ] Dédoublonnage sémantique (au-delà des motifs) + séparation train/test PAR SOURCE (anti-fuite — audit exact sur labelText et la séparation par exemple).
- [ ] Compteurs réels distincts synthétique/reformulé/réel dans les métriques publiées (jamais mélanger les volumes déclarés et les échantillons réellement traversés).

### Phase 3 — Évolution du cerveau (représentations)
- [ ] Au-delà du hachage FNV-1a : embeddings d'usage du cortex (voisins co-activés → proximité) pour rapprocher voiture/automobile — MESURER le gain rappel avant d'adopter (règle anti-régression).
- [ ] Bandes porteuses : passer de 8 bandes partagées à des sous-bandes par domaine (finir les collisions) — mesurer l'impact inter-domaines.
- [ ] Évaluations externes indépendantes (jeux jamais vus, reformulations) — les métriques internes (résonance, renforts) ne prouvent pas la compréhension.

### Phase 4 — Multimodal réel
- [ ] Pipeline multimodal unifié (associations texte↔image↔audio conservées à l'ingestion — le plan directeur v2 §6-9 reste la référence ; PHASE 11-17 distribué non commencé).

### Phase 5 — Laboratoire de validation
- [ ] Benchmarks externes publiés (comparaison honnête, pas d'« équivalent aux grands modèles » prématuré).
- [ ] Suite anti-régression à chaque modification du cerveau (bench CI existe — l'étendre au rappel par domaine).

## 4. Décisions enregistrées
1. **Directive 10-10 conservée** (approval-policy) — choix propriétaire explicite ; l'audit est noté, pas appliqué.
2. **Fantômes retirés** plutôt que construits : camera.capture (pont matériel inexistant), ads.publish (action Composio non câblée) — les portes de politique restent en place ; le jour où un exécuteur existe, le test de cohérence impose les trois couches d'un coup.
3. **Unification orchestration** = Phase 1 ci-dessus — PAS de branchement forcé dans cette itération (le wiring aurait dupliqué la comptabilité de job.ts/boucle avec risque de régression).
4. **Tout statut honnête** : la capacité annoncée = capacité exécutable ; l'échec propre nomme toujours la variable manquante ; aucun résultat simulé présenté comme réel.
