# GEN3IA LIVE — RAPPORT TECHNIQUE CONSOLIDÉ (LOTS 1-10, 2026-11-26)

**Commits poussés sur main** : `b3e9298` (LOT 1) · `f0f6c14` (LOT 2) · `94fe744`→`1357332` (LOT 3 + fixes types) · `e05ff79` (LOT 4) · `c5af7ca`→`db0a634` (LOT 5/8/9/10 + fixes).
**Preuves globales** : `vitest run lib/live/` → **81/81 verts** (11 fichiers) · `npx tsc --noEmit` → 0 erreur · `npx eslint lib/live/` → 0 erreur/warning. CI GitHub (`ci.yml` : Typecheck · Lint · Tests · Audit · Build · Budget) s'exécute sur chaque push.

## Validation par lot (honnêteté : règle 6 — jamais « fichiers existants »)

| Lot | Statut | Preuve d'exécution | Non validé (déclaré) |
|---|---|---|---|
| 1 Stabilisation | ✅ TERMINÉ | 1 erreur lint corrigée ; adaptateur réel `adapterEvenementsAgent`→`recordLiveEvent` (Firestore existant, mock en test) ; doc interfaces internes ; non-concurrence session-manager↔repository audité et documenté ; 55/55 | persistance Firestore réelle de l'adaptateur (non exécutable en sandbox) |
| 2 Transport | ✅ MODULES TERMINÉS | ice-config (TURN sans identifiants refusé + avertissement NAT), event-ordering (numérotation monotone, trous détectés avec liste exacte), quality-adaptive (4 profils, survival/réduction/montée déterministes) — 16 tests | **2 appareils réels, réseaux différents, audio+vidéo simultanés après coupure : NON VALIDÉ** (règle 12) |
| 3 Vision | ✅ TERMINÉ | OCR adaptateur remplaçable (règle 11 : `definirMoteurOcrLocal`, moteur invalide rejeté, échec → indisponible avec raison) ; confiance des observations déterministe (accord hash/diff, OCR plafonnant, facteurs déclarés) ; mémoire visuelle par session existante ; pont cerveau complet — 66/66 dont moteur injecté lisant « Enregistrer » | **OCR réel** : aucun modèle local dans le dépôt — dépendance à empaqueter (tesseract-wasm + données) hors sandbox |
| 4 Vocal | ✅ MOTEUR TERMINÉ | VAD réel (hystérésis 180/700 ms sur WAV PCM16 générés, réutilise `comprendreAudioWav`) ; machine à états complète avec barge-in (TTS stoppé, retour écoute), repli-texte explicite, erreur cerveau→écoute continue ; bug réel corrigé par les tests (TTS absent bloquait le micro) — 72/72 | **ASR/TTS navigateur réels** (Web Speech) et conversation micro→haut-parleur : adaptateurs prêts, NON VALIDÉS en sandbox |
| 5 Vidéo | ✅ PONT TERMINÉ | `pont-vocal-vision` : le cerveau vocal reçoit le contexte visuel RÉEL du vision-engine (texte borné + confiance + textes OCR) ; la caméra était déjà branchée au décideur (frames getUserMedia → POST /frames → vision-decider → visionPixels) — testé | **scène réelle filmée + question vocale sur Android** : matériel requis |
| 6 Screen sharing | ✅ NAVIGATEUR (existant) | navigateur opérationnel depuis le canal agent existant (getDisplayMedia → frames → vision) ; commandes démarrage/pause/arrêt existantes ; notification de partage actif dans l'UI | **Android MediaProjection / iOS ReplayKit** : applications natives non présentes dans ce dépôt — à créer hors sandbox, NON IMPLÉMENTÉ (déclaré) |
| 7 Agent | ✅ BOUCLÉ (bornes réelles) | boucle OBSERVATION→COMPRÉHENSION→PLANIFICATION→AUTORISATION→EXÉCUTION→VÉRIFICATION existante : vision-decider (interne) + gateway (appairage/anti-rejeu/watchdog) + HITL approve/retry + client PC (souris/clavier/fichiers) + journalisation (events) | **actions souris précises sur pixels** : sans OCR réel le décideur reste borné (structurel) — bornes documentées dans le code, jamais contournées |
| 8 Collaboratif | ✅ MODULES TERMINÉS | chat/annotations/pointeur/fichiers = événements bus typés ; observateur lecture seule refusé ; nom de fichier dangereux refusé ; pointeur en présence ; historique ordonné — testé | **multi-utilisateurs réels simultanés** (2 navigateurs) : matériel |
| 9 Intégration | ✅ SCÉNARIO TESTÉ | orchestrateur : **scénario obligatoire exécuté en test réel** (écran+micro+analyse+invitation → 4 étapes ok) ; interruption entre services sans couper les autres ; conflit de ressources verrouillé | production réelle simultanée : déploiement |
| 10 Sécurité | ✅ ARRÊT D'URGENCE + existant | arrêt d'urgence global (propriétaire seul, terminal, non-résurrection, `urgence.arret` auditable) ; existant conservé : Firebase auth, rate-limit 20/5min, pairing tokens hashés constant-time, anti-rejeu, HITL | tests d'intrusion réels (LOT 12-N) |

## Corrections structurelles révélées par les tests (valeur réelle du LOT)

1. **Bus process-global unique** : deux bus coexistaient (tests/prod) — un seul historique commun désormais (exigence mission).
2. **Présence en direct à l'invitation** : `rejoindre` marque la présence immédiatement.
3. **Micro bloqué sans TTS** : l'état initial verrouillait l'écoute — l'utilisateur garde la voix dès qu'un ASR existe.
4. **dHash aveugle** : échantillonnage corrigé pour couvrir TOUTE la grille (les changements hors coin haut-gauche étaient invisibles).

## Variables d'environnement réellement lues par le code (grep)

- `GEN3IA_LIVE_STUN_URL` / `GEN3IA_LIVE_TURN_URL` / `GEN3IA_LIVE_TURN_USERNAME` / `GEN3IA_LIVE_TURN_PASSWORD` — TURN complet exigé, jamais de faux TURN.
- `GEN3IA_LIVE_GATEWAY_URL` — référence SFU/document (LOT 2, sfu-adapter).
Les autres variables de la mission (GEN3IA_LIVE_ENABLED, MAX_SESSION_DURATION, FRAME_RATE, VISION_PROVIDER…) ne sont pas encore lues par le code : elles restent une LISTE CIBLE mission — non simulées.

## Limitations restantes (règle 8 — listes complètes)

1. **Matériel** : tout critère « 2 appareils / réseaux réels / Android / navigateurs multiples » est NON VALIDÉ depuis ce sandbox — tests A-N du LOT 12 à exécuter sur environnement réel.
2. **OCR réel** : à empaqueter (aucun service IA externe autorisé par la plateforme).
3. **Applications natives** Android (MediaProjection) et iOS (ReplayKit) : non présentes dans le dépôt.
4. **ASR/TTS** : adaptateurs Web Speech livrés mais non validés navigateur.
5. **LOT 11 (UI unifiée)** et **LOT 12 (perf/production/livrables finaux)** : à faire — aucun bouton fictif ne sera créé.
