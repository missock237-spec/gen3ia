/**
 * POOL HTTP SORTANT — agent keep-alive (undici) + timeouts propres.
 *
 * RÔLE (Task 9-a — performance/échelle) : réutiliser les connexions TCP/TLS
 * entre appels sortants VERS LES MÊMES ORIGINES (certificats Google, API
 * Composio, hubs Hugging Face/Kaggle, moteurs de recherche…) au lieu d'ouvrir
 * une nouvelle connexion à chaque fetch. Gains mesurables :
 *  - économie du handshake TCP + TLS (1 à 3 RTT ≈ 30–200 ms par appel selon
 *    la distance) ;
 *  - latence p50 en baisse sur les chaînes d'appels répétés (auth, RAG,
 *    intégrations) ;
 *  - fewer sockets en état TIME_WAIT sur le VPS (charge kernel en baisse).
 *
 * IMPLÉMENTATION : `undici.Agent` avec pool de connexions keep-alive par
 * origine. undici est PRÉSENT dans le dépôt (pin package.json overrides
 * « undici: 7.30.1 » — transitive firebase-admin, hoistée au top-level) ;
 * Node 20+ l'expose. Import LAZY + repli gracieux : si l'import échoue
 * (environnement exotique), `requeteSortante` retombe sur le fetch global —
 * le pool est une ACCÉLÉRATION, jamais une dépendance dure.
 *
 * RUNTIME : Node uniquement (undici n'existe pas au runtime Edge). Ne pas
 * importer ce module depuis du code exécuté au runtime Edge (le middleware
 * est en runtime "nodejs" — OK).
 *
 * TIMEOUTS PROPRES (par défaut, surchargeables par appel) :
 *  - délai d'attente des en-têtes : 10 s (un serveur qui ne répond pas
 *    libère vite la connexion) ;
 *  - délai de lecture du corps : 30 s (téléchargements légitimes passent) ;
 *  - AbortSignal par requête : 10 s (défaut), le pilote N'EST JAMAIS
 *    laissé sans garde-fou temporel.
 *
 * AUCUN SECRET dans ce module : il ne journalise rien (ni URL avec
 * credentials, ni en-têtes d'autorisation).
 */

/** Connexions simultanées max PAR ORIGINE (au-delà, mise en file). */
const CONNEXIONS_PAR_ORIGINE = 64;

/** Keep-alive : une connexion inutilisée reste ouverte ~4 s (serveurs
 *  typiques ferment avant ; undici respecte l'indice du serveur si fourni). */
const KEEP_ALIVE_TIMEOUT_MS = 4_000;

/** Plafond absolu du keep-alive (undici ne dépassera jamais ce délai). */
const KEEP_ALIVE_MAX_TIMEOUT_MS = 60_000;

/** Timeout d'attente des en-têtes de réponse (par connexion). */
const TIMEOUT_EN_TETES_MS = 10_000;

/** Timeout de lecture du corps (entre deux chunks). */
const TIMEOUT_CORPS_MS = 30_000;

/** Timeout par requête par défaut (AbortSignal). */
const TIMEOUT_REQUETE_DEFAUT_MS = 10_000;

/** Clé du singleton agent sur globalThis (résiste au hot-reload dev). */
const CLE_AGENT = "__gen3iaAgentSortant__";

type GlobalAvecAgent = typeof globalThis & {
  [CLE_AGENT]?: Promise<AgentMinimal | null> | undefined;
};

/**
 * Surface minimale utilisée de l'Agent undici — permet le typage strict sans
 * importer le module au chargement du fichier (import lazy).
 */
interface AgentMinimal {
  dispatcher: unknown;
  close(): Promise<void>;
}

/** Charge (une fois) l'agent keep-alive ; null si undici indisponible. */
function chargerAgent(): Promise<AgentMinimal | null> {
  const global_ = globalThis as GlobalAvecAgent;
  if (!global_[CLE_AGENT]) {
    global_[CLE_AGENT] = import("undici")
      .then((undici) => {
        const agent = new undici.Agent({
          connections: CONNEXIONS_PAR_ORIGINE,
          keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS,
          keepAliveMaxTimeout: KEEP_ALIVE_MAX_TIMEOUT_MS,
          headersTimeout: TIMEOUT_EN_TETES_MS,
          bodyTimeout: TIMEOUT_CORPS_MS,
          // H1/H2 : pipelining 1 (pas de pipelining — les serveurs distants
          // le gèrent mal ; la réutilisation de connexions suffit).
          pipelining: 1,
        });
        return agent as unknown as AgentMinimal;
      })
      .catch(() => {
        // undici absent/inimportable : repli fetch global (sans pool).
        return null;
      });
  }
  return global_[CLE_AGENT];
}

/** Options de `requeteSortante`. */
export interface OptionsRequeteSortante {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Timeout global de la requête en ms (défaut 10 000). */
  timeoutMs?: number;
  /** Signal d'abandon fourni par l'appelant (prioritaire sur timeoutMs). */
  signal?: AbortSignal;
}

/**
 * Requête HTTP sortante via le pool keep-alive (repli fetch global si
 * undici indisponible). Garantit un timeout propre même sans signal appelant.
 *
 * Retourne la Response standard (l'objet undici est spec-compatible —
 * recasté explicite pour le typage strict du dépôt).
 */
export async function requeteSortante(
  url: string,
  options: OptionsRequeteSortante = {},
): Promise<Response> {
  const timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? TIMEOUT_REQUETE_DEFAUT_MS));
  const signal = options.signal ?? AbortSignal.timeout(timeoutMs);
  const init: RequestInit = {
    method: options.method,
    headers: options.headers,
    body: options.body,
    signal,
    // Le cache HTTP du navigateur n'existe pas côté serveur : explicite.
    cache: "no-store",
  };

  const agent = await chargerAgent();
  if (!agent) {
    return fetch(url, init);
  }

  // undici.fetch honore `dispatcher` (le fetch GLOBAL de Node l'ignore dans
  // certaines versions) : on utilise le fetch d'undici avec l'agent. La
  // Response undici est spec-compatible avec la Response globale — recast
  // explicite pour le typage strict du dépôt.
  const { fetch: fetchUndici } = await import("undici");
  type UndiciFetch = (url: string, init?: Record<string, unknown>) => Promise<Response>;
  const appeler = fetchUndici as unknown as UndiciFetch;
  return appeler(url, { ...init, dispatcher: agent });
}

/**
 * Indique si l'agent keep-alive est actif (observabilité /api/perf/metrics
 * et tests). false = repli fetch global (undici indisponible).
 */
export async function agentSortantActif(): Promise<boolean> {
  return (await chargerAgent()) !== null;
}

/**
 * @internal Réservé aux tests/arrêt gracieux : ferme l'agent (libère les
 * sockets keep-alive). Un appel suivant recrée l'agent à la demande.
 */
export async function fermerAgentSortantPourTests(): Promise<void> {
  const global_ = globalThis as GlobalAvecAgent;
  const charge = global_[CLE_AGENT];
  global_[CLE_AGENT] = undefined;
  if (!charge) return;
  const agent = await charge;
  if (agent) {
    try {
      await agent.close();
    } catch {
      // La fermeture ne doit jamais lever vers l'appelant.
    }
  }
}
