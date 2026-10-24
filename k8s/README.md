# k8s/ — Manifestes Kubernetes (préparatoire Phase 3)

> **⚠️ RIEN N'EST DÉPLOYÉ SUR KUBERNETES AUJOURD'HUI.** Le runtime de
> production reste le **VPS 2 Go + PM2 + nginx** (CD `deploy-vps.yml` — ne
> pas toucher). Ces manifestes préparent la **Phase 3 (GKE)** dont les
> déclencheurs explicites sont dans
> `docs/roadmap.md` § « Phases structurelles » (charge, coût, équipe).

## Pourquoi kustomize (et PAS Helm)

Zéro dépendance : les manifestes sont du YAML statique versionné, lisibles
en revue de code, sans binaire supplémentaire ni chart à maintenir. La
spécialisation par environnement (tag d'image, replicas, hosts TLS) passe
par des overlays kustomize (`overlays/prod`, `overlays/staging`).

**Note Helm** : si l'équipe grandit (déclencheur « Équipe > 1 » du §6 —
revues multi-humains, environnements séparés), migrer ces manifestes vers
un **Chart Helm** (values par environnement, templates pour les tags
d'image secrets). La structure `base/` + `overlays/` se transpose
directement en chart + values — la migration est mécanique, ne la lance
que si le coût de duplication des manifests devient réel.

## Arborescence

```
k8s/
├── base/                     # topologie commune (toute environnement)
│   ├── namespace.yaml        # namespace gen3ia
│   ├── deployment-app.yaml   # app Next.js (2 replicas, probes /api/health)
│   ├── service-app.yaml      # ClusterIP 3000
│   ├── ingress.yaml          # ingress-nginx + TLS cert-manager
│   ├── hpa-app.yaml          # autoscaling 2→6 (CPU 70 %)
│   ├── pdb-app.yaml          # budget de disruption (maxUnavailable 1)
│   ├── qdrant/               # base vectorielle (StatefulSet + service)
│   ├── secret-example.yaml   # ⚠️ EXEMPLE — pas appliqué, cf. doc
│   ├── configmap-example.yaml# ⚠️ EXEMPLE — pas appliqué, cf. doc
│   └── kustomization.yaml
└── overlays/
    ├── prod/                 # tag d'image + hosts gen3ia.online
    └── staging/              # 1 replica, staging.gen3ia.online
```

## Valider sans cluster

```bash
bash scripts/k8s/valider-manifestes.sh   # rendu kustomize offline (+ kubeconform si installé)
```

## Ordre d'application (résumé — guide complet : `docs/deploiement-k8s.md`)

1. Prérequis cluster : ingress-nginx + cert-manager (ClusterIssuers) ;
2. Créer `gen3ia-app-secrets` + `gen3ia-app-config` (`kubectl create …`) ;
3. Épingler le tag d'image dans `overlays/prod` ;
4. `kubectl apply -k k8s/overlays/prod` puis vérifier les probes.

Le README racine et `docs/deploiement-k8s.md` font foi pour les étapes
de déploiement, la migration des données Qdrant et la correspondance
nginx-VPS ↔ Ingress.
