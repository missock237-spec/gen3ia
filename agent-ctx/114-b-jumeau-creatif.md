# Task 114-b — « Jumeau Créatif » (profil utilisateur → chat, missions, images, TTS)

Agent : développement Next.js 15 / TypeScript strict. Dépôt : main, base 88de191. Zéro commande git, zéro installation, périmètre 114-b strict (aucun fichier 114-a/noyau touché).

## Objet

Profil jumeau UTILISATEUR (style d'écriture, univers, valeurs, ton + voix par défaut) stocké dans l'identité R2 et injecté (fail-soft) dans : le chat des agents, les missions planifiées, la génération d'images et la synthèse vocale.

## Créés

- `lib/identity/twin.ts` — getTwinProfile (fail-soft {}), updateTwinProfile (parse zod → fusion champ à champ → updateIdentity, updatedAtMs serveur, chaîne vide = effacement), buildTwinDirective (PUR, FR, ≤ 1200 chars, sections « Style d'écriture / Univers / Valeurs / Ton », "" si vide), buildTwinImageHint (PUR, ≤ 300 chars), twinDirectiveForUser + twinImageHintForUser (cache mémoire TTL 60 s via cacheWrap lib/cache/redis, fail-soft undefined). Types TwinProfile/TwinProfileInput.
- `app/api/identity/twin/route.ts` — GET (getTwinProfile → { twinProfile }) et PATCH (safeParse TwinProfileSchema → 400 badRequest FR si invalide, sinon updateTwinProfile → { twinProfile }). Garde `protectRoute` (requireUser + rate limit 120/60 req / 5 min), erreurs canoniques errorBody/errorStatus + identityErrorStatus (404 non provisionné, 503 R2, 400/422 validation), runtime nodejs, cache-control no-store.
- `lib/voice/user-voice.ts` — resolveUserVoiceId(userId) : defaultVoiceProfileId du jumeau → VoiceProfile (getVoiceProfile) → elevenLabsVoiceId ; sinon profil isDefault (sinon premier) de listVoiceProfiles → elevenLabsVoiceId ; sinon null. Un profil recording NON cloné (sans elevenLabsVoiceId) n'est JAMAIS retourné. Cache TTL 120 s, imports dynamiques de voice-service (pile vidéo chargée seulement si besoin), fail-soft total → null.
- Tests : `lib/identity/twin.test.ts` (14 — directive vide/complet/plafond 1200, hint image ≤ 300, schéma >12 valeurs & >2000 chars refusés / bornes incluses acceptées, fusion + effacement + ZodError sans écriture + fail-soft), `lib/voice/user-voice.test.ts` (9 — chaîne de sélection complète defaultVoiceProfileId > isDefault > premier > null, recording non cloné jamais retourné, pannes jumeau/bibliothèque → null).

## Modifiés

- `lib/identity/schema.ts` (ADDITIF) — TwinProfileSchema (writingStyle/universe ≤ 2000, values ≤ 12 × 200, tone ≤ 200, defaultVoiceProfileId ≤ 200, voiceEnabled, updatedAtMs), `twinProfile` optionnel ajouté à IdentitySchema ET IdentityPatchSchema (strictObject). Vérifié : publicIdentity (projection explicite uid/displayName/photoURL/theme/createdAt) n'expose RIEN du jumeau — donnée privée par construction ; GET /api/auth/profile renvoie l'identité COMPLÈTE au propriétaire seul (déjà le cas) ; putIdentity re-parse par le schéma → stockage conforme.
- `lib/agents/chat-engine.ts` — answerAsAgent : directive du jumeau concaténée à la charte (après applyPromptVariables) dans le prompt système ; planAgentTask : directive composée AVEC la charte dans le config passé à planUniversalAgent (chemin agent). Signature publique inchangée, fail-soft try/catch + console.warn partout.
- `lib/agents/runtime/unified-agent.ts` (AUTORISÉ) — chemin UNIVERSEL (missions lancées hors agent, sans charter) : injection de la directive via import dynamique `@/lib/identity/twin` (pattern existant custom-apis/skills/evolution) ; AVEC charte → PAS d'injection (déjà composée par planAgentTask, jamais en double). Fail-soft.
- `lib/ai/image-prompt-enhancer.ts` — enhanceImagePrompt(rawPrompt, options?: { twinHint?: string; userId?: string }) : options TOUTES optionnelles (aucun appelant cassé) ; extrait jumeau ajouté au prompt FINAL (jamais au passage isSaneEnhancement — la vérif de fidélité du sujet reste intacte), y compris sur les chemins de repli (garde-fou rejeté, LLM down) ; résolution AVANT l'appel LLM (cache 60 s, zéro latence perçue), fail-soft.
- `lib/integrations/elevenlabs/tools.ts` — voiceSpeakTool.execute : si l'input ne fournit PAS de voiceId → resolveUserVoiceId(context.userId) via import dynamique et transmission à elevenLabsTextToSpeech. Schéma d'input et output INCHANGÉS ; fail-soft (voix null → voix plateforme historique).
- `lib/live/voice/turn-pipeline.ts` — LiveVoiceTurnInput + champ optionnel `voiceId?: string` transmis à l'appel TTS de fin de tour (spread conditionnel). Comportement inchangé quand absent.
- Tests étendus : `lib/agents/chat-engine.test.ts` (+4 : injection jumeau chat, absence = inchangé, panne = chat OK, charte+jumeau composés dans le planner), `lib/agents/runtime/unified-agent.tools.test.ts` (+3 : injection universelle, pas de double avec charte, panne = inchangé), `lib/ai/image-prompt-enhancer.test.ts` (+5 : append hint, priorité twinHint > userId, vide = historique, hint sur replis, panne = OK).

## Points de branchement de l'injection (récapitulatif)

| Surface | Point | État |
|---|---|---|
| Chat agents | answerAsAgent (chat-engine) — charter + directive dans le system prompt | ✅ branché |
| Missions via agent | planAgentTask → planUniversalAgent (charter composé) | ✅ branché |
| Missions universelles | unified-agent planUniversalAgent (sans charte uniquement) | ✅ branché |
| Live voix (TEXTE) | turn-pipeline → answerAsAgent → même injection | ✅ branché (transitif) |
| Images (outil prêt) | enhanceImagePrompt options {twinHint, userId} | ⚠️ prêt, appelants à brancher |
| TTS conversation (voice.speak) | tools.ts → resolveUserVoiceId | ✅ branché |
| TTS live voix | turn-pipeline input.voiceId | ⚠️ paramètre prêt, route à brancher |

## Branchement à finaliser (hors périmètre 114-b, fichiers noyau/114-a)

1. `lib/domain/conversations/engine.ts` (~l.1389, produceConversationImage) : `enhanceImagePrompt(rawPrompt, { userId })` — le chat conversationnel aura la signature visuelle du jumeau (l'outillage est complet, 1 ligne).
2. `lib/agents/runtime/runner.ts` (~l.402, executeMedia) : idem `{ userId: this.userId }` — les missions exécuteront la signature visuelle.
3. `app/api/live/voice/turn/route.ts` (~l.155) : `voiceId: (await resolveUserVoiceId(auth.uid)) ?? undefined` dans l'input de runLiveVoiceTurn — la session live parlera avec la voix clonée du jumeau.
4. UI jumeau (édition GET/PATCH /api/identity/twin) : non demandée dans ce lot — l'API est prête.

## Décisions & invariants

- twinProfile = donnée PRIVÉE : exclue de publicIdentity ; aucun champ du jumeau ne sort par une projection publique.
- Sémantique PATCH : fusion champ à champ (l'objet complet remplace via IdentityPatchSchema mais le service fusionne AVANT) ; chaîne vide = effacement ; updatedAtMs toujours serveur.
- Directive ≤ 1200 chars (plafond dur, budgets par section) pour ne pas diluer les chartes ; extrait image ≤ 300 chars (style/univers/ambiance).
- Cache mémoire process-local (cacheWrap) : 60 s directive/hint, 120 s voix ; pannes JAMAIS mises en cache ; fail-soft intégral ({} / undefined / null) — aucune erreur jumeau ne peut casser un chat, une mission, une image ou un TTS.
- Résolution voix : le clonage reste du ressort du pipeline vidéo (voice-service) — resolveUserVoiceId ne clone JAMAIS, il ne consomme que des elevenLabsVoiceId existants.

## Validation (chiffrée)

- `npx tsc --noEmit` = 0 erreur.
- `npx eslint` (14 fichiers touchés) `--max-warnings 0` = 0 erreur / 0 warning.
- `npx vitest run lib/identity lib/voice/user-voice.test.ts lib/agents/chat-engine.test.ts lib/agents/runtime/unified-agent.tools.test.ts lib/ai/image-prompt-enhancer.test.ts lib/live/voice/turn-pipeline.test.ts` = 9 fichiers / 131 tests verts (dont 23 nouveaux).
- Suites impactées élargies (lib/agents, lib/ai, lib/live, lib/tools, app/api/agent, app/api/auth, app/api/live, app/api/settings) = 93 fichiers / 859 verts + 1 skipped.
- Suite COMPLÈTE `npx vitest run` = 284 fichiers / 2932 verts + 2 skipped / 0 échec.
- `bun run lint` : 1 erreur PRÉEXISTANTE hors périmètre (app/api/agent/chat/route.ts `captureMissionEscrow` unused — fichier 114-a en cours en parallèle, non touché).
