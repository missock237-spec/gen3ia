import { GEN3IA_TOOLS } from "@/lib/tools/registry";
import { KNOWN_TOOL_SECURITY_NAMES } from "@/lib/security/tool-permissions";
import type { AuthorizationMode } from "@/lib/security/authorization-mode";

/**
 * Résolution des outils « en clair » (étape 7 du plan 20).
 *
 * Agent gen (langage naturel) peut proposer des noms d'outils libres —
 * « Gmail », « envoyer des emails », « jira », « recherche web » — qui ne
 * correspondent à AUCUN outil réel du registre Gen3ia. Sans résolution, ces
 * outils fantômes sont persistés puis silencieusement ignorés au runtime
 * (l'agent annonce des capacités qu'il n'aura jamais), et sans durcissement
 * une config proposée peut combiner des outils sensibles avec un mode
 * d'autorisation permissif.
 *
 * Ce module est PUR (aucune I/O) et constitue la SOURCE UNIQUE de :
 *  1. NORMALISATION : accents, casse, ponctuation → forme comparable ;
 *  2. RECONNAISSANCE : alias métier en clair → noms canoniques du registre ;
 *  3. RÉSOLUTION : chaque entrée déclarée devient kept / mapped / removed ;
 *  4. DURCISSEMENT : auto_allow + outil sensible (external/destructive) →
 *     ask_if_needed. Le plancher HITL runtime (NEVER_AUTO_APPROVE_TOOLS,
 *     isAutoApprovable) reste la défense ultime — celui-ci agit à la
 *     proposition/création pour que la config soit honnête dès le départ.
 */

export type ToolResolutionStatus = "kept" | "mapped" | "removed";

export interface ToolResolutionEntry {
  /** Entrée brute déclarée (avant normalisation). */
  from: string;
  /** Nom canonique résultant (présent pour kept / mapped). */
  to?: string;
  status: ToolResolutionStatus;
  /** Explication lisible par l'utilisateur (pour kept/mapped/removed). */
  reason?: string;
}

export interface ToolResolution {
  /** Noms canoniques dédupliqués, ordre de déclaration conservé. */
  resolved: string[];
  /** Entrées en clair qu'aucun alias ni nom canonique n'a reconnues. */
  unknown: string[];
  /** Traçabilité complète entrée par entrée. */
  mapping: ToolResolutionEntry[];
}

export interface ToolHardening {
  /** Mode d'autorisation après durcissement (identique si aucun changement). */
  mode: AuthorizationMode;
  /** true si auto_allow a été rétrogradé à cause d'outils sensibles. */
  hardened: boolean;
  /** Outils résolus à risque external ou destructive. */
  sensitiveTools: string[];
}

const REGISTRY_NAMES = GEN3IA_TOOLS.map((tool) => tool.name);
/**
 * Ensemble d'existence RÉEL : union du registre d'exécution (GEN3IA_TOOLS)
 * et des définitions de sécurité (schedule.*, workflow.* — sous-services
 * internes exécutables légitimement, absents du registre). Un nom hors de
 * cette union n'est ni exécutable ni autorisable : c'est un fantôme.
 */
const REGISTRY_SET = new Set<string>([...REGISTRY_NAMES, ...KNOWN_TOOL_SECURITY_NAMES]);

/** Forme comparable : minuscules, accents retirés, non-alphanumériques → espace. */
export function normalizeToolName(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

type AliasRule = { pattern: RegExp; tools: string[]; label: string };

/**
 * Règles d'alias en clair, dans l'ordre de priorité (la plus spécifique
 * d'abord). Chaque règle ne mappe QUE vers des outils réels du registre.
 * Les variantes d'écriture restent volontairement restreintes à des
 * intentions sans ambiguïté : une entrée non reconnue est « removed » avec
 * raison — jamais devinée au hasard.
 */
const ALIAS_RULES: AliasRule[] = [
  // — Messageries & email (avant la règle générique « recherche » : aucun
  //   conflit, mais « gmail » doit passer avant « mail » générique).
  { pattern: /\bgmail\b|\bcourriel\b|\bemail\b|\be mails?\b|\bmails?\b|\boutlook\b|\bsmtp\b|envoi\w* mail|send (an? )?email/, tools: ["email.send"], label: "email.send (envoi d'email réel)" },
  { pattern: /\bslack\b|\bwhatsapp\b|\btelegram\b|\bmessenger\b|\bsms\b|\bmessaging\b/, tools: ["messaging.send"], label: "messaging.send (WhatsApp/Telegram/Slack)" },
  // — Médias générés (image & vidéo) : AVANT les règles sociaux/publicité et
  //   caméra — « photo » désigne ici une image GÉNÉRÉE (image.generate), pas
  //   une capture caméra (qui garde « camera » / « capture ») ; « instagram
  //   reels » est une VIDÉO, pas une publication sociale. Pour la vidéo,
  //   « reel » n'est reconnu QUE accolé à une plateforme : après
  //   normalisation (accents retirés), « reel(s) » est l'homographe de
  //   « réel(s) » — jamais deviné seul. Idem pour « short » : le nom
  //   (« shorts », YouTube Shorts) mappe, pas l'adjectif anglais générique.
  { pattern: /\bimages?\b|\bphoto\w*\b|\bdessins?\b|\blogo\w*\b|\bbanni[èe]res?\b|\billustrations?\b|\bicones?\b|\bavatars?\b/, tools: ["image.generate"], label: "image.generate (génération d'image à partir d'un texte)" },
  { pattern: /\bvid[ée]os?\b|\bclips?\b|\bmontage(s)? vid[ée]o\b|\b(?:instagram|tiktok|facebook|youtube)\s+reels?\b|\breels?\s+(?:instagram|tiktok|facebook|youtube)\b|\bshorts\b|\bvideo courte\b|\bvid[ée]o courte\b/, tools: ["video.create"], label: "video.create (production vidéo complète autonome)" },
  // — Réseaux sociaux & publicité
  { pattern: /\bgoogle ads\b|\bmeta ads\b|\btiktok ads\b|\badwords\b|\bpublicite\b|\bpublicités?\b|\badvertising\b|\bads\b/, tools: ["ads.read"], label: "ads.read (lecture publicitaire ; la publication reste une action approuvée)" },
  { pattern: /\blinkedin\b|\btwitter\b|\bx post\b|\binstagram\b|\bfacebook\b|\breseaux? sociaux?\b|\bsocial\b/, tools: ["social.publish"], label: "social.publish (publication sur plateforme connectée)" },
  // — Recherche & web
  { pattern: /\brecherche web\b|\bweb search\b|\bsearch the web\b|\bgoogl\w*\b|\binternet\b|\bactualites?\b|\bnews\b|\bveille\b|recherche (sur|en) ligne|\bsearch\b|\brecherches?\b/, tools: ["web.search"], label: "web.search (recherche web réelle)" },
  { pattern: /\bweb\.open\b|ouvrir (une )?page|lire (une )?page web|extraire (une )?page|\bopen url\b|\bscraper\b|\bscraping\b/, tools: ["web.open"], label: "web.open (lecture d'une page web)" },
  { pattern: /\bwebhook\b/, tools: ["webhook.emit"], label: "webhook.emit (événement signé vers vos endpoints)" },
  // — APIs (personnelles, externes, connectées)
  { pattern: /\bapi personnelle\b|\bmes apis?\b|\bcustom api\b|\brest\b|\bhttp\b|\bapi\b|\bapis?\b/, tools: ["custom_api.call", "web.api"], label: "custom_api.call + web.api (appels HTTP réels)" },
  { pattern: /\bcalendrier\b|\bcalendar\b|\bagenda\b|\bdrive\b|\bgoogle drive\b|\bsheets?\b|\bspreadsheet\b|\bexcel en ligne\b|\bairtable\b|\bhubspot\b|\bsalesforce\b|\bcrm\b|\bdatabase\b|\bbase de donnees\b|\bsql\b|\bnotion connexe\b/, tools: ["mcp.call"], label: "mcp.call (apps connectées : Drive, Sheets, CRM, bases de données…)" },
  // — Intégrations nommées
  { pattern: /\bnotion\b/, tools: ["notion.search"], label: "notion.search (recherche Notion)" },
  { pattern: /\bgithub\b|\brepositor\w*\b|\brepo git\b|\bgit\b/, tools: ["github.create_repository"], label: "github.create_repository (création de dépôt)" },
  { pattern: /\bcloudflare\b|\bdns\b/, tools: ["cloudflare.dns.list", "cloudflare.dns.create"], label: "cloudflare.dns.* (lecture + création DNS, création soumise à validation)" },
  { pattern: /\bjules\b/, tools: ["jules.create_task"], label: "jules.create_task (tâche de codage asynchrone)" },
  { pattern: /\bcomposio\b|\bzapier\b|\bconnecteur\b|\bintegrations?\b|\bappels? externes?\b/, tools: ["composio.execute"], label: "composio.execute (action externe autorisée)" },
  { pattern: /\btaches? planifie\w*\b|\bplanifi\w*\b|\brecurring\b|\bcron\b|\brecurrent\w*\b|\bautomatisations? recurrentes?\b|\bprogramm\w* reguliere\w*\b/, tools: ["schedule.create"], label: "schedule.create (tâche récurrente planifiée)" },
  { pattern: /\bmcp\b/, tools: ["mcp.call"], label: "mcp.call (outils MCP connectés)" },
  // — Code & terminal
  { pattern: /\bpython\b|\bjavascript\b|\bnode\b|\btypescript\b|\bcoder?\b|\bcode\b|\bprogramme\w*\b|\bcalcul\w*\b|\bscript\b/, tools: ["code.execute"], label: "code.execute (sandbox isolée)" },
  { pattern: /\bsimulation\b|\bsimuler\b|\bsimulate\b|\bvalider du code\b/, tools: ["code.simulate"], label: "code.simulate (simulation sans effet externe)" },
  { pattern: /\bterminal\b|\bshell\b|\bbash\b|\bligne de commande\b|\bcommande\w*\b/, tools: ["terminal.execute"], label: "terminal.execute (terminal isolé)" },
  // — Livrables & fichiers (après « code » : « créer un fichier » reste fichier)
  { pattern: /\bpdf\b|\bword\b|\bdocx?\b|\bexcel\b|\bxlsx?\b|\bpowerpoint\b|\bpptx?\b|\brapports?\b|\bpresentation\w*\b|\bdiaporama\b|\bslides?\b|\blivrables?\b|\bdocument\w*\b|\bartifact\b/, tools: ["artifact.create"], label: "artifact.create (document téléchargeable réel)" },
  { pattern: /\bfichier\w*\b|\bfiles?\b|\bcreation de fichier\b|\bcreer un fichier\b|\bexport\w*\b/, tools: ["file.create"], label: "file.create (fichier d'espace de travail)" },
  { pattern: /\blire (un|le|les) fichier\w*\b|\blecture de fichier\b|\bread file\b|\bcontenu d'un fichier\b/, tools: ["file.read"], label: "file.read (lecture de fichier)" },
  { pattern: /\bzip\b|\barchive\w*\b/, tools: ["zip.create"], label: "zip.create (archive ZIP persistée)" },
  // — Connaissance & mémoire
  { pattern: /\bconnaissance\w*\b|\bknowledge\b|\bbase documentaire\b|\bdocuments internes\b|\bdocs internes\b|\bindex documentaire\b/, tools: ["knowledge.search"], label: "knowledge.search (base de connaissances du projet)" },
  { pattern: /\bmemoire\b|\bmemory\b|\bse souvenir\b|\bmemoris\w*\b|\bcontexte persistant\b/, tools: ["memory.read"], label: "memory.read (mémoire utilisateur)" },
  // — Voix & téléphone & caméra
  { pattern: /\bvoix\b|\bvoice\b|\bvocal\w*\b|\btts\b|\bspeech\b|\bsynthese vocale\b|\baudio\b|\bpodcast\b/, tools: ["voice.speak"], label: "voice.speak (audio naturel à partir du texte)" },
  { pattern: /\bphone\b|\bappel\w*\b|\btelephon\w*\b|\btéléphone\b/, tools: ["phone.call"], label: "phone.call (appel IA sortant borné)" },
  { pattern: /\bcamera\b|\bcapture\w*\b/, tools: ["camera.capture"], label: "camera.capture (capture autorisée)" },
  // — Outils explicitement SANS équivalent Gen3ia : reconnus comme « removed »
  //   avec une raison claire plutôt que silencieusement perdus.
  { pattern: /\bjira\b|\btrello\b|\basana\b|\blinear\b|\bclickup\b|\bmonday\b|\bconfluence\b/, tools: [], label: "aucun équivalent direct Gen3ia — connectez l'app via MCP ou Composio (Intégrations)" },
];

/**
 * Résout une liste d'outils déclarés en liste canonique du registre :
 *  - un nom canonique exact reste (« kept ») ;
 *  - un alias en clair reconnu est traduit (« mapped ») ;
 *  - une entrée inconnue est retirée avec raison (« removed »).
 * Pur, déterministe, sans effet de bord — testable exhaustivement.
 */
export function resolveDeclaredTools(rawTools: readonly string[]): ToolResolution {
  const resolved: string[] = [];
  const seen = new Set<string>();
  const unknown: string[] = [];
  const mapping: ToolResolutionEntry[] = [];

  for (const raw of rawTools) {
    const trimmed = raw.trim();
    if (!trimmed || mapping.some((entry) => entry.from === trimmed)) continue;
    const normalized = normalizeToolName(trimmed);
    const canonical = normalizeToolName(trimmed).replace(/\s+/g, ".");

    // 1) Nom canonique exact (forme registre : web.search, email.send…).
    if (REGISTRY_SET.has(trimmed) || REGISTRY_SET.has(canonical)) {
      const name = REGISTRY_SET.has(trimmed) ? trimmed : canonical;
      if (!seen.has(name)) {
        seen.add(name);
        resolved.push(name);
      }
      mapping.push({ from: trimmed, to: name, status: "kept", reason: "outil réel du registre Gen3ia" });
      continue;
    }

    // 2) Alias en clair reconnu (première règle gagnante).
    const rule = ALIAS_RULES.find((candidate) => candidate.pattern.test(normalized));
    if (rule) {
      if (rule.tools.length === 0) {
        // Intention reconnue mais sans équivalent : retiré AVEC raison
        // actionnable (jamais silencieux).
        mapping.push({ from: trimmed, status: "removed", reason: rule.label });
        if (!unknown.includes(trimmed)) unknown.push(trimmed);
        continue;
      }
      for (const tool of rule.tools) {
        if (!seen.has(tool)) {
          seen.add(tool);
          resolved.push(tool);
        }
      }
      mapping.push({ from: trimmed, to: rule.tools.join(", "), status: "mapped", reason: rule.label });
      continue;
    }

    // 3) Aucune correspondance : retiré explicitement.
    mapping.push({ from: trimmed, status: "removed", reason: "outil inconnu du registre Gen3ia" });
    if (!unknown.includes(trimmed)) unknown.push(trimmed);
  }

  return { resolved: resolved.slice(0, 50), unknown, mapping };
}

const SENSITIVE_RISKS = new Set(["external", "destructive"]);

/**
 * Durcissement automatique de la config : un mode « Autoriser
 * automatiquement » combiné à au moins un outil à risque external ou
 * destructive est rétrogradé en « Demander si nécessaire ». La config
 * proposée devient honnête — les actions sensibles passeront bien par une
 * validation humaine, comme le fera le runtime.
 */
export function hardenAuthorizationMode(
  resolvedTools: readonly string[],
  mode: AuthorizationMode,
): ToolHardening {
  const sensitiveTools = GEN3IA_TOOLS
    .filter((tool) => resolvedTools.includes(tool.name) && SENSITIVE_RISKS.has(tool.risk))
    .map((tool) => tool.name);
  if (mode === "auto_allow" && sensitiveTools.length > 0) {
    return { mode: "ask_if_needed", hardened: true, sensitiveTools };
  }
  return { mode, hardened: false, sensitiveTools };
}

/** Rapport condensé destiné à l'utilisateur (proposal / création). */
export interface ToolReport {
  /** Outils réels retenus après résolution. */
  tools: string[];
  /** Alias traduits : « Gmail » → email.send. */
  mapped: Array<{ from: string; to: string; reason?: string }>;
  /** Entrées retirées avec raison (jamais silencieuses). */
  removed: Array<{ from: string; reason?: string }>;
  /** Outils sensibles détectés (external/destructive). */
  sensitiveTools: string[];
  /** true si auto_allow a été rétrogradé en ask_if_needed. */
  hardened: boolean;
}

export function buildToolReport(resolution: ToolResolution, hardening: ToolHardening): ToolReport {
  return {
    tools: resolution.resolved,
    mapped: resolution.mapping
      .filter((entry) => entry.status === "mapped" && entry.to)
      .map((entry) => ({ from: entry.from, to: entry.to as string, reason: entry.reason })),
    removed: resolution.mapping
      .filter((entry) => entry.status === "removed")
      .map((entry) => ({ from: entry.from, reason: entry.reason })),
    sensitiveTools: hardening.sensitiveTools,
    hardened: hardening.hardened,
  };
}

/**
 * Convenience : résout puis durcit en un appel — le contrat utilisé par les
 * routes de génération et de création d'agents.
 */
export function resolveAndHarden(
  rawTools: readonly string[],
  mode: AuthorizationMode,
): { resolution: ToolResolution; hardening: ToolHardening; report: ToolReport } {
  const resolution = resolveDeclaredTools(rawTools);
  const hardening = hardenAuthorizationMode(resolution.resolved, mode);
  return { resolution, hardening, report: buildToolReport(resolution, hardening) };
}
