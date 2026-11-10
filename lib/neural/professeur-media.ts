import "server-only";

import { downloadFromR2 } from "@/lib/storage/r2";

/**
 * PROFESSEUR MÉDIA TEMPORAIRE — échafaudage externe de la loi CONTRAINTE-ONDES.
 *
 * « Les IA que tu ajoutes à gen3 ne sont que temporaires car gen3 ne
 *   fonctionne pas comme eux ; le GPU de Colab ne doit servir qu'à traiter
 *   le signal d'onde de gen3. »
 *
 * Rôle : tant que les poids média du signal d'onde gen3 (sd-photoreal-v2,
 * kokoro, vidéo) ne sont pas distillés dans le moteur d'ondes natif (pipeline
 * Colab → RPIA), un professeur externe fournit les médias RÉELS (image
 * photoréaliste, voix humaine, vidéo réaliste) exigés par les utilisateurs.
 * Chaque œuvre porte la mention honnête `echafaudage: true` — elle sera
 * produite demain par le signal d'onde gen3 lui-même après distillation
 * (professeur supprimable sans toucher au reste du projet).
 *
 * Activation (aucun secret dans le code — lecture runtime uniquement) :
 *   - variable d'environnement ZAI_CONFIG_JSON (JSON {baseUrl, apiKey, …})
 *   - ou fichier .z-ai-config : /etc → $HOME → process.cwd()
 * Sans configuration, le professeur est ABSENT : les moteurs neuronaux
 * locaux (compositions abstraites honnêtes) prennent la main.
 */

/** Voix TTS documentées de la passerelle (roster officiel, défaut tongtong). */
export const VOIX_PROFESSEUR = [
  "tongtong",
  "chuichui",
  "xiaochen",
  "jam",
  "kazi",
  "douji",
  "luodo",
] as const;

export type VoixProfesseur = (typeof VOIX_PROFESSEUR)[number];

export interface ConfigurationProfesseur {
  baseUrl: string;
  apiKey: string;
  chatId?: string;
  userId?: string;
  token?: string;
  /** Voix TTS (défaut : tongtong — français correct). */
  voix?: string;
  /** Jeton Hugging Face (Inference Providers) — demande propriétaire :
   *  « Utilise Hugging Face pour générer des ressources multimodales :
   *  images photoréalistes ». La passerelle interne est injoignable depuis
   *  un VPS public (adresses privées 172.25/16, constat it.144) — HF est
   *  public et le chemin de production. */
  hfToken?: string;
  /** Modèle text-to-image HF (défaut : SD3-medium — hf-inference vivant). */
  hfModel?: string;
}

let cacheConfig: ConfigurationProfesseur | null | undefined;

/** Normalise un objet de config brut (env, fichier, R2) — exporté pour la garde. */
export function normaliserConfigurationProfesseur(
  parsed: Partial<ConfigurationProfesseur>,
): ConfigurationProfesseur | null {
  if (typeof parsed.baseUrl === "string" && typeof parsed.apiKey === "string"
    && parsed.baseUrl.length > 0 && parsed.apiKey.length > 0) {
    return {
      baseUrl: parsed.baseUrl.replace(/\/$/, ""),
      apiKey: parsed.apiKey,
      ...(typeof parsed.chatId === "string" && parsed.chatId ? { chatId: parsed.chatId } : {}),
      ...(typeof parsed.userId === "string" && parsed.userId ? { userId: parsed.userId } : {}),
      ...(typeof parsed.token === "string" && parsed.token ? { token: parsed.token } : {}),
      ...(typeof parsed.voix === "string" && parsed.voix ? { voix: parsed.voix } : {}),
      ...(typeof parsed.hfToken === "string" && parsed.hfToken ? { hfToken: parsed.hfToken } : {}),
      ...(typeof parsed.hfModel === "string" && parsed.hfModel ? { hfModel: parsed.hfModel } : {}),
    };
  }
  return null;
}

/** Lit la configuration du professeur (mise en cache, lecture unique) —
 *  chemin SYNC historique : env puis fichiers locaux (le canal R2 est
 *  uniquement dans la résolution async). */
export function configurationProfesseur(): ConfigurationProfesseur | null {
  if (cacheConfig !== undefined) return cacheConfig;
  const brutEnv = process.env.ZAI_CONFIG_JSON;
  if (brutEnv) {
    try {
      const config = normaliserConfigurationProfesseur(
        JSON.parse(brutEnv) as Partial<ConfigurationProfesseur>,
      );
      if (config) {
        cacheConfig = config;
        return config;
      }
    } catch {
      // env illisible → fichiers
    }
  }
  cacheConfig = chargerFichiersProfesseur();
  return cacheConfig;
}

/* ---- CANAL R2 (mode pull) ------------------------------------------------
 * Le canal SSH du CD est muet : l'installation /opt/gen3ia/.z-ai-config
 * n'a JAMAIS réussi en mode pull (runs #79→…→#471 skippés) — le professeur
 * était donc absent de la production. Le runner CD dépose désormais la
 * config dans le bucket R2 PRIVÉ de l'application (credentials du .env
 * de production) et l'application la lit ici au runtime — cache positif
 * 6 h / négatif 10 min pour ne jamais marteler R2.
 */
export const CLE_R2_CONFIG_PROFESSEUR = "private/professeur-media/z-ai-config.json";
const TTL_R2_POSITIF_MS = 6 * 60 * 60 * 1000;
const TTL_R2_NEGATIF_MS = 10 * 60 * 1000;

let cacheR2Config: { config: ConfigurationProfesseur | null; expiration: number } | null = null;
let cacheResolue: { config: ConfigurationProfesseur | null; expiration: number } | null = null;

/** Résolution ASYNC de la configuration — ORDRE (constat it.144 : un
 *  fichier héritage /opt/gen3ia/.z-ai-config SANS hfToken masquait la
 *  livraison R2) : 1. env ZAI_CONFIG_JSON → 2. bucket R2 privé (canal CD,
 *  source de vérité fraîche portée par le secret) → 3. fichiers locaux
 *  (héritage SSH/dev). Zéro throw — absent ⇒ null (repli honnête). */
export async function configurationProfesseurAsync(): Promise<ConfigurationProfesseur | null> {
  const maintenant = Date.now();
  if (cacheResolue && maintenant < cacheResolue.expiration) return cacheResolue.config;

  // 1) env (premier candidat historique — contrat inchangé)
  const brutEnv = process.env.ZAI_CONFIG_JSON;
  if (brutEnv) {
    try {
      const parsed = JSON.parse(brutEnv) as Partial<ConfigurationProfesseur>;
      const config = normaliserConfigurationProfesseur(parsed);
      if (config) {
        cacheResolue = { config, expiration: maintenant + TTL_R2_POSITIF_MS };
        return config;
      }
    } catch {
      // env illisible → candidats suivants
    }
  }

  // 2) R2 (canal CD — porte hfToken/métadonnées fraîches)
  if (cacheR2Config && maintenant < cacheR2Config.expiration) {
    // cache R2 déjà résolu pour cette fenêtre
  } else {
    try {
      const brut = await downloadFromR2(CLE_R2_CONFIG_PROFESSEUR, 64 * 1024);
      const parsed = JSON.parse(brut.toString("utf-8")) as Partial<ConfigurationProfesseur>;
      const config = normaliserConfigurationProfesseur(parsed);
      cacheR2Config = { config, expiration: maintenant + (config ? TTL_R2_POSITIF_MS : TTL_R2_NEGATIF_MS) };
    } catch {
      // clé absente / R2 indisponible / JSON illisible → absent (cache négatif)
      cacheR2Config = { config: null, expiration: maintenant + TTL_R2_NEGATIF_MS };
    }
  }
  if (cacheR2Config?.config) {
    cacheResolue = { config: cacheR2Config.config, expiration: maintenant + TTL_R2_POSITIF_MS };
    return cacheR2Config.config;
  }

  // 3) fichiers locaux (héritage SSH/dev)
  const locale = chargerFichiersProfesseur();
  cacheResolue = { config: locale, expiration: maintenant + (locale ? TTL_R2_POSITIF_MS : TTL_R2_NEGATIF_MS) };
  return locale;
}

/** Disponibilité ASYNC du professeur (mêmes gardes d'environnement que la
 *  version sync + candidat R2). */
export async function professeurDisponibleAsync(): Promise<boolean> {
  if (process.env.GEN3_PROFESSEUR_MEDIA === "0") return false;
  if (process.env.NODE_ENV === "test") return false;
  return (await configurationProfesseurAsync()) !== null;
}

/** Le professeur peut-il produire une image ICI, MAINTENANT ? — config
 *  présente ET (passerelle joignable OU jeton HF configuré). Utilisé par le
 *  routage chat : photoréaliste → serveur si oui, WebGPU navigateur sinon. */
export async function professeurImageDisponibleAsync(): Promise<boolean> {
  if (process.env.GEN3_PROFESSEUR_MEDIA === "0") return false;
  if (process.env.NODE_ENV === "test") return false;
  const config = await configurationProfesseurAsync();
  if (!config) return false;
  if (await professeurGatewayAtteignable()) return true;
  return Boolean(config.hfToken);
}

function chargerFichiersProfesseur(): ConfigurationProfesseur | null {
  // GEN3_PROFESSEUR_FICHIERS_LOCALS=0 : ignore les candidats FICHIERS
  // (/etc, $HOME, cwd, /opt) — isolation de test et mode R2-seul. L'env
  // ZAI_CONFIG_JSON est traité AVANT (priorité 1) hors de cette fonction.
  const ignorerFichiers = process.env.GEN3_PROFESSEUR_FICHIERS_LOCALS === "0";
  if (ignorerFichiers) return null;
  const candidats: Array<() => string | null> = [
    ...[
          () => lireFichier("/etc/.z-ai-config"),
          () => lireFichier(`${process.env.HOME ?? "/root"}/.z-ai-config`),
          () => lireFichier(`${process.cwd()}/.z-ai-config`),
          // VPS de production : le cwd de PM2 peut différer du répertoire
          // applicatif (le workflow CD y dépose la config via SSH). Chemin
          // explicite + racine passée par variable d'environnement.
          () => lireFichier("/opt/gen3ia/.z-ai-config"),
          () => (process.env.GEN3IA_ROOT ? lireFichier(`${process.env.GEN3IA_ROOT}/.z-ai-config`) : null),
        ],
  ];
  for (const lire of candidats) {
    const brut = lire();
    if (!brut) continue;
    try {
      const parsed = JSON.parse(brut) as Partial<ConfigurationProfesseur>;
      const config = normaliserConfigurationProfesseur(parsed);
      if (config) return config;
    } catch {
      // Config illisible → candidat suivant.
    }
  }
  return null;
}

function lireFichier(chemin: string): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    return readFileSync(chemin, "utf-8");
  } catch {
    return null;
  }
}

/** Le professeur est-il disponible (config présente, environnement admis) ?
 *  Désactivable explicitement par GEN3_PROFESSEUR_MEDIA=0 ; jamais actif
 *  sous les tests (NODE_ENV=test) pour éviter tout appel réseau réel. */
export function professeurDisponible(): boolean {
  if (process.env.GEN3_PROFESSEUR_MEDIA === "0") return false;
  if (process.env.NODE_ENV === "test") return false;
  return configurationProfesseur() !== null;
}

/* ------------------------------------------------------------------ */
/* Client HTTP minimal (endpoints du professeur)                       */
/* ------------------------------------------------------------------ */

function enTetes(config: ConfigurationProfesseur): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.apiKey}`,
    "X-Z-AI-From": "Z",
  };
  if (config.chatId) h["X-Chat-Id"] = config.chatId;
  if (config.userId) h["X-User-Id"] = config.userId;
  if (config.token) h["X-Token"] = config.token;
  return h;
}

async function fetchAvecDélai(
  url: string,
  init: RequestInit,
  délaiMs: number,
): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(délaiMs) });
}

/* ------------------------------------------------------------------ */
/* IMAGE PHOTORÉALISTE                                                 */
/* ------------------------------------------------------------------ */

/** Tailles admises par le professeur (mêmes ratios que gen3). */
const TAILLES_IMAGE: Record<string, string> = {
  "1:1": "1024x1024",
  "3:4": "864x1152",
  "4:3": "1152x864",
  "16:9": "1344x768",
  "9:16": "768x1344",
  "2:3": "832x1248",
  "3:2": "1248x832",
  "21:9": "1344x576",
};

export interface ŒuvreProfesseur {
  buffer: Buffer;
  mime: string;
  meta: Record<string, unknown>;
}

/** Amélioration déterministe du prompt (sujet INTACT, rendu photo). Exporté
 *  pour la garde photoréaliste. */
export function durcirPromptImage(prompt: string): string {
  const bas = prompt.toLowerCase();
  const déjàPhoto = /(photograph|photoreal|photor[eé]aliste|hyper[- ]?r[eé]aliste|ultra[- ]?r[eé]aliste|r[eé]aliste)/.test(bas);
  const noyaux = [
    prompt,
    déjàPhoto ? "" : "photographier, rendu photoréaliste",
    "lumière naturelle",
    "mise au point nette",
    "profondeur de champ réaliste",
    "haute définition",
  ].filter(Boolean);
  return noyaux.join(", ").slice(0, 1200);
}

/** Génère une image PHOTORÉALISTE via le professeur (échafaudage).
 *  ÉCHELLE DE MOTEURS (constat réseau it.144) : la passerelle interne
 *  (adresses privées 172.25/16) est injoignable depuis un VPS public —
 *  Hugging Face (Inference Providers, token du propriétaire) est le chemin
 *  de production ; la passerelle reste le chemin de l'environnement
 *  d'exécution intégré (sandbox/dev). */
export async function professeurImage(params: {
  prompt: string;
  ratio?: string;
}): Promise<ŒuvreProfesseur> {
  const config = await configurationProfesseurAsync();
  if (!config) throw new Error("Professeur média absent (configuration manquante).");
  const erreurs: string[] = [];
  // 1) passerelle interne (sandbox/dev — réseau privé)
  if (await professeurGatewayAtteignable()) {
    try {
      return await professeurImagePasserelle(params, config);
    } catch (erreur) {
      erreurs.push(`passerelle : ${erreur instanceof Error ? erreur.message : String(erreur)}`);
    }
  } else {
    erreurs.push("passerelle : injoignable depuis ce réseau (adresses privées)");
  }
  // 2) Hugging Face Inference Providers (public — chemin officiel)
  if (config.hfToken) {
    try {
      return await professeurImageHf(params, config);
    } catch (erreur) {
      erreurs.push(`hugging face : ${erreur instanceof Error ? erreur.message : String(erreur)}`);
    }
  }
  // 2 bis) espace HF gratuit (quota ZeroGPU du jeton — constat it.144 :
  //  le router 402 sans crédits, l'espace répond event complete)
  if (config.hfToken) {
    try {
      return await professeurImageEspace(params, config);
    } catch (erreur) {
      erreurs.push(`espace hf : ${erreur instanceof Error ? erreur.message : String(erreur)}`);
    }
  }
  throw new Error(`Aucun moteur d'image disponible — ${erreurs.join(" · ")}`);
}

/** Sonde d'ATTEIGNABILITÉ de la passerelle interne (cache 10 min) — permet
 *  au routage chat d'envoyer les demandes photoréalistes vers WebGPU quand
 *  le serveur ne peut pas joindre la passerelle (VPS public). */
let cacheAtteignable: { valeur: boolean; expiration: number } | null = null;

export async function professeurGatewayAtteignable(): Promise<boolean> {
  const maintenant = Date.now();
  if (cacheAtteignable && maintenant < cacheAtteignable.expiration) return cacheAtteignable.valeur;
  const config = await configurationProfesseurAsync();
  let valeur = false;
  if (config) {
    try {
      const r = await fetchAvecDélai(config.baseUrl, { method: "GET" }, 4_000);
      valeur = r.status < 500; // 301/302/4xx = réseau OK (c'est le routage qui compte)
    } catch {
      valeur = false;
    }
  }
  cacheAtteignable = { valeur, expiration: maintenant + 10 * 60 * 1000 };
  return valeur;
}

/** Moteur 1 — passerelle interne (POST /images/generations, réseau privé). */
async function professeurImagePasserelle(
  params: { prompt: string; ratio?: string },
  config: ConfigurationProfesseur,
): Promise<ŒuvreProfesseur> {
  const taille = TAILLES_IMAGE[params.ratio ?? "1:1"] ?? "1024x1024";
  const prompt = durcirPromptImage(params.prompt);

  const réponse = await fetchAvecDélai(
    `${config.baseUrl}/images/generations`,
    {
      method: "POST",
      headers: enTetes(config),
      body: JSON.stringify({ prompt, size: taille }),
    },
    // 150 s (incidence réelle it.144, 2026-11-10) : la passerelle mesure
    // 34 s en moyenne mais dépasse parfois 55 s — les échecs silencieux
    // déclenchaient le repli composition abstraite et l'utilisateur
    // recevait une scène plate au lieu d'un photoréalisme.
    150_000,
  );
  if (!réponse.ok) {
    throw new Error(`Professeur image ${réponse.status}: ${(await réponse.text()).slice(0, 200)}`);
  }
  const json = (await réponse.json()) as { data?: Array<{ url?: string; base64?: string }> };
  const premier = json.data?.[0];
  if (!premier) throw new Error("Professeur image : réponse vide.");

  let buffer: Buffer;
  if (typeof premier.base64 === "string" && premier.base64.length > 0) {
    buffer = Buffer.from(premier.base64, "base64");
  } else if (premier.url) {
    const téléchargement = await fetchAvecDélai(premier.url, {}, 120_000);
    if (!téléchargement.ok) throw new Error(`Professeur image : téléchargement ${téléchargement.status}`);
    buffer = Buffer.from(await téléchargement.arrayBuffer());
  } else {
    throw new Error("Professeur image : ni URL ni base64.");
  }
  if (buffer.length < 1024) throw new Error("Professeur image : fichier trop petit.");

  return {
    buffer,
    mime: mimeDepuisOctets(buffer, "image/jpeg"),
    meta: {
      moteur: "professeur-image-temporaire",
      echafaudage: true,
      loi: "CONTRAINTE-ONDES",
      professeurSupprimable: true,
      taille,
      octets: buffer.length,
      note: "Œuvre du professeur temporaire — le signal d'onde gen3 prendra le relais après distillation.",
    },
  };
}

/** Moteur 2 — Hugging Face Inference Providers (public, chemin de production).
 *  POST https://router.huggingface.co/hf-inference/models/{model} avec le
 *  token du propriétaire ; la réponse est l'image RAW (bytes). */
async function professeurImageHf(
  params: { prompt: string; ratio?: string },
  config: ConfigurationProfesseur,
): Promise<ŒuvreProfesseur> {
  const taille = (TAILLES_IMAGE[params.ratio ?? "1:1"] ?? "1024x1024").split("x");
  const largeur = Math.min(1536, Math.max(256, Number(taille[0]) || 1024));
  const hauteur = Math.min(1536, Math.max(256, Number(taille[1]) || 1024));
  const prompt = durcirPromptImage(params.prompt);
  const modèle = config.hfModel ?? "stabilityai/stable-diffusion-3-medium-diffusers";

  const réponse = await fetchAvecDélai(
    `https://router.huggingface.co/hf-inference/models/${modèle}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.hfToken}`,
      },
      body: JSON.stringify({
        inputs: prompt,
        parameters: { width: largeur, height: hauteur },
      }),
    },
    150_000,
  );
  if (!réponse.ok) {
    const corps = (await réponse.text()).slice(0, 200);
    throw new Error(`HF ${réponse.status} (${modèle}) : ${corps}`);
  }
  const buffer = Buffer.from(await réponse.arrayBuffer());
  if (buffer.length < 1024) throw new Error("HF : image trop petite.");
  return {
    buffer,
    mime: mimeDepuisOctets(buffer, "image/jpeg"),
    meta: {
      moteur: "professeur-image-hf",
      echafaudage: true,
      loi: "CONTRAINTE-ONDES",
      professeurSupprimable: true,
      hfModel: modèle,
      taille: `${largeur}x${hauteur}`,
      octets: buffer.length,
      note: "Œuvre du professeur temporaire (Hugging Face, demande propriétaire) — le signal d'onde gen3 prendra le relais après distillation.",
    },
  };
}

/* ------------------------------------------------------------------ */
/* ESPACE HF GRATUIT (gradio API — quota ZeroGPU du jeton)              */
/* ------------------------------------------------------------------ */

/** Constat it.144 (2026-11-10, sondes réelles) : le router hf-inference
 *  exige des crédits prépayés (HTTP 402 — « Purchase pre-paid credits ») et
 *  l'API legacy api-inference.huggingface.co n'existe plus (DNS vide). L'
 *  espace officiel black-forest-labs/FLUX.1-schnell sert en revanche la
 *  file d'attente GPU gratuite à tout porteur de jeton (sonde : image
 *  photoréaliste 1024×1024 livrée, event complete). Contrat gradio :
 *  POST /gradio_api/call/infer → {event_id}, puis GET
 *  /gradio_api/call/infer/{event_id} (SSE) — « event: complete » porte le
 *  tableau de fichiers, [0].url est l'image générée. */
const ESPACE_FLUX_SCHNELL = "https://black-forest-labs-flux-1-schnell.hf.space";

async function professeurImageEspace(
  params: { prompt: string; ratio?: string },
  config: ConfigurationProfesseur,
): Promise<ŒuvreProfesseur> {
  const taille = (TAILLES_IMAGE[params.ratio ?? "1:1"] ?? "1024x1024").split("x");
  const largeur = Math.min(1536, Math.max(256, Number(taille[0]) || 1024));
  const hauteur = Math.min(1536, Math.max(256, Number(taille[1]) || 1024));
  const prompt = durcirPromptImage(params.prompt);

  const lancement = await fetchAvecDélai(
    `${ESPACE_FLUX_SCHNELL}/gradio_api/call/infer`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.hfToken}`,
      },
      // contrat de la démo FLUX.1-schnell : [prompt, seed, randomize, largeur, hauteur, pas]
      body: JSON.stringify({ data: [prompt, 0, true, largeur, hauteur, 4] }),
    },
    60_000,
  );
  if (!lancement.ok) {
    throw new Error(`espace gradio ${lancement.status} : ${(await lancement.text()).slice(0, 200)}`);
  }
  const { event_id } = (await lancement.json()) as { event_id?: string };
  if (!event_id) throw new Error("espace gradio : event_id absent.");

  const flux = await fetchAvecDélai(
    `${ESPACE_FLUX_SCHNELL}/gradio_api/call/infer/${encodeURIComponent(event_id)}`,
    { headers: { Authorization: `Bearer ${config.hfToken}` } },
    150_000,
  );
  if (!flux.ok) throw new Error(`espace gradio flux ${flux.status}`);
  const sse = await flux.text();
  let issue = "";
  let donnee = "";
  for (const bloc of sse.split("\n\n")) {
    const ev = /^event:\s*(.+)$/m.exec(bloc);
    const da = /^data:\s*(.*)$/m.exec(bloc);
    if (ev) issue = ev[1]!.trim();
    if (da) donnee = da[1]!.trim();
  }
  if (issue !== "complete") {
    const detail = donnee && donnee !== "null" ? ` — ${donnee.slice(0, 120)}` : "";
    throw new Error(`espace gradio : file d'attente « ${issue || "inconnue"} »${detail}`);
  }
  const fichiers = JSON.parse(donnee || "[]") as Array<{ url?: string }>;
  const url = fichiers[0]?.url;
  if (!url) throw new Error("espace gradio : URL d'image absente du résultat.");
  const téléchargement = await fetchAvecDélai(url, {}, 120_000);
  if (!téléchargement.ok) throw new Error(`espace gradio : téléchargement ${téléchargement.status}`);
  const buffer = Buffer.from(await téléchargement.arrayBuffer());
  if (buffer.length < 1024) throw new Error("espace gradio : image trop petite.");
  return {
    buffer,
    mime: mimeDepuisOctets(buffer, "image/webp"),
    meta: {
      moteur: "professeur-image-espace-flux-schnell",
      echafaudage: true,
      loi: "CONTRAINTE-ONDES",
      professeurSupprimable: true,
      espace: "black-forest-labs/FLUX.1-schnell",
      taille: `${largeur}x${hauteur}`,
      octets: buffer.length,
      note: "Œuvre du professeur temporaire (espace HF FLUX.1-schnell, quota ZeroGPU du jeton) — le signal d'onde gen3 prendra le relais après distillation.",
    },
  };
}

/* ------------------------------------------------------------------ */
/* VOIX HUMAINE                                                        */
/* ------------------------------------------------------------------ */

/** Génère une VOIX HUMAINE (TTS) via le professeur (échafaudage).
 *  Voix au choix dans le roster documenté (VOIX_PROFESSEUR), vitesse
 *  réglable 0.5–2 ; la durée réelle est mesurée dans l'en-tête WAV renvoyé. */
export async function professeurVoix(params: {
  texte: string;
  vitesse?: number;
  voix?: string;
}): Promise<ŒuvreProfesseur> {
  const config = await configurationProfesseurAsync();
  if (!config) throw new Error("Professeur média absent (configuration manquante).");
  const texte = params.texte.trim().slice(0, 2000);
  if (texte.length < 2) throw new Error("Professeur voix : texte trop court.");

  // Défense en profondeur : une voix hors roster retombe sur la voix par défaut.
  const voixDemandée = (VOIX_PROFESSEUR as readonly string[]).includes(params.voix ?? "")
    ? (params.voix as VoixProfesseur)
    : undefined;
  const voix = voixDemandée ?? config.voix ?? "tongtong";

  const réponse = await fetchAvecDélai(
    `${config.baseUrl}/audio/tts`,
    {
      method: "POST",
      headers: enTetes(config),
      body: JSON.stringify({
        input: texte,
        voice: voix,
        speed: Math.min(2, Math.max(0.5, params.vitesse ?? 1)),
        response_format: "wav",
      }),
    },
    55_000,
  );
  if (!réponse.ok) {
    throw new Error(`Professeur voix ${réponse.status}: ${(await réponse.text()).slice(0, 200)}`);
  }
  const buffer = Buffer.from(await réponse.arrayBuffer());
  if (buffer.length < 1024) throw new Error("Professeur voix : audio vide.");
  const duree = dureeWavSecondes(buffer);

  return {
    buffer,
    mime: mimeDepuisOctets(buffer, "audio/wav"),
    meta: {
      moteur: "professeur-voix-temporaire",
      echafaudage: true,
      loi: "CONTRAINTE-ONDES",
      professeurSupprimable: true,
      voix,
      ...(duree !== undefined ? { duree } : {}),
      caractères: texte.length,
      octets: buffer.length,
      note: "Voix du professeur temporaire — le signal d'onde gen3 prendra le relais après distillation.",
    },
  };
}

/**
 * Durée réelle (secondes) lue dans l'en-tête WAV RIFF : parcours des chunks
 * (fmt → byteRate, data → octets PCM). Fail-soft : undefined si l'en-tête
 * est absent ou malformé — JAMAIS de durée inventée.
 */
export function dureeWavSecondes(buffer: Buffer): number | undefined {
  if (buffer.length < 44) return undefined;
  if (buffer.subarray(0, 4).toString("ascii") !== "RIFF") return undefined;
  if (buffer.subarray(8, 12).toString("ascii") !== "WAVE") return undefined;
  let byteRate = 0;
  let octetsDonnees = 0;
  let off = 12;
  for (let garde = 0; garde < 16 && off + 8 <= buffer.length; garde += 1) {
    const id = buffer.subarray(off, off + 4).toString("ascii");
    const brut = buffer.readUInt32LE(off + 4);
    const restant = buffer.length - (off + 8);
    const taille = Math.min(brut, Math.max(0, restant)); // clamp anti-malformation
    if (id === "fmt " && taille >= 16) {
      byteRate = buffer.readUInt32LE(off + 8 + 8); // fmt : format(2)+canaux(2)+sampleRate(4) puis byteRate(4)
    }
    if (id === "data") {
      octetsDonnees = taille;
      break;
    }
    off += 8 + taille + (taille % 2); // chunks alignés sur mot
  }
  if (byteRate <= 0 || octetsDonnees <= 0) return undefined;
  return Math.round((octetsDonnees / byteRate) * 100) / 100;
}

/* ------------------------------------------------------------------ */
/* TRANSCRIPTION VOCALE (ASR)                                          */
/* ------------------------------------------------------------------ */

/** Résultat honnête d'une tentative de transcription. */
export interface TranscriptionProfesseur {
  disponible: boolean;
  texte?: string;
  moteur?: string;
  echafaudage?: boolean;
  /** Raison honnête quand disponible === false. */
  raison?: string;
}

/**
 * Transcrit un AUDIO via le professeur (échafaudage) — configuration
 * passée EXPLICITEMENT (fonction pure testable : le mock fetch remplace
 * le réseau, aucune clé réelle n'est jamais lue en test).
 * Endpoint : POST {baseUrl}/audio/asr — corps { file_base64 }, réponse { text }
 * (contrat exact du SDK officiel z-ai-web-dev-sdk, client createAudioASR).
 */
export async function transcriptionViaProfesseurAvec(
  config: ConfigurationProfesseur,
  buffer: Buffer,
): Promise<{ texte: string; meta: Record<string, unknown> }> {
  if (buffer.length < 512) throw new Error("Professeur ASR : audio trop court.");
  if (buffer.length > 25_000_000) {
    throw new Error("Professeur ASR : audio trop volumineux (max 25 Mo).");
  }

  const réponse = await fetchAvecDélai(
    `${config.baseUrl}/audio/asr`,
    {
      method: "POST",
      headers: enTetes(config),
      body: JSON.stringify({ file_base64: buffer.toString("base64") }),
    },
    55_000,
  );
  if (!réponse.ok) {
    throw new Error(`Professeur ASR ${réponse.status}: ${(await réponse.text()).slice(0, 200)}`);
  }
  const json = (await réponse.json()) as { text?: unknown };
  if (typeof json.text !== "string" || json.text.trim().length === 0) {
    throw new Error("Professeur ASR : réponse sans texte.");
  }

  return {
    texte: json.text,
    meta: {
      moteur: "professeur-asr-temporaire",
      echafaudage: true,
      loi: "CONTRAINTE-ONDES",
      professeurSupprimable: true,
      caractères: json.text.length,
      octets: buffer.length,
      note: "Transcription du professeur temporaire — le signal d'onde gen3 prendra le relais après distillation.",
    },
  };
}

/**
 * Tente une transcription vocale réelle du buffer audio — FAIL-SOFT TOTAL :
 * professeur absent, erreur réseau ou réponse vide → { disponible: false,
 * raison } honnête. JAMAIS de texte inventé (règle it.58 / invariant
 * InterfaceVocaleTelephonique : pas de transcription fabriquée).
 */
export async function tenterTranscriptionProfesseur(
  buffer: Buffer,
): Promise<TranscriptionProfesseur> {
  if (!professeurDisponible()) {
    return {
      disponible: false,
      raison: "Aucun moteur de reconnaissance vocale configuré (professeur média absent) — mesures acoustiques seules.",
    };
  }
  try {
    const config = await configurationProfesseurAsync();
    if (!config) {
      return { disponible: false, raison: "Configuration professeur illisible — transcription indisponible." };
    }
    const œuvre = await transcriptionViaProfesseurAvec(config, buffer);
    return {
      disponible: true,
      texte: œuvre.texte,
      moteur: String(œuvre.meta.moteur ?? "professeur-asr-temporaire"),
      echafaudage: true,
    };
  } catch (erreur) {
    const raison = erreur instanceof Error ? erreur.message.slice(0, 200) : "erreur de transcription";
    return { disponible: false, raison: `Transcription indisponible : ${raison}` };
  }
}

/* ------------------------------------------------------------------ */
/* VIDÉO RÉALISTE (tâche asynchrone + sondage borné)                   */
/* ------------------------------------------------------------------ */

const TAILLES_VIDEO: Record<string, string> = {
  "1:1": "960x960",
  "16:9": "1280x720",
  "9:16": "720x1280",
  "4:3": "960x720",
  "3:4": "720x960",
};

interface TâcheVidéo {
  id?: string;
  task_status?: string;
  video_result?: Array<{ url?: string }>;
  video_url?: string;
  url?: string;
  video?: string;
}

/** Génère une VIDÉO réaliste via le professeur (échafaudage).
 *  Sondage borné (défaut 240 s) — au-delà, échec honnête (le client
 *  retombe sur les moteurs locaux). */
export async function professeurVideo(params: {
  prompt: string;
  ratio?: string;
  duréeSecondes?: number;
  délaiMaxMs?: number;
}): Promise<ŒuvreProfesseur> {
  const config = await configurationProfesseurAsync();
  if (!config) throw new Error("Professeur média absent (configuration manquante).");
  const prompt = params.prompt.trim().slice(0, 1500);
  if (prompt.length < 4) throw new Error("Professeur vidéo : prompt trop court.");
  const taille = TAILLES_VIDEO[params.ratio ?? "16:9"] ?? "1280x720";
  const durée = Math.min(10, Math.max(5, Math.round(params.duréeSecondes ?? 5)));

  // Création de tâche avec re-tentatives (429 « Too many requests » du
  // professeur : quota concurrent — on espace au lieu d'échouer net).
  let tâche: TâcheVidéo | null = null;
  for (let essai = 0; essai < 3; essai += 1) {
    const création = await fetchAvecDélai(
      `${config.baseUrl}/video/generation`,
      {
        method: "POST",
        headers: enTetes(config),
        body: JSON.stringify({
          prompt,
          quality: "speed",
          with_audio: true,
          size: taille,
          fps: 30,
          duration: durée,
        }),
      },
      55_000,
    );
    if (création.ok) {
      tâche = (await création.json()) as TâcheVidéo;
      break;
    }
    const corps = (await création.text()).slice(0, 200);
    if (création.status === 429 && essai < 2) {
      await new Promise((r) => setTimeout(r, 45_000 * (essai + 1))); // 45 s puis 90 s
      continue;
    }
    throw new Error(`Professeur vidéo ${création.status}: ${corps}`);
  }
  if (!tâche?.id) throw new Error("Professeur vidéo : identifiant de tâche absent.");

  const début = Date.now();
  const délaiMax = params.délaiMaxMs ?? 240_000;
  for (;;) {
    await new Promise((r) => setTimeout(r, 8_000));
    if (Date.now() - début > délaiMax) {
      throw new Error(`Professeur vidéo : délai dépassé (${Math.round(délaiMax / 1000)} s) — tâche ${tâche.id}.`);
    }
    const sonde = await fetchAvecDélai(
      `${config.baseUrl}/async-result?id=${encodeURIComponent(tâche.id)}`,
      { method: "GET", headers: enTetes(config) },
      30_000,
    );
    if (!sonde.ok) continue; // erreur réseau passagère : on re-sonde
    const résultat = (await sonde.json()) as TâcheVidéo;
    if (résultat.task_status === "SUCCESS") {
      const urlVidéo = résultat.video_result?.[0]?.url ?? résultat.video_url ?? résultat.url ?? résultat.video;
      if (!urlVidéo) throw new Error("Professeur vidéo : tâche réussie mais URL absente.");
      const téléchargement = await fetchAvecDélai(urlVidéo, {}, 120_000);
      if (!téléchargement.ok) throw new Error(`Professeur vidéo : téléchargement ${téléchargement.status}`);
      const buffer = Buffer.from(await téléchargement.arrayBuffer());
      if (buffer.length < 4096) throw new Error("Professeur vidéo : fichier trop petit.");
      return {
        buffer,
        mime: "video/mp4",
        meta: {
          moteur: "professeur-video-temporaire",
          echafaudage: true,
          loi: "CONTRAINTE-ONDES",
          professeurSupprimable: true,
          taille,
          durée,
          octets: buffer.length,
          note: "Vidéo du professeur temporaire — le signal d'onde gen3 prendra le relais après distillation.",
        },
      };
    }
    if (résultat.task_status === "FAIL") {
      throw new Error(`Professeur vidéo : tâche ${tâche.id} échouée côté professeur.`);
    }
    // PROCESSING ou statut inconnu → re-sonde jusqu'au délai.
  }
}

/* ------------------------------------------------------------------ */
/* Utilitaires                                                         */
/* ------------------------------------------------------------------ */

/** MIME réel (magic bytes) avec repli fourni. */
function mimeDepuisOctets(buffer: Buffer, repli: string): string {
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString("ascii") === "ftyp") return "video/mp4";
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) return "image/jpeg";
  if (buffer.length >= 8 && buffer.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") return "image/png";
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF"
    && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF"
    && buffer.subarray(8, 12).toString("ascii") === "WAVE") return "audio/wav";
  if (buffer.length >= 3 && buffer.subarray(0, 3).toString("ascii") === "ID3") return "audio/mpeg";
  if (buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) return "audio/mpeg";
  return repli;
}
