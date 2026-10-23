/**
 * REGISTRE DE MÉTRIQUES SLI (format Prometheus) — compteur HTTP in-memory.
 *
 * RÔLE (Task G — SRE) : alimenter l'endpoint /api/metrics en indicateurs de
 * niveau de service (SLI) sans dépendance externe (pas d'OTel, pas de Redis,
 * pas d'exporteur) — adapté au VPS solo 2 Go. Complète les métriques OTel
 * produit (lib/observability/metrics.ts et lib/observability/otel.ts) qui
 * restent les canaux officiels des métriques métier (exécutions, tokens).
 *
 * CARACTÉRISTIQUES :
 *  - 100 % mémoire process, Singleton attaché à globalThis (même contrat que
 *    lib/neural/runtime.ts et lib/ondes/registre-signalisation.ts) : survit
 *    au hot-reload Next.js en dev et reste unique au sein d'un realm ;
 *  - CARDINALITÉ STRICTEMENT BORNÉE : les labels ne portent JAMAIS le chemin
 *    brut (injection de cardinalité interdite) mais une classe parmi
 *    « chat | api | pages | static » × une classe de statut parmi
 *    « 1xx…5xx » — au plus 4 × 5 = 20 séries ;
 *  - latence = moyenne GLISSANTE sur un ring buffer de 500 durées PAR CLASSE
 *    (mémoire constante, fenêtre récente représentative) ;
 *  - module PUR (zéro import, zéro effet de bord à l'import) : importable
 *    depuis le middleware (runtime nodejs) comme depuis une route API sans
 *    tirer de graphe de dépendances ;
 *  - jamais d'exception levée vers l'appelant : la télémétrie ne doit
 *    JAMAIS perturber le trafic.
 *
 * PÉRIMÈTRE DE MESURE (honnêteté des SLI — cf. docs/sre/sli-slo.md) : les
 * observations sont enregistrées par le hook du middleware (middleware.ts),
 * qui mesure le traitement middleware et le statut de SA réponse (200/307/
 * 403). Les 5xx issus d'un route handler en aval ne passent pas par ici :
 * la source de vérité complémentaire reste les logs d'accès nginx
 * (disponibilité, statuts, latence de bout en bout).
 */

/** Classe de route — cardinalité FIXE (jamais le path brut). */
export type ClasseRoute = "chat" | "api" | "pages" | "static";

/** Classe de statut HTTP (familles centaines). */
export type ClasseStatut = "1xx" | "2xx" | "3xx" | "4xx" | "5xx";

/** Taille du ring buffer de durées par classe de route (mémoire constante). */
const TAILLE_ECHANTILLON = 500;

/** Clé du singleton sur globalThis (résiste au hot-reload). */
const CLE_GLOBALE = "__gen3iaMetricsRegistry__";

/** Ordres d'affichage déterministes (sortie Prometheus stable = diffs propres). */
const ORDRE_CLASSES: ReadonlyArray<ClasseRoute> = ["chat", "api", "pages", "static"];
const ORDRE_STATUTS: ReadonlyArray<ClasseStatut> = ["1xx", "2xx", "3xx", "4xx", "5xx"];

/** État interne persistant (attaché à globalThis). */
interface EtatRegistre {
  /** Date de création du registre (≈ démarrage du process, à la 1re mesure). */
  creeLe: number;
  /** Compteurs de requêtes — clé « ${classe}|${statut} » (≤ 20 entrées). */
  compteurs: Map<string, number>;
  /** Ring buffer de durées (ms) par classe de route. */
  durees: Map<ClasseRoute, number[]>;
}

type GlobalAvecRegistre = typeof globalThis & { [CLE_GLOBALE]?: EtatRegistre };

/** Singleton paresseux : créé à la première écriture/lecture, jamais avant. */
function obtenirEtat(): EtatRegistre {
  const global_ = globalThis as GlobalAvecRegistre;
  let etat = global_[CLE_GLOBALE];
  if (!etat) {
    etat = { creeLe: Date.now(), compteurs: new Map(), durees: new Map() };
    global_[CLE_GLOBALE] = etat;
  }
  return etat;
}

/** Famille de statut HTTP (« 404 » → « 4xx ») — bornée à 5 libellés. */
export function classeStatut(statut: number): ClasseStatut {
  const centaine = Math.floor(statut / 100);
  if (centaine >= 1 && centaine <= 5) {
    return `${centaine}xx` as ClasseStatut;
  }
  // Statut hors bornes (0, 6xx…) : rangé en 5xx (l'erreur est bien une erreur).
  return "5xx";
}

/**
 * Classification d'un chemin en classe de route à cardinalité limitée.
 *
 * Ordre d'évaluation : statique (fichiers servis) → chat (surface produit
 * critique, page + API) → api (reste des API) → pages (toutes les pages HTML).
 * Classes inspirées des familles de lib/security/user-access.ts (page /chat
 * = chat ; /dashboard reste « pages » : surface applicative complète, pas
 * uniquement le chat).
 */
export function classerChemin(chemin: string): ClasseRoute {
  // 1) Fichiers statiques servis depuis /public et assets Next.
  if (
    chemin.startsWith("/_next/") ||
    chemin.startsWith("/icons/") ||
    chemin.startsWith("/images/") ||
    chemin.startsWith("/sdk/") ||
    chemin.startsWith("/worklets/") ||
    chemin === "/favicon.ico" ||
    chemin === "/robots.txt" ||
    chemin === "/sitemap.xml" ||
    chemin === "/manifest.webmanifest" ||
    chemin === "/sw.js" ||
    chemin === "/offline.html" ||
    chemin === "/ads.txt" ||
    chemin === "/llms.txt" ||
    chemin === "/llms-full.txt" ||
    chemin === "/version.json"
  ) {
    return "static";
  }
  // 2) Chat IA — surface critique des SLO (page canonique + son API d'agent).
  if (chemin === "/chat" || chemin.startsWith("/chat/") || chemin.startsWith("/api/agent/chat")) {
    return "chat";
  }
  // 3) Toutes les autres API.
  if (chemin.startsWith("/api/")) {
    return "api";
  }
  // 4) Toutes les pages HTML (landing, dashboard, billing, admin…).
  return "pages";
}

/**
 * Enregistre une requête observée (compteur + durée). Sûr par construction :
 * aucune exception ne remonte, les valeurs aberrantes (négatives) sont
 * bornées à 0 pour ne pas corrompre la moyenne.
 */
export function enregistrerRequete(
  classe: ClasseRoute,
  statut: number,
  dureeMs: number,
): void {
  try {
    const etat = obtenirEtat();
    const cleStatut = classeStatut(statut);

    const cle = `${classe}|${cleStatut}`;
    etat.compteurs.set(cle, (etat.compteurs.get(cle) ?? 0) + 1);

    let buffer = etat.durees.get(classe);
    if (!buffer) {
      buffer = [];
      etat.durees.set(classe, buffer);
    }
    buffer.push(Number.isFinite(dureeMs) ? Math.max(0, dureeMs) : 0);
    if (buffer.length > TAILLE_ECHANTILLON) {
      // Ring buffer : éviction du plus ancien (FIFO — taille mémoire constante).
      buffer.shift();
    }
  } catch {
    // Télémétrie silencieuse : un échec de mesure ne casse JAMAIS la requête.
  }
}

/** Ligne de compteur exposée par l'instantané. */
export interface SerieCompteur {
  route: ClasseRoute;
  statut: ClasseStatut;
  total: number;
}

/** Ligne de latence exposée par l'instantané. */
export interface SerieDuree {
  route: ClasseRoute;
  /** Moyenne glissante (ms) sur la fenêtre courante du ring buffer. */
  moyenneMs: number;
  /** Taille de l'échantillon courant (≤ TAILLE_ECHANTILLON). */
  echantillons: number;
}

/** Photographie complète du registre (source de /api/metrics). */
export interface InstantaneMetriques {
  compteurs: SerieCompteur[];
  durees: SerieDuree[];
  /** Secondes écoulées depuis la création du registre (≈ uptime process). */
  uptimeSecondes: number;
  /** Mémoire résidente du process Node (octets). */
  memoireRssOctets: number;
  /** Tas V8 utilisé (octets). */
  memoireTasUtiliseOctets: number;
}

/** Photographie de l'état courant (lecture seule, sans effet de bord). */
export function instantane(): InstantaneMetriques {
  const etat = obtenirEtat();

  const compteurs: SerieCompteur[] = [];
  for (const classe of ORDRE_CLASSES) {
    for (const statut of ORDRE_STATUTS) {
      const total = etat.compteurs.get(`${classe}|${statut}`);
      // Séries jamais observées : omises (sortie compacte ; l'absence de
      // série vaut 0 pour les scrapers Prometheus).
      if (total !== undefined) {
        compteurs.push({ route: classe, statut, total });
      }
    }
  }

  const durees: SerieDuree[] = ORDRE_CLASSES.flatMap((classe) => {
    const buffer = etat.durees.get(classe);
    if (!buffer || buffer.length === 0) return [];
    const somme = buffer.reduce((acc, valeur) => acc + valeur, 0);
    return [
      {
        route: classe,
        moyenneMs: Math.round((somme / buffer.length) * 100) / 100,
        echantillons: buffer.length,
      },
    ];
  });

  let memoire = { rss: 0, heapUsed: 0 };
  try {
    const usage = process.memoryUsage();
    memoire = { rss: usage.rss, heapUsed: usage.heapUsed };
  } catch {
    // Environnement sans process.memoryUsage (théorique) : zéros honnêtes.
  }

  return {
    compteurs,
    durees,
    uptimeSecondes: Math.max(0, Math.round(((Date.now() - etat.creeLe) / 1000) * 1000) / 1000),
    memoireRssOctets: memoire.rss,
    memoireTasUtiliseOctets: memoire.heapUsed,
  };
}

/**
 * Sérialisation au format TEXTE Prometheus (exposition 0.0.4) — sortie
 * déterministe (ordre fixe des classes et statuts) pour des diffs et des
 * tests stables.
 */
export function formaterPrometheus(): string {
  const photo = instantane();
  const lignes: string[] = [];

  lignes.push(
    "# HELP gen3ia_http_requests_total Total des requêtes HTTP par classe de route et classe de statut (cardinalité bornée — jamais le chemin brut).",
  );
  lignes.push("# TYPE gen3ia_http_requests_total counter");
  for (const serie of photo.compteurs) {
    lignes.push(`gen3ia_http_requests_total{route="${serie.route}",status="${serie.statut}"} ${serie.total}`);
  }

  lignes.push(
    "# HELP gen3ia_http_request_duration_ms Latence moyenne GLISSANTE (ms) par classe de route — fenêtre des 500 dernières requêtes.",
  );
  lignes.push("# TYPE gen3ia_http_request_duration_ms gauge");
  for (const serie of photo.durees) {
    lignes.push(`gen3ia_http_request_duration_ms{route="${serie.route}"} ${serie.moyenneMs}`);
  }

  lignes.push(
    "# HELP gen3ia_http_request_duration_samples Taille de l'échantillon de latence courant (≤ 500) par classe de route.",
  );
  lignes.push("# TYPE gen3ia_http_request_duration_samples gauge");
  for (const serie of photo.durees) {
    lignes.push(`gen3ia_http_request_duration_samples{route="${serie.route}"} ${serie.echantillons}`);
  }

  lignes.push(
    "# HELP gen3ia_uptime_seconds Secondes écoulées depuis la première mesure du registre (≈ uptime du process).",
  );
  lignes.push("# TYPE gen3ia_uptime_seconds gauge");
  lignes.push(`gen3ia_uptime_seconds ${photo.uptimeSecondes}`);

  lignes.push("# HELP gen3ia_memory_rss_bytes Mémoire résidente (RSS) du process Node en octets.");
  lignes.push("# TYPE gen3ia_memory_rss_bytes gauge");
  lignes.push(`gen3ia_memory_rss_bytes ${photo.memoireRssOctets}`);

  lignes.push("# HELP gen3ia_memory_heap_used_bytes Tas V8 utilisé en octets.");
  lignes.push("# TYPE gen3ia_memory_heap_used_bytes gauge");
  lignes.push(`gen3ia_memory_heap_used_bytes ${photo.memoireTasUtiliseOctets}`);

  return `${lignes.join("\n")}\n`;
}
