# Rapport — Réflexion profonde & recherche web systématique Gen3

**Date :** 2026-11-22 · **Demande :** trace `1a2022281ea8d0a5` · **Statut :** livré

## 1. Demande utilisateur (trois exigences)

1. **Réflexion de niveau humain** : élever le niveau de réflexion de Gen3 pour qu'il possède un grand niveau de raisonnement afin de résoudre un problème ou une tâche précise, y compris un problème rencontré pendant son travail.
2. **Recherche web systématique** : pour TOUTE tâche qu'il rencontre ou qu'on lui demande, Gen3 doit effectuer des recherches web pour comprendre en détail ce que l'utilisateur demande ou veut.
3. **Recherche multi-pages (≥ 10 pages)** : les recherches doivent couvrir plusieurs pages web — **10 pages minimum**, proportionnelles au niveau de difficulté du prompt (plus le prompt est long, plus la recherche doit couvrir de pages) pour la compréhension et le raisonnement.

## 2. Ce qui a été construit

### 2.1 ① Réflexion profonde (raisonnement humain en 4 phases)

**Nouveau module pur et déterministe : `lib/ai/raisonnement-profond.ts`** (zéro LLM, zéro réseau, garde-fous anti-ReDoS identiques à `tool-intent.ts` — scan borné 2000 caractères, regex linéaires).

Il produit une directive graduée par difficulté injectée dans les trois surfaces de raisonnement :

- **Planner universel** (`lib/agents/runtime/unified-agent.ts`) : directive « DEEP REASONING » dans `PLAN_SYSTEM` + section `RÉFLEXION PROFONDE` complète.
- **Chat conversationnel** (`lib/domain/conversations/engine-chat.ts`) : la directive est ajoutée au prompt système pour toute tâche (pas une salutation).
- **Boucle plan→critique→révision** (`lib/ai/planning.ts`) : le planificateur Task 42 raisonne en 4 phases avant de produire un plan.

Les quatre phases (impératives, silencieuses, avant toute réponse) :
1. **PHASE 1 — Compréhension exhaustive** : reformulation, intention vraie, contraintes implicites, ce qui n'est pas dit et doit être vérifié.
2. **PHASE 2 — Réflexion multi-angles** : décomposition, au moins deux hypothèses candidates, avantages/limites/risques, analogies, cas particuliers et exceptions.
3. **PHASE 3 — Vérification et contre-argumentation** : test des hypothèses contre les faits réels (sources web), recherche active de réfutation, interdiction d'inventer (recherche à la place).
4. **PHASE 4 — Synthèse argumentée** : décision motivée, étapes concrètes, confiance calibrée, alternatives écartées.

Les demandes simples reçoivent une version courte ; les difficultés élevées le mode étendu.

### 2.2 ② Recherche web systématique pour toute tâche

**Détection déterministe** `estTacheRecherchable()` (même module) : un message est une tâche s'il porte un verbe d'action (crée, génère, analyse, compare, résous…) ou une question substantielle (≥ 60 caractères) — les salutations et micro-messages sont exclus.

**Trois chemins d'injection :**

| Surface | Comportement nouveau |
|---|---|
| **Chat** (`engine.ts` + `recherche-systematique.ts`) | Toute tâche déclenche AVANT la réponse une recherche approfondie multi-pages (`web.deep_research` via le pipeline sécurisé `executeTool`), injectée dans le contexte web du tour (bloc honnête « pages réellement lues »). Fail-soft total : une panne n'annule jamais le tour. |
| **Bouton « Recherche web »** | L'ancienne étape `web.search` unique est remplacée par une étape `web.deep_research` (multi-requêtes, ≥ 10 pages) suivie d'une synthèse fondée sur les sources. Idem pour les messages à verbe de recherche détectés (`detectExplicitToolIntent` → upgrade automatique). |
| **Missions/agent universel** (`unified-agent.ts`) | `PLAN_SYSTEM` impose désormais une première étape `web.deep_research` pour TOUT plan ; le plan de repli déterministe (`fallbackPlan`) ouvre aussi par cette étape pour toute tâche. |

### 2.3 ③ Outil `web.deep_research` — multi-pages ≥ 10 selon difficulté

**Nouveau fichier `lib/tools/web/deep-research.ts`** (catégorie `web`, risque `read`, permission `network.read`, SSRF-gardé) :

1. Évalue la difficulté de l'objectif (score 0-100 : longueur + marqueurs + questions + listes).
2. Construit des **requêtes différenciées** : cœur de la demande + angles (explications détaillées, erreurs courantes, meilleures pratiques, comparaison des solutions, actualités — 2 à 5 requêtes selon le niveau).
3. Collecte les candidats (dédup par URL, **diversité par domaine : max 3 pages/domaine**).
4. **Ouvre réellement les pages** jusqu'au budget — **plancher absolu 10 pages**, formule `10 + score/5` plafonnée à 30 : simple → 10, avancée → ~14, complexe → ~19, extrême → 24-30.
5. Renvoie un **bloc honnête** : pages exigées vs pages réellement lues, échecs explicites (raison par page), extraits sourcés (1 600 caractères/page), note « budget atteint » si le plancher n'est pas couvert — jamais de page inventée.

**Enregistrements complets** (l'outil est exécutable partout) :
- `lib/tools/registry.ts` (`GEN3IA_TOOLS` — visible du planner),
- `lib/tools/default-registry.ts` (registre exécutable),
- `lib/security/tool-permissions.ts` (définition de sécurité : lecture réseau pure, comme `web.search`).

Budgets : 12 s/page, budget total par défaut 60 s (chat : 55 s), garde `AbortSignal`.

## 3. Fichiers modifiés/créés

| Fichier | Type | Rôle |
|---|---|---|
| `lib/ai/raisonnement-profond.ts` | créé | Difficulté, requêtes différenciées, directive 4 phases, détection de tâche |
| `lib/tools/web/deep-research.ts` | créé | Outil multi-pages ≥ 10 (recherche + lecture réelle + honnêteté) |
| `lib/domain/conversations/recherche-systematique.ts` | créé | Pont chat → recherche systématique (fail-soft, budget 55 s) |
| `lib/agents/runtime/unified-agent.ts` | modifié | PLAN_SYSTEM (recherche systématique + raisonnement), section réflexion, user prompt avec difficulté, repli déterministe |
| `lib/ai/planning.ts` | modifié | PLAN_SYSTEM enrichi (4 phases + étape de recherche en tête) |
| `lib/agents/runtime/tool-intent.ts` | modifié | `web_research` préfère `web.deep_research` (repli web.search/open) |
| `lib/domain/conversations/engine.ts` | modifié | Chat : contexte de recherche systématique ; bouton + verbes de recherche → deep research multi-pages |
| `lib/domain/conversations/engine-chat.ts` | modifié | Directive de réflexion pour toute tâche ; wording du contexte web |
| `lib/domain/conversations/engine-intent.ts` | modifié | Union `ExplicitToolIntent` + `web.deep_research` |
| `lib/tools/registry.ts`, `lib/tools/default-registry.ts`, `lib/security/tool-permissions.ts` | modifié | Enregistrement outil (3 couches) |
| `lib/ai/raisonnement-profond.test.ts`, `lib/tools/web/deep-research.test.ts` | créés | 15 tests nouveaux |
| `lib/agents/runtime/tool-intent.test.ts` | modifié | Contrat `web_research` mis à jour |

## 4. Vérifications

- **Tests unitaires ciblés : 38/38 verts** (nouveaux modules + tool-intent mis à jour) :
  - plancher 10 pages garanti pour toute entrée (y compris chaîne vide) ;
  - croissance des pages avec la difficulté ; plafond 30 respecté ;
  - diversité par domaine, dédup, échecs honnêtes, budget temps, `minPages` ;
  - « Bonjour » → aucun indice (contrat tool-intent conservé) ; ReDoS-safe ;
  - directive : 4 phases présentes, version courte pour « simple ».
- **Suite vitest intégrale, eslint, tsc, scan secrets : voir journal d'exécution** (section 5).

## 5. Journal d'exécution

- **Pipeline local (commit 8c19900)** : vitest intégral **7430 verts** (14 skipped), eslint 0 erreur, tsc 0 erreur, scan secrets 0 occurrence. CI GitHub : 1er run rouge sur un **timeout flake** du test lourd d'entraînement SNN (`lib/neural/training/webdev.test.ts`, 120 s sous instrumentation coverage — sans rapport avec la livraison) ; **relance des jobs en échec → CI VERTE**.
- **CD « Déploiement continu VPS »** : build production OK, release `cd-latest` publiée (canal pull faisant autorité, sha 8c19900f…) ; le contrôle de livraison PULL a violé le SLE (2400 s) car **gen3ia.online était injoignable** pendant toute la fenêtre (prod='injoignable') → escalade automatique **issue #163** (« intervention console VPS requise », même modèle que #106/#109).
- **Point clé d'attribution** : le site était DÉJÀ injoignable depuis le sandbox à 07:33Z (sondes en timeout) — AVANT le début du CD à 07:57Z et AVANT le push. La surveillance synthétique GitHub échoue de façon concordante. Conclusion : **indisponibilité VPS préexistante** (voir aussi issue #160 « production dégradée » du 2026-11-17), NON causée par la livraison. Le canal pull du VPS rattrapera la release dès le retour du serveur ; la vérification `version.json → gitSha` reste à exécuter après intervention console (script `scripts/verifie-production-reflexion-2026-11-22.py`).
- **Preuve des sondes du jour** : `var-copie/verifie-production-reflexion-2026-11-22.json` (échecs enregistrés honnêtement, `tous_ok: false`).
- Commit de preuve inclus dans **ae79f39 (it.148, Job 478451)** qui pousse au-dessus de 8c19900 ; CI ae79f39 : 7439 verts.

## 6. Limites honnêtes

- La lecture multi-pages ajoute une latence proportionnelle (jusqu'à ~55-60 s dans le pire cas pour une tâche complexe en chat) ; le budget temps est borné et le tour n'est jamais bloqué par une panne (fail-soft).
- Si les moteurs de recherche échouent tous (DuckDuckGo + Wikipédia indisponibles), le bloc porte les échecs explicites et l'agent signale la limite au lieu d'inventer.
- Le nombre de pages est un plancher garanti côté outil ; un contenu web non extractible (JS-only) compte comme échec documenté, pas comme page lue.
