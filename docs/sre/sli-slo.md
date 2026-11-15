# SLI / SLO — Fiabilité Gen3ia (VPS solo)

> Contrat de fiabilité de la plateforme (<https://gen3ia.online>).
> Contexte d'exécution : VPS 2 Go RAM (AlmaLinux), PM2 (process `gen3ia`,
> port 3000), nginx devant l'application, déploiement automatisé
> (`.github/workflows/deploy-vps.yml` → `infra/deploy/cd-finisher.sh`, swap
> atomique `.next` + health check + rollback). Le Docker (`infra/Dockerfile`,
> `infra/docker-compose.yml`) est une préparation de portabilité (Phase 2/3),
> PAS le runtime actuel.
>
> Compléments : runbooks `docs/runbooks/deployment.md` et
> `docs/runbooks/incident-response.md` (réaction), modèle de retour
> d'expérience `docs/sre/postmortem-modele.md` (analyse a posteriori).

---

## 1. Sources de mesure

| Source | Contenu | Périmètre | Limites |
|---|---|---|---|
| `/api/metrics` (format texte Prometheus, préfixe `gen3ia_`) | Compteurs HTTP par classe de route × famille de statut, latence moyenne glissante (fenêtre 500), uptime process, RSS / tas V8 | In-process, alimenté par le hook du middleware | Compteurs remis à zéro à chaque redémarrage PM2 ; statuts observés = réponses du middleware (200/307/403) |
| `/api/health` | Heartbeat public sans dépendance (HTTP 200 + timestamp) | Disponibilité du process | Ne vérifie pas les dépendances (c'est le rôle de `/api/status`) |
| `/api/status` | Santé détaillée (auth, r2, ticks), 503 si dégradée | Dépendances | Non utilisé pour les SLO ci-dessous (indicateur de diagnostic) |
| Logs d'accès **nginx** | Chaque requête réelle : statut final, latence de bout en bout | Source de vérité externe au process | À agréger par script (grep/awk) — aucune rétention longue par défaut |
| `/version.json` + `/api/deploy-info` | Empreinte du déploiement (BUILD_ID, sha git) | Fraîcheur de déploiement | — |

Les deux premières sources sont des **compteurs process** : ils décrivent le
process courant. Les SLO mensuels s'évaluent en composant ces mesures avec
les logs nginx (source externe qui survit aux redémarrages).

---

## 2. Indicateurs de niveau de service (SLI)

| # | SLI | Formule (source) | Fenêtre |
|---|---|---|---|
| 1 | **Disponibilité HTTP** | (2xx + 3xx) / total des requêtes — `gen3ia_http_requests_total` ou logs nginx | mensuelle |
| 2 | **Latence chat** | P95 des requêtes chat (page `/chat` + API `/api/agent/chat`) — proxy actuel : moyenne glissante `gen3ia_http_request_duration_ms{route="chat"}` ; P95 exact : logs nginx | mensuelle |
| 3 | **Taux d'erreur serveur (5xx)** | 5xx / total — logs nginx (source principale : les 5xx naissent dans les routes, en aval du middleware) ; `gen3ia_http_requests_total{status="5xx"}` en complément | mensuelle |
| 4 | **Fraîcheur de déploiement** | Écart entre le merge sur `main` (run CD vert) et la confirmation prod : `/version.json` (sha git) + `gen3ia_uptime_seconds` (redémarrage process constaté) | par déploiement |

Classes de route (cardinalité bornée, jamais le chemin brut) :
`chat` = page `/chat` + `/api/agent/chat*` · `api` = autres API ·
`pages` = pages HTML · `static` = fichiers publics (hors `_next/static`,
non traversés par le middleware).

---

## 3. Objectifs de niveau de service (SLO)

Calibrés pour un **VPS solo 2 Go** (un seul process, maintenance sur la
machine comprise) — pas des objectifs de cloud multi-AZ :

| # | SLO | Cible | Budget d'erreur mensuel |
|---|---|---|---|
| 1 | Disponibilité HTTP | **≥ 99,5 % / mois** | ≤ 3,65 h d'indisponibilité (0,5 % de 30 j) |
| 2 | Latence P95 chat | **< 3 s** | 1,5 % des requêtes chat peuvent dépasser (marge de moitié) |
| 3 | Taux de 5xx | **< 0,5 % / mois** | ≤ 0,5 % des requêtes |
| 4 | Fraîcheur de déploiement | Déploiement confirmé en prod **< 24 h** après merge | 1 déploiement « en retard » toléré / mois |

Justifications :
- **99,5 %** (et non 99,9 %) : un solo-VPS assume reboot kernel, montées de
  version et fenêtres de maintenance — 3,65 h/mois est tenu sans artifice ;
- **P95 < 3 s chat** : la génération en streaming rend le TTFB court, mais le
  VPS 2 Go plafonne la concurrence ; 3 s au 95e percentile est ambitieux
  mais réaliste ;
- **5xx < 0,5 %** : aligné sur la cible d'alerte interne (voir §5) — au-delà,
  l'incident-response s'ouvre.

---

## 4. Politique d'error budget

Le budget d'erreur = 1 − SLO. Il se **consomme**, il ne se renégocie pas en
cours de mois.

**Calcul (relevé mensuel)** — depuis `/api/metrics` (fenêtre = depuis le
dernier redémarrage process) :

```bash
curl -s http://127.0.0.1:3000/api/metrics | grep '^gen3ia_http_requests_total'
# dispo % = (Σ 2xx + Σ 3xx) / (Σ toutes les séries) × 100
# taux 5xx % = Σ 5xx / (Σ toutes les séries) × 100
```

Pour une fenêtre mensuelle fiable (indépendante des redémarrages PM2),
agréger les logs nginx (`/var/log/nginx/access.log`) ou créer un cron qui
**exporte** les compteurs chaque nuit vers un fichier horodaté (textfile
collector `node_exporter`, ou simple JSON dans `/opt/gen3ia/var/sli/`) —
voir §7 (suite).

**Règles de gouvernance :**

| Budget consommé | Décision |
|---|---|
| < 50 % | Rythme normal : features + fiabilité |
| **≥ 50 %** | **Gel des nouvelles features** : toutes les nouveautés planifiées passent derrière les correctifs de fiabilité (dettes techniques, latence, erreurs, capacité) jusqu'à retour sous le seuil |
| ≥ 100 % | Fiabilité exclusive + postmortem **obligatoire** (modèle `docs/sre/postmortem-modele.md`) sur la ou les causes de consommation ; gel maintenu jusqu'à deux semaines consécutives dans le budget |

Chaque dépassement de seuil est tracé dans le rapport mensuel (une ligne :
période, SLI, valeur, budget consommé, décision).

---

## 5. Alertes minimales (seuils de déclenchement)

Plancher opérationnel — moniteur d'uptime externe + cron local sur le VPS.
Toute alerte P1/P2 suit `docs/runbooks/incident-response.md`.

| Signal | Seuil | Priorité | Première action |
|---|---|---|---|
| Health check `/api/health` | **2 échecs consécutifs** (30 s d'intervalle) | P1 | Vérifier `pm2 status` / logs PM2 ; si le CD vient de déployer, laisser le rollback automatique agir |
| Mémoire RSS process | `gen3ia_memory_rss_bytes > 1,5 Go` (75 % du VPS) | P2 | Capter une heap snapshot, chercher la fuite, prévoir un `pm2 restart gen3ia` en heure creuse |
| Disque VPS | occupation **> 85 %** | P2 | Purger logs/journaux PM2, `.next.old`, artefacts `var/` ; sinon étendre le volume |
| Taux 5xx | > 1 % sur 5 min (logs nginx) | P2 | Sentry → route fautive ; rollback CD si post-déploiement |
| Latence chat | moyenne glissante `route="chat"` > 5 s pendant 15 min | P3 | Charge ? Qdrant/Firestore lent ? Monter la priorité si elle s'étend |
| Process redémarré | `gen3ia_uptime_seconds < 120` sans déploiement prévu | P3 | Crash/OOM kill suspect — corréler avec dmesg + logs PM2 |

---

## 6. Relevé pratique (VPS actuel)

```bash
# Métriques complètes (local au VPS — ne pas exposer publiquement) :
curl -s http://127.0.0.1:3000/api/metrics

# Avec jeton (METRICS_TOKEN défini) :
curl -s -H "Authorization: Bearer $METRICS_TOKEN" http://127.0.0.1:3000/api/metrics

# Disponibilité et 5xx depuis les compteurs process :
curl -s http://127.0.0.1:3000/api/metrics | awk '
  /^gen3ia_http_requests_total/ {
    match($0, /status="[0-9]xx"/); s = substr($0, RSTART+8, 3);
    total += $NF; if (s ~ /^[23]xx/) ok += $NF; if (s == "5xx") err += $NF;
  }
  END { printf "dispo=%.3f%% 5xx=%.3f%% total=%d\n", 100*ok/total, 100*err/total, total }'

# P95 réel (logs nginx — latence de bout en bout en secondes, champ $request_time) :
awk '$7 ~ /^\/chat/ {print $NF}' /var/log/nginx/access.log | sort -n | awk '{a[NR]=$1} END {print a[int(NR*0.95)]}'
```

Sécurité de l'endpoint : données 100 % numériques (aucun path utilisateur,
aucun identifiant). Recommandation production : définir `METRICS_TOKEN`
(`openssl rand -hex 32`, voir `.env.example`) et restreindre le scraping à
`127.0.0.1` — nginx ne doit pas exposer `/api/metrics` depuis l'extérieur.

---

## 7. Limites connues et suite

1. **Statuts observés côté middleware** : le hook mesure la réponse du
   middleware (200 continuation / 307 / 403). Les 5xx réels naissent dans
   les routes (aval) → le taux 5xx fait foi côté **logs nginx** ; l'étape
   naturelle est un hook `onRequestError` (instrumentation) pour compter
   les erreurs de routes dans `gen3ia_http_requests_total{status="5xx"}`.
2. **Moyenne glissante ≠ P95** : `gen3ia_http_request_duration_ms` est une
   moyenne sur les 500 dernières requêtes (mémoire constante, VPS 2 Go).
   Un histogramme Prometheus (buckets cumulés) donnerait le P95 natif —
   Phase 3 (GKE + Prometheus).
3. **Compteurs volatils** : à chaque `pm2 restart` (déploiement, crash),
   le registre repart de zéro. L'uptime `gen3ia_uptime_seconds` sert
   justement à repérer ces remises à zéro. L'export périodique (§4)
   rend les fenêtres mensuelles exactes.
4. **`_next/static` non compté** : le middleware ne traverse pas les assets
   statiques internes de Next — la classe `static` couvre les autres
   fichiers publics. Sans impact sur les SLO (axés chat/api/pages).
5. **Suite (Phase 2/3)** : scraper Prometheus + alertmanager (règles du §5
   en `alert:`), dashboards Grafana, puis instrumentation P95 native quand
   l'application passera sous orchestrateur (GKE).
