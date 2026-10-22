# Gemini Live (écran/caméra + voix) — canal complémentaire du système Agent Live

> Task 2-a — intégration du fichier autonome fourni par l'opérateur
> « Gemini Live Screen & Voice App.html » (genIA Desktop) au tableau de bord
> `/live` — élargi sur demande du propriétaire à **Android** (caméra) et aux
> **utilisateurs** (réouverture de la liste blanche).

## Objet

Le panneau « Gemini Live — écran ou caméra + voix »
(`app/live/live-gemini-panel.tsx`) reproduit, dans le système agent live
gen3ia, les capacités temps réel du fichier HTML d'origine, avec une source
visuelle adaptée à l'appareil :

- **Vision pixel — PC** : `getDisplayMedia` 1 fps → canvas → JPEG qualité
  0,6 → `realtimeInput.mediaChunks` (`image/jpeg`) sur le WebSocket Gemini.
- **Vision pixel — Android/iOS** : le partage d'écran n'existe pas sur ces
  navigateurs (`getDisplayMedia` indisponible) — la **CAMÉRA**
  (`getUserMedia`, bascule avant/arrière à chaud) alimente la même chaîne
  canvas → JPEG → 1 fps. Aucun simulacre d'écran : la source réelle est
  annoncée dans le journal et les libellés.
- **Voix bidirectionnelle** : micro PCM16 16 kHz continu
  (`audio/pcm`, ScriptProcessorNode 4096, base64) et réponses voix du modèle
  en PCM 24 kHz (`serverContent.modelTurn.parts[].inlineData`,
  `audio/pcm;rate=24000`) mises en file de lecture via `AudioContext`.
- **Barge-in** : VAD RMS > 0,06 pendant la lecture (le micro coupe la voix de
  l'IA), message serveur `serverContent.interrupted`, bouton manuel.
- **Protocole** : WebSocket
  `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=…`,
  setup `models/gemini-2.0-flash-exp`, modalités `["AUDIO","TEXT"]`, voix
  `Puck` — exactement le schéma du fichier d'origine
  (`lib/live/gemini-live-client.ts`).

La CSP existante autorise déjà `wss://*.googleapis.com` (connect-src) et
`microphone=(self)` / `display-capture=(self)` (Permissions-Policy) :
**aucune modification du middleware n'était nécessaire**.

## Modèle de sécurité (honnêteté)

- La clé API Gemini est **saisie par l'opérateur dans l'UI**, stockée dans le
  `sessionStorage` du navigateur (clé `gen3ia-gemini-key`) et **n'est jamais
  envoyée au backend gen3ia** : elle transite uniquement entre le navigateur
  et le WebSocket officiel de Google, comme dans l'app d'origine.
- Aucune clé Gemini serveur n'existe dans le projet ; le panneau n'appelle
  aucune route `/api/live/*` et ne crée pas de session Firestore.
- Pendant la session, les images d'écran et la voix de l'opérateur sont
  envoyées aux serveurs Google (cf. note affichée dans l'UI).
- `/live` est DÉSORMAIS dans la liste blanche utilisateur (réouverture
  demandée : « l'agent live accessible via Android et PC ») — famille
  `live` dans `lib/security/user-access.ts` ; `/api/live` également
  (sessions + frames). L'ancien garde PC-only des routes
  `/api/live/sessions` et `/api/live/sessions/[id]/frames` est retiré :
  les sessions peuvent être créées depuis Android (source caméra).
- Aucun relais local (`ws://localhost:8080` du fichier d'origine) n'est
  nécessaire : le client parle DIRECTEMENT au WebSocket officiel de Google
  (la CSP autorise `wss://*.googleapis.com`) — moins de maillons, la clé ne
  quitte jamais le navigateur de l'opérateur.
- L'intégration Electron native (`desktopCapturer` via IPC) du fichier
  d'origine n'est PAS reproduite : le navigateur PC utilise le sélecteur
  standard de `getDisplayMedia` (écran/fenêtre/onglet) — fonctionnel
  partout, sans binaire à signer. Le pont `Gen3iaDesktop` reste détecté
  par `lib/device/detect.ts` pour le reste de la plateforme.

## Limites réelles

- Modèle **expérimental** `gemini-2.0-flash-exp` : disponibilité, format de
  réponse et quotas côté Google peuvent évoluer sans préavis.
- Le WebSocket et les médias dépendent du réseau de l'opérateur ; les envois
  sont protégés si le socket n'est pas OPEN (chunks ignorés, aucun crash).
- La qualité du barge-in VAD (RMS simple, seuil 0,06) est celle du fichier
  d'origine : un bruit fort pendant la lecture peut déclencher une coupure.
- Le WebSocket réseau Google n'est **pas** testable en unitaire : les tests
  couvrent les parties pures (conversions PCM/base64, messages du protocole,
  parseur tolérant, file de lecture avec AudioContext factice, gardes
  d'état) — voir `lib/live/gemini-live-client.test.ts` (40 tests).

## Choix de capture micro : ScriptProcessorNode (et pourquoi pas le worklet)

Le worklet existant `public/worklets/live-voice-capture.js` (contrat 110-0)
livre des **énoncés** VAD-gated (`start`/`flush` → `utterance` Int16 @ 16 kHz
avec pré-roll de 320 ms) et non un flux PCM continu. L'utiliser en boucle
`start`→`flush` pour alimenter `realtimeInput` dupliquerait 320 ms de
pré-roll à chaque redémarrage, et le silence entre énoncés ne serait pas
streamé. Gemini attend un flux continu : le panneau utilise donc
**ScriptProcessorNode 4096** (fidèle au fichier HTML) avec le même calcul RMS
inline (seuil 0,06) pour le barge-in. Le worklet reste disponible pour la
pipeline d'énoncés gen3ia (aucun code modifié de son côté).

## Périmètre inchangé

- `lib/live/vision-decider.ts` (perception structurelle, moteur Gen3),
  `lib/live/repository.ts`, `lib/live/gateway.ts` et le flux
  sessions/frames du dashboard (`app/live/live-dashboard.tsx`) :
  **inchangés**. Le panneau Gemini est rendu sous la grille existante,
  comme canal complémentaire. La route `/api/live/sessions/[id]/frames`
  ne change que d'un point : le garde PC-only est retiré (frames caméra
  Android acceptées) — toute la logique de décision reste identique.

## Fichiers

| Fichier | Rôle |
| --- | --- |
| `lib/live/gemini-live-client.ts` | Module pur : constantes protocole, conversions PCM16/base64, RMS/VAD, messages setup/realtimeInput, parseur tolérant, `GeminiLiveSession` (WebSocket + file audio 24 kHz + barge-in, fabriques injectables pour tests). |
| `lib/live/gemini-live-client.test.ts` | 40 tests vitest (conversions, protocole, parseur, RMS, session avec WebSocket/AudioContext factices). |
| `app/live/live-gemini-panel.tsx` | Panneau UI (clé opérateur sessionStorage, démarrage/arrêt, barge-in manuel, journal). |
| `app/live/live-dashboard.tsx` | Intégration du panneau (rendu sous la grille existante — aucun flux modifié). |
