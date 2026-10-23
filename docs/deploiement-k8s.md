# Déploiement Kubernetes (GKE) — guide préparatoire Phase 3

> **STATUT : PRÉPARATOIRE.** Rien n'est déployé sur Kubernetes aujourd'hui.
> La production actuelle est le **VPS 2 Go (AlmaLinux) + PM2 + nginx**,
> livrée par `.github/workflows/deploy-vps.yml` (swap atomique
> `deploy/cd-finisher.sh`). Ce document et l'arborescence `k8s/` préparent
> la **Phase 3 — migration GCP**, qui NE DÉMARRE PAS sans déclencheur.

## 1. Pourquoi ce travail est préparatoire

La feuille de route (`docs/feuille-de-route-google-grade.md` §6) fixe
**trois déclencheurs de migration** — un seul suffit, tous mesurés :

| Déclencheur | Seuil |
|---|---|
| **Charge / capacité** | RAM VPS > 80 % sur 7 jours glissants, p95 du smoke > 3 000 ms répété, files PM2 qui s'allongent |
| **Coût** | Le coût total (ingénierie perdue en incidents de capacité inclus) dépasse durablement l'écart de facturation GCP |
| **Équipe** | Effectif > 1 humain : staging permanent, revues multi-humains, IAP |

Tant qu'aucun ne s'allume, le VPS 2 Go reste le runtime officiel et ces
manifestes dorment — c'est voulu : les avoir prêts (et validés
statiquement) transforme une migration en bascule, pas en projet de six
semaines improvisé sous pression.

## 2. Pourquoi kustomize (et PAS Helm)

**Kustomize** a été choisi car il est **sans dépendance** : YAML statiques
versionnés, lisibles en revue, aucun binaire ni chart à maintenir, patchs
par environnement (`overlays/prod`, `overlays/staging`). `kubectl apply -k`
suffit à tout déployer.

**Note Helm** : si l'équipe dépasse 1 personne (déclencheur « Équipe » §6)
et que la duplication de manifests devient un coût réel, migrer vers un
**Chart Helm** — la structure `base/` + `overlays/` se transpose
directement (chart + `values-{prod,staging}.yaml`). Migration mécanique,
à ne lancer qu'à ce moment-là.

## 3. Prérequis (le jour de la migration)

- **GKE Autopilot recommandé** (Google-grade par défaut) : control-plane
  managé, nœuds dimensionnés automatiquement à partir des `requests` des
  pods, sécurité de base renforcée (interdiction des conteneurs privilégiés,
  Workload Identity disponible). Un cluster Standard à nœuds partagés serait
  moins cher sur le papier mais ramènerait la charge opérationnelle des
  nœuds qu'on vient de fuir. Cloud Run est l'alternative honnête si la
  charge reste modeste (feuille de route §6) — les images de la Task G
  fonctionnent telles quelles.
- **gcloud** configuré (`gcloud container clusters get-credentials …`).
- **Registre d'images** : ghcr.io (image Task G) ou **Artifact Registry**
  (recommandé en GCP : latence de pull régionale, Workload Identity sans
  secret d'accès).
- **ingress-nginx** installé (`kubectl apply -f` du manifeste officiel
  stable ou Helm du controller) — honore `ingressClassName: nginx`.
- **cert-manager** installé + deux ClusterIssuers :
  `letsencrypt-prod` et `letsencrypt-staging` (HTTP-01, l'Ingress est
  routé publiquement).
- **metrics-server** : préinstallé sur GKE (requis par l'HPA).
- DNS : `gen3ia.online` et `www` → IP de l'ingress (service
  `ingress-nginx-controller`), `staging.gen3ia.online` → même IP (staging).

## 4. Étapes de déploiement pas à pas

```bash
# 0) Validation statique (aucun cluster requis) — doit passer d'abord
bash scripts/k8s/valider-manifestes.sh

# 1) Build + push de l'image (le build Next.js réclame > 3,5 Go — cf.
#    deploy-vps.yml : il vit sur le runner/ligne de commande locale, jamais
#    sur le VPS ni sur les nœuds)
docker build -t ghcr.io/missock237-spec/gen3ia:v1.0.0-k8s .
docker push ghcr.io/missock237-spec/gen3ia:v1.0.0-k8s

# 2) Secrets + ConfigMap (cf. §5 — PAS les NEXT_PUBLIC_*)
kubectl create secret generic gen3ia-app-secrets \
  --namespace gen3ia --from-env-file=/tmp/runtime.env
kubectl create configmap gen3ia-app-config \
  --namespace gen3ia \
  --from-literal=LOG_LEVEL=info \
  --from-literal=OTEL_EXPORTER_OTLP_ENDPOINT=

# 3) Épingler le tag d'image dans l'overlay prod
cd k8s/overlays/prod
kustomize edit set image \
  ghcr.io/missock237-spec/gen3ia=ghcr.io/missock237-spec/gen3ia:v1.0.0-k8s
cd ../..
# (sans binaire kustomize : éditer newTag de k8s/overlays/prod/kustomization.yaml)

# 4) Application — déploie namespace, qdrant, app, ingress, hpa, pdb
kubectl apply -k k8s/overlays/prod

# 5) Vérifications
kubectl -n gen3ia get pods -w                      # gen3ia-app-x2 + gen3ia-qdrant-0 Ready
kubectl -n gen3ia rollout status deployment/gen3ia-app
kubectl -n gen3ia get ingress gen3ia-ingress       # attendre l'adresse
kubectl -n gen3ia describe certificate gen3ia-tls  # cert-manager : Ready=True
```

Vérification applicative (une fois le DNS propagé) :

```bash
curl -fsS https://gen3ia.online/api/health        # {"status":"ok",…} — sonde légère
curl -fsS https://gen3ia.online/version.json      # = BUILD_ID de l'image poussée
curl -fsS https://gen3ia.online/api/status        # version + services (auth, r2, ticks)
# ⚠️ /api/health/infra est PROTÉGÉ (détails infra) : jamais utilisé pour les
# probes publiques — cf. app/api/health (heartbeat) vs app/api/health/infra.
```

Le Deployment applique `maxUnavailable: 0 / maxSurge: 1` : le rollout est
l'équivalent conteneur du swap atomique VPS (jamais moins de 2 pods en
service). Un `kubectl rollout undo deployment/gen3ia-app -n gen3ia`
rejoue l'image précédente = le rollback `.next.old`.

## 5. Secrets — règles non négociables

- **Les `NEXT_PUBLIC_*` n'existent PAS dans le Secret** : elles sont
  **inlinées dans le bundle JS au build** (config Firebase client, URL app…).
  Les changer runtime n'a AUCUN effet — c'est la même contrainte que le CD
  actuel qui restaure `DOTENV_PRODUCTION` **avant** `npm run build`
  (cf. en-tête de `deploy-vps.yml`). **Un changement de `NEXT_PUBLIC_*` = un
  rebuild + push d'image**, point final.
- Le Secret `gen3ia-app-secrets` ne contient que les variables **runtime**
  (Firebase Admin, R2, Qdrant, tokens…) :

  ```bash
  grep -vE '^(NEXT_PUBLIC_|#|$)' .env.production > /tmp/runtime.env
  # contrôle : aucune ligne NEXT_PUBLIC_ ne doit rester
  grep -c '^NEXT_PUBLIC_' /tmp/runtime.env || echo "OK — 0 NEXT_PUBLIC_"
  kubectl create secret generic gen3ia-app-secrets -n gen3ia --from-env-file=/tmp/runtime.env
  ```

- Rotation : recréer le Secret puis
  `kubectl -n gen3ia rollout restart deployment/gen3ia-app`
  (`envFrom` ne recharge pas à chaud).
- Phase 3 aboutie : migrer vers **Secret Manager + Workload Identity**
  (feuille de route §6) et geler les secrets k8s comme source secondaire.

## 6. Migration des données Qdrant (snapshot)

Le StatefulSet `gen3ia-qdrant` démarre **vide** (PVC 10 Gi). Les
collections (mémoires, connaissances) vivent aujourd'hui sur le VPS :

1. **Exporter depuis le VPS/actuel** — API snapshot (port 6333, localhost) :

   ```bash
   curl -X POST "http://127.0.0.1:6333/collections/<collection>/snapshots"
   curl -f "http://127.0.0.1:6333/collections/<collection>/snapshots/<nom>" -o <nom>.snapshot
   ```

2. **Restaurer sur le StatefulSet** (ou Qdrant Cloud — alternative managée
   prévue par la feuille de route §6 ; dans ce cas supprimer
   `qdrant/` des `resources` de la base et pointer `QDRANT_URL` sur l'URL
   Cloud) :

   ```bash
   kubectl -n gen3ia cp <nom>.snapshot gen3ia-qdrant-0:/qdrant/snapshots/
   # puis POST /collections/<collection>/snapshots/upload (API REST 6333)
   ```

3. **Vérifier le compte de vecteurs** (`GET /collections/<collection>`)
   avant de basculer `QDRANT_URL` de l'app sur
   `http://gen3ia-qdrant.gen3ia.svc.cluster.local:6333`
   (cf. `lib/memory/vector-store.ts` : `QDRANT_URL` + `QDRANT_API_KEY`).
4. La bascule applicative se fait par mise à jour du **Secret** +
   `rollout restart` — pas de rebuild d'image (variable runtime).
5. Snapshot **régulier après bascule** : tant qu'il n'y a qu'1 replica, le
   PVC n'est pas une sauvegarde — job Cron k8s ou snapshot API planifié
   vers Cloud Storage.

## 7. Correspondance nginx-VPS ↔ Ingress

| VPS (nginx, Phase 2) | Ingress nginx (k8s, Phase 3) |
|---|---|
| `server_name gen3ia.online www` | 2 `rules` sur `gen3ia-ingress` (base) |
| Certbot (certificat renouvelé par cron) | cert-manager + ClusterIssuer `letsencrypt-prod` → secret `gen3ia-tls` (auto-renouvelé) |
| Redirection 80→443 | `ssl-redirect: "true"` |
| `proxy_read/send_timeout` (chats SSE) | `proxy-read-timeout`/`proxy-send-timeout: "3600"` + `proxy-buffering: "off"` |
| WebSocket (upgrade nginx natif) | natif ingress-nginx, **aucune annotation** — ne pas en inventer |
| `client_max_body_size` | `proxy-body-size: "25m"` |
| Sticky/affinité : jamais mis | idem — **pas de session-affinity** (app stateless, cf. `service-app.yaml`) |
| `deploy/nginx/gen3ia-cache.conf` (cache immutable `/_next/static/`, `no-store` sur `version.json`) | les en-têtes sont déjà posés **par l'app** (Next/next.config.ts) ; si on veut les redoubler au bord : annotation `configuration-snippet`, ou Cloud CDN en Phase 3 (feuille de route §6) — ne pas dupliquer sans décision |
| Bloqué 401 sur /api/* internes (garde Task A) | inchangé : c'est applicatif (middleware) |

## 8. HPA et coûts estimatifs

- **HPA** (`hpa-app.yaml`) : 2→6 replicas, cible **CPU 70 %**, descente
  bridée (stabilisation 300 s, ≤ 25 %/min) — l'équivalent élastique du
  VPS qui garde sa RAM allouée. La **mémoire n'est pas un critère
  d'autoscaling** volontairement : une app Node garde un RSS élevé (GC,
  caches) sans être saturée — regarder `/api/metrics` + Cloud Monitoring
  avant d'en faire une cible.
- **Budget pods app (Autopilot, facturation aux `requests`)** :
  2 pods × (250m + 512Mi) ≈ **0,5 vCPU / 1 Gi** au repos, jusqu'à
  6 pods ≈ **1,5 vCPU / 3 Gi** à pleine charge (plafond = `maxReplicas`).
- **Qdrant** : 250m / 512Mi request + PVC 10 Gi.
- **Ordre de grandeur mensuel** (tarifs GKE publics, à re-coter au jour J) :
  Autopilot app+qdrant au repos **~35–60 USD/mois**, ~90–150 USD/mois en
  trafic soutenu (HPA à 4–6 pods), disques/egress en sus — contre ~10–20
  USD/mois pour le VPS actuel. **C'est le §6 qui tranche** : le coût
  RETARDE la migration tant que la charge suit ; c'est l'incidents de
  capacité (temps d'ingénierie) qu'il faut comparer, pas la facture seule.

## 9. Rodage post-déploiement (à ne pas improviser)

1. **Smoke test existant d'abord** : reprendre le runbook
   `docs/runbooks/deployment.md` §4 (health, version, redirections, garde
   401) adapté au domaine — il est le contrat de validité d'un déploiement,
   k8s ne le change pas.
2. **Charge** : `scripts/charge/k6-chat-smoke.js` (workflow
   `load-test.yml`, dispatch manuel) — les seuils de
   `docs/sre/sli-slo.md` (p95 < 3 s, 5xx < 0,5 %) s'appliquent à
   l'infrastructure cible comme à l'actuelle.
3. **Rollout réel observé** : déployer une v1.0.1 pendant qu'on regarde
   (`kubectl rollout status`, zéro 5xx dans `/api/metrics`) — c'est la
   preuve que maxUnavailable 0 + PDB + probes tiennent leurs promesses.
4. **Drain de nœud** (upgrade GKE) : vérifier que le PDB + anti-affinité
   gardent ≥ 1 pod servi pendant l'évacuation.
5. **72 h après bascule** : postmortem/REX selon
   `docs/sre/postmortem-modele.md`, puis congédiement du VPS (DNS TTL bas
   AVANT la bascule).

## 10. Limites connues de cette préparation

- Aucune validation **sur cluster** à ce stade (pas d'environnement k8s) :
  le rendu kustomize et la syntaxe sont vérifiés
  (`scripts/k8s/valider-manifestes.sh`), pas le comportement réel des
  probes, du cert-manager, de l'ingress ou de l'HPA.
- Les ClusterIssuers cert-manager, ingress-nginx, DNS et les quotas
  Let's Encrypt sont à installer/configurer sur le cluster cible (§3) —
  hors périmètre de ce dépôt.
- L'image officielle `qdrant/qdrant` tourne en root (durcissement image
  à évaluer si Qdrant Cloud n'est pas retenu).
- NetworkPolicy deny-by-default : volontairement hors base (§ commentaires
  de `deployment-app.yaml`) — à activer après la topologie de trafic
  validée en staging.
