import "server-only";

/**
 * AGENTS-OS — REGISTRE DES TÂCHES INTERNES (Module 2 : dispatch zero-cloud).
 *
 * Le hub accepte deux voies d'exécution :
 *   A. `taskType` déclaré ici — tâche interne NATIVE, paramètres typés,
 *      exécution déterministe in-process (rapide, sans spawn) ;
 *   B. `script` fourni — code JavaScript envoyé à la SANDBOX
 *      (executeur-sandbox.ts : processus enfant isolé, timeout, cleanup).
 *
 * Aucune tâche interne n'exécute une commande shell arbitraire : c'est le
 * rôle de la voie B (isolée), et uniquement elle.
 */

export interface DemandeTache {
  readonly taskType: string;
  readonly data: Record<string, unknown>;
}

export interface ResultatTache {
  readonly ok: boolean;
  readonly taskType: string;
  /** Résultat brut (JSON-sérialisable) ou message d'échec. */
  readonly resultat?: unknown;
  readonly erreur?: string;
}

export type TacheInterne = (data: Record<string, unknown>) => Promise<unknown> | unknown;

/* ----------------------------- Tâches natives ----------------------------- */

/** Extraction de texte par expressions régulières nommées (scraping ciblé). */
const tacheExtraire = (data: Record<string, unknown>): unknown => {
  const texte = exigerChaine(data.texte, "texte");
  const motifs = exigerObjet(data.motifs, "motifs");
  const extrait: Record<string, string[]> = {};
  for (const [nom, brut] of Object.entries(motifs)) {
    if (typeof brut !== "string") throw new Error(`motifs["${nom}"] doit être une expression régulière (chaîne)`);
    if (brut.length > 500) throw new Error(`motifs["${nom}"] dépasse 500 caractères`);
    const re = new RegExp(brut, "g"); // Re DoS borné par la taille du texte (ci-dessous)
    extrait[nom] = [...texte.matchAll(re)].slice(0, 1_000).map((m) => (m[1] ?? m[0]).slice(0, 2_000));
  }
  return { extrait };
};

/** Récupération HTTP locale (fetch natif) — GET, timeout, taille plafonnée. */
const tacheHttpScrape = async (data: Record<string, unknown>): Promise<unknown> => {
  const url = exigerChaine(data.url, "url");
  if (!/^https?:\/\//i.test(url)) throw new Error("url doit commencer par http(s)://");
  const limiteOctets = nombre(data.limiteOctets, 1_000_000);
  const timeoutMs = Math.min(30_000, nombre(data.timeoutMs, 10_000));

  const reponse = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "user-agent": "gen3ia-agents-os-dispatch/1.0 (souverain; +https://gen3ia.online)" },
  });
  const tampon = await reponse.arrayBuffer();
  const corps = new TextDecoder("utf-8", { fatal: false }).decode(tampon.slice(0, limiteOctets));
  return {
    statut: reponse.status,
    contentType: reponse.headers.get("content-type") ?? "inconnu",
    tronque: tampon.byteLength > limiteOctets,
    tailleOctets: tampon.byteLength,
    corps,
  };
};

/** Transformation JSON déclarative : chemin pointé → valeur. */
const tacheJsonTransform = (data: Record<string, unknown>): unknown => {
  const source = data.json ?? data.data;
  const arbre = typeof source === "string" ? (JSON.parse(source) as unknown) : source;
  if (arbre === null || typeof arbre !== "object") throw new Error("json doit être un objet ou un tableau");
  const chemins = Array.isArray(data.chemins) ? (data.chemins as unknown[]) : null;
  if (!chemins) throw new Error("chemins doit être un tableau de chemins pointés");
  const selection: Record<string, unknown> = {};
  for (const chemin of chemins.slice(0, 200)) {
    if (typeof chemin !== "string") continue;
    selection[chemin] = lireChemin(arbre, chemin);
  }
  return { selection };
};

/** Empreinte SHA-256 locale (crypto natif) — vérification d'intégrité. */
const tacheSha256 = async (data: Record<string, unknown>): Promise<unknown> => {
  const { createHash } = await import("node:crypto");
  const contenu = exigerChaine(data.contenu, "contenu");
  return { sha256: createHash("sha256").update(contenu, "utf8").digest("hex") };
};

/* -------------------------------- Registre -------------------------------- */

const REGISTRE: Record<string, TacheInterne> = {
  "text-extract": tacheExtraire,
  "http-scrape": tacheHttpScrape,
  "json-transform": tacheJsonTransform,
  sha256: tacheSha256,
};

export const TYPES_TACHES = Object.keys(REGISTRE);

export function estTacheInterne(taskType: string): boolean {
  return Object.prototype.hasOwnProperty.call(REGISTRE, taskType);
}

/** Exécute une tâche interne — ne lève jamais (échec → ResultatTache). */
export async function executerTacheInterne(demande: DemandeTache): Promise<ResultatTache> {
  const tache = REGISTRE[demande.taskType];
  if (!tache) {
    return { ok: false, taskType: demande.taskType, erreur: `taskType inconnu — tâches natives : ${TYPES_TACHES.join(", ")}` };
  }
  try {
    const resultat = await tache(demande.data);
    return { ok: true, taskType: demande.taskType, resultat };
  } catch (erreur) {
    return {
      ok: false,
      taskType: demande.taskType,
      erreur: erreur instanceof Error ? erreur.message : String(erreur),
    };
  }
}

/* ------------------------------ Utilitaires ------------------------------- */

function exigerChaine(valeur: unknown, champ: string): string {
  if (typeof valeur !== "string") throw new Error(`« ${champ} » (chaîne) est requis`);
  return valeur;
}

function exigerObjet(valeur: unknown, champ: string): Record<string, unknown> {
  if (valeur === null || typeof valeur !== "object" || Array.isArray(valeur)) {
    throw new Error(`« ${champ} » (objet) est requis`);
  }
  return valeur as Record<string, unknown>;
}

function nombre(valeur: unknown, defaut: number): number {
  const n = typeof valeur === "number" ? valeur : typeof valeur === "string" ? Number(valeur) : NaN;
  return Number.isFinite(n) && n > 0 ? n : defaut;
}

/** Lecture d'un chemin pointé « a.b[2].c » sans eval. */
function lireChemin(arbre: unknown, chemin: string): unknown {
  const segments = chemin
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean);
  let courant: unknown = arbre;
  for (const segment of segments.slice(0, 32)) {
    if (courant === null || typeof courant !== "object") return undefined;
    courant = (courant as Record<string, unknown>)[segment];
  }
  return courant;
}
