# Task 103-e — audit-frontend (périmètre components/** + app/** hors app/api)

Dépôt : /home/z/my-project/repo-gen3ia (branche main). Arbre PARTAGÉ avec le lot
parallèle 103-f (audit-lib) : les fichiers app/api/**, lib/** et leur test
apparaissant dans `git status` LUI appartiennent — vérifiable au diff ; mes 6
fichiers modifiés sont listés ci-dessous et ne recouvrent pas son périmètre.
Aucun install/commit/push/build, aucun console.log ajouté ; lib/** et app/api/**
respectés (lecture seule pour lib).

## Corrections appliquées (6 fichiers)

| # | Fichier | Axe | Anomalie | Sévérité | Corrigée |
|---|---------|-----|----------|----------|----------|
| 1 | components/workspace/artifact-panel.tsx | Contrats fetch (1) + état mort | `previewUrl` initialisé, remis à null, lu (`previewUrl ?? currentVersion.url`) mais JAMAIS alimenté : un artefact persisté porte une CLÉ R2 (storagePath), pas une URL — l'audio voice.speak copié en R2 (Task 103-b : content=undefined, storagePath=clé, url=clé) recevait `<audio src="users/…">` invalide, et les images d'outil avec URL provider expirée (Task 103-a) restaient cassées bien que la copie permanente existe | Haute | ✅ useEffect de résolution : image/audio avec storagePath (hors data URI inline) → URL signée fraîche via resolveFileUrl ?? defaultResolveFileUrl (/api/storage/permanent), repli silencieux sur l'URL d'origine/inline, garde anti-course `cancelled` |
| 2 | components/video/video-project-workspace.tsx | Hooks (3) | `syncTimelineMutations` (useCallback [projectId, loadProject]) lisait `project` figé à la création du callback (souvent null au montage) : le repli `cachedProject?.project ?? project` écrivait un cache périmé ou sautait l'écriture locale après sync Timeline. Warning eslint react-hooks/exhaustive-deps. Ajout naïf de la dep risquait une boucle (retry d'items en erreur → loadProject → setProject → re-run effet) | Moyenne | ✅ `projectRef` synchronisé par effet, lu dans le callback — closure fraîche, identité du callback inchangée (zéro boucle possible), warning eslint éliminé |
| 3 | components/auth/EmailAuthForm.tsx | Handlers morts (2) | `<a href="#" onClick={handleReset}>` : faux lien — handleReset fait preventDefault, href="#" ne navigue jamais (pollution historique + sémantique lien erronée pour lecteurs d'écran) | Basse | ✅ `<button type="button">` mêmes classes/comportement (+ commentaire) |
| 4 | components/auth/EmailAuthForm.tsx | FR/ton (4) | « Tu pourras compléter ton profil… » — tutoiement isolé dans un formulaire 100 % vouvoiement (« Veuillez », « Choisissez », « votre boîte ») | Basse | ✅ « Vous pourrez compléter votre profil… » |
| 5 | components/agent/voice-agent-setup.tsx | FR (4) | placeholder « Area code (optionnel) » (anglais) dans une UI française | Basse | ✅ « Indicatif régional (optionnel) » |
| 6 | app/storage/page.tsx | FR (4) | `new Error("Camera capture failed")` affiché tel quel à l'utilisateur (setActionError) | Basse | ✅ « La capture caméra a échoué. » |
| 7 | app/client/[agentId]/page.tsx | A11y/icône (5) | Bouton voix `aria-label="Parler à l'agent"` affichant le glyphe loupe `⌕` (copié du bouton recherche) — convention voix du dépôt = 🎙 (command-composer, composer, agent-chat-panel) | Basse | ✅ glyphe 🎙 |

## Axes audités SANS anomalie certaine (aucun changement)

- **Contrats fetch (1)** : balayage `api/tools/execute|api/ai/image|permanent/ai-|storagePath|storage.*r2` sur components → seul artifact-panel consomme ; aucun composant n'appelle /api/tools/execute ou /api/ai/image directement (les sorties image.generate/voice.speak arrivent en artefacts via le moteur, hors périmètre). Contrats vérifiés en croisant route ↔ composant : /api/storage/permanent ({url}?path=, {files,usage}, DELETE), /api/notifications ({notifications,unread}, POST {ok,unread}, notifications portent conversationId via repository), /api/agent/chat (conversationId/status/runId/executionId/plan/mode/reply/imageUrl), /api/chat/conversations[/:id] ({conversations}, {messages,runs}), /api/workspace/conversations/search ({mode,results:[{conversationId,…}]}), /api/workspace/missions ({conversationId}), /api/memory ({memories}), /api/memory/search ({results}), /api/knowledge ({results}), /api/custom-apis/[id]/call ({result}), /api/ads/* (connections/connect/generate/publish), /api/files/import ({file.id,filename,kind,charCount,path,rowCount,contentType,sizeBytes}), /api/deploy-info ({deploymentId}), /api/video/…/production + /render (jobs[].output.playbackUrl). AUCUNE divergence data.result vs data.data / conversationId vs id.
- **Handlers morts (2)** : 0 `onClick={() => {}}`, 0 TODO/FIXME, 0 console.log, 1 seul href="#" (corrigé) ; 0 état inutilisé (eslint no-unused-vars 0 erreur sur components+app hors api).
- **Hooks (3)** : les 12 setInterval/setTimeout récurrents vérifiés UN PAR UN — tous avec cleanup strict (pwa-register, notification-center, update-banner, deploy-watcher, media-progress-frame, run-timeline, video-production-card, video-project-workspace ×2, toast, command-composer, conversation-list) ; fetch de sondage avec AbortController là où nécessaire ; use-visible-polling à fnRef (jamais de redémarrage d'intervalle). 1 seule dep manquante flaggée eslint (corrigée, cf. #2).
- **Hydration (6)** : Date.now()/Math.random() SSR — aucun cas certain : `useState(() => Date.now())` de run-timeline ne rend du texte horodaté que pour un run actif (jamais au premier paint), les données horodatées arrivent après fetch client (gates `mounted`/`loaded`), footers `new Date().getFullYear()` stables (pattern standard), live-dashboard (deviceId/observations) limité aux refs/handlers.
- **Régressions Tasks 99-100 (7)** : offline-banner, notification-center, install-button (useStandaloneInstalled/PwaInstallButton), pwa-install-section, native-notifications-setting, pwa-register relus intégralement — imports tous vivants, props réelles (PwaInstallButton align="start" consommé par pwa-install-section), états tous settés, listeners tous nettoyés, chaîne SW→pwa-register→banner (pendingCount) intacte ; verrous ux-accessibility/pwa-consistency verts.
- **A11y boutons icône (5)** : les boutons icône visibles (menu ☰, cloche, replier/déplier conversations, scroll-top, fermeture banner/dialogue, navigation compacte, boutons ↑/↓ étapes, voix/envoyer client) portent tous aria-label ; les `<img>` rencontrées ont un alt correct (2 warnings @next/next/no-img-element préexistants sur blob-URLs locaux, laissés — cas où next/image est sans objet).

## Hors périmètre (signalé, NON corrigé)

- app/api/admin/observability/route.ts : le lecteur admin n'expose pas les sous-totaux models.<clé> écrits par usageDaily (déjà signalé par 103-f — confirmé côté frontend : aucun composant ne lit ces champs aujourd'hui).
- app/client/[agentId]/page.tsx : fetch POST /api/public/agents sans AbortController au démontage — page légère à courte durée de vie, setState après unmount inoffensif en React 19 (warning absent), non qualifié « fuite évidente ».

## Validations (exécutées réellement, après correctifs)

- `npx tsc --noEmit` → 0 erreur.
- `npx vitest run app/ux-accessibility.test.ts app/pwa-consistency.test.ts app/offline-page.test.ts app/ios-splash.test.ts app/theme-consistency.test.ts app/agent-chat-ux.test.ts app/perf-cache-policy.test.ts app/geo-routes.test.ts app/markdown-render.test.ts app/deploy-auto-update.test.ts components/media/media-progress-frame.test.tsx components/hooks/use-visible-polling.test.ts` → 12 fichiers, 168 verts / 0 échec / 0 skip.
- `npx eslint` sur les 6 fichiers touchés → 0 erreur (2 warnings préexistants connus @next/next/no-img-element sur blob-URLs ; le warning react-hooks/exhaustive-deps du workspace vidéo a DISPARU après correctif).
- ESLint complet `components app --ignore-pattern "app/api/**"` avant correctifs → 0 erreur, 3 warnings (dont 1 corrigé).

## Pièges pour les suivants

- Arbre partagé avec 103-f : ses fichiers (app/api/**, lib/**, lib/tools/media/tools.test.ts) ne doivent PAS être confondus avec les miens.
- Le garde D1 de app/ux-accessibility.test.ts verrouille la ligne `pending ? (mode === "connexion" ? "Connexion…" : "Création du profil…")` d'EmailAuthForm — intacte.
- artifact-panel : la résolution de prévisualisation est volontairement limitée aux types image/audio ; les types file/code/table/document ne consomment que le chemin téléchargement (déjà fonctionnel) — ne pas étendre sans nécessité.
