# GEN3IA LIVE — AUDIT DE L'EXISTANT (Phase 0, mission GEN3IA LIVE)

**Date** : 2026-11-26 · **Méthode** : lecture du code réel (`lib/live`, `app/api/live`, `app/live`, `services/live-agent`, scripts e2e, `docs/live-gemini.md`). Aucun composant supprimé ; ce rapport distingue les 5 niveaux exigés.

## 1. Cartographie réelle (5200 lignes Live existantes)

| Fichier | Lignes | Rôle réel constaté | Tests |
|---|---|---|---|
| `lib/live/types.ts` | 110 | modèle zod : 6 permissions (`screen.read`, `input.mouse/keyboard`, `files.read/write`, `browser.control`), 7 statuts session, modes `browser`/`desktop`, runtime states, actions souris/clavier/fichiers avec chemins sûrs | — |
| `lib/live/repository.ts` | 247 | persistance Firestore (`liveAgentSessions`), heartbeat 30 s plafonné (2 writes/min), pending actions (10 min), max 300 itérations | indirecte |
| `lib/live/gateway.ts` + `gateway-server.ts` | 412 | serveur WebSocket `ws` : appairage par token hashé (constant-time), anti-rejeu timestamps, rate limiting, validation frames base64, heartbeat 30 s, watchdog zombie 75 s, max 3 viewers, boucle décision→action→résultat | `gateway.test.ts` |
| `lib/live/vision-decider.ts` | 257 | décideur vision **interne uniquement** (Task 150 : IA externes purgées) : perception STRUCTURELLE (dimensions JPEG via marqueurs SOF, poids, SHA-256 dédup), narration moteur Gen3 texte, **actions limitées à `wait`** — les actions souris/clavier sans vision pixel seraient des fabrications de coordonnées | `vision-decider.test.ts` (17) |
| ~~lib/live/gemini-live-client.ts~~ | — | **RETIRÉ pendant l'audit** (commit cron 95c1c3/95c1dc3, Job 478451 : règle plateforme « zéro service IA externe ») — remplacé par `components/live/live-interne-panel` (canal 100 % moteur Gen3) | tests retirés avec le canal |
| `lib/live/security.ts` | 95 | `LiveAuthFailureLimiter`, `LiveRateLimiter`, hash pairing token, vérification fraîcheur timestamps, validation frames | `security.test.ts` (5) |
| `lib/live/decision-lock.ts` | 109 | verrou décision (une seule décision concurrente) | `decision-lock.test.ts` (7) |
| `app/api/live/sessions/**` | 8 routes | sessions CRUD, `[id]/start`, `/events`, `/frames`, `/contexte`, `/actions/[actionId]/approve|retry` | `route.test.ts` |
| `app/live/` + `components/live/` | ~1445 | page responsive PC/Android, dashboard HITL, panneau INTERNE live-interne-panel (après retrait du panneau Gemini externe par 95c1dc3) | 4 tests structurels (commit 95c1dc3) |
| `services/live-agent/` | 450 | client PC Node : exécution souris/clavier/fichiers, file-capsule (capsules fichiers), limits | `file-capsule.test.ts`, `limits.test.ts` |
| scripts e2e | — | `e2e_live_browser_prod.mjs`, `probe_sdk_live.mjs`, `diag_video_delivery.mjs`, `gen_live_fixtures.py` (frames réelles) | outils de validation |

## 2. Les 5 niveaux exigés (honnêteté)

- **Présente** : capture écran PC (`getDisplayMedia`), capture caméra Android (avant/arrière), micro, transport JPEG base64 ≤900 ms/frame, agent PC (souris/clavier/fichiers), vocal bidirectionnel (Gemini Live, VAD, barge-in), dashboard HITL.
- **Intégrée** : sessions Firestore + 8 routes API, permissions zod uniques, HITL approve/retry, gateway sécurité complète, appairage token, verrou décision, UI connectée aux API.
- **Testée** : ~84 tests `lib/live` + tests routes + tests live-agent — **exécution re-verify ce tour après restauration node_modules** (le sandbox a recyclé `node_modules` une seconde fois).
- **Validée sur matériel** : outils e2e présents (scripts ci-dessus, fixtures réelles) ; **dernier résultat de run non vérifiable dans ce sandbox** — à re-exécuter en Phase 13 (scénarios A-L).
- **Opérationnelle en production** : le projet est déployé (production Next.js) mais **aucune vérification Live en prod n'est possible depuis ce sandbox** — niveau déclaré « non vérifié ».

## 2bis. ÉVÉNEMENT PENDANT L'AUDIT (2026-11-26) — retrait du canal externe par le dépôt

Le commit cron `95c1dc3` a supprimé le canal Gemini externe (gemini-live-client + 40 tests + panneau + doc) au motif de la règle plateforme « zéro service IA externe », et remplacé le panneau du chat par `components/live/live-interne-panel` (pipeline interne : /api/live/sessions, frames getDisplayMedia PC OU getUserMedia caméra mobile, vision-decider interne, HITL inline, stop réel — « plus AUCUNE voix annoncée (guidage textuel) »).

Conséquences pour la mission GEN3IA LIVE :
- **Écart n°5 résolu** : le vocal n'entre plus par un cerveau externe — le cerveau décisionnel est UNIQUEMENT Gen3ia Core (conforme à la règle architecturale fondamentale de la mission).
- **Phase 4 (vocal bidirectionnel) s'ouvre à nouveau** : le vocal n'existe plus côté navigateur ; à reconstruire 100 % interne (ASR + TTS internes ou Web Speech API côté client) — aucune dépendance externe.
- Les niveaux « Présente/Intégrée/Testée » du §2 qui mentionnaient Gemini sont RÉVISÉS : le vocal bidirectionnel repasse au niveau « ABSENT (retiré) ».

## 3. Écarts vs mission (cibles non couvertes — à construire, pas à remplacer)

1. **Vision pixel réelle** : ABSENTE (honnêtement documentée dans `vision-decider.ts` : pas d'OCR, pas d'objets/scènes, actions restreintes à `wait`). → Phase 3 mission.
2. **WebRTC/SFU** : ABSENT (transport = JPEG base64 via WebSocket + PCM via Gemini). → Phase 2 mission ; la mission autorise « communication directe sans SFU pour les premières versions ».
3. **Live Engine central unifié** : PARTIEL — deux canaux coexistent (gateway interne écran/agent, panneau Gemini externe écran+voix) sans cœur commun orchestrant les 5 services. → Phase 1 mission.
4. **Collaboration multi-participants** : LIMITÉE (3 viewers, pas d'annotations/pointeur partagé/fichiers/rôles). → Phase 8.
5. **Cerveau unique** : RÉSOLU par 95c1dc3 (moteur interne uniquement). Le vocal bidirectionnel reste à reconstruire avec ce moteur interne (Phase 4 mission).
6. **Arrêt d'urgence / consentement écran** : partiel (stop session existe ; bannière d'information présente ; consentement explicite par action sensible : HITL approve).

## 4. Fonctions réutilisables précises (réutilisation obligatoire Phase 1+)

- `repository.ts` (sessions/events/runtime) → devient la couche persistance du session-manager central.
- `types.ts` (permissions/actions) → contrat unique, étendu aux nouveaux modes (vocal, caméra, collaboration) sans casser les zod existants.
- `gateway.ts` (sécurité, boucle, watchdog) → canal agent conservé ; l'engine central s'y raccorde.
- `security.ts` (limiters, pairing) → réutilisés par toute nouvelle route live.
- `vision-decider.ts` → remplacé INTÉRIEUREMENT (mêmes entrées/sorties) par le moteur vision réel Phase 3, jamais doublé.
- ~~gemini-live-client.ts~~ → RETIRÉ par 95c1dc3 ; le canal vocal sera reconstruit interne (Phase 4 mission) sur le même module pur testable que le reste.
- `services/live-agent` → l'Action Executor du plan existant (niveau 3 « Contrôle autorisé » déjà implémenté via HITL).
