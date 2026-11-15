# Task 103-f — audit-lib (périmètre lib/**)

Dépôt : /home/z/my-project/repo-gen3ia (branche main, arbre propre avant intervention).
Périmètre autorisé : lib/** + leurs tests. Interdits respectés : app/**, components/**, next.config.ts, firestore.indexes.json, vercel.json. Aucun install/commit/push/build, aucun console.log ajouté.

## Corrections appliquées (5 fichiers)

| # | Fichier | Anomalie | Corrigée | Diff |
|---|---------|----------|----------|------|
| 1 | lib/domain/conversations/engine.ts | Intercept video.create (~L2556) dupliquait le littéral `["16:9","9:16","1:1"]` au lieu du constant partagé | ✅ | Import `VIDEO_ASPECT_RATIOS` depuis `@/lib/tools/media/create-video` + sélection `find()` (type `VideoAspectRatio` déduit, comportement identique) |
| 2 | lib/tools/media/create-video.ts | Doc-commentaire décrivait l'intercept chat comme « à aligner manuellement » | ✅ | Commentaire mis à jour : l'intercept importe désormais le constant (source unique effective) |
| 3 | lib/tools/media/tools.test.ts | Garde structurel 103-c obsolète + absence de garde anti-régression sur l'intercept | ✅ | Garde « align » mis à jour + NOUVEAU garde : engine.ts contient l'import + `VIDEO_ASPECT_RATIOS.find` et ne contient plus `aspectInput === "16:9"` |
| 4 | lib/storage/permanent-user-storage.ts | `FieldValue.serverTimestamp() as unknown as SessionDoc["createdAt"]` (L161) | ✅ | Type d'écriture `SessionDocWrite = Omit<SessionDoc,"createdAt"> & { createdAt: FirebaseFirestore.FieldValue }` — zéro assertion, lectures inchangées |
| 5 | lib/integrations/elevenlabs/client.ts | 2 fetch SANS timeout : `listElevenLabsVoices` et `elevenLabsTextToSpeech` (risque de pendaison indéfinie d'un outil) | ✅ | `AbortSignal.timeout(30_000)` (voices) / `(60_000)` (TTS ≤2 500 caractères) — `addElevenLabsVoice` déjà borné à 120 s |

## Anomalies auditées, CONFORMES (aucun changement)

| Axe | Constat |
|-----|---------|
| Résidus de refactor | 0 référence morte : « huggingface » restant = usages vivants (lib/memory/embeddings.ts, lib/skills/semantic.ts via @huggingface/inference — HF_TOKEN préservé) + commentaires/gardes 103-c ; `ExecutionTelemetry`/`recordExecutionMetrics` (lib/observability/otel.ts) VIVANTS (6 routes app + tests) ; 0 occurrence `agents/autonomous`, `agents/orchestrator/` |
| wakeAtMs (Task 102) | 7 chemins documentés conformes (create L358, update L414, claimDue tx L468, terminaison tx L627, claimRetry tx L929, poll veille L1161, backfill L721) ; 2 écritures sans recalcul analysées correctes (triggerScheduleNow L970 : ne consomme aucun champ du calcul ; claimAlwaysOnRun L1027 : slot webhook sans collision `oneshot:` ; la terminaison recalcule) |
| usageDaily | Aucun lecteur de l'ancienne collection « usage » (lib + app) ; écritures atomiques set merge + FieldValue.increment cohérentes |
| Replis | lib/media/persist.ts : try/catch total jamais-throw, timeout 30 s, plafond 15 Mo ; lib/integrations/elevenlabs/tools.ts : persistance R2 try/catch total, repli inline garanti |
| Clés R2 doublons | Chat (engine.ts L1403) et outil (lib/media/persist.ts L170) produisent des clés compatibles `users/<uid>/permanent/ai-images/<ts>-<uuid>.<ext>` — non fusionnés (engine.ts critique) |

## Assertions de type documentées sans changement (non triviales, protégées par normalisation runtime)

- lib/video/render-queue.ts L477, lib/video/production-queue.ts L411 — payload miroir Supabase casté puis normalisé champ à champ.
- lib/video/security.ts L157/L164 — interop CJS ffmpeg-static/ffprobe-static.
- lib/storage/r2.ts L53 — sonde duck-typing `destroy` sur le Body S3 (union SDK).
- lib/integrations/elevenlabs/client.test.ts L77 — accès aux args d'un mock (test).

lib/ai et lib/media : 0 assertion. `uploadVideoAsset` (lib/storage/r2.ts) : NON touché (décision produit documentée).

## Hors périmètre — signalé SANS corriger (app/**)

1. **app/api/admin/observability/route.ts** : lit `usageDaily` (calls, costMinor) mais n'expose PAS les sous-totaux `models.<clé>` pourtant écrits par lib/ai/usage.ts. Extension triviale à prévoir : agréger `data.models` dans le reduce de la réponse.
2. NB cohérence : `costMinor`/`costUsd` n'est pas écrit par usageDaily (coût suivi côté lib/billing) → le total coût de la réponse admin reste 0 côté usage IA.

## Validations (exécutées réellement)

- `npx tsc --noEmit` → **0 erreur**
- `npx vitest run lib/tools lib/video lib/ai lib/media lib/integrations/elevenlabs lib/domain/conversations lib/storage` → **46 fichiers, 474 verts / 1 skipped** (skip préexistant `it.runIf(productionQueueAvailable)`)
- `npx eslint` sur les 5 fichiers touchés → **0 erreur**

## Diffs résumés

```
 lib/domain/conversations/engine.ts    |  7 ++++++-   (import constant + intercept find())
 lib/integrations/elevenlabs/client.ts |  6 ++++++    (2 AbortSignal.timeout)
 lib/storage/permanent-user-storage.ts | 13 +++++++-- (SessionDocWrite, -as unknown as)
 lib/tools/media/create-video.ts       |  8 +++-----  (doc source unique)
 lib/tools/media/tools.test.ts         | 21 ++++++++-- (garde intercept aligné)
```
