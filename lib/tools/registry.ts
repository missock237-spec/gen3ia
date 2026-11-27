import type { ToolDefinition } from "./types";

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    const id = tool.id ?? tool.name;
    if (this.tools.has(id)) throw new Error(`Tool already registered: ${id}`);
    this.tools.set(id, { ...tool, id });
    if (tool.name !== id && !this.tools.has(tool.name)) this.tools.set(tool.name, { ...tool, id });
  }

  get(toolId: string): ToolDefinition | undefined {
    return this.tools.get(toolId);
  }

  has(toolId: string): boolean {
    return this.tools.has(toolId);
  }

  list(): ToolDefinition[] {
    return [...new Map([...this.tools.values()].map((tool) => [tool.id ?? tool.name, tool])).values()];
  }
}

export interface Gen3iaToolDefinition {
  name: string;
  description: string;
  risk: "read" | "write" | "external" | "destructive";
  permission: string;
  sideEffect: boolean;
}

export const GEN3IA_TOOLS: Gen3iaToolDefinition[] = [
  { name: "web.search", description: "Search the public web.", risk: "read", permission: "network.read", sideEffect: false },
  { name: "web.open", description: "Open and extract text from a public web page.", risk: "read", permission: "network.read", sideEffect: false },
  { name: "web.deep_research", description: "Deep multi-page web research: several differentiated queries then REAL reading of at least 10 pages (scaled to the request's difficulty) with sourced excerpts.", risk: "read", permission: "network.read", sideEffect: false },
  { name: "file.read", description: "Read a REAL file: an attachment from the owner's permanent storage (users/<uid>/permanent/...) or an authorized workspace file (input { path, workspaceId? }). Returns converted text plus metadata.", risk: "read", permission: "file.read", sideEffect: false },
  { name: "file.create", description: "Create a workspace file.", risk: "write", permission: "file.create", sideEffect: true },
  // it.58 — file.modify RETIRÉ du catalogue : aucun exécuteur n'a jamais
  // existé (fantôme — le planner pouvait planifier un échec garanti).
  // La modification passe par file.create (écrasement) ou file.read + code.
  // v2 (2026-11-27 — audit outils) — camera.capture et ads.publish RETIRÉS :
  // annoncés au catalogue mais AUCUN exécuteur au registre (grep dépôt
  // complet) — même classe de fantôme que file.modify ; le planificateur
  // planifiait deux échecs garantis. Les portes de politique (allowCamera,
  // ads.write, CRITICAL_TOOLS) restent en place pour le jour où un vrai
  // pont matériel/Composio est construit — le test de cohérence
  // (tests/unit/tool-registries-coherence.test.ts) imposera alors les trois
  // couches (catalogue + sécurité + exécuteur) d'un coup.
  { name: "zip.analyze", description: "Analyze a ZIP archive safely.", risk: "read", permission: "file.read", sideEffect: false },
  { name: "zip.create", description: "Create and persist a ZIP artifact.", risk: "write", permission: "file.create", sideEffect: true },
  { name: "artifact.create", description: "Create a persistent document artifact.", risk: "write", permission: "file.create", sideEffect: true },
  // it.58 — renommé artifact.get : c'est l'ID RÉEL de l'exécuteur
  // (lib/tools/files/get-artifact.ts) — l'ancien alias artifact.download
  // produisait « Unknown tool » à l'exécution (fantôme).
  { name: "artifact.get", description: "Get metadata and content of an authorized persistent document artifact.", risk: "read", permission: "file.read", sideEffect: false },
  { name: "zip.extract", description: "Extract a ZIP archive into the authorized workspace.", risk: "write", permission: "file.create", sideEffect: true },
  { name: "file.delete", description: "Delete an authorized workspace file.", risk: "destructive", permission: "file.delete", sideEffect: true },
  { name: "memory.read", description: "Read the user memory available to the agent.", risk: "read", permission: "memory.read", sideEffect: false },
  { name: "memory.write", description: "Persist a non-secret memory for the user.", risk: "write", permission: "memory.write", sideEffect: true },
  // Task 122 — terminal intégré FONCTIONNEL : version EXÉCUTABLE au registre
  // d'outils (le planificateur la voit, l'exécuteur existe). Outil INTERNE
  // (directive 10-10 : env nettoyé, workspace /tmp, deny-list durcie — aucun
  // secret utilisateur manipulé) → risque « write », pas de forçage HITL.
  { name: "terminal.run", description: "Run a REAL command in the Gen3ia agent terminal (cleaned environment, /tmp workspace, hardened deny-list, time/memory/output limits). Returns the honest execution mode (Docker sandbox, serverless in-process, or announced simulation).", risk: "write", permission: "tool.write", sideEffect: true },
  { name: "terminal.execute", description: "Run an authorized command in the isolated agent terminal.", risk: "destructive", permission: "terminal.execute", sideEffect: true },
  { name: "ads.read", description: "Read data from an authorized advertising account.", risk: "read", permission: "ads.read", sideEffect: false },
  // v2 — ads.publish retiré (fantôme : aucun exécuteur — voir note it.58/v2 ci-dessus).
  { name: "github.create_repository", description: "Create a GitHub repository for a generated project.", risk: "external", permission: "tool.external", sideEffect: true },
  // it.58 — voice.list et phone.call RETIRÉS du catalogue : les exécuteurs
  // externes (Bland, ElevenLabs) ont été retirés de la plateforme (règle
  // zéro service IA externe) — planifier ces outils garantissait un échec.
  // La voix locale reste disponible via voice.speak ; le répondeur via
  // voicemail.respond.
  { name: "code.execute", description: "Execute code in the isolated sandbox.", risk: "external", permission: "code.execute", sideEffect: true },
  // v2 — code.simulate : l'ancienne entrée courte est remplacée par la
  // version détaillée en fin de catalogue (exécuteur réel branché sur
  // lib/sandbox/simulation.ts — voir la note de synchronisation v2).
  { name: "knowledge.search", description: "Search the project knowledge base (indexed documents, tenant-scoped vector search).", risk: "read", permission: "file.read", sideEffect: false },
  { name: "composio.execute", description: "Execute an authorized external action.", risk: "external", permission: "tool.external", sideEffect: true },
  { name: "mcp.call", description: "Execute a tool exposed by one of the user's connected MCP servers (Google Drive, GitHub, databases, etc.) using { serverId, tool, args }.", risk: "external", permission: "tool.external", sideEffect: true },
  { name: "messaging.send", description: "Send a WhatsApp, Telegram or Slack message from the agent.", risk: "external", permission: "tool.external", sideEffect: true },
  { name: "email.send", description: "Send an email from the agent on behalf of the platform.", risk: "external", permission: "tool.external", sideEffect: true },
  { name: "social.publish", description: "Publish content on a connected social platform via Composio.", risk: "external", permission: "tool.external", sideEffect: true },
  { name: "webhook.emit", description: "Emit a signed Gen3ia event to the user's declared outgoing webhook endpoints.", risk: "external", permission: "tool.external", sideEffect: true },
  // it.58 — ui.components RETIRÉ du catalogue : le connecteur 21st.dev
  // n'a jamais existé (fantôme — le planner planifiait un échec garanti).
  // it.58 — SCHEDULES + WORKFLOWS exposés au planner : exécutables RÉELS
  // (lib/tools/schedules.ts, lib/tools/workflows.ts) et allowlistés par
  // PROJECT_SERVICE_TOOLS depuis longtemps, ils étaient ABSENTS du
  // catalogue — le planner les jugeait « INDISPONIBLE » à tort.
  { name: "schedule.create", description: "Planifier une tâche récurrente ou différée de l'agent (cron, intervalle, une fois) — exécution réelle par le scheduler.", risk: "write", permission: "tool.write", sideEffect: true },
  { name: "schedule.list", description: "Lister les tâches planifiées du propriétaire avec leur état réel.", risk: "read", permission: "tool.read", sideEffect: false },
  { name: "schedule.update", description: "Mettre à jour une tâche planifiée (pause, reprise, horaire).", risk: "write", permission: "tool.write", sideEffect: true },
  { name: "schedule.delete", description: "Supprimer une tâche planifiée du propriétaire.", risk: "write", permission: "tool.write", sideEffect: true },
  { name: "workflow.create", description: "Créer un workflow d'automatisation (étapes séquentielles réelles exécutées par le moteur de workflows).", risk: "write", permission: "tool.write", sideEffect: true },
  { name: "workflow.list", description: "Lister les workflows du propriétaire avec leur état réel.", risk: "read", permission: "tool.read", sideEffect: false },
  { name: "workflow.run", description: "Exécuter un workflow existant (déclenchement réel du moteur d'exécution).", risk: "write", permission: "tool.write", sideEffect: true },
  { name: "workflow.delete", description: "Supprimer un workflow du propriétaire.", risk: "write", permission: "tool.write", sideEffect: true },
  { name: "notion.search", description: "Search pages and databases in the authorized Notion workspace.", risk: "read", permission: "network.read", sideEffect: false },
  { name: "notion.create_page", description: "Create a page in the authorized Notion workspace.", risk: "external", permission: "tool.external", sideEffect: true },
  // it.58 — jules.create_task / jules.get_task RETIRÉS du catalogue :
  // l'intégration Jules n'existe pas (JULES_API_KEY seulement citée) —
  // le planner planifiait deux échecs garantis.
  { name: "cloudflare.zones.list", description: "List Cloudflare zones accessible to the integration.", risk: "read", permission: "network.read", sideEffect: false },
  { name: "cloudflare.dns.list", description: "List DNS records of a Cloudflare zone.", risk: "read", permission: "network.read", sideEffect: false },
  { name: "cloudflare.dns.create", description: "Create a DNS record in an authorized Cloudflare zone.", risk: "external", permission: "tool.external", sideEffect: true },
  // Task 133 — connecteurs entreprise : Zendesk (tickets de support) et
  // ServiceNow (incidents ITSM) via le hub de connexions Composio.
  { name: "zendesk_ticket_create", description: "Créer un ticket Zendesk (sujet, description, priorité, demandeur) via la connexion de l'utilisateur.", risk: "external", permission: "tool.external", sideEffect: true },
  { name: "zendesk_ticket_update", description: "Mettre à jour un ticket Zendesk (statut, priorité, assignation, commentaire public ou interne).", risk: "external", permission: "tool.external", sideEffect: true },
  { name: "zendesk_ticket_list", description: "Lister les tickets ouverts d'un demandeur ou d'un assigné Zendesk.", risk: "read", permission: "network.read", sideEffect: false },
  { name: "zendesk_ticket_search", description: "Rechercher des tickets Zendesk en plein texte.", risk: "read", permission: "network.read", sideEffect: false },
  { name: "servicenow_incident_create", description: "Créer un incident ServiceNow (brève, urgence, impact, description).", risk: "external", permission: "tool.external", sideEffect: true },
  { name: "servicenow_incident_update", description: "Mettre à jour un incident ServiceNow (état, notes de travail, résolution).", risk: "external", permission: "tool.external", sideEffect: true },
  { name: "servicenow_incident_query", description: "Interroger les incidents ServiceNow filtrés par état ou urgence.", risk: "read", permission: "network.read", sideEffect: false },
  { name: "custom_api.call", description: "Appelle RÉELLEMENT (GET) une API personnelle fournie par l'utilisateur et retourne la réponse réelle.", risk: "read", permission: "network.read", sideEffect: false },
  { name: "custom_api.write", description: "Modifie RÉELLEMENT des données via une API personnelle de l'utilisateur (POST/PUT/PATCH/DELETE).", risk: "external", permission: "tool.external", sideEffect: true },
  { name: "web.api", description: "Appelle RÉELLEMENT (GET) une API publique désignée par URL et retourne la réponse réelle.", risk: "read", permission: "network.read", sideEffect: false },
  { name: "web.api.write", description: "Modifie RÉELLEMENT des données via une API publique désignée par URL (POST/PUT/PATCH/DELETE).", risk: "external", permission: "tool.external", sideEffect: true },
  { name: "network.list", description: "Liste les équipes (réseaux) d'agents du propriétaire : membres, rôles, topologie.", risk: "read", permission: "tool.read", sideEffect: false },
  { name: "network.send_message", description: "Envoie un message à un agent coéquipier du MÊME réseau (collaboration agent-à-agent).", risk: "write", permission: "tool.write", sideEffect: true },
  { name: "network.read_inbox", description: "Lit la boîte de réception d'un agent (messages de ses coéquipiers).", risk: "read", permission: "tool.read", sideEffect: false },
  { name: "network.mark_read", description: "Marque un message d'équipe comme lu.", risk: "read", permission: "tool.read", sideEffect: false },
  // MÉDIAS & VOIX — OUTILS INTERNES (directive 10-10 : « aucune approbation
  // pour une utilisation d'un outil interne ») : génération d'image Agnes,
  // production vidéo (file interne payante), suivi/révision, synthèse vocale
  // et analyse média opèrent UNIQUEMENT sur l'infrastructure Gen3ia — ils ne
  // touchent NI app externe NI secret utilisateur → jamais de carte de
  // validation. L'ancienne classification « external » forçait
  // requiresApproval sur CHAQUE génération (captures 07:24 : image.generate
  // et video.create bloqués par « Confirmation requise »).
  { name: "image.generate", description: "Générer une image à partir d'une description texte, avec ratio et images de référence optionnels.", risk: "write", permission: "tool.write", sideEffect: false },
  { name: "video.create", description: "Lancer une production vidéo complète autonome (script, images, voix, montage) avec paramètres de production (durée, format, résolution, langue, style, audience, plateforme, musique, formats dérivés) et suivre sa progression.", risk: "write", permission: "tool.write", sideEffect: true },
  { name: "video.status", description: "Suivre une production vidéo : étape en cours, progression réelle, avertissements, URL de lecture du master terminé.", risk: "read", permission: "tool.read", sideEffect: false },
  { name: "video.revise", description: "Réviser ou piloter une vidéo existante : rythme, musique, voix, sous-titres, suppression de scène, pause/reprise/annulation du rendu, formats dérivés.", risk: "write", permission: "tool.write", sideEffect: true },
  { name: "media.analyze", description: "Analyser localement une image, un audio ou une vidéo fournie (mesures réelles : format, dimensions, durée, codecs, palette, luminosité, images clés) et TRANSCRIRE RÉELLEMENT la parole des pistes audio (ASR) quand le professeur média est configuré ; sinon mesures seules, absence déclarée honnêtement.", risk: "read", permission: "tool.read", sideEffect: false },
  { name: "voice.speak", description: "Synthétiser un AUDIO PARLÉ à partir d'un texte : voix humaine RÉELLE via le professeur média temporaire quand il est configuré (7 voix, vitesse 0.5–2), sinon composition harmonique neuronale locale déterministe (pas de parole — signalé honnêtement).", risk: "write", permission: "tool.write", sideEffect: false },
  // Task 140 — SUITE « OUTILS PILOTÉS PAR LES AGENTS IA » (16 outils).
  // Risques : « read » = analyse/lecture sans effet de bord ; « write » =
  // opération INTERNE Gen3ia (LLM facturé, artefacts, registres — directive
  // 10-10 : jamais de carte de validation) ; « external » = action externe
  // réelle (PR GitHub, envoi email/SMS, re-soumission webhook) soumise à la
  // validation humaine du flux HITL.
  { name: "handover.compose", description: "Générer un brief de relais IA → humain structuré (intention du client, état émotionnel, blocages techniques, données collectées, actions suivantes) depuis la transcription d'une conversation, avec livrable persisté.", risk: "write", permission: "tool.write", sideEffect: true },
  { name: "terminal.shield", description: "Exécuter une commande dans le terminal agent PROTÉGÉ : pré-analyse des chemins erronés avant exécution, surveillance de la sortie, interception des erreurs de build et auto-réparation (correction de chemin, alias de commande, dépendance manquante) avec relance bornée.", risk: "write", permission: "tool.write", sideEffect: true },
  { name: "registry.find", description: "Rechercher et vérifier EN DIRECT des packages (npm + PyPI) : existence, dernière version, dépréciation, fraîcheur, présence MCP — pour ne jamais recommander une bibliothèque obsolète ou inexistante.", risk: "read", permission: "network.read", sideEffect: false },
  { name: "build.autofix", description: "Pipeline d'auto-correction : analyse un log de build brut, localise les lignes fautive dans le dépôt GitHub, écrit le correctif et crée la pull request automatiquement.", risk: "external", permission: "tool.external", sideEffect: true },
  { name: "simulation.run", description: "Studio de simulation : des agents aux profils psychologiques variés (novice, hacker, acheteur pressé, sceptique…) simulent des utilisateurs réels sur une cible (page réelle ou parcours décrit) et produisent un rapport de bugs comportementaux persisté.", risk: "write", permission: "tool.write", sideEffect: true },
  { name: "browser.navigate", description: "Navigation web ADAPTATIVE anti-robots : rotation d'agents utilisateurs, backoff sur les limites de débit, suivi des redirections et détection honnête des pages challenge — jamais de contenu inventé.", risk: "read", permission: "network.read", sideEffect: false },
  { name: "schema.extract", description: "Extraire des DONNÉES STRUCTURÉES (tableaux JSON typés) d'une page web ou d'un HTML non structuré, selon un schéma cible ou en détection automatique des colonnes.", risk: "read", permission: "network.read", sideEffect: false },
  { name: "voicemail.respond", description: "Répondeur vocal asynchrone : extrait le besoin réel d'un message vocal transcrit (intention, urgence, données), rédige les réponses (email/SMS/objectif d'appel) et expédie via les canaux configurés.", risk: "external", permission: "tool.external", sideEffect: true },
  { name: "transcript.redact", description: "Masquer EN TEMPS RÉEL les données sensibles d'une transcription d'appel (cartes bancaires validées Luhn, IBAN, CVV, mots de passe, téléphones, emails, NIR) — 100 % déterministe, aucun LLM.", risk: "read", permission: "tool.read", sideEffect: false },
  { name: "ivr.navigate", description: "Analyser un arbre de menus vocaux (SVI/IVR) — depuis une transcription ou un arbre structuré — et calculer le chemin de touches DTMF optimal vers un objectif (ex. parler à un conseiller).", risk: "read", permission: "tool.read", sideEffect: false },
  { name: "webhook.heal", description: "Passerelle webhooks auto-réparatrice : diagnostique une livraison échouée (auth, limite, schéma, taille), adapte la charge utile et la re-soumet une fois avec la signature HMAC correcte.", risk: "external", permission: "tool.external", sideEffect: true },
  { name: "watchdog.track", description: "Surveiller une page web stratégique : enregistre une référence, détecte les changements à chaque vérification et CLASSIFIE stratégique vs cosmétique (prix, offre, produit… contre dates et compteurs).", risk: "write", permission: "tool.write", sideEffect: true },
  { name: "terminal.guide", description: "Transformer une session terminal brute (commandes + sorties) en GUIDE INTERACTIF pas-à-pas persisté : commandes expliquées, sorties attendues, avertissements — adapté au niveau du lecteur.", risk: "write", permission: "tool.write", sideEffect: true },
  { name: "content.package", description: "Pipeline de contenu automatisé : d'une idée, produit le PACK COMPLET — angles éditoriaux, script vidéo scène par scène (directions visuelles incluses), pack SEO (titres, mots-clés, hashtags, miniature) — livrable persisté.", risk: "write", permission: "tool.write", sideEffect: true },
  { name: "knowledge.graph", description: "Construire le GRAPHE DE CONNAISSANCES d'une collection de documents : concepts pondérés, relations typées, clusters et visualisation SVG déterministe intégrée au livrable.", risk: "write", permission: "tool.write", sideEffect: true },
  { name: "decision.analyze", description: "Moteur de décision probabiliste : espérance, variance, simulation Monte-Carlo reproductible, VaR/CVaR, probabilité de perte, sensibilité et recommandation adaptée à la tolérance au risque — 100 % déterministe.", risk: "read", permission: "tool.read", sideEffect: false },
  // v2 (2026-11-27) — SYNCHRONISATION CATALOGUE (audit outils) : 11
  // exécuteurs RÉELS du registre (lib/tools/default-registry.ts) étaient
  // absents du catalogue — le planificateur les jugeait « INDISPONIBLE » à
  // tort (même défaut que schedule.* corrigé en it.58). Capacité réelle =
  // capacité annoncée ; chaque entrée décrit le comportement réel.
  { name: "artifact.convert", description: "Convertir un document d'un format vers un autre : extraction réelle de la source, reconstruction en blocs, génération et persistance d'un nouveau livrable.", risk: "write", permission: "file.create", sideEffect: true },
  { name: "brain.train", description: "Entraîner le cerveau Gen3 depuis la conversation : apprendre des connaissances « X signifie Y » ou des abréviations dans le cortex langagier (paires réellement ajoutées, doublons ignorés — idempotent).", risk: "write", permission: "tool.write", sideEffect: true },
  { name: "musique.creer", description: "Composer une musique algorithmique déterministe (styles, accords, mélodie, percussions) rendue WAV→MP3 via FFmpeg et persistée — l'utilisateur reçoit un vrai fichier audio de la durée demandée.", risk: "write", permission: "tool.write", sideEffect: true },
  { name: "code.exec", description: "Exécuter du JavaScript dans une sandbox vm durcie (worker isolé, prototype nul, import() refusé, timeout strict, sortie plafonnée) — limitations honnêtes annoncées dans le résultat.", risk: "write", permission: "code.execute", sideEffect: true },
  { name: "code.inspect", description: "Analyse statique de code : structure, dépendances, motifs risqués — sans exécution.", risk: "read", permission: "tool.read", sideEffect: false },
  { name: "code.simulate", description: "Simuler du code SANS effet de bord (analyse statique Node/Python/shell : structure, opérations détectées, avertissements) — le mode réel renvoyé est toujours « simulation ». Pour exécuter réellement : terminal.run ou code.exec.", risk: "read", permission: "code.execute", sideEffect: false },
  { name: "web.http", description: "Effectuer une requête HTTP GET SSRF-gardée vers une URL publique désignée et retourner la réponse réelle (statut, en-têtes, corps).", risk: "read", permission: "network.read", sideEffect: false },
  { name: "web.dns", description: "Résoudre réellement un nom de domaine (registres A/AAAA/CNAME/MX/TXT) et retourner les enregistrements observés.", risk: "read", permission: "network.read", sideEffect: false },
  { name: "dev.fmt", description: "Formater et transformer des données en mémoire : JSON, Base64, hash (SHA-256/MD5), encodage/décodage d'URL.", risk: "read", permission: "tool.read", sideEffect: false },
  { name: "dev.regex", description: "Tester une expression régulière contre un texte : correspondances réelles, groupes capturés, validation — sans exécution de code.", risk: "read", permission: "tool.read", sideEffect: false },
  { name: "artefacts.audit", description: "Auditer les créations de gen3 et les apports de l'utilisateur (toutes conversations) : lister, lire, modifier avec historique de versions.", risk: "write", permission: "tool.write", sideEffect: true },
];
