---
Task ID: 41
Agent: Super Z (principal)
Task: « Script de connexion Google AdSense — assurer que la connexion est
bien établie et fonctionnelle. API Supabase (URL + publishable key + JWKS).
Vérifier que TOUTES les API données jusqu'à présent sont fonctionnelles et
configurées dans le env Vercel. »

Work Log:
- SUPABASE VÉRIFIÉ EN DIRECT : URL teuxdanucpcurbokcomv.supabase.co —
  auth/v1/health avec publishable key → 200 (GoTrue v2.197.0, email activé) ;
  auth/v1/.well-known/jwks.json → 200 (clé ES256 servie) ; REST PostgREST
  → clé ACCEPTÉE mais PGRST205 : la table profiles n'existe pas → LES
  MIGRATIONS 0001/0002 NE SONT PAS APPLIQUÉES au projet distant (application
  impossible depuis le sandbox : nécessite SUPABASE_ACCESS_TOKEN ou mot de
  passe DB — action utilisateur).
- SENTRY VÉRIFIÉ EN DIRECT : token utilisateur → API Sentry 200 (org
  gen3ia active, projet javascript-nextjs, tous droits) ; DSN récupéré
  (3f648aff…@o4511820262473728.ingest.de.sentry.io/4511820405276752) ;
  clé client isActive=true sans rate-limit ; ingestion réelle d'un
  événement test → HTTP 200 + accusé officiel {"id":"<event_id>"}. Les
  endpoints events/issues/stats restent à 0 plusieurs minutes après
  (latence d'indexation projet neuf OU soft-quota plan gratuit — l'ack
  d'ingestion est la preuve d'acceptation du DSN ; la preuve end-to-end
  sera la production réelle après déploiement).
- ADSENSE VÉRIFIÉ EN DIRECT : loader adsbygoogle.js?client=ca-pub-716856…→
  200 (207 Ko). CONNEXION RENDUE ÉTABLIE : le composant AdSenseAd (Task 40)
  exigeait un slot pour rendre — le loader n'apparaissait donc JAMAIS dans
  le HTML et Google ne pouvait pas vérifier le site. FIX : snippet officiel
  (exactement celui fourni par l'utilisateur) servi SSR dans le <head> du
  layout racine, conditionné à NEXT_PUBLIC_ADSENSE_CLIENT ; loader du
  composant retiré (dédup, file window.adsbygoogle sûre dans les deux
  ordres) ; ads.txt déjà correct (pub-7168568074147796, DIRECT, f08c47fec0942fa0).
- SENTRY HOOK NAVIGATIONS : le build émettait « ACTION REQUIRED:
  onRouterTransitionStart ». FIX SANS coût bundle : hook exporté en
  délégation paresseuse depuis instrumentation-client.ts (window.__g3Sentry
  .ready → import dynamique cache-hit → captureRouterTransitionStart) —
  l'import statique officiel réintroduirait les +54 kB gzip éliminés en
  Task 40. Message ACTION REQUIRED disparu du build.
- ENV LOCALE : .env.local créé (gitignored) avec les valeurs réelles :
  NEXT_PUBLIC_SUPABASE_URL/ANON_KEY (publishable sb_publishable_…),
  SENTRY_DSN + NEXT_PUBLIC_SENTRY_DSN, NEXT_PUBLIC_ADSENSE_CLIENT.
  SENTRY_AUTH_TOKEN VOLONTAIREMENT ABSENT du build local : avec token,
  le pipeline source maps fait OOM-kill sur le sandbox 3.9 Go (vérifié) ;
  il sera renseigné côté Vercel (builders 8 Go+). SUPABASE_SERVICE_ROLE_KEY
  et NEXT_PUBLIC_ADSENSE_SLOT_HOME restent à fournir par l'utilisateur.
  DATA_BACKEND conservé = firebase (garde anti-oubli : service-role absent).
- VERCEL ENV : AUCUN token Vercel disponible dans le sandbox (vérifié :
  pas de .vercel/, pas d'auth CLI) → les variables ne peuvent pas être
  posées par API depuis ici. Liste exacte prête à coller fournie à
  l'utilisateur (message final) : SENTRY_DSN, NEXT_PUBLIC_SENTRY_DSN,
  SENTRY_AUTH_TOKEN, SENTRY_ORG/PROJECT/ENVIRONMENT,
  NEXT_PUBLIC_ADSENSE_CLIENT (+SLOT_HOME à créer), NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY (à fournir),
  DATA_BACKEND=firebase (jusqu'aux migrations).
- DÉPLOIEMENT : le commit Task 40 (e0079b8) n'était PAS poussé (origin à
  6304dff) — la production ne pouvait rien servir de tout ça. QA complète
  puis push 6304dff..cb63d50 → déploiement Vercel déclenché (Task 40 +
  Task 41 ensemble).
- QA : typecheck 0 ; lint 0 (fichiers modifiés) ; vitest 689 verts / 88
  fichiers ; budget bundle pire route 180 kB gzip (0 WARN — hook et head
  script gratuits) ; build prod local OK (compil 117 s ; typecheck intégré
  OOM sandbox — désactivé ponctuellement, tsc standalone vert, config
  restaurée) ; serveur prod local vérifié : snippet AdSense SSR servi,
  ads.txt 200, tunnel /monitoring GET 200 + enveloppe invalide 400, CSP
  pagead2 présente sans unsafe-eval.
- Commit : cb63d50 (layout.tsx + adsense-ad.tsx + instrumentation-client.ts).

Stage Summary:
- Les 3 API fournies sont VALIDÉES en direct : Supabase (auth 200, JWKS
  200, clé acceptée), Sentry (token 200, DSN actif, ingestion 200 + ack),
  AdSense (loader 200 + connexion ÉTABLIE par le snippet officiel SSR).
- Connexion AdSense réellement établie : le head de chaque page sert le
  snippet officiel — c'est ce que le robot AdSense lit pour valider
  gen3ia.online, avec /ads.txt. Slot manuel (SLOT_HOME) à créer dans la
  console si annonce vitrine manuelle voulue ; Auto Ads fonctionne sans.
- Production : push cb63d50 → Vercel déploie Task 40+41. Vérification
  finale gen3ia.online à la fin du déploiement (script verify_task40_prod).
- Actions utilisateur restantes : ① env Vercel (liste exacte fournie,
  dont SENTRY_AUTH_TOKEN = token Sentry fourni) ; ② SUPABASE_SERVICE_ROLE_KEY
  (dashboard → Settings → API) ; ③ application des migrations Supabase
  (dashboard SQL editor avec supabase/migrations/0001+0002, ou access
  token pour supabase db push) ; ④ slot AdSense vitrine (optionnel).

---
Task ID: 41-bis
Agent: Super Z (principal)
Task: « Voici un token Vercel — mets [les variables] dans les env Vercel. »

Work Log:
- SANDBOX RÉINITIALISÉ en cours de session (gen3ia/ disparu) : repo re-cloné
  (missock237-spec/gen3ia, public) à d24808b + npm ci. Tous les travaux
  distants intacts (GitHub + Vercel + Sentry). .env.local restauré.
- TOKEN VERCEL VALIDÉ : GET /v2/user → missock237-spec ; projet gen3ia
  trouvé (prj_1S2nU43JatLWyGTs87Dr4TZ7Tf0j) ; 136 variables existantes
  listées — SENTRY_AUTH_TOKEN déjà présent (non touché).
- UPSERT 9 VARIABLES (API v10, upsert=true, target production+preview,
  script scripts/vercel_env_upsert.mjs, token JAMAIS écrit dans un fichier) :
  NEXT_PUBLIC_ADSENSE_CLIENT=ca-pub-7168568074147796 ; SENTRY_DSN +
  NEXT_PUBLIC_SENTRY_DSN (DSN de.sentry.io) ; SENTRY_ORG=gen3ia ;
  SENTRY_PROJECT=javascript-nextjs ; SENTRY_ENVIRONMENT=production ;
  NEXT_PUBLIC_SUPABASE_URL=https://teuxdanucpcurbokcomv.supabase.co ;
  NEXT_PUBLIC_SUPABASE_ANON_KEY=sb_publishable_… ; DATA_BACKEND=firebase.
  Types "plain" (publics par conception, même modèle que les clés Firebase).
- REDÉPLOIEMENT API : POST /v13/deployments (gitSource main) →
  dpl_Hzst93NcAs2R4WFXPtH13oR4hfoq, BUILDING → READY (~6 min).
- VÉRIFICATION PRODUCTION FINALE : snippet officiel AdSense SERVI SSR dans
  le head de gen3ia.online (exact script utilisateur) ; ads.txt 200 ;
  tunnel /monitoring 200/400/403 ; CSP pagead2 sans unsafe-eval ;
  verify_task40_prod → 11/12 (seul ❌ = conteneur unité manuelle, attend
  NEXT_PUBLIC_ADSENSE_SLOT_HOME — slot à créer dans la console AdSense).
- SENTRY E2E CONFIRMÉ : lag d'indexation levé (~30 min) — l'événement test
  apparaît dans events ET issues ; 4 releases enregistrées (e0079b8,
  cb63d50, d24808b, gen3ia@d24808b) = preuve SENTRY_AUTH_TOKEN + upload
  source maps opérationnels ; SDK runtime armé (server + client + tunnel).
- Non créés (non fournis) : SUPABASE_SERVICE_ROLE_KEY (dashboard Supabase
  → Settings → API), NEXT_PUBLIC_ADSENSE_SLOT_HOME (console AdSense).

Stage Summary:
- Toutes les API fournies par l'utilisateur sont CONFIGURÉES DANS VERCEL
  ET FONCTIONNELLES EN PRODUCTION : AdSense (snippet live + ads.txt),
  Sentry (releases + source maps + DSN armé), Supabase (URL + clé posées).
- La connexion AdSense est ÉTABLIE : Google peut valider gen3ia.online
  (head + ads.txt) — clic « Vérifier »/« Demander un examen » côté console
  AdSense pour finaliser l'approbation du site.
- Restant (actions utilisateur) : ① SUPABASE_SERVICE_ROLE_KEY + migrations
  SQL (0001+0002) pour activer le backend Supabase ; ② slot AdSense
  (optionnel, unité manuelle vitrine) ; ③ quota Sentry à vérifier si le
  plan gratuit plafonne l'ingestion.

---
Task ID: 42
Agent: Super Z (principal)
Task: « 8 axes d'évolution IA (fenêtre de contexte, apprentissage continu
sûr, outils externes contrôlés, multimodal, raisonnement/planification,
mémoire long terme privée, alignement/anti-hallucination, élasticité) —
dans le cadre sécurité/confidentialité/politique Gen3ia. »

Work Log:
- AUDIT PRÉALABLE : inventaire des capacités EXISTANTES (auto-improvement
  run-leçons, tool-permissions + HITL, user-memory, RAG Qdrant, planner +
  critique d'actions, sandbox, micro-caches) — les 8 axes sont traités par
  EXTENSION ciblée des gaps réels, pas par reconstruction.
- AXE 1 (CONTEXTE) : lib/ai/context-window.ts — registre de fenêtres par
  modèle (Claude 200k, GPT-4.1 1M, GPT-4o/Llama3/GLM 128k, Gemini 1M,
  fallback 32k conservateur) ; clampOutputTokens dans les DEUX providers
  (jamais plus de sortie que fenêtre/2) ; compressHistory PUR et
  DÉTERMINISTE (récents verbatim + digest EXTRACTIF des anciens — zéro
  invention) ; assembleMessages branché dans chat-engine.answerAsAgent
  (remplace la troncature brutale aux 12 messages : l'historique ENTIER
  tient dans la fenêtre du modèle).
- AXE 2 (CONTINUAL LEARNING SÛR) : lib/ai/feedback.ts + POST
  /api/ai/feedback — retours 👍/👎 par (conversation, message) avec
  catégorie (hallucination/incorrect/incomplet/hors-sujet/style) ;
  PIPELINE DE VALIDATION : leçon « proposée » au 1er signal négatif →
  « active » au 2e (LESSON_ACTIVATION_THRESHOLD=2) — formulation
  DÉTERMINISTE (jamais générée par LLM) ; leçons actives injectées dans
  buildEvolutionContext (auto-amélioration Gen IA) ; rate-limit 60/h +
  garde anti-abus ; export/purge RGPD inclus.
- AXE 3 (OUTILS CONTRÔLÉS) : lib/security/tool-consents.ts + GET/PUT
  /api/settings/tool-consents — 4 catégories (external_apps,
  code_execution, camera, destructive) × modes ask|always|deny ; TROISIÈME
  couche d'autorisation branchée dans lib/tools/executor.executeTool
  (au-dessus des permissions, en dessous du HITL) ; « deny » bloque AVANT
  exécution ; « always » ne pré-approuve JAMAIS une écriture (garde
  permanente) ; cache TTL 30 s (0 latence ajoutée au chemin chaud) ;
  échec de lecture = jamais bloquant.
- AXE 4 (MULTIMODAL) : AIMessage.images (base64|URL) ; providers
  openai-compatible (parts image_url/data-URI, chemins normal + STREAMING)
  et anthropic (source base64|url) ; lib/ai/content-filter.ts — max 4
  images, 5 Mo binaire réel (décodage), formats png/jpeg/webp/gif, URLs
  https uniquement (anti-SSRF) ; validation centralisée dans router
  generate + generateStream (rejet uniforme avant sélection provider).
- AXE 5 (RAISONNEMENT) : lib/ai/planning.ts — boucle createPlan →
  critiquePlan (rôle LLM distinct, exigeant) → revisePlan (coût borné,
  maxRevisions≤2) ; schémas zod stricts côté code (le LLM ne décide pas
  de la forme) ; critique FINALE toujours renvoyée ; renderPlanForExecution
  pour injection orchestrateur (point d'extension documenté).
- AXE 6 (MÉMOIRE PRIVÉE) : lib/memory/privacy.ts + 3 routes — GET
  /api/memory/export (JSON portable en pièce jointe), POST /api/memory/purge
  (428 sans confirm:true ; double validation applicative), GET|POST
  /api/memory/consent (drapeau révocable ; défaut = comportement
  historique) ; purge = souvenirs + feedback + leçons + consentements +
  reset du drapeau.
- AXE 7 (ALIGNEMENT) : lib/ai/grounding.ts — buildGroundedContext (sources
  numérotées + consigne de citation), extractCitations, groundingReport
  (heuristique DÉTERMINISTE : phrases factuelles sans citation, citations
  hors plage, couverture), groundingWarning prêt à afficher — non bloquant,
  sans LLM, sans coût.
- AXE 8 (ÉLASTICITÉ) : lib/ai/resilience.ts — coupe-circuit par fournisseur
  (3 échecs → open, cooldown exponentiel 30 s→5 min, half-open à sonde
  unique) branché dans router.generate (skip des circuits ouverts SAUF si
  tous ouverts) ; getBreakerSnapshot pour l'observabilité ; cache
  d'embeddings LRU 500 entrées dans lib/memory/embeddings.ts (fonction
  déterministe — réindexations ne re-paient plus le réseau).
- QA : typecheck 0 ; lint 0 ; vitest 741 verts / 95 fichiers (+52 nouveaux
  : context-window 12, content-filter 7, grounding 9, resilience 7,
  planning 6, tool-consents 9, feedback 2) ; build OK (compiler, typecheck
  intégré OOM sandbox — tsc standalone vert, config restaurée) ; budget
  bundle pire route 180 kB gzip INCHANGÉ (0 ajout au chemin client — tout
  est serveur-seul).
- Commit : à suivre. Push → déploiement Vercel.

Stage Summary:
- Les 8 axes sont livrés en capacités RÉELLES et testées : fenêtre de
  contexte gérée par modèle avec compression sans invention ; boucle de
  feedback validée injectée dans l'auto-amélioration ; consentements
  outils par catégorie appliqués à l'exécution ; vision entrante avec
  filtre de contenu ; planification avec critique adversariale ; coffre
  mémoire RGPD (export/purge/consentement) ; ancrage anti-hallucination
  mesuré ; résilience multi-fournisseurs + cache embeddings.
- Conformité : zéro ajout au bundle client, tout serveur-seul ; aucune
  donnée conversationnelle persistée par les nouveaux modules ; HITL
  jamais contourné ; défauts = comportement historique (ask, consentement
  consenti, circuits fermés).

---
Task ID: 43
Agent: Super Z (principal)
Task: « Applique tes suggestions » — recommandations restantes applicables
au code : Rec 8a (accessibilité automatisée axe-core), Rec 7 P2
(double-écriture Firestore⇄Supabase), §3 observabilité (métriques par
organisation) ; vérification du déploiement production de la Task 42.

Work Log:
- DÉPLOIEMENT TASK 42 VÉRIFIÉ : dpl_Bjn7GaYZ94FyftmtEFGWGQyuixAK READY sur
  d8b27cd (production) ; sonde live health 200 / home 200 / tunnel 400
  (attendu, route vivante).
- REC 8a (A11Y) : scripts/a11y_prod.mjs — sonde Playwright + axe-core
  (WCAG 2.1 A/AA) sur les pages publiques (/ , /login), échec exit 1 sur
  toute violation critical/serious non allowlistée (allowlist vide et
  documentée). Premier scan production : 4 violations réelles trouvées.
  CORRECTIONS UI : ① toast.tsx — aria-label interdit sur conteneur sans
  role (axe aria-prohibited-attr) → suppression, l'annonce passe par les
  role="alert"/"status" enfants ; ② auth-aurora-aside.tsx — aside plus
  aria-hidden (axe aria-hidden-focus : contenait le lien retour accueil) ;
  ③ signature du panneau passée g3-faint→g3-muted (axe color-contrast :
  3,0:1 → 6,1:1 sur sky-hero, calcul WCAG vérifié scripté) ;
  ④ login/signup — textes discrets g3-faint→g3-muted (AA 4.5:1 atteint).
  Re-scan local : 0 violation sur / et /login. CI : nouveau job `a11y`
  hermétique (build + next start localhost + scan, fail sur critical/
  serious) ; script npm `check:a11y` (scan production à la demande).
- REC 7 P2 (DUAL-WRITE) : lib/db/dual-write.ts — miroir best-effort par
  DOMAINE (DUAL_WRITE_DOMAINS CSV, défaut vide = OFF), gardes triples
  (Supabase non configuré → OFF ; DATA_BACKEND=supabase → OFF ; domaine
  inconnu filtré), stats par domaine (attempted/ok/failed/lastError) pour
  /api/health/infra. lib/notifications/mirror.ts — réplication des 4
  écritures primales (create, markRead, markAllRead, markForApprovalRead)
  avec id Postgres DÉRIVÉ de l'id Firestore (uuid v5, espace de noms
  dédié) → miroir ET backfill IDEMPOTENTS sans migration_mapping (réservé
  aux domaines à uuid frais). Firestore reste la VÉRITÉ ; un échec de
  miroir ne bloque jamais le flux. scripts/backfill_supabase.ts — backfill
  notifications par lots (dry-run par défaut, --apply), reprise sûre,
  audit migration_mapping, checksums par utilisateur ; échec rapide avec
  instructions si SUPABASE_SERVICE_ROLE_KEY absente ; script npm
  `backfill:supabase` (NODE_OPTIONS --conditions=react-server pour tsx).
- OBSERVABILITÉ (§3 RESTE) : lib/observability/org-queries.ts — vue d'usage
  PAR ORGANISATION : membres → exécutions (requêtes `in` paginées par
  chunks de 30) → agrégation PURE (totaux, par agent/outils/jour) ;
  ExecutionSummary étendu agentId ; summarizeExecution exporté (zéro
  duplication). Route GET /api/observability/org?orgId= — requireUser +
  requireOrgContext (404 uniforme anti-énumération).
- QA : typecheck 0 ; lint 0 ; vitest 767 verts / 98 fichiers (+26) ;
  build production OK en sandbox (exit 0, sans OOM) ; budget bundle
  client inchangé (tout est serveur-seul).

Stage Summary:
- Accessibilité : 4 violations WCAG réelles corrigées dans l'UI et
  régression désormais impossible (scan axe-core bloquant en CI).
- Migration Supabase : la phase P2 est CODE-READY — inscrire
  DUAL_WRITE_DOMAINS=notifications dans Vercel (après application des
  migrations 0001/0002 et pose de SUPABASE_SERVICE_ROLE_KEY) active le
  miroir ; le backfill s'exécute avec `npm run backfill:supabase`.
- Observabilité : la dimension entreprise (usage par organisation) est
  disponible via /api/observability/org — base du dashboard Usage (LOT 12).
- Restant (actions utilisateur) : ① SUPABASE_SERVICE_ROLE_KEY + migrations
  SQL 0001/0002 → puis DUAL_WRITE_DOMAINS + backfill ; ② slot AdSense
  (optionnel) ; ③ Sentry Alerts (console) ; ④ i18n FR/EN (Rec 8b, chantier).

Task 44 — GEO complet + tranche i18n : le projet est désormais RECOMMANDABLE par les IA
- Objectif utilisateur : « fais en sorte que le projet soit recommandé par les IA pendant les recherches de leurs utilisateurs » + « continue avec tes suggestions » (tranche i18n Rec 8b).
- SOURCE UNIQUE : lib/geo/content.ts — FAQ FR (8 Q/R) + FAQ EN (8 Q/R) autosuffisantes, buildStructuredData(fr|en) (Organization, WebSite, SoftwareApplication, FAQPage), brandPitch. Toute surface publique importe d'ici : zéro dérive possible.
- PAGE /faq (nouvelle, statique) : FAQ dédiée URL stable, JSON-LD FAQPage + BreadcrumbList, fil d'Ariane, CTA signup + renvoi /en, footer compact, AdSense. Format le plus cité par ChatGPT/Perplexity/Gemini.
- LANDING /en (nouvelle, statique) : pitch complet en anglais (hero, 6 capacités, 3 cas d'usage, FAQ EN, CTA), hreflang réciproque / ↔ /en (x-default /en), OG en_US, JSON-LD EN, bootstrap document.documentElement.lang. Cible les requêtes anglophones des LLM.
- FILAGE : app/page.tsx consomme lib/geo (FAQ_ITEMS=FAQ_FR, STRUCTURED_DATA=buildStructuredData("fr")) + liens « Voir la page FAQ complète » et « English version » ; VitrineHeader internationalisé (prop lang, FAQ visible) ; sitemap +5 pages (faq, en, integrations, signup, login) + alternates hreflang ; llms.txt (+ liens /faq, /en, langues) ; llms-full.txt (+ section « 0. English summary », liens).
- TESTS : lib/geo/content.test.ts (7) + app/geo-routes.test.ts (6) — anti-dérive : crawlers IA présents dans robots, pages citables dans sitemap, hreflang réciproques, llms.txt sync. 780 tests verts / 100 fichiers, lint 0, typecheck 0, build OK (routes /en /faq pré-rendues statiques ○).
- next.config.ts : patch temporaire ignoreBuildErrors pour le build sandbox (OOM) puis restauré à l'identique (vérifié git diff vide).

Task 45 — 5 améliorations demandées (agents, balises, Live, outils internes, téléchargements)
- ÉTAPE 1 (balises) : lib/ai/think-filter.ts — stripThinkTags + ThinkTagStreamFilter (machine à états, balises coupées entre chunks, 14 tests). Branché sur le streaming conversationnel (deltas filtrés), les 3 chemins de persistance, answerAsAgent et le renderer markdown (défense en profondeur). Plus aucune balise <think>/<thinking>/<reasoning> visible.
- ÉTAPE 2 (outils internes) : lib/tools/labels.ts — toolLabel/approvalToolLabel/humanizeConnectorAction (GMAIL_SEND_EMAIL → « Gmail — send email »). Branché : run-timeline, approval-card, context-drawer, agent-chat-panel, observability-dashboard. Aucun identifiant technique brut n'est plus affiché (6 tests).
- ÉTAPE 3 (téléchargements) : images générées PERSISTÉES (R2 users/<id>/permanent/ai-images ou data URI inline ≤ 380 Ko) — plus d'URL Agnes expirée ; bouton ⬇ Télécharger sur les images du fil, du chat agent et du panneau ; artefacts AUDIO (type + extraction voice.speak + lecteur <audio> + onglet) ; resolveFileUrl par défaut (/api/storage/permanent) ; téléchargement Blob forcé avec repli CORS (lib/client/download.ts).
- ÉTAPE 4 (agents) : timeout 55 s Anthropic (A1) ; timeout d'étape NON retryable — anti double-exécution + double facturation (A2) ; repli classificateur journalisé (A3) ; route autonome FACTURÉE via generateForUser (A4) ; coupe-circuit sur generateStream (A6) ; fuite viewerTokenHash corrigée (A7/L9).
- ÉTAPE 5 (Agent Live) : verrou décision-en-vol (gateway + route navigateur) — élimine la pause spontanée par double action ; timeout 12 s + cache clients + parse JSON tolérant (vision-decider) ; dédup frames par SHA-256 (écran inchangé = 0 appel LLM + 0 écriture) ; watchdog client muet 45 s ; plafond itérations 300 ; client desktop : réduction JPEG 4K (jpeg-js, frames plus jamais perdues en silence) ; échecs réseau visibles dans le journal UI.
- QA : typecheck 0, lint 0, 800 tests verts / 102 fichiers, build OK. Commits 13d905d, 2b03c52, c18e1e0, 809886c, 90ed677.

Task 45-bis — correctif CI : le job couverture échouait (68,49 % lignes < 70 %) car le nouveau coupe-circuit generateStream n'était pas testé (router.ts dans la liste de couverture). lib/ai/router-stream.test.ts : 3 tests avec mock de ./providers (saut circuit ouvert, ouverture après seuil de 3 échecs, enregistrement du succès) → 80,13 % lignes. 803 tests verts.

Task 46 — Étape 1/20 : « le système d'agent IA ne mémorise pas les historiques de conversation des agents » — CORRIGÉ (score auto-évalué 9,7/10)
- ANALYSE (protocole règle 1) : 6 causes racines identifiées et vérifiées dans le code.
  RC1 : conversations créées SANS agentId (route agent/chat) → rail « Historique des chats » d'un agent toujours vide, réouverture impossible.
  RC2 : index Firestore composite (userId, agentId, updatedAt DESC) absent → FAILED_PRECONDITION avalé silencieusement par l'UI.
  RC3 : listMessages orderBy asc+limit renvoyait les N PLUS ANCIENS → le LLM recevait le début du fil et « oubliait » la fin (agent/chat, engine, chat/message).
  RC4 : classificateur et planificateur mode task appelés SANS historique → références implicites cassées, plans hors-contexte (historyContextNote jamais appelée).
  RC5 : résultat FINAL post-approbation jamais persisté dans le fil (seul le refus l'était).
  RC6 : missions du chat agent liées à aucun run → réouverture = texte seul, plan/étapes/livrables perdus.
- CORRECTIFS (protocole règle 2, zéro code de démonstration) :
  ① lib/chat/repository.ts : listMessages option order:"recent" (N plus récents renvoyés chronologiques) ; getConversation/findLatestConversation exposent agentId ; updateConversation accepte agentId (rattachement rétroactif) ; replis SANS INDEX pour listConversations scopé agent (filtre mémoire) et listMessages (tri mémoire, même contrat).
  ② firestore.indexes.json : + index chatConversations(userId,agentId,updatedAt DESC) et chatMessages(conversationId,userId,createdAt DESC).
  ③ lib/agents/conversation-run.ts (nouveau) : pont mission↔conversation — mapPlanStepsToRunSteps (timeline lisible), compactRuntimePayload (borné 220 Ko, troncature explicite), recordAgentRun, reconcileAgentRun (créé si absent).
  ④ app/api/agent/chat/route.ts : création de fil AVEC agentId + backfill legacy ; historique récent (30) ; classifyRequest avec historique ; historyContextNote injectée en mode task ET chemin universel ; run enregistré (waiting_approval ET final) + runId sur le message final ; cadence de résumé sur messageCount réel (plus limitée à la fenêtre).
  ⑤ approve/route.ts : résultat FINAL persisté (succès OU échec explicite) + reconcileAgentRun (statut final, timeline, payload).
  ⑥ GET /api/chat/conversations/[id] : renvoie les runs du fil.
  ⑦ agent-chat-panel : la réouverture restaure la mission (panneau plan/étapes/sorties) depuis le run persisté — plus aucune mission perdue.
  ⑧ engine.ts + chat/message : contexte LLM sur les PLUS RÉCENTS (order recent).
- TESTS RÉELS (protocole règle 5) : 24 nouveaux tests (chat.history 10, approve.history 4, repository.recent 4, conversation-run 6) — scoping agentId, backfill, ordre récent, repli sans index, historique au classificateur/planificateur, run lié + fail-soft, persistance post-approbation succès/échec, mapping/condensation/statuts, index déclaré. Suite complète : 827 verts / 107 fichiers, typecheck 0, lint 0, build compilé (OOM sandbox sur la phase types — tsc standalone vert = garde réelle, limitation documentée).
- SONDES PROD (post-déploiement) : la comparaison ancien/nouveau build a révélé que le 401 « historique » venait de la protection Vercel SSO sur l'URL de déploiement — le comportement réel de l'app : approve anonyme → 500 opaque (requireUser HORS du try, HttpError 401 non capturé) et agent/chat → 400 trompeur (AUTH_REQUIRED mappé 400). DÉFAUTS PRÉEXISTANTS CORRIGÉS : approve — auth + Body.parse déplacés DANS le try (401 structuré) + code machine errorCode dans la réponse ; agent/chat — catch renvoie 401 explicite sur code AUTH_REQUIRED. 2 tests de non-régression 401 ajoutés. 829 verts / 107 fichiers.

Task 46 — Étape 1 : CLÔTURE VALIDÉE
- Déploiements : 63633fa (dpl_d1PBquM8…) READY puis a8d99b1 (correctifs auth) READY.
- Sondes production verify_task46_step1_prod.mjs : 6/6 vertes (vitrine 200, health 200, 401 structurés sur les 3 routes modifiées, build vivant).
- Auto-évaluation finale règle 3 : 9,7/10 ≥ 9,5 → appliqué. Aucune régression : 829 tests verts / 107 fichiers, typecheck 0, lint 0.

Task 46 — Étape 2/20 : « le système d'agent IA ne traite pas les tâches longues » — CORRIGÉ (score auto-évalué 9,6/10)
- ANALYSE : 12 causes racines (3 modèles de temps contradictoires 60 s/120 s/30 min ; checkpoint persisté mais lisible UNIQUEMENT par la route d'approbation ; reprise amnésique (outputs: {} dans le constructeur) ; timeline conversationnelle persistée seulement en fin de tour ; bug `status` hors scope dans executeApprovedStep (chaque approbation workspace « échouait » après avoir agi) ; cron quotidien vs dispatch documenté 5 min (limite plan Vercel Hobby : crons 1×/jour)).
- CORRECTIFS :
  ① Reprise NON-AMNÉSIQUE : RuntimeRunnerOptions.initialOutputs — le constructeur restaure les sorties des étapes complétées (les étapes dépendantes reprennent avec leur contexte).
  ② NOUVELLE ROUTE POST /api/agent/chat/continue : reprise réelle d'une mission interrompue — garde-fous complets (401 structuré, 404, 409 completed/cancelled/running-frais/waiting_approval→HITL), reprend un `running` STALE > 10 min (kill plateforme), réinitialise failed/running→pending sur demande EXPLICITE, saute les complétées, persiste le message final dans le fil + réconcilie le run, répond resumable:true si ré-échec (jamais de blocage définitif). Rate limit dédié.
  ③ agent/chat : réponses d'échec (2 chemins) portent resumable:true — le checkpoint (travail partiel + coût) est conservé.
  ④ UI agent-chat-panel : bouton « Continuer la mission » sur les missions échouées reprenables (bloc bleu explicatif, reprise n'exécute que le reste).
  ⑤ engine.ts executeApprovedStep : bug `status` hors scope corrigé (hoist) — les approbations workspace se terminent enfin proprement.
  ⑥ runPlanTurn : timeline persistée APRÈS CHAQUE ÉTAPE (persistSteps fail-soft) — un kill ne laisse plus de run fantôme vide ; les étapes réussies restent visibles dans le fil.
- LIMITE PLATEFORME DOCUMENTÉE : vercel.json cron reste 1×/jour (Hobby = crons quotidiens uniquement ; */5 serait ignoré) — la veille RSS dispose d'un throttle 10 min intégré prêt pour un passage en fréquence dès un plan Pro.
- QA : typecheck 0, lint 0, 839 tests verts / 108 fichiers (+10 : continue.history 10 — reprise, garde-fous, stale-running, HITL, 401).

Task 46 — Étape 3/20 : fausses confirmations « résultat livré » — SUPPRIMÉES (score auto-évalué 9,7/10)
- CORRECTIFS :
  ① lib/agents/final-response.ts (nouveau) : buildFinalResponse — texte final construit depuis les STATUTS RÉELS du plan, règle unique sur les 3 chemins runtime (agent/chat, approve, continue) : livrable réel si tout est réussi ; « Mission incomplète : N étape(s) en échec — non livrée(s) » + liste explicite + « Aucun livrable produit » sinon + invitation à « Continuer la mission » (travail conservé). Les 3 fonctions locales finalResponseText sont supprimées.
  ② engine.ts summarizePlanTurn : RÈGLE ABSOLUE D'HONNÊTETÉ injectée dans le prompt de synthèse (une étape [failed] n'est PAS livrée ; seules [done] sont annoncées réalisées) + planFailureAppendix — annexe DÉTERMINISTE ajoutée au texte final dès qu'une étape échoue, même si le LLM omet ou minimise les échecs (flux, non-flux et repli couverts). Pure, exportée, testée.
  ③ route continue : le message persisté après reprise en échec combine l'annexe honnête + la cause réelle de l'interruption.
- TESTS : +7 (final-response 6, honnêteté via continue 1) — contrat : un échec n'expose JAMAIS de finalText de livraison ; l'honnêteté passe par le message du fil. 846 verts / 109 fichiers, typecheck 0, lint 0.

Task 46 — Étape 4/20 : cohérence stricte thème sombre/clair — CORRIGÉ (score auto-évalué 9,6/10)
- ANALYSE : 10 causes racines (couche compat clair incomplète : dégradés --g3-gradient non exemptés, g3-primary-surface morte, hover:text-white non couvert ; 179 pastels clairs en dur dans 63 fichiers cassant le SOMBRE ; îlots sombres involontaires (admin/ads illisible en clair) ; aucun toggle sur vitrine/auth ; global-error 100 % clair hors thème ; theme-color sur le système au lieu du choix).
- CORRECTIFS :
  ① globals.css : exemption de .text-white étendue aux dégradés de marque ([class*="--g3-gradient"], exemption morte supprimée) ; hover:text-white converti en clair ; NOUVELLE COUCHE SYMÉTRIQUE pour le thème SOMBRE — les pastels Tailwind clairs (bg-{emerald,amber,red,sky,violet,...}-50/100/200, text-*700/800, border-*200) remappés vers les tokens sémantiques --g3-{success,warning,danger,primary,magenta}-soft/strong : 63 fichiers assainis d'un coup, sans toucher aux composants ; bordures white/10-30 → bordure du thème en clair ; neutres gray/zinc/slate → surface/muted du thème.
  ② components/shells/status-badge.tsx (déployé sur ~40 pages) : TONE_CLASSES convertis en tokens bithème — plus AUCUN pastel en dur.
  ③ app/admin/ads : 7 champs bg-[--g3-deep] (illisibles en clair) → classe g3-input bithème.
  ④ app/global-error.tsx : bootstrap data-theme (même convention localStorage) + couleurs 100 % variables --g3-* avec replis — l'écran d'erreur suit le thème.
  ⑤ app/layout.tsx : le meta theme-color SUIT le choix utilisateur (barre navigateur mobile).
  ⑥ vitrine-header : ThemeToggle compact sur la vitrine (le choix est désormais accessible sur TOUTES les surfaces, sidebar + vitrine + paramètres).
- TESTS : +7 app/theme-consistency.test.ts (couche sombre présente, exemptions clair corrigées, tokens définis dans les 2 blocs, status-badge sans pastel, toggle vitrine, global-error thémé, theme-color). 853 verts / 110 fichiers, typecheck 0, lint 0.
- SONDES PROD (post-déploiement 1ad2504 READY) : scripts/verify_task46_step4_theme_prod.mjs — la CSS servie en production contient la couche sombre (.bg-emerald-50→tokens), les tokens soft/strong, l'exemption dégradés (forme minifiée [class*=--g3-gradient]), la conversion hover:text-white. Probes globales 7/7.

Task 46 — Étape 5/20 : version app (PWA) fonctionnelle, sans blocage, synchro web — CORRIGÉ (score auto-évalué 9,5/10)
- ANALYSE : 7 causes racines (offline = page erreur navigateur brute ; outbox sur les MAUVAISES routes — chat stream non couvert, /api/chat/message morte, préfixe large capturant /approve et /continue ; 202 {queued} géré par AUCUNE UI — faux statuts, bouton mission bloqué à vie ; sync fragile — perte silencieuse 401/4xx, doubles envois possibles, pas d'idempotence ; live-agent non packagé (deps natives) ; promesse push non tenue = étape 18).
- CORRECTIFS :
  ① public/sw.js refondu : file STRICTE (Set + pathname exact — plus jamais /approve /continue en file ; /api/chat/message morte retirée) ; fallback offline.html en NETWORK-FIRST pour les navigations uniquement (bug historique inverse impossible) ; verrou anti-concurrence flushOutbox (missions jamais doublées) ; idempotence x-gen3ia-idempotency-key par item ; erreurs transitoires replafonnées (MAX_ATTEMPTS 5, updateQueued) ; 4xx définitifs retirés de la file MAIS notifiés (gen3ia-outbox-failed, reason) — JAMAIS de perte silencieuse ; IndexedDB indisponible → 503 explicite (OFFLINE_UNAVAILABLE) au lieu d'une erreur réseau brute.
  ② mission-composer : 202 queued annoncé honnêtement (« enregistrée, envoyée au retour du réseau ») + finally setBusy(false) — le bouton « Création… » n'est plus jamais bloqué à vie.
  ③ agent-chat-panel : 202 queued annoncé honnêtement (mission), gardes défensifs sur approbation/reprise (jamais de faux « Autorisation appliquée » hors-ligne), plan?.steps?.map (anti-crash panneau), consommateur gen3ia:outbox-failed (échec de synchro visible, cause session expirée distinguée).
  ④ pwa-register : flush via navigator.serviceWorker.ready (le reg.active null du premier register perdait le flush de démarrage) + relais outbox-failed/pending vers la page.
  ⑤ manifest : theme_color/background_color alignés sur le thème sombre de boot (#05060C/#0B0D1A).
- LIMITE DOCUMENTÉE : le chat workspace en streaming NDJSON reste hors file (reprise complexe, décision produit dédiée) — hors-ligne, l'erreur est explicite ; live-agent : packaging natif requis (nut-js) — chantier séparé ; notifications natives push = Étape 18.
- TESTS : +11 app/pwa-consistency.test.ts (file stricte, verrou, idempotence, network-first, 503, notifications, plafond, manifest, composer, panel, pwa-register). 864 verts / 111 fichiers, typecheck 0, lint 0.
- SONDES PROD (post-déploiement e80e2ba READY) : scripts/verify_task46_step5_pwa_prod.mjs 8/8 (SW strict/idempotent/plafonné/offline-first/notifications, manifest sombre, installable, offline.html 200) + probes globales 7/7.

Task 46 — Étape 12/20 : le « carré parasite » — IDENTIFIÉ ET ÉLIMINÉ (score auto-évalué 9,6/10)
- ANALYSE (captures utilisateur fournies, upload/) : IMG_20260929_221922.jpg montre un contour VIOLET À ANGLES DROITS autour du composer du chat — cause racine : la règle globale a11y `textarea:focus-visible { outline: 2px solid var(--g3-primary) }` (globals.css:1192, spécificité 0,1,1) BAT la classe utilitaire .outline-none (0,1,0) → un rectangle à angles droits est dessiné autour du textarea à chaque focus (les champs texte matchent :focus-visible même au clic), débordant visuellement la carte arrondie. Les autres captures : crash PWA « This page couldn't load » (corrigé en Étape 5 par le fallback offline.html network-first).
- CORRECTIF : le textarea du CommandComposer reçoit focus-visible:outline-none focus-visible:ring-0 — l'état de focus reste SIGNALÉ par le focus-within de la carte arrondie (bordure du thème) ; la règle globale a11y reste intacte pour tous les autres éléments.
- TESTS : +2 (contour supprimé sur le composer ; règle globale a11y conservée). 866 verts / 111 fichiers, typecheck 0, lint 0.

Task 46 — Étape 6/20 : Agent Live fonctionnel, sans bugs — VÉRIFICATION CONSOLIDÉE (Task 45 étape 5 = verrou décision-en-vol, timeout 12 s + cache vision, dédup frames SHA-256, watchdog 45 s, plafond 300 itérations, JPEG 4K ; score 9,6/10)
- TESTS : lib/live 3/3 verts ; runtime + router-stream verts.
- SONDES PROD : POST /api/live/sessions sans session → 403 = garde PC-ONLY serveur (detectDeviceFromHeaders, message dédié, code LIVE_PC_ONLY) — comportement voulu ; GET/POST /api/live/sessions/probe sans session → 401. Aucun endpoint ouvert, aucune régression.
- Décision : l'Étape 6 est tenue par les correctifs Task 45 étape 5 (commit 90ed677) + cette vérification ; aucune anomalie nouvelle détectée.

Task 46 — Étape 18/20 : notifications natives de l'appareil — LIVRÉ (score auto-évalué 9,6/10)
- ANALYSE : les notifications natives existaient pour les approbations mais RIEN ne demandait jamais la permission (statut default → silence perpétuel) ; new Notification() échoue sur Android (dépréciée) ; aucun clic de notification ; limité aux seules approvals.
- CORRECTIFS :
  ① lib/notifications/native.ts : chaîne complète — opt-in utilisateur persisté (désactivé par défaut), demande de permission au clic, éligibilité pure testée (permission accordée + activé + onglet caché + jamais montrée), dédup par session plafonnée (200), affichage avec REPLI AUTOMATIQUE service worker showNotification (Android + app installée), clic → focus + navigation.
  ② public/sw.js : handler notificationclick — réutilise la fenêtre existante (focus + navigate) sinon openWindow : les notifications natives fonctionnent aussi en app installée.
  ③ notification-center : TOUTES les nouvelles notifications non lues (approbations + info + conversation) partent nativement avec route de retour contextualisée (/workspace?c=…, /studio?taskId=…).
  ④ Paramètres : section « Notifications natives de l'appareil » — activation avec demande de permission au clic, état réel du navigateur affiché (accordée / refusée avec instructions / non demandée), désactivation.
- EXTENSION DOCUMENTÉE : push serveur (fenêtre totalement fermée) = VAPID + subscriptions — chantier distinct ; la demande utilisateur (« notifications sur l'interface de l'appareil ») est tenue par le natif en app ouverte/installée.
- TESTS : +12 (éligibilité, dédup plafonnée, opt-in persisté, gardes de câblage SW/centre/paramètres). 878 verts / 112 fichiers, typecheck 0, lint 0.

Task 46 — ÉTAT DU PLAN 20 ÉTAPES (fin de session)
- LIVRÉES (protocole complet : analyse → sandbox → auto-note ≥9,5 → push → QA réelle → sondes prod) :
  Étape 1 (historiques agents, 6 causes racines) ; Étape 2 (tâches longues : reprise non-amnésique + route continue + timeline par étape) ; Étape 3 (faux « livré » : buildFinalResponse + annexe déterministe) ; Étape 4 (thème bithème : couche symétrique 63 fichiers + status-badge tokens + toggle vitrine + global-error) ; Étape 5 (PWA : file hors-ligne stricte/idempotente/plafonnée + offline.html network-first + 202 honnêtes + bouton mission débloqué) ; Étape 6 (Agent Live : consolidation vérifiée, tests + garde PC-only confirmés) ; Étape 12 (« carré » : contour focus-visible qui battait outline-none, éliminé) ; Étape 18 (notifications natives : opt-in + permission + repli SW + notificationclick + réglage).
- QA GLOBALE : 878 tests verts / 112 fichiers (+75 vs début de Task 46), typecheck 0, lint 0, 8 déploiements Vercel READY, sondes production vertes à chaque étape (verify_task46_step1/4/5_prod.mjs).
- RESTANTES : 7 (API + outil en clair → sécurisation auto), 8 (édition d'images), 9 (temps estimé affiché), 10 (adaptateur d'écran), 11 (mises à jour multi-appareils), 13 (liens web pour agent/conversation), 14 (bibliothèque de capacités → conversation directe), 15 (Knowledge +), 16 (Mission +), 17 (fonctionnalités internes), 19 (perf/UX), 20 (facturation).

Task 47 — Étape 7/20 : « Agent gen API appelable + outils en clair reconnus et durcis automatiquement » — LIVRÉ (score auto-évalué 9,7/10)
- ANALYSE (règle 1) : 7 causes racines vérifiées. RC1 : proposal.tools du LLM non validée contre le registre (42 outils) — Agent gen peut proposer « Gmail », « Jira », des outils fantômes. RC2/RC3 : création et PATCH persistent ces chaînes telles quelles (fantômes en base). RC4 : policyForAgent ne fait qu'un contrôle de FORMAT (/^[a-z0-9_.]+$/) — jamais d'existence ; fantômes bien formés whitelisés silencieusement, noms en clair jetés sans trace. RC5 : aucun durcissement de config (email.send + auto_allow accepté tel quel). RC6 : aucune route d'exécution d'agent n'accepte les clés API g3x_ (session seule). Découverte : GEN3IA_TOOLS ne contient PAS schedule.*/workflow.* (8 outils) pourtant exécutables légitimement (moteur conversationnel) — tout filtre d'existence doit utiliser l'UNION registre + TOOL_SECURITY.
- CORRECTIFS (règle 2, zéro code de démonstration) :
  ① lib/agents/tool-resolver.ts (NOUVEAU, pur, 17 tests) : normalisation (accents/casse/ponctuation) + 40+ règles d'alias métier FR → outils canoniques (Gmail→email.send, recherche web→web.search, tâches planifiées→schedule.create, Slack/WhatsApp/Telegram→messaging.send, Python/code→code.execute, PDF/rapport→artifact.create, Zapier→composio.execute, agenda/Drive/SQL→mcp.call…) ; ensemble d'existence = UNION GEN3IA_TOOLS ∪ TOOL_SECURITY (KNOWN_TOOL_SECURITY_NAMES exporté) ; entrée inconnue (Jira…) retirée AVEC raison actionnable (« connectez l'app via MCP ou Composio »), JAMAIS silencieuse ; hardenAuthorizationMode : auto_allow + outil external/destructive → ask_if_needed + rapport.
  ② Intégration sur les 3 surfaces : /api/agents/generate (proposal assainie + toolReport {mapped, removed, sensitiveTools, hardened}), POST /api/agents (résolution AVANT createAgentRecord — plus aucun fantôme en base), PATCH /api/agents/[id] (fusion hygiénique : patch.tools ?? current.tools, mode ?? courant).
  ③ policyForAgent : filtre par existence réelle à l'UNION (défense en profondeur — records legacy à outils fantômes ne whitelistent plus rien).
  ④ POST /api/v1/agents/[agentId]/run (NOUVEAU) : auth clé développeur g3x_ (authenticateDeveloper + X-Gen3ia-Project-Id), propriété réelle (getAgentForOwner → 404), statut actif requis (409), rate limit dédié 30/5 min (429), pipeline EXACT de la route session (createPersonalizedPlan + policyForAgent + AgentRuntime : HITL, quotas, metering, audit), 402 explicite sur solde insuffisant, erreurs 401 structurées (jamais 500 opaque).
  ⑤ Panneau développeur : section « Exécuter un agent par API » — l'endpoint est documenté dans l'app (curl-like, contrat de réponse, limites).
- TESTS RÉELS (règle 5) : +30 (resolver 17 : alias, union, dédup, durcissement, rapport ; route v1 7 : 401/404/409/400/429/200/402 ; hygiène generate+création 3 ; PATCH 3). Suite complète : 908 verts / 116 fichiers, typecheck 0, lint 0. Build local OOM (limite sandbox 4 Go, connue) — le déploiement Vercel a compilé le build réel avec succès (garde définitive).
- CI : le step « Audit production dependencies » (npm audit) échouait DÉJÀ sur tous les commits précédents (ff4d0d7, eaf30ff…) — pré-existant, aucune dépendance ajoutée par ce commit ; les autres jobs (E2E, a11y, secrets, Supabase) sont verts.
- SONDES PROD (post-déploiement READY) : scripts/verify_task47_step7_api_prod.mjs — 7/7 vertes (route v1 vivante : 401 structuré sans clé ET avec clé invalide, sans exécution ; generate/create anonymes → 401 ; build vivant).

Task 47 — ÉTAT DU PLAN 20 ÉTAPES après l'étape 7
- LIVRÉES : 1, 2, 3, 4, 5, 6, 7, 12, 18 (9/20).
- RESTANTES : 8 (édition d'images), 9 (ETA affiché), 10 (adaptateur d'écran), 11 (mises à jour multi-appareils), 13 (liens/web pour agent), 14 (bibliothèque de capacités → conversation directe), 15 (Knowledge +), 16 (Mission +), 17 (fonctionnalités internes), 19 (perf/UX), 20 (facturation).

Task 47 — Étape 8/20 : « édition d'images (import utilisateur OU image générée) » — LIVRÉ (score auto-évalué 9,6/10)
- ANALYSE (règle 1) : 5 causes racines. RC1 : le module image-generation n'envoyait JAMAIS extra_body.image — l'img2img supporté par Agnes 2.5 flash (doc officielle vérifiée : POST /v1/images/generations + extra_body.image[], URLs publiques ou Data URI Base64) était inaccessible. RC2 : les images importées étaient converties « metadata-only » et le binaire JETÉ — aucune ressource exploitable. RC3 : aucune détection d'intention d'édition (une retouche partait en génération from scratch ou en texte). RC4 : aucune résolution de source (path R2, URL expirable, data URI) vers le contrat de l'API. RC5 : aucune route d'édition.
- CORRECTIFS (règle 2, zéro code de démonstration) :
  ① editImageWithAgnes — même endpoint que la génération, sources dans extra_body.image (contrat doc officielle), multi-composition ≤ 4 images, code INVALID_IMAGE dédié, erreurs upstream lisibles.
  ② lib/files/image-source.ts (NOUVEAU) : résolution serveur de TOUTE source en Data URI Base64 (voie garantie par la doc Agnes) — data URI direct, URL http(s) récupérée (20 s, plafond 8 Mo, content-type image vérifié), clé R2 permanente téléchargée via downloadFromR2 (authentifié, jamais exposée) ; sniffing magic bytes (PNG/JPEG/GIF/WEBP) ; plafond 4 sources ; sources individuellement indisponibles sautées, échec explicite si AUCUNE.
  ③ lib/domain/conversations/image-intent.ts (NOUVEAU, pur) : détection déterministe FR/EN — verbe d'édition + référence d'image existante (« modifie cette image », « retouche la photo ») OU modification ciblée (« supprime l'arrière-plan », « fond flou ») ; questions explicatives et génération pure exclues.
  ④ Moteur conversationnel : runImageEditTurn branché AVANT la génération — sources = attachments image du message (import utilisateur) OU dernière image de la conversation (imageUrl du dernier message assistant / attachment avec ressource, scan depuis la fin) ; résultat persisté exactement comme la génération (persistGeneratedImage → R2 ou inline) + artefact image + imageUrl sur le message + events message_complete/artifact_created ; échec = message honnête dans le fil.
  ⑤ Import de fichiers : le binaire des images importées est réellement persisté en R2 (users/<uid>/permanent/imported-images/, fail-soft documenté) et la clé path remonte dans la vue + l'attachment du composer — les imports deviennent des sources réelles.
  ⑥ /api/ai/image : champ images[] optionnel (Data URI/URL, ≤ 4) → route d'édition ; réponse enrichie edited+sourceCount ; contrat génération inchangé.
  ⑦ UI : bouton « ✎ Éditer l'image » à côté de « ⬇ Télécharger » sur les images du fil → l'image est injectée comme ATTACHMENT RÉEL du composer (mechanisme injected/injectedKey, dédup, focus) avec préfixe « Édite cette image : » — l'utilisateur complète l'instruction et envoie : le tour d'édition réel démarre.
- TESTS RÉELS (règle 5) : +24 (éditeur 3 : contrat extra_body.image, sources invalides, upstream ; intent 9 ; sources 12 : classificateurs, fetch/R2/plafonds/résilience/magic bytes). Suite complète : 932 verts / 118 fichiers, typecheck 0, lint 0.
- LIMITE DOCUMENTÉE : sans R2 configuré, une image importée reste non éditable (aucun binaire persistable) — l'édition répond alors honnêtement qu'aucune source n'est exploitable ; data URI inline ≤ seuil reste exploitable.
- SONDES PROD : Vercel « Deployment has completed » (API GitHub) + scripts/verify_task47_step8_edit_prod.mjs 5/5 vertes (édition anonyme → 401 structuré, import anonyme → 401, build vivant).

Task 47 — ÉTAT DU PLAN 20 ÉTAPES après l'étape 8
- LIVRÉES : 1, 2, 3, 4, 5, 6, 7, 8, 12, 18 (10/20).
- RESTANTES : 9 (ETA affiché), 10 (adaptateur d'écran), 11 (mises à jour multi-appareils), 13 (liens/web pour agent), 14 (bibliothèque de capacités → conversation directe), 15 (Knowledge +), 16 (Mission +), 17 (fonctionnalités internes), 19 (perf/UX), 20 (facturation).

Task 47 — Étape 9/20 : « temps de livraison estimé (ETA) affiché pendant l'exécution » — LIVRÉ (score auto-évalué 9,6/10)
- ANALYSE : les RunStep portaient déjà startedAt/finishedAt (durées réelles) mais AUCUNE estimation ni affichage : pendant une mission en cours, l'utilisateur n'avait aucun signal du délai de livraison.
- CORRECTIFS :
  ① lib/agents/eta.ts (NOUVEAU, pur, 11 tests) : estimateRunEta — médiane des durées RÉELLES mesurées par phase (les mesures du run priment sur les typiques), repli TYPICAL_PHASE_MS (understanding 8 s, plan 12 s, execution 30 s…), étape in_progress créditée du temps écoulé (plancher 1 s), validations humaines (awaiting) EXCLUES de l'estimation machine et comptées à part — l'UI les annonce explicitement ; formatRunEta honnête (moins d'une minute / ~N min (HH:MM) / plus de 30 min + mention « hors N validations en attente de votre accord ») ; chaîne vide quand rien à estimer.
  ② RunTimeline : ligne ETA vivante sous l'en-tête du run (tick 10 s, pas de re-rendu par seconde), affichée dans le fil de conversation ET le tiroir contextuel (context-drawer) tant que le run est actif.
- TESTS : +11 (mesures réelles vs typiques, crédit du temps écoulé, exclusion/comptage des awaiting, ignore skipped, formats honnêtes, chaîne vide). Suite complète : 943 verts / 119 fichiers, typecheck 0, lint 0.
- SONDES PROD : Vercel « success » (API GitHub) sur le commit de l'étape.

Task 47 — ÉTAT DU PLAN 20 ÉTAPES après l'étape 9
- LIVRÉES : 1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 18 (11/20).
- RESTANTES : 10 (adaptateur d'écran), 11 (mises à jour multi-appareils), 13 (liens/web pour agent), 14 (bibliothèque de capacités → conversation directe), 15 (Knowledge +), 16 (Mission +), 17 (fonctionnalités internes), 19 (perf/UX), 20 (facturation).

Task 47 — Étape 10/20 : « adaptateur d'écran (expérience cohérente tous appareils) » — LIVRÉ (score auto-évalué 9,5/10)
- ANALYSE : détection d'appareils déjà solide (lib/device/detect + use-device + headers middleware, viewport interactiveWidget) — mais un DÉFAUT MAJEUR de cohérence : la liste des conversations et le tiroir contextuel du workspace étaient `max-lg:hidden` SANS aucune alternative — sous 1024 px (mobile + tablette), impossible d'accéder à ses conversations, et le bouton « ⧉ Contexte » de l'en-tête ne faisait RIEN de visible.
- CORRECTIFS :
  ① lib/ui/screen-adapter.ts (NOUVEAU, pur) : SOURCE UNIQUE des classes « même contenu, deux habillages » — panneaux inline ≥ lg (comportement historique), feuilles superposées < lg (w-72, max-w-[85vw], z-50, fond cliquable z-40, fermées sous lg) ; boutons d'en-tête mobiles masqués ≥ lg. Zéro dérive de classes possible.
  ② conversation-workspace : feuille mobile GAUCHE réutilisant le MÊME ConversationList (fermeture automatique à la sélection via effet sur conversationId) ; feuille mobile DROITE réutilisant le MÊME ContextDrawer — le bouton « ⧉ Contexte » fonctionne désormais sur tous les écrans ; bouton « ◧ Conversations » dans l'en-tête mobile ; aria-modal + aria-label ; fonds d'obstruction cliquables.
- TESTS : +6 (inline/caché selon breakpoint, feuille ouverte vs fermée par token, côté gauche/droite, largeur bornée, fond seulement si ouverte, boutons mobiles). Suite : 949 verts / 120 fichiers, typecheck 0, lint 0.
- SONDES PROD : Vercel « success » sur le commit.

Task 47 — ÉTAT DU PLAN 20 ÉTAPES après l'étape 10
- LIVRÉES : 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 18 (12/20).
- RESTANTES : 11 (mises à jour multi-appareils), 13 (liens/web pour agent), 14 (bibliothèque de capacités → conversation directe), 15 (Knowledge +), 16 (Mission +), 17 (fonctionnalités internes), 19 (perf/UX), 20 (facturation).

Task 47 — Étape 11/20 : « chaque mise à jour disponible sur tous les appareils » — LIVRÉ (score auto-évalué 9,6/10)
- ANALYSE : skipWaiting activait le nouveau SW mais AUCUNE page ouverte ne rechargeait — l'utilisateur restait sur l'ancien build (PWA mobile sans bouton refresh = jours de retard) ; update() appelé une seule fois au montage.
- CORRECTIFS (pwa-register refondu) : détection reg.waiting → application ; controllerchange ≠ première installation (pageWasControlled) → application ; moment sûr (onglet caché = reload, onglet visible = signal gen3ia:new-version sans couper une mission) ; garde anti-boucle sessionStorage ; poll 30 min + visibilitychange pour les sessions longues.
- TESTS : +3 (câblage complet). Suite : 952 verts / 120 fichiers, typecheck 0, lint 0. Vercel success.
- LIMITE DOCUMENTÉE : le signal gen3ia:new-version est prêt pour une bannière UI dédiée (prochain chantier UX si souhaité).

Task 47 — ÉTAT DU PLAN 20 ÉTAPES après l'étape 11
- LIVRÉES : 1-12, 18 sauf 13/14/15/16/17/19/20 → précisément : 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 18 (13/20).
- RESTANTES : 13 (liens/web pour agent), 14 (bibliothèque de capacités → conversation directe), 15 (Knowledge +), 16 (Mission +), 17 (fonctionnalités internes), 19 (perf/UX), 20 (facturation).

Task 47 — Étape 13/20 : « l'agent et les conversations utilisent les liens/web fournis par l'utilisateur » — LIVRÉ (score auto-évalué 9,6/10)
- ANALYSE : web.open existait (SSRF-safe) et le mode task pouvait le planifier, mais le CHAT conversationnel ne récupérait JAMAIS le contenu d'une URL collée — réponse sans la page ou inventée.
- CORRECTIFS : lib/domain/conversations/web-context.ts (NOUVEAU) — extractUserUrls (pur : dédup, ponctuation, plafond 2), shouldFetchUrlContext (exclut l'URL déjà routée vers web.api), loadWebPageContext (récupération RÉELLE via executeTool web.open — garde SSRF, quotas, audit ; échecs individuels explicites dans le bloc) ; injection dans la décision d'intention (résumé) ET le system prompt du tour chat avec consigne de fidélité stricte (« ne complète JAMAIS par une invention »).
- TESTS : +8. Suite : 960 verts / 121 fichiers, typecheck 0, lint 0. Vercel success.

Task 47 — ÉTAT DU PLAN 20 ÉTAPES après l'étape 13
- LIVRÉES : 1-12, 13, 18 (14/20).
- RESTANTES : 14 (bibliothèque de capacités → conversation directe), 15 (Knowledge +), 16 (Mission +), 17 (fonctionnalités internes), 19 (perf/UX), 20 (facturation).

Task 47 — Étape 14/20 : « bibliothèque de capacités → conversation directe qui commence à travailler » — LIVRÉ (score auto-évalué 9,6/10)
- ANALYSE : le flux existant créait la conversation puis ATTENDAIT la fin du tour complet (POST /messages bloquant) avant de naviguer — aucune rétroaction, aucun streaming. Le pattern de hand-off streaming (g3-pending-message) existait déjà pour l'accueil.
- CORRECTIFS : la bibliothèque transmet désormais le starterPrompt via le marqueur (constante exportée PENDING_MESSAGE_PREFIX — source unique) et navigue immédiatement ; la page de conversation consomme le marqueur et exécute avec le rendu en direct complet (streaming, timeline, ETA, validations).
- TESTS : +4. Suite : 964 verts / 122 fichiers, typecheck 0, lint 0. Vercel success.

Task 47 — ÉTAT DU PLAN 20 ÉTAPES après l'étape 14
- LIVRÉES : 1-14, 18 (15/20).
- RESTANTES : 15 (Knowledge +), 16 (Mission +), 17 (fonctionnalités internes), 19 (perf/UX), 20 (facturation).

Task 47 — Étape 15/20 : « Knowledge + » — LIVRÉ (score auto-évalué 9,6/10)
- ANALYSE : knowledge.search existait (vectoriel + repli Firestore) mais n'était accessible qu'en mode PLANIFIÉ — en chat, les questions sur les documents du projet ne consultaient jamais la base.
- CORRECTIFS : lib/knowledge/chat-context.ts (pur) — garde (projet requis), seuil de pertinence 0.3 (bruit écarté), tri/plafond (6 fragments × 700 car.), formatage citable ; moteur — recherche automatique sur le message quand la conversation a un projet (budget 4 s fail-soft), injection dans le system prompt avec consigne de fidélité stricte.
- TESTS : +4. Suite : 968 verts / 123 fichiers, typecheck 0, lint 0. Vercel success.

Task 47 — ÉTAT DU PLAN 20 ÉTAPES après l'étape 15
- LIVRÉES : 1-15, 18 (16/20).
- RESTANTES : 16 (Mission +), 17 (fonctionnalités internes), 19 (perf/UX), 20 (facturation).

Task 47 — Étape 16/20 : « Mission + » — LIVRÉ (score auto-évalué 9,6/10)
- ANALYSE : les runs étaient listables UNIQUEMENT par conversation — aucune vue globale de l'activité d'exécution.
- CORRECTIFS : listRecentRuns (sans index composite, tri mémoire — actif immédiatement), GET /api/workspace/missions (propriété stricte, statut + avancement + conversation d'origine), onglet « Missions » dans le panneau de contexte avec saut vers la conversation d'origine (statuts/labels réutilisés).
- TESTS : +2 (contrats). Suite : 970 verts / 124 fichiers, typecheck 0, lint 0.

Task 47 — ÉTAT DU PLAN 20 ÉTAPES après l'étape 16
- LIVRÉES : 1-16, 18 (17/20).
- RESTANTES : 17 (fonctionnalités internes), 19 (perf/UX), 20 (facturation).

Task 47 — Étape 20/20 : « facturation fonctionnelle » — LIVRÉ (score auto-évalué 9,6/10)
- ANALYSE : le système de facturation était structurellement complet (wallet balance/réservé/disponible, topup Chariow Mobile Money + webhook signé, réservation → ajustement → restitution sur chaque exécution, quota 402) MAIS la page Facturation chargeait l'historique du ledger sans JAMAIS l'afficher (_transactions) — l'utilisateur ne pouvait pas voir où va son argent.
- CORRECTIF : section « Dernières transactions » — type traduit en clair, signe par TYPE (ledger à montants positifs : + topup/welcome_grant, − charge/reservation, ↺ release), date locale, référence, devise, note explicative du mécanisme réservation → ajustement → restitution.
- TESTS : suite complète 970 verts / 124 fichiers, typecheck 0, lint 0.

Task 47 — ÉTAT FINAL DU PLAN 20 ÉTAPES (fin de session)
- LIVRÉES (protocole complet) : 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 20 (18/20).
- RESTANTES : 17 (fonctionnalités internes — périmètre à définir avec l'utilisateur), 19 (perf/UX — audit global, chantier transversal).
- QA GLOBALE : 970 tests verts / 124 fichiers (début de session : 878 / 112), typecheck 0, lint 0, déploiements Vercel READY à chaque étape, sondes production vertes (verify_task47_step7_api_prod 7/7, verify_task47_step8_edit_prod 5/5).

Task 48 — Étape 19/20 : « performance & UX » (audit de production de l'utilisateur) — LIVRÉ (score auto-évalué 9,6/10)
- ANALYSE (règle 1) : chaque affirmation de l'audit vérifiée contre le code réel. DÉJÀ EN PLACE (audit daté) : error.tsx/global-error.tsx/not-found.tsx complets (Sentry + thème + réessai), Monaco en next/dynamic ssr:false avec repli texte, serverExternalPackages (pdf-lib/docx/exceljs/pptxgenjs/archiver/yauzl), optimizePackageImports (@monaco-editor/react/openai/@vercel/analytics), images AVIF/WebP + minimumCacheTTL 31 j, script check:bundle (FAIL > 240 kB gzip). ÉCARTS RÉELS CONFIRMÉS : ① le signal gen3ia:new-version (pwa-register, onglet VISIBLE — limite documentée de l'étape 11) était ORPHELIN : aucune UI ne l'écoutait, l'utilisateur n'avait AUCUN retour qu'une mise à jour est prête (scénario exact visé par l'audit : « alertes d'invalidation de cache PWA sans interrompre une mission ») ; ② aucun Cache-Control explicite pour les assets statiques (icônes re-téléchargées à chaque visite, sw.js non verrouillé max-age=0 — un SW servi depuis le cache navigateur ferait rater les mises à jour suivantes) ; ③ le middleware ne pose PAS de Cache-Control global (vérifié : ajout sans risque d'intersection).
- CORRECTIFS (règle 2, zéro code de démonstration) :
  ① components/nav/update-banner.tsx (NOUVEAU) : bannière « Nouvelle version disponible » — consomme gen3ia:new-version ; « Recharger » = window.location.reload() par GESTE EXPLICITE uniquement (garde anti-boucle session de pwa-register, aucun timer automatique), « Plus tard » = dismiss sans perte des détections suivantes ; role=status + aria-live=polite + aria-label ; variables --g3-* (sombre/clair suivis) ; zéro rendu tant qu'aucune mise à jour n'est détectée (hydratation intacte) ; montée dans le layout racine à côté de PwaRegister.
  ② next.config.ts : Cache-Control par classe — /icons/:path* + /og-image.png (public, max-age=86400, stale-while-revalidate=604800), /manifest.webmanifest (3600 + SWR 86400), /sw.js + /offline.html (public, max-age=0, must-revalidate — justesse des mises à jour PWA, le navigateur plafonne sinon sa vérification à 24 h).
- TESTS RÉELS (règle 5) : +10 (6 câblage bannière dans pwa-consistency : consommation du signal, pas de fuite de listener, aucun rechargement automatique — gardes structurels setTimeout/setInterval —, dismiss, a11y, montage layout ; 4 politique de cache dans perf-cache-policy.test.ts NOUVEAU : durées par classe, sw.js/offline.html jamais cachés, garde middleware sans Cache-Control). Suite complète : 980 verts / 125 fichiers, typecheck 0, lint 0.
- BUILD : compilation ✓ (116 s) ; phase lint/types interne de next build OOM-tuée par le sandbox (limite mémoire, 4 Go, même à 3,4 Go libres) — redondante avec les portes standalone (tsc --noEmit 0, eslint 0) et exécutée intégralement par Vercel (pipeline des 18 étapes précédentes). check:bundle : 100 % OK, pire route /layout 182 kB gzip (seuil FAIL 240), zéro marqueur serveur-seul dans les 299 routes.
- COMMIT/PUSH : 40fa14a → origin/main (token utilisateur), 5 fichiers, +204 lignes.
- SONDES PROD : déploiement Vercel à vérifier sur le commit (API GitHub) — voir section suivante si applicable.

Task 48 — ÉTAT DU PLAN 20 ÉTAPES après l'étape 19
- LIVRÉES : 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 19, 20 (19/20).
- RESTANTE : 17 (fonctionnalités internes — périmètre à définir avec l'utilisateur).

Task 48 — SONDES PROD (vérification réelle après déploiement)
- Vercel (API GitHub, commit 40fa14a) : success — « Deployment has completed ».
- scripts/verify_task48_step19_prod.mjs : 6/6 VERTES — site vivant (200), sw.js servi « max-age=0, must-revalidate », icônes « max-age=86400, stale-while-revalidate=604800 » (NOUVEAU actif en prod), manifest.webmanifest « max-age=3600, SWR 86400 » (NOUVEAU actif en prod), sw.js vivant (skipWaiting présent). Note : les défauts Vercel pour public/ sont déjà max-age=0 — l'apport réel de la politique est le cache long icônes/OG + la contractualisation explicite (protection contre tout changement d'hôte), mesurée verte.

Task 49 — Recommandation D de l'audit de production : « alerte solde critique du wallet » — LIVRÉ (score auto-évalué 9,6/10)
- CONTEXTE : sandbox réinitialisé (dépôt recloné à 62d8551, npm ci). L'utilisateur a transmis l'audit de production complet et demandé de traiter les recommandations ; priorité donnée à la facturation D (bien scorpée, vérifiable en prod).
- ANALYSE (règle 1) : wallet.ts (reserve/settle/release en transactions Firestore, XAF unités mineures ×100, bienvenue 3 000 FCFA) ; createNotification (non bloquant, cache invalidé, miroir Supabase) ; Resend = RESEND_API_KEY + EMAIL_FROM_ADDRESS (l'email agentique est FACTURÉ — un e-mail système ne doit PAS passer par ce chemin) ; email utilisateur dans users/{uid} ; AUCUNE alerte de solde existante (rg lowBalance/seuil = 0 résultat) ; /billing existe.
- CORRECTIFS (règle 2) :
  ① lib/billing/low-balance.ts (NOUVEAU) : seuil 50 000 minor (500 FCFA, surchargeable GEN3IA_WALLET_LOW_THRESHOLD_MINOR, repli sûr sur valeur invalide), cooldown 24 h (GEN3IA_WALLET_LOW_COOLDOWN_MS), isLowBalance STRICT (< seuil, égalité = pas critique), cooldownElapsed accepte Timestamp Firestore, formatMinorAsFcfa au PLANCHER (jamais plus que le réel), fireLowBalanceAlert = notification in-app (« Solde Gen3ia critique », type info) + e-mail SYSTÈME Resend (timeout 5 s, jamais facturé — aucun import media-meter), email lu users/{uid} avec validation ; chaque étage fail-soft (console.warn, jamais de throw).
  ② wallet.ts : dédup ATOMIQUE — décision (seuil+cooldown) dans la transaction, drapeau lowBalanceNotifiedAtMs écrit dans le MÊME commit que la mutation (deux exécutions concurrentes ne peuvent pas doubler) ; dispatch fire-and-forget APRÈS commit ; hard-stop « solde 0 » alerte aussi via InsufficientFundsError porteuse (messages historiques préservés octet pour octet, erreur repropagée) + drapeau best-effort hors transaction ; applyTopup réarme (FieldValue.delete) — release ne réarme PAS (pas de fonds nouveaux).
- TESTS RÉELS (règle 5) : +25 (défauts/surcharges/valeurs invalides, frontières, cooldown, formatage, gating e-mail, gardes structurels : dédup transactionnel, messages préservés, non-facturation, fire-and-forget, exports consommés). Suite complète : 1005 verts / 126 fichiers, typecheck 0, lint 0 (1 correction : variable `module` interdite ESLint), compilation OK (phase lint/types interne OOM sandbox — portes standalone 0), budget bundle 100 % OK, /layout inchangé 182 kB gzip (module serveur).
- LIMITES DOCUMENTÉES : l'e-mail exige RESEND_API_KEY + EMAIL_FROM_ADDRESS en prod (la notification in-app fonctionne sans) ; l'alerte se déclenche aux moments de cycle de mission (réservation/règlement/hard-stop) — pas de balayage en arrière-plan des wallets déjà bas (hors périmètre, à demander si souhaité).
- COMMIT/PUSH : 7b9a91e → origin/main (token utilisateur), 3 fichiers, +444/-28.

Task 50 — Recommandations §4 (Sécurité) et §7 (CI/CD) de l'audit de production — LIVRÉ (score auto-évalué 9,6/10)
- ANALYSE (règle 1) : ci.yml déjà solide (cache npm via setup-node, gitleaks, e2e émulateurs, a11y axe-core, budget bundle) — MAIS ① aucun cache .next/cache sur les DEUX jobs qui buildent (ci + a11y : rebuild webpack complet à chaque run) ; ② AUCUN SAST (CodeQL/Semgrep absents, audit §4) ; ③ le step « Audit production dependencies » était EN ÉCHEC depuis des commits antérieurs aux Tasks 48-50 : 8 advisories (5 high) dans des chaînes transitives de production.
- CORRECTIFS (règle 2) :
  ① ci.yml : cache .next/cache branché sur les deux jobs (clé SHA + restore-keys runner) — builds Next réutilisés entre runs.
  ② .github/workflows/codeql.yml (NOUVEAU) : SAST CodeQL javascript-typescript, suite security-extended, push/PR + hebdo lundi 03:00 UTC, permissions moindre privilège (security-events: write, contents: read), catégorie verrouillée.
  ③ Dépendances : overrides ciblés VERS versions corrigées les plus proches — @grpc/grpc-js ^1.14.5 (via firebase client, aligné sur la chaîne firebase-admin ; le fix npm --force = downgrade firebase@9 REFUSÉ), dompurify ^3.4.16 (DOM XSS GHSA-p98j-92pf-mc4p via monaco-editor), undici 7.30.0 (9 advisories DoS/TLS/cookies via @qdrant + openai/composio, resté en 7.x). npm audit --omit=dev : 0 vulnérabilité.
  ④ PREMIÈRE ALERTE SAST CORRIGÉE : sanitizeRedirect (auth-client) — bypass WHATWG « /\\evil.com » interprété « //evil.com » (redirection protocol-relative) malgré les gardes startsWith ; désormais la cible est résolue par URL et l'origine résolue doit être same-origin. +5 tests dédiés.
- TESTS RÉELS (règle 5) : +8 (ci-pipeline.test.ts : cache sur les 2 jobs avec comptage anti-suppression, régression des portes, gitleaks conservé, déclencheurs/permissions/v3 CodeQL) + 5 (auth-redirect.test.ts). Suite : 1018 verts / 128 fichiers, typecheck 0, lint 0, compilation OK, budget 100 % OK.
- VÉRIFICATION CI RÉELLE (API GitHub Actions) : commit 9db401a → CI success (audit deps VERT) + CodeQL success ; Vercel success ; 0 alerte bloquante.
- TRIAGE DES 30 ALERTES CODEQL (backlog SAST neuf, à traiter par lot — enregistré pour les prochaines sessions) :
  · CORRIGÉ (c56b3a6) : js/client-side-unvalidated-url-redirection (auth-client).
  · PRODUCTION lib/ — P1 : js/double-escaping ×2 + js/incomplete-multi-character-sanitization ×2 (lib/tools/web/search.ts:405, lib/knowledge/ingestion.ts:39/103) ; js/bad-tag-filter ×3 (web/open.ts:49, knowledge/ingestion.ts:40, agents/watch-sources.ts:42 — normalisation de contenu pour hash, vérifier la couche de rendu avant de « durcir ») ; js/regex/missing-regexp-anchor (integrations/twentyfirst/client.ts:202) ; js/file-system-race (lib/tools/files/create-zip.ts:71).
  · PRODUCTION lib/ — P2 : js/incomplete-url-substring-sanitization ×12 (lib/research/v2/normalizer.ts — normalisation de recherche, faible exposition).
  · OUTILS/DEV (non exposés) : verify_*.mjs ×9, check_bundle_budget.mjs, diag_oauth_redirect.mjs ×2.
  · SERVICES ANNEXES : live-agent/src/index.ts ×5 (log-injection, file-access-to-http, file-system-race, resource-exhaustion), sandbox/src/server.ts:17 (missing-rate-limiting — à traiter en P1 lors d'un lot dédié), public/sw.js:265 (missing-origin-check — à analyser : les postMessages proviennent du SW propre).
- LIMITE DOCUMENTÉE : les 29 alertes restantes nécessitent une analyse de flux de données par site — aucun correctif « à l'aveugle » (règle 4) ; le backlog ci-dessus est l'entrée du prochain lot.
- COMMIT/PUSH : 88cdc35 (cache+CodeQL), 9db401a (0 vulnérabilité), c56b3a6 (sanitizeRedirect) → origin/main.

Task 51 — Rechargement automatique du navigateur après chaque build Vercel (demande utilisateur explicite : « après que Vercel a terminé le build, le navigateur doit pouvoir charger les modifications automatiquement ») — LIVRÉ (score auto-évalué 9,6/10)
- CONTEXTE : sandbox réinitialisé (dépôt recloné à 6e3ddf6, npm ci). Le couple étapes 11/19 ne détectait une mise à jour qu'aux revalidations navigateur de sw.js (navigation, retour d'onglet, poll 30 min) et n'allait jamais au-delà d'une bannière MANUELLE : un onglet ouvert inactif restait sur un build périmé jusqu'à 30 min après un déploiement, puis exigeait un clic.
- ANALYSE (règle 1) : pwa-register.tsx (détection reg.waiting/controllerchange + poll 30 min + visibilité ; reload caché gardé session, signal visible) ; update-banner.tsx = SEUL consommateur de gen3ia:new-version (vérifié par recherche : aucun autre) ; sw.js = network-first navigations + skipWaiting à l'installation → un reload simple sert le NOUVEAU build immédiatement (aucun changement SW requis, _next/static jamais cachés par le SW) ; middleware /api inclus sans garde d'auth (empreinte publique : dpl id + SHA publics) ; env Vercel runtime (VERCEL_DEPLOYMENT_ID, VERCEL_GIT_COMMIT_SHA) disponibles dans les fonctions ; contrat étape 19 « bannière ne recharge jamais d'elle-même » à faire ÉVOLUER (gardes structurels pwa-consistency à migrer, pas à contourner).
- CORRECTIFS (règle 2, zéro code de démonstration) :
  ① app/api/deploy-info/route.ts (NOUVEAU) : empreinte du déploiement actif — VERCEL_DEPLOYMENT_ID → VERCEL_GIT_COMMIT_SHA → GEN3IA_RELEASE (auto-hébergement) → local-dev ; lu À LA REQUÊTE (testable) ; Cache-Control no-store (une empreinte cachée ferait rater des déploiements — même raisonnement que sw.js étape 11) ; force-dynamic ; ULTRA-LÉGER contracté par test (seul import next/server — jamais Firebase/Supabase/DB, sondée ~90 s par onglet ouvert).
  ② components/deploy-watcher.tsx (NOUVEAU) : sonde /api/deploy-info toutes les 90 s ±25 % jitter (pas de vague synchronisée) + retour d'onglet (throttle 30 s) + retour réseau (événement natif online, indépendant de pwa-register) ; PREMIER relevé réussi = référence → boucle de rechargement impossible par construction (après reload, la référence relevée est le nouveau déploiement) ; écart → onglet caché = reload transparent gardé PAR CIBLE (gen3ia-deploy-reloaded:<id> en sessionStorage qui survit au reload — bascule d'infra plafonnée ; repli garde mémoire si stockage indisponible), onglet visible = signal gen3ia:new-version dédupliqué par cible ; AbortSignal.timeout 10 s (sonde pendue ne bloque pas la boucle) ; anti-concurrence checkInFlight ; échec réseau = cycle silencieux (jamais de reload hors-ligne) ; nettoyage complet (timer + listeners).
  ③ components/nav/update-banner.tsx (V2) : application AUTOMATIQUE au terme d'un compte à rebours VISIBLE de 10 s (annonce honnête « Rechargement automatique dans N s — Plus tard pour annuler ») ; « Recharger » = accélération immédiate, « Plus tard » = annulation (intervalle démonté via dismissed) ; RETENUE DE SAISIE : keydown/pointerdown < 4 s (capture+passive) → rechargement différé (revérification 2 s) — jamais de coupure à la frappe, état annoncé (« dès la fin de votre saisie ») ; chaque NOUVELLE détection réarme l'annonce (setDismissed(false)) — jamais en boucle grâce à la déduplication par cible du watcher ; a11y conservée (role=status, aria-live=polite, nombre défilant aria-hidden — pas d'annonce par seconde) ; zéro rendu tant qu'aucune mise à jour (hydratation intacte) ; missions agents non perdues (exécution serveur, reprise non-amnésique Task 46).
  ④ app/layout.tsx : <DeployWatcher /> monté à côté de <UpdateBanner /> + commentaire Task 51 (l'ancien commentaire « geste explicite » était devenu faux).
- CONTRAT ÉVOLUÉ (assumé, traçable) : le garde pwa-consistency « la bannière ne recharge JAMAIS d'elle-même » (étape 19) est REMPLACÉ par le garde Task 51 « application automatique encadrée » (countdown + retenue + annulation) — évolution demandée par l'utilisateur, documentée dans le test lui-même ; les autres gardes étape 19 restent verts (signal, fuite, a11y, layout).
- TESTS RÉELS (règle 5) : +20 dans app/deploy-auto-update.test.ts (NOUVEAU) — endpoint COMPORTEMENTAL (GET réel : priorité Vercel, chaîne de repli commit→release→local-dev, empreinte jamais vide, lecture à la requête sur 2 appels, no-store strict, seul import next/server) + gardes watcher (référence au premier relevé, garde par cible, déduplication, déclencheurs, timeout, anti-concurrence, nettoyage) + gardes bannière v2 (countdown, retenue, annulation, réarmement, a11y, cleanup) + câblage layout. Suite complète : 1038 verts / 129 fichiers (1 skipped préexistant), typecheck 0, lint 0.
- BUILD : compilation ✓ (116 s, mode --experimental-build-mode compile après libération mémoire du sandbox : serveur dev scaffold arrêté puis RELANCÉ) ; phase lint/types interne de next build OOM-tuée (limite sandbox 4 Go, connue Tasks 48-50) — redondante avec les portes standalone (tsc --noEmit 0, eslint 0) et exécutée intégralement par Vercel. check:bundle 100 % OK, pire route /layout 183 kB gzip (+1 kB = watcher, seuil FAIL 240), zéro marqueur serveur-seul dans 300 routes.
- LIMITES DOCUMENTÉES : cadence de détection ≈ 90 s pour un onglet inactif (immédiat au retour d'onglet/réseau) — le polling en continu plus agressif ne serait pas gratuit côté serveur ; auto-hébergement hors Vercel = poser GEN3IA_RELEASE au déploiement (repli sinon local-dev → pas de détection, jamais de boucle) ; l'empreinte expose dpl-id/SHA (publics par conception).
- COMMIT/PUSH : 892d4a1 → origin/main (token utilisateur), 6 fichiers, +572/-35.

Task 51 — SONDES PROD (vérification réelle après déploiement)
- Vercel (API GitHub, commit 892d4a1) : success — « Deployment has completed » ; statut global du commit success.
- scripts/verify_task51_deploy_autoreload_prod.mjs : 7/7 VERTES — site vivant (200) ; /api/deploy-info LIVE avec VRAIE empreinte Vercel (deploymentId=dpl_GCBBxfRcusuU4q2eMF62YVxxpCRY) ; Cache-Control no-store actif en prod ; empreinte STABLE sur deux requêtes (sémantique de référence côté client confirmée) ; régressions nulles (sw.js max-age=0 must-revalidate + skipWaiting intacts).
- Note sonde : premier passage 6/7 — le ROUGE venait de la sonde elle-même (corps d'une Response relu après consommation au point 3) ; corrigé (37c08d9 : deux requêtes fraîches pour le test de stabilité), 7/7 au second passage. Le produit n'était pas en cause.
- EFFET PRODUCTION ATTENDU : chaque build Vercel terminé → les onglets ouverts (y compris PWA mobiles laissées ouvertes) le détectent en ≤ ~90 s (ou immédiatement au retour d'onglet/réseau) ; onglet caché = rechargement transparent ; onglet visible = bannière « Mise à jour prête » avec rechargement automatique dans 10 s (annulable, retenu pendant une saisie).

Task 52 — QUALITÉ DES RÉPONSES IA (demande utilisateur : « les réponses des agents IA et de la conversation soient claires et précises selon le sujet saisi, comparables aux résultats de ChatGPT à chaque requête ») — LIVRÉ (score auto-évalué 9,6/10)
- CONTEXTE : sandbox réinitialisé (dépôt recloné à 8d7d40c, npm ci). Analyse complète du pipeline de génération (Protocole ①) : SEPT écarts qualité identifiés — ① TOUS les chemins de réponse visibles passaient `preferFree: true` → le routeur choisissait openrouter « free » (roulette de modèles gratuits, jamais le meilleur fournisseur) ; ② /api/chat/message (chat générique) n'avait AUCUN system prompt (réponses sans cadre) + pas de nettoyage <think> + 100 messages empilés sans fenêtre ; ③ answerAsAgent : maxTokens 3000 (troncature) + pas de contrat de formatage ; ④ runChatTurn : system minimal sans règles de précision ; ⑤ executeLLM/executeSubAgent : livrables de mission sans contrat de présentation ; ⑥ synthèse de plan limitée à 700 tokens ; ⑦ le renderer markdown ne rendait NI tableaux NI séparateurs — toute sortie « style ChatGPT » à tableaux s'affichait en texte brut.
- CORRECTIFS (règle 2, zéro code de démonstration) :
  ① lib/ai/response-quality.ts (NOUVEAU, pur, sans dépendance) : `responseQualityMode()` (GEN3IA_RESPONSE_QUALITY = premium|free, défaut PREMIUM, valeur invalide → premium repli sûr, lecture à l'appel) ; `preferFreeForVisibleAnswers()` (false en premium → le routeur prend le MEILLEUR fournisseur configuré : openai 100 > anthropic 98 > glm 95 > groq 90 > agnes 85 > openrouter 80, mêmes replis automatiques) ; `RESPONSE_FORMAT_RULES` (contrat de présentation : langue de l'utilisateur, réponse directe dès la première ligne, structure markdown alignée sur le renderer réel — titres/listes/gras/tableaux —, précision et quantification selon le sujet, honnêteté absolue zéro invention, UNE question de clarification si ambiguïté, terminaison utile) ; `withResponseStyle()` (compose sans écraser un system existant, system complet sinon).
  ② CÂBLAGE routage qualité + contrat sur TOUS les chemins VISIBLES : runChatTurn (3 appels) + runAppTurn (2) + ensureArtifactInput + summarizePlanTurn (engine.ts : 7 sites, plus AUCUN `preferFree: true` codé en dur — garde structurel en test) ; answerAsAgent (chat-engine.ts : charte complétée par le contrat, maxTokens 3000→4096, reservedOutput 4096) ; /api/chat/message (system de qualité dès la première réponse via withResponseStyle(), assembleMessages fenêtre de contexte, stripThinkTags, maxTokens 4096, preferFree client ?? politique qualité) ; runner.ts executeLLM + executeSubAgent (contrat ajouté APRÈS les instructions owner — livrables de mission structurés).
  ③ TÂCHES INTERNES INTACTES (coût maîtrisé) : classifyRequest, planUniversalAgent, runAIJSON (intention/mémoire/prompt-enhancer), résumés vocaux conservent preferFree: true — verrouillé par test structurel.
  ④ lib/ui/markdown-blocks.ts (NOUVEAU, feuille pure) : parser markdown extrait du composant (testable sous Node) + support TABLEAUX (ligne d'en-tête + séparateur |---|---| avec alignements :---/---: + cellules découpées) et SÉPARATEURS (---, ***, ___) ; markdown.tsx consomme le parser et rend <table>/<thead>/<tbody>/<hr> en éléments React sûrs (jamais dangerouslySetInnerHTML), cellules passant par renderInline (gras/liens/code dans les cellules).
  ⑤ summarizePlanTurn : 700 → 1200 tokens (synthèse visible jamais tronquée).
- TESTS RÉELS (règle 5) : +39 — response-quality.test.ts (18 : modes env défaut/free/premium/invalide, contrat couvre les 6 exigences, composition avec/ sans system, intégralité préservée) ; ai-response-quality.test.ts (14 : answerAsAgent COMPORTEMENTAL — contrat injecté après la charte, preferFree false premium / true free via env, maxTokens 4096 —, gardes structurels anti-régression : zéro preferFree:true dans engine.ts, classification interne préservée, route chat générique câblée, runner livrables, JSON structurés non altérés, renderer tableaux/séparateurs) ; markdown-render.test.ts (13 : tableaux standard/alignements/cellules inline/fin propre, séparateurs, tiret simple non séparateur, code non interprété, non-régressions titres/listes/citations). Suite complète : 1077 verts / 132 fichiers (1 skipped préexistant), typecheck 0, lint 0.
- BUILD : compilation ✓ (mode --experimental-build-mode compile, mémoire sandbox libérée) ; phase lint/types interne OOM sandbox (connue Tasks 48-51, exécutée par Vercel, portes standalone 0). check:bundle 100 % OK, pire route /layout 183 kB gzip (inchangé, seuil FAIL 240), zéro marqueur serveur-seul dans 300 routes.
- LIMITES DOCUMENTÉES : le PLAFOND de qualité réel dépend des fournisseurs configurés en production — si seul OPENROUTER_API_KEY existe, premium route vers openrouter (comportement inchangé) ; pour l'effet maximal, configurer OPENAI_API_KEY ou ANTHROPIC_API_KEY ou GROQ_API_KEY (Vercel env, sans redéploiement du module : lecture à l'appel). GEN3IA_RESPONSE_QUALITY=free permet un retour au mode économique à tout moment. Le routage interne gratuit est un choix de coût assumé (classification/planification/mémoire — jamais visible).
- COMMIT/PUSH : Task 52 → origin/main (token utilisateur).

Task 52 — SONDES PROD (vérification réelle après déploiement)
- Vercel (API GitHub, commit 3b46d0f) : success — « Deployment has completed » ; dpl-id du commit : 3mVTwyWe85Dg2u4RwwKKeTFJXys6.
- scripts/verify_task52_response_quality_prod.mjs : 5/5 VERTES — site vivant (200, HTML Gen3ia) ; déploiement ACTIF = build du commit Task 52 (dpl-id Vercel du commit comparé à l'empreinte /api/deploy-info servie en production : dpl_3mVTwyWe85Dg2u4RwwKKeTFJXys6) ; empreinte STABLE sur seconde requête (comparaison identique au client Task 51 : deploymentId seul) ; régressions nulles (sw.js max-age=0 must-revalidate + skipWaiting, offline.html max-age=0).
- Note sonde : premier passage 3/5 — les deux ROUGE venaient de la sonde elle-même (champ sha inexistant dans la réponse deploy-info : la route ne sert que deploymentId + generatedAt volatil par conception ; le watcher client ne compare JAMAIS generatedAt — aucun risque de boucle, produit correct). Sonde corrigée (dpl-id du commit via statut GitHub + comparaison deploymentId), 5/5 au second passage. Le produit n'était pas en cause.
- EFFET PRODUCTION ATTENDU : à chaque requête, les réponses de la conversation et des agents sont désormais générées par le MEILLEUR fournisseur configuré (au lieu de la roulette de modèles gratuits), avec le contrat de présentation injecté (langue de l'utilisateur, réponse directe, structure markdown, précision selon le sujet, zéro invention) ; le chat générique possède enfin un system prompt et une fenêtre de contexte assemblée ; les tableaux et séparateurs des réponses sont réellement rendus. Pour l'effet maximal, configurer OPENAI_API_KEY ou ANTHROPIC_API_KEY (ou GROQ_API_KEY) dans Vercel ; GEN3IA_RESPONSE_QUALITY=free ramène le mode économique à tout moment.

---
Task ID: 53
Agent: Super Z (principal)
Task: Recommandation A de l'audit de production — « tâches longues : file d'attente asynchrone + runId + SSE ». Demande utilisateur : « Oui continue avec les recommandations restant ». Statut des recommandations avant ce lot : B dual-write (Task 43, code-ready), D alerte solde (Task 49), §4/§7 sécurité+CI (Task 50), E perf/cache (Task 48) — toutes LIVRÉES. Restaient : A (partielle : reprise manuelle Task 46 mais exécution toujours synchrone coupée par la fenêtre serverless), C orgId (partielle : observabilité org Task 43), backlog SAST P1/P2 (29 alertes CodeQL).

Work Log:
- ANALYSE (règle 1) : /api/agents/run exécutait AgentRuntime.run() DANS la requête HTTP sans export maxDuration (défaut plateforme ~10 s sur les fenêtres courtes, max 60 s) — une mission multi-étapes était coupée sans reprise automatique ; checkpoint runtime déjà solide (collection `executions`, saveCheckpoint après chaque lot, reprise non-amnésique initialOutputs Task 46) ; mécanisme de pause propre éprouvé (PauseRequestedError entre les lots, étapes restantes « pending », travail payé conservé) ; BullMQ ÉCARTÉ (worker process permanent incompatible serverless) → QStash (file HTTP Upstash, publiée vers un receiver signé) ; AUCUN appelant frontend sur /api/agents/run (API externe) → changement de contrat 202 sans impact UI ; 0 référence QStash existante.
- IMPLÉMENTATION (règle 2, zéro code de démonstration) :
  ① lib/queue/qstash.ts (NOUVEAU) : configuration lue À L'APPEL (QSTASH_TOKEN + QSTASH_CURRENT_SIGNING_KEY + QSTASH_NEXT_SIGNING_KEY — les trois requis, un receiver non vérifiable est refusé) ; publishMissionTick (POST /v2/publish/{url}, Upstash-Retries 3, Upstash-Delay pour le ré-enfilement, timeout 10 s, erreurs PROPAGÉES — un échec d'enfilement silencieux créerait une mission fantôme) ; verifyUpstashSignature — schéma officiel QStash HMAC-SHA256(clé, `clé\ncorps`), clé courante OU suivante (rotation), comparaison TEMPS CONSTANT (timingSafeEqual), parsing du header multi-signatures ; missionQueueConfigured() pour l'activation.
  ② lib/queue/mission-queue.ts (NOUVEAU) : document `missionQueue` = source de vérité du STATUT client (polling/SSE) tandis que le checkpoint runtime reste la vérité du TRAVAIL ; createQueuedMission (plan COMPLET exécutable stocké — seule mémoire entre deux ticks) ; claimMissionTick TRANSACTIONNEL : statut terminal → no-op, bail actif (90 s > fenêtre fonction) → no-op, sinon bail posé + attempts incrémentés DANS le même commit → exactement UN worker par tranche, reprise après kill plateforme à l'expiration du bail ; persistMissionProgress / finalizeMissionRun / markMissionEnqueueFailed fail-soft (un incident Firestore de statut ne masque jamais un travail réel) ; compactQueueStep (aperçus bornés 800 car.) ; decideNextTick PUR : ré-enfile une pause D'ÉCHÉANCE avec étapes restantes, jamais une pause UTILISATEUR (reprise jamais forcée) ni un statut terminal.
  ③ app/api/queue/mission-tick/route.ts (NOUVEAU receiver) : signature vérifiée AVANT tout parsing (corps brut), 401/413/400 défensifs, 503 si file non configurée ; claim → checkpoint runtime PRIME sur le plan du record (reprise : statuses + outputs réels) ; AgentRuntime avec batchDeadlineMs = now + 50 s (marge ≥ 10 s sous les 60 s) ; échec MÉTIER → mission « failed », réponse 2xx SANS redélivrance (re-exécuter automatiquement une mission facturée doublerait la facture — même règle que les timeouts non-retryables Task 45) ; échec INFRA → 5xx (QStash re-tente, le bail expire, le claim reprend depuis le checkpoint) ; ORDRE CRITIQUE documenté : finalisation (bail relâché) PUIS publish du tick suivant — un échec de publish laisse QStash re-tenter la délivrance courante sur un document re-claimable → auto-réparation, mission fantôme impossible ; mapping runtime→file explicite (pending/running impossibles en sortie traités comme pause d'échéance → auto-réparation).
  ④ lib/agents/runtime/runner.ts : RuntimeRunnerOptions + batchDeadlineMs (échéance horloge) + minBatchReserveMs (réserve 45 s par défaut) — AVANT chaque lot, si l'échéance ne laisse pas la réserve, PauseRequestedError est levée DIRECTEMENT (sans écriture de contrôle : aucune fausse demande de pause utilisateur) → chemin de pause propre éprouvé : checkpoint conservé, étapes restantes « pending », zéro appel payant démarré au-delà de l'échéance. Non défini = comportement identique au bit près (toutes les intégrations existantes).
  ⑤ app/api/agents/run/route.ts : branche ASYNC par défaut quand la file est configurée — createQueuedMission + publish → 202 {runId, executionId, status:"queued", statusUrl, streamUrl, pollSeconds} immédiat ; mode:"sync" explicite = exécution dans la requête (compatibilité intégrations) ; mode:"async" explicite + échec d'enfilement → 502 HONNÊTE + mission marquée failed (JAMAIS de repli synchrone silencieux : le client a demandé du détaché, un démarrage synchrone serait coupé sans qu'il le sache) ; mode auto + échec → repli synchrone journalisé ; export maxDuration = 60 ajouté au chemin sync (défaut plateforme ~10 s = coupure réelle corrigée).
  ⑥ app/api/agents/runs/[runId]/route.ts (NOUVEAU) : statut propriétaire-scopé (userId ≠ → 404 anti-énumération), runId validé, Cache-Control no-store, timeline compacte + compteur d'étapes restantes — JAMAIS le plan ni les payloads bruts.
  ⑦ app/api/agents/runs/[runId]/stream/route.ts (NOUVEAU, SSE) : EventSource natif (cookie de session same-origin) ; événements `progress` (dédupliqués par signature statut:updatedAt:pending) et `final` (completed/failed/cancelled/paused-utilisateur) ; fenêtre bornée 50 s + fermeture propre → EventSource se reconnecte automatiquement (la mission ne dépend JAMAIS de la connexion du spectateur) ; heartbeat `: ping` 15 s ; relevé Firestore 2 s (miroir de statut — aucun moteur LLM connecté) ; not_found → final immédiat.
  ⑧ lib/env/config-report.ts : groupe « queue-qstash » (fallback documenté : exécution synchrone limitée par la fenêtre serverless).
- TESTS RÉELS (règle 5) : +65 — qstash.test.ts (12 : schéma HMAC officiel, rotation de clés, multi-signatures, temps constant, corps modifié détecté, gardes de configuration, URL receiver) ; mission-queue.test.ts (17 : claim transactionnel bail/terminal/missing/expiration, décisions de ré-enfilement, fail-soft, bornes des aperçus, plan complet voyageant vers le receiver) ; mission-tick/route.test.ts (14 COMPORTEMENTAUX : sécurité 503/401/413/400 avant parsing, no-op sans ré-exécution, échéance → ré-enfilement avec ORDRE finalisation-avant-publish vérifié, checkpoint prime sur le record, pause utilisateur → terminaison, échec métier → 2xx sans redélivrance, échec infra → 5xx, origine forcée) ; agents/run/route.test.ts (8 : 202 immédiat sans exécution synchrone, 502 honnête mode async, replis auto/sync, guard projet avant enfilement, validation) ; stream/follow.test.ts (10 : 400/401, en-têtes SSE anti-buffering, progress/final, déduplication, not_found) ; batch-deadline.test.ts (4 : comportement SANS option inchangé 3 étapes complétées, échéance dépassée → pause propre avant tout appel payant, tranche exacte après un lot — horloge simulée déterministe, réserve personnalisée). Suite complète : 1142 verts / 138 fichiers (1 skipped préexistant), typecheck 0, lint 0.
- BUILD : compilation ✓ (mode --experimental-build-mode compile après arrêt du serveur dev scaffold — mémoire sandbox 4 Go connue Tasks 48-52 ; phase lint/types interne OOM, redondante avec les portes standalone tsc/eslint vertes et exécutée par Vercel). check:bundle 100 % OK — pire route /layout 183 kB gzip (INCHANGÉE : toute la file est serveur-seul, zéro octet client ajouté), zéro marqueur serveur-seul dans 303 routes.
- LIMITES DOCUMENTÉES : sémantique at-least-once — une étape coupée par la plateforme au cœur d'un lot peut être ré-exécutée par le tick suivant (même compromis que la reprise manuelle Task 46 ; le bail rend les doubles exécutions CONCURRENTES impossibles) ; activer la file = poser QSTASH_TOKEN + QSTASH_CURRENT_SIGNING_KEY + QSTASH_NEXT_SIGNING_KEY dans Vercel (Upstash Console — sans redéploiement, lecture à l'appel) ; sans ces variables, /api/agents/run reste synchrone (comportement d'avant, compatibilité totale) ; le chemin conversationnel /api/agent/chat reste streamant dans la requête (choix UX assumé : le streaming live ne passe pas par une file — sa reprise Task 46 + ETA Task 47 couvrent déjà les coupures) ; le suivi SSE est un miroir de statut — la reprise des livrables détaillés passe par le run lié au fil.
- SCORE AUTO-ÉVALUÉ (règle 3) : 9,6/10 — recommandation A de l'audit désormais LIVRÉE de bout en bout (file + runId + SSE + tranches bornées + auto-réparation), 1142 tests verts, zéro régression.

Stage Summary:
- Les missions longues survivent aux fenêtres serverless : 202 immédiat, exécution par tranches ré-enfilées (QStash), progression en SSE, runId de suivi — le client peut fermer l'onglet sans tuer une mission.
- Prochaines recommandations restantes : C (scoping orgId multi-tenant systématique — analyse d'applicabilité nécessaire : le modèle actuel est ownerId, les organisations existent via requireOrgContext), backlog SAST P1 (double-escaping ×2, incomplete-multi-char-sanitization ×2, bad-tag-filter ×3, missing-regexp-anchor, file-system-race), puis P2 (incomplete-url-substring-sanitization ×12).
