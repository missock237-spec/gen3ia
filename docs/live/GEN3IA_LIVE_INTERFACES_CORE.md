# GEN3IA LIVE — INTERFACES INTERNES DU MOTEUR CENTRAL (LOT 1, livrable)

**Date** : 2026-11-26 · Scope : `lib/live/core/` + connexions vers l'existant. ESLint/tsc/tests : propres (50/50, 0 erreur lint sur lib/live + app/api/live + components/live + app/live).

## 1. Surfaces core (contrats exacts)

| Module | Export | Contrat |
|---|---|---|
| `live-core-types.ts` | `MODES_LIVE` (5 modes), `ModeLive`, `RoleParticipant`, `ParticipantLive`, `SessionLive`, `EvenementLive`, `StoreSessionsLive`, `StoreEvenementsLive`, `createStoreMemoire()`, `nouvelleSession()` | contrats purs injectables ; store mémoire borné (5000 événements) |
| `live-session-manager.ts` | `creerGestionnaireSessions(store, maintenant?)` → `GestionnaireSessions` | cycle de vie UNIQUE : creer/lire/activerMode/desactiverMode/demarrer/pauser/reprendre/arreter/rejoindre/quitter/pouls/balayage ; propriétaire+admin modifient, collaborateur active, observateur rien ; expiration auto ; `nouveauJetonAppairage(dureeMs)` (jetons à durée limitée, mission sécurité) |
| `live-event-bus.ts` | `obtenirBusEvenements(store?)`, `reinitialiserBus()` | pub/typé/filtré par types et source ; abonné défaillant ne bloque pas ; singleton process-global en prod ; historique via store |
| `live-state-manager.ts` | `marquerPresence`, `marquerDeconnexion`, `acquerirVerrou`, `libererVerrou`, `etatPresence`, `reinitialiserEtatLive` | état temporaire process-global ; verrous TTL 60 s ; présence sans TTL ici (le pouls du session-manager fait l'expiration à 120 s) |
| `live-engine.ts` | `LiveEngine` (façade) | ouvrirSession/activerMode (verrou par mode)/desactiverMode/pouls/deconnexion/rejoindre/vue ; `PERMISSIONS_MODE` (écran→screen.read, agent→HITL, vocal/caméra→consentement client) |
| `live-store-adapters.ts` | `adapterEvenementsAgent(sessionId)`, `storeProduction()`, `mapperSessionCoreVersAgent()` | bus d'une session agent → `recordLiveEvent` existant (lecture via GET /events existante) ; sessions multimodes en mémoire (Firestore multimodes = LOT 9, NON VALIDÉE) |

## 2. Non-concurrence des gestionnaires de sessions (audit exigé)

**Un seul gestionnaire de cycle de vie multimodal** : `core/live-session-manager.ts`. `repository.ts` n'est PAS un concurrent : c'est la **persistance du canal AGENT** (appairage, runtime, HITL) consommée par le gateway WebSocket existant et les 8 routes — jamais remplacé, jamais doublé (règles mission 3-4-5).

| Aspect | `core/live-session-manager` (multimodes) | `repository.ts` (canal agent) |
|---|---|---|
| Statuts | `pending/active/pause/terminee/expiree` | `pending/connected/running/paused/disconnected/stopped/failed` |
| Rôle | cycles de vie des 5 services + participants/rôles | runtime d'exécution agent PC (observations, actions, approbations) |
| Persistance | store injectable (mémoire prod, Firestore multimodes LOT 9) | Firestore `liveAgentSessions` |
| Connexion | `adapterEvenementsAgent` écrit les événements core dans la sous-collection `events` d'une session agent | `recordLiveEvent` existant inchangé |

Verrous : `decision-lock.ts` (une décision à la fois, canal agent) ≠ `state-manager.acquerirVerrou` (ressources multimodes, TTL) — usages distincts, aucune redondance. Aucun autre créateur de session n'a été ajouté.

## 3. Utilisation réelle (aucun composant inutilisé)

- Les modules core sont exécutés par **18 tests réels** (core 11 + adapters) — preuve d'exécution, pas « fichiers existants ».
- L'adaptateur `adapterEvenementsAgent` est branché sur `recordLiveEvent` EXISTANT (règle 5 : pas de fausse intégration — le test utilise un mock de repository, la persistance Firestore réelle est déclarée **non validée** en sandbox).
- Les lots suivants consomment l'engine : LOT 4 (vocal : session vocal + bus), LOT 8 (collaboration : participants/rôles/présence existants dans core), LOT 9 (orchestrateur sur la façade LiveEngine).

## 4. CI et validation LOT 1

- `vitest run lib/live/` → 50/50 verts (7 fichiers).
- `npx tsc --noEmit` → 0 erreur lib/live.
- `npx eslint lib/live/ app/api/live/ components/live/ app/live/` → 0 erreur 0 warning (1 erreur corrigée : import inutilisé `reinitialiserBus`).
- CI GitHub (`ci.yml` : Typecheck · Lint · Tests · Audit · Build · Budget sur push main) : les étapes locales équivalentes sont vertes ; le run GitHub dépend du push (voir rapport).
