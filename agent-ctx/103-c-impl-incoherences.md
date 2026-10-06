# Task 103-c — impl-incoherences : record de travail (pour les agents suivants)

## État du dépôt au moment du travail
- HEAD = ef8716f, arbre propre au démarrage. Lot 103-a (persistance R2 des
  images) a travaillé EN PARALLÈLE dans le même arbre : app/api/tools/execute/
  route.ts, lib/tools/media/generate-image.ts, lib/integrations/elevenlabs/**,
  lib/video/voice-service.ts, lib/media/** (non persisté), + leurs tests
  (client.test.ts, voice-service.test.ts, lib/media/persist.test.ts).
  NE PAS confondre ces modifications avec les miennes.

## Mes fichiers modifiés (103-c)
1. lib/env/config-report.ts — OPTIONAL_RECOGNIZED étendu (variables média
   réellement lues) : AGNES_API_KEY, AGNES_IMAGE_MODEL, AGNES_API_BASE,
   AGNES_TEXT_MODEL, TWENTY_FIRST_API_KEY, VIDEO_FFMPEG_PATH,
   VIDEO_FFPROBE_PATH, VIDEO_FONT_PATH, VIDEO_STATIC_RELEASE_TAG,
   VIDEO_STATIC_BINARIES_URL, VIDEO_RENDER_MINOR_PER_SEC, GEN3IA_APP_ORIGIN.
   ELEVENLABS_VOICE_ID était déjà présent ; HF_TOKEN CONSERVÉ (il est réellement
   lu par lib/memory/embeddings.ts et lib/skills/semantic.ts via
   @huggingface/inference — l'audit « HF_TOKEN jamais lu hors test » était
   inexact ; il ne s'agit PAS du provider AIProvider supprimé).
2. lib/ai/models.ts — union AIProvider sans "huggingface" (+ commentaire FR).
3. lib/ai/providers/index.ts — case "huggingface" (throw « implemented
   separately ») supprimé ; tombé dans le default « Unsupported provider ».
   HORS liste autorisée mais NON interdit et OBLIGATOIRE (TS2678 : case non
   comparable à l'union réduite).
4. lib/billing/cost-engine.ts — entrées huggingface (COST_HF_*) retirées des
   Record<AIProvider, number>.
5. lib/tools/media/create-video.ts — export VIDEO_ASPECT_RATIOS (as const) +
   type VideoAspectRatio ; zod du z.enum consomme le constant ; commentaire FR
   « source unique / intercept chat séparé mais à aligner ».
6. lib/workflows/executor.ts + lib/agents/runtime/runner.ts — retrait de
   "huggingface" des unions littérales locales / VALID_PROVIDERS (tsc-forced :
   ces unions alimentent AIRequest.provider). Effet : un ancien doc stockant
   provider:"huggingface" retombe dans le routage automatique (lecture
   tolérée), au lieu du throw « implemented separately ».
7. app/api/chat/message/route.ts — EXCEPTION DÉCLARÉE à l'interdit app/api/** :
   le zod d'ENTRÉE du chat acceptait "huggingface" et TS2322 cassait tsc
   (body.provider → AIRequest). L'instruction du lot (« si un schéma zod
   d'ENTRÉE utilisateur accepte huggingface, retire la valeur du enum »)
   commande ce retrait ; 1 ligne + commentaire. À signaler à l'orchestrateur.
8. Tests : lib/env/config-report.test.ts (+4 : 1 comportemental faux écart +
   3 gardes fs), lib/ai/models.test.ts (NOUVEAU, 4 gardes fs : union sans HF,
   case HF absent, COST_HF absent, zod chat sans HF), lib/ai/resilience.test.ts
   (huggingface→agnes), lib/ai/router.test.ts (delete HF_TOKEN retiré),
   lib/tools/media/tools.test.ts (+1 test ratios + 2 gardes fs ; collision
   d'imports avec 103-a dédoublonnée — leurs tests persist cohabitent).

## Validations (21:41, arbre partagé avec 103-a)
- npx tsc --noEmit → 0 erreur.
- npx vitest run lib/env/config-report.test.ts lib/ai lib/billing lib/tools/media
  → 28 fichiers, 270 verts / 1 skip (gated production-queue).
- npx eslint sur les 13 fichiers touchés → 0 erreur.
- Aucun install/commit/push/build ; aucun console.log ajouté.

## Pièges pour les suivants
- Le libellé « huggingface » reste cité dans des commentaires FR (historique) :
  les gardes verrouillent les FORMES syntaxiques (| "huggingface",
  case "huggingface", huggingface:, process.env.COST_HF) pas le mot nu.
- lib/tools/media/tools.test.ts est un fichier PARTAGÉ avec 103-a : ajouter en
  fin de fichier / describes distincts, ne jamais réécrire leurs blocs.
- engine.ts (intercept video.create, L2535-2584) valide toujours les ratios
  inline (interdit intouché) : si VIDEO_ASPECT_RATIOS évolue, aligner
  manuellement engine.ts (commentaire FR dans create-video.ts le signale).
