import "server-only";

/**
 * ORIGINE CANONIQUE DES PUBLICATIONS QSTASH (fix CodeQL js/request-forgery).
 *
 * POURQUOI CE MODULE : les destinations des publications de jobs (ticks de
 * mission, dispatch planifié, rendu/production vidéo) étaient dérivées de
 * l'ORIGINE DE LA REQUÊTE ENTRANTE (`process.env.GEN3IA_APP_ORIGIN?.trim()
 * || request.nextUrl.origin`). L'origine d'une requête HTTP est contrôlée
 * par l'appelant (header Host, URL absolue du proxy…) : un attaquant capable
 * de déclencher un enfilement pouvait donc FAISSIFIER la destination QStash
 * et faire publier un POST signé vers un serveur qu'il contrôle (exfiltration
 * du corps signé, SSRF sortant). Le modèle correct est l'inverse : la
 * destination est une propriété DU SERVEUR (variables d'environnement),
 * validée contre une ALLOWLIST stricte, et AUCUN repli sur l'hôte entrant
 * n'existe. Si l'origine canonique est absente ou invalide, la publication
 * est REFUSÉE (retour « non configuré » : les continuations par sondage
 * existantes prennent le relais, jamais de publication vers une cible
 * inconnue).
 *
 * TÉLÉMÉTRIE : console uniquement (warn une fois par processus et par
 * message) — JAMAIS d'écriture Firestore (une config cassée ne doit pas
 * générer de coût de lecture/écriture à chaque tick).
 */

/** Hôtes autorisés en dur (production canonique de l'app). */
const ALLOWED_JOB_HOSTS = new Set<string>(["gen3ia.online", "www.gen3ia.online", "gen3ia.vercel.app"]);

/** Hôtes de développement local — http toléré pour ces seuls hôtes. */
const LOCAL_HOSTS = new Set<string>(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Résolution de l'origine canonique des publications de jobs :
 *  - ok      → origine SANS slash final, prête pour les URL tick ;
 *  - "unset" → GEN3IA_APP_ORIGIN absente/vide ;
 *  - "invalid" → présente mais rejetée (URL malformée, protocole non https
 *    hors dev local, hôte hors allowlist).
 */
export type JobOriginResolution =
  | { ok: true; origin: string }
  | { ok: false; reason: "unset" | "invalid"; detail?: string };

/** Messages de warn déjà émis dans ce processus (un seul log par cause). */
const warnedKeys = new Set<string>();

/** Warn FR une fois par processus et par message — télémétrie console only. */
function warnOnce(key: string, message: string): void {
  if (warnedKeys.has(key)) return;
  warnedKeys.add(key);
  console.warn(`[queue/origin] ${message}`);
}

function isLocalHost(hostname: string): boolean {
  return LOCAL_HOSTS.has(hostname.toLowerCase());
}

/**
 * L'hôte donné peut-il servir de destination à une publication de job ?
 * Allowlist : hôtes de production en dur + hôtes additionnels déclarés dans
 * GEN3IA_ALLOWED_ORIGINS (origines https validées par les mêmes règles) +
 * hôtes locaux (dev). Utilisé par resolveJobOrigin ET par le contrôle
 * défense-en-profondeur de publishToDestination.
 */
export function isAllowedJobHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  if (!host) return false;
  if (isLocalHost(host)) return true;
  if (ALLOWED_JOB_HOSTS.has(host)) return true;
  for (const extra of extraAllowedHosts()) {
    if (extra === host) return true;
  }
  return false;
}

/**
 * Hôtes additionnels issus de GEN3IA_ALLOWED_ORIGINS (comma-separated
 * d'ORIGINES, ex. « https://staging.gen3ia.online,https://preview.vercel.app »).
 * Chaque entrée est validée par les MÊMES règles que GEN3IA_APP_ORIGIN
 * (URL https, ou http local) : une entrée invalide est ignorée — la liste
 * ne peut jamais élargir vers un protocole/hôte interdit. Lu À L'APPEL :
 * la variable devient active sans redéploiement (politique du dépôt).
 */
function extraAllowedHosts(): string[] {
  const raw = process.env.GEN3IA_ALLOWED_ORIGINS?.trim();
  if (!raw) return [];
  const hosts: string[] = [];
  for (const entry of raw.split(",")) {
    const candidate = entry.trim();
    if (!candidate) continue;
    try {
      const url = new URL(candidate);
      const httpsOrLocal = url.protocol === "https:" || (url.protocol === "http:" && isLocalHost(url.hostname));
      if (httpsOrLocal) hosts.push(url.hostname.toLowerCase());
    } catch {
      // Entrée malformée : ignorée silencieusement (une allowlist ne doit
      // jamais s'élargir par accident) — le warn de resolveJobOrigin suffit.
    }
  }
  return hosts;
}

/**
 * Valide une origine candidate et retourne sa forme canonique (schéma +
 * hôte, SANS slash final ni chemin — les receivers vivent à la racine).
 */
function validateOriginCandidate(candidate: string): { ok: true; origin: string } | { ok: false; detail: string } {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { ok: false, detail: `URL invalide (« ${candidate.slice(0, 100)} »)` };
  }
  // https obligatoire — SAUF dev local (http://localhost, 127.0.0.1, [::1]).
  const httpsOrLocal = url.protocol === "https:" || (url.protocol === "http:" && isLocalHost(url.hostname));
  if (!httpsOrLocal) {
    return { ok: false, detail: `Protocole non autorisé (${url.protocol}) — https requis hors développement local` };
  }
  if (!isAllowedJobHost(url.hostname)) {
    return { ok: false, detail: `Hôte non autorisé (« ${url.hostname} ») — absent de l'allowlist` };
  }
  // url.origin normalise hôte/port et ne porte jamais de slash final.
  return { ok: true, origin: url.origin };
}

/**
 * Origine canonique des publications de jobs — lit UNIQUEMENT
 * GEN3IA_APP_ORIGIN (JAMAIS l'origine de la requête : falsifiable).
 * Absente → { ok:false, reason:"unset" } ; invalide → "invalid" avec
 * détail ; dans les deux cas un warn FR est émis une fois par processus.
 */
export function resolveJobOrigin(): JobOriginResolution {
  const raw = process.env.GEN3IA_APP_ORIGIN?.trim();
  if (!raw) {
    warnOnce(
      "unset",
      "GEN3IA_APP_ORIGIN absente — aucune délivrance de tick ne sera effectuée. Configurez l'origine canonique de l'app (ex. https://gen3ia.online) ; la continuation par sondage prend le relais.",
    );
    return { ok: false, reason: "unset" };
  }
  const validated = validateOriginCandidate(raw);
  if (!validated.ok) {
    warnOnce(
      `invalid:${raw}`,
      `GEN3IA_APP_ORIGIN invalide (${validated.detail}) — publication de tick refusée. Hôtes autorisés : gen3ia.online, www.gen3ia.online, gen3ia.vercel.app, ou étendez GEN3IA_ALLOWED_ORIGINS.`,
    );
    return { ok: false, reason: "invalid", detail: validated.detail };
  }
  return { ok: true, origin: validated.origin };
}

/**
 * DÉFENSE EN PROFONDEUR (appelé par publishToDestination) : la destination
 * d'une publication QStash doit être https (http toléré pour le dev local)
 * et son hôte autorisé. Toute destination falsifiée (origine requête,
 * paramètre client, corps malveillant) est rejetée AVANT tout appel réseau.
 */
export function assertSafeDestinationUrl(destinationUrl: string): void {
  let url: URL;
  try {
    url = new URL(destinationUrl);
  } catch {
    throw new Error(`Destination de tick invalide (« ${destinationUrl.slice(0, 100)} ») — URL absolue attendue.`);
  }
  const httpsOrLocal = url.protocol === "https:" || (url.protocol === "http:" && isLocalHost(url.hostname));
  if (!httpsOrLocal) {
    throw new Error(`Destination de tick refusée : protocole ${url.protocol} non autorisé (https requis hors dev local).`);
  }
  if (!isAllowedJobHost(url.hostname)) {
    throw new Error(`Destination de tick refusée : hôte « ${url.hostname} » non autorisé (allowlist serveur).`);
  }
}
