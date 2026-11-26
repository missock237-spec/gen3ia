# GEN3IA LIVE — AUDIT DE L'EXISTANT (Phase 0, mission GEN3IA LIVE)

**Date** : 2026-11-26 · **Méthode** : lecture du code réel (`lib/live`, `app/api/live`, `app/live`, `services/live-agent`, scripts e2e, `docs/live-gemini.md`). Aucun composant supprimé ; ce rapport distingue les 5 niveaux exigés.

## 1. Cartographie réelle (5200 lignes Live existantes)

| Fichier | Lignes | Rôle réel constaté | Tests |
|---|---|---|---|
| `lib/live/types.ts` | 110 | modèle zod : 6 permissions (`screen.read`, `input.mouse/keyboard`, `files.read/write`, `browser.control`), 7 statuts session, modes `browser`/`desktop`, runtime states, actions souris/clavier/fichiers avec chemins sûrs | — |
| `lib/live/repository.ts` | 247 | persistance Firestore (`liveAgentSessions`), heartbeat 30 s plafonné (2 writes/min), pending actions (10 min), max 300 itérations | indirecte |
| `lib/live/gateway.ts` + `gateway-server.ts` | 412 | serveur WebSocket `ws` : appairage par token hashé (constant-time), anti-rejeu timestamps, rate limiting, validation frames base64, heartbeat 30 s, watchdog zombie 75 s, max 3 viewers, boucle décision→action→résultat | `gateway.test.ts` |
| `lib/live/vision-decider.ts` | 257 | décideur vision **interne uniquement** (Task 150 : IA externes purgées) : perception STRUCTURELLE (dimensions JPEG via marqueurs SOF, poids, SHA-256 dédup), narration moteur Gen3 texte, **actions limitées à `wait`** — les actions souris/clavier sans vision pixel seraient des fabrications de coordonnées | `vision-decider.test.ts` (17) |
| `lib/live/gemini-live-client.ts` | 741 | client Gemini Live (BidiGenerateContent v1alpha) : écran+voix, audio PCM16 16 kHz→24 kHz, VAD RMS>0,06, barge-in, clé API en sessionStorage navigateur, module pur testable | `gemini-live-client.test.ts` (54) |
| `lib/live/security.ts` | 95 | `LiveAuthFailureLimiter`, `LiveRateLimiter`, hash pairing token, vérification fraîcheur timestamps, validation frames | `security.test.ts` (5) |
| `lib/live/decision-lock.ts` | 109 | verrou décision (une seule décision concurrente) | `decision-lock.test.ts` (7) |
| `app/api/live/sessions/**` | 8 routes | sessions CRUD, `[id]/start`, `/events`, `/frames`, `/contexte`, `/actions/[actionId]/approve|retry` | `route.test.ts` |
| `app/live/` | 1445 | page responsive PC/Android (détection device), dashboard HITL 840 l., panneau Gemini 545 l. | — |
| `services/live-agent/` | 450 | client PC Node : exécution souris/clavier/fichiers, file-capsule (capsules fichiers), limits | `file-capsule.test.ts`, `limits.test.ts` |
| scripts e2e | — | `e2e_live_browser_prod.mjs`, `probe_sdk_live.mjs`, `diag_video_delivery.mjs`, `gen_live_fixtures.py` (frames réelles) | outils de validation |

## 2. Les 5 niveaux exigés (honnêteté)

- **Présente** : capture écran PC (`getDisplayMedia`), capture caméra Android (avant/arrière), micro, transport JPEG base64 ≤900 ms/frame, agent PC (souris/clavier/fichiers), vocal bidirectionnel (Gemini Live, VAD, barge-in), dashboard HITL.
- **Intégrée** : sessions Firestore + 8 routes API, permissions zod uniques, HITL approve/retry, gateway sécurité complète, appairage token, verrou décision, UI connectée aux API.
- **Testée** : ~84 tests `lib/live` + tests routes + tests live-agent — **exécution re-verify ce tour après restauration node_modules** (le sandbox a recyclé `node_modules` une seconde fois).
- **Validée sur matériel** : outils e2e présents (scripts ci-dessus, fixtures réelles) ; **dernier résultat de run non vérifiable dans ce sandbox** — à re-exécuter en Phase 13 (scénarios A-L).
- **Opérationnelle en production** : le projet est déployé (production Next.js) mais **aucune vérification Live en prod n'est possible depuis ce sandbox** — niveau déclaré « non vérifié ».

## 3. Écarts vs mission (cibles non couvertes — à construire, pas à remplacer)

1. **Vision pixel réelle** : ABSENTE (honnêtement documentée dans `vision-decider.ts` : pas d'OCR, pas d'objets/scènes, actions restreintes à `wait`). → Phase 3 mission.
2. **WebRTC/SFU** : ABSENT (transport = JPEG base64 via WebSocket + PCM via Gemini). → Phase 2 mission ; la mission autorise « communication directe sans SFU pour les premières versions ».
3. **Live Engine central unifié** : PARTIEL — deux canaux coexistent (gateway interne écran/agent, panneau Gemini externe écran+voix) sans cœur commun orchestrant les 5 services. → Phase 1 mission.
4. **Collaboration multi-participants** : LIMITÉE (3 viewers, pas d'annotations/pointeur partagé/fichiers/rôles). → Phase 8.
5. **Cerveau unique** : le vocal passe par un cerveau EXTERNE (Gemini, clé opérateur) — écart avec la règle « Gen3ia Core seul décideur » ; le pont vers Gen3ia Core est à construire sans casser le canal Gemini opérationnel.
6. **Arrêt d'urgence / consentement écran** : partiel (stop session existe ; bannière d'information présente ; consentement explicite par action sensible : HITL approve).

## 4. Fonctions réutilisables précises (réutilisation obligatoire Phase 1+)

- `repository.ts` (sessions/events/runtime) → devient la couche persistance du session-manager central.
- `types.ts` (permissions/actions) → contrat unique, étendu aux nouveaux modes (vocal, caméra, collaboration) sans casser les zod existants.
- `gateway.ts` (sécurité, boucle, watchdog) → canal agent conservé ; l'engine central s'y raccorde.
- `security.ts` (limiters, pairing) → réutilisés par toute nouvelle route live.
- `vision-decider.ts` → remplacé INTÉRIEUREMENT (mêmes entrées/sorties) par le moteur vision réel Phase 3, jamais doublé.
- `gemini-live-client.ts` → conservé comme canal vocal opérationnel ; pont Gen3ia Core ajouté par-dessus.
- `services/live-agent` → l'Action Executor du plan existant (niveau 3 « Contrôle autorisé » déjà implémenté via HITL).
