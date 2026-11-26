/**
 * LES 12 MODULES GEN3 — SOURCE DE VÉRITÉ DÉCLARATIVE (demande propriétaire :
 * « architecture 12 modules orchestrés par Gen3 Core » : Gen3 Core, Texte,
 * Vision, Audio, Vidéo, Code, Spatial, Mémoire, Apprentissage, Agents,
 * Raisonnement, Recherche).
 *
 * CE MODULE EST LA SOURCE DE VÉRITÉ de l'architecture modulaire de gen3 :
 *  - exposée par GET /api/neural/modules (inventaire + routage à la demande) ;
 *  - affichée par le tableau de bord /neural (composant ModulesGen3) ;
 *  - vérifiée par le garde (lib/gen3/modules/garde-modules.test.ts) : 12
 *    modules exacts, zéro organe fantôme (chemins vérifiés sur disque),
 *    zéro outil fantôme (noms croisés avec GEN3IA_TOOLS + brain.train —
 *    les seuls outils réellement enregistrés dans la plateforme).
 *
 * RÈGLES D'HONNÊTÉ (règle zéro fantôme du dépôt, cf. it.58) :
 *  - chaque `organes[]` est un chemin RÉEL du dépôt (vérifié par le garde
 *    via fs.existsSync) — le module DÉCLARE où son intelligence réside ;
 *  - chaque `outils[]` est un nom RÉEL du registre d'outils (GEN3IA_TOOLS
 *    lib/tools/registry.ts, ou brain.train lib/tools/brain-train.ts
 *    enregistré dans lib/tools/default-registry.ts) — vérifié par le garde ;
 *  - aucun module ne promet une capacité qui n'existe pas dans le code.
 *
 * MODULE PUR (aucune IO, aucun "server-only") — partageable serveur (API,
 * prompts) et tests sans tirer de bundle serveur dans le client.
 */

/** Niveau de maturité d'un module (grille propriétaire N1/N2/N3) :
 *  - N1 — multi-modalité de base (compréhension + génération du canal) ;
 *  - N2 — multi-modalité avancée (mémoire, outils réels, agents, code) ;
 *  - N3 — intelligence expérimentale (spatial, apprentissage expérientiel,
 *    raisonnement transversal, planification, adaptation). */
export type NiveauModuleGen3 = "N1" | "N2" | "N3";

/** Identifiants canoniques des 12 modules (kebab-case, stables). */
export type IdModuleGen3 =
  | "core"
  | "texte"
  | "vision"
  | "audio"
  | "video"
  | "code"
  | "spatial"
  | "memoire"
  | "apprentissage"
  | "agents"
  | "raisonnement"
  | "recherche";

/** Un module de l'architecture Gen3 : déclaration honnête de sa mission,
 * de son niveau, de ses organes réels et de ses outils réels. */
export interface ModuleGen3 {
  /** Identifiant canonique. */
  readonly id: IdModuleGen3;
  /** Libellé français propriétaire (« Gen3 Core », « Gen3 Texte »…). */
  readonly label: string;
  /** Mission du module — formulation lisible par gen3 lui-même (en « tu »). */
  readonly mission: string;
  /** Niveau de maturité N1/N2/N3 (grille propriétaire). */
  readonly niveau: NiveauModuleGen3;
  /** Chemins RÉELS du dépôt où réside l'intelligence du module
   *  (vérifiés par le garde via fs.existsSync). */
  readonly organes: readonly string[];
  /** Noms RÉELS d'outils mobilisés (registre GEN3IA_TOOLS + brain.train —
   *  vérifiés par le garde contre la liste réelle). */
  readonly outils: readonly string[];
  /** Signaux lexicaux FR/EN normalisés (minuscules, sans diacritiques) pour
   *  le routage déterministe d'une demande vers ce module. */
  readonly signaux: readonly string[];
}

/** LES 12 MODULES — ordre canonique : Core d'abord (orchestrateur), puis les
 * canaux de perception/action, puis les facultés transverses. */
export const MODULES_GEN3: readonly ModuleGen3[] = [
  {
    id: "core",
    label: "Gen3 Core",
    mission:
      "Tu es l'orchestrateur central : tu recevras chaque demande, activeras les modules " +
      "nécessaires, consolideras leurs résultats et rendras une réponse unique traçable " +
      "(provenance déclarée, jamais de canal fantôme).",
    niveau: "N2",
    organes: [
      "lib/neural/engine.ts",
      "lib/neural/runtime.ts",
      "lib/neural/core/central-core.ts",
      "lib/neural/core/v2/effecteur-cortex.ts",
    ],
    outils: ["registry.find", "decision.analyze", "watchdog.track"],
    signaux: ["orchestre", "orchestrate", "module", "cerveau", "central", "pipeline", "coordonne"],
  },
  {
    id: "texte",
    label: "Gen3 Texte",
    mission:
      "Tu traiteras le langage : comprendre, générer, résumer, corriger, traduire et " +
      "analyser les documents (PDF/DOCX/XLSX convertis par file.read) depuis le cortex " +
      "langagier appris — déterministe, traçable, honnête sous le seuil.",
    niveau: "N1",
    organes: [
      "lib/neural/generation/language.ts",
      "lib/neural/generation/corpus.ts",
      "lib/neural/decoding/response-decoder.ts",
      "lib/neural/encoding/text-encoder.ts",
    ],
    outils: ["file.read", "knowledge.search", "schema.extract", "memory.read"],
    signaux: ["texte", "text", "redige", "redact", "resume", "corrige", "traduit", "traduction", "phrase", "paragraphe", "document", "pdf", "docx", "xlsx"],
  },
  {
    id: "vision",
    label: "Gen3 Vision",
    mission:
      "Tu traiteras l'image : analyser scène, objets, couleurs et formes, détecter les " +
      "anomalies, lire l'OCR, générer et composer des visuels depuis les moteurs locaux " +
      "(aucune IA externe).",
    niveau: "N1",
    organes: [
      "lib/neural/media-service.ts",
      "lib/media",
      "lib/neural/generation/compositeur.ts",
      "lib/camera",
    ],
    outils: ["media.analyze", "image.generate", "camera.capture"],
    signaux: ["image", "photo", "vision", "visual", "couleur", "forme", "objet", "scene", "ocr", "dessin", "illustration", "diagramme", "graphique"],
  },
  {
    id: "audio",
    label: "Gen3 Audio",
    mission:
      "Tu traiteras le son : synthèse vocale réaliste, transcription, détection d'ambiance " +
      "et d'intention, musique et effets — signaux calculés localement (WAV, synthèse " +
      "acoustique, voix apprise).",
    niveau: "N1",
    organes: [
      "lib/neural/voix-realiste.ts",
      "lib/neural/audio-intention.ts",
      "lib/ondes/synthese-acoustique.ts",
      "lib/neural/generation/audio-composition.ts",
    ],
    outils: ["voice.speak", "media.analyze", "transcript.redact"],
    signaux: ["audio", "son", "voix", "parle", "dicte", "transcription", "musique", "melodie", "bruit", "micro", "podcast", "lecture vocale"],
  },
  {
    id: "video",
    label: "Gen3 Vidéo",
    mission:
      "Tu produiras et éditeras la vidéo : pipeline réel (script, timeline, sous-titres, " +
      "synchronisation labiale, files de rendu avec reprise), sous-agents spécialisés et " +
      "livraison mesurée.",
    niveau: "N1",
    organes: [
      "lib/video/production-job.ts",
      "lib/video/timeline-service.ts",
      "lib/video/voice-sync.ts",
      "lib/video/subtitle-service.ts",
      "lib/video/sub-agents.ts",
    ],
    outils: ["video.create", "video.status", "video.revise", "media.analyze"],
    signaux: ["video", "film", "clip", "scene animee", "montage", "sous-titre", "sous titre", "rendu video", "animation", "trailer"],
  },
  {
    id: "code",
    label: "Gen3 Code",
    mission:
      "Tu exécuteras le code : terminal virtuel et sandbox réelle, génération de sites et " +
      "d'applications (corpus dev web it.150), simulateur, correctif de build — chaque " +
      "exécution passe par les gardes de sécurité.",
    niveau: "N2",
    organes: [
      "lib/neural/compartiments/terminal-virtuel.ts",
      "lib/gen3/generateur-sites.ts",
      "lib/gen3/generateur-dev-web-it150.ts",
      "lib/tools/code",
      "services/sandbox",
    ],
    outils: ["code.execute", "code.simulate", "terminal.execute", "terminal.run", "terminal.shield", "build.autofix", "github.create_repository"],
    signaux: ["code", "script", "programme", "fonction", "site", "application", "api", "bug", "compile", "terminal", "react", "next", "typescript", "html"],
  },
  {
    id: "spatial",
    label: "Gen3 Spatial",
    mission:
      "Tu raisonneras dans l'espace : rendu spatio-temporel, maillages privés, manifold " +
      "ondulatoire et monde simulé — profondeur, distances, relations spatiales et " +
      "interactions physiques calculées, jamais devinées.",
    niveau: "N3",
    organes: [
      "lib/ondes/rendu-spatiotemporel.ts",
      "lib/ondes/mesh-prive.ts",
      "lib/ondes/manifold.ts",
      "lib/monde",
    ],
    outils: ["simulation.run", "code.simulate"],
    signaux: ["3d", "spatial", "profondeur", "distance", "mesh", "maillage", "volume", "geometrie", "physique", "carte", "plan", "orbite", "manifold"],
  },
  {
    id: "memoire",
    label: "Gen3 Mémoire",
    mission:
      "Tu porteras la mémoire permanente : hippocampe de travail, mémoire de domaines " +
      "alimentée par le corpus commis, mémoire utilisateur et RAG ondulaire — chaque " +
      "donnée déjà traitée devient réutilisable sans retraitement.",
    niveau: "N2",
    organes: [
      "lib/neural/memory/hippocampus.ts",
      "lib/neural/generation/memoire-domaines.ts",
      "lib/memory",
      "lib/ondes/rag-onde.ts",
    ],
    outils: ["memory.read", "memory.write", "knowledge.graph"],
    signaux: ["souviens", "souvenir", "memoire", "retenir", "rappelle", "memorise", "historique", "deja", "precedent", "contexte"],
  },
  {
    id: "apprentissage",
    label: "Gen3 Apprentissage",
    mission:
      "Tu apprendras continûment : entraînement supervisé depuis le chat (brain.train), " +
      "pré-entraînement de masse (million), campagne d'amélioration continue avec " +
      "checkpoints et reprise, évaluation avant/après et refus de régression.",
    niveau: "N3",
    organes: [
      "lib/neural/training",
      "lib/gen3/pretrain-million.ts",
      "lib/gen3/amelioration-continue.ts",
      "lib/capabilities/learning",
    ],
    outils: ["brain.train"],
    signaux: ["apprend", "apprentissage", "entraine", "entrainement", "dataset", "corpus", "ameliore", "progres", "repetition", "epoque"],
  },
  {
    id: "agents",
    label: "Gen3 Agents",
    mission:
      "Tu délègueras aux agents : essaims (global, média), missions planifiées, " +
      "workflows, planificateur 24h et moteur de capacités UCE — chaque action sensible " +
      "reste sous approbation humaine.",
    niveau: "N2",
    organes: [
      "lib/agents",
      "lib/essaim-agents",
      "lib/capabilities/core/capability-registry.ts",
      "lib/missions",
      "services/orchestrator-24h",
    ],
    outils: [
      "workflow.create",
      "workflow.run",
      "schedule.create",
      "schedule.list",
      "composio.execute",
      "mcp.call",
      "network.send_message",
    ],
    signaux: ["agent", "essaim", "mission", "workflow", "automatise", "automatisation", "planifie", "tache de fond", "delegue", "24h", "continu"],
  },
  {
    id: "raisonnement",
    label: "Gen3 Raisonnement",
    mission:
      "Tu raisonneras : familles de méthodes (induction, déduction, sens commun, ironie, " +
      "spatial, temporel…), orchestrateur de raisonnement branché aux compartiments " +
      "calculables, solveurs exacts et auto-évaluation honnête.",
    niveau: "N3",
    organes: [
      "lib/gen3/familles-methodes.ts",
      "lib/neural/compartiments/orchestrateur-raisonnement.ts",
      "lib/gen3/raisonnement-it94.ts",
      "lib/neural/solveurs",
    ],
    outils: ["decision.analyze", "simulation.run", "schema.extract"],
    signaux: ["pourquoi", "raisonne", "deduis", "induis", "logique", "resous", "conclus", "explique", "analyse", "compare", "argument"],
  },
  {
    id: "recherche",
    label: "Gen3 Recherche",
    mission:
      "Tu chercheras : recherche web multi-pages réelles (web.deep_research), lecture de " +
      "pages publiques, base de connaissances indexée et composition sourcée — chaque " +
      "affirmation porte sa source.",
    niveau: "N1",
    organes: [
      "lib/recherche-web",
      "lib/tools/web",
      "lib/knowledge",
      "lib/neural/recherche-web-pont.ts",
    ],
    outils: ["web.search", "web.open", "web.deep_research", "browser.navigate", "knowledge.search"],
    signaux: ["cherche", "recherche", "google", "trouve", "internet", "web", "source", "reference", "nouvelles", "actualite", "documente"],
  },
] as const;

/** Nombre canonique de modules — 12 (garde). */
export const NB_MODULES_GEN3 = 12;

/** Les niveaux N1/N2/N3 valides. */
export const NIVEAUX_VALIDES: readonly NiveauModuleGen3[] = ["N1", "N2", "N3"];

/** Outil réel hors GEN3IA_TOOLS : brain.train (lib/tools/brain-train.ts,
 * enregistré dans lib/tools/default-registry.ts). Le garde autorise
 * exactement ce nom supplémentaire — aucun autre. */
export const OUTILS_HORS_REGISTRE_AUTORISES: readonly string[] = ["brain.train"];

/** Index par identifiant (accès O(1) pour l'API et le tableau de bord). */
export const MODULES_PAR_ID: Readonly<Record<IdModuleGen3, ModuleGen3>> =
  Object.fromEntries(MODULES_GEN3.map((m) => [m.id, m])) as Readonly<
    Record<IdModuleGen3, ModuleGen3>
  >;

/** Mission maîtresse de l'architecture modulaire (injectable dans les
 * prompts système — cohérente avec MISSION_GEN3 de lib/gen3/vocation.ts). */
export const MISSION_MODULES_GEN3 =
  "Gen3 est organisé en 12 modules orchestrés par Gen3 Core : Texte, Vision, Audio, " +
  "Vidéo, Code, Spatial, Mémoire, Apprentissage, Agents, Raisonnement et Recherche. " +
  "Chaque module déclare ses organes réels et ses outils réels — rien de décoratif. " +
  "Une demande active d'abord le module compétent, puis les modules transverses " +
  "(mémoire, raisonnement, recherche) ; la réponse finale est consolidée par Core " +
  "avec la provenance de chaque module sollicité.";
