# Plan directeur Gen3 v2 — million de neurones + GNWM + calcul distribué WebGPU

**Statut du document :** PLAN DIRECTEUR validé — feuille de route d'exécution (PHASE 0-17).
**Consolidation :** 2026-11-27 (v2) — intègre le bloc « calcul distribué WebGPU » (PHASE 11-17) au plan million-neurones (PHASE 0-10).
**Règle transversale :** aucun statut TESTED/PRODUCTION_VERIFIED n'est accordé sans mesure réelle ; le simulated n'est jamais présenté comme du réel ; chaque palier est validé avant le suivant.

---

## 1. Objectif

Transformer le réseau actuel (fenêtre réelle gravée en continu, itérations it.1xx, ~140 neurones d'origine) en un cerveau de **~1 000 000 de neurones** organisé en 5 couches, avec mémoire d'ondes GNWM, exécution CPU-first (GPU optionnel) et — nouveauté v2 — une couche d'**accélération par le matériel des utilisateurs** (WebGPU dans le navigateur), connectée au serveur neuronal central sans jamais transférer l'autorité de décision.

| Cible | Valeur |
|---|---|
| Total neurones | 999 960 (~1 M) |
| Plateforme de référence | CPU serveur (Node.js, typed arrays) |
| Accélération | WebGPU navigateur (opt-in, facultative, vérifiée) |
| Mémoire | GNWM — réseau d'ondes (actives + traces persistantes) |
| Persistance | Checkpoints disque + chargement progressif (D3) |
| Déploiement | Hyperlift / cPanel — conteneur persistant (jamais serverless) |

## 2. Principes architecturaux (révisés v2)

| Principe | Formulation révisée |
|---|---|
| Cerveau unique | **Inchangé et renforcé** : le serveur neuronal (Gen3ia Brain) reste la seule autorité de décision. Les nœuds navigateurs des utilisateurs sont des **accélérateurs sans autorité de décision** — ils propagent des ondes, ils ne pensent pas |
| Matériel | CPU serveur prioritaire ; **GPU des utilisateurs (WebGPU) = couche d'accélération facultative et consentie**, gracieusement absente (le système fonctionne à 100 % sans elle) |
| Frontière de confidentialité | **La mémoire (GNWM) et la consolidation ne quittent jamais le serveur.** Un client ne reçoit que des éclats structurels (topologie + poids CSR) et des événements anonymes — jamais de requêtes ni de traces personnelles (D1 + isolation préservées) |
| Résultats authentiques | Interdiction absolue de résultats simulés : **tout résultat client est vérifié** (exécution redondante + contrôle CPU échantillonné + réputation). Un nœud fautif est détecté, écarté, journalisé |
| État | Labels honnêtes uniquement : IMPLEMENTED / INTEGRATED / TESTED / PRODUCTION_VERIFIED / BLOCKED — « les fichiers existent » n'est jamais une preuve |
| Environnement d'exécution | Hyperlift/cPanel (conteneur persistant) ; Vercel serverless n'est pas un environnement d'exécution persistant |
| Dépendances externes | Toujours derrière un adaptateur remplaçable (LLM, TTS, stockage, transport WS, backend GPU) |

## 3. Architecture 5 couches (~1 M neurones)

| Couche | Neurones | Rôle | Distribution (v2) |
|---|---|---|---|
| N1 — encodage | 1 024 | Entrées multimodales → ondes (fréquence/phase/amplitude/relations conceptuelles) | **Serveur** (latence critique) |
| N2 — motifs | 16 384 | Détection de motifs, bande 0-31 | **Serveur** (latence critique) |
| N3 — associations | 131 072 | Croisements inter-domaines | **Éclats distribuables** |
| N4 — mémoire/reasoning | 524 288 | Traces GNWM, raisonnement | **Éclats distribuables** |
| N5 — spécialisation | 327 192 | Groupes spécialisés par domaine/vocation | **Éclats distribuables** |

Sous-total : 1 024 + 16 384 + 131 072 + 524 288 + 327 192 = **999 960**.

## 4. GNWM — mémoire d'ondes (Wave Memory)

La mémoire n'est pas un stockage séparé : **les quatre mémoires (épisodique, sémantique, procédurale, de travail) sont des fonctions du même réseau** — des configurations d'ondes et de poids, pas des tables.

| Concept | Définition |
|---|---|
| Onde active | Configuration de neurones activés qui propage une représentation en cours de traitement (vivant, éphémère) |
| Trace persistante | Poids consolidés qui survivent au cycle (mémoire longue) — seule la trace est durable, l'onde est le processus |
| Consolidation sélective | Les traces se forment uniquement depuis les ondes validées (mesure avant/après exigée) — jamais d'écriture de poids non mesurée |

**Boucle GNWM (6 étapes, cycle neural continu) :**

1. **Encodage** — la perception entrante devient une onde dans N1/N2 (bandes de fréquence).
2. **Propagation** — l'onde traverse N3-N5 par activation événementielle (listes actives, file d'événements).
3. **Résonance** — confrontations aux traces persistantes : hits/miss mesurés (rappel = résonance).
4. **Écriture candidate** — les ondes à forte co-activation marquent des arêtes candidates (jamais d'écriture directe).
5. **Consolidation** — processus neural indépendant en arrière-plan (JAMAIS dans le serveur web) : les candidates validées deviennent des poids persistants ; mesure avant/après obligatoire.
6. **Rappel/réponse** — l'onde résiduelle + les traces activées produisent la sortie ; le cycle recommence.

## 5. Transformations techniques

| Domaine | Changement |
|---|---|
| Représentation | Matrices creuses **CSR/CSC** + `Float32Array`/`Int32Array` (zéro objet par neurone) |
| Activation | Événementielle : file d'événements + listes actives (pas de boucle dense sur 1 M neurones) |
| Connexions | Construction progressive (paliers) — jamais une matrice dense 1M×1M |
| Spécialisation | Groupes de colonnes par domaine (vocation chartée), compositables |
| Persistance | D3 : checkpoints disque + chargement progressif (le serveur redémarre sans tout retenir en RAM) |
| Encodage | D1 : l'encodage s'exécute à chaque requête, mais **seules les modifications de traces VALIDÉES** persistent les poids |
| Consolidation | Processus séparé (worker/process neural dédié) — le serveur web ne réapprend jamais en ligne |

## 6. Bloc distribué WebGPU (v2) — fonctionnement

1. **Découpage** : N1–N2 restent serveur (latence critique) ; N3–N5 sont découpés en **éclats** (shards) = groupe de neurones + tranche CSR + états `Float32Array`.
2. **Registre des nœuds** : chaque navigateur consentant ouvre un worker (`gen3-node.worker`), déclare ses capacités (WebGPU, VRAM, limites), heartbeat.
3. **Dispatch** : le serveur assigne éclat × fenêtre de pas de temps (job_id type `gen3_job_…`, machine à 5 états du système genAPI réutilisée) ; transport **WebSocket avec repli HTTP polling** (adaptateur remplaçable).
4. **Calcul GPU** : shaders WGSL — propagation événementielle (liste active → liste active suivante), mise à jour de poids uniquement si la politique de consolidation l'autorise (jamais côté client en pratique).
5. **Retour + routage** : les impulsions frontalières (spikes traversant les frontières d'éclat) reviennent au serveur, qui les route vers les éclats suivants.
6. **Fusion + vérification** : le serveur fusionne, vérifie (redondance N=2 + contrôle CPU échantillonné + invariants : comptes de spikes, énergie), intègre au cerveau central.
7. **Robustesse** : déconnexion d'un onglet → re-dispatch idempotent ; réputation des nœuds ; liste noire.

## 7. Organisation des fichiers (cible)

| Module | Responsabilité |
|---|---|
| `lib/neural/core/*` | Champ cortical, colonnes, bandes, propagation événementielle |
| `lib/neural/memory/*` | GNWM : ondes actives, traces, consolidation, checkpoints (D3) |
| `lib/neural/distributed/shard-manager.ts` | Découpage N3–N5, tranches CSR, événements frontaliers |
| `lib/neural/distributed/node-registry.ts` | Nœuds, heartbeat, capacités, réputation |
| `lib/neural/distributed/task-dispatcher.ts` | Jobs, sélection, re-dispatch idempotent |
| `lib/neural/distributed/result-verifier.ts` | Intégrité : redondance, tolérances, échantillonnage CPU |
| `lib/neural/backends/webgpu-adapter.ts` | Buffers + kernels WGSL (**adaptateur remplaçable**) |
| `lib/neural/backends/cpu-backend.ts` | Implémentation de référence (contrat d'adaptateur) |
| `lib/neural/transport/ws-protocol.ts` | Protocole messages (hello/cap/task/result/heartbeat) — adaptateur WS + repli HTTP |
| `public/workers/gen3-node.worker.ts` | Entrée nœud navigateur (opt-in explicite) |
| `components/contribute/*` | UI consentement, limites ressources, état du nœud |

## 8. Stratégie par paliers (croissance validée)

| Palier | Neurones | Validation exigée avant de passer au suivant |
|---|---|---|
| P0 (référence) | réseau actuel (~140 → état réel mesuré) | Benchmark CPU : latence/onde, RAM, rappel — la BASE |
| P1 | 1 024 | Exactitude rappel ≥ baseline P0 ; latence/onde ≤ 2× P0 |
| P2 | 16 384 | Propagation événementielle < boucle dense ; RAM mesurée |
| P3 | 131 072 | CSR/CSC obligatoire ; checkpoints disque testés (D3) |
| P4 | 524 288 | Consolidation en processus séparé vérifiée (D2) ; serveur web sans relearning |
| P5 | 999 960 (~1 M) | Endurance 72 h ; rappel mesuré par domaine ; rapport honnête |

## 9. PHASES

### 9.1 Noyau et mémoire (PHASE 0-10)

| Phase | Travail | Validation |
|---|---|---|
| 0 | Audit référence du réseau actuel (benchmark CPU mesuré, archivé) | JSON de mesures committé |
| 1 | Cœur événementiel (listes actives + file d'événements) | Tests d'équivalence vs boucle dense |
| 2 | CSR/CSC + typed arrays | Bénéfice RAM/latence mesuré |
| 3 | Palier 1 024 → 16 384 | Seuils du palier P2 |
| 4 | GNWM : ondes actives + traces + résonance | Mesures avant/après, hits/miss publiés |
| 5 | Consolidation en processus indépendant (D2) | Le serveur web reste réactif pendant consolidation |
| 6 | Palier 131 072 (CSR obligatoire) | Seuils P3 |
| 7 | Checkpoints disque + chargement progressif (D3) | Redémarrage : état restauré vérifié par empreinte |
| 8 | Palier 524 288 | Seuils P4 |
| 9 | Groupes spécialisés + compositing | Rappel par domaine ≥ seuil |
| 10 | Palier 999 960 + endurance | Endurance 72 h + rapport final |

### 9.2 Calcul distribué WebGPU (PHASE 11-17)

| Phase | Travail | Validation exigée avant statut TESTED |
|---|---|---|
| 11 | Contrat d'adaptateur calcul (CPU référence / WebGPU) + détection capacités | Tests de contrat ; CPU et stub GPU interchangeables |
| 12 | Kernels WGSL propagation événementielle sur 1 éclat | Équivalence GPU/CPU mesurée (1 024–16 384 neurones, tolérances documentées) |
| 13 | Shard-manager serveur (tranches CSR, frontaliers) | Tests golden : aucun événement perdu aux frontières |
| 14 | Registre + transport WS/repli HTTP + re-dispatch | Test intégration : déconnexion brutale d'un nœud, job bouclé sans duplication |
| 15 | Vérificateur de résultats + réputation | **Test anti-fraude réel** : un nœud délibérément fautif est détecté, écarté, journalisé |
| 16 | Worker navigateur opt-in + UI consentement + limites | E2E navigateur réel : un onglet contribue un éclat à un serveur local, résultat vérifié intégré |
| 17 | Montée en charge distribuée + benchmarks + sécurité | N éclats × M nœuds : débit frontalier, latence vs CPU-only, rapport final |

## 10. Métriques (à chaque palier)

- Noyau : latence/onde, RAM/1 000 neurones, précision rappel par domaine, hits/miss résonance, débit consolidation.
- Distribué (à chaque palier distribué) : nœuds actifs, éclats/s, événements frontaliers/s, taux de re-dispatch, taux de fraude détectée, **delta de latence et de RAM serveur vs CPU-seul** — le distribué n'est retenu que s'il améliore le rapport capacité/ressources **mesuré**.

## 11. Décisions d'architecture

| Décision | Contenu |
|---|---|
| D1 | Encodage par requête ; seules les modifications de traces **validées** persistent les poids (pas d'écriture non mesurée) |
| D2 | Consolidation en processus neural indépendant (arrière-plan) — interdiction de relearning dans le serveur web |
| D3 | Checkpoints disque + chargement progressif — le redémarrage ne reconstruit pas tout en RAM |

## 12. Risques déclarés dès maintenant

| Risque | Doctrine |
|---|---|
| **WebSocket entrant sur Hyperlift** : capacité à vérifier (PHASE 14) | En cas de blocage, le repli HTTP polling est l'adaptateur de secours ; statut `BLOCKED` posé si non vérifiable |
| **Non-déterminisme flottant GPU** | Vérification par tolérances statistiques (jamais d'égalité bit-exacte exigée), tolérances publiées dans le rapport |
| **WebGPU en navigateur headless** | Tests E2E nécessitent Chrome réel avec flags ; limites déclarées si non reproductibles en CI |
| Environnement persistant absent (production générique) | Les paliers P3+ et l'endurance 72 h exigent Hyperlift/cPanel opérationnel — sinon statut BLOCKED, jamais simulé |
| Quotas données massives (10 M/modalité) | Pipeline fenêtré opérationnel ; l'échelle requiert un disque persistant — état réel publié dans `datasets/INDEX_v6.json` |

## 13. État de départ (mesuré, 2026-11-26-27)

| Réalité de départ | Source |
|---|---|
| Pré-entraînement million 19/19 domaines — 19 177 594 échantillons (trace d'assimilation 12/19 déclarée) | `assets/neural-pretrained/preentrainement-eod-million-19-domaines.json` |
| Fenêtres multimodales réelles gravées (it.150 : HF + Kaggle, 40 assets, 2 696 lignes couleurs) | `var-copie/rapport-it150.json`, `datasets/INDEX_v6.json` |
| Cortexte/SNN en production : fenêtre réelle + snapshot `cortex-multimodal-it150.bin` (12 582 960 o) | dépôt |
| Référence CPU : benchmark du workflow CI (« Gen3 Brain — benchmark CPU et garde-fous ») | `.github/workflows/ci.yml` |

Le plan s'exécute depuis CET état réel — pas depuis zéro, pas depuis une simulation.
