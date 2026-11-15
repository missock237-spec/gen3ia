import "server-only";

/**
 * FEATURE FLAGS GEN3IA — registre minimal, typé, zéro dépendance (Task M).
 *
 * RÔLE : matérialiser le Trunk-Based Development (docs/processus-ingenierie.md
 * §2.1). Un travail non fini n'attend pas dans une branche longue : il entre
 * à `main` derrière un flag d'environnement — le `defaut` du catalogue
 * reproduit le comportement actuel (donc INACTIF pour une feature nouvelle,
 * ACTIF pour un kill-switch d'existant) — et se nettoie une fois consommé
 * (< 90 jours). C'est la généralisation du pattern éprouvé du dépôt :
 *  - PAYMENT_PROVIDER (lib/billing/payment-provider.ts) — flag fail-safe :
 *    toute valeur non reconnue FERME la fonctionnalité (501) ;
 *  - GEN3IA_BILLING_ENABLED (lib/billing/billing-mode.ts) — interrupteur
 *    global no-ops fail-soft ;
 *  - AGENT_TRIGGER_WEBHOOK_SECRET / METRICS_TOKEN — durcissement progressif
 *    déployé avant configuration.
 *
 * SÉMANTIQUE (contrat unique, documenté dans .env.example) :
 *  - chaque flag s'appelle GEN3IA_FLAG_<NOM> dans l'environnement ;
 *  - GEN3IA_FLAG_<NOM> = "1" | "true" | "on"  → ACTIF (insensible à la
 *    casse, espaces tolérés) ;
 *  - "0" | "false" | "off" → INACTIF (kill-switch explicite, prime sur le
 *    défaut du catalogue) ;
 *  - variable ABSENTE → valeur `defaut` du catalogue ;
 *  - toute AUTRE valeur (ex. "yes", "2", "oui") → défaut du catalogue + un
 *    SEUL warning console par flag et par process (configuration suspecte
 *    signalée, jamais interprétée en silence).
 *
 * LIMITES ASSUMÉES (documentées aussi dans docs/processus-ingenierie.md) :
 * les flags sont lus dans process.env À CHAQUE APPEL d'estActive() mais un
 * changement ne prend effet qu'au RESTART du process (sur le VPS PM2 :
 * `pm2 restart gen3ia`). Ce sont des flags de DÉPLOIEMENT, pas un système
 * d'activation à chaud par utilisateur — LaunchDarkly/Unleash seraient
 * disproportionnés à notre échelle (Phase 3 non déclenchée).
 */

/** Définition d'un flag connu du catalogue. */
export interface DefinitionFlag {
  /** Nom EXACT de la variable d'environnement (GEN3IA_FLAG_<NOM>). */
  readonly nom: string;
  /** À quoi sert le flag — en français, lisible par un humain pressé. */
  readonly description: string;
  /** Valeur quand la variable est ABSENTE (le défaut est le comportement sûr). */
  readonly defaut: boolean;
  /** Date/version d'introduction — sert au ménage (< 90 jours, §2 du processus). */
  readonly depuis: string;
}

/**
 * CATALOGUE DES FLAGS CONNUS — source de vérité unique.
 * L'ajout d'un flag se fait ICI (et dans .env.example le même commit) ;
 * le type `NomFlag` en est dérivé, donc un appel avec un nom inconnu ne
 * compile pas. Toute valeur non listée ici n'est PAS un flag : c'est une
 * faute de frappe potentielle.
 */
export const CATALOGUE_FLAGS = {
  /**
   * Kill-switch d'URGENCE de l'endpoint SLI /api/metrics (Task G). Défaut
   * ACTIF pour ne rien casser (l'endpoint existe depuis le Pilier 4) ;
   * GEN3IA_FLAG_SLI_ENDPOINT=0 renvoie un 404 JSON propre (scraping coupé,
   * collecte en mémoire inchangée — cf. app/api/metrics/route.ts).
   * Premier exemple réel du système de flags : la variable d'env déplace la
   * décision d'exposition hors du code, sans redéploiement.
   */
  SLI_ENDPOINT: {
    nom: "GEN3IA_FLAG_SLI_ENDPOINT",
    description:
      "Expose l'endpoint SLI /api/metrics (format texte Prometheus). " +
      "Kill-switch d'urgence : 0 → 404 JSON propre, scraping coupé " +
      "(la collecte en mémoire du registre continue, sans exposition).",
    defaut: true,
    depuis: "2026-10-23 (Task M — feature flags & TBD)",
  },
} as const satisfies Record<string, DefinitionFlag>;

/** Union des noms de flags connus — garantit la complétude à la compilation. */
export type NomFlag = keyof typeof CATALOGUE_FLAGS;

/** Valeurs d'env qui ACTIVENT un flag (insensible casse, après trim). */
const VALEURS_ACTIVES = new Set(["1", "true", "on"]);
/** Valeurs d'env qui DÉSACTIVENT explicitement un flag (kill-switch). */
const VALEURS_INACTIVES = new Set(["0", "false", "off"]);

/** Warnings déjà émis (un seul par flag et par process — pas de spam de logs). */
const warningsEmis = new Set<string>();

/** Construit le nom de variable d'environnement d'un flag (GEN3IA_FLAG_<NOM>). */
export function nomVariableEnv(nom: NomFlag): string {
  return `GEN3IA_FLAG_${nom}`;
}

/**
 * Lit la valeur brute de l'env pour un flag : { présente, normalisée }.
 * Trim + lowercase — le parse est volontairement tolérant sur la forme
 * (espaces, majuscules), strict sur le fond (valeurs reconnues seulement).
 */
function lireEnv(nom: NomFlag): { presente: boolean; normalisee: string } {
  const brute = process.env[nomVariableEnv(nom)];
  if (brute === undefined || brute.trim() === "") {
    // Variable absente OU vide : traitée identiquement (défaut du catalogue).
    return { presente: false, normalisee: "" };
  }
  return { presente: true, normalisee: brute.trim().toLowerCase() };
}

/**
 * Résout l'état d'un flag SANS effet de bord : { actif, source, valeurBrute }.
 * Exporté pour les tests et les diagnostics ; estActive() est l'API du code
 * applicatif.
 */
export function resoudreFlag(nom: NomFlag): {
  actif: boolean;
  source: "env" | "defaut";
  valeurBrute: string | null;
} {
  const definition = assertFlag(nom);
  const { presente, normalisee } = lireEnv(nom);
  if (!presente) {
    return { actif: definition.defaut, source: "defaut", valeurBrute: null };
  }
  if (VALEURS_ACTIVES.has(normalisee)) {
    return { actif: true, source: "env", valeurBrute: normalisee };
  }
  if (VALEURS_INACTIVES.has(normalisee)) {
    return { actif: false, source: "env", valeurBrute: normalisee };
  }
  // Valeur non reconnue : on retombe sur le DÉFAUT du catalogue (jamais
  // une interprétation silencieuse) et on signale une seule fois.
  if (!warningsEmis.has(definition.nom)) {
    warningsEmis.add(definition.nom);
    console.warn(
      `[flags] GEN3IA_FLAG_${nom} = "${normalisee}" n'est pas une valeur reconnue ` +
        `(1/true/on ou 0/false/off) — valeur par défaut appliquée (${definition.defaut}).`,
    );
  }
  return { actif: definition.defaut, source: "defaut", valeurBrute: normalisee };
}

/**
 * Est-ce que le flag est ACTIF ? API principale du code applicatif.
 *
 *   if (estActive("SLI_ENDPOINT")) { … }
 *
 * L'argument est typé par le catalogue : un nom inconnu ne compile pas en
 * TypeScript (et, venu du JS ou d'un appel dynamique, `assertFlag` lève).
 */
export function estActive(nom: NomFlag): boolean {
  return resoudreFlag(nom).actif;
}

/**
 * Vérifie que le nom appartient bien au catalogue et renvoie sa définition.
 * Garde-fou runtime (appels dynamiques / JS) : une faute de frappe lève une
 * erreur explicite en français au lieu d'un silence fail-soft trompeur.
 */
export function assertFlag(nom: NomFlag): DefinitionFlag {
  const definition = (CATALOGUE_FLAGS as Record<string, DefinitionFlag | undefined>)[nom];
  if (!definition) {
    throw new Error(
      `[flags] Flag inconnu « ${String(nom)} » — déclarer le flag dans ` +
        `CATALOGUE_FLAGS (lib/flags/feature-flags.ts) et dans .env.example.`,
    );
  }
  return definition;
}

/** Diagnostic d'un flag pour listeFlags() — état résolu + configuration. */
export interface DiagnosticFlag {
  readonly nom: NomFlag;
  readonly variable: string;
  readonly description: string;
  readonly defaut: boolean;
  readonly depuis: string;
  readonly actif: boolean;
  readonly source: "env" | "defaut";
  readonly valeurBrute: string | null;
}

/**
 * Liste TOUS les flags connus avec leur état RÉSOLU — pour /admin, les
 * diagnostics et les pages « pourquoi ce comportement ? ». Aucune valeur
 * secrète ici : un flag n'est jamais un secret (secrets uniquement dans les
 * secrets GitHub / .env.production, cf. docs/processus-ingenierie.md §3.2).
 */
export function listeFlags(): DiagnosticFlag[] {
  return (Object.keys(CATALOGUE_FLAGS) as NomFlag[]).map((nom) => {
    const definition = CATALOGUE_FLAGS[nom];
    const resolu = resoudreFlag(nom);
    return {
      nom,
      variable: definition.nom,
      description: definition.description,
      defaut: definition.defaut,
      depuis: definition.depuis,
      actif: resolu.actif,
      source: resolu.source,
      valeurBrute: resolu.valeurBrute,
    };
  });
}
