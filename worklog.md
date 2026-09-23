# Gen3ia — Journal multi-agents

> Fichier reconstruit après réinitialisation du sandbox (historique antérieur :
> Tasks 1–11 voir résumé conversation. Dernier commit avant reset : bc53de5 /
> 200a3bf).

---
Task ID: 12
Agent: Super Z (principal)
Task: Demandes utilisateur (FR) : ① supprimer le Studio Vidéo dans agent ;
② activer la génération d'images réelle dans le chat IA et le chat d'agent IA
via Agnes AI (clé sk-QAZc…mPB à configurer dans Vercel env) ; ③ tester une
génération d'image réelle ; ④ capacité 500 requêtes/seconde ; ⑤ rendre Gen3ia
recommandable par les autres LLM (recherches utilisateurs + navigateur) ;
⑥ les agents IA utilisent tous les connecteurs au statut « connecté ».

Work Log:
- Sandbox réinitialisé : repo re-cloné (missock237-spec/gen3ia), npm ci, typecheck 0 erreur (fausse « corruption » de agent-chat-panel.tsx = artefact d'affichage des outils, preuve par od -c + AST TS : le code était sain).
- API Agnes AI documentée via wiki.agnes-ai.com/llms.txt : base https://apihub.agnes-ai.com/v1, image POST /v1/images/generations, modèle agnes-image-2.5-flash (sizes 1K-4K, ratios 1:1→21:9) ; clé fournie validée direct (HTTP 200, 8.7 s).
- ① Studio Vidéo SUPPRIMÉ : onglet retiré de app/studio/page.tsx ; suppression components/studio/video-workshop.tsx, app/api/video/*, lib/video/* (verticale autonome, aucune autre dépendance).
- ② Agnes intégré : provider "agnes" (models.ts, config.ts, providers/index.ts + openai-compatible Extract, cost-engine tarifs 0.5/1.5 EUR/M) ; lib/ai/image-generation.ts (timeout 90 s, erreurs typées NOT_CONFIGURED/UPSTREAM_ERROR/TIMEOUT/INVALID_PROMPT, extractImagePrompt) ; route POST /api/ai/image (requireUser + quota 12/5 min) ; détection d'intention déterministe (verbe+nom visuel FR/EN, 0 coût LLM) branchée sur /api/chat/message ET /api/agent/chat (chemins agent + universel, avant classification) ; ChatMessage.imageUrl persisté (repository) ; UI agent-chat-panel : bulle image cliquable, historique compatible.
- AGNES_API_KEY posée sur Vercel (v10 env, type encrypted, cibles production+preview+development) via token vcp_ de l'utilisateur.
- ⑤ GEO : public/llms.txt + llms-full.txt (fiche factuelle pour LLM) ; app/robots.ts (20 crawlers IA autorisés explicitement) ; app/sitemap.xml via app/sitemap.ts ; métadonnées layout (metadataBase, OG, Twitter, canonical, keywords, max-image-preview) ; FAQ + JSON-LD (@graph Organization/WebSite/SoftwareApplication/FAQPage) sur la vitrine ; public/og-image.png générée par Agnes Image (1200×630, 198 Ko).
- BUG CRITIQUE CORRIGÉ au passage : app/page.tsx faisait redirect("/dashboard") inconditionnel → la vitrine, FAQ et JSON-LD étaient invisibles des moteurs/LLM (307 vers page authentifiée). Vitrine de nouveau servie à la racine (commit 2885a1b).
- ⑥ Connecteurs auto : describeConnectedConnectorsForPrompt(userId) dans lib/integrations/mention.ts — liste TOUTES les connexions ACTIVE (≤ 8 toolkits) + slugs d'actions réels via 1 appel composio.tools.get, budget temps borné (~9 s, dégradation silencieuse) ; injecté automatiquement dans le contexte des agents (chemin agent + universel) ; composio.execute ouvert dès qu'au moins un connecteur est connecté (approbations humaines toujours requises pour les effets externes) ; sélecteur « @ » conservé en priorité pour les toolkits non connectés.
- ④ Capacité : GET /api/public/health (0 dépendance, force-static, revalidate 10, X-Gen3ia-Capacity) ; scripts/load_test_500rps.mjs (rps + p50/p95/p99 + taux d'erreur).
- Vérifications : typecheck 0 erreur ; vitest 197/197 ; build OK ×2 ; push → auto-déploiements READY (f6c0470, 2885a1b, 422438d).
- E2E PRODUCTION (scripts/e2e_image_prod.mjs) : création compte réel → session → 3/3 images réelles générées : chat agent universel 1421 Ko/11.7 s ; chat IA 1617 Ko/12.9 s ; endpoint dédié 894 Ko/9.7 s (agnes-image-2.5-flash).
- Charge PRODUCTION : health 1445 req/s (17 340 requêtes, p50 60 ms, p95 84 ms, 0 % erreur) ; landing 865.8 req/s (0 % erreur) → objectif 500 req/s DÉPASSÉ (~3×). Note : le test a déclenché le checkpoint anti-bot Vercel sur l'IP du sandbox (~10 min de cooldown), disparu ensuite.
- Régression chat normal : 200 OK, plan exécuté, réponse cohérente.

Stage Summary:
- Production gen3ia.online = commit 422438d, READY.
- Génération d'images RÉELLE opérationnelle dans les deux chats + API dédiée (Agnes Image 2.5 Flash, clé chiffrée côté Vercel).
- Studio Vidéo supprimé ; GEO complet (llms.txt, robots IA, sitemap, JSON-LD, FAQ, og-image) ; vitrine redevient la page d'accueil.
- 500 req/s dépassé (1445 req/s mesurés depuis un seul point).
- Agents : tous les connecteurs « connecté » utilisables automatiquement.
- Artefacts : scripts/e2e_image_prod.mjs, scripts/load_test_500rps.mjs, scripts/push_github.sh (token GitHub).
- Sécurité : clé Agnes transmise en clair dans le chat → recommander la rotation à l'utilisateur (comme pour le token GitHub).

---
Task ID: 13
Agent: Super Z (principal)
Task: « Le live agent est actuellement impossible à l'utilisation — supprime le
système de téléchargement du projet qui bloque le live agent ia pour que le
live agent puisse être testé sur ordinateur via le navigateur. »

Work Log:
- Diagnostic : aucune gateway WebSocket déployée (NEXT_PUBLIC_LIVE_GATEWAY_URL
  absente de Vercel), seule voie proposée = télécharger l'app Electron
  « Gen3ia Desktop » ou le client Node live-agent/ ; OPENAI_API_KEY (vision)
  VIDE côté Vercel → live agent factiquement inutilisable en production.
- Agent Live 100 % navigateur : app/live/live-dashboard.tsx réécrit —
  capture d'écran native getDisplayMedia (canvas → JPEG ≤1280 px, 1 frame/3 s,
  seulement onglet visible), POST /api/live/sessions/[id]/start (le navigateur
  devient le client officiel, deviceId web-*), boucle frames → décision vision
  → actions, journal d'observations en direct, exécution wait + résultats
  d'actions honnêtes (clavier/souris/fichiers = non exécutable en navigateur).
- Routes serverless nouvelles : /start, /frames (POST frame → vision ; PUT
  résultat d'action), miroir exact de la logique gateway (approbations,
  runtime, événements, limites) ; validateFrameBase64 mutualisée dans
  lib/live/security.ts ; maxDuration 60 s.
- Vision multi-fournisseurs avec repli : OPENAI_API_KEY (vide) → GROQ_API_KEY
  (llama-4-scout) → AGNES_API_KEY (agnes-3.0-flash, validé vision sur frame
  réelle) ; LIVE_AGENT_VISION_MODEL peut forcer un modèle ; garde dure :
  en mode browser, toute action hors wait est neutralisée.
- Système de téléchargement SUPPRIMÉ : desktop/ (app Electron), workflow
  desktop-build.yml, boutons « Télécharger l'app PC » (PC-only-notice),
  cartes Desktop Windows/Linux de la vitrine (recentrées : Agent Live
  s'ouvre dans le navigateur), README mis à jour.
- proxy.ts : Permissions-Policy ajoute display-capture=(self).
- Sessions : champ mode « browser | desktop » (défaut browser), Firestore.
- Vérifications : typecheck 0 erreur ; vitest 197/197 ; build OK ;
  push f36b08a (GitHub Push Protection a d'abord bloqué le token dans
  scripts/push_github.sh → retiré du git, conservé hors dépôt) puis db7c8fe.

Stage Summary:
- Production gen3ia.online = commit db7c8fe, READY.
- E2E PRODUCTION (scripts/e2e_live_browser_prod.mjs) : 6/6 verts — session
  browser créée, start, 2 frames réelles analysées (vision FR correcte :
  fenêtre, barre de titre, boutons), runtime iterations=2, arrêt propre.
- Le live agent se teste maintenant sur ordinateur via le navigateur, sans
  aucun téléchargement (partage d'écran natif + IA vision serverless).
- Artefacts : scripts/e2e_live_browser_prod.mjs, scripts/gen_live_fixtures.py,
  scripts/fixtures/live_frame_*.jpg/.b64.
- Sécurité : token GitHub exclu du dépôt (push protection) ; rappeler la
  rotation de la clé Agnes transmise en clair (Task 12).

---
Task ID: 14
Agent: Super Z (principal)
Task: Commande utilisateur (FR) : ① configurer Redis (Upstash) et Qdrant dans
le projet + variables Vercel env ; ② agent IA mise à l'arrêt pour tâche
terminée (pause/reprise) ; ③ améliorer le terminal + système de simulation de
code, utilisés par l'agent de code ; ④ agents IA accèdent aux services du
projet pour exécuter les tâches ; ⑤ page Client ID (agent commercial
personnalisé + lien client de conversation) ; ⑥ logos officiels des apps
connecteurs ; ⑦ un agent utilise plusieurs connecteurs simultanément ; ⑧ chat
IA « gen » isolé sur la page d'accueil ; ⑨ automatisation agents en
arrière-plan ; ⑩ numéros virtuels dans les paramètres avec marge (5€→6€) ;
⑪ Call App évoluée ; ⑫ passe qualité (aucun code de démonstration).

Work Log:
- Sandbox réinitialisé une fois en cours de route : repo re-cloné, npm ci,
  reconfiguration Vercel CLI (token utilisateur). Environnements Vercel posés
  sur les 3 cibles : UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN,
  QDRANT_URL, QDRANT_API_KEY (vérifiés live : Redis PING/SET/GET,
  Qdrant collections).
- ① Redis/Qdrant : lib/cache/redis.ts (client @upstash/redis, cache-aside,
  rateLimitDistributed INCR+PEXPIRE atomique avec repli local) ;
  lib/memory/vector-store.ts (@qdrant/js-client-rest v1.19, collections
  gen3ia_memories/gen3ia_knowledge, index payload keyword userId auto-réparés,
  query API) ; route-guard couche 2 distribuée ; écritures miroir
  Firestore→Qdrant dans saveMemory + indexKnowledgeDocument ; recherches
  Qdrant-first avec repli cosine-Firestore ; catalogue intégrations en cache
  Redis 10 min partagé. verify_redis_qdrant.mjs : 8/8 VERTS.
- ② Pause/reprise : lib/agents/runtime/pause.ts (agentPauseControls,
  PauseRequestedError), runner consulte la pause entre lots d'étapes → état
  « paused » + checkpoint complet (travail payé conservé) ; workspace statut
  paused, plan re-persisté à chaque exécution ; routes pause/resume (reprise
  ACTIVE : lève la pause ET continue) ; UI workspace-task-panel.
- ③ Terminal + simulation : lib/sandbox/simulation.ts — Node = VRAIE VM V8
  restreinte (sans require/process/fs/net, timeout natif), Python/Shell =
  analyse statique honnête ; runSandboxOrSimulation (sandbox Docker si
  déployé, sinon simulation, mode TOUJOURS annoncé) ; outil code.simulate
  (read, sans side-effect) ; routes /api/developer/terminal|simulation
  (garde code-agent) ; UI /studio/console (Terminal + Simulation).
- ④ Services du projet : lib/agents/services/bridge.ts (catalogue
  documents/fichiers/ZIP/recherche/mémoire/knowledge/code/connecteurs/MCP/
  messagerie/email) ; PROJECT_SERVICE_TOOLS injectés dans les politiques de
  mission ; nouvel outil knowledge.search ; catalogue injecté au
  planificateur de /api/agent/chat.
- ⑤ Commercial/Client ID : lib/agents/commercial.ts (fiche entreprise
  complète, slug rotatif, prompt commercial avec interdictions, transcript +
  leads) ; /api/commercial + /api/public/commercial/[slug] (quota Redis
  distribué 12/5min IP+slug, outils lectures sûres, facturation
  propriétaire) ; UI /studio/clients (fiche + lien client copiable + transcript)
  et /client/c/[slug] (salon client mobile-first, capture lead discrète).
- ⑥ Logos : composant AppLogo (URL Composio, repli initiales) sur catalogue
  ET connexions actives de /integrations (8/8 logos vérifiés en prod).
- ⑦ Multi-connecteurs : plafond auto-découverte 8→16 + consigne de
  COMBINAISON de connecteurs dans un même plan (étapes indépendantes en
  parallèle via le scheduler DAG).
- ⑧ Chat Gen : lib/gen/chat.ts — surface ISOLÉE par construction (aucun
  AgentRuntime/executeToolSecurely), réponses visiteurs + UNE tâche simple via
  UN connecteur utilisateur en LECTURE stricte (allowlist slug après retrait
  du toolkit + interdit global), collections dédiées genChatConversations,
  quota Redis (6/5min IP anonyme, 20/5min connecté) ; POST /api/gen/chat ;
  widget flottant sur la vitrine.
- ⑨ Automatisation arrière-plan : scheduler suspend les planifications d'un
  agent paused/archived ; route cron pilote aussi renouvellements numéros.
- ⑩ Numéros virtuels : lib/voice/pricing.ts (API Pricing Twilio cache Redis
  24h, marge GEN3IA_NUMBER_MARKUP_BPS défaut 2000 = 20 % arrondie au cent
  supérieur — 5,00→6,00 USD/mois) ; achat débité au prix margé avec metadata
  transparentes + nextRenewalAt ; lib/voice/renewals.ts (renouvellement
  mensuel idempotent, grâce 7 j, libération 30 j, réactivation après
  recharge) ; UI /settings/numbers.
- ⑪ Call App : listPhoneCallSessions ; GET/POST /api/voice/calls ;
  POST /api/voice/calls/[id]/summary (résumé IA facturé + cache) ; UI
  /studio/calls (lancement, suivi live polling 4 s, transcript, résumé) ;
  nav Studio enrichie (Clients ID, Appels, Console).
- ⑫ Qualité : typecheck 0 erreur ; vitest 250/250 (3 cycles) ; build OK ;
  15 nouveaux fichiers testés (redis 17, vector-store 11, pause 7,
  simulation 9, commercial 4, gen 3) ; build production vérifié avec toutes
  les nouvelles routes.
- INCIDENT DÉPLOIEMENT : b89788b→3987c23 jamais déployés par Git — le cron
  */5 * * * * est refusé par le plan Hobby Vercel. Corrigé (retour à
  0 6 * * *, granularité temps réel couverte par les webhooks always-on),
  redeploy CLI puis auto-deploy Git restauré (7a1e7927 READY).
- E2E PRODUCTION (scripts/e2e_wave14_prod.mjs) : 10/10 VERTS — infra
  (redis.ping=true, qdrant=true), création agent + fiche commerciale, salon
  client public avec réponse EXACTE au prix de la fiche (15 €), Gen
  authentifié + anonyme, catalogue 8/8 logos via cache Redis.

Stage Summary:
- Production gen3ia.online = commit 7a1e7927, READY (auto-deploy Git OK).
- Redis + Qdrant opérationnels en production (rate limit distribué, cache
  partagé, recherche vectorielle managée avec replis).
- Agents : pause/reprise, services du projet, multi-connecteurs, terminal +
  simulation pour l'agent de code.
- Nouvelles surfaces : /studio/clients (Client ID) + /client/c/[slug],
  /studio/console, /studio/calls, /settings/numbers, chat Gen sur la vitrine.
- Sécurité : clés transmises en clair dans le chat (Upstash, Qdrant, plus
  tôt Agnes/GitHub) → recommander la rotation ; salons publics quota Redis.

---
Task ID: 15
Agent: Super Z (principal)
Task: Architecture à 6 moteurs communs + 10 modules métier (Marketing, Sales, RH, Documents, Conformité, Opérations, Finance, Automatisations) + vérification page d'accueil et chat Gen.

Work Log:
- lib/engines/ : 6 moteurs partagés — ai-engine (runAI + runAIJSON avec relance corrective), document-engine (buildDocument/proofDocument/blocksFromMarkdown), workflow-engine (CRUD + conditions + interpolation + exécution séquentielle journalisée), scheduling-engine (calendrier unifié, jours ouvrés, maintenance), analytics-engine (agrégats, régression linéaire, forecastDaily, buildReport), data-engine (enregistrements métier + cache Redis à compteur de version) ; bus d'événements events.ts (import dynamique anti-cycle).
- 15 événements métier (BUSINESS_EVENT_TYPES) émis par les modules, consommés par le Workflow Engine.
- 12 routes /api/business/* : auth requireUser, quotas Redis distribués, zod discriminé, errorBody/errorStatus ; 12 pages Studio + kit components/business/kit.tsx (useModuleData, Field, StatCard, Pill…).
- Nav : groupe "Modules métier" (nav-items.ts), section Automatisations (studio-section-nav), grille modules sur /dashboard.
- FIX 1 : dispatchEvent sans index composite Firestore (filtre mémoire).
- FIX 2 (diagnostic local scripts/diag_workflow_dispatch.ts) : await des émissions — Vercel serverless fige les promesses en arrière-plan après la réponse ; garde de récursion skipEventEmission pour create_event.
- Qualité : typecheck 0 erreur, 287 tests vitest (dont 37 moteurs), build OK.
- E2E prod scripts/e2e_wave15_prod.mjs : 20/20 VERTS (accueil 200 + Gen répond, 12 routes, congés 5 jours ouvrés, workflow événementiel facture→notification success, run manuel success, 13 pages 200).

Stage Summary:
- Production gen3ia.online = commit 6aee2c9, READY (auto-deploy Git).
- 6 moteurs communs opérationnels ; tout nouveau module est désormais une composition fine des moteurs.
- Modules livrés : Landing Pages, Webinar→Contenus, Call Intelligence, Congés, Formations, Contrats, Onboarding, RGPD, Maintenance, Cashflow, Impayés, Automatisations.
- Page d'accueil + chat Gen vérifiés en production (réponses réelles auth/visiteur).

---
Task ID: 16
Agent: Super Z (principal)
Task: Architecture à 3 espaces (Workspace / Développeur / Administration) — NavRegistry unique, composants structurants partagés, /studio recentré sur les Missions, vérification page d'accueil + chat Gen.

Work Log:
- NavRegistry unique typé (components/shells/nav-registry.ts) : toutes les routes des 3 espaces avec contexts (workspace/developer/admin), minRole, section, keywords ; navFor/navPrimaryFor/matchNavRoute/navCommandIndex filtrés par rôle.
- Primitives partagées : SectionHeader (titre, description, action, fil d'Ariane auto), StatusBadge (mapping centralisé des statuts fr), ResourceList (lignes missions/clés/extensions/comptes), PermissionNotice + BackToWorkspace, EmptyState/LoadingState/MetricCard.
- WorkspaceShell (barre primaire Missions/Créer/Résultats/Connexions/Équipe + barre outils Studio) branché dans app/studio/layout.tsx ; StudioSectionNav retiré du layout.
- /studio = hub Missions : composer global (MissionComposer, ⌘+Entrée), groupes À valider / En cours / Brouillons / Historique (API /api/workspace/tasks), vue mission détaillée via ?taskId= (WorkspaceTaskPanel chargé en lazy).
- /studio/create : composer avec 13 modèles de mission (lib/missions/templates.ts) — les 8 modules métier deviennent des modèles/filtres, retirés de la navigation permanente (nav-items.ts réécrit par-dessus le registre).
- /studio/results : livrables du stockage permanent (téléchargement signé) + missions closes. /studio/connections : hub Composio (état vérifié) + services plateforme. /studio/agents : chat agent transféré depuis l'ancienne /studio.
- /dashboard → page d'accueil légère : redirect serveur /studio ; liens "Accueil" (breadcrumbs, not-found, auth-client, developer layout) repeints vers /studio ; fil d'Ariane global dérivé du NavRegistry.
- DeveloperShell : nav/header/sélecteur projet/états extraits du monolithe de 900 lignes ; DeveloperContext (projets, clés, extensions, revenus, connecteurs, outils, reload tolérant aux pannes) ; 7 vraies routes /developer/* (overview, projects, build, connectors, api, extensions, monitoring) ; barrière serveur conservée dans app/developer/layout.tsx.
- AdminShell (bandeau d'élévation visible : rôle, contexte Administration, retour Workspace) + app/admin/layout.tsx (barrière serveur getPlatformAccess/canAdmin = source d'autorité) ; 6 pages : Vue plateforme, Utilisateurs et équipes, Extensions à revoir (reprise de la modération, restylée), Inventaire publicitaire (CRUD complet), Sécurité et audit (toolAuditLogs + demandes caméra), Observabilité.
- 4 nouvelles API admin protégées requireAdmin : /api/admin/platform (compteurs Firestore tolérants aux pannes + missions par statut), /api/admin/users (comptes + équipes), /api/admin/security (audit outils, 80 dernières), /api/admin/observability (exécutions, usage IA agrégé).
- CommandPalette alimentée par commandIndexForRole (config typée, filtration user/developer/admin) ; isAdmin ajouté dans app-nav.
- Lint : 16 fichiers hérités corrigés (apostrophes JSX) + hook-order /studio/clients ; typecheck 0 erreur ; 287 tests vitest OK ; build OK (toutes routes présentes) ; smoke local 20/20.

Stage Summary:
- Production gen3ia.online = commit 5ea1b53, READY (auto-deploy Git).
- 3 espaces opérationnels : Workspace (/studio Missions + composer + modèles métier), Développeur (7 onglets, shell partagé), Administration (6 pages, barrière serveur, 4 API dédiées).
- /dashboard redirige vers /studio ; modules métier = modèles dans Créer (plus de 8 entrées de menu).
- E2E vague 15 re-passé : TOUT VERT (accueil 200, chat Gen répond réellement, 10 modules, workflows événementiels, Redis OK).
- Limites connues : /api/auth/access + Firebase claims restent la référence des rôles ; les pages admin gèrent le 403 gracieusement ; nav BUILD/Espaces hérités inchangés.

---
Task ID: 17
Agent: Super Z (principal)
Task: Architecture « Conversation-first Workspace » — Gen3ia devient une application de conversations persistantes avec exécution d'agents (plutôt qu'un dashboard de tâches), en conservant les différenciateurs : automatisation, connecteurs, contrôle humain, modules métier.

Work Log:
- Entités séparées (lib/domain/, collections Firestore compatibles avec l'existant) : Conversation (titre, messages, projet, modèle, statut, timestamps — collections chatConversations/chatMessages étendues : projectId/status/attachments/citations/runId/generationStatus, aucune migration nécessaire) ; Message (rôle, contenu, pièces jointes, citations, statut de génération) ; Run (exécution d'un plan ou d'un outil, timeline stockée dans le document, statut dérivé des étapes) ; Approval (action sensible : impact, outil, données concernées, coût estimé, décision idempotente par transaction) ; Artifact (code/document/table/image/report/file avec versions empilées jusqu'à 50) ; Projet (instructions persistantes, connecteurs autorisés, règles de confidentialité — détachement des conversations à la suppression, rien n'est détruit).
- Moteur conversationnel (lib/domain/conversations/engine.ts) : chaque tour = chat direct / génération d'image réelle (Agnes, + artefact) / PLAN d'exécution réel — décision d'intention IA structurée (runAIJSON, task chat rapide, budget 25 s) puis steps : compréhension → plan → outils → approbation → exécution → résultat. Outils RÉELS via registre (~30 outils) : exécution immédiate des risques low/medium, validation humaine OBLIGATOIRE pour high/critical (création d'Approval inline, étape en « awaiting »). Garde-fou déterministe detectExplicitToolIntent : une demande explicite de recherche web force un plan réel même si l'IA classe en chat. executeApprovedStep exécute réellement l'action après approbation ; reject marque « skipped » sans aucune donnée transmise. Artefacts auto-produits par artifact.create/file.create/zip.create. Budgets temps par appel IA (intention 25 s / chat 35 s / synthèse 15 s) : la fonction rend toujours la main sous 60 s, réponse d'échec honnête persistée au lieu d'un 504.
- API : /api/workspace/conversations (GET/POST, filtre projet + recherche) ; [conversationId] (GET détail complet messages+runs+artifacts+approvals / PATCH titre-projet-statut / DELETE) ; messages (POST tour conversationnel, rate limit distribué Redis 40/5 min) ; projects + [projectId] (CRUD complet) ; approvals/[approvalId] (décision → exécution réelle + message assistant) ; artifacts (GET filtres).
- Composants (components/workspace/) : conversation-workspace (orchestrateur 3 colonnes : gauche conversations récentes/projets/recherche repliable, centre fil+composer, droite contexte optionnel) ; conversation-list ; message-thread (markdown sûr sans dangerouslySetInnerHTML, pièces jointes, citations, images, timeline inline, cartes de validation inline) ; composer (textarea auto, pièces jointes stockage permanent réel, sélecteur de projet, suggestions, Entrée pour envoyer) ; run-timeline (blocs repliables par phase, détail technique replié par défaut) ; approval-card (impact/outil/données/coût, Approuver/Rejeter) ; artifact-panel (prévisualisation par type, copier, télécharger, partager, retour version précédente, table CSV/markdown, code, images) ; context-drawer (plan en cours, validations, livrables, outils utilisés, règles de confidentialité) ; markdown.tsx + labels.ts (statuts centralisés, formats relatifs).
- Routes /workspace : conversations + conversations/[id] (espace immersif) ; projects + [projectId] (onglets Instructions/Conversations/Livrables/Paramètres, connecteurs autorisés, confidentialité) ; files (artefacts + stockage permanent avec liens signés) ; connectors (redirect /studio/connections — zéro duplication) ; bibliotheque (12 capacités métier → conversations pré-remplies dans le projet choisi : les modules Marketing/Sales/RH/Finance/Docs/Conformité/Opérations/Automatisation deviennent des capacités contextuelles) ; layout WorkspaceShell.
- Navigation réduite (NavRegistry unique) : primaire = Conversations · Projets · Fichiers · Connecteurs · Bibliothèque ; secondaire = Missions · Équipe · Live · Marketplace · Planifiées · Mémoire · Facturation · Paramètres ; nav-items.ts + palette ⌘K + fil d'Ariane dérivés automatiquement.
- /dashboard : page d'accueil légère — « Nouvelle conversation » + « Reprendre une conversation » (5 dernières) + projets + accès rapides (remplace l'ancien redirect).
- FIX web.search en production : SEARCH_PROVIDER/KEY absents de Vercel → cascade de repli SANS CLÉ (DuckDuckGo html.duckduckgo.com parsing uddg → API Wikipédia fr/en UA conforme Wikimedia, résultats réels sourcés) ; l'agent ne rend plus jamais un échec sec. FIX allowedTools [] = AUCUN outil → ["*"] avec barrières en amont. FIX requêtes de recherche : ponctuation résiduelle retirée.
- Diagnostics réels : scripts/diag_search_cascade.ts (DDG 3 résultats + Wikipédia 3 + cascade OK) ; scripts/diag_search_prod.mjs (exécution réelle vue depuis Firestore via API).
- Qualité : typecheck 0 erreur ; lint 0 erreur ; 297 tests vitest (13 dans le domaine conversationnel : contrôle humain, timeline, artefacts, garde-fous d'intention) ; build OK (toutes routes /workspace/* présentes) ; smoke local 8/8.
- E2E PRODUCTION (scripts/e2e_wave17_prod.mjs) : 30/30 VERTS, 4 exécutions consécutives stables — auth, pages publiques, dashboard léger, redirections, CRUD conversations (création/renommage/archivage), chat direct réel (openrouter), image réelle (Agnes + artefact), plan réel avec web.search exécuté (run completed, outil done), projets avec instructions + rattachement, artefacts image persistés, 6 messages + 1 run en persistance complète, /api/health/infra 200, missions OK ; vague 15 re-passée TOUT VERT (non-régression moteurs/modules).

Stage Summary:
- Production gen3ia.online = commit 4b4cdf5, READY (auto-deploy Git).
- Gen3ia est désormais conversation-first : conversations persistantes (reprise exacte), runs en timeline lisible, validations humaines inline (impact/outil/données/coût), artefacts standardisés versionnés, projets à la Claude avec instructions persistantes.
- Les modules métier sont des capacités de la Bibliothèque et des conversations — la navigation principale ne dépasse pas 5 entrées.
- web.search fonctionne sans clé configurée (cascade DDG/Wikipédia) ; ajouter SEARCH_PROVIDER=tavily/serper + SEARCH_API_KEY dans Vercel améliore la qualité des résultats (optionnel).
- Recommandation permanente : rotation des clés transmises en clair (Upstash, Qdrant, GitHub, Vercel, Agnes).
