/**
 * Rapport de configuration environnement — observable, jamais secret.
 *
 * Chaque groupe décrit une capacité du produit (fournisseurs LLM,
 * téléphonie, voix, publicités, facturation, e-mail, stockage, caches).
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
    group: "llm-openai",
    role: "Fournisseur LLM OpenAI (planner, chat, vision)",
    required: ["OPENAI_API_KEY"],
    fallback: "bascule automatique sur Groq / Agnes / GLM",
  },
  {
    group: "llm-groq",
    role: "Fournisseur LLM Groq (repli rapide)",
    required: ["GROQ_API_KEY"],
    fallback: "bascule sur OpenAI / Agnes",
  },
  {
    group: "llm-glm",
    role: "Fournisseur LLM GLM",
    required: ["GLM_API_KEY"],
    fallback: "bascule sur les autres fournisseurs LLM",
  },
  {
    group: "llm-agnes",
    role: "Fournisseur LLM Agnes (repli + images)",
    required: ["AGNES_API_KEY"],
    fallback: "bascule sur OpenAI / Groq",
  },
  {
    group: "cache-redis",
    role: "Redis Upstash (rate limit distribué, micro-caches, quotas Gen)",
    required: ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"],
    fallback: "repli en mémoire locale (mono-instance)",
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
    group: "telephony",
    role: "Téléphonie Twilio (appels sortants/entrants)",
    required: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER"],
    fallback: "outils phone.* indisponibles (jamais planifiés)",
  },
  {
    group: "voice",
    role: "Synthèse vocale ElevenLabs",
    required: ["ELEVENLABS_API_KEY"],
    fallback: "voix de repli navigateur",
  },
  {
    group: "tools-composio",
    role: "Connecteurs externes Composio (Gmail, Notion, Slack, ads…)",
    required: ["COMPOSIO_API_KEY"],
    fallback: "API directes par URL (web.api) restent disponibles",
  },
  {
    group: "billing-chariow",
    role: "Facturation Chariow (abonnements, recharges)",
    required: ["CHARIOW_API_BASE_URL", "CHARIOW_TOPUP_PRODUCT_ID"],
    fallback: "portefeuille d'accueil uniquement",
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
    group: "data-supabase",
    role: "Supabase/PostgreSQL (backend de données piloté, ADR-006)",
    required: ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"],
    fallback: "Firestore (DATA_BACKEND=firebase) — état stable et supporté",
  },
];

/** Variables optionnelles reconnues mais jamais exigées (noms à part). */
const OPTIONAL_RECOGNIZED = [
  "OPENROUTER_API_KEY",
  "ANTHROPIC_API_KEY",
  "HF_TOKEN",
  "ELEVENLABS_VOICE_ID",
  "TWILIO_WEBHOOK_BASE_URL",
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
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "DATA_BACKEND",
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
