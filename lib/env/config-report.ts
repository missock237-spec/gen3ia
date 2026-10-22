/**
 * Rapport de configuration environnement — observable, jamais secret.
 *
 * Chaque groupe décrit une capacité du produit (fournisseurs LLM,
 * téléphonie, voix, publicités, facturation, e-mail, stockage).
 * Task 108 : plus de groupe de cache externe ni de second backend — le cache
 * est process-local (toujours disponible) et Firestore est l'unique moteur.
 * Le rapport n'expose QUE des booléens de présence et les noms des
 * variables manquantes : aucune valeur, jamais — même tronquée.
 *
 * Consommé par /api/health/infra (section `config`) pour que la
 * supervision sache QUOI est câblé sans avoir accès aux secrets, et par
 * le développement local pour diagnostiquer un .env.local incomplet.
 */

type EnvSource = Record<string, string | undefined>;

export interface EnvGroupReport {
  /** Clé stable du groupe (supervision, tests). */
  group: string;
  /** Capacité couverte, en clair. */
  role: string;
  /** true si TOUTES les variables requises du groupe sont présentes. */
  present: boolean;
  /** Variables requises absentes (noms uniquement). */
  missing: string[];
  /** Mode dégradé assumé quand absent (repli documenté). */
  fallback: string;
}

interface GroupSpec {
  group: string;
  role: string;
  /** Variables strictement requises (toutes). */
  required: string[];
  fallback: string;
}

const GROUPS: GroupSpec[] = [
  {
    group: "firebase-admin",
    role: "Firestore Admin (données serveur, provisioning, billing)",
    required: ["FIREBASE_PROJECT_ID", "FIREBASE_CLIENT_EMAIL", "FIREBASE_PRIVATE_KEY"],
    fallback: "aucun — la plateforme entière en dépend",
  },
  {
    group: "neural-gen3",
    role: "Moteur neuronal Gen3 (SNN interne — unique moteur IA, aucune clé requise)",
    required: [],
    fallback: "toujours actif (calcul local, tarif nul)",
  },
  {
    group: "vector-qdrant",
    role: "Qdrant (recherche vectorielle mémoires/connaissances/conversations)",
    required: ["QDRANT_URL", "QDRANT_API_KEY"],
    fallback: "repli cosine Firestore",
  },
  {
    group: "storage-r2",
    role: "Cloudflare R2 (fichiers, pièces jointes, artefacts)",
    required: ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"],
    fallback: "repli base de données (métadonnées) en attendant les credentials",
  },
  {
    group: "email-resend",
    role: "E-mail transactionnel Resend",
    required: ["RESEND_API_KEY", "EMAIL_FROM_ADDRESS"],
    fallback: "e-mails désactivés (aucun crash)",
  },
  {
    group: "tools-composio",
    role: "Connecteurs externes Composio (Gmail, Notion, Slack, ads…)",
    required: ["COMPOSIO_API_KEY"],
    fallback: "API directes par URL (web.api) restent disponibles",
  },
  {
    group: "billing-chariow",
    role: "Facturation Chariow (abonnements, recharges wallet, webhook Pulse)",
    required: ["CHARIOW_API_KEY", "CHARIOW_PULSE_SECRET"],
    // Produits par défaut de la boutique (plans + recharge prd_llfosdp1) : les
    // variables CHARIOW_PLAN_* et CHARIOW_TOPUP_PRODUCT_ID ne sont que des
    // surcharges. Sans clé API, le paiement direct passe par les widgets
    // boutique ; sans secret Pulse, le crédit wallet dépend du retour de
    // paiement vérifié (/api/billing/topup/verify).
    fallback: "widgets boutique pour le paiement direct ; crédit wallet au retour de paiement vérifié",
  },
  {
    group: "sandbox",
    role: "Sandbox Docker (exécution réelle de code)",
    required: ["SANDBOX_URL", "SANDBOX_SHARED_SECRET"],
    fallback: "simulation intégrée (par conception)",
  },
  {
    group: "observability-sentry",
    role: "Sentry (erreurs + traces + replay, tunnel /monitoring)",
    required: ["SENTRY_DSN", "NEXT_PUBLIC_SENTRY_DSN"],
    fallback: "logs structurés pino seuls (aucune perte applicative)",
  },
  {
    group: "queue-r2",
    role: "File de ticks R2 (missions agents longues, exécution par tranches — recommandation A) : dérivée de la configuration R2, aucune variable dédiée",
    required: [],
    fallback: "exécution synchrone dans la requête (limitée par la fenêtre serverless)",
  },
];

/**
 * Variables optionnelles reconnues mais jamais exigées (noms à part).
 *
 * Convention (audit médias 103-c) : TOUTE variable média réellement lue dans
 * le code (process.env.*) doit figurer ici — sinon la sonde
 * /api/health/infra signale un faux « écart » entre variables câblées et
 * variables reconnues. AGNES_API_KEY est le cas d'école : requise dans le
 * groupe llm-agnes (ci-dessus) ET reconnue ici (la reconnaissance optionnelle
 * n'est jamais bloquante, elle n'informe que la télémétrie de présence).
 */
const OPTIONAL_RECOGNIZED = [
  // HF_TOKEN : UNIQUEMENT pour l'import de datasets Hugging Face du Training
  // Studio (téléchargement de données — aucune inférence IA externe).
  "HF_TOKEN",
  "VIDEO_MAX_GENERATED_SCENE_VIDEOS",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "GOOGLE_ADS_DEVELOPER_TOKEN",
  "META_ADS_ACCESS_TOKEN",
  "TIKTOK_ADS_ACCESS_TOKEN",
  "LINKEDIN_ADS_ACCESS_TOKEN",
  "GITHUB_TOKEN",
  "SENTRY_DSN",
  "NEXT_PUBLIC_SENTRY_DSN",
  "SENTRY_AUTH_TOKEN",
  "SENTRY_ORG",
  "SENTRY_PROJECT",
  "SENTRY_ENVIRONMENT",
  "SENTRY_RELEASE",
  "NEXT_PUBLIC_ADSENSE_CLIENT",
  "NEXT_PUBLIC_ADSENSE_SLOT_HOME",
  // Pipeline vidéo (lib/video/security.ts, lib/video/render/fonts.ts,
  // lib/video/credits.ts) : binaires ffmpeg/ffprobe, police, release statique,
  // URL de binaires et coût de rendu — tous optionnels (replis par défaut).
  "VIDEO_FFMPEG_PATH",
  "VIDEO_FFPROBE_PATH",
  "VIDEO_FONT_PATH",
  "VIDEO_STATIC_RELEASE_TAG",
  "VIDEO_STATIC_BINARIES_URL",
  "VIDEO_RENDER_MINOR_PER_SEC",
  // Origine publique de l'app (callbacks planifiés, liens de reprise —
  // lib/agents/scheduler.ts, lib/video/production-queue.ts, routes de queue).
  "GEN3IA_APP_ORIGIN",
  // Escrow de mission (Task 114-a, lib/billing/mission-escrow.ts) : frais de
  // résultat (minor + plafond) et TTL des holds — tous optionnels (défauts
  // 5 000 / 50 000 minor, 7 jours).
  "GEN3IA_MISSION_RESULT_FEE_MINOR",
  "GEN3IA_MISSION_RESULT_FEE_MAX_MINOR",
  "GEN3IA_ESCROW_TTL_MS",
  // Chariow (lib/billing/chariow.ts) : produit de recharge wallet API
  // (défaut boutique prd_llfosdp1) et repli boutique /billing — surcharges
  // optionnelles, jamais requises.
  "CHARIOW_TOPUP_PRODUCT_ID",
  "CHARIOW_TOPUP_STORE_URL",
  "FIRESTORE_EMULATOR_HOST",
  "FIREBASE_AUTH_EMULATOR_HOST",
];

export function describeEnvGroups(env: EnvSource = process.env): EnvGroupReport[] {
  return GROUPS.map(({ group, role, required, fallback }) => {
    const missing = required.filter((name) => {
      const value = env[name];
      return typeof value !== "string" || value.trim().length === 0;
    });
    return { group, role, present: missing.length === 0, missing, fallback };
  });
}

/** Noms optionnels reconnus et effectivement présents (télémétrie douce). */
export function listRecognizedOptional(env: EnvSource = process.env): string[] {
  return OPTIONAL_RECOGNIZED.filter(
    (name) => typeof env[name] === "string" && (env[name] as string).trim().length > 0,
  );
}

/** Résumé compact pour la supervision : le vital est câblé ? */
export function summarizeEnv(env: EnvSource = process.env): {
  ok: boolean;
  groups: EnvGroupReport[];
  optionalRecognized: string[];
} {
  const groups = describeEnvGroups(env);
  // firebase-admin seul est vital : tout le reste a un repli assumé.
  const vital = groups.find((g) => g.group === "firebase-admin");
  return {
    ok: Boolean(vital?.present),
    groups,
    optionalRecognized: listRecognizedOptional(env),
  };
}
