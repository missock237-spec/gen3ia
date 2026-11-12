/**
 * GÉNÉRATEUR DÉVELOPPEMENT WEB + DNS it.150 — entraînement mémoire du
 * domaine (demande propriétaire : « gen3 manque d'entraînement mémoire en
 * développement web — l'entraîner sur le dev web ET le DNS »).
 *
 * HONNÊTETÉ SUR L'ÉCHELLE : 5 milliards de datasets / 50 millions d'exemples
 * sont IMPOSSIBLES dans ce dépôt. Ce module produit un corpus SUBSTANTIEL
 * RÉEL : des tables de faits vérifiables (codes de statut RFC 9110, headers,
 * éléments HTML, rôles ARIA, propriétés flex/grid, hooks React, conventions
 * App Router, seuils Core Web Vitals, types d'enregistrements DNS, DNSSEC,
 * SPF/DKIM/DMARC…) instanciées en unités { question → réponse précise } par
 * des gabarits paramétrés — MÊME MÉCANIQUE QUE les graines de
 * memoire-domaines-graines.ts et le générateur raisonnement-it94 :
 *   - AUCUNE donnée inventée : chaque table énonce des faits vérifiables ;
 *   - les réponses ARITHMÉTIQUES (fraîcheur cache, TTL, priorités MX, semver,
 *     contraste WCAG, verdicts Core Web Vitals, chemins de résolution) sont
 *     CALCULÉES par construction ;
 *   - déterminisme total : même index → même unité, partout, toujours ;
 *   - unicité des motifs (Set + déduplication documentée).
 *
 * Module PUR — aucune dépendance Node.
 */

export type SousThemeDevWeb =
  | "html-css"
  | "js-ts"
  | "react-next"
  | "http-securite"
  | "perf-a11y"
  | "dns";

export interface UniteDevWeb {
  readonly motif: string;
  readonly reponse: string;
  /** Thème conversationnel : « developpement-web:<sous-thème> ». */
  readonly theme: string;
  readonly sousTheme: SousThemeDevWeb;
  /** Famille de faits ayant produit l'unité (traçabilité). */
  readonly famille: string;
}

/** Ligne de fait : tableau de chaînes positionnel (défini par chaque famille). */
type Ligne = readonly string[];

interface FamilleDevWeb {
  readonly id: string;
  readonly sousTheme: SousThemeDevWeb;
  /** Gabarits : (ligne) → [motif, réponse]. Plusieurs formulations réelles
   * d'un même besoin — règle du corpus maison (cf. corpus.ts). */
  readonly gabarits: readonly ((l: Ligne) => readonly [string, string])[];
  readonly lignes: readonly Ligne[];
}

// ─── AIDES CALCULÉES (arithmétique réelle, zéro invention) ───────────────────

/** Famille d'un code de statut HTTP — CALCULÉE depuis les plages RFC 9110. */
export function familleStatutHttp(code: number): string {
  if (code >= 100 && code < 200) return "réponses informationnelles (1xx)";
  if (code >= 200 && code < 300) return "réponses de réussite (2xx)";
  if (code >= 300 && code < 400) return "réponses de redirection (3xx)";
  if (code >= 400 && code < 500) return "erreurs côté client (4xx)";
  if (code >= 500 && code < 600) return "erreurs côté serveur (5xx)";
  return "code hors plage HTTP";
}

function heureApres(hhmm: string, minutes: number): string {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  const total = h * 60 + m + minutes;
  const h2 = Math.floor(total / 60) % 24;
  const m2 = total % 60;
  return `${String(h2).padStart(2, "0")}:${String(m2).padStart(2, "0")}`;
}

function dureeHumaine(secondes: number): string {
  if (secondes < 60) return `${secondes} seconde${secondes > 1 ? "s" : ""}`;
  const m = Math.round(secondes / 60);
  if (m < 60) return m === 1 ? "1 minute" : `${m} minutes`;
  const h = m / 60;
  if (h < 24)
    return h === 1 ? "1 heure" : Number.isInteger(h) ? `${h} heures` : `${h.toFixed(1)} heures`;
  const j = h / 24;
  return j === 1 ? "1 jour" : Number.isInteger(j) ? `${j} jours` : `${j.toFixed(1)} jours`;
}

/** Luminance relative sRGB (WCAG 2.x) — formule officielle, calcul exact. */
function luminanceRelative(hex: string): number {
  const n = hex.replace("#", "");
  const r = parseInt(n.slice(0, 2), 16) / 255;
  const g = parseInt(n.slice(2, 4), 16) / 255;
  const b = parseInt(n.slice(4, 6), 16) / 255;
  const canal = (c: number): number =>
    c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  return 0.2126 * canal(r) + 0.7152 * canal(g) + 0.0722 * canal(b);
}

/** Ratio de contraste WCAG (formule officielle : (L1+0.05)/(L2+0.05)). */
export function ratioContraste(hex1: string, hex2: string): number {
  const l1 = luminanceRelative(hex1);
  const l2 = luminanceRelative(hex2);
  const haut = Math.max(l1, l2);
  const bas = Math.min(l1, l2);
  return (haut + 0.05) / (bas + 0.05);
}

/** Verdict WCAG d'un couple de couleurs (texte normal 4.5:1, gros texte 3:1). */
export function verdictContraste(hex1: string, hex2: string): {
  ratio: number;
  verdict: string;
} {
  const ratio = ratioContraste(hex1, hex2);
  const r = Math.round(ratio * 100) / 100;
  const verdict =
    ratio >= 7
      ? `AA et AAA (ratio ${r}:1 ≥ 7:1)`
      : ratio >= 4.5
        ? `AA pour texte normal (ratio ${r}:1 ≥ 4.5:1), pas AAA`
        : ratio >= 3
          ? `AA pour GROS texte uniquement (ratio ${r}:1 ≥ 3:1 mais < 4.5:1)`
          : `échec AA (ratio ${r}:1 < 3:1)`;
  return { ratio: r, verdict };
}

function plagesSemver(v: string, op: "^" | "~" | "x"): string {
  const [maj, min, cor] = v.split(".").map(Number) as [number, number, number];
  if (op === "^") {
    if (maj > 0) return `≥ ${maj}.${min}.${cor} et < ${maj + 1}.0.0`;
    if (min > 0) return `≥ 0.${min}.${cor} et < 0.${min + 1}.0`;
    return `≥ 0.0.${cor} et < 0.0.${cor + 1}`;
  }
  if (op === "~") return `≥ ${maj}.${min}.${cor} et < ${maj}.${min + 1}.0`;
  return `toute 1.x : ≥ 1.0.0 et < 2.0.0`;
}

// ─── TABLES DE FAITS (vérifiables — sources : RFC 9110/1035/4034/7208/7484,
//     MDN, WCAG 2.2, web.dev) ─────────────────────────────────────────────────

const STATUTS: readonly Ligne[] = [
  ["200", "OK", "requête réussie — le corps porte la représentation demandée"],
  ["201", "Created", "ressource créée — l'en-tête Location désigne la nouvelle URL"],
  ["202", "Accepted", "requête acceptée mais traitement pas encore terminé (file d'attente)"],
  ["204", "No Content", "succès sans corps de réponse (ex. suppression, PUT sans retour)"],
  ["206", "Partial Content", "réponse partielle suite à un Range (reprise de téléchargement, vidéo)"],
  ["301", "Moved Permanently", "redirection permanente — les moteurs transfèrent le rang vers la cible"],
  ["302", "Found", "redirection temporaire — la méthode n'est en principe pas modifiée"],
  ["303", "See Other", "aller chercher la cible avec GET (ex. après un POST de formulaire)"],
  ["304", "Not Modified", "validation de cache réussie (If-None-Match/If-Modified-Since) — pas de corps"],
  ["307", "Temporary Redirect", "redirection temporaire qui PRÉSERVE la méthode et le corps"],
  ["308", "Permanent Redirect", "redirection permanente qui PRÉSERVE la méthode et le corps"],
  ["400", "Bad Request", "syntaxe de la requête malformée — le serveur ne peut pas la comprendre"],
  ["401", "Unauthorized", "authentification requise ou invalide — renvoyer WWW-Authenticate"],
  ["403", "Forbidden", "le serveur a compris mais refuse — l'authentification ne changera rien"],
  ["404", "Not Found", "ressource introuvable — l'URL ne correspond à rien (permanent ou non)"],
  ["405", "Method Not Allowed", "méthode non supportée par la ressource — renvoyer Allow"],
  ["406", "Not Acceptable", "aucune représentation compatible avec les en-têtes Accept-*"],
  ["408", "Request Timeout", "le client a mis trop de temps à envoyer la requête"],
  ["409", "Conflict", "la requête entre en conflit avec l'état courant (ex. version concurrente)"],
  ["410", "Gone", "ressource définitivement supprimée — plus de redirection possible"],
  ["412", "Precondition Failed", "une condition If-* n'est pas remplie (If-Match sur une version obsolète)"],
  ["413", "Content Too Large", "corps de requête trop volumineux pour le serveur"],
  ["415", "Unsupported Media Type", "format du corps non supporté (ex. Content-Type refusé)"],
  ["416", "Range Not Satisfiable", "plage demandée hors bornes de la ressource"],
  ["418", "I'm a teapot", "blague du 1er avril 1998 (RFC 2324) — jamais utilisé en série"],
  ["422", "Unprocessable Content", "syntaxe correcte mais sémantiquement invalide (ex. validation de formulaire)"],
  ["425", "Too Early", "requête trop tôt — risque de rejeu non mitigé (early data TLS 1.3)"],
  ["426", "Upgrade Required", "le client doit changer de protocole (ex. passer en TLS)"],
  ["428", "Precondition Required", "le serveur EXIGE une condition If-Match pour éviter les pertes de mise à jour"],
  ["429", "Too Many Requests", "limite de débit atteinte — Retry-After indique quand réessayer"],
  ["431", "Request Header Fields Too Large", "en-têtes trop gros (cookies souvent)"],
  ["451", "Unavailable For Legal Reasons", "ressource bloquée pour raison légale (censure)"],
  ["500", "Internal Server Error", "erreur générique côté serveur — bug non géré"],
  ["501", "Not Implemented", "le serveur ne sait pas traiter la méthode"],
  ["502", "Bad Gateway", "le proxy/la passerelle a reçu une réponse invalide de l'upstream"],
  ["503", "Service Unavailable", "service indisponible (surcharge, maintenance) — souvent Retry-After"],
  ["504", "Gateway Timeout", "la passerelle n'a pas obtenu de réponse de l'upstream à temps"],
  ["505", "HTTP Version Not Supported", "version HTTP de la requête non supportée"],
  ["507", "Insufficient Storage", "stockage insuffisant pour mener la requête (WebDAV)"],
  ["511", "Network Authentication Required", "authentification réseau nécessaire (portail captif Wi-Fi)"],
];

const METHODES_HTTP: readonly Ligne[] = [
  ["GET", "sûre", "idempotente", "cacheable", "récupérer une représentation de la ressource"],
  ["HEAD", "sûre", "idempotente", "cacheable", "récupérer les en-têtes de GET sans le corps"],
  ["POST", "non sûre", "non idempotente", "non cacheable par défaut", "créer une ressource ou déclencher un traitement"],
  ["PUT", "non sûre", "idempotente", "non cacheable", "remplacer complètement l'état de la ressource cible"],
  ["PATCH", "non sûre", "non idempotente en général", "non cacheable", "modifier partiellement la ressource"],
  ["DELETE", "non sûre", "idempotente", "non cacheable", "supprimer la ressource (l'état final est stable)"],
  ["OPTIONS", "sûre", "idempotente", "non cacheable", "décrire les options de communication — c'est elle que le preflight CORS envoie"],
  ["TRACE", "sûre", "idempotente", "non cacheable", "boucler la requête pour le diagnostic (souvent désactivé)"],
  ["CONNECT", "non sûre", "non idempotente", "non cacheable", "établir un tunnel (HTTPS via un proxy)"],
];

const ENTETES_HTTP: readonly Ligne[] = [
  ["Host", "désigne le serveur visé — obligatoire en HTTP/1.1, base de l'hébergement mutualisé"],
  ["Content-Type", "type de média du corps (application/json, text/html…) — côté requête ET réponse"],
  ["Content-Length", "taille du corps en octets"],
  ["Accept", "formats que le client accepte — négociation de contenu"],
  ["Accept-Language", "langues préférées du client — négociation de langue"],
  ["Authorization", "identifiants du client (Basic, Bearer…)"],
  ["Cache-Control", "politique de mise en cache (max-age, no-store, no-cache, must-revalidate)"],
  ["ETag", "identifiant opaque de la version de la ressource — fondement des revalidations"],
  ["If-None-Match", "revalidation par le client : « ceci correspond à mon ETag en cache » → 304 si inchangé"],
  ["If-Modified-Since", "revalidation par date (complément d'If-None-Match)"],
  ["Last-Modified", "date de dernière modification de la ressource"],
  ["Location", "URL de la ressource créée (201) ou cible d'une redirection (3xx)"],
  ["Set-Cookie", "pose un cookie côté client (attributs HttpOnly, Secure, SameSite…)"],
  ["Cookie", "cookies renvoyés par le client au serveur"],
  ["Origin", "origine (schéma+host+port) de la requête — pilier du CORS"],
  ["Access-Control-Allow-Origin", "réponse CORS : quelles origines peuvent lire la ressource"],
  ["Access-Control-Allow-Methods", "réponse CORS au preflight : méthodes autorisées"],
  ["Access-Control-Allow-Headers", "réponse CORS au preflight : en-têtes personnalisés autorisés"],
  ["Access-Control-Max-Age", "durée de mise en cache de la réponse de preflight"],
  ["X-Content-Type-Options", "nosniff — interdit le reniflement de type MIME"],
  ["Strict-Transport-Security", "HSTS — force HTTPS pour les visites futures"],
  ["Content-Security-Policy", "politique de sécurité du contenu (sources autorisées par type de ressource)"],
  ["Referer", "URL de la page d'origine du clic (orthographe historique à une seule R)"],
  ["Retry-After", "durée ou date avant de réessayer (après 429, 503…)"],
  ["Vary", "clés de variation du cache (ex. Vary: Origin, Accept-Encoding)"],
  ["User-Agent", "identité du logiciel client (à manipuler avec prudence)"],
  ["WWW-Authenticate", "défis d'authentification du serveur (avec 401)"],
  ["X-Frame-Options", "anti-clickjacking (DENY / SAMEORIGIN) — remplacé par CSP frame-ancestors"],
];

const MAX_AGES: readonly number[] = [
  60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 43200, 86400, 604800,
];

const HEURES: readonly string[] = [
  "00:10", "01:30", "03:45", "05:00", "07:20", "09:15", "11:05", "12:40",
  "14:00", "15:50", "17:25", "19:10", "20:30", "21:45", "23:05", "22:55",
  "06:05", "08:35", "10:45", "13:20", "16:15", "18:40", "02:15", "04:55",
];

const ETAGS: readonly Ligne[] = [
  ["\"a1b2c3\"", "inchangé", "304"],
  ["\"v7\"", "inchangé", "304"],
  ["\"x9f\"", "changé", "200"],
  ["\"c0ffee\"", "changé", "200"],
  ["W/\"meta-12\"", "inchangé", "304"],
  ["W/\"meta-13\"", "changé", "200"],
  ["\"5f2-1a\"", "inchangé", "304"],
  ["\"doc-2026\"", "changé", "200"],
  ["\"sha-88ab\"", "inchangé", "304"],
  ["\"sha-99cd\"", "changé", "200"],
  ["\"img-v3\"", "inchangé", "304"],
  ["\"json-77\"", "changé", "200"],
];

const COOKIES_ATTRS: readonly Ligne[] = [
  ["HttpOnly", "le cookie est invisible pour JavaScript (document.cookie) — blinde contre le vol par XSS"],
  ["Secure", "le cookie ne circule que sur HTTPS"],
  ["SameSite=Strict", "jamais envoyé sur une navigation croisée — protection CSRF maximale"],
  ["SameSite=Lax", "envoyé sur les navigations top-level sûres (GET) — défaut des navigateurs modernes"],
  ["SameSite=None", "envoyé sur les requêtes cross-site — EXIGE Secure (tiers, iframes)"],
  ["Max-Age", "durée de vie en secondes — prioritaire sur Expires"],
  ["Expires", "date d'expiration absolue (format HTTP)"],
  ["Path", "chemin d'URL où le cookie est envoyé"],
  ["Domain", "domaine(s) auquel le cookie est rattaché"],
  ["Partitioned", "cookie CHIPS partitionné par site de premier niveau — limite le suivi tiers"],
];

const CAS_CORS: readonly Ligne[] = [
  ["même origine (schéma, hôte, port identiques)", "CORS ne s'applique pas — pas d'en-tête Origin significatif, pas de preflight"],
  ["GET cross-origin simple (aucun en-tête personnalisé)", "requête « simple » envoyée directement ; le navigateur ne rend la réponse LISIBLE que si Access-Control-Allow-Origin couvre l'origine"],
  ["POST avec Content-Type: application/json", "pas une requête simple → le navigateur envoie d'abord un PREFLIGHT OPTIONS"],
  ["en-tête personnalisé X-Auth-Token", "préflight obligatoire ; le serveur doit le lister dans Access-Control-Allow-Headers"],
  ["méthode DELETE cross-origin", "méthode hors liste simple → preflight OPTIONS puis Access-Control-Allow-Methods"],
  ["requête avec credentials (cookies)", "Access-Control-Allow-Origin doit être l'origine EXACTE (* interdit) et Access-Control-Allow-Credentials: true"],
  ["réponse de preflight", "OPTIONS 204 avec Access-Control-Allow-Methods, Allow-Headers et Access-Control-Max-Age"],
  ["serveur sans en-têtes CORS", "la requête peut PARTIR, mais le navigateur bloque la lecture de la réponse côté JavaScript"],
  ["cache du preflight", "Access-Control-Max-Age évite de rejouer le OPTIONS à chaque requête"],
  ["origines multiples", "une seule origine par en-tête — le serveur renvoie l'origine du demandeur et Vary: Origin"],
  ["erreur côté preflight", "si le OPTIONS échoue, la vraie requête n'est JAMAIS envoyée"],
  ["JSONP / proxy serveur", "contournements historiques — le proxy serveur n'est pas soumis au CORS du navigateur"],
];

const AUTH_SCHEMES: readonly Ligne[] = [
  ["Basic", "user:password en base64 — chiffré seulement si HTTPS, à réserver aux tests"],
  ["Bearer", "jeton porteur (JWT, OAuth2) dans Authorization: Bearer <token> — la norme des API"],
  ["Session cookie", "identifiant de session opaque dans un cookie HttpOnly — révocable côté serveur"],
  ["API key", "clé statique (souvent X-API-Key) — simple mais non renouvelable, périmètre large"],
  ["Digest", "défi-réponse avec hachage — évite d'envoyer le mot de passe en clair"],
  ["OAuth 2.0", "délégation d'autorisation : code d'autorisation + PKCE pour les applications publiques"],
  ["OpenID Connect", "couche d'identité par-dessus OAuth 2.0 (ID Token JWT signé)"],
  ["mTLS", "certificat client côté TLS — authentification mutuelle forte, souvent machine à machine"],
];

const CSP_DIRECTIVES: readonly Ligne[] = [
  ["default-src", "source par défaut des autres directives — la politique de repli"],
  ["script-src", "sources autorisées pour les scripts — la directive anti-XSS centrale"],
  ["style-src", "sources des feuilles de style"],
  ["img-src", "sources des images"],
  ["connect-src", "cibles des requêtes réseau (fetch, XHR, WebSocket)"],
  ["font-src", "sources des polices"],
  ["frame-src", "sources des frames/iframes"],
  ["frame-ancestors", "QUI peut encadrer cette page — remplace X-Frame-Options"],
  ["object-src", "sources des <object>/<embed> — à bloquer ('none') par défaut"],
  ["base-uri", "URL autorisées pour <base href> — bloque le détournement de liens relatifs"],
  ["form-action", "cibles autorisées pour les soumissions de formulaire"],
  ["media-src", "sources audio/vidéo"],
  ["worker-src", "sources des Web Workers"],
  ["manifest-src", "source du manifeste d'application"],
  ["upgrade-insecure-requests", "réécrit les URLs http:// en https://"],
  ["nonce-…", "nonce à usage unique pour autoriser UN script inline précis"],
  ["hash-…", "empreinte sha256 d'un contenu inline autorisé"],
  ["report-to", "canal de signalement des violations de CSP"],
];

const CONTEXTES_XSS: readonly Ligne[] = [
  ["corps HTML", "échapper &, <, > — jamais injecter du HTML construit avec des données"],
  ["attribut HTML", "échapper aussi les guillemets (' et \") et toujours mettre l'attribut entre guillemets"],
  ["URL (href/src)", "valider le schéma : bloquer javascript:, data: (sauf images sûres), autoriser http(s) et relatif"],
  ["innerHTML", "remplacer par textContent dès que possible ; si HTML obligatoire, assainir (DOMPurify)"],
  ["document.write", "à bannir — injecte directement dans le flux HTML"],
  ["script inline + JSON", "échapper </script> et les séquences sensibles, ou servir le JSON via fetch"],
  ["eval / new Function", "à bannir — exécute n'importe quelle chaîne en code"],
  ["localStorage comme stockage d'HTML", "attention : rejouer du HTML stocké réinjecte le payload (XSS stocké)"],
  ["postMessage", "toujours vérifier event.origin côté récepteur"],
  ["CSP en défense en profondeur", "script-src avec nonce/hash bloque l'exécution même si l'échappement a échoué"],
];

const HEADERS_SECURITE: readonly Ligne[] = [
  ["Content-Security-Policy", "liste blanche de sources par type de ressource — le meilleur garde anti-XSS"],
  ["X-Content-Type-Options: nosniff", "interdit au navigateur de deviner le type MIME — bloque les injections via reniflement"],
  ["X-Frame-Options: DENY", "interdit tout encadrement (anti-clickjacking, legacy)"],
  ["X-Frame-Options: SAMEORIGIN", "encadrement réservé à la même origine"],
  ["Strict-Transport-Security", "HSTS : max-age + includeSubDomains (+ preload) — tout futur accès passe en HTTPS"],
  ["Referrer-Policy", "contrôle ce qui fuit via Referer (strict-origin-when-cross-origin recommandé)"],
  ["Permissions-Policy", "désactive les API puissantes (caméra, géoloc…) pour les tiers"],
  ["Cross-Origin-Opener-Policy", "isole le contexte de navigation (protège contre les attaques XS-Leaks)"],
  ["Cross-Origin-Embedder-Policy", "exige que les ressources embarquées soient CORS-activées"],
  ["Cross-Origin-Resource-Policy", "refuse que d'autres sites embarquent cette ressource"],
  ["Set-Cookie: Secure + HttpOnly + SameSite", "triptyque minimal d'un cookie de session robuste"],
  ["Cache-Control: no-store", "sur les données sensibles — rien ne doit rester dans les caches"],
];

const INJECTION: readonly Ligne[] = [
  ["requêtes paramétrées", "la défense n°1 contre l'injection SQL — la requête et les données voyagent séparément"],
  ["échappement seul", "insuffisant : il dépend du contexte et casse avec certains jeux de caractères"],
  ["ORM", "protège par défaut (requêtes paramétrées en dessous) — attention au SQL brut échappé à la main"],
  ["concaténation de chaînes SQL", "LA mauvaise pratique : la donnée devient du code"],
  ["privilège minimal", "un compte applicatif ne doit pas pouvoir DROP — limite la portée d'une injection"],
  ["injection de commande", "préférer execFile sans shell aux chaînes passées à un shell"],
  ["injection NoSQL", "valider les types (string attendu) — un objet { $gt: … } passe là où on attend un mot de passe"],
  ["validation d'entrée", "liste blanche des formats attendus — complète mais ne REMPLACE pas les paramètres"],
];

const ELEMENTS_HTML: readonly Ligne[] = [
  ["<header>", "en-tête de section/page (logo, titre)", "zone de titre du site"],
  ["<nav>", "bloc de liens de navigation principaux", "menu du site"],
  ["<main>", "contenu principal unique de la page — un seul par page", "le contenu central"],
  ["<article>", "contenu autonome et distribuable seul (post, carte produit)", "un billet de blog"],
  ["<section>", "regroupement thématique avec en-tête", "chapitre d'une page"],
  ["<aside>", "contenu tangentiel au contenu principal", "barre latérale"],
  ["<footer>", "pied de page/section (mentions, copyright)", "pied du site"],
  ["<h1>…<h6>", "hiérarchie de titres — un seul h1, ordre sans saut", "titres de niveaux"],
  ["<figure>/<figcaption>", "illustration avec légende liée", "image + légende"],
  ["<time datetime>", "date/heure lisible par machine", "date de publication"],
  ["<details>/<summary>", "bloc repliable natif sans JavaScript", "FAQ repliable"],
  ["<dialog>", "boîte de dialogue native avec focus géré", "modale"],
  ["<abbr>", "abréviation avec title explicite", "sigle expliqué"],
  ["<mark>", "surlignage pertinent au contexte courant", "terme trouvé"],
  ["<strong>/<em>", "importance / emphase (sémantique)", "insister sur un mot"],
  ["<b>/<i>", "attraits visuels sans sémantique — à réserver aux conventions éditoriales", "mettre en gras/italique SANS signification"],
  ["<table>/<caption>/<th>", "données tabulaires — caption nomme le tableau, th relie cellule/en-tête", "un tableau de données"],
  ["<button>", "action déclenchée par le code — sémantique de bouton native", "un bouton d'action"],
  ["<a href>", "navigation vers une autre URL — le seul élément qui navigue sans JS", "un lien de navigation"],
  ["<label>", "étiquette associée à un champ (for/id) — obligatoire pour l'accessibilité", "étiqueter un champ de formulaire"],
  ["<fieldset>/<legend>", "groupement de champs avec titre", "groupe de boutons radio"],
  ["<img alt>", "alternative textuelle décrivant la fonction de l'image", "une image avec son texte de remplacement"],
  ["<picture>/<source>", "art direction / formats multiples (AVIF, WebP) avec repli", "servir plusieurs formats d'image"],
  ["<video>/<audio>/<track>", "média natif — track fournit les sous-titres", "une vidéo sous-titrée"],
  ["<datalist>", "liste de suggestions pour un input", "des suggestions de saisie"],
  ["<output>", "résultat d'un calcul/formulaire", "afficher le résultat d'un calcul"],
  ["<progress>/<meter>", "progression / mesure scalaire", "une barre de progression"],
  ["<del>/<ins>", "suppression / insertion éditoriale", "marquer une révision de texte"],
  ["<address>", "coordonnées de contact de l'auteur", "des coordonnées"],
  ["<search>", "région de recherche (nouveau sémantique)", "une zone de recherche"],
];

const ROLES_ARIA: readonly Ligne[] = [
  ["button", "déclenche une action — appui Entrée/Espace natif si <button> réel"],
  ["link", "navigue vers une destination — activé par Entrée"],
  ["navigation", "repertoire de navigation (équivalent <nav>)"],
  ["main", "contenu principal (équivalent <main>)"],
  ["banner", "en-tête global (équivalent <header> au niveau page)"],
  ["contentinfo", "pied global (équivalent <footer> au niveau page)"],
  ["complementary", "contenu complémentaire (équivalent <aside>)"],
  ["search", "région de recherche"],
  ["form", "région de formulaire (quand il n'a pas de nom accessible, sinon form générique)"],
  ["region", "zone nommée par aria-label — point d'ancrage de navigation"],
  ["alert", "message important annoncé immédiatement (role assertif)"],
  ["status", "message d'état annoncé poliment (aria-live=polite implicite)"],
  ["dialog", "boîte de dialogue — à coupler au piège de focus"],
  ["alertdialog", "dialogue qui interrompt et exige une réponse"],
  ["tablist/tab/tabpanel", "onglets : conteneur, onglet, panneau — gérer flèches + aria-selected"],
  ["menu/menubar/menuitem", "menus d'application (pas des menus de site !)"],
  ["list/listitem", "liste et ses éléments (équivalent ul/li)"],
  ["table/grid/gridcell", "données tabulaires / grille interactive"],
  ["checkbox", "case à cocher — aria-checked"],
  ["radio", "bouton radio — aria-checked + groupement"],
  ["switch", "interrupteur binaire"],
  ["slider", "valeur dans une plage — aria-valuenow/min/max"],
  ["progressbar", "progression — aria-valuenow"],
  ["tooltip", "info-bulle — à lier par aria-describedby"],
  ["heading", "repère de titre (pour div à transformer en titre)"],
  ["img", "image pour les div role=img avec aria-label"],
];

const ATTRS_ARIA: readonly Ligne[] = [
  ["aria-label", "nom accessible direct sur l'élément"],
  ["aria-labelledby", "pointe vers le(s) id(s) qui nomment l'élément — prioritaire sur aria-label"],
  ["aria-describedby", "pointe vers une description complémentaire"],
  ["aria-hidden", "retire l'élément de l'arbre d'accessibilité — JAMAIS sur un élément focusable"],
  ["aria-expanded", "état déplié/replié d'un contrôle (accordéon, menu)"],
  ["aria-controls", "pointe vers le contenu contrôlé par le bouton"],
  ["aria-live", "région dynamique : polite (attend la pause) / assertive (interrompt)"],
  ["aria-current", "élément courant d'un ensemble (page, étape, date…)"],
  ["aria-selected", "sélection dans tablist/grid/option"],
  ["aria-checked", "état coché de checkbox/radio/switch"],
  ["aria-disabled", "état désactivé mais focusable (préférer au disabled pour expliquer)"],
  ["aria-atomic", "annonce toute la région ou seulement les changements"],
  ["aria-required", "champ requis (complète le required natif)"],
  ["aria-invalid", "le champ est en erreur — à coupler à un message visible"],
];

const FLEX_PROPS: readonly Ligne[] = [
  ["display: flex", "active le contexte flex : les enfants deviennent des éléments flex"],
  ["flex-direction: row", "axe principal horizontal (défaut)"],
  ["flex-direction: column", "axe principal vertical"],
  ["flex-wrap: wrap", "autorise le passage à la ligne de la ligne flex"],
  ["justify-content: flex-start", "empile au début de l'axe principal (défaut)"],
  ["justify-content: center", "centre le long de l'axe principal"],
  ["justify-content: space-between", "répartit : premier au début, dernier à la fin, espaces égaux entre"],
  ["justify-content: space-around", "espaces égaux AUTOUR de chaque élément (demi-espace aux extrémités)"],
  ["justify-content: space-evenly", "espaces strictement identiques partout (extrémités incluses)"],
  ["align-items: stretch", "étire les enfants sur l'axe secondaire (défaut)"],
  ["align-items: center", "centre sur l'axe secondaire"],
  ["align-items: flex-start", "aligne au début de l'axe secondaire"],
  ["align-items: baseline", "aligne les lignes de base du texte"],
  ["align-self", "surcharge align-items pour UN enfant"],
  ["align-content", "répartit les LIGNES flex quand il y a enveloppement (flex-wrap: wrap)"],
  ["flex-grow", "proportion d'espace libre absorbé (0 = n'absorbe rien)"],
  ["flex-shrink", "proportion de rétrécissement en manque de place"],
  ["flex-basis", "taille de départ avant répartition (auto = selon le contenu)"],
  ["flex: 1", "raccourci pour flex-grow: 1, flex-shrink: 1, flex-basis: 0%"],
  ["gap", "espacement régulier entre éléments flex (sans marges)"],
  ["order", "réordonne visuellement les enfants (pas l'ordre d'accessibilité !)"],
  ["margin: auto", "absorbe l'espace libre sur un enfant — centrage ou poussée locale"],
];

const GRID_PROPS: readonly Ligne[] = [
  ["display: grid", "active le contexte de grille bidimensionnel"],
  ["grid-template-columns: 1fr 2fr", "colonnes proportionnelles (2:1)"],
  ["grid-template-columns: repeat(3, 1fr)", "trois colonnes égales"],
  ["grid-template-columns: repeat(auto-fit, minmax(200px, 1fr))", "colonnes responsives sans media query : place autant de colonnes ≥ 200px que possible"],
  ["grid-template-columns: repeat(auto-fill, minmax(200px, 1fr))", "comme auto-fit mais crée les pistes vides (alignements stables)"],
  ["grid-template-rows", "définit les pistes de lignes explicites"],
  ["grid-column: 1 / 3", "place l'élément de la ligne 1 à la ligne 3 (s'étend sur 2 colonnes)"],
  ["grid-column: span 2", "s'étend sur 2 pistes"],
  ["grid-row", "placement vertical par lignes"],
  ["grid-area", "nomme ou place une zone (après grid-template-areas)"],
  ["grid-template-areas", "maquettage visuel par noms (« sidebar main »)"],
  ["gap", "espacement entre pistes (row-gap / column-gap)"],
  ["justify-items", "aligne chaque élément DANS sa cellule (axe horizontal)"],
  ["align-items", "aligne chaque élément DANS sa cellule (axe vertical)"],
  ["justify-content", "répartit les pistes dans le conteneur (axe horizontal)"],
  ["align-content", "répartit les pistes dans le conteneur (axe vertical)"],
  ["grid-auto-rows", "taille des lignes créées implicitement"],
  ["grid-auto-flow: dense", "remplit les trous laissés par les placements explicites"],
  ["place-items", "raccourci align-items + justify-items"],
  ["minmax(min, max)", "piste bornée — pilier des grilles responsives"],
];

const MEDIA_FACTS: readonly Ligne[] = [
  ["min-width", "mobile-first : styles actifs à partir de la largeur donnée"],
  ["max-width", "desktop-first : styles actifs jusqu'à la largeur donnée"],
  ["prefers-reduced-motion", "l'utilisateur demande moins d'animations — à respecter (WCAG 2.3.3)"],
  ["prefers-color-scheme", "thème clair/sombre du système"],
  ["orientation: portrait", "selon l'orientation de l'écran"],
  ["print", "feuille d'impression"],
  ["hover: none", "appareil sans pointeur fin (tactile)"],
  ["clamp(1rem, 2vw + 0.5rem, 1.5rem)", "taille fluide bornée — réduit le besoin de breakpoints"],
];

const BREAKPOINTS: readonly number[] = [480, 768, 1024, 1200];
const LARGEURS: readonly number[] = [
  320, 360, 414, 480, 540, 600, 700, 768, 800, 900, 1000, 1024, 1100, 1200,
  1280, 1440, 1600, 1920, 2560, 1023, 767, 479, 1199,
];

const CUSTOM_PROPS: readonly Ligne[] = [
  ["--couleur-marque: #336699;", "déclare une propriété personnalisée (double tiret obligatoire)"],
  ["color: var(--couleur-marque)", "consomme la variable"],
  ["var(--x, #999)", "valeur de repli si --x n'est pas définie"],
  [":root { --… }", "portée globale — les variables se HÉRITENT dans le sous-arbre"],
  ["calc(100% - 2rem)", "calcul avec unités mixtes — compatible avec les variables"],
  ["redéfinition locale", "un élément peut redéfinir --x : ses descendants héritent de la NOUVELLE valeur"],
  ["media query + variables", "un seul point de vérité : changer la valeur du thème, tout suit"],
  ["JavaScript : el.style.setProperty('--x', v)", "lecture/modification possible côté JS (getComputedStyle)"],
];

const UNITES_CSS: readonly Ligne[] = [
  ["px", "pixel CSS fixe — précis mais ne suit pas les préférences de zoom utilisateur"],
  ["%", "pourcentage du conteneur parent (contexte-dépendant)"],
  ["em", "relatif à la taille de police DU PARENT (compose de façon exponentielle)"],
  ["rem", "relatif à la racine html — l'unité d'espacement préférée pour l'accessibilité"],
  ["vw/vh", "1 % de la largeur/hauteur du viewport"],
  ["vmin/vmax", "1 % du côté le plus petit/le plus grand du viewport"],
  ["ch", "largeur du « 0 » de la police courante — idéale pour limiter la longueur de ligne"],
  ["fr", "partie libre de la grille (grid uniquement)"],
  ["deg/ms/s", "angles et durées (transform, transitions)"],
  ["clamp(min, val, max)", "borne une valeur fluide entre deux limites"],
];

const METHODES_TABLEAU: readonly Ligne[] = [
  ["map", "transforme chaque élément → NOUVEAU tableau de même taille"],
  ["filter", "garde les éléments qui passent le prédicat → nouveau tableau"],
  ["reduce", "accumule en une seule valeur (gauche → droite)"],
  ["reduceRight", "accumule de droite à gauche"],
  ["find", "premier élément qui passe le prédicat (ou undefined)"],
  ["findIndex", "index du premier élément qui passe (ou -1)"],
  ["findLast", "DERNIER élément qui passe le prédicat (ES2023)"],
  ["findLastIndex", "index du dernier élément qui passe (ES2023)"],
  ["some", "true si AU MOINS UN élément passe"],
  ["every", "true si TOUS les éléments passent"],
  ["includes", "présence d'une valeur (NaN inclus, contrairement à indexOf)"],
  ["indexOf", "premier index d'une valeur (-1 si absente)"],
  ["at", "accès par index négatif accepté : arr.at(-1) = dernier élément"],
  ["slice", "copie superficielle d'une tranche — ne modifie pas l'original"],
  ["splice", "SUPPRIME/insère EN PLACE (mutant) — renvoie les éléments retirés"],
  ["toSorted", "tri → NOUVEAU tableau (ES2023, version non mutante de sort)"],
  ["toReversed", "inverse → nouveau tableau (ES2023, version non mutante de reverse)"],
  ["toSpliced", "version non mutante de splice (ES2023)"],
  ["with", "remplace l'élément d'index i → NOUVEAU tableau (ES2023)"],
  ["flat", "aplatit l'imbrication d'un niveau (ou plus avec argument)"],
  ["flatMap", "map puis aplatit d'un niveau"],
  ["join", "concatène en chaîne avec un séparateur"],
  ["fill", "remplit une plage avec une valeur (en place)"],
  ["Object.groupBy", "regroupe par clé dérivée (ES2024)"],
];

const PROMESSES: readonly Ligne[] = [
  ["new Promise((resolve, reject) => …)", "crée une promesse : le résultat arrive plus tard (valeur ou erreur)"],
  ["then(onFulfilled)", "chaîne le succès — renvoie une nouvelle promesse"],
  ["catch(onRejected)", "rattrape l'échec de n'importe quel maillon amont"],
  ["finally", "s'exécute quoi qu'il arrive (nettoyage)"],
  ["async function", "fonction qui renvoie TOUJOURS une promesse"],
  ["await", "suspend la fonction async SANS bloquer le thread — attend la promesse"],
  ["try/catch autour de await", "la façon d'attraper un échec asynchrone"],
  ["Promise.all", "attend TOUTES les promesses — échoue dès la première erreur (fail-fast)"],
  ["Promise.allSettled", "attend toutes les issues, succès OU échec — ne rejette jamais"],
  ["Promise.race", "première issue gagnante (succès OU échec) — utile pour les timeouts"],
  ["Promise.any", "premier SUCCÈS gagnant — rejette (AggregateError) seulement si tout échoue"],
  ["erreur dans .then sans catch", "rejection non gérée → unhandledrejection"],
  ["await dans une boucle for", "séquentiel — pour le parallèle : construire les promesses puis Promise.all"],
];

const MODULES_JS: readonly Ligne[] = [
  ["import / export", "syntaxe ESM standard — un module = un fichier"],
  ["export default", "une exportation par défaut par module (import librement nommé)"],
  ["export nommé", "plusieurs par module — importés avec leur nom exact"],
  ["import as", "renommer à l'import : import { a as b }"],
  ["import('./module.js')", "import dynamique → promesse, point d'entrée du code splitting"],
  ["import.meta", "métadonnées du module courant (url…)"],
  ["re-export", "export { x } from './m' — pont d'API (barrel file)"],
  ["import d'effet de bord", "import './styles.css' — charge pour l'effet"],
  ["tree shaking", "les bundlers éliminent les exports non utilisés — préférer les exports nommés"],
  ["type: module", "package.json : le .js du paquet est traité comme ESM"],
];

const TYPES_TS: readonly Ligne[] = [
  ["string | number | boolean", "types primitifs de base"],
  ["Array<T> / T[]", "tableau de T"],
  ["[string, number]", "tuple : tableau à longueur et types fixes"],
  ["A | B", "union : l'un OU l'autre — affiner par narrowing"],
  ["'a' | 'b'", "type littéral : valeur exacte autorisée"],
  ["enum", "énumération — souvent remplacée par des littéraux + as const"],
  ["unknown", "n'importe quoi MAIS utilisation interdite sans affinage (sûr)"],
  ["any", "n'importe quoi SANS vérification — désactive le typage (à bannir)"],
  ["never", "l'impossible : fin d'une union exhaustive, fonction qui ne revient jamais"],
  ["void", "absence de retour significatif"],
  ["? (propriété optionnelle)", "champ présent ou undefined"],
  ["readonly", "interdit la mutation (champ, tableau, objet)"],
  ["(a: A) => B", "type de fonction"],
  ["function id<T>(v: T): T", "GÉNÉRIQUE : paramètre de type réutilisable, l'inférence fait le reste"],
  ["<T extends Contrainte>", "générique contraint : T doit satisfaire la contrainte"],
  ["<T = défaut>", "générique avec paramètre de type par défaut"],
  ["keyof T", "union des clés de T"],
  ["typeof x", "type de la valeur x (monde valeur → monde type)"],
  ["T['id']", "accès indexé : type du champ id de T"],
  ["satisfies Contrainte", "valide la valeur sans élargir son type inféré"],
  ["v as Type", "assertion : « fais-moi confiance » — à utiliser avec parcimonie"],
  ["x is Type", "garde de type (type predicate) dans un booléen"],
];

const UTILITY_TYPES: readonly Ligne[] = [
  ["Partial<T>", "tous les champs deviennent optionnels (PATCH)"],
  ["Required<T>", "tous les champs deviennent requis"],
  ["Readonly<T>", "tous les champs deviennent readonly"],
  ["Pick<T, K>", "ne garde QUE les clés K"],
  ["Omit<T, K>", "retire les clés K"],
  ["Record<K, V>", "objet dont les clés K mappent vers V"],
  ["Exclude<T, U>", "retire de T les membres assignables à U"],
  ["Extract<T, U>", "garde de T les membres assignables à U"],
  ["NonNullable<T>", "retire null et undefined"],
  ["ReturnType<F>", "type de retour de la fonction F"],
  ["Parameters<F>", "tuple des paramètres de F"],
  ["Awaited<T>", "résolu d'une promesse (async)"],
  ["Uppercase<S>/Lowercase<S>", "transformation littérale de chaîne"],
  ["InstanceType<C>", "instance d'une classe/constructeur"],
  ["Mappeur (keyof + in)", "[K in keyof T]?: … — fabrique tes propres types utilitaires"],
  ["Type conditionnel T extends U ? X : Y", "choix de type selon une condition"],
];

const HOOKS_REACT: readonly Ligne[] = [
  ["useState", "état local : [valeur, setter] — le setter déclenche un re-rendu"],
  ["useEffect", "effet après rendu (abonnements, horloge) — tableau de dépendances, retour = nettoyage"],
  ["useLayoutEffect", "effet AVANT la peinture (mesure DOM) — coûteux, usage rare"],
  ["useContext", "lit un contexte (thème, session) sans percer les props"],
  ["useReducer", "état complexe : dispatch(action) → reducer pur → nouvel état"],
  ["useMemo", "mémoïse un CALCUL — dépendances, pas pour les effets"],
  ["useCallback", "mémoïse une FONCTION (identité stable pour un enfant memo)"],
  ["useRef", "boîte mutable qui ne déclenche pas de re-rendu (DOM, horloge)"],
  ["useId", "identifiant stable côté serveur et client (aria/for)"],
  ["useTransition", "marque une mise à jour non urgente (UI reste réactive)"],
  ["useDeferredValue", "version différée d'une valeur coûteuse"],
  ["useOptimistic", "état optimiste le temps de la confirmation serveur"],
  ["useSyncExternalStore", "abonne React à un store externe (sans tearing)"],
  ["useImperativeHandle", "expose une API limitée d'un enfant via ref"],
  ["hooks personnalisés", "fonction useXxx qui compose les hooks — réutilisation d'ÉTAT+logique"],
  ["règle des hooks", "jamais dans une condition/boucle : même ordre à chaque rendu"],
];

const APP_ROUTER: readonly Ligne[] = [
  ["page.tsx", "route publique de l'arborescence — rendue pour son chemin"],
  ["layout.tsx", "coquille partagée qui PERSISTE entre navigations enfants (pas de re-render complet)"],
  ["loading.tsx", "fallback Suspense automatique du segment"],
  ["error.tsx", "boundary d'erreur du segment — DOIT être un client component"],
  ["not-found.tsx", "404 du segment"],
  ["template.tsx", "comme layout mais re-MONTÉ à chaque navigation"],
  ["route.ts", "Route Handler : GET/POST… côté serveur (API)"],
  ["[id]/page.tsx", "segment dynamique : params.id"],
  ["[...slug]/page.tsx", "catch-all (tous les segments restants)"],
  ["[[...slug]]/page.tsx", "catch-all optionnel (match aussi le chemin racine)"],
  ["(marketing)/page.tsx", "groupe de route : organise sans affecter l'URL"],
  ["@statistiques/page.tsx", "route parallèle : slot rendu en même temps"],
  ["globals.css", "styles globaux importés par le layout racine"],
  ["metadata (export const)", "métadonnées SEO par page/layout (ou generateMetadata)"],
  ["middleware.ts", "à la racine : réécrit/redirige chaque requête avant le routeur"],
  ["public/", "assets servis tels quels (hors arborescence de routage)"],
];

const FETCH_OPTIONS: readonly Ligne[] = [
  ["fetch par défaut (RSC)", "mise en cache selon la configuration du segment — explicite depuis Next 15 : no-store par défaut"],
  ["cache: 'force-cache'", "utilise/renseigne le cache de données"],
  ["cache: 'no-store'", "toujours frais — jamais mis en cache"],
  ["next: { revalidate: 60 }", "cache de 60 secondes (ISR)"],
  ["next: { tags: ['posts'] }", "balise d'invalidation ciblée"],
  ["revalidateTag('posts')", "invalide au prochain accès les entrées portant la balise"],
  ["revalidatePath('/blog')", "invalide le cache d'un chemin"],
  ["Server Actions ('use server')", "mutation côté serveur appelable depuis un composant — remplace les route handlers de mutation"],
  ["async Server Component", "un composant serveur peut être async et awaiter ses données directement"],
  ["Suspense + streaming", "affiche la coquille pendant que les données coulent"],
  ["Route Handler GET", "Response/NextResponse — du HTTP classique côté serveur"],
  ["données POST en mutation", "réserver aux Server Actions ou route.ts + authentification"],
];

const RSC_VS_CLIENT: readonly Ligne[] = [
  ["composants serveur (défaut App Router)", "rendus UNE FOIS côté serveur : zéro JS envoyé au client, accès direct BDD/fs/secrets"],
  ["'use client'", "opte pour l'interactivité : hooks, événements, window — bundle inclus"],
  ["frontière", "les props client→serveur ne traversent pas : le serveur reçoit des props SÉRIALISABLES"],
  ["server component dans client component", "passé en children/props : fonctionne (rendu serveur, monté côté client)"],
  ["hooks interdits en serveur", "useState/useEffect n'existent pas côté serveur"],
  ["async en serveur", "autorisé et encouragé (data fetching direct)"],
  ["interactivité = client", "tout onChange/onClick exige 'use client'"],
  ["coût", "chaque client component embarque son code dans le bundle — descendre la frontière"],
  ["imports serveur-only", "un module marqué server-only casse à la compilation s'il fuit dans le client"],
  ["data fetching", "serveur : fetch/BDD direct ; client : à partir de hooks (SWR, React Query)"],
];

const WEB_VITALS: readonly Ligne[] = [
  ["LCP", "≤ 2,5 s bon · ≤ 4,0 s à améliorer · > 4,0 s mauvais — plus grand élément peint"],
  ["INP", "≤ 200 ms bon · ≤ 500 ms à améliorer · > 500 ms mauvais — réactivité aux interactions"],
  ["CLS", "≤ 0,1 bon · ≤ 0,25 à améliorer · > 0,25 mauvais — stabilité visuelle cumulée"],
  ["FCP", "≤ 1,8 s bon · ≤ 3,0 s à améliorer — premier contenu peint"],
  ["TTFB", "≤ 0,8 s bon · ≤ 1,8 s à améliorer — premier octet"],
  ["mesuré au 75e percentile", "le « bon » s'évalue sur le terrain (CrUX), pas en laboratoire"],
];

const VERDICTS_VITALS: readonly Ligne[] = [
  ["LCP", "1,2"],
  ["LCP", "2,4"],
  ["LCP", "3,1"],
  ["LCP", "4,5"],
  ["INP", "90"],
  ["INP", "180"],
  ["INP", "260"],
  ["INP", "600"],
  ["CLS", "0,02"],
  ["CLS", "0,08"],
  ["CLS", "0,15"],
  ["CLS", "0,3"],
];

function verdictVital(metric: string, valeur: number): string {
  if (metric === "LCP")
    return valeur <= 2.5 ? "bon" : valeur <= 4 ? "à améliorer" : "mauvais";
  if (metric === "INP")
    return valeur <= 200 ? "bon" : valeur <= 500 ? "à améliorer" : "mauvais";
  return valeur <= 0.1 ? "bon" : valeur <= 0.25 ? "à améliorer" : "mauvais";
}

const TECHNIQUES_PERF: readonly Ligne[] = [
  ["loading=\"lazy\" sur <img>", "chargement différé hors viewport — réduit les requêtes initiales (LCP des autres)"],
  ["fetchpriority=\"high\"", "priorise l'image LCP"],
  ["<link rel=\"preload\">", "charge tôt une ressource critique découverte tard"],
  ["<link rel=\"preconnect\">", "ouvre la connexion (DNS+TCP+TLS) vers un tiers avant le besoin"],
  ["import() dynamique", "code splitting : charge le JS au moment du besoin"],
  ["srcset/sizes", "livre l'image adaptée à la densité/au viewport"],
  ["AVIF/WebP", "formats modernes : 30–50 % plus légers que JPEG"],
  ["font-display: swap", "texte visible immédiatement (police d'échange)"],
  ["defer (scripts)", "exécution après le parsing, dans l'ordre — ne bloque pas le rendu"],
  ["async (scripts)", "exécution dès disponible, ordre non garanti"],
  ["compression brotli/gzip", "réduit le poids des textes (HTML/CSS/JS)"],
  ["HTTP caching (ETag/Cache-Control)", "évite de re-télécharger ce qui n'a pas changé"],
  ["CDN", "sert depuis l'edge, proche de l'utilisateur (latence)"],
  ["CLS : dimensions réservées", "width/height ou aspect-ratio sur img/video/embed — zéro saut de mise en page"],
  ["INP : découper le travail long", "differer, requestIdleCallback, garder les handlers < 200 ms"],
  ["CSS critique inline", "styles au-dessus de la plonge sans requête bloquante"],
];

const WCAG_BASES: readonly Ligne[] = [
  ["POUR", "4 principes : Perceptible, Utilisable (Operable), Compréhensible, Robuste"],
  ["niveaux A/AA/AAA", "critères de succès gradués — AA est le standard légal (RGAA s'y appuie)"],
  ["contraste texte normal", "≥ 4,5:1 en AA (7:1 en AAA)"],
  ["contraste gros texte", "≥ 3:1 en AA (18pt/14pt gras)"],
  ["clavier (2.1.1)", "tout est opérable au clavier — pas de piège de focus"],
  ["focus visible (2.4.7)", "indicateur de focus jamais supprimé (outline: none sans alternative)"],
  ["libellés de champs (3.3.2)", "<label> ou aria-label sur chaque champ"],
  ["lang (1.3.1)", "<html lang=\"fr\"> — la synthèse vocale choisit la bonne voix"],
  ["ordre des titres", "h1 unique, niveaux sans saut — plan navigable"],
  ["reflow (1.4.10)", "contenu utilisable à 320px sans défilement bidirectionnel"],
  ["zoom 200 % (1.4.4)", "texte lisible après zoom — préférer rem aux px"],
  ["alternative textuelle (1.1.1)", "alt pertinent : decoratif → alt=\"\", informatif → description"],
  ["mouvement (2.3.3)", "respecter prefers-reduced-motion"],
];

const COUPLES_CONTRASTE: readonly Ligne[] = [
  ["#000000", "#ffffff"],
  ["#767676", "#ffffff"],
  ["#757575", "#ffffff"],
  ["#959595", "#ffffff"],
  ["#ffffff", "#336699"],
  ["#777777", "#eeeeee"],
  ["#595959", "#ffffff"],
  ["#005a9c", "#ffffff"],
  ["#a8a8a8", "#1a1a1a"],
  ["#ff0000", "#ffffff"],
  ["#006400", "#ffffff"],
  ["#ffd700", "#ffffff"],
];

const NPM_COMMANDES: readonly Ligne[] = [
  ["npm install", "installe les dépendances selon package.json + lockfile (peut le mettre à jour)"],
  ["npm ci", "installe EXACTEMENT le lockfile — propre, déterministe (CI)"],
  ["npm run <script>", "exécute un script de package.json"],
  ["npx <outil>", "télécharge et exécute un outil sans l'installer globalement"],
  ["npm audit", "signale les vulnérabilités connues de l'arbre de dépendances"],
  ["npm outdated", "liste les dépendances dépassées"],
  ["npm update", "met à jour dans les plages semver autorisées"],
  ["package-lock.json", "arrête les versions exactes — COMMITTÉ, source de vérité"],
  ["dependencies vs devDependencies", "runtime vs build/tests — l'install de prod peut omettre les secondes"],
  ["^1.2.3 (caret)", "accepte les mises à jour mineures/patch : 1.x.y ≥ 1.2.3"],
  ["~1.2.3 (tilde)", "accepte les patch uniquement : 1.2.x ≥ 1.2.3"],
  ["semver MAJEURE.MINUEURE.CORRECTIF", "majeure = rupture, minueure = ajout rétrocompatible, correctif = bug"],
  ["type: \"module\"", "les .js du paquet sont ESM"],
  ["exports (package.json)", "déclare les points d'entrée publics du paquet"],
  ["workspaces", "monorepo npm : un seul node_modules pour plusieurs paquets"],
  ["engines", "versions de Node requises"],
];

const VERSIONS_SEMVER: readonly string[] = [
  "1.2.3", "1.4.0", "2.0.0", "0.5.1", "0.2.0", "3.10.2", "1.0.0", "4.1.3",
  "0.0.5", "2.3.9", "1.9.9", "5.0.1", "0.9.9", "6.2.0", "1.1.7", "3.0.0",
];

// ─── DNS ─────────────────────────────────────────────────────────────────────

const TYPES_DNS: readonly Ligne[] = [
  ["A", "nom → adresse IPv4", "ex. exemple.org. IN A 203.0.113.10"],
  ["AAAA", "nom → adresse IPv6", "ex. exemple.org. IN AAAA 2001:db8::10"],
  ["CNAME", "alias vers un AUTRE NOM (interdit à l'apex avec SOA/NS)", "ex. www. IN CNAME exemple.org."],
  ["MX", "routage du courriel vers le serveur de messagerie + priorité", "ex. IN MX 10 mail.exemple.org."],
  ["NS", "délégation : quels serveurs font autorité pour la zone", "ex. IN NS ns1.fournisseur.net."],
  ["TXT", "texte arbitraire : SPF, DKIM, DMARC, vérification de possession", "ex. IN TXT \"v=spf1 include:_spf.exemple.org -all\""],
  ["SOA", "début d'autorité : NS primaire, courriel admin, numéros de série, timers", "serial, refresh, retry, expire, minimum/TTL négatif"],
  ["PTR", "reverse : adresse IP → nom (rétro-DNS, bases anti-spam)", "ex. 10.113.0.203.in-addr.arpa. IN PTR mail.exemple.org."],
  ["CAA", "quelles autorités de certification peuvent émettre pour le domaine", "ex. IN CAA 0 issue \"letsencrypt.org\""],
  ["SRV", "localisation d'un service (port + hôte + priorité + poids)", "ex. _sip._tcp IN SRV 10 60 5060 sip.exemple.org."],
  ["DNSKEY", "clé publique DNSSEC de la zone (KSK et/ou ZSK)", "publiée dans la zone signée"],
  ["DS", "empreinte de la KSK, publiée CHEZ LE PARENT — lie la zone à la chaîne de confiance", "ex. exemple.org. IN DS 12345 8 2 AB12CD…"],
  ["RRSIG", "signature cryptographique d'un RRset (DNSSEC)", "vérifiée avec la DNSKEY de la zone"],
  ["NSEC/NSEC3", "prouve le DÉNI D'EXISTENCE d'un nom (anti NXDOMAIN forgé)", "chaînage signé entre noms existants"],
  ["TLSA", "attache un certificat TLS à un service (DANE)", "ex. _443._tcp.www IN TLSA 3 1 1 …"],
  ["SVCB/HTTPS", "pointeurs de service modernes (alt endpoints,ECH, ALPN)", "ex. IN HTTPS 1 . alpn=h2"],
  ["ALIAS/ANAME", "pseudo-CNAME à l'apex : aplatit en A côté DNS (spécifique fournisseur)", "le fournisseur résout en A à chaque TTL"],
  ["SSHFP", "empreintes SSH des hôtes de la zone", "ex. hote IN SSHFP 2 1 AB12CD…"],
];

const HIERARCHIE_DNS: readonly Ligne[] = [
  ["racine (.)", "sommet de l'arbre — 13 serveurs logiques (a–m.root-servers.net), anycast"],
  ["TLD", "domaines de premier niveau (.org, .fr, .com) gérés par des registres"],
  ["registre/registrar", "le registre tient la zone TLD ; le registrar vend l'enregistrement du domaine"],
  ["serveurs autoritaires", "font autorité pour UNE zone — répondent avec des données signées (ou NXDOMAIN)"],
  ["résolveur récursif", "fait le travail complet pour le client (FAI, 1.1.1.1, 8.8.8.8) et CACHE les réponses"],
  ["résolveur stub", "le petit client de l'OS : renvoie tout au récursif configuré"],
  ["cache", "chaque niveau garde les réponses pendant leur TTL — la « propagation » est du cache qui expire"],
  ["délégation NS + glue", "le parent pointe les NS de l'enfant ; glue = A du NS dans la zone du parent si son nom est sous le domaine"],
  ["zone vs domaine", "la zone est la partie déléguée (fichier) ; le domaine est le sous-arbre entier"],
  ["port 53", "UDP pour les requêtes usuelles, TCP pour les grandes réponses (DNSSEC) et les transferts de zone"],
  ["anycast", "le même IP servi depuis plusieurs sites — résolveurs publics et serveurs racine"],
  ["récursif vs itératif", "le récursif fait tout pour vous ; l'itératif répond par des références à suivre"],
];

const DOMAINES_RESOLUTION: readonly string[] = [
  "www.exemple.org", "api.monsite.fr", "blog.exemple.net", "mail.corp.example",
  "cdn.boutique.fr", "web.app.com", "intranet.asso.org", "docs.dev.io",
  "shop.example.com", "portal.admin.net", "sso.identite.fr", "edge.media.tv",
];

const ZONE_PRODUCTION: readonly Ligne[] = [
  ["www IN A 203.0.113.10", "adresse du site (IPv4)"],
  ["www IN AAAA 2001:db8::10", "adresse du site (IPv6)"],
  ["exemple.org. IN A 203.0.113.10", "apex : DOIT être A/AAAA (CNAME interdit)"],
  ["www IN CNAME exemple.org.", "alias www vers l'apex — autorisé car www n'est pas l'apex"],
  ["IN MX 10 mail.exemple.org.", "courriel : priorité 10, hôte cible"],
  ["IN MX 20 mail2.exemple.org.", "serveur de secours : priorité plus GRANDE essayée après"],
  ["mail IN A 203.0.113.25", "le hôte visé par MX doit résoudre en A/AAAA"],
  ["IN TXT \"v=spf1 include:_spf.exemple.org -all\"", "SPF : quels serveurs peuvent émettre pour le domaine, -all refuse le reste"],
  ["sep2026._domainkey IN TXT \"v=DKIM1; k=rsa; p=MIIBI…\"", "clé publique DKIM du sélecteur sep2026"],
  ["_dmarc IN TXT \"v=DMARC1; p=quarantine; rua=mailto:dmarc@exemple.org\"", "politique DMARC + rapports"],
  ["IN CAA 0 issue \"letsencrypt.org\"", "certificats autorisés : Let's Encrypt seulement"],
  ["_acme-challenge IN TXT \"gfj9Xq…\"", "défi DNS-01 pour Let's Encrypt"],
  ["IN NS ns1.hebergeur.net.", "délégation vers le serveur autoritaire primaire"],
  ["IN NS ns2.hebergeur.net.", "secondaire — toujours au moins deux NS"],
  ["IN SOA ns1.hebergeur.net. hostmaster.exemple.org. 2026111501 3600 900 1209600 3600", "série incrémentée à chaque changement + timers"],
  ["_sip._tcp IN SRV 10 60 5060 sip.exemple.org.", "localisation du service SIP"],
  ["10.113.0.203.in-addr.arpa. IN PTR mail.exemple.org.", "reverse DNS de l'IP du serveur de courriel"],
  ["sub IN A 203.0.113.42", "sous-domaine dédié (API, application)"],
];

const TTLS_DNS: readonly number[] = [
  60, 120, 300, 600, 900, 1800, 3600, 7200, 14400, 43200, 86400, 172800,
  30, 45, 240, 1200, 2700, 5400, 10800, 21600, 64800, 129600, 259200, 15,
];

const HEURES_DNS: readonly string[] = [
  "00:00", "01:00", "02:30", "03:15", "04:40", "06:00", "07:30", "09:00",
  "10:15", "11:45", "13:00", "14:20", "15:30", "16:50", "18:00", "19:35",
  "21:00", "22:15", "23:30", "05:50", "08:10", "12:35", "17:25", "20:45",
];

const SETS_MX: readonly Ligne[] = [
  ["10 mail1.exemple.org.", "20 mail2.exemple.org."],
  ["5 mx1.fournisseur.net.", "10 mx2.fournisseur.net.", "20 mx3.fournisseur.net."],
  ["1 mx.urgent.org.", "100 mx.lent.org."],
  ["10 mx.exemple.fr.", "10 mx2.exemple.fr."],
  ["20 backup.net.", "10 primaire.net."],
  ["0 mx0.org.", "5 mx5.org.", "10 mx10.org."],
  ["15 mail.a.io.", "15 mail.b.io."],
  ["2 gmail-smtp-in.l.google.com.", "5 alt1.aspmx.l.google.com."],
  ["50 mx.lent.", "1 mx.rapide."],
  ["10 mx.principal.", "10 mx.secondaire.", "20 mx.tertiaire."],
  ["3 mx.un.", "7 mx.deux."],
  ["12 mx.a.", "4 mx.b."],
];

const ERREURS_DNS: readonly Ligne[] = [
  ["NXDOMAIN", "le NOM n'existe pas — réponse autoritative (ou négative cachée selon le TTL SOA minimum)"],
  ["SERVFAIL", "le résolveur n'a PAS réussi : zone cassée, DNSSEC invalide, timeout upstream — réponse d'échec"],
  ["REFUSED", "le serveur refuse de répondre à CE client (ACL, récursion fermée)"],
  ["timeout", "aucune réponse — port 53 bloqué, serveur mort, pare-feu UDP"],
  ["TTL négatif", "un NXDOMAIN est caché aussi : durée = minimum/TTL négatif du SOA"],
  ["CNAME suspendu", "alias vers un nom qui n'existe plus — résolution échoue côté cible"],
  ["boucle CNAME", "chaîne infinie d'alias — le résolveur abandonne en SERVFAIL"],
  ["glue manquant", "NS dans la zone du domaine sans A au parent — amorçage impossible (SERVFAIL/délai)"],
  ["« propagation »", "ce n'est pas une onde : c'est du CACHE qui expire — chaque résolveur expire à son rythme"],
  ["domaine expiré", "registrar : le domaine retombe en NXDOMAIN/parking après expiration"],
  ["registre vs zone", "le domaine peut être ENREGISTRÉ mais sans zone active — erreur courante"],
  ["DNSSEC cassé", "signature expirée/changée sans publication DS → SERVFAIL sur les résolveurs VALIDATEURS"],
];

const DNSSEC_FAITS: readonly Ligne[] = [
  ["pourquoi DNSSEC", "authenticité + intégrité des réponses : impossible de falsifier un RRset (anti cache-poisoning)"],
  ["ce que DNSSEC ne fait PAS", "pas de chiffrement ni de confidentialité : le contenu reste lisible (DoT/DoH pour ça)"],
  ["chaîne de confiance", "racine → DS du TLD → DS de la zone → DNSKEY : chaque parent signe le lien vers l'enfant"],
  ["KSK", "Key Signing Key : signe les DNSKEY — sa DS est publiée chez le registrar/parent"],
  ["ZSK", "Zone Signing Key : signe les RRsets courants (A, MX, TXT…)"],
  ["RRSIG", "signature par RRset, valide entre inception et expiration — RÉNOVER avant péremption"],
  ["NSEC/NSEC3", "prouve qu'un nom N'existe PAS (déni d'existence authentifié)"],
  ["DS au parent", "empreinte de la KSK publiée par le registrar dans la zone TLD"],
  ["validation côté résolveur", "le récursif valideur vérifie la chaîne ; le flag AD signale une réponse validée"],
  ["algorithme", "ex. 8 (RSA/SHA-256) ou 13 (ECDSA P-256/SHA-256) — ECDSA réduit la taille des réponses"],
  ["rollover", "rotation des clés planifiée (prépublication) — sinon rupture de service"],
  ["échec typique", "signatures expirées ou DS périmée au parent → SERVFAIL pour les clients validants"],
  ["DO/AD/CD bits", "DO : envoie-moi les enregistrements DNSSEC ; AD : validé ; CD : je vérifie moi-même"],
  ["activation", "signer la zone + publier la DS chez le registrar — testable via les outils DNS"],
];

const SPF_DKIM_DMARC: readonly Ligne[] = [
  ["SPF v=spf1", "liste blanche des serveurs autorisés à ÉMETTRE pour le domaine"],
  ["SPF -all", "échec dur : tout serveur non listé est rejeté (après déploiement validé)"],
  ["SPF ~all", "échec doux : suspect mais accepté — phase de transition"],
  ["SPF 10 lookups", "limite dure de résolutions par message — simplifier les include"],
  ["DKIM", "signature cryptographique du message par le serveur émetteur"],
  ["DKIM sélecteur", "s1._domainkey.exemple.org — la clé publique est publiée en TXT"],
  ["DKIM 2048 bits", "taille de clé recommandée (1024 trop court aujourd'hui)"],
  ["DMARC", "politique sur l'ALIGNEMENT SPF/DKIM avec le domaine From"],
  ["DMARC p=none", "surveillance seule — première étape, aucun rejet"],
  ["DMARC p=quarantine", "les échecs passent en indésirable"],
  ["DMARC p=reject", "les échecs sont rejetés — cible finale"],
  ["rua=mailto:…", "adresse recevant les rapports agrégés (XML)"],
  ["alignment", "le domaine SPF (Return-Path) ou DKIM (d=) doit COÏNCIDER avec le From visible"],
  ["production", "SPF + DKIM + DMARC ensemble : DKIM seul survit aux redirections"],
];

const OUTILS_DNS: readonly Ligne[] = [
  ["dig +short exemple.org", "réponse épurée : l'essentiel (A)"],
  ["dig MX exemple.org", "réponse MX complète avec TTL"],
  ["dig @1.1.1.1 exemple.org", "interroge UN résolveur précis — comparaison multi-résolveurs"],
  ["dig +trace exemple.org", "rejoue la délégation racine→TLD→autoritaire pas à pas"],
  ["dig +norecurse @ns1.exemple.org exemple.org", "interroge l'AUTORITAIRE direct — réponse de référence"],
  ["TTL affiché par le résolveur", "le TTL renvoyé DÉCRÉT à chaque lecture — signe que la réponse vient du cache"],
  ["nslookup -type=AAAA exemple.org", "équivalent dig sans format détaillé"],
  ["host exemple.org", "réponse compacte, tous les types courants"],
  ["whois exemple.org", "enregistrement/registrar au registre — pas la résolution"],
  ["DoH/DoT", "DNS chiffré (HTTPS/TLS 853) : confidentialité transport — DNSSEC reste la signature"],
];

// ─── FAMILLES (id → gabarits × lignes) ───────────────────────────────────────

const FAMILLES: readonly FamilleDevWeb[] = [
  {
    id: "statuts-http",
    sousTheme: "http-securite",
    lignes: STATUTS,
    gabarits: [
      (l) => [
        `Que signifie le code de statut HTTP ${l[0]} ?`,
        `${l[0]} — ${l[1]} : ${l[2]}. Famille : ${familleStatutHttp(Number(l[0]))}.`,
      ],
      (l) => [
        `Le statut HTTP ${l[0]} indique une réussite, une redirection, une erreur client ou une erreur serveur ?`,
        `${l[0]} (${l[1]}) : ${familleStatutHttp(Number(l[0]))}. En clair : ${l[2]}.`,
      ],
      (l) => [
        `Quel statut HTTP porte le nom « ${l[1]} » ?`,
        `C'est le ${l[0]} : ${l[2]}.`,
      ],
    ],
  },
  {
    id: "methodes-http",
    sousTheme: "http-securite",
    lignes: METHODES_HTTP,
    gabarits: [
      (l) => [
        `À quoi sert la méthode HTTP ${l[0]} ?`,
        `${l[0]} : ${l[4]}. Elle est ${l[1]} et ${l[2]}, ${l[3]}.`,
      ],
      (l) => [
        `La méthode HTTP ${l[0]} est-elle sûre et idempotente ?`,
        `${l[0]} : sûreté ${l[1]}, idempotence ${l[2]} (usage : ${l[4]}).`,
      ],
    ],
  },
  {
    id: "entetes-http",
    sousTheme: "http-securite",
    lignes: ENTETES_HTTP,
    gabarits: [
      (l) => [
        `À quoi sert l'en-tête HTTP ${l[0]} ?`,
        `${l[0]} : ${l[1]}.`,
      ],
      (l) => [
        `Dans quel cas l'en-tête ${l[0]} est-il utilisé ?`,
        `${l[0]} intervient quand ${l[1].replace(/^[A-Z]/, (c) => c.toLowerCase())}.`,
      ],
    ],
  },
  {
    id: "cache-fraicheur",
    sousTheme: "http-securite",
    lignes: MAX_AGES.flatMap((a) => HEURES.map((h) => [String(a), h] as Ligne)),
    gabarits: [
      (l) => {
        const secondes = Number(l[0]);
        return [
          `Une réponse avec Cache-Control: max-age=${l[0]} est reçue à ${l[1]}. Jusqu'à quand reste-t-elle fraîche ?`,
          `max-age=${l[0]} s = ${dureeHumaine(secondes)} : fraîche jusqu'à ${heureApres(l[1], secondes)} (puis revalidation via ETag/If-None-Match).`,
        ];
      },
    ],
  },
  {
    id: "etag-revalidation",
    sousTheme: "http-securite",
    lignes: ETAGS,
    gabarits: [
      (l) =>
        l[2] === "304"
          ? [
              `Le cache envoie If-None-Match: ${l[0]} et l'ETag du serveur correspond. Que répond-il ?`,
              `304 Not Modified : la ressource (${l[0]}) n'a pas changé — pas de corps, le cache réutilise sa copie. Économie totale de bande passante.`,
            ]
          : [
              `Le cache envoie If-None-Match: ${l[0]} mais la ressource a changé. Que répond le serveur ?`,
              `200 OK avec le NOUVEAU corps et un nouvel ETag (l'ancien ${l[0]} ne correspond plus) — le cache se met à jour.`,
            ],
    ],
  },
  {
    id: "cookies-attrs",
    sousTheme: "http-securite",
    lignes: COOKIES_ATTRS,
    gabarits: [
      (l) => [
        `Que fait l'attribut de cookie ${l[0]} ?`,
        `${l[0]} : ${l[1]}.`,
      ],
      (l) => [
        `Pourquoi utiliser ${l[0]} sur un cookie ?`,
        `Parce que ${l[0]} ${l[1].replace(/^[A-Z]/, (c) => c.toLowerCase())}.`,
      ],
    ],
  },
  {
    id: "cors-cas",
    sousTheme: "http-securite",
    lignes: CAS_CORS,
    gabarits: [
      (l) => [
        `CORS : ${l[0]} — comment ça se passe ?`,
        `${l[1]}.`,
      ],
    ],
  },
  {
    id: "auth-schemes",
    sousTheme: "http-securite",
    lignes: AUTH_SCHEMES,
    gabarits: [
      (l) => [
        `Comment fonctionne le schéma d'authentification ${l[0]} ?`,
        `${l[0]} : ${l[1]}.`,
      ],
      (l) => [
        `Quand choisir l'authentification ${l[0]} ?`,
        `${l[0]} convient quand ${l[1].replace(/^[A-Z]/, (c) => c.toLowerCase())}.`,
      ],
    ],
  },
  {
    id: "csp-directives",
    sousTheme: "http-securite",
    lignes: CSP_DIRECTIVES,
    gabarits: [
      (l) => [
        `À quoi sert la directive CSP ${l[0]} ?`,
        `${l[0]} : ${l[1]}.`,
      ],
      (l) => [
        `Dans une Content-Security-Policy, que contrôle ${l[0]} ?`,
        `${l[0]} contrôle ${l[1].replace(/^[A-Z]/, (c) => c.toLowerCase())}.`,
      ],
    ],
  },
  {
    id: "contextes-xss",
    sousTheme: "http-securite",
    lignes: CONTEXTES_XSS,
    gabarits: [
      (l) => [
        `XSS : quelle défense dans le contexte « ${l[0]} » ?`,
        `${l[1]}.`,
      ],
    ],
  },
  {
    id: "headers-securite",
    sousTheme: "http-securite",
    lignes: HEADERS_SECURITE,
    gabarits: [
      (l) => [
        `Que protège l'en-tête ${l[0]} ?`,
        `${l[0]} : ${l[1]}.`,
      ],
      (l) => [
        `Pourquoi envoyer ${l[0]} ?`,
        `Pour ${l[1].replace(/^[A-Z]/, (c) => c.toLowerCase())}.`,
      ],
    ],
  },
  {
    id: "injection",
    sousTheme: "http-securite",
    lignes: INJECTION,
    gabarits: [
      (l) => [
        `Injection : que penser de « ${l[0]} » ?`,
        `${l[1]}.`,
      ],
      (l) => [
        `Comment se protéger contre ${l[0]} ?`,
        `${l[1]}.`,
      ],
    ],
  },
  {
    id: "elements-html",
    sousTheme: "html-css",
    lignes: ELEMENTS_HTML,
    gabarits: [
      (l) => [
        `À quoi sert l'élément HTML ${l[0]} ?`,
        `${l[0]} : ${l[1]}.`,
      ],
      (l) => [
        `Quel élément HTML sémantique pour ${l[2]} ?`,
        `${l[0]} — ${l[1]}.`,
      ],
    ],
  },
  {
    id: "roles-aria",
    sousTheme: "html-css",
    lignes: ROLES_ARIA,
    gabarits: [
      (l) => [
        `Que signifie le rôle ARIA ${l[0]} ?`,
        `role="${l[0]}" : ${l[1]}.`,
      ],
      (l) => [
        `Quand utiliser role="${l[0]}" ?`,
        `Quand ${l[1].replace(/^[A-Z]/, (c) => c.toLowerCase())}.`,
      ],
    ],
  },
  {
    id: "attrs-aria",
    sousTheme: "html-css",
    lignes: ATTRS_ARIA,
    gabarits: [
      (l) => [
        `À quoi sert ${l[0]} ?`,
        `${l[0]} : ${l[1]}.`,
      ],
      (l) => [
        `Comment annoncer l'état avec ${l[0]} ?`,
        `${l[0]} — ${l[1].replace(/^[A-Z]/, (c) => c.toLowerCase())}.`,
      ],
    ],
  },
  {
    id: "flex-props",
    sousTheme: "html-css",
    lignes: FLEX_PROPS,
    gabarits: [
      (l) => [
        `Que fait ${l[0]} en CSS flexbox ?`,
        `${l[0]} : ${l[1]}.`,
      ],
      (l) => [
        `Quelle est l'effet de ${l[0]} ?`,
        `${l[1].replace(/^[A-Z]/, (c) => c.toLowerCase())} — c'est le rôle de ${l[0]}.`,
      ],
    ],
  },
  {
    id: "grid-props",
    sousTheme: "html-css",
    lignes: GRID_PROPS,
    gabarits: [
      (l) => [
        `Que fait ${l[0]} en CSS Grid ?`,
        `${l[0]} : ${l[1]}.`,
      ],
      (l) => [
        `Comment ${l[0]} fonctionne-t-il dans une grille CSS ?`,
        `${l[1].replace(/^[A-Z]/, (c) => c.toLowerCase())}.`,
      ],
    ],
  },
  {
    id: "media-queries",
    sousTheme: "html-css",
    lignes: [
      ...MEDIA_FACTS,
      ...LARGEURS.map((w) => [String(w)] as Ligne),
    ],
    gabarits: [],
  },
  {
    id: "custom-props",
    sousTheme: "html-css",
    lignes: CUSTOM_PROPS,
    gabarits: [
      (l) => [
        `Variables CSS : comment fonctionne « ${l[0]} » ?`,
        `${l[1]}.`,
      ],
    ],
  },
  {
    id: "unites-css",
    sousTheme: "html-css",
    lignes: UNITES_CSS,
    gabarits: [
      (l) => [
        `Quand utiliser l'unité CSS ${l[0]} ?`,
        `${l[0]} : ${l[1]}.`,
      ],
      (l) => [
        `Que vaut 1${l[0]} en CSS ?`,
        `${l[0]} — ${l[1].replace(/^[A-Z]/, (c) => c.toLowerCase())}.`,
      ],
    ],
  },
  {
    id: "methodes-tableau",
    sousTheme: "js-ts",
    lignes: METHODES_TABLEAU,
    gabarits: [
      (l) => [
        `Que fait Array.prototype.${l[0]} en JavaScript ?`,
        `${l[0]} : ${l[1]}.`,
      ],
      (l) => [
        `Quand utiliser ${l[0]} sur un tableau JS ?`,
        `Quand ${l[1].replace(/^[A-Z]/, (c) => c.toLowerCase())}.`,
      ],
    ],
  },
  {
    id: "promesses-js",
    sousTheme: "js-ts",
    lignes: PROMESSES,
    gabarits: [
      (l) => [
        `Promesses JS : comment fonctionne « ${l[0]} » ?`,
        `${l[1]}.`,
      ],
      (l) => [
        `Comment gérer ${l[0]} ?`,
        `${l[1].replace(/^[A-Z]/, (c) => c.toLowerCase())}.`,
      ],
    ],
  },
  {
    id: "modules-js",
    sousTheme: "js-ts",
    lignes: MODULES_JS,
    gabarits: [
      (l) => [
        `Modules JavaScript : que fait « ${l[0]} » ?`,
        `${l[1]}.`,
      ],
    ],
  },
  {
    id: "types-ts",
    sousTheme: "js-ts",
    lignes: TYPES_TS,
    gabarits: [
      (l) => [
        `TypeScript : à quoi sert « ${l[0]} » ?`,
        `${l[0]} : ${l[1]}.`,
      ],
      (l) => [
        `Que veut dire ${l[0]} en TypeScript ?`,
        `${l[1].replace(/^[A-Z]/, (c) => c.toLowerCase())}.`,
      ],
    ],
  },
  {
    id: "utility-types-ts",
    sousTheme: "js-ts",
    lignes: UTILITY_TYPES,
    gabarits: [
      (l) => [
        `À quoi sert le type utilitaire ${l[0]} en TypeScript ?`,
        `${l[0]} : ${l[1]}.`,
      ],
      (l) => [
        `Comment dériver un type avec ${l[0]} ?`,
        `${l[0]} — ${l[1].replace(/^[A-Z]/, (c) => c.toLowerCase())}.`,
      ],
    ],
  },
  {
    id: "hooks-react",
    sousTheme: "react-next",
    lignes: HOOKS_REACT,
    gabarits: [
      (l) => [
        `À quoi sert le hook React ${l[0]} ?`,
        `${l[0]} : ${l[1]}.`,
      ],
      (l) => [
        `Quand utiliser ${l[0]} en React ?`,
        `Quand ${l[1].replace(/^[A-Z]/, (c) => c.toLowerCase())}.`,
      ],
    ],
  },
  {
    id: "app-router",
    sousTheme: "react-next",
    lignes: APP_ROUTER,
    gabarits: [
      (l) => [
        `Next.js App Router : à quoi sert ${l[0]} ?`,
        `${l[0]} : ${l[1]}.`,
      ],
      (l) => [
        `Comment organiser ${l[0]} dans l'App Router ?`,
        `${l[1].replace(/^[A-Z]/, (c) => c.toLowerCase())}.`,
      ],
    ],
  },
  {
    id: "fetch-next",
    sousTheme: "react-next",
    lignes: FETCH_OPTIONS,
    gabarits: [
      (l) => [
        `Next.js : que fait « ${l[0]} » pour les données ?`,
        `${l[1]}.`,
      ],
      (l) => [
        `Comment gérer le cache avec ${l[0]} ?`,
        `${l[1].replace(/^[A-Z]/, (c) => c.toLowerCase())}.`,
      ],
    ],
  },
  {
    id: "rsc-vs-client",
    sousTheme: "react-next",
    lignes: RSC_VS_CLIENT,
    gabarits: [
      (l) => [
        `React/Next : ${l[0]} — c'est quoi ?`,
        `${l[1]}.`,
      ],
      (l) => [
        `Server vs client components : que signifie ${l[0]} ?`,
        `${l[1].replace(/^[A-Z]/, (c) => c.toLowerCase())}.`,
      ],
    ],
  },
  {
    id: "web-vitals",
    sousTheme: "perf-a11y",
    lignes: WEB_VITALS,
    gabarits: [
      (l) => [
        `Core Web Vitals : quelles sont les seuils de ${l[0]} ?`,
        `${l[0]} — ${l[1]}.`,
      ],
      (l) => [
        `Que mesure ${l[0]} ?`,
        `${l[0]} mesure ${l[1].replace(/^[A-Z]/, (c) => c.toLowerCase())}.`,
      ],
    ],
  },
  {
    id: "verdict-vitals",
    sousTheme: "perf-a11y",
    lignes: VERDICTS_VITALS,
    gabarits: [
      (l) => [
        `Un ${l[0]} mesuré à ${l[1]}${l[0] === "CLS" ? "" : l[0] === "INP" ? " ms" : " s"} — verdict ?`,
        `${l[0]} ${l[1]}${l[0] === "CLS" ? "" : l[0] === "INP" ? " ms" : " s"} = ${verdictVital(l[0], Number(l[1]))} (seuils : LCP ≤ 2,5 s, INP ≤ 200 ms, CLS ≤ 0,1).`,
      ],
    ],
  },
  {
    id: "techniques-perf",
    sousTheme: "perf-a11y",
    lignes: TECHNIQUES_PERF,
    gabarits: [
      (l) => [
        `Performance web : que fait « ${l[0]} » ?`,
        `${l[1]}.`,
      ],
      (l) => [
        `Comment améliorer ${l[0]} ?`,
        `${l[1].replace(/^[A-Z]/, (c) => c.toLowerCase())}.`,
      ],
    ],
  },
  {
    id: "wcag-bases",
    sousTheme: "perf-a11y",
    lignes: WCAG_BASES,
    gabarits: [
      (l) => [
        `Accessibilité : que dit WCAG sur « ${l[0]} » ?`,
        `${l[1]}.`,
      ],
      (l) => [
        `Comment respecter ${l[0]} ?`,
        `${l[1].replace(/^[A-Z]/, (c) => c.toLowerCase())}.`,
      ],
    ],
  },
  {
    id: "contraste-wcag",
    sousTheme: "perf-a11y",
    lignes: COUPLES_CONTRASTE,
    gabarits: [
      (l) => {
        const v = verdictContraste(l[0], l[1]);
        return [
          `Quel est le ratio de contraste entre ${l[0]} et ${l[1]} ?`,
          `Ratio calculé (luminance relative WCAG) : ${v.ratio}:1 — ${v.verdict}.`,
        ];
      },
      (l) => {
        const v = verdictContraste(l[0], l[1]);
        return [
          `Le texte ${l[0]} sur fond ${l[1]} passe-t-il l'accessibilité AA ?`,
          `${v.ratio}:1 — ${v.verdict}.`,
        ];
      },
    ],
  },
  {
    id: "npm-node",
    sousTheme: "perf-a11y",
    lignes: NPM_COMMANDES,
    gabarits: [
      (l) => [
        `Node/npm : que fait « ${l[0]} » ?`,
        `${l[1]}.`,
      ],
      (l) => [
        `Pourquoi utiliser ${l[0]} ?`,
        `Parce que ${l[1].replace(/^[A-Z]/, (c) => c.toLowerCase())}.`,
      ],
    ],
  },
  {
    id: "semver-arith",
    sousTheme: "perf-a11y",
    lignes: VERSIONS_SEMVER.flatMap((v) => [
      [`^${v}`, "caret"] as Ligne,
      [`~${v}`, "tilde"] as Ligne,
    ]),
    gabarits: [
      (l) => [
        `npm : quelle plage de versions couvre ${l[0]} ?`,
        `${l[0]} accepte ${plagesSemver(l[0].slice(1), l[1] === "caret" ? "^" : "~")}.`,
      ],
    ],
  },
  {
    id: "types-enregistrements-dns",
    sousTheme: "dns",
    lignes: TYPES_DNS,
    gabarits: [
      (l) => [
        `À quoi sert un enregistrement DNS de type ${l[0]} ?`,
        `${l[0]} : ${l[1]} (${l[2]}).`,
      ],
      (l) => [
        `Que contient un enregistrement ${l[0]} ?`,
        `${l[0]} contient ${l[1].replace(/^[A-Z]/, (c) => c.toLowerCase())} — ${l[2]}.`,
      ],
      (l) => [
        `Quel type d'enregistrement DNS pour ${l[1].replace(/^[A-Z]/, (c) => c.toLowerCase())} ?`,
        `${l[0]} — ${l[2]}.`,
      ],
    ],
  },
  {
    id: "hierarchie-dns",
    sousTheme: "dns",
    lignes: HIERARCHIE_DNS,
    gabarits: [
      (l) => [
        `DNS : que joue « ${l[0]} » dans la hiérarchie ?`,
        `${l[0]} : ${l[1]}.`,
      ],
      (l) => [
        `Quel est le rôle de ${l[0]} ?`,
        `${l[1].replace(/^[A-Z]/, (c) => c.toLowerCase())}.`,
      ],
    ],
  },
  {
    id: "resolution-pas-a-pas",
    sousTheme: "dns",
    lignes: DOMAINES_RESOLUTION.map((d) => [d] as Ligne),
    gabarits: [
      (l) => [
        `Comment se résout ${l[0]} pas à pas ?`,
        `1) le stub de l'OS vérifie son cache ; 2) question au résolveur récursif (cache ?) ; 3) le récursif demande à la RACINE → référence vers les serveurs ${l[0].split(".").slice(-1)[0]} ; 4) le TLD renvoie les NS autoritaires du domaine ; 5) l'autoritaire répond (A/AAAA) avec son TTL ; 6) le récursif met en cache et rend la réponse.`,
      ],
      (l) => [
        `Quel est le chemin de résolution DNS de ${l[0]} ?`,
        `Stub → récursif → racine → serveurs du TLD ${l[0].split(".").slice(-1)[0]} → serveur autoritaire du domaine → réponse A/AAAA cachée pendant le TTL.`,
      ],
    ],
  },
  {
    id: "zone-production",
    sousTheme: "dns",
    lignes: ZONE_PRODUCTION,
    gabarits: [
      (l) => [
        `Mise en production DNS : pourquoi publier « ${l[0]} » ?`,
        `Parce que ${l[1].replace(/^[A-Z]/, (c) => c.toLowerCase())}.`,
      ],
      (l) => [
        `Quelle entrée de zone correspond à « ${l[1]} » ?`,
        `${l[0]} — ${l[1].replace(/^[A-Z]/, (c) => c.toLowerCase())}.`,
      ],
    ],
  },
  {
    id: "ttl-duree",
    sousTheme: "dns",
    lignes: TTLS_DNS.map((t) => [String(t)] as Ligne),
    gabarits: [
      (l) => [
        `Un enregistrement avec TTL ${l[0]} s : après un changement, combien de temps les résolveurs peuvent-ils servir l'ancienne valeur ?`,
        `Jusqu'à ${dureeHumaine(Number(l[0]))} (le TTL ${l[0]} s = durée de cache). Conseil : baisser le TTL 24–48 h AVANT la migration.`,
      ],
      (l) => [
        `TTL ${l[0]} : quelle durée maximale de « propagation » pour ce record ?`,
        `${dureeHumaine(Number(l[0]))} au maximum — c'est du cache qui expire, pas une onde qui circule.`,
      ],
    ],
  },
  {
    id: "ttl-horloge",
    sousTheme: "dns",
    lignes: TTLS_DNS.flatMap((t) =>
      HEURES_DNS.map((h) => [String(t), h] as Ligne),
    ),
    gabarits: [
      (l) => [
        `Un résolveur a mis en cache le record à ${l[1]} avec TTL ${l[0]} s. Jusqu'à quand répond-il l'ancienne valeur ?`,
        `Jusqu'à ${heureApres(l[1], Number(l[0]))} (cache posé à ${l[1]} + ${dureeHumaine(Number(l[0]))}).`,
      ],
    ],
  },
  {
    id: "mx-priorites",
    sousTheme: "dns",
    lignes: SETS_MX,
    gabarits: [
      (l) => {
        const tri = l
          .map((e) => {
            const m = e.match(/^(\d+)\s+(\S+)\.?$/)!;
            return { p: Number(m[1]), h: m[2] };
          })
          .sort((a, b) => a.p - b.p);
        const ordre = tri.map((m) => `${m.h} (priorité ${m.p})`).join(" → ");
        return [
          `MX : ${l.join(" ; ")}. Quel serveur est essayé en premier ?`,
          `Priorité la PLUS BASSE d'abord : ${ordre}. Si le premier échoue, on descend la liste dans l'ordre croissant des priorités.`,
        ];
      },
      (l) => {
        const tri = l
          .map((e) => {
            const m = e.match(/^(\d+)\s+(\S+)\.?$/)!;
            return { p: Number(m[1]), h: m[2] };
          })
          .sort((a, b) => a.p - b.p);
        return [
          `Comment interpréter ces enregistrements MX : ${l.join(" ; ")} ?`,
          `Ordre d'essai : ${ordre2(tri)}. Les nombres égaux répartissent la charge ; les plus grands sont des secours.`,
        ];
      },
    ],
  },
  {
    id: "erreurs-dns",
    sousTheme: "dns",
    lignes: ERREURS_DNS,
    gabarits: [
      (l) => [
        `DNS : que signifie ${l[0]} ?`,
        `${l[0]} : ${l[1]}.`,
      ],
      (l) => [
        `Comment diagnostiquer ${l[0]} ?`,
        `${l[1].replace(/^[A-Z]/, (c) => c.toLowerCase())} — croiser dig +trace, un autoritaire direct (@ns) et deux résolveurs publics.`,
      ],
    ],
  },
  {
    id: "dnssec-faits",
    sousTheme: "dns",
    lignes: DNSSEC_FAITS,
    gabarits: [
      (l) => [
        `DNSSEC : ${l[0]} — explique.`,
        `${l[1]}.`,
      ],
      (l) => [
        `Pourquoi ${l[0]} en DNSSEC ?`,
        `${l[1].replace(/^[A-Z]/, (c) => c.toLowerCase())}.`,
      ],
    ],
  },
  {
    id: "spf-dkim-dmarc",
    sousTheme: "dns",
    lignes: SPF_DKIM_DMARC,
    gabarits: [
      (l) => [
        `Courriel : à quoi sert ${l[0]} ?`,
        `${l[0]} : ${l[1]}.`,
      ],
      (l) => [
        `Comment configurer ${l[0]} ?`,
        `${l[1].replace(/^[A-Z]/, (c) => c.toLowerCase())}.`,
      ],
    ],
  },
  {
    id: "outils-dns",
    sousTheme: "dns",
    lignes: OUTILS_DNS,
    gabarits: [
      (l) => [
        `Quelle commande DNS pour « ${l[0]} » ?`,
        `${l[0]} : ${l[1]}.`,
      ],
      (l) => [
        `Comment vérifier ${l[0]} ?`,
        `${l[1].replace(/^[A-Z]/, (c) => c.toLowerCase())}.`,
      ],
    ],
  },
];

function ordre2(
  tri: readonly { p: number; h: string }[],
): string {
  return tri.map((m) => `${m.h} (${m.p})`).join(" → ");
}

// Corrige le gabarit media-queries (fait texte ou largeur calculée).
function uniteMediaQueries(l: Ligne): readonly [string, string] | null {
  const estLargeur = /^\d+$/.test(l[0]);
  if (!estLargeur) {
    return [
      `Que signifie la media query ${l[0]} ?`,
      `${l[0]} : ${(l[1] ?? "").length > 0 ? l[1] : "condition de média CSS"}.`,
    ];
  }
  const w = Number(l[0]);
  const bp = [...BREAKPOINTS].filter((b) => b <= w).sort((a, b) => b - a)[0];
  if (bp === undefined) {
    return [
      `Pour un viewport de ${w}px, quelle media query min-width s'applique ?`,
      `Aucune des bornes (480, 768, 1024, 1200) : ${w}px < 480px — styles mobile de base, la première min-width à franchir est 480px.`,
    ];
  }
  return [
    `Pour un viewport de ${w}px, quelle media query min-width s'applique ?`,
    `La plus grande borne ≤ ${w}px : @media (min-width: ${bp}px) (bornes : 480, 768, 1024, 1200).`,
  ];
}

/** Index → famille (rotation : les familles se succèdent pour que tout
 * préfixe du corpus couvre uniformément chaque sous-thème). */
function familleParIndex(index: number): FamilleDevWeb {
  return FAMILLES[index % FAMILLES.length]!;
}

/** UNITÉ DEV WEB N : matérialise la N-ième unité du générateur.
 * Déterministe : même N → même unité. null si la famille ne peut plus
 * produire de motif inédit (capacité épuisée — honnêteté). */
export function uniteDevWeb(index: number): UniteDevWeb | null {
  const fam = familleParIndex(index);
  const i = Math.floor(index / FAMILLES.length);
  const ligne = fam.lignes[i % fam.lignes.length]!;
  if (fam.id === "media-queries") {
    const paire = uniteMediaQueries(ligne);
    if (!paire) return null;
    return {
      motif: paire[0],
      reponse: paire[1],
      theme: `developpement-web:${fam.sousTheme}`,
      sousTheme: fam.sousTheme,
      famille: fam.id,
    };
  }
  const gabarit = fam.gabarits[Math.floor(i / fam.lignes.length) % fam.gabarits.length]!;
  const [motif, reponse] = gabarit(ligne);
  return {
    motif,
    reponse,
    theme: `developpement-web:${fam.sousTheme}`,
    sousTheme: fam.sousTheme,
    famille: fam.id,
  };
}

/** Nombre de familles exposé (tests + transparence). */
export const NB_FAMILLES_DEV_WEB = FAMILLES.length;

/** Capacité inédite d'une famille : lignes × gabarits (1 gabarit calculé
 * par combinaison). Au-delà, les motifs se répéteraient — on s'arrête. */
export function capaciteFamilleDevWeb(idFamille: string): number {
  const fam = FAMILLES.find((f) => f.id === idFamille);
  if (!fam) return 0;
  // media-queries : unité calculée par ligne (fait OU viewport → borne) —
  // le chemin passe par uniteMediaQueries, pas par des gabarits.
  if (fam.id === "media-queries") return fam.lignes.length;
  return fam.lignes.length * fam.gabarits.length;
}

/** Liste des familles (id, sous-thème, capacité) — transparence totale. */
export function famillesDevWeb(): readonly {
  id: string;
  sousTheme: SousThemeDevWeb;
  capacite: number;
}[] {
  return FAMILLES.map((f) => ({
    id: f.id,
    sousTheme: f.sousTheme,
    capacite:
      f.id === "media-queries"
        ? f.lignes.length
        : f.lignes.length * f.gabarits.length,
  }));
}

/** Matérialise les unités d'UNE famille (dans l'ordre des lignes × gabarits),
 * motifs uniques garantis. */
export function unitesFamilleDevWeb(
  idFamille: string,
  nombre: number,
): readonly UniteDevWeb[] {
  const fam = FAMILLES.find((f) => f.id === idFamille);
  if (!fam) return [];
  const vues = new Set<string>();
  const sorties: UniteDevWeb[] = [];
  const nbIterations =
    fam.id === "media-queries"
      ? fam.lignes.length
      : fam.lignes.length * fam.gabarits.length;
  for (let i = 0; i < nbIterations; i++) {
    const ligne = fam.lignes[i % fam.lignes.length]!;
    const gabarit =
      fam.gabarits[Math.floor(i / fam.lignes.length) % fam.gabarits.length]!;
    let motif: string;
    let reponse: string;
    if (fam.id === "media-queries") {
      const paire = uniteMediaQueries(ligne);
      if (!paire) continue;
      motif = paire[0];
      reponse = paire[1];
    } else if (gabarit) {
      [motif, reponse] = gabarit(ligne);
    } else {
      continue;
    }
    if (vues.has(motif)) continue;
    vues.add(motif);
    sorties.push({
      motif,
      reponse,
      theme: `developpement-web:${fam.sousTheme}`,
      sousTheme: fam.sousTheme,
      famille: fam.id,
    });
    if (sorties.length >= nombre) break;
  }
  return sorties;
}

/** Nombre de lignes d'une famille (télémétrie honnête). */
export function tailleFamilleDevWeb(idFamille: string): number {
  return FAMILLES.find((f) => f.id === idFamille)?.lignes.length ?? 0;
}
