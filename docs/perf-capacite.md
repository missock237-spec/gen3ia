# Plan de capacité & performance — Gen3ia (honnête)

> Task 9-a (PERF). Ce document dit ce qui EST, ce qui a été implémenté, et
> ce qu'il faudrait pour monter en débit — avec des ordres de grandeur
> réalistes et vérifiables. Il ne survent JAMAIS : chaque affirmation est
> assortie de son périmètre et de sa limite. Compléments : `docs/sre/sli-slo.md`
> (SLI/SLO production), `docs/load-testing.md` (k6), `docs/deploiement-k8s.md`
> (portabilité future).

---

## 1. Verdict préalable : « 10 milliards de requêtes par seconde » est physiquement impossible pour gen3

**10¹⁰ req/s sur un seul service web n'est pas un objectif atteignable — pour
personne.** Ce n'est pas une question d'optimisation, c'est de la physique et
de l'arithmétique :

| Référence | Ordre de grandeur (req/s) | Source / calcul |
|---|---|---|
| Une instance Node.js (JSON simple, cache mémoire) | ~10⁴–10⁵ | 1 thread utile × boucle d'événements ; au-delà, CPU saturé |
| **gen3 aujourd'hui** (VPS 2 Go, 1 process PM2, middleware Node + Firestore) | ~10¹–10³ selon la route | dynamique Firestore ~10¹–10² ; cache mémoire ~10²–10³ ; sondes publiques ~10³ |
| nginx sur un VPS (fichiers statiques) | ~10⁴–10⁵ | limité par le disque/le réseau de la machine |
| Un grand CDN mondial (Cloudflare — le plus gros réseau HTTP public) | ~10⁸–2×10⁸ | record public d'absorption d'attaque ≈ 2×10⁸ req/s (201 M rps, 2023), sur 300+ villes |
| **Objectif cité** | **10¹⁰** | ≈ 50× le record mondial du plus grand réseau CDN de la planète |

Pour servir 10¹⁰ req/s à ~1 Ko par requête (hors réponses), il faut déjà
~10 Tb/s de trafic entrant soutenu — soit plusieurs fois la capacité
combinée des plus grands opérateurs mondiaux. Aucune « optimisation logicielle »
n'y change rien : cela exige un système distribué planétaire (des centaines de
POP CDN, du cache agressif à la périphérie, du sharding mondial). Même les
géants n'atteignent ces chiffres que sur des surfaces cacheables ultra-simples
(résolution DNS, assets immuables), pas sur des API métier authentifiées.

**Ce que gen3 fait à la place (et ce que ce document couvre)** : construire
chaque étage du chemin d'échelle réellement utile — réduire le coût unitaire
d'une requête, absorber les rafales, cacher ce qui est cacheable, et documenter
combien chaque étage peut porter. Tout chiffre de débit annoncé ailleurs sans
périmètre serait mensonger.

---

## 2. État actuel (avant la Task 9-a)

Infrastructure (source `docs/sre/sli-slo.md`) : **un VPS 2 Go RAM**, un seul
process Node (`pm2 gen3ia`, port 3000), nginx devant, Next.js 15 App Router
(middleware en runtime Node), Firestore (base), R2 (objets), LLM distants
(chat, agents). Déploiement continu avec swap atomique `.next`.

Ce qui existait déjà :
- Registre SLI in-process (compteurs par **classe** de route chat/api/pages/static,
  latence moyenne glissante) exposé en Prometheus via `/api/metrics` ;
- Tests de charge k6 (`scripts/load/k6-smoke.js`, `k6-stress.js`) ;
- Cache process-local générique (`lib/cache/redis.ts`, cache-aside sans
  single-flight) et un cache à trois étages propre à la route intégrations.

Limites connues de ce socle : aucun coalescing générique (N requêtes
identiques simultanées = N calculs), aucune granularité p50/p95 par route,
pas d'en-tête de cache partagé (s-maxage) pour la couche CDN, et des appels
sortants ouverts sans réutilisation de connexion.

---

## 3. Implémenté aujourd'hui (Task 9-a)

| Module | Contenu | Limite honnête |
|---|---|---|
| `lib/perf/cache-reponses.ts` | Cache LRU + TTL **borné** (1 000 entrées / ~25 Mo par défaut) + **single-flight** : N requêtes identiques simultanées → 1 calcul. Stats exactes (`hits`, `misses`, `coalesced`, `erreurs`) et `latenceGagneeMs` **estimée** (somme des durées de calcul initial évitées — un minorant). Clés namespacées obligatoires (`cleCache("espace", "v1", …)`). | Process-local : chaque instance Node a SON cache (en serverless/multi-instance, le taux de hit se divise par le nombre d'instances chaudes). Ne JAMAIS cacher une réponse personnalisée ou privée sans l'uid dans la clé. |
| `lib/perf/pool.ts` | Agent HTTP **keep-alive** undici (pool par origine, 64 connexions max, timeouts propres : en-têtes 10 s, corps 30 s, AbortSignal par requête 10 s par défaut). Repli automatique sur le fetch global si undici est indisponible. Branché sur le fetch des certificats publics Google (`lib/firebase/auth-server.ts`) — origine unique, appels périodiques, gain = handshake TCP/TLS économisé à chaque vérification de jeton. | Runtime Node uniquement. Le gain dépend de la récurrence vers une même origine : un appel unique ne gagne rien. |
| `lib/perf/compteur.ts` | Compteurs de requêtes + latence **par route normalisée** (segments identifiants repliés en `:id`), **p50/p95** par rang le plus proche, ring buffer 500 par route, cardinalité plafonnée à 256 routes (au-delà → série `autre`). | Alimenté par le middleware : mesure le traitement **middleware** et le statut de SA réponse — PAS la latence complète des route handlers (Firestore, LLM…). Source complémentaire : logs nginx + `/api/metrics`. |
| `app/api/perf/metrics/route.ts` | Exposition JSON **admin-only** (`requireAdmin`, même garde que les autres routes admin) : routes p50/p95, stats du cache, état du pool. `no-store`. | Décrit UNE instance. Une agrégation multi-instance demande un collecteur externe (hors périmètre). |
| Hot paths cachés | 1. **`GET /api/training/catalog`** (TTL 60 s) : catalogue moteurs/modèles/quotas — global, **aucune donnée personnelle** ; seul `requestId` reste par-requête. 2. **`GET /api/neural/public-stats`** (TTL 10 s) : vitrine publique 100 % anonyme (compteurs structurels du moteur + état d'auto-apprentissage plateforme). Sur les deux : single-flight → les rafales de visiteurs concurrents partagent UNE construction. | Choix de sûreté documenté dans chaque route : réponse identique pour tous les appelants, aucune donnée privée, aucune réponse IA. Les routes IA personnalisées, les conversations et les données utilisateur ne sont PAS cachées — et ne doivent pas l'être sans clé utilisateur explicite. |
| En-têtes de cache statiques | Middleware : `s-maxage` ajouté sur la liste bornée des assets publics DÉJÀ cacheables (icônes, splash `/images/`, og-image, SDK, llms.txt, manifeste) — max-age navigateur inchangé. `next.config.ts` : `/_next/static` déclarée explicitement `public, max-age=31536000, immutable` (valeur identique à celle que Next émet déjà — idempotent). | `/_next/static` reste volontairement hors du matcher du middleware (ne pas faire transiter chaque asset par le middleware Node) — c'est pourquoi l'immuable y est déclaré dans `next.config.ts`, pas dans le middleware. Un CDN devant l'app est néCESSAIRE pour que `s-maxage` serve à quelque chose aujourd'hui (nginx seul l'ignore sans `proxy_cache`). |

Tests de garde (vitest) : `lib/perf/cache-reponses.test.ts` (hit/miss, TTL,
single-flight N=50 → 1 calcul, éviction LRU, namespaces), `lib/perf/compteur.test.ts`
(p50/p95, familles de statut, normalisation, plafond), `lib/perf/pool.test.ts`
(pool actif + timeout propre), `lib/perf/rendement-cache.test.ts`
(banc de vitesse : gain cache > 5×).

---

## 4. Goulots d'étranglement réels (dans l'ordre d'impact)

1. **Appels LLM** : 1–60 s de latence, coût direct par requête. C'est le
   plafond STRUCTUREL du débit « utile » de gen3 : la valeur du produit est
   générée par des appels qui ne se cachent presque jamais (chaque réponse
   est personnelle). Aucune infra ne rend un LLM plus rapide qu'il n'est.
2. **Firestore** : lectures/écritures par opération, quota par projet. Les
   hot paths cachés aujourd'hui (catalogue, stats) n'y touchent plus par
   requête ; les routes métier restent à ~10¹–10² req/s utiles par instance.
3. **Process unique** : un seul process Node = 1 seul cœur utile pour le
   JS ; au-delà de ~10³ req/s de trafic dynamique, la latence P95 monte.
4. **Cold start / redémarrage** : PM2 reload = caches process vidés
   (réchauffement nécessaire), démarrage Firestore quelques centaines de ms.
5. **Rafales sur les sondes** : `/api/health`, `/api/status`, vitrine publique
   sont sondées par des moniteurs — d'où le single-flight sur les surfaces
   publiques cachées.

---

## 5. Ordres de grandeur réalistes par étage

| Étage | Ce qui peut y être servi | Débit réaliste | Statut gen3 |
|---|---|---|---|
| Navigateur (Cache-Control) | assets immuables `/_next/static`, icônes, SDK, splash | Illimité côté serveur (0 requête reçue) | ✅ en place |
| CDN / edge (`s-maxage` posé aujourd'hui) | assets publics, surfaces GET globales si on les y autorise | 10⁵–10⁷ req/s par réseau CDN mondial pour les surfaces cacheables | 🟠 en-têtes en place ; CDN devant le domaine : à faire |
| Cache mémoire process (LRU+TTL+single-flight) | réponses globales idempotentes | ~10²–10³ req/s par instance (borné par le middleware Node) | ✅ fait (2 hot paths) |
| Cache partagé (Redis) | cohérence multi-instance des mêmes réponses | déceuvre le gain par instance ; utile dès N>1 instances | ⬜ étape d'échelle |
| Node dynamique authentifié (Firestore) | API métier par utilisateur | ~10¹–10² req/s par instance | État actuel |
| Node horizontal (N instances + LB) | tout ce qui est stateless (sessions cookie/jeton → oui) | ~N × le débit ci-dessus, linéaire jusqu'au DB | ⬜ étape d'échelle |
| Files d'attente (rendu, entraînement, ticks) | travaux lourds asynchrones | déborde la latence hors du chemin requête-réponse | 🟠 partiel (render queue, tick queue) |
| Sharding / réplicas de données | lectures multi-tenant massives | multiplie le plafond base de données | ⬜ étape d'échelle |

Lecture honnête du tableau : **même avec CDN + 10 instances + Redis, gen3
atteint des milliers — pas des milliards — de req/s sur ses routes dynamiques**.
Les surfaces cacheables (assets, catalogues, sondes) peuvent, elles, monter à
des centaines de milliers de req/s dès qu'un CDN est devant — car elles ne
remontent plus jusqu'à Node du tout.

---

## 6. Chemin d'échelle recommandé (par ordre de rendement)

1. **Réduire le coût unitaire** (fait) : cache LRU+single-flight sur les hot
   paths globaux, keep-alive sortant, en-têtes immuables.
2. **Mettre un CDN devant le domaine** (prochaine étape la plus rentable) :
   Cloudflare/Vercel devant nginx honore `s-maxage` — les assets publics et
   les GET globaux quittent le chemin Node. Ordre de grandeur : les surfaces
   cacheables passent de ~10²–10³ à 10⁵+ req/s (servies au bord).
3. **Horizontal scaling stateless** : PM2 cluster / 2ᵉ VPS + répartiteur.
   L'app est déjà stateless-friendly (sessions cookie + Firestore) — les
   caches process devront être complétés par Redis pour garder un taux de
   hit cohérent.
4. **Files d'attente pour tout ce qui est lourd** (rendu vidéo, entraînement,
   ingestions) : déjà amorcé (`lib/queue/`, render queue) — généraliser pour
   que JAMAIS une requête HTTP n'attende un travail long.
5. **Base de données** : réplicas de lecture Firestore, agrégats pré-calculés
   (déjà amorcé avec `usageDaily`), puis sharding par tenant si vraiment
   nécessaire.
6. **Multi-région** uniquement si le trafic le justifie : coût opérationnel
   élevé, gain plafonné par la base de données.

---

## 7. Comment vérifier (mesures, pas promesses)

- `GET /api/perf/metrics` (admin) : p50/p95 par route, stats cache
  (hits/misses/coalesced/latence gagnée estimée), pool keep-alive actif.
- `GET /api/metrics` (Prometheus, garde locale/token) : compteurs par classe,
  latence glissante, mémoire.
- `docs/load-testing.md` : profils k6 smoke/stress — le **coude de charge**
  observé sous stress est la capacité réelle du moment ; c'est la seule
  source de vérité sur le débit, jamais une estimation sur papier.

---

## 8. Engagement d'honnêteté

- Aucun chiffre de débit n'est affirmé dans le code : les commentaires
  décrivent des mécanismes (coalescing, keep-alive, bornes) et des ordres de
  grandeur, jamais des capacités garanties.
- `latenceGagneeMs` du cache est présentée comme une ESTIMATION (minorant)
  dans le code, l'API et ce document.
- Le périmètre de mesure du compteur par route (côté middleware) est rappelé
  dans la route d'exposition et ici.
- **« gen3 traite 10 Md req/s » est faux et restera non écrit nulle part.**
  L'objectif réaliste de cette infrastructure est : chaque requête coûte moins
  cher, les rafales ne multiplient pas les calculs, les surfaces cacheables
  sont prêtes pour un CDN, et le chemin d'échelle est documenté étage par
  étage.
