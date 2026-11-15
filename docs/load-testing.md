# Tests de charge — guide d'exécution k6

> Task 130 (axe « Tests de charge » du rapport d'amélioration). Ce guide
> couvre l'exécution, la lecture et l'interprétation des deux profils de
> charge k6 du dépôt : `scripts/load/k6-smoke.js` et
> `scripts/load/k6-stress.js`. k6 s'exécute **hors Node** (binaire
> autonome) : aucune dépendance npm n'est ajoutée au projet.

## 1. Prérequis

- **k6 ≥ 0.50** installé localement — https://grafana.com/docs/k6/latest/set-up/install-k6/
  - macOS : `brew install k6`
  - Debian/Ubuntu : dépôt officiel `apt install k6` (voir doc ci-dessus)
  - Windows : `choco install k6`
  - Vérification : `k6 version`
- Une cible joignable : la production https://gen3ia.online (par défaut)
  ou un serveur local (`npm run build && npm run start`, puis
  `BASE_URL=http://localhost:3000`).
- **Aucune clé d'API ni compte utilisateur n'est nécessaire** : les deux
  profils ne ciblent que des surfaces publiques.

## 2. Les deux profils

| | Smoke (`k6-smoke.js`) | Stress (`k6-stress.js`) |
|---|---|---|
| Objectif | Détecter une régression évidente en 30 s | Révéler les points de dégradation sous charge |
| Charge | 5 VU pendant 30 s (constant) | 5 → 50 VU en 5 min, plateau 5 min, descente 3 min |
| Endpoints | `/api/health`, `/api/status`, `/login` | `/api/health`, `/api/status` |
| Latence (p95) | < 800 ms | < 2000 ms |
| Échecs (`http_req_failed`) | < 1 % | < 2 % (**arrêt immédiat si franchi** — `abortOnFail`) |
| Risque pour la prod | Négligeable | Réel mais maîtrisé — cf. §7 |
| Durée totale | ~35 s | ~13 min |

Pourquoi les endpoints métier (conversations, agents, facturation) sont
exclus du stress : ils déclenchent des coûts par requête (LLM, R2,
Firestore) et ne sont pas conçus pour absorber du trafic synthétique
massif. Le stress se limite aux deux sondes publiques prévues pour être
interrogées en continu par les moniteurs d'uptime.

## 3. Lancer les tests

```bash
# Smoke contre la production (défaut) — sans risque, à tout moment :
k6 run scripts/load/k6-smoke.js

# Smoke contre un serveur local :
BASE_URL=http://localhost:3000 k6 run scripts/load/k6-smoke.js

# Stress contre la production — LIRE LE §7 AVANT (fenêtre + supervision) :
k6 run scripts/load/k6-stress.js

# Stress contre un serveur local :
BASE_URL=http://localhost:3000 k6 run scripts/load/k6-stress.js
```

Options utiles :

```bash
k6 run --out json=rapport-stress.json scripts/load/k6-stress.js  # export brut
k6 run --vus 10 --duration 1m scripts/load/k6-smoke.js           # override rapide
k6 run --quiet scripts/load/k6-smoke.js                          # sortie minimale
```

`BASE_URL` est la seule variable d'environnement des scripts (lue via
`__ENV`), valeur par défaut `https://gen3ia.online`.

## 4. Lire les résultats

En fin d'exécution, k6 imprime un résumé. Les métriques qui comptent :

| Métrique | Signification | Ce qu'on en fait |
|---|---|---|
| `http_req_duration` | Latence totale de chaque requête | La p95/p99 est le contrat de performance ; comparer au seuil du profil |
| `http_req_failed` | Taux de requêtes échouées (erreurs réseau + réponses 4xx/5xx) | Doit rester sous le seuil ; toute valeur > 0 se investigue (logs Vercel) |
| `checks` | Taux de réussite des vérifications (statut 200, JSON valide…) | Un check rouge alors que le statut est 200 = réponse dégradée (ex. corps HTML au lieu du JSON attendu) |
| `http_reqs` | Nombre total de requêtes émises | Le débit réel observé (req/s) — utile pour dimensionner les quotas |
| `iterations` | Nombre de boucles complètes jouées | Sanity check du volume de test |
| `vus_max` | Pic d'utilisateurs virtuels atteint | Doit correspondre au scénario (5 en smoke, 50 en stress) |
| `http_req_connecting` / `http_req_tls_handshaking` | Temps de connexion / poignée de main TLS | Si élevés : problème réseau ou CDN, pas applicatif |

En stress, observer la **forme** de la latence dans le temps (k6 Cloud,
Grafana, ou l'export JSON) plus que la moyenne : le plateau doit rester
stable ; une latence qui croît pendant tout le plateau signale une fuite
ou une saturation progressive.

## 5. Interpréter les thresholds

- **Smoke — `p(95)<800ms` franchi** : la prod (ou le local) est lente sur
  une surface légère → vérifier `/api/status` (services dégradés ?), les
  déploiements récents, le réseau. Bloquant avant tout gros déploiement.
- **Smoke — `rate<0.01` franchi** : au moins 1 % de requêtes en erreur
  (souvent `/api/status` en 503 = un service dégradé) → incident à ouvrir
  immédiatement, ce n'est pas un problème de charge.
- **Stress — `p(95)<2000ms` franchi** : la plateforme sature avant 50 VU
  simultanés. Noter le VU/le débit au moment du coude : c'est la **capacité
  réelle** actuelle. Décision : optimiser, dimensionner (plan Vercel,
  cache), ou documenter la limite.
- **Stress — `rate<0.02` franchi** : le test **s'est arrêté seul**
  (`abortOnFail`) — la cible échouait sous charge. Consulter les logs
  Vercel de la fenêtre du test avant toute relance ; une relance immédiate
  sans diagnostic reviendrait à insister sur un service à terre.

Un threshold franchi fait sortir k6 avec un code non nul : les profils
sont intégrables tels quels dans un futur job CI (rodage manuel d'abord —
même doctrine que le scan ZAP de `.github/workflows/security.yml`).

## 6. Quand relancer

- **Smoke** : avant chaque gros déploiement (nouvelle route publique,
  refonte du middleware/CSP, montée de version Next.js), et après chaque
  incident de latence rapporté — ~35 s, aucun prérequis.
- **Stress** : au minimum **une fois par semaine** (rendez-vous de
  l'équipe ops), et impérativement avant tout changement d'architecture
  qui touche le trafic entrant (middleware, CSP, cache CDN, plan
  Vercel, passage à un autre runtime).
- **Après chaque montée de capacité** : rebâtir la courbe de référence
  (VU → latence/débit) pour garder un historique comparable.

## 7. Cadre éthique — à lire avant tout stress

1. **Ne tester QUE gen3ia.online** (ou localhost). La plateforme est
   notre propriété ; tout autre service tiers est hors sujet — pointer
   k6 vers un domaine qui ne nous appartient pas est un délit, pas un
   test.
2. **Le stress n'est pas un outil d'attaque** : la montée est progressive
   et bornée, et `abortOnFail` coupe le test dès que la cible échoue.
   Ne jamais élever `--vus`/`--duration` au-delà du scénario versionné
   sans revue (le scénario du dépôt fait foi).
3. **Respecter les quotas** : les 50 VU du plateau génèrent de l'ordre de
   quelques centaines de requêtes/seconde sur deux sondes légères —
   dans les limites du plan Vercel, mais à connaître (invocations de
   fonctions, bande passante). Les routes payantes (LLM, R2, Firebase)
   sont volontairement exclues des profils.
4. **Fenêtre communiquée** : lancer le stress de préférence en heure
   creuse (ex. dimanche matin) et prévenir l'équipe ; garder un œil sur
   `/api/status` pendant l'exécution — s'il passe en `degraded`, arrêter
   (`Ctrl+C`).
5. **Les rapports de tests de charge non autorisés** sont explicitement
   exclus du programme de divulgation responsable — voir
   `docs/securite/bug-bounty.md` § Exclusions.
