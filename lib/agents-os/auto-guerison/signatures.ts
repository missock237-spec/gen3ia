/**
 * AGENTS-OS — CATALOGUE DES SIGNATURES DE PANNE (Module 1 : auto-guérison).
 *
 * Chaque signature décrit une panne observable DANS LES LOGS (déterministe,
 * locale, souveraine — aucune heuristique LLM) et l'action de remédiation
 * déclarative associée. Le catalogue est purement déclaratif : l'ajout d'une
 * signature ne touche aucun autre fichier (ouvert à l'extension).
 *
 * POLITIQUE DE SÛRETÉ — trois niveaux d'action :
 *   · "diagnostic"      : journaliser + exposer (GET /api/v1/agents-os/daemon)
 *                        — AUCUNE mutation du système ;
 *   · "commande"        : exécuter une commande shell LOCALE déclarée ici,
 *                        plafonnée (timeout, pas d'interprétation dynamique) ;
 *   · "pm2" / "docker"  : relancer proprement un service nommé via le
 *                        gestionnaire de processus local.
 *
 * La remédiation n'agit que si la config du daemon active le niveau
 * correspondant (cf. daemon.ts — par défaut : diagnostic seul).
 */

export type NiveauAction = "diagnostic" | "commande" | "pm2" | "docker";

export interface SignaturePanne {
  /** Identifiant stable (journal, télémétrie, tests). */
  readonly id: string;
  /** Motif de détection (appliqué ligne à ligne, casse ignorée). */
  readonly motif: RegExp;
  /** Cause humaine — écrite telle quelle dans le journal. */
  readonly cause: string;
  /** Gravité : info < avertissement < critique. */
  readonly gravite: "info" | "avertissement" | "critique";
  /** Niveau d'action minimal requis pour remédier. */
  readonly niveau: NiveauAction;
  /** Action déclarée (selon niveau) — JAMAIS construite depuis les logs. */
  readonly action?: {
    /** Commande locale (niveau "commande") — tableau argv, pas de shell. */
    readonly commande?: readonly string[];
    /** Gestionnaire de service (niveaux "pm2"/"docker"). */
    readonly gestionnaire?: "pm2" | "docker";
    /** Service cible (nom PM2 / conteneur docker) ; `{{service}}` = groupe
     *  de capture nommé du motif, sinon nom fixe fourni par la config. */
    readonly service?: string;
    /** Arguments du redémarrage (pm2 restart <args...> <service>). */
    readonly args?: readonly string[];
  };
}

/**
 * Catalogue des pannes courantes couvertes nativement.
 *
 * Note sûreté : les actions "pm2"/"docker" ciblent des noms de services FIXES
 * ou des placeholders `{{service}}` rempli UNIQUEMENT par le groupe de capture
 * nommé du motif ou la config — jamais une ligne de log brute
 * (anti-injection, cf. remediateur.ts).
 */
export const SIGNATURES_PANNE: readonly SignaturePanne[] = [
  {
    id: "port-occupe",
    motif: /\bEADDRINUSE\b/i,
    cause: "Port déjà occupé — un autre processus écoute déjà sur le port cible.",
    gravite: "avertissement",
    niveau: "commande",
    action: {
      commande: ["bash", "-lc", "ss -ltnp | head -20"],
    },
  },
  {
    id: "fuite-memoire-heap",
    motif: /(FATAL ERROR:\s*Reached heap limit|JavaScript heap out of memory)/i,
    cause: "Épuisement du tas V8 — fuite mémoire ou budget RSS insuffisant.",
    gravite: "critique",
    niveau: "pm2",
    action: { gestionnaire: "pm2", service: "{{service}}", args: ["--update-env"] },
  },
  {
    id: "boucle-redemarrage-pm2",
    motif: /(exited with code (?!0)|max restarts reached|restart count exceeded)/i,
    cause: "Le service sort en boucle (code non nul / plafond de redémarrages atteint).",
    gravite: "critique",
    niveau: "pm2",
    action: { gestionnaire: "pm2", service: "{{service}}", args: ["--update-env"] },
  },
  {
    id: "module-introuvable",
    motif: /(Cannot find module|MODULE_NOT_FOUND)/,
    cause: "Dépendance manquante — node_modules incohérent ou installation partielle.",
    gravite: "critique",
    niveau: "commande",
    action: { commande: ["bash", "-lc", "npm ci --no-audit --no-fund"] },
  },
  {
    id: "disque-plein",
    motif: /\bENOSPC\b/i,
    cause: "Système de fichiers saturé — plus d'espace d'écriture.",
    gravite: "critique",
    niveau: "commande",
    action: { commande: ["bash", "-lc", "df -h && du -sh /tmp/* 2>/dev/null | sort -h | tail -5"] },
  },
  {
    id: "connexion-refusee",
    motif: /\bECONNREFUSED\b/i,
    cause: "Dépendance locale injoignable (base, cache, service interne) — probablement arrêtée.",
    gravite: "avertissement",
    niveau: "diagnostic",
  },
  {
    id: "exception-non-capturee",
    motif: /(uncaught exception|unhandledRejection|UNHANDLED REJECTION)/i,
    cause: "Exception non capturée — le gestionnaire de processus relancera le service.",
    gravite: "avertissement",
    niveau: "pm2",
    action: { gestionnaire: "pm2", service: "{{service}}", args: ["--update-env"] },
  },
  {
    id: "conteneur-mort",
    motif: /(container .* (exited|is unhealthy)|OOMKilled)/i,
    cause: "Conteneur Docker terminé ou tué (OOM) — relance demandée.",
    gravite: "critique",
    niveau: "docker",
    action: { gestionnaire: "docker", service: "{{service}}", args: [] },
  },
] as const;

/** Gravités ordonnées (tri des rapports). */
export const ORDRE_GRAVITE: Record<SignaturePanne["gravite"], number> = {
  info: 0,
  avertissement: 1,
  critique: 2,
};
