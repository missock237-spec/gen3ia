/**
 * CORPUS DÉVELOPPEMENT WEB — SOUS-THÈMES HTTP + SÉCURITÉ WEB (it.150).
 *
 * HTTP : méthodes et idempotence, familles de statuts (codes calculés
 * depuis les plages RFC 9110), en-têtes, cache (Cache-Control, ETag/304),
 * CORS (simple vs preflight), cookies, authentification (Basic/Bearer/
 * sessions/OAuth). Sécurité : XSS par contexte, CSRF, CSP, injection
 * (SQL/commande/NoSQL), en-têtes de sécurité, TLS.
 *
 * Deux sources honnêtes : paires RÉDIGÉES (cœur de qualité) + unités
 * déterministes du générateur lib/gen3/generateur-dev-web-it150.ts
 * (codes de statut, fraîcheur cache CALCULÉE, revalidations ETag).
 * Module PUR — aucune dépendance Node.
 */

import type { PaireLangage } from "./corpus";
import {
  unitesFamilleDevWeb,
  type UniteDevWeb,
} from "../../gen3/generateur-dev-web-it150";

const THEME = "developpement-web:http-securite";

const ECRIRE = (motif: string, reponse: string): PaireLangage => ({
  motif,
  reponse,
  theme: THEME,
});

export const CORPUS_DEV_WEB_HTTP_SECURITE_ECRIT: readonly PaireLangage[] = [
  // ─── HTTP ───────────────────────────────────────────────────────────────
  ECRIRE(
    "Quelles sont les familles de codes de statut HTTP ?",
    "1xx informationnel (100 Continue, 101 Switching Protocols) ; 2xx réussite (200 OK, 201 Created, 204 No Content) ; 3xx redirection (301 permanent, 302/307 temporaire, 304 Not Modified) ; 4xx erreur CLIENT (400, 401, 403, 404, 409, 422, 429) ; 5xx erreur SERVEUR (500, 502, 503, 504). Le premier chiffre dit la catégorie.",
  ),
  ECRIRE(
    "Quelle différence entre 301, 302, 307 et 308 ?",
    "301 : permanent, la méthode peut être changée en GET par les clients (SEO transféré). 302 : temporaire, même règle historique. 307 : temporaire SANS changement de méthode (le POST reste POST). 308 : permanent sans changement de méthode. Règle : rediriger un POST d'API → 307/308 ; une page → 301/302.",
  ),
  ECRIRE(
    "Quelle différence entre 401 et 403 ?",
    "401 Unauthorized : ON NE SAIT PAS QUI VOUS ÊTES — authentifiez-vous (WWW-Authenticate renvoyé). 403 Forbidden : on sait qui vous êtes et vous n'avez PAS le droit — réessayer ne changera rien. Un 401 invite à (re)se connecter ; un 403 refuse sans espoir.",
  ),
  ECRIRE(
    "Quand renvoyer 400, 422 et 409 ?",
    "400 : requête MALFORMÉE (JSON invalide, paramètre illisible). 422 : syntaxe correcte mais SÉMANTIQUE refusée (champ email invalide, âge négatif) — la validation métier. 409 : CONFLIT avec l'état courant (version concurrente, doublon d'unicité) — le client doit réconcilier avant de retenter.",
  ),
  ECRIRE(
    "Quelles méthodes HTTP sont idempotentes et pourquoi c'est important ?",
    "GET, HEAD, OPTIONS, TRACE, PUT et DELETE sont idempotentes : N appels = même effet que 1 (le PUT réécrit l'état, le DELETE supprime — rejouer ne double pas). POST ne l'est PAS. L'idempotence rend les REJOUATIONS sûres : réseau instable, retry après timeout, files de messages.",
  ),
  ECRIRE(
    "Comment fonctionne le cache HTTP avec Cache-Control ?",
    "Réponse : Cache-Control: max-age=3600 (fraîche 1 h), public/private, no-store (rien ne reste), no-cache (caché mais revalidé avant usage), must-revalidate (pas de périmé servi hors ligne). Le navigateur puis les proxys respectent la chaîne ; stale-while-revalidate sert le périmé en rafraîchissant en tâche de fond.",
  ),
  ECRIRE(
    "Comment fonctionne la revalidation ETag / If-None-Match / 304 ?",
    "Le serveur pose ETag: \"v7\" (identifiant de version). Le client recaché envoie If-None-Match: \"v7\" ; si inchangé → 304 Not Modified SANS corps (économie totale) ; si changé → 200 avec le nouveau corps + nouvel ETag. Alternative par date : Last-Modified/If-Modified-Since. L'ETag est plus fin (version, pas l'horloge).",
  ),
  ECRIRE(
    "Qu'est-ce que le Vary et pourquoi Vary: Origin avec CORS ?",
    "Vary liste les en-têtes de requête qui CHANGENT la réponse — le cache stocke une entrée par valeur. Vary: Origin est obligatoire quand le serveur renvoie une ACAO différente par origine, sinon un proxy peut servir la réponse de l'origine A à l'origine B (fuite CORS par cache).",
  ),
  ECRIRE(
    "Quelles différences entre HTTP/1.1, HTTP/2 et HTTP/3 ?",
    "1.1 : texte, une requête par connexion (ou pipelining cassé) — head-of-line blocking. 2 : binaire, multiplexé sur une connexion (streams), compression HPACK, serveur push abandonné. 3 : sur QUIC/UDP — pas de blocage TCP, reprise de session, natif chiffré (TLS 1.3 obligatoire). Les deux gèrent le multiplexage ; 3 résout la perte de paquets.",
  ),
  ECRIRE(
    "Que fait l'en-tête Host et pourquoi est-il obligatoire en HTTP/1.1 ?",
    "Host: monsite.fr dit QUEL site v Virtual host de cette IP — l'hébergement mutualisé repose dessus. Sans Host (ou faux), le serveur ne sait pas quelle vHost servir : 400 ou mauvais site. Avec TLS, SNI joue le même rôle pendant la poignée de main.",
  ),
  // ─── CORS ───────────────────────────────────────────────────────────────
  ECRIRE(
    "Comment fonctionne CORS en une synthèse ?",
    "Le navigateur vérifie la POLITIQUE du serveur : une réponse cross-origin n'est lisible que si Access-Control-Allow-Origin couvre l'origine du demandeur. Les requêtes « simples » partent directement ; les autres (méthodes non simples, en-têtes personnalisés, Content-Type JSON) déclenchent d'abord un PREFLIGHT OPTIONS. CORS protège le LECTEUR (votre JS ne peut pas lire une réponse tierce non autorisée) — ça ne sécurise pas le serveur.",
  ),
  ECRIRE(
    "Qu'est-ce qu'une requête « simple » en CORS ?",
    "GET/HEAD/POST avec des en-têtes sûrs (Accept, Accept-Language, Content-Language, Content-Type limité à text/plain, form-urlencoded, multipart/form-data) — celles que le HTML historique pouvait déjà faire (formulaires). Tout ce qui sort de ce périmètre (JSON, Authorization, DELETE, en-tête X-…) = preflight.",
  ),
  ECRIRE(
    "Comment autoriser des cookies dans une requête CORS ?",
    "fetch(url, { credentials: \"include\" }) côté client ; côté serveur : Access-Control-Allow-Credentials: true ET Access-Control-Allow-Origin avec l'origine EXACTE (le wildcard * est interdit avec credentials). Côté cookie : SameSite=None; Secure pour traverser les sites.",
  ),
  ECRIRE(
    "Pourquoi mon fetch échoue avec une erreur CORS alors que la requête est partie ?",
    "La requête PART toujours (on le voit réseau) mais le navigateur BLOQUE LA LECTURE de la réponse : pas d'Access-Control-Allow-Origin, ou pas couvrant. Vérifier : la réponse du serveur (F12 → Network → en-têtes de RÉPONSE), le preflight OPTIONS si présent, et Vary: Origin si plusieurs origines.",
  ),
  // ─── Cookies & authentification ─────────────────────────────────────────
  ECRIRE(
    "Comment rendre un cookie de session robuste ?",
    "Set-Cookie: session=…; HttpOnly (invisible pour JS — anti vol XSS) ; Secure (HTTPS seulement) ; SameSite=Lax ou Strict (anti CSRF) ; Path=/ ; Max-Age court pour une session ; côté serveur : identifiant opaque aléatoire révocable (pas le user id), rotation après login. Pour les iframes tiers : SameSite=None + Secure.",
  ),
  ECRIRE(
    "Session cookie vs JWT : que choisir ?",
    "Session : identifiant opaque en cookie HttpOnly, état côté serveur (révocable instantanément, taille fixe) — le choix par défaut pour un site. JWT : jeton signé porteur des claims (stateless, multi-service) — mais révocabilité difficile (blacklist/expirations courtes), taille, et SI exposé au JS il est volable par XSS. Hybride courant : JWT court côté mémoire, refresh token en cookie HttpOnly.",
  ),
  ECRIRE(
    "Comment valider un JWT ?",
    "Vérifier la SIGNATURE (clé publique/JWKS), l'alg (refuser none), exp/nbf, iss et aud correspondent à votre service. Les claims sont SIGNÉS mais pas CHIFFRÉS : rien de sensible dans le payload. Ne jamais faire confiance à un JWT reçu d'un client sans vérification — un décodeur ne valide rien.",
  ),
  ECRIRE(
    "Comment fonctionne le flux OAuth 2.0 code + PKCE ?",
    "Le client génère un verifier (aléatoire) et envoie son défi (S256) ; l'utilisateur s'authentifie chez le fournisseur ; redirection avec un CODE à usage unique ; le serveur échange code + verifier contre des jetons. PKCE protège l'interception du code (apps publiques/mobiles/SPA). Jamais de client_secret côté navigateur.",
  ),
  ECRIRE(
    "Comment stocker les mots de passe côté serveur ?",
    "Jamais en clair ni en MD5/SHA bruts : hachage LENT et SALÉ spécifique mot de passe — bcrypt, scrypt ou argon2id (coût calibré ~100–300 ms). Le sel unique par utilisateur est stocké avec le haché. Comparaison en temps constant. La force du hachage est le dernier rempart si la base fuit.",
  ),
  ECRIRE(
    "Qu'est-ce que MFA/2FA et pourquoi ne pas se limiter au mot de passe ?",
    "Deuxième facteur indépendant (TOTP, clé FIDO2/WebAuthn, push) : le vol du mot de passe (phishing, fuite) ne suffit plus. WebAuthn/passkeys est le plus fort : challenge cryptographique lié à l'origine, insensible au phishing. TOTP reste bien meilleur que SMS (SIM swap).",
  ),
  // ─── Sécurité web ───────────────────────────────────────────────────────
  ECRIRE(
    "Qu'est-ce que le XSS et comment s'en protéger ?",
    "Injection de JavaScript dans la page d'un utilisateur (vol de cookies, actions à sa place). Trois formes : réfléchi (paramètre d'URL rendu), stocké (commentaire en base rendu à tous), DOM (JS client injecte location.hash dans innerHTML). Défense : échapper par CONTEXTE en sortie, textContent plutôt que innerHTML, valider les URL (pas de javascript:), CSP avec nonce en défense en profondeur.",
  ),
  ECRIRE(
    "Qu'est-ce que le CSRF et comment le prévenir ?",
    "Un site tiers fait le NAVIGATEUR de la victime envoyer une requête authentifiée (le cookie part tout seul). Défenses : SameSite=Lax/Strict sur les cookies (le défaut moderne tue la plupart des CSRF), token CSRF aléatoire lié à la session et vérifié côté serveur sur les mutations, vérifier Origin/Referer. Les GET ne mutent jamais.",
  ),
  ECRIRE(
    "Comment construire une CSP efficace contre le XSS ?",
    "Commencer en rapport : Content-Security-Policy-Report-Only avec report-to. Puis : default-src 'self' ; script-src 'self' 'nonce-…' (aucun inline sauf nonce) ; object-src 'none' ; base-uri 'none' ; frame-ancestors 'self' ; upgrade-insecure-requests. Le nonce par requête remplace unsafe-inline — un inline injecté sans nonce n'exécute pas.",
  ),
  ECRIRE(
    "Quels en-têtes de sécurité envoyer en production ?",
    "Content-Security-Policy (sources), Strict-Transport-Security max-age=63072000; includeSubDomains (HSTS), X-Content-Type-Options: nosniff, X-Frame-Options: DENY (ou frame-ancestors), Referrer-Policy: strict-origin-when-cross-origin, Permissions-Policy minimaliste, cookies Secure+HttpOnly+SameSite. Tester : securityheaders.com, observatoire Mozilla.",
  ),
  ECRIRE(
    "Comment éviter l'injection SQL ?",
    "Requêtes PARAMÉTRÉES partout (prepare/execut avec placeholders) — la donnée ne devient jamais du code ; ORM par défaut ; si SQL dynamique obligatoire : liste blanche des identifiants (noms de table/colonnes non paramétrables). Pas d'échappement fait main, pas de concaténation ; compte applicatif à privilège minimal (pas de DROP).",
  ),
  ECRIRE(
    "Qu'est-ce que SSRF et comment le prévenir ?",
    "Server-Side Request Forgery : l'attaquant fait demander AU SERVEUR une URL interne (169.254.169.254 — métadonnées cloud, localhost, plage privée). Défense : liste blanche de destinations, résoudre le DNS puis re-vérifier l'IP (rebinding), bloquer les plages privées/link-local, pas de URL user-controlled dans les webhooks sans validation, réseau sortant segmenté.",
  ),
  ECRIRE(
    "Qu'est-ce que le clickjacking et l'anti-defense ?",
    "La victime clicke sur votre page rendue INVISIBLE dans une iframe d'un site tiers (overlay). Défenses : CSP frame-ancestors 'self' (moderne), X-Frame-Options: DENY (legacy), et côté JS un framebusting de repli. Les actions destructives demandent une confirmation explicite.",
  ),
  ECRIRE(
    "Qu'est-ce qu'un open redirect et pourquoi le corriger ?",
    "Un paramètre ?next=https://malveillant.fr utilisé sans vérification fait de votre domaine un tremplin de phishing (l'URL de départ est légitime). Défense : liste blanche de chemins RELATIFS (commence par / et pas //), pas d'URL absolue utilisateur, encodage vérifié. Affecte aussi OAuth redirect_uri.",
  ),
  ECRIRE(
    "Comment stocker les secrets d'une application web ?",
    "Jamais dans le code ni le git : variables d'environnement injectées par le déploiement, coffre (secrets manager) avec rotation ; .env hors git (gitignore) ; séparer les secrets serveur (DB, API) des exposés client (NEXT_PUBLIC_ = public). Rotation + périmètre minimal par service ; journal d'accès aux secrets.",
  ),
  ECRIRE(
    "Comment rate-limiter une API correctement ?",
    "Par identité (IP + utilisateur + clé) avec fenêtre glissante ou token bucket ; renvoyer 429 avec Retry-After et des en-têtes X-RateLimit-* ; limiter d'abord les coûteux (auth, envoi courriel, export). Au niveau edge quand possible. Le limiter protège le service, pas contre un attaquant déterminé — voir aussi quotas par compte.",
  ),
  ECRIRE(
    "Pourquoi HTTPS partout et comment le forcer ?",
    "Chiffre le transport (pas d'écoute/modification sur le chemin) + authentifie le serveur (certificat). Forcer : redirection 301 vers https, HSTS max-age long + includeSubDomains (après validation des sous-domaines), cookies Secure. Let's Encrypt rend le coût nul — un site sans HTTPS est un site modifiable par le réseau.",
  ),
  ECRIRE(
    "Qu'est-ce que le path traversal et comment le bloquer ?",
    "../../etc/passwd dans un paramètre de fichier pour sortir du dossier prévu. Défense : ne jamais concaténer un chemin utilisateur ; résoudre puis vérifier que le chemin final reste SOUS la racine (path.resolve + startsWith), liste blanche des fichiers servis, pas de transfert de FS direct depuis une URL.",
  ),
];

function versPaire(u: UniteDevWeb): PaireLangage {
  return { motif: u.motif, reponse: u.reponse, theme: u.theme };
}

const FAMILLES_HTTP_SECURITE = [
  "statuts-http",
  "methodes-http",
  "entetes-http",
  "cache-fraicheur",
  "etag-revalidation",
  "cookies-attrs",
  "cors-cas",
  "auth-schemes",
  "csp-directives",
  "contextes-xss",
  "headers-securite",
  "injection",
] as const;

function genereFamilles(): readonly PaireLangage[] {
  const sorties: PaireLangage[] = [];
  for (const fam of FAMILLES_HTTP_SECURITE) {
    for (const u of unitesFamilleDevWeb(fam, 10_000)) {
      sorties.push(versPaire(u));
    }
  }
  return sorties;
}

export const CORPUS_DEV_WEB_HTTP_SECURITE_GENERE: readonly PaireLangage[] =
  genereFamilles();

export const CORPUS_DEV_WEB_HTTP_SECURITE: readonly PaireLangage[] = [
  ...CORPUS_DEV_WEB_HTTP_SECURITE_ECRIT,
  ...CORPUS_DEV_WEB_HTTP_SECURITE_GENERE,
];

export const TAILLE_CORPUS_DEV_WEB_HTTP_SECURITE =
  CORPUS_DEV_WEB_HTTP_SECURITE.length;
