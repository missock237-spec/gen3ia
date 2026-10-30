import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * GARDE ANTI-CODE-MORT GLOBAL (itération 29, Job 478451).
 *
 * Constat d'audit : le motif « code mort livré en production » s'est produit
 * QUATRE fois — ErrorBoundary jamais monté (it.22), politique de sauvegarde
 * documentée sans implémentation (it.23), endpoints RGPD sans UI (it.25),
 * /api/settings/export-data orphelin (it.27). À chaque fois, le code était
 * testé vert, déployé… et inaccessible aux utilisateurs : personne ne
 * référence la route depuis l'interface.
 *
 * Ce garde croise SYSTÉMATIQUEMENT l'inventaire des endpoints
 * (`app/api/…/route.ts`) avec les fichiers atteignables par l'utilisateur
 * (`app/` hors `app/api/`, `components/`, `public/`, `middleware.ts`,
 * `next.config.*`). Il échoue à la CI dès qu'un endpoint apparaît SANS
 * aucune référence UI : la 5e occurrence du motif devient structurellement
 * impossible à livrer sans décision explicite (entrée dans la baseline).
 *
 * Baseline = registre HONNÊTE des endpoints actuels sans référence UI,
 * classés par motif. Deux règles d'hygiène :
 *  - une entrée de baseline qui DEVIENT référencée doit être retirée
 *    (la CI refuse les entrées obsolètes) ;
 *  - une entrée de baseline qui ne correspond à aucun endpoint réel est
 *    refusée (pas de registre fantôme).
 */

const RACINE = process.cwd();

/* ------------------------------------------------------------------ */
/* Walk du code source (hors node_modules — on ne descend que dans     */
/* les répertoires produit).                                           */
/* ------------------------------------------------------------------ */

function walk(rel: string, acc: string[] = []): string[] {
  const abs = path.join(RACINE, rel);
  if (!existsSync(abs)) return acc;
  for (const entry of readdirSync(abs)) {
    const relEntry = `${rel}/${entry}`;
    const absEntry = path.join(abs, entry);
    if (statSync(absEntry).isDirectory()) walk(relEntry, acc);
    else acc.push(relEntry);
  }
  return acc;
}

/** Endpoints = tous les fichiers app/api/**\/route.ts → chemin /api/… */
function inventorierEndpoints(): string[] {
  const fichiers = walk("app/api").filter((f) => f.endsWith("route.ts"));
  return fichiers
    .map((f) => f.replace(/^app\/api/, "").replace(/\/route\.ts$/, ""))
    .sort();
}

/** Fichiers « surface utilisateur » : le seul lieu où une route devient
 *  accessible à quelqu'un. Les tests, lib/ et docs ne comptent PAS :
 *  un endpoint testé mais jamais appelé depuis l'UI est précisément le
 *  motif que cette garde traque. */
function inventaireSurfaceUtilisateur(): string[] {
  const fichiers = [
    ...walk("app").filter((f) => !f.startsWith("app/api/")),
    ...walk("components"),
    ...walk("public"),
  ];
  for (const racine of ["middleware.ts", "next.config.ts", "next.config.js", "next.config.mjs"]) {
    if (existsSync(path.join(RACINE, racine))) fichiers.push(racine);
  }
  return fichiers;
}

/* ------------------------------------------------------------------ */
/* Baseline honnête — 62 endpoints orphelins au 2026-10-31 (it.51 ;      */
/* 103 à l'it.29, puis settings/export-data, tool-consents et           */
/* memory/consent câblés (it.29-30), le lot marketplace                 */
/* extensions/{installed,purchases,licenses,usage} câblé sur /extensions*/
/* (it.31), finance-unpaid, finance-cashflow, hr-training et            */
/* operations-maintenance câblés sur /business (it.33, lot 1/3),        */
/* hr-leaves, compliance-gdpr et documents-onboarding câblés sur        */
/* /business (it.35, lot 2/3), puis documents-contracts,                */
/* marketing-landing, marketing-webinar et automations câblés sur       */
/* /business (it.36, lot 3/3 — /business/pulse reste volontairement     */
/* sans vue lecture : mission agent POST coûteuse), puis les 6          */
/* doublons morts /orchestrator* SUPPRIMÉS (it.37 — la lib du workflow  */
/* d'approbation reste vivante via agent/chat/approve, ads/*,           */
/* messaging ; les entrées HTTP n'avaient AUCUN appelant, l'UI passe     */
/* par /api/team/[teamId]/orchestrator), puis RECULS DE /skills* et     */
/* /knowledge* vers « pre-ui-roadmap » (it.38 — API de données de       */
/* l'agent, UI classée LOT 6 du plan plateforme, décision produit        */
/* documentée ; total inchangé, classification corrigée), puis les 4     */
/* doublons morts /ads/{connect,connections,composio/*} SUPPRIMÉS        */
/* (it.39 — la connexion Composio vivante passe par la porte GÉNÉRIQUE  */
/* /api/integrations/composio/connect appelée par nova-chat +           */
/* connectors-panel ; /ads/generate + /ads/publish restent des candidats */
/* UI documentés — guide-technique), puis AFFINAGE DE CLASSIFICATION     */
/* (it.40 — total inchangé 81 : les 4 /admin/* audités 4 canaux (0       */
/* appelant UI, libs toutes vivantes) et /ads/{generate,publish} sont    */
/* reclassés en 2 catégories explicites : « conserver-motive » (outils   */
/* ops sans UI par conception : reconcile paiement Chariow, modération   */
/* avis, migration Firestore→R2) et « candidat-ui-documente » (API au    */
/* contrat produit : mfa-requirement dans enterprise-security.md,        */
/* generate/publish dans guide-technique — sous-statut it.39 élevé).     */
/* Puis it.41 : /ai/generate SUPPRIMÉ (doublon mort — le chemin LLM      */
/* vivant passe par les 26 consommateurs directs de lib/ai/router :      */
/* engines conversations, SDK v1/chat, training ; 4 canaux à zéro),      */
/* /agents/generate RECULÉ en « pre-ui-roadmap » (route génération de    */
/* config construite — LLM réel, billing, resolveAndHarden — décision    */
/* produit « système réservé » (demande n°5) et UI d'acceptation         */
/* classées LOT 3 du plan ; total 81→80). Puis it.43 : audit 4 canaux du */
/* 5e lot orphelin (6 endpoints) — /developer/secrets CÂBLÉ (panneau     */
/* Secrets dans l'onglet Extensions du portail développeur : GET refs,   */
/* PUT valeur, DELETE retrait — valeurs serveur uniquement, jamais       */
/* retournées), /storage/r2-diagnostic reclassé « conserver-motive »     */
/* (diagnostic ops double-garde, SEUL diagnostic R2 bout-en-bout depuis  */
/* le runtime prod), /workspace/conversations/search (décision produit   */
/* LOT 13 « Recherche globale »), /workspace/tasks/clarify,              */
/* /files/workspaces et /developer/simulation reculés                    */
/* « pre-ui-roadmap » (ateliers/étapes pas encore échus ; total RÉEL     */
/* 74→73 — RECTIFICATION du comptage : les totaux « 81/80 » cités aux    */
/* it.39-42 étaient surestimés de 6 (comptage embrassant les commentaires*/
/* de catégorie) ; le registre réel ci-dessus fait foi, 73 entrées).     */
/* Puis it.44 : /workspace/conversations/search CÂBLÉ — la Recherche     */
/* globale (LOT 13) est livrée dans la sidebar du chat : requête serveur */
/* débouncée (350 ms) vers /api/workspace/conversations/search via       */
/* authFetch, badge sémantique/titres, extrait du message retrouvé,      */
/* ouverture locale par serverId ou IMPORT fidèle via la porte détail    */
/* GET /api/workspace/conversations/[id] (ownership re-vérifié) ;        */
/* l'entrée sort du registre (total 73→72).                              */
/* Puis it.45 : AUDIT 4 CANAUX du 6e lot (10 orphelin-connu restants) —  */
/* AUCUN doublon mort, 10 portes réelles reclassées avec motif :         */
/* conserver-motive ×2 (/media/professeur-statut diagnostic ops de la    */
/* loi CONTRAINTE-ONDES, /monde/stats transparence publique + audit      */
/* ops), candidat-ui-documente ×4 (/deployments/create et                */
/* /tools/execute documentés au plan, /business/pulse exclusion          */
/* volontaire documentée au test studio métier, /provisioning/intent     */
/* concept post-SaaS #4 au CHANGELOG), pre-ui-roadmap ×4 (/neural/evolve */
/* console neuronale, /ia/auto-apprentissage/rapport carte live,         */
/* /observability/org vue usage org, /training/hub/inspect console Data) */
/* — la catégorie orphelin-connu est VIDÉ : registre 100 % motivé,       */
/* total inchangé 72. Classés par motif.                                */
/* Puis it.46 : ÉVOLUTION PILOTÉE — la porte /neural/evolve est CÂBLÉE   */
/* dans l'onglet Cerveau de la console neuronale (métriques GET via      */
/* useTelechargement conditionné à l'onglet, POST « Consolider          */
/* maintenant » avec retour honnête enseignées/déjà connues/écartés/     */
/* sauvegarde + rafraîchissement cerveau+métriques ; 4 tests             */
/* structurels + verrou bidirectionnel) — l'entrée sort du registre      */
/* (pre-ui-roadmap 14→13, total 72→71).                                  */
/* Puis it.47 : HISTORIQUE COMPLET DES ÉVALUATIONS — la porte            */
/* /ia/auto-apprentissage/rapport est CÂBLÉE dans la carte               */
/* auto-apprentissage du chat (bloc dépliable chargé À LA DEMANDE via    */
/* onToggle — protocole restitué, sous-seuil « non comptable » signalé,  */
/* résumés par domaine, instantané daté, 4 tests structurels + verrou    */
/* bidirectionnel) — l'entrée sort du registre (pre-ui-roadmap 13→12,    */
/* total 71→70).                                                         */
/* Puis it.48 : INSPECTION RÉELLE DES JEUX DU HUB — la porte             */
/* /training/hub/inspect est CÂBLÉE dans la console Data (bouton         */
/* « Inspecter » sur chaque résultat de la recherche : licence, splits   */
/* déclarés, fichiers, échantillon réel, limites honnêtes restituées,    */
/* instantané daté — 4 tests structurels + verrou bidirectionnel) —      */
/* l'entrée sort du registre (pre-ui-roadmap 12→11, total 70→69).        */
/* Puis it.49 : KNOWLEDGE SPACES — ESPACE DOCUMENTS — la porte           */
/* /knowledge est CÂBLÉE dans l'espace Connaissances (nouvelle page      */
/* /knowledge + components/knowledge/knowledge-console : GET liste       */
/* scopée par projet, POST ingestion fichiers multipart + JSON URL       */
/* (SSRF-guard serveur), DELETE retrait fragments+miroir ; résultats     */
/* par fichier restitués tels quels, allowlist page + entrée nav         */
/* secondaire + robots disallow ; 4 tests structurels + verrou           */
/* bidirectionnel) — l'entrée sort du registre (pre-ui-roadmap 11→10,    */
/* total 69→68).                                                         */
/* Puis it.50 : LOT 6 COMPLET — DÉCLENCHEURS + COMPÉTENCES — les 5        */
/* portes restantes du lot Knowledge Spaces sont CÂBLÉES dans l'espace    */
/* Connaissances (onglets secondaires chargés À LA DEMANDE, liens         */
/* profonds #declencheurs/#competences) : Déclencheurs d'ingestion        */
/* (GET/POST /api/knowledge/triggers — règle any/filename_contains/       */
/* mime_type → mission RÉELLE enfilée à l'ingestion d'un document         */
/* correspondant, agent cible choisi parmi les agents actifs du Studio    */
/* et validé serveur, jetons {{document.*}} annoncés ; PATCH/DELETE       */
/* [id] activer/pause/supprimer) et Compétences (GET /api/skills          */
/* bibliothèque système+privées actives, POST /api/skills/create Skill    */
/* Factory LOCALE déterministe — zéro service externe, POST               */
/* /api/skills/import catalogue skills.sh idempotent restitué item par    */
/* item) ; 4 tests structurels + verrou bidirectionnel (19ᵉ) — les 5      */
/* entrées sortent du registre (pre-ui-roadmap 10→5, total 68→63).        */
/* Puis it.51 : USAGE PAR ORGANISATION — la porte /observability/org est  */
/* CÂBLÉE dans la vue entreprise (nouvelle page /observability/org +      */
/* components/observability/org-usage-console : GET /api/organizations   */
/* pour le sélecteur (rôle + membres restitués), GET /api/observability/ */
/* org?orgId=…&days=… pour l'usage agrégé — totaux, adoption par agent,  */
/* outils, activité quotidienne, membres couverts ; 404 uniforme de la   */
/* porte (org absente OU non-membre) restitué tel quel, garde            */
/* anti-course, allowlist page + entrée nav secondaire + lien croisé     */
/* depuis la vue personnelle ; 4 tests structurels + verrou              */
/* bidirectionnel (20e) — l'entrée sort du registre (pre-ui-roadmap      */
/* 5→4, total 63→62).                                                    */
/* Puis it.52 : LE LIVE PASSE AU MOTEUR INTERNE GEN3 — demande           */
/* propriétaire (« activation depuis le Chat IA, live en interne avec    */
/* gen3 ») : le canal externe « Gemini Live » (clé opérateur, service    */
/* tiers) est RETIRÉ (panneau, client, tests, doc — 4 fichiers           */
/* supprimés) et remplacé sous le chat par le panneau INTERNE            */
/* components/live/live-interne-panel (mêmes portes que /live : POST     */
/* /api/live/sessions + /start + frames + approve HITL + stop, moteur    */
/* de vision interne lib/live/vision-decider ; écran PC getDisplayMedia  */
/* OU caméra mobile getUserMedia — la caméra redevient accessible SANS   */
/* service externe) ; l'espace /live devient la surface de suivi HITL    */
/* avec renvoi honnête vers le chat ; verrou bidirectionnel (21e).       */
/* Puis it.53 : UN SEUL EXÉCUTEUR, DEUX SURFACES — la boucle de capture   */
/* navigateur du live (armement, getDisplayMedia/getUserMedia, frames,   */
/* journal, HITL inline, arrêt) vivait en DEUX COPIES divergentes        */
/* (panneau du chat vs dashboard /live — la copie dashboard avait perdu  */
/* la caméra et la carte d'approbation inline) : elle est EXTRAITE dans  */
/* l'exécuteur UNIQUE components/live/live-executeur, consommé par le    */
/* chat ET par /live (« Tester dans ce navigateur ») — le dashboard      */
/* gagne la caméra mobile et la carte HITL inline, les codes terminaux   */
/* de la porte frames (LIVE_STOPPED/EXPIRED/FAILED/DEVICE_MISMATCH)      */
/* arrêtent proprement la boucle, jeton de génération anti-course        */
/* (StrictMode) ; PERMISSION_LABELS unifiés dans lib/live/types ;        */
/* 3 tests structurels du panneau réécrits + 4 tests de l'exécuteur +    */
/* verrou bidirectionnel (22e).                                          */
/* Puis it.54 : UN SEUL BOUTON, L'APPAREIL DÉTECTÉ PAR LE SYSTÈME —       */
/* demande propriétaire : le choix manuel Écran PC / Caméra mobile est   */
/* SUPPRIMÉ de la carte d'activation du chat ET du dashboard — le        */
/* SYSTÈME détecte l'appareil via la capacité réelle du navigateur       */
/* (getDisplayMedia = ordinateur, sinon caméra = téléphone) et l'        */
/* exécuteur reconfirme au démarrage (bascule automatique annoncée,      */
/* source déclarée à la porte /start) ; ANOMALIE CORRIGÉE au passage :   */
/* la garde LIVE_PC_ONLY inconditionnelle de /start bloquait la caméra   */
/* mobile promise par it.52 — elle ne s'applique plus qu'au partage      */
/* d'écran (la caméra est honnête partout) ; picker d'arrêt conservé     */
/* en override manuel ; verrou bidirectionnel (23e).                     */
/* Puis it.55 : DÉBLOCAGE DU VOLET BUSINESS — demande propriétaire : la   */
/* suite métier (12 modules CRUD réels) était complète mais 403 par       */
/* défaut allowlist : "/business" + "/api/business" ajoutés à la liste    */
/* blanche (famille studio, requireUser + scoping par route), copie 403  */
/* mise à jour, verrou test inversé — pulse garde son exclusion          */
/* volontaire de la vue lecture.                                         */
/* Puis it.56 : LE CERVEAU À UN MILLION DE NEURONES — demande            */
/* propriétaire : CORTEX_CONFIG_DEFAUTS.colonnes = 1 048 576 (2^20, ×4)  */
/* — neurones spiking réels en TypedArrays, coût ∝ activité ; BUS D'ONDES */
/* INTER-RÉGIONS (lib/neural/core/v2/bus-ondes-regions.ts) : canal       */
/* HORIZONTAL du champ cortical — les bandes d'intention émettent des    */
/* paquets d'onde (porteur fréquentiel VOCABULAIRE par bande, région     */
/* émettrice en rotation déterministe), les 1000 régions résonnent par   */
/* couplage de Kuramoto (renfort en phase, annulation en opposition),    */
/* intégré À CHAQUE CYCLE via EffecteurCortexV2 + télémétrie busOndes ;  */
/* MÉTABOLISME V2 (MetabolismePasV2 : évaluées/reposées/transmissions/ms */
/* mesurés par pas) ; doc docs/cerveau/architecture-cible-1m.md (loi     */
/* CONTRAINTE-ONDES formalisée) ; verrou bidirectionnel (24e).           */
/* Puis it.57 : ENTRAÎNEMENT PAR ONDES DE DOMAINE (EOD) — demande         */
/* propriétaire : NOUVEAU moyen d'entraînement selon les domaines CHOISIS */
/* (lib/neural/training/entrainement-ondes.ts) : 1) ANALYSE DES ONDES —   */
/* chaque token devient un paquet [fréquence, phase, amplitude]           */
/* déterministe ; 2) TRAITEMENT DES ONDES — la colonne cible est dérivée  */
/* de l'ONDE (sin phase + porteur), intensité = amplitude ; 3)            */
/* CONSOLIDATION ONDULAIRE — plasticité supervisée vers la bande-porteuse */
/* du domaine (porteur ω dérivé du label, même vocabulaire que le bus)    */
/* + émission au bus inter-régions (la « partie » du domaine grandit) ;   */
/* branchée sur POST /api/neural/train { source: "ondes", domainesOndes } */
/* + rapport honnête par domaine (résonance, paquets, métabolisme cumulé) */
/* + doc docs/entrainement/methode-ondes.md ; verrou bidirectionnel (25e).*/
/* Réviser à chaque suppression/ajout d'UI.                              */
/* ------------------------------------------------------------------ */

const BASELINE_ORPHELINS: Record<string, string[]> = {
  /** Déclenchés par l'infrastructure (cron Vercel, workers, webhooks
   *  externes, sondes) — jamais par le navigateur. */
  "infra-externe": [
    "/ads/callback",
    "/cron/cleanup-invitations",
    "/cron/knowledge-ingest",
    "/cron/observability",
    "/cron/training-sweep",
    "/cron/workflow-triggers",
    "/health/infra",
    "/public/health",
    "/queue/dispatch-tick",
    "/queue/mission-tick",
    "/training/worker",
    "/video/worker/production-tick",
    "/video/worker/tick",
    "/webhooks/chariow",
    "/workflows/triggers/webhook/[token]",
  ],
  /** Appelés côté serveur par des chaînes lib/ vivantes (files d'attente,
   *  clients d'agents, SDK interne, upload R2…) — la surface utilisateur
   *  est en amont dans la chaîne. */
  "chaine-serveur-lib": [
    "/agents/plan",
    "/agents/runs/[runId]",
    "/agents/runs/[runId]/stream",
    "/agents/system/activate",
    "/auth/r2/password-reset",
    "/auth/r2/password-reset/confirm",
    "/billing/api-usage",
    "/documents/[artifactId]",
    "/essaim/canal",
    "/essaim/job/[id]",
    "/essaim/ondes",
    "/essaim/resultat",
    "/extensions/entitlements",
    "/files/read",
    "/files/write",
    "/identity/twin",
    "/integrations/composio/tools",
    "/networks",
    "/networks/[id]",
    "/networks/[id]/run",
    "/ondes/rpia",
    "/ondes/signaling",
    "/storage/permanent/commit",
    "/storage/permanent/session",
  ],
  /** Consommés par des clients hors dépôt app : SDK public, extension
   *  navigateur, bridge d'entraînement. */
  "api-publique-sdk": [
    "/capabilities",
    "/public/sdk/download",
    "/v1/capabilities",
    "/v1/chat",
    "/v1/essaim/manifeste",
    "/v1/wallet",
  ],
  /** Endpoints PRÉ-UI (roadmap LOT 6 du plan plateforme) : la LIB et la
   *  porte HTTP sont DÉJÀ construites et vivantes côté agent (tool
   *  knowledge.search enregistrée dans le runtime, catalog capacités),
   *  l'UI de gestion n'est PAS ENCORE ÉCHUE — décision produit documentée
   *  (docs/plan-plateforme-enterprise.md : « Skills backend réels, zéro
   *  UI — pas de @Skills dans le composer », « UI Knowledge Spaces »
   *  classée LOT 6). Constat it.38 : 4 canaux vérifiés (aucun fetch
   *  frontend, aucun fetch serveur, SDK hors scope, tests = unitaires lib)
   *  — ce ne sont NI des candidats UI imminents NI des doublons morts :
   *  ce sont les API de données de l'agent, en attente de leur LOT.
   *  it.41 : /agents/generate rejoint cette catégorie — la ROUTE de
   *  génération de config par langage naturel est construite (LLM réel,
   *  billing Task 153, resolveAndHarden outils réels) mais l'UI
   *  d'acceptation est classée LOT 3 du plan (priorité Bas) et la
   *  décision produit « système réservé » (demande n°5 : les users
   *  passent par le chat, l'admin conservé) est codée en dur dans
   *  lib/security/agent-system-access.ts.
   *  it.43 : 3 portes reculées ici après audit 4 canaux —
   *   - /workspace/tasks/clarify : clarification plan-mode (lib/ai/router
   *     + repli heuristique) — panneau tâches existant, étape pas échue.
   *   - /files/workspaces : création d'espace d'exécution — chaîne lib
   *     vivante (serverless-exec, user-terminal, file-engine, create-zip),
   *     sonde e2e_cycle01, UI atelier pas échue.
   *   - /developer/simulation : simulation SANS side-effect (VM V8
   *     restreinte / analyse statique) — chemin vivant côté runtime
   *     (secure-tool-executor), bouton « Simuler » de l'IDE pas échu.
   *  it.44 : /workspace/conversations/search SORT de cette catégorie —
   *  la Recherche globale (LOT 13) est CÂBLÉE dans la sidebar du chat
   *  (nova-chat : requête débouncée, badge sémantique/titres, extrait,
   *  ouverture locale par serverId ou import via la porte détail).
   *  it.45 : audit 4 canaux du 6e lot — 4 portes rejoint cette catégorie
   *  avec leur surface naturelle documentée (UI pas échue) :
   *   - /neural/evolve : télémétrie d'évolution RÉELLE (GET) + cycle de
   *     consolidation forcé (POST, auth + rate-limit + audit) — surface
   *     naturelle = console neuronale (components/neural/neural-console,
   *     vivante : brain/state/domaines/cycle/media/train) qui ne consomme
   *     pas encore cette porte ; cohérence cerveau métabolique (it.42).
   *     it.46 : SORT de cette catégorie — l'onglet Cerveau consomme
   *     désormais la porte (métriques GET + consolidation POST).
   *   - /ia/auto-apprentissage/rapport : HISTORIQUE COMPLET des
   *     évaluations (10/domaine, validité statistique honnête) — la carte
   *     auto-apprentissage du chat (vivante) ne consomme que le GET
   *     principal (dernière évaluation) ; l'extension « historique »
   *     est l'étape suivante naturelle.
   *     it.47 : SORT de cette catégorie — la carte consomme désormais la
   *     porte (bloc « Historique des évaluations » chargé au dépliage).
   *   - /observability/org : usage agrégé PAR ORGANISATION (Task 43,
   *     saas-roadmap §3) — requireOrgContext vérifie l'appartenance ; la
   *     vue usage org n'est pas encore une surface (UI pas échue).
   *     it.51 : SORT de cette catégorie — la vue entreprise
   *     (/observability/org + org-usage-console) consomme désormais la
   *     porte (sélecteur d'orgs + usage agrégé par agent / outil / jour).
   *   - /knowledge : ingestion RAG réelle (GET liste, POST
   *     fichiers/URL, DELETE) — API de données de l'agent, UI classée
   *     LOT 6 du plan plateforme (Knowledge Spaces).
   *     it.49 : SORT de cette catégorie — l'espace Connaissances
   *     (page /knowledge + knowledge-console) consomme désormais la
   *     porte dans ses trois modes.
   *   it.50 : les 5 entrées restantes du LOT 6 SORTENT de cette
   *   catégorie — l'espace Connaissances consomme désormais les portes
   *   déclencheurs (GET/POST /knowledge/triggers, PATCH/DELETE [id] :
   *   règles de correspondance → missions réelles, agent cible validé
   *   serveur) et compétences (GET /skills bibliothèque, POST /create
   *   Skill Factory locale déterministe, POST /import catalogue
   *   skills.sh idempotent) via deux onglets à la demande. */
  "pre-ui-roadmap": [
    "/agents/generate",
    "/developer/simulation",
    "/files/workspaces",
    "/workspace/tasks/clarify",
  ],
  /** VIDÉE à l'it.45 (audit 4 canaux du 6e lot) : les 10 dernières
   *  « vrais orphelins connus » ont été reclassées avec motif — voir les
   *  catégories conserver-motive, candidat-ui-documente et
   *  pre-ui-roadmap. Historique de la catégorie : /business/* (lot métier
   *  sans écran, câblé it.33/35), /settings/export-data (constat it.27,
   *  câblé it.29), /extensions/{installed,licenses,purchases,usage} (lot
   *  marketplace, câblé it.31) ; les doublons morts /orchestrator* ont
   *  été SUPPRIMÉS à l'it.37 ; les 6 /skills* + /knowledge* partis en
   *  « pre-ui-roadmap » à l'it.38 ; les 4 /admin/* + /ads/* en
   *  « conserver-motive » / « candidat-ui-documente » à l'it.40 ;
   *  /developer/secrets câblé et 5 entrées reclassées à l'it.43 ;
   *  /workspace/conversations/search câblé à l'it.44 (Recherche globale). */
  /** Outils d'EXPLOITATION (ops) invoqués par un opérateur authentifié
   *  (console, curl, cron VPS) — PAS D'UI par conception : l'utilisateur
   *  final n'a pas à déclencher un rapprochement de paiements ni une
   *  migration de stockage. Constat it.40 : audit 4 canaux des 4
   *  /admin/* — 0 fetch frontend, 0 fetch serveur, docs internes
   *  vérifiées, 0 test d'intégration UI ; chaque lib servie est vivante
   *  (webhook Chariow, repository extensions 16+ portes, moteur r2fs,
   *  mfa lecture via session+topup). Motivations :
   *   - /admin/billing/reconcile : rattrapage des livraisons Chariow
   *     coincées (Task 104-b) — le chemin de RECOUVREMENT du canal de
   *     paiement unique (règle plateforme) ; le webhook temps réel
   *     (/webhooks/chariow, vivant) ne couvre pas les baux expirés ;
   *     documenté docs/analyse-projet.md (rapprochement périodique).
   *   - /admin/extensions/reviews : modération hide/show des avis de la
   *     marketplace (repository vivant, signalements /reports existants)
   *     — l'UI admin de modération nécessiterait d'abord une route GET
   *     de liste (inexistante) : chantier documenté, pas une perte.
   *   - /admin/migrate-firestore-r2 : SEUL lecteur Firestore restant du
   *     projet (Task 111-b) — pont de migration 1:1 vers R2, relançable
   *     et idempotent, invocation ponctuelle opérateur par conception.
   *   - /storage/r2-diagnostic (it.43) : diagnostic R2 bout-en-bout
   *     exécuté depuis le runtime de production (config, connectivité,
   *     listing, création bucket, CORS, cycle put/get/delete) — double
   *     garde session ADMIN + header x-diag-secret à temps constant :
   *     outil opérateur (curl/console) par conception, jamais une UI.
   *   - /media/professeur-statut (it.45) : diagnostic ops du professeur
   *     média TEMPORAIRE (loi CONTRAINTE-ONDES — échafaudage externe tant
   *     que les poids média ne sont pas distillés dans le signal d'onde
   *     natif) : familles de chemins sondés, état de config SANS secret,
   *     ping TTS réel bout-en-bout ; lib vivante (media-service,
   *     capabilities) ; invocation opérateur par conception.
   *   - /monde/stats (it.45) : transparence PUBLIQUE de l'essaim global
   *     (admissions, refus, équité Jain, mémoire) — chiffres qui PROUVENT
   *     les garanties du répartiteur ; données volatiles sans auth par
   *     conception, consommé par l'audit ops scripts/audit-gardes-auth.mjs
   *     (liste « Stats publiques volatiles ») et toute sonde externe.
   *  Verrou dédié it.40 en fin de fichier (routes + libs + docs). */
  "conserver-motive": [
    "/admin/billing/reconcile",
    "/admin/extensions/reviews",
    "/admin/migrate-firestore-r2",
    "/storage/r2-diagnostic",
    "/media/professeur-statut",
    "/monde/stats",
  ],
  /** API documentées au CONTRAT PRODUIT sans appelant dans le dépôt :
   *  les supprimer serait un breaking change contractuel (leçon it.39
   *  §8.3 — « les API documentées ne sont pas du code mort »). Le câblage
   *  UI reste leur destin naturel — l'entrée sortira de la baseline le
   *  jour où une surface utilisateur consommera la porte.
   *   - /admin/security/mfa-requirement : politique MFA par compte
   *     (Task 63), documentée DEUX FOIS dans docs/enterprise-security.md
   *     (tableau des endpoints + « jamais par l'utilisateur ») ; lib
   *     mfa vivante côté lecture (auth/session, billing/topup) ; garde
   *     anti-locked-out : refuse tant qu'Identity Platform est inactif.
   *   - /ads/generate + /ads/publish : sous-statut implicite it.39
   *     élevé en catégorie explicite — guide-technique.md les documente
   *     (« Génération de contenu publicitaire multi-canal », « Publication
   *     de campagnes ») avec flux payant complet (wallet, media-meter,
   *     action-approvals).
   *   - it.45 (audit 4 canaux du 6e lot) :
   *     · /deployments/create — Deployments RÉELS (GitHub PAT plateforme +
   *       Vercel + Render) documentés au plan plateforme (inventaire
   *       « réel ») ; deployProject (lib/deployments/service) vivant.
   *     · /tools/execute — EXÉCUTION DURCIE documentée au plan
   *       (emergency-stop → permissions → audit toolAuditLogs) ; test
   *       agent-driven (lib) vérifie que la route autorise la suite ;
   *       executor.ts la nomme surface d'exécution à part entière.
   *     · /business/pulse — concept post-SaaS #7 (Autonomous Business
   *       Cloud) : KPIs réels + mission d'analyse bornée (dryRun, jamais
   *       de dépense) ; exclusion VOLONTAIRE de la vue lecture studio
   *       métier documentée au test business-dashboard (mission POST
   *       coûteuse) ; famille /business vivante (12 modules câblés).
   *     · /provisioning/intent — concept post-SaaS #4 (Intent-to-
   *       Infrastructure) documenté au CHANGELOG (vague Tasks 64–68) :
   *       une phrase → ressources réelles (agent, automatisation,
   *       planification, projet), dryRun. */
  "candidat-ui-documente": [
    "/admin/security/mfa-requirement",
    "/ads/generate",
    "/ads/publish",
    "/deployments/create",
    "/tools/execute",
    "/business/pulse",
    "/provisioning/intent",
  ],
  /** VIDÉ à l'it.45 : les 10 entrées du 6e lot ont été auditées 4 canaux
   *  et reclassées avec motif (conserver-motive ×2, candidat-ui-documente
   *  ×4, pre-ui-roadmap ×4 — voir ces catégories). Le registre est
   *  désormais 100 % motivé : plus AUCUN orphelin « connu » sans verdict.
   *  Toute NOUVELLE entrée ici devra passer le même audit. */
  "orphelin-connu": [],
};

/* Endpoints dont le câblage UI est une EXIGENCE produit (RGPD) — ils ne
 * doivent JAMAIS rejoindre la baseline. */
const RGPD_A_CABLAGE_OBLIGATOIRE = [
  "/account/export",
  "/auth/account",
  "/memory/export",
  "/memory/purge",
];

/* ------------------------------------------------------------------ */
/* Calcul partagé                                                      */
/* ------------------------------------------------------------------ */

const endpoints = inventorierEndpoints();
const surface = inventaireSurfaceUtilisateur();
const contenus = surface.map((f) => readFileSync(path.join(RACINE, f), "utf8"));

/** Clé de recherche : préfixe statique (coupe avant le 1er segment [dyn]) —
 *  une référence UI en template literal `/api/agents/${id}` contient le
 *  préfixe `/api/agents/`. */
const cleRecherche = (endpoint: string) => endpoint.split("[")[0];

const references = (endpoint: string) =>
  contenus.filter((c) => c.includes(cleRecherche(endpoint)));

const orphelinsCalcules = endpoints.filter((ep) => references(ep).length === 0).sort();

const baselineUnion = Object.values(BASELINE_ORPHELINS)
  .flat()
  .sort();

/* ------------------------------------------------------------------ */
/* Garde                                                               */
/* ------------------------------------------------------------------ */

describe("garde anti-code-mort — endpoints vs surface utilisateur (it.29)", () => {
  it("inventaire auto-protégé : le scan voit assez d'endpoints et de fichiers UI", () => {
    // Si ces planchers tombent à zéro, le walker est cassé et la garde
    // deviendrait vacuole (0 orphelin = tout passe). Planchers volontairement
    // sous les valeurs courantes (302 endpoints / ~240 fichiers UI).
    expect(endpoints.length).toBeGreaterThanOrEqual(250);
    expect(surface.length).toBeGreaterThanOrEqual(200);
    expect(endpoints.some((ep) => ep.includes("[id]"))).toBe(true);
  });

  it("chaque route.ts exporte au moins un gestionnaire HTTP", () => {
    const sansHandler = endpoints.filter((ep) => {
      const src = readFileSync(
        path.join(RACINE, `app/api${ep}/route.ts`),
        "utf8",
      );
      return !/export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/.test(
        src,
      );
    });
    expect(
      sansHandler,
      `Routes sans gestionnaire HTTP exporté (code mort pur) : ${sansHandler.join(", ")}`,
    ).toEqual([]);
  });

  it("aucun NOUVEL endpoint orphelin hors baseline — la 5e occurrence du motif code-mort est bloquée à la CI", () => {
    const horsBaseline = orphelinsCalcules.filter(
      (ep) => !baselineUnion.includes(ep),
    );
    expect(
      horsBaseline,
      `NOUVEAUX endpoints sans aucune référence UI — soit câbler l'UI, soit ` +
        `documenter une entrée motivée dans BASELINE_ORPHELINS ` +
        `(tests/unit/api-endpoints-dead-code-guard.test.ts) : ${horsBaseline.join(", ")}`,
    ).toEqual([]);
  });

  it("baseline sans entrée obsolète — une route désormais référencée sort du registre", () => {
    const obsoletes = baselineUnion.filter(
      (ep) => endpoints.includes(ep) && references(ep).length > 0,
    );
    expect(
      obsoletes,
      `Entrées de baseline devenues référencées — retirer de BASELINE_ORPHELINS : ${obsoletes.join(", ")}`,
    ).toEqual([]);
  });

  it("baseline couvre exactement les orphelins actuels (pas de registre fantôme, pas de trou)", () => {
    const fantomes = baselineUnion.filter((ep) => !endpoints.includes(ep));
    const manquants = orphelinsCalcules.filter(
      (ep) => !baselineUnion.includes(ep),
    );
    expect(fantomes, `Entrées baseline sans endpoint réel : ${fantomes.join(", ")}`).toEqual([]);
    expect(manquants, `Orphelins absents de la baseline : ${manquants.join(", ")}`).toEqual([]);
    expect(new Set(baselineUnion).size).toBe(baselineUnion.length);
  });

  it("les endpoints RGPD critiques restent câblés à l'UI (jamais en baseline)", () => {
    for (const ep of RGPD_A_CABLAGE_OBLIGATOIRE) {
      expect(endpoints, `${ep} doit exister`).toContain(ep);
      expect(
        references(ep).length,
        `${ep} (RGPD) n'est plus référencé depuis app/components/public — régressions it.25/it.27`,
      ).toBeGreaterThan(0);
      expect(baselineUnion, `${ep} ne doit JAMAIS être baseliné`).not.toContain(ep);
    }
  });

  it("les 6 doublons morts /orchestrator* restent SUPPRIMÉS (it.37) — la porte HTTP morte ne doit pas renaître", () => {
    // Constat it.37 : la lib du workflow d'approbation est VIVANTE
    // (agent/chat/approve avec UI notification-center, ads/generate,
    // ads/publish, integrations/messaging, autonomy-guard), mais ses 6
    // entrées HTTP /api/orchestrator* n'avaient AUCUN appelant : ni fetch
    // frontend, ni fetch serveur, ni SDK documenté. L'UI d'orchestration
    // passe par /api/team/[teamId]/orchestrator (adhésion équipe vérifiée).
    // Ces routes étaient donc des doublons morts : supprimées, pas câblées.
    const doublonsSupprimes = [
      "app/api/orchestrator/route.ts",
      "app/api/orchestrator/action-plan/route.ts",
      "app/api/orchestrator/actions/route.ts",
      "app/api/orchestrator/actions/[id]/approve/route.ts",
      "app/api/orchestrator/actions/[id]/execute/route.ts",
      "app/api/orchestrator/actions/[id]/reject/route.ts",
    ];
    for (const rel of doublonsSupprimes) {
      expect(
        existsSync(path.join(RACINE, rel)),
        `${rel} a été supprimé à l'it.37 (doublon mort sans appelant) — ne le recréez pas sans UI ; l'orchestration passe par /api/team/[teamId]/orchestrator`,
      ).toBe(false);
    }
    // La LIB du workflow reste vivante et consommée — si l'un de ces
    // fichiers disparaît, c'est une régression fonctionnelle (approbations
    // agent/chat, ads, messaging cassées), pas un nettoyage.
    const libVivantes = [
      "lib/agents/action-approvals.ts",
      "lib/orchestrator/team-coordination.ts",
      "app/api/team/[teamId]/orchestrator/route.ts",
      "app/api/agent/chat/approve/route.ts",
    ];
    for (const rel of libVivantes) {
      expect(
        existsSync(path.join(RACINE, rel)),
        `${rel} est VIVANT (consommé par l'UI ou d'autres entrées HTTP) — sa disparition est une régression, pas un nettoyage`,
      ).toBe(true);
    }
  });

  it("les 6 API /skills* + /knowledge* restent des portes PRE-UI vivantes (it.38) — ni supprimées ni câblées en avance de phase", () => {
    // Constat it.38 : ces 6 endpoints sont les API de DONNÉES de l'agent.
    // Leur lib est consommée par le runtime agent (tool knowledge.search
    // dans lib/agents/tool-resolver, catalog capacités) et la porte HTTP
    // est déjà construite (Zod, rate-limit, org-scoping). L'UI de gestion
    // est classée LOT 6 du plan plateforme — pas encore échue. Décision
    // produit documentée dans docs/plan-plateforme-enterprise.md.
    const portesPreUi = [
      "app/api/skills/route.ts",
      "app/api/skills/create/route.ts",
      "app/api/skills/import/route.ts",
      "app/api/knowledge/route.ts",
      "app/api/knowledge/triggers/route.ts",
      "app/api/knowledge/triggers/[id]/route.ts",
    ];
    for (const rel of portesPreUi) {
      expect(
        existsSync(path.join(RACINE, rel)),
        `${rel} est la porte de données de l'agent (LOT 6) — la supprimer détruirait l'infrastructure pré-UI`,
      ).toBe(true);
    }
    // La chaîne lib côté agent doit rester vivante (sinon l'outil agent
    // knowledge.search et le catalog capacités se cassent).
    const chainesLib = [
      "lib/knowledge/ingestion.ts",
      "lib/skills/repository.ts",
      "lib/capabilities/catalog.ts",
    ];
    for (const rel of chainesLib) {
      expect(
        existsSync(path.join(RACINE, rel)),
        `${rel} est le socle agent des API pre-UI — sa disparition est une régression fonctionnelle`,
      ).toBe(true);
    }
    // La décision produit doit rester documentée (anti-dérive : si le plan
    // change, mettre à jour CE verrou ET la catégorie pre-ui-roadmap).
    const plan = readFileSync(
      path.join(RACINE, "docs/plan-plateforme-enterprise.md"),
      "utf8",
    );
    expect(
      plan.includes("UI Knowledge Spaces"),
      "Le plan plateforme doit toujours référencer l'UI Knowledge Spaces (LOT 6) — catégorie pre-ui-roadmap à réviser sinon",
    ).toBe(true);
  });

  it("les 4 doublons morts /ads/{connect,connections,composio/*} restent SUPPRIMÉS (it.39) — la porte générique Composio est la voie vivante", () => {
    // Constat it.39 : la connexion Composio de la plateforme passe par la
    // porte GÉNÉRIQUE /api/integrations/composio/connect (nova-chat,
    // developer/tabs/connectors-panel) et /api/integrations/composio/
    // connections (integrations-workspace, nova-chat, lab ondes). Les
    // variantes /ads/* en dupliquaient la fonction pour 3 providers :
    // supprimées, pas câblées. /ads/callback reste (infra, référencé par
    // lib/ad-connections consommée par ad-publisher) ; /ads/generate et
    // /ads/publish restent des candidats UI documentés (guide-technique).
    const doublonsAds = [
      "app/api/ads/connect/route.ts",
      "app/api/ads/connections/route.ts",
      "app/api/ads/composio/connect/route.ts",
      "app/api/ads/composio/connections/route.ts",
    ];
    for (const rel of doublonsAds) {
      expect(
        existsSync(path.join(RACINE, rel)),
        `${rel} a été supprimé à l'it.39 (doublon de la porte générique /api/integrations/composio/connect) — ne le recréez pas sans UI`,
      ).toBe(false);
    }
    // Les chaînes vivantes doivent rester : porte générique Composio (UI),
    // campagnes (UI admin), placement, et les 2 candidats UI documentés.
    const chainesVivantes = [
      "app/api/integrations/composio/connect/route.ts",
      "app/api/integrations/composio/connections/route.ts",
      "app/api/ads/callback/route.ts",
      "app/api/ads/campaigns/route.ts",
      "app/api/ads/my-campaigns/route.ts",
      "app/api/ads/placement/route.ts",
      "app/api/ads/generate/route.ts",
      "app/api/ads/publish/route.ts",
      "lib/ads/ad-connections.ts",
      "lib/ads/ad-publisher.ts",
    ];
    for (const rel of chainesVivantes) {
      expect(
        existsSync(path.join(RACINE, rel)),
        `${rel} est VIVANT (UI générique, infra OAuth, ou candidat UI documenté) — sa disparition est une régression, pas un nettoyage`,
      ).toBe(true);
    }
  });

  it("les 4 outils ops /admin/* restent vivants avec leurs libs et leurs docs (it.40) — outils d'exploitation, pas du code mort", () => {
    // Constat it.40 : audit 4 canaux des 4 /admin/* — 0 fetch frontend,
    // 0 fetch serveur, docs vérifiées (analyse-projet, enterprise-security),
    // 0 test d'intégration UI. Ce sont des outils d'EXPLOITATION invoqués
    // par un opérateur authentifié (console/curl/cron VPS) : pas d'UI par
    // conception, pas des doublons morts. Leurs libs servies sont toutes
    // vivantes : /webhooks/chariow (porte temps réel du paiement),
    // repository extensions (16+ portes), moteur r2fs (chemin de données),
    // lib mfa (lecture via auth/session + billing/topup).
    const outilsOps = [
      "app/api/admin/billing/reconcile/route.ts",
      "app/api/admin/extensions/reviews/route.ts",
      "app/api/admin/migrate-firestore-r2/route.ts",
      "app/api/admin/security/mfa-requirement/route.ts",
    ];
    for (const rel of outilsOps) {
      expect(
        existsSync(path.join(RACINE, rel)),
        `${rel} est un OUTIL OPS documenté (catégorie conserver-motive / candidat-ui-documente) — sa suppression détruirait une capacité d'exploitation (recouvrement paiement, modération, migration, politique MFA)`,
      ).toBe(true);
    }
    // Les libs servies par ces outils doivent rester vivantes.
    const libsServies = [
      "lib/billing/chariow-delivery.ts",
      "lib/extensions/repository.ts",
      "lib/r2fs/store.ts",
      "lib/security/mfa.ts",
      "lib/security/admin-access.ts",
    ];
    for (const rel of libsServies) {
      expect(
        existsSync(path.join(RACINE, rel)),
        `${rel} est le socle d'un outil ops /admin/* — sa disparition est une régression fonctionnelle`,
      ).toBe(true);
    }
    // Anti-dérive documentaire : les docs qui justifient la classification
    // doivent continuer à référencer les outils (sinon, réviser les
    // catégories conserver-motive / candidat-ui-documente ET ce verrou).
    const analyseProjet = readFileSync(
      path.join(RACINE, "docs/analyse-projet.md"),
      "utf8",
    );
    expect(
      analyseProjet.includes("billing/reconcile"),
      "docs/analyse-projet.md doit toujours documenter le rapprochement Chariow — catégorie conserver-motive à réviser sinon",
    ).toBe(true);
    const docSecurite = readFileSync(
      path.join(RACINE, "docs/enterprise-security.md"),
      "utf8",
    );
    expect(
      docSecurite.includes("mfa-requirement"),
      "docs/enterprise-security.md doit toujours documenter la politique MFA admin — catégorie candidat-ui-documente à réviser sinon",
    ).toBe(true);
  });

  it("la porte LLM générique /ai/generate reste SUPPRIMÉE (it.41) — le chemin vivant passe par lib/ai/router consommée en direct", () => {
    // Constat it.41 : POST /api/ai/generate (passerelle LLM générique
    // requireUser) n'avait AUCUN appelant sur 4 canaux — ni fetch
    // frontend, ni fetch serveur, ni doc SDK (sdk.md ne la mentionne
    // pas), ni test d'intégration. La capacité LLM vit dans lib/ai/router
    // avec 26 consommateurs directs (engines conversations chat/plan/
    // turn/apps/training/media, SDK v1/chat, training assistant) : la
    // porte HTTP n'apportait rien et ouvrait une surface d'appel LLM
    // générique sans cas d'usage. Supprimée, pas câblée.
    expect(
      existsSync(path.join(RACINE, "app/api/ai/generate")),
      "app/api/ai/generate a été supprimé à l'it.41 (doublon mort — consommez lib/ai/router en direct comme les engines) — ne le recréez pas sans appelant",
    ).toBe(false);
    // Le chemin LLM vivant doit rester : la lib, le chemin conversations
    // (chat utilisateur réel), la porte SDK v1, et la porte pre-UI
    // /agents/generate (LOT 3) avec sa décision produit.
    const cheminVivant = [
      "lib/ai/router.ts",
      "lib/domain/conversations/engine-chat.ts",
      "app/api/v1/chat/route.ts",
      "app/api/agents/generate/route.ts",
      "lib/security/agent-system-access.ts",
      "lib/agents/system-activation.ts",
    ];
    for (const rel of cheminVivant) {
      expect(
        existsSync(path.join(RACINE, rel)),
        `${rel} est le chemin LLM VIVANT (libs consommées en direct, SDK, pre-UI LOT 3) — sa disparition est une régression, pas un nettoyage`,
      ).toBe(true);
    }
    // Anti-dérive roadmap : le plan doit toujours classer l'UI
    // d'acceptation de la génération d'agent (LOT 3) — sinon réviser la
    // catégorie pre-ui-roadmap ET ce verrou.
    const plan = readFileSync(
      path.join(RACINE, "docs/plan-plateforme-enterprise.md"),
      "utf8",
    );
    expect(
      plan.includes("UI d'acceptation"),
      "Le plan plateforme doit toujours référencer l'UI d'acceptation de la génération d'agent (LOT 3) — entrée pre-ui-roadmap /agents/generate à réviser sinon",
    ).toBe(true);
  });

  it("le panneau Secrets reste câblé et les 5 portes reculées it.43 restent vivantes avec leurs libs", () => {
    // Constat it.43 : audit 4 canaux du 5e lot orphelin (6 endpoints).
    //  - /developer/secrets : CÂBLÉ — panneau « Secrets… » dans l'onglet
    //    Extensions du portail développeur (GET refs déclarées/configurées,
    //    PUT valeur, DELETE retrait). Les valeurs sont stockées SERVEUR
    //    uniquement : l'API ne les retourne jamais, l'UI n'affiche que
    //    l'état « configuré / à définir ». requireDeveloperAccess (rôle
    //    développeur) + ownership extension vérifié côté route.
    //  - /storage/r2-diagnostic : outil OPS double-garde (session ADMIN +
    //    header x-diag-secret à temps constant) — SEUL diagnostic R2
    //    bout-en-bout exécuté depuis le runtime de production (config,
    //    connectivité, listing, création bucket, CORS, cycle
    //    put/get/delete). Invocation opérateur par conception.
    //  - /workspace/conversations/search : recherche sémantique de
    //    conversations (Qdrant + repli textuel R2, re-vérification
    //    d'ownership par getConversation) — décision produit LOT 13
    //    « Recherche globale » ; UI CÂBLÉE à l'it.44 (sidebar du chat,
    //    voir le verrou dédié it.44 ci-dessous).
    //  - /workspace/tasks/clarify : clarification plan-mode (lib/ai/router,
    //    repli heuristique sans 500) — étape du panneau tâches pas échue.
    //  - /files/workspaces : création d'espace d'exécution — chaîne lib
    //    vivante (serverless-exec, user-terminal, file-engine, create-zip).
    //  - /developer/simulation : simulation SANS side-effect (VM V8
    //    restreinte / analyse statique) — chemin vivant côté runtime
    //    (secure-tool-executor) ; bouton IDE pas encore échu.
    const panneau = readFileSync(
      path.join(RACINE, "components/developer/tabs/secrets-panel.tsx"),
      "utf8",
    );
    for (const fragment of [
      "/api/developer/secrets?extensionId=",
      '"/api/developer/secrets"',
      "type=\"password\"",
    ]) {
      expect(
        panneau.includes(fragment),
        `components/developer/tabs/secrets-panel.tsx doit continuer à câbler l'API /developer/secrets (fragment attendu : ${fragment})`,
      ).toBe(true);
    }
    const ongletExtensions = readFileSync(
      path.join(RACINE, "components/developer/tabs/extensions-panel.tsx"),
      "utf8",
    );
    expect(
      ongletExtensions.includes("secrets-panel"),
      "L'onglet Extensions doit continuer d'intégrer le panneau Secrets (câblage it.43)",
    ).toBe(true);
    // Les 6 portes du lot it.43 restent en place (câblée ou reculée
    // documenté) — leur suppression détruirait une capacité réelle.
    const portes = [
      "app/api/developer/secrets/route.ts",
      "app/api/storage/r2-diagnostic/route.ts",
      "app/api/workspace/conversations/search/route.ts",
      "app/api/workspace/tasks/clarify/route.ts",
      "app/api/files/workspaces/route.ts",
      "app/api/developer/simulation/route.ts",
    ];
    for (const rel of portes) {
      expect(
        existsSync(path.join(RACINE, rel)),
        `${rel} est une porte réelle du lot it.43 (câblée ou pre-UI/ops documentée) — sa suppression est une régression`,
      ).toBe(true);
    }
    // Les libs servies par ces portes doivent rester vivantes.
    const libsServies = [
      "lib/chat/vector-index.ts",
      "lib/chat/repository.ts",
      "lib/agents/planner/clarification.ts",
      "lib/execution/workspace-registry.ts",
      "lib/sandbox/simulation.ts",
      "lib/storage/permanent-user-storage.ts",
      "lib/security/timing-safe.ts",
      "lib/extensions/repository.ts",
    ];
    for (const rel of libsServies) {
      expect(
        existsSync(path.join(RACINE, rel)),
        `${rel} est le socle d'une porte du lot it.43 — sa disparition est une régression fonctionnelle`,
      ).toBe(true);
    }
    // Anti-dérive roadmap : le plan doit toujours classer la Recherche
    // globale (LOT 13) — depuis l'it.44 elle est CÂBLÉE (sortie du
    // registre pre-ui-roadmap) : l'assertion garde le cap produit.
    const plan = readFileSync(
      path.join(RACINE, "docs/plan-plateforme-enterprise.md"),
      "utf8",
    );
    expect(
      plan.includes("Recherche globale"),
      "Le plan plateforme doit toujours référencer la Recherche globale (LOT 13) — câblée en UI depuis l'it.44, à réviser sinon",
    ).toBe(true);
  });

  it("la Recherche globale reste câblée dans la sidebar du chat (it.44) — porte sémantique + ouverture sûre", () => {
    // Constat it.44 : la décision produit LOT 13 « Recherche globale » est
    // livrée dans la sidebar du chat (nova-chat). Le champ de recherche
    // câble la porte sémantique /api/workspace/conversations/search :
    // requête débouncée (350 ms) via authFetch (jamais de fetch brut),
    // badge de mode (sémantique = correspondance par le SENS du contenu /
    // titres = repli textuel), extrait du message retrouvé, et ouverture
    // d'un résultat : sélection locale par serverId si la conversation est
    // déjà en cache, sinon IMPORT fidèle via la porte détail
    // GET /api/workspace/conversations/[id] (ownership re-vérifié côté
    // route — une conversation d'un autre compte reste impossible à
    // ouvrir). Anti-réponse périmée : compteur d'ordre, une réponse
    // arrivée après une frappe plus récente est ignorée.
    const chat = readFileSync(path.join(RACINE, "components/chat/nova-chat.tsx"), "utf8");
    for (const fragment of [
      "/api/workspace/conversations/search?q=",
      "encodeURIComponent(requete)",
      "authFetch",
      "350",
      "ouvrirResultatRecherche",
      'role="button"',
      "nova-rg-badge",
      "sémantique",
      "r.excerpt",
      "r.messageCount",
      'c.serverId === resultat.conversationId',
      "/api/workspace/conversations/${encodeURIComponent(resultat.conversationId)}",
      "monOrdre !== ordreRechercheRef.current",
    ]) {
      expect(
        chat.includes(fragment),
        `components/chat/nova-chat.tsx doit continuer à câbler la Recherche globale (fragment attendu : ${fragment})`,
      ).toBe(true);
    }
    // La porte détail (import d'une conversation d'un autre appareil) et
    // la porte search restent en place — leur suppression casserait la
    // fonctionnalité livrée.
    const portes = [
      "app/api/workspace/conversations/search/route.ts",
      "app/api/workspace/conversations/[conversationId]/route.ts",
    ];
    for (const rel of portes) {
      expect(
        existsSync(path.join(RACINE, rel)),
        `${rel} est une porte réelle de la Recherche globale (LOT 13) — sa suppression est une régression`,
      ).toBe(true);
    }
  });

  it("le 6e lot orphelin (it.45) est entièrement reclassé — 10 portes réelles, libs vivantes, registre 100 % motivé", () => {
    // Constat it.45 : audit 4 canaux des 10 derniers « orphelins connus ».
    // AUCUN doublon mort : 10 portes réelles reclassées avec motif —
    //  conserver-motive ×2 :
    //   · /media/professeur-statut — diagnostic ops du professeur média
    //     TEMPORAIRE (loi CONTRAINTE-ONDES : échafaudage externe tant que
    //     les poids média ne sont pas distillés dans le signal d'onde
    //     natif) ; lib vivante (media-service + capabilities) ;
    //   · /monde/stats — transparence PUBLIQUE de l'essaim global
    //     (équité Jain, files bornées), consommée par l'audit ops
    //     scripts/audit-gardes-auth.mjs ;
    //  candidat-ui-documente ×4 :
    //   · /deployments/create — plan plateforme : « Deployments : GitHub
    //     + Vercel + Render réels via /api/deployments/create » ;
    //   · /tools/execute — plan plateforme : « Exécution durcie »
    //     (emergency-stop → permissions → audit toolAuditLogs) ;
    //   · /business/pulse — exclusion volontaire de la vue lecture
    //     documentée au test business-dashboard (mission POST coûteuse) ;
    //   · /provisioning/intent — concept post-SaaS #4 (vague Tasks 64–68
    //     documentée au CHANGELOG) ;
    //  pre-ui-roadmap ×4 :
    //   · /neural/evolve — surface naturelle = console neuronale vivante
    //     (cohérence cerveau métabolique it.42) ;
    //   · /ia/auto-apprentissage/rapport — carte auto-apprentissage
    //     vivante (historique complet = étape suivante) ;
    //   · /observability/org — vue usage org (Task 43, saas-roadmap §3) ;
    //   · /training/hub/inspect — console Data vivante (hub/search
    //     sibling déjà câblé).
    // Verrous structurels :
    expect(
      BASELINE_ORPHELINS["orphelin-connu"].length,
      "La catégorie orphelin-connu doit rester VIDÉE (registre 100 % motivé depuis l'it.45) — toute nouvelle entrée doit passer l'audit 4 canaux",
    ).toBe(0);
    // Les 10 portes du lot restent en place (reclassées, pas supprimées) —
    // leur suppression détruirait une capacité réelle.
    const portes = [
      "app/api/business/pulse/route.ts",
      "app/api/deployments/create/route.ts",
      "app/api/ia/auto-apprentissage/rapport/route.ts",
      "app/api/media/professeur-statut/route.ts",
      "app/api/monde/stats/route.ts",
      "app/api/neural/evolve/route.ts",
      "app/api/observability/org/route.ts",
      "app/api/provisioning/intent/route.ts",
      "app/api/tools/execute/route.ts",
      "app/api/training/hub/inspect/route.ts",
    ];
    for (const rel of portes) {
      expect(
        existsSync(path.join(RACINE, rel)),
        `${rel} est une porte réelle du 6e lot (reclassée avec motif à l'it.45) — sa suppression est une régression`,
      ).toBe(true);
    }
    // Les libs servies par ces portes doivent rester vivantes.
    const libsServies = [
      "lib/business/pulse.ts",
      "lib/deployments/service.ts",
      "lib/entrainement-auto/etat.ts",
      "lib/entrainement-auto/maitrise.ts",
      "lib/neural/professeur-media.ts",
      "lib/neural/media-service.ts",
      "lib/essaim-global/repartiteur.ts",
      "lib/neural/runtime.ts",
      "lib/observability/org-queries.ts",
      "lib/provisioning/intent.ts",
      "lib/execution/execution-gateway.ts",
      "lib/training/hub",
    ];
    for (const rel of libsServies) {
      expect(
        existsSync(path.join(RACINE, rel)),
        `${rel} est le socle d'une porte du 6e lot — sa disparition est une régression fonctionnelle`,
      ).toBe(true);
    }
    // Ancres documentaires des motifs (anti-dérive) : le plan plateforme
    // documente les contrats /deployments/create et /tools/execute ; le
    // CHANGELOG documente la vague post-SaaS ; la console Data consomme
    // déjà le sibling hub/search ; le test studio métier documente
    // l'exclusion volontaire du pulse ; la console neuronale est la
    // surface naturelle d'/neural/evolve.
    const plan = readFileSync(path.join(RACINE, "docs/plan-plateforme-enterprise.md"), "utf8");
    expect(plan.includes("/api/deployments/create"), "Le plan doit continuer à documenter Deployments via /api/deployments/create — motif candidat-ui-documente à réviser sinon").toBe(true);
    expect(plan.includes("/api/tools/execute"), "Le plan doit continuer à documenter l'exécution durcie /api/tools/execute — motif candidat-ui-documente à réviser sinon").toBe(true);
    const changelog = readFileSync(path.join(RACINE, "docs/journal/CHANGELOG.md"), "utf8");
    expect(changelog.includes("post-SaaS"), "Le CHANGELOG doit continuer à documenter la vague concepts post-SaaS (/business/pulse #7, /provisioning/intent #4) — motifs candidat-ui-documente à réviser sinon").toBe(true);
    const dataConsole = readFileSync(path.join(RACINE, "components/data/data-console.tsx"), "utf8");
    expect(dataConsole.includes("/training/hub/search"), "La console Data doit rester câblée au sibling /training/hub/search (l'inspection hub/inspect est câblée depuis l'it.48) — régression sinon").toBe(true);
    const testBusiness = readFileSync(path.join(RACINE, "tests/unit/business-dashboard.test.ts"), "utf8");
    expect(testBusiness.includes("/business/pulse reste"), "Le test studio métier doit continuer à documenter l'exclusion volontaire de /business/pulse (mission POST coûteuse) — motif candidat-ui-documente à réviser sinon").toBe(true);
    const consoleNeurale = readFileSync(path.join(RACINE, "components/neural/neural-console.tsx"), "utf8");
    expect(consoleNeurale.includes("/api/neural/brain"), "La console neuronale doit rester vivante — surface du système neuronal à réviser sinon").toBe(true);
    // it.46 : le câblage de la porte est maintenant RÉEL — verrouillé
    // aussi par le 15e test (évolution pilotée).
    expect(consoleNeurale.includes("/api/neural/evolve"), "La console neuronale doit rester câblée à la porte /api/neural/evolve (it.46, évolution pilotée) — régression sinon").toBe(true);
  });

  it("l'évolution pilotée reste câblée dans la console neuronale (it.46) — porte vivante, registre à jour", () => {
    // it.46 : la porte /neural/evolve est consommée par l'onglet Cerveau
    // de la console neuronale (métriques GET + consolidation POST
    // auditable, cohérence cerveau métabolique it.42) — l'entrée a quitté
    // pre-ui-roadmap (total 72→71).
    const consoleNeurale = readFileSync(path.join(RACINE, "components/neural/neural-console.tsx"), "utf8");
    expect(consoleNeurale.includes('onglet === "cerveau" ? "/api/neural/evolve" : ""'), "La console doit interroger les métriques d'évolution pendant l'onglet Cerveau — régression du câblage it.46").toBe(true);
    expect(consoleNeurale.includes('fetch("/api/neural/evolve", { method: "POST" })'), "Le bouton de consolidation doit poster vers /api/neural/evolve — régression du câblage it.46").toBe(true);
    expect(consoleNeurale.includes("Consolider maintenant"), "L'action de consolidation doit rester visible (bouton) — régression UI it.46").toBe(true);
    // La porte reste réelle (contrats GET + POST).
    expect(existsSync(path.join(RACINE, "app/api/neural/evolve/route.ts")), "La porte /api/neural/evolve est le socle de l'évolution pilotée — sa suppression est une régression").toBe(true);
    // Les libs servies restent vivantes.
    expect(existsSync(path.join(RACINE, "lib/neural/evolution.ts")), "lib/neural/evolution.ts est le moteur de l'évolution — sa disparition est une régression fonctionnelle").toBe(true);
    expect(existsSync(path.join(RACINE, "lib/neural/runtime.ts")), "lib/neural/runtime.ts est le socle du cerveau persisté — sa disparition est une régression fonctionnelle").toBe(true);
    // Le test structurel du composant reste en place.
    expect(existsSync(path.join(RACINE, "components/neural/neural-evolution-pilotee.test.ts")), "Le test structurel de l'évolution pilotée doit rester en place — il verrouille le contrat UI↔porte").toBe(true);
    // Registre : l'entrée est sortie (et n'est revenue dans aucune autre
    // catégorie).
    for (const [categorie, endpoints] of Object.entries(BASELINE_ORPHELINS)) {
      expect(endpoints, `/neural/evolve est CÂBLÉE depuis l'it.46 — elle ne doit plus figurer dans « ${categorie} »`).not.toContain("/neural/evolve");
    }
  });

  it("l'historique des évaluations reste câblé dans la carte auto-apprentissage (it.47) — porte vivante, registre à jour", () => {
    // it.47 : la porte /ia/auto-apprentissage/rapport est consommée par la
    // carte du chat (bloc dépliable chargé à la demande, honnêteté
    // statistique restituée) — l'entrée a quitté pre-ui-roadmap (71→70).
    const carte = readFileSync(path.join(RACINE, "components/chat/auto-apprentissage-carte.tsx"), "utf8");
    expect(carte.includes('fetch("/api/ia/auto-apprentissage/rapport", { cache: "no-store" })'), "La carte doit interroger la porte rapport (historique complet) — régression du câblage it.47").toBe(true);
    expect(carte.includes("onToggle={ouvrirRapport}"), "Le rapport doit être chargé À LA DEMANDE (dépliage) — régression du pattern it.47").toBe(true);
    expect(carte.includes("non comptable (sous-seuil)"), "Les évaluations sous-seuil doivent rester signalées (honnêteté statistique) — régression it.47").toBe(true);
    // La porte reste réelle (contrat GET exportable).
    expect(existsSync(path.join(RACINE, "app/api/ia/auto-apprentissage/rapport/route.ts")), "La porte /ia/auto-apprentissage/rapport est le socle de l'historique — sa suppression est une régression").toBe(true);
    // Les libs servies restent vivantes.
    expect(existsSync(path.join(RACINE, "lib/entrainement-auto/etat.ts")), "lib/entrainement-auto/etat.ts est l'état persisté des évaluations — sa disparition est une régression fonctionnelle").toBe(true);
    expect(existsSync(path.join(RACINE, "lib/entrainement-auto/maitrise.ts")), "lib/entrainement-auto/maitrise.ts est le calcul de maîtrise — sa disparition est une régression fonctionnelle").toBe(true);
    // Le test structurel du composant reste en place.
    expect(existsSync(path.join(RACINE, "components/chat/auto-apprentissage-rapport.test.ts")), "Le test structurel de l'historique doit rester en place — il verrouille le contrat UI↔porte").toBe(true);
    // Registre : l'entrée est sortie (et n'est revenue dans aucune autre
    // catégorie).
    for (const [categorie, endpoints] of Object.entries(BASELINE_ORPHELINS)) {
      expect(endpoints, `/ia/auto-apprentissage/rapport est CÂBLÉE depuis l'it.47 — elle ne doit plus figurer dans « ${categorie} »`).not.toContain("/ia/auto-apprentissage/rapport");
    }
  });

  it("l'inspection des jeux du hub reste câblée dans la console Data (it.48) — porte vivante, registre à jour", () => {
    // it.48 : la porte /training/hub/inspect est consommée par la console
    // Data (bouton « Inspecter » sur chaque résultat de la recherche hub :
    // licence, splits déclarés, fichiers, échantillon réel, limites
    // honnêtes restituées, instantané daté) — l'entrée a quitté
    // pre-ui-roadmap (70→69).
    const dataConsole = readFileSync(path.join(RACINE, "components/data/data-console.tsx"), "utf8");
    expect(dataConsole.includes("`/api/training/hub/inspect?${params.toString()}`"), "La console Data doit interroger la porte inspect (provider + ref) — régression du câblage it.48").toBe(true);
    expect(dataConsole.includes("non exposé par le hub"), "Les champs non exposés par le hub doivent rester signalés comme tels (honnêteté) — régression it.48").toBe(true);
    expect(dataConsole.includes("Inspection générée le"), "L'inspection doit rester datée (instantané, pas données vivantes) — régression it.48").toBe(true);
    // La porte reste réelle (contrat GET inspectHubDataset).
    expect(existsSync(path.join(RACINE, "app/api/training/hub/inspect/route.ts")), "La porte /api/training/hub/inspect est le socle de l'inspection des jeux — sa suppression est une régression").toBe(true);
    // Les libs servies restent vivantes.
    expect(existsSync(path.join(RACINE, "lib/training/hub/index.ts")), "lib/training/hub est la façade hub unifiée (search + inspect + import) — sa disparition est une régression fonctionnelle").toBe(true);
    // Le test structurel du composant reste en place.
    expect(existsSync(path.join(RACINE, "components/data/data-hub-inspect.test.ts")), "Le test structurel de l'inspection doit rester en place — il verrouille le contrat UI↔porte").toBe(true);
    // Registre : l'entrée est sortie (et n'est revenue dans aucune autre
    // catégorie).
    for (const [categorie, endpoints] of Object.entries(BASELINE_ORPHELINS)) {
      expect(endpoints, `/training/hub/inspect est CÂBLÉE depuis l'it.48 — elle ne doit plus figurer dans « ${categorie} »`).not.toContain("/training/hub/inspect");
    }
  });

  it("l'espace Connaissances reste câblé à la porte /knowledge (it.49) — porte vivante, registre à jour", () => {
    // it.49 : la porte /knowledge est consommée par l'espace Connaissances
    // (page /knowledge + knowledge-console : GET liste scopée par projet,
    // POST ingestion fichiers + URL, DELETE retrait — allowlist page,
    // entrée nav secondaire, robots disallow) — l'entrée a quitté
    // pre-ui-roadmap (69→68).
    const consoleData = readFileSync(path.join(RACINE, "components/knowledge/knowledge-console.tsx"), "utf8");
    expect(consoleData.includes("`/api/knowledge?projectId=${projectId}`"), "La console doit interroger la liste des documents scopée par projet — régression du câblage it.49").toBe(true);
    expect(consoleData.includes('authFetch("/api/knowledge", { method: "POST", body: form }'), "La console doit ingérer des fichiers via POST multipart — régression it.49").toBe(true);
    expect(consoleData.includes('`/api/knowledge?id=${id}`'), "La console doit permettre le retrait d'un document (DELETE) — régression it.49").toBe(true);
    expect(consoleData.includes("vide (aucun texte extrait)"), "Les documents vides doivent rester signalés comme tels (honnêteté d'ingestion) — régression it.49").toBe(true);
    // La page est réelle et allowlistée utilisateur.
    expect(existsSync(path.join(RACINE, "app/knowledge/page.tsx")), "La page /knowledge est la surface Knowledge Spaces — sa suppression est une régression").toBe(true);
    const userAccess = readFileSync(path.join(RACINE, "lib/security/user-access.ts"), "utf8");
    expect(userAccess.includes('"/knowledge": "connaissances"'), "La page /knowledge doit rester allowlistée utilisateur — régression d'accès it.49").toBe(true);
    // Les libs servies restent vivantes.
    expect(existsSync(path.join(RACINE, "lib/knowledge/ingestion.ts")), "lib/knowledge/ingestion.ts est le pipeline d'extraction+indexation — sa disparition est une régression fonctionnelle").toBe(true);
    // Le test structurel du composant reste en place.
    expect(existsSync(path.join(RACINE, "components/knowledge/knowledge-console.test.ts")), "Le test structurel de l'espace Connaissances doit rester en place — il verrouille le contrat UI↔porte").toBe(true);
    // Registre : l'entrée est sortie (et n'est revenue dans aucune autre
    // catégorie).
    for (const [categorie, endpoints] of Object.entries(BASELINE_ORPHELINS)) {
      expect(endpoints, `/knowledge est CÂBLÉE depuis l'it.49 — elle ne doit plus figurer dans « ${categorie} »`).not.toContain("/knowledge");
    }
  });

  it("les déclencheurs et les compétences restent câblés dans l'espace Connaissances (it.50) — 5 portes vivantes, registre à jour", () => {
    // it.50 : les 5 portes restantes du LOT 6 sont consommées par les
    // onglets à la demande de l'espace Connaissances — déclencheurs
    // (GET/POST /api/knowledge/triggers + PATCH/DELETE [id] : règles de
    // correspondance → missions réelles, agent cible actif validé serveur)
    // et compétences (GET /api/skills + POST /create + POST /import) —
    // elles ont quitté pre-ui-roadmap (68→63).
    const consoleData = readFileSync(path.join(RACINE, "components/knowledge/knowledge-console.tsx"), "utf8");
    // Les 5 portes sont toutes interrogées depuis la console.
    expect(consoleData.includes('authFetch("/api/knowledge/triggers", { cache: "no-store" })'), "La console doit interroger la liste des déclencheurs — régression du câblage it.50").toBe(true);
    expect(consoleData.includes('action: { type: "run_agent_mission", agentId: triggerAgent, objectiveTemplate: triggerObjectif.trim() }'), "La création de déclencheur doit poster l'action réelle (agent + objectif) — régression it.50").toBe(true);
    expect(consoleData.includes("`/api/knowledge/triggers/${trigger.id}`"), "La console doit permettre activer/pause/supprimer un déclencheur (PATCH/DELETE [id]) — régression it.50").toBe(true);
    expect(consoleData.includes('authFetch("/api/skills?status=active"'), "La console doit interroger la bibliothèque de compétences — régression it.50").toBe(true);
    expect(consoleData.includes('authFetch("/api/skills/create"'), "La Skill Factory locale doit rester joignable depuis la console — régression it.50").toBe(true);
    expect(consoleData.includes('authFetch("/api/skills/import"'), "L'import idempotent du catalogue skills.sh doit rester joignable — régression it.50").toBe(true);
    // Honnêteté conservée : idempotence restituée, agent actif exigé.
    expect(consoleData.includes("déjà dans la bibliothèque"), "L'idempotence de l'import doit rester restituée (déjà présent = rien d'écrit) — régression it.50").toBe(true);
    expect(consoleData.includes('agent.status === "active"'), "L'agent cible d'un déclencheur doit être choisi parmi les agents ACTIFS — régression it.50").toBe(true);
    // Les 5 portes restent réelles (contrats serveur intacts).
    for (const rel of [
      "app/api/knowledge/triggers/route.ts",
      "app/api/knowledge/triggers/[id]/route.ts",
      "app/api/skills/route.ts",
      "app/api/skills/create/route.ts",
      "app/api/skills/import/route.ts",
    ]) {
      expect(
        existsSync(path.join(RACINE, rel)),
        `${rel} est une porte réelle du LOT 6 (câblée it.50) — sa suppression est une régression`,
      ).toBe(true);
    }
    // Les libs servies restent vivantes.
    for (const rel of [
      "lib/knowledge/triggers.ts",
      "lib/skills/factory.ts",
      "lib/skills/sh-importer.ts",
      "lib/skills/repository.ts",
      "lib/skills/schema.ts",
    ]) {
      expect(
        existsSync(path.join(RACINE, rel)),
        `${rel} est le socle d'une porte câblée it.50 — sa disparition est une régression fonctionnelle`,
      ).toBe(true);
    }
    // Le test structurel du composant reste en place.
    expect(existsSync(path.join(RACINE, "components/knowledge/knowledge-console-onglets.test.ts")), "Le test structurel des onglets doit rester en place — il verrouille le contrat UI↔portes").toBe(true);
    // Registre : les 5 entrées sont sorties (et ne sont revenues dans
    // aucune autre catégorie).
    for (const [categorie, endpoints] of Object.entries(BASELINE_ORPHELINS)) {
      for (const entree of ["/knowledge/triggers", "/knowledge/triggers/[id]", "/skills", "/skills/create", "/skills/import"]) {
        expect(endpoints, `${entree} est CÂBLÉE depuis l'it.50 — elle ne doit plus figurer dans « ${categorie} »`).not.toContain(entree);
      }
    }
  });

  it("l'usage par organisation reste câblé dans la vue entreprise (it.51) — porte vivante, registre à jour", () => {
    // it.51 : la porte /observability/org est consommée par la vue
    // entreprise (page /observability/org + org-usage-console :
    // sélecteur d'orgs via /api/organizations, usage agrégé par
    // agent / outil / jour, membres couverts, 404 uniforme restitué tel
    // quel, garde anti-course) — l'entrée a quitté pre-ui-roadmap
    // (63→62).
    const consoleData = readFileSync(path.join(RACINE, "components/observability/org-usage-console.tsx"), "utf8");
    expect(consoleData.includes("`/api/observability/org?${params.toString()}`"), "La vue entreprise doit interroger la porte d'usage org (orgId + days) — régression du câblage it.51").toBe(true);
    expect(consoleData.includes('authFetch("/api/organizations", { cache: "no-store" })'), "Le sélecteur doit interroger les organisations réelles du compte — régression it.51").toBe(true);
    expect(consoleData.includes("usage.membersCovered"), "La vue doit restituer les membres couverts (preuve du périmètre organisation) — régression it.51").toBe(true);
    expect(consoleData.includes("aucun contenu conversationnel"), "L'honnêteté du périmètre (données agrégées) doit rester affichée — régression it.51").toBe(true);
    // La page est réelle et allowlistée utilisateur.
    expect(existsSync(path.join(RACINE, "app/observability/org/page.tsx")), "La page /observability/org est la surface entreprise — sa suppression est une régression").toBe(true);
    const userAccess = readFileSync(path.join(RACINE, "lib/security/user-access.ts"), "utf8");
    expect(userAccess.includes('"/observability/org": "observabilite"'), "La page /observability/org doit rester allowlistée utilisateur — régression d'accès it.51").toBe(true);
    // La porte reste réelle (contrat GET buildOrgUsageOverview).
    expect(existsSync(path.join(RACINE, "app/api/observability/org/route.ts")), "La porte /api/observability/org est le socle de la vue entreprise — sa suppression est une régression").toBe(true);
    // La lib servie reste vivante.
    expect(existsSync(path.join(RACINE, "lib/observability/org-queries.ts")), "lib/observability/org-queries.ts est l'agrégation d'usage org (I/O + pure) — sa disparition est une régression fonctionnelle").toBe(true);
    // Le test structurel du composant reste en place.
    expect(existsSync(path.join(RACINE, "components/observability/org-usage-console.test.ts")), "Le test structurel de la vue organisation doit rester en place — il verrouille le contrat UI↔porte").toBe(true);
    // Registre : l'entrée est sortie (et n'est revenue dans aucune autre
    // catégorie).
    for (const [categorie, endpoints] of Object.entries(BASELINE_ORPHELINS)) {
      expect(endpoints, `/observability/org est CÂBLÉE depuis l'it.51 — elle ne doit plus figurer dans « ${categorie} »`).not.toContain("/observability/org");
    }
  });

  it("l'agent live du chat reste sur le moteur interne gen3 (it.52) — portes vivantes, zéro canal externe", () => {
    // it.52 : demande propriétaire (« activation depuis le Chat IA, live
    // en interne avec gen3 ») — le canal externe « Gemini Live » (clé
    // opérateur, service tiers) est SUPPRIMÉ et remplacé sous le chat
    // par le panneau interne (mêmes portes que /live).
    const chat = readFileSync(path.join(RACINE, "components/chat/nova-chat.tsx"), "utf8");
    expect(chat.includes('import("@/components/live/live-interne-panel")'), "Le chat doit charger le panneau live INTERNE (lazy) — régression du câblage it.52").toBe(true);
    expect(chat.includes("live-gemini-panel"), "Plus AUCUNE référence au canal externe Gemini dans le chat — régression it.52").toBe(false);
    // Le panneau interne est réel (activation) et délègue l'exécution à
    // l'exécuteur unique (it.53) qui consomme les portes maison.
    const panel = readFileSync(path.join(RACINE, "components/live/live-interne-panel.tsx"), "utf8");
    expect(panel.includes('authFetch("/api/live/sessions", {'), "Le panneau interne doit créer des sessions réelles via la porte /api/live/sessions — régression it.52").toBe(true);
    const executeur = readFileSync(path.join(RACINE, "components/live/live-executeur.tsx"), "utf8");
    expect(executeur.includes("/actions/${pendingApproval.actionId}/approve`"), "L'approbation HITL doit rester possible depuis le chat (exécuteur unique) — régression it.52/it.53").toBe(true);
    expect(executeur.includes("navigator.mediaDevices.getUserMedia"), "La caméra mobile doit rester accessible via le moteur INTERNE (fallback honnête) — régression it.52/it.53").toBe(true);
    // Le canal externe est BIEN supprimé du dépôt (code + tests).
    expect(existsSync(path.join(RACINE, "app/live/live-gemini-panel.tsx")), "Le panneau Gemini externe doit rester supprimé (moteur interne gen3) — régression it.52").toBe(false);
    expect(existsSync(path.join(RACINE, "lib/live/gemini-live-client.ts")), "Le client Gemini externe doit rester supprimé — régression it.52").toBe(false);
    // Les portes internes et le moteur de vision restent vivants.
    expect(existsSync(path.join(RACINE, "app/api/live/sessions/route.ts")), "La porte /api/live/sessions est le socle du live interne — sa suppression est une régression").toBe(true);
    expect(existsSync(path.join(RACINE, "lib/live/vision-decider.ts")), "lib/live/vision-decider.ts est le moteur de vision INTERNE — sa disparition est une régression fonctionnelle").toBe(true);
    // L'espace /live reste la surface de suivi (renvoi honnête vers le chat).
    const dashboard = readFileSync(path.join(RACINE, "app/live/live-dashboard.tsx"), "utf8");
    expect(dashboard.includes("Le mode Live s&apos;active depuis le Chat IA"), "L'espace /live doit renvoyer honnêtement vers l'activation dans le chat — régression it.52").toBe(true);
    expect(dashboard.includes("LiveGeminiPanel"), "L'espace /live ne doit plus embarquer le canal externe — régression it.52").toBe(false);
    // Le test structurel du panneau reste en place.
    expect(existsSync(path.join(RACINE, "components/live/live-interne-panel.test.ts")), "Le test structurel du panneau interne doit rester en place — il verrouille le contrat UI↔portes").toBe(true);
  });

  it("l'exécution navigateur du live est UNIQUE — un seul exécuteur partagé par le chat et /live (it.53)", () => {
    // it.53 : la boucle de capture vivait en DEUX COPIES divergentes
    // (panneau du chat vs dashboard /live). Elle est désormais EXTRAITE
    // dans l'exécuteur unique components/live/live-executeur : toute
    // réapparition d'une boucle en copie est une régression.
    const panel = readFileSync(path.join(RACINE, "components/live/live-interne-panel.tsx"), "utf8");
    const dashboard = readFileSync(path.join(RACINE, "app/live/live-dashboard.tsx"), "utf8");
    const executeur = readFileSync(path.join(RACINE, "components/live/live-executeur.tsx"), "utf8");

    // L'exécuteur existe, est réel, et porte TOUTE la boucle (armement,
    // captures écran/caméra, frames, HITL, arrêt).
    expect(existsSync(path.join(RACINE, "components/live/live-executeur.tsx")), "L'exécuteur navigateur unique doit exister — régression it.53").toBe(true);
    expect(executeur.includes("/api/live/sessions/${sessionId}/start"), "L'exécuteur doit armer la session (POST /start) — régression it.53").toBe(true);
    expect(executeur.includes("navigator.mediaDevices.getDisplayMedia"), "L'exécuteur doit capturer l'écran PC — régression it.53").toBe(true);
    expect(executeur.includes("navigator.mediaDevices.getUserMedia"), "L'exécuteur doit capturer la caméra mobile — régression it.53").toBe(true);
    expect(executeur.includes("CODES_TERMINAUX"), "L'exécuteur doit arrêter la boucle sur les codes terminaux de la porte — régression it.53").toBe(true);
    expect(executeur.includes("generationRef"), "L'exécuteur doit être protégé contre le double-montage StrictMode (jeton de génération) — régression it.53").toBe(true);

    // Les DEUX surfaces consomment l'exécuteur — et NE COPIENT PLUS la boucle.
    expect(panel.includes('from "@/components/live/live-executeur"'), "Le panneau du chat doit déléguer l'exécution à l'exécuteur unique — régression it.53").toBe(true);
    expect(dashboard.includes('from "@/components/live/live-executeur"'), "Le dashboard /live doit exécuter via l'exécuteur unique — régression it.53").toBe(true);
    expect(dashboard.includes("getDisplayMedia"), "Le dashboard ne doit PLUS copier la boucle de capture (getDisplayMedia supprimé) — régression it.53").toBe(false);
    expect(dashboard.includes("captureAndSendFrame"), "Le dashboard ne doit PLUS copier la boucle de frames — régression it.53").toBe(false);
    expect(panel.includes("getDisplayMedia({") || panel.includes("getUserMedia"), "Le panneau ne doit PAS capturer (la sonde de capacité it.54 est licite, l'appel de capture ne l'est pas) — régression it.53").toBe(false);

    // L'unicité est vérifiée par balayage : un seul fichier client dans
    // components/live EFFECTUE la capture d'écran (l'exécuteur) — le
    // marqueur est l'APPEL de capture, la sonde de capacité it.54 du
    // panneau (Boolean(...?getDisplayMedia)) n'est pas une capture.
    const dossierLive = path.join(RACINE, "components/live");
    const fichiersAvecCapture = readdirSync(dossierLive).filter((file) =>
      file.endsWith(".tsx") && !file.endsWith(".test.ts") &&
      readFileSync(path.join(dossierLive, file), "utf8").includes("getDisplayMedia({"),
    );
    expect(fichiersAvecCapture, "Un SEUL composant client doit contenir la capture d'écran (l'exécuteur) — régression it.53").toEqual(["live-executeur.tsx"]);

    // Les labels de permissions ont une source unique (lib/live/types).
    expect(dashboard.includes('PERMISSION_LABELS } from "@/lib/live/types"') || dashboard.includes('import { PERMISSION_LABELS } from "@/lib/live/types"'), "Le dashboard doit consommer les labels partagés — régression it.53").toBe(true);
    expect(panel.includes('from "@/lib/live/types"'), "Le panneau doit consommer les labels partagés — régression it.53").toBe(true);

    // Le test structurel de l'exécuteur reste en place.
    expect(existsSync(path.join(RACINE, "components/live/live-executeur.test.ts")), "Le test structurel de l'exécuteur doit rester en place — régression it.53").toBe(true);
  });

  it("l'activation du live est UN SEUL BOUTON — l'appareil est détecté par le système (it.54)", () => {
    // it.54 : demande propriétaire (« le live agent doit s'activer à
    // travers un seul bouton et c'est le système qui doit détecter si
    // l'utilisateur utilise un PC ou un téléphone portable »).
    const panel = readFileSync(path.join(RACINE, "components/live/live-interne-panel.tsx"), "utf8");
    const executeur = readFileSync(path.join(RACINE, "components/live/live-executeur.tsx"), "utf8");
    const dashboard = readFileSync(path.join(RACINE, "app/live/live-dashboard.tsx"), "utf8");
    const startRoute = readFileSync(path.join(RACINE, "app/api/live/sessions/[id]/start/route.ts"), "utf8");

    // Plus AUCUN picker manuel sur la carte d'activation (chat ni dashboard).
    expect(panel.includes('aria-pressed={source === "screen"}') || panel.includes('aria-pressed={source === "camera"}'), "La carte du chat ne doit PLUS proposer de choix manuel de source — régression it.54").toBe(false);
    expect(dashboard.includes("sourceLocale") || dashboard.includes("facingLocale"), "Le dashboard ne doit PLUS proposer de picker pré-montage — régression it.54").toBe(false);
    // Le SYSTÈME détecte : capacité réelle du navigateur à l'activation
    // (panneau), reconfirmation + bascule automatique annoncée (exécuteur).
    expect(panel.includes('partageEcranPossible ? "screen" : "camera"'), "Le panneau doit détecter l'appareil via la capacité réelle — régression it.54").toBe(true);
    expect(panel.includes("Source détectée automatiquement par le système"), "La carte doit annoncer la détection automatique — régression it.54").toBe(true);
    expect(executeur.includes('body: JSON.stringify({ deviceId, source: sourceEffective })'), "L'exécuteur doit déclarer la source détectée à la porte /start — régression it.54").toBe(true);
    expect(executeur.includes("bascule sur la caméra."), "La bascule automatique écran→caméra doit être annoncée dans le journal — régression it.54").toBe(true);
    // La garde LIVE_PC_ONLY ne concerne PLUS que le partage d'écran
    // (anomalie it.52 corrigée : la caméra mobile doit pouvoir s'armer).
    expect(startRoute.includes('source: z.enum(["screen", "camera"]).default("screen")'), "La porte /start doit accepter la source déclarée — régression it.54").toBe(true);
    expect(startRoute.includes('if (source === "screen" && !device.isLiveCapable)'), "La garde PC-only ne doit s'appliquer qu'au partage d'écran (caméra mobile légitime) — régression it.54").toBe(true);
    // L'override manuel reste disponible APRÈS un arrêt (picker de l'exécuteur).
    expect(executeur.includes('aria-pressed={sourceActuelle === "screen"}'), "L'override manuel de source doit rester disponible après arrêt — régression it.54").toBe(true);
  });

  it("le cerveau gen3 possède un million de neurones, des parties et un bus d'ondes (it.56)", () => {
    // it.56 : demande propriétaire (« un million de neurones, plusieurs
    // parties réparties, un langage réparti sous des ondes, les parties
    // communiquent via des ondes, ressources matérielles = ondes gen3,
    // très faible énergie »).
    const cortex = readFileSync(path.join(RACINE, "lib/neural/core/v2/cortex-columnnaire.ts"), "utf8");
    const bus = readFileSync(path.join(RACINE, "lib/neural/core/v2/bus-ondes-regions.ts"), "utf8");
    const champ = readFileSync(path.join(RACINE, "lib/neural/core/v2/champ-cortical.ts"), "utf8");
    const effecteur = readFileSync(path.join(RACINE, "lib/neural/core/v2/effecteur-cortex.ts"), "utf8");

    // SUBSTRAT 1M : défaut 2^20 (un million de neurones spiking réels).
    expect(cortex.includes("colonnes: 1048576"), "Le cortex columnnaire doit avoir 1 048 576 colonnes par défaut (un million de neurones) — régression it.56").toBe(true);
    // MÉTABOLISME V2 : coût ∝ activité, repos gratuit, MESURÉ.
    expect(cortex.includes("metabolismeDernierPas"), "Le métabolisme v2 (évaluées/reposées/transmissions/ms) doit rester mesuré par pas — régression it.56").toBe(true);
    // BUS D'ONDES : le canal horizontal existe, est PUR et borné.
    expect(bus.includes("export function propagerOndesInterRegions"), "Le bus d'ondes inter-régions doit rester le canal horizontal du champ — régression it.56").toBe(true);
    expect(bus.includes("PAQUETS_MAX = 64"), "Le bus doit plafonner les paquets (garde-fou de coût) — régression it.56").toBe(true);
    expect(bus.includes("Math.cos"), "Le couplage doit être physique (Kuramoto, cos du déphasage) — régression it.56").toBe(true);
    // CHAMP : le bus est exposé sur le champ cortical (1000 régions).
    expect(champ.includes("propagerOndes(t: number, paquets"), "Le champ cortical doit exposer la propagation d'ondes inter-régions — régression it.56").toBe(true);
    // EFFECTEUR : le bus tourne À CHAQUE CYCLE (émission + propagation) et
    // la télémétrie honnête est exposée.
    expect(effecteur.includes("emettrePaquetsDepuisBandes(activation, this.horloge)"), "L'effecteur v2 doit émettre des paquets d'onde depuis les bandes actives à chaque cycle — régression it.56").toBe(true);
    expect(effecteur.includes("this.champ.propagerOndes"), "L'effecteur v2 doit propager les ondes inter-régions à chaque cycle — régression it.56").toBe(true);
    expect(effecteur.includes("busOndes:"), "La télémétrie busOndes doit rester exposée (bilan honnête) — régression it.56").toBe(true);
    // DOC : l'architecture cible + la loi CONTRAINTE-ONDES sont formalisées.
    expect(existsSync(path.join(RACINE, "docs/cerveau/architecture-cible-1m.md")), "La doc d'architecture 1M (loi CONTRAINTE-ONDES) doit rester en place — régression it.56").toBe(true);
    // TESTS : le bus garde ses tests unitaires.
    expect(existsSync(path.join(RACINE, "lib/neural/core/v2/bus-ondes-regions.test.ts")), "Le test du bus d'ondes doit rester en place — régression it.56").toBe(true);
  });

  it("l'entraînement par ondes de domaine existe et est branché (it.57)", () => {
    // it.57 : demande propriétaire (« un tout nouveau moyen d'entraînement
    // basé sur l'analyse des ondes et le traitement de ces ondes, selon les
    // domaines que l'on choisira » + fichier explicatif).
    const eod = readFileSync(path.join(RACINE, "lib/neural/training/entrainement-ondes.ts"), "utf8");
    const job = readFileSync(path.join(RACINE, "lib/neural/training/job.ts"), "utf8");
    const route = readFileSync(path.join(RACINE, "app/api/neural/train/route.ts"), "utf8");

    // Les TROIS phases réelles : analyse des ondes → traitement des ondes
    // (colonne dérivée de l'onde) → consolidation ondulaire (bus inter-régions).
    expect(eod.includes("export function analyserOndeTexte"), "L'analyse des ondes doit rester la phase 1 — régression it.57").toBe(true);
    expect(eod.includes("export function colonnesDepuisOndes"), "Le traitement des ondes doit rester la phase 2 — régression it.57").toBe(true);
    expect(eod.includes("champ.propagerOndes"), "La consolidation ondulaire doit passer par le bus inter-régions — régression it.57").toBe(true);
    expect(eod.includes("cortex.plasticiteSupervisee"), "La plasticité supervisée vers la bande-porteuse doit rester réelle — régression it.57").toBe(true);
    // Chaque domaine a son porteur dérivé de son nom (extensible sans code).
    expect(eod.includes("export function bandeDuDomaine"), "La bande-porteuse dérivée du nom du domaine doit rester — régression it.57").toBe(true);
    // Branché sur la porte d'entraînement : source « ondes » + domaines CHOISIS.
    expect(route.includes('"ondes"'), "La porte /api/neural/train doit accepter la source « ondes » — régression it.57").toBe(true);
    expect(route.includes("domainesOndes"), "Les domaines choisis par le propriétaire doivent être acceptés — régression it.57").toBe(true);
    expect(job.includes('source === "ondes"'), "Le job doit exécuter la session d'ondes — régression it.57").toBe(true);
    expect(job.includes("entrainerDomainesParOndes"), "Le job doit appeler le trainer par ondes — régression it.57").toBe(true);
    expect(job.includes("rapportOndes"), "Le rapport honnête de la session d'ondes doit rester exposé — régression it.57").toBe(true);
    // Le fichier explicatif demandé par le propriétaire reste en place.
    expect(existsSync(path.join(RACINE, "docs/entrainement/methode-ondes.md")), "Le fichier explicatif de la méthode d'entraînement par ondes doit rester en place — régression it.57").toBe(true);
    // Tests unitaires de la méthode.
    expect(existsSync(path.join(RACINE, "lib/neural/training/entrainement-ondes.test.ts")), "Le test de la méthode d'ondes doit rester en place — régression it.57").toBe(true);
  });
});
