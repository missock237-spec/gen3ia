# Tests de charge (scripts/charge) — profil smoke VPS 2 Go

> Pilier 4 — Excellence opérationnelle : **un déploiement majeur est précédé
> d'un test de charge**. Ce dossier contient le profil smoke dimensionné pour
> la production actuelle (VPS AlmaLinux 2 Go, PM2 + nginx). Les profils
> historiques (smoke 5 VU / stress progressif 50 VU) vivent dans
> `scripts/load/` et sont documentés dans [`docs/load-testing.md`](../docs/load-testing.md).

## 1. Ce que couvre ce dossier

| Fichier | Rôle | Charge | Endpoints | Seuils |
|---|---|---|---|---|
| `k6-chat-smoke.js` | Smoke **pré-déploiement** — détecter une régression évidente avant les utilisateurs | 10 VU · 60 s | `GET /`, `GET /api/health`, `GET /api/deploy-info` | p95 < 3 000 ms · échecs < 1 % |

Pourquoi ces trois endpoints (et pas le chat / l'IA) :

- **`/`** — rendu serveur complet : middleware + CSP, rendu React, assets. Le
  chemin qui casse en premier lors d'un déploiement dégradé.
- **`/api/health`** — heartbeat sans aucune dépendance
  (`app/api/health/route.ts`) : si lui-même est lent, c'est le process Node
  entier qui sature.
- **`/api/deploy-info`** — API publique la plus légère du dépôt (lecture d'un
  fichier de ~20 octets, `app/api/deploy-info/route.ts`) : sondée en continu
  par chaque onglet ouvert (rechargement automatique), sa tenue sous charge
  garantit que ce mécanisme ne dérive pas.

**Aucun endpoint coûteux n'est ciblé** (chat, IA, génération vidéo, agents) :
chaque requête y déclenche un appel LLM ou un calcul réel — coût d'argent,
latence en secondes, RAM sur une machine à 2 Go. Chercher les limites de la
plateforme reste le rôle du profil stress de `scripts/load/k6-stress.js`.

## 2. Installer k6

k6 s'exécute **hors Node** (binaire autonome) : aucune dépendance npm n'est
ajoutée au projet.

- **macOS** : `brew install k6`
- **Debian/Ubuntu** (dépôt officiel Grafana) :

  ```bash
  sudo gpg -k
  sudo gpg --dearmor -o /usr/share/keyrings/k6-archive-keyring.gpg \
    https://dl.k6.io/keyrings/pubkey.gpg
  echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" \
    | sudo tee /etc/apt/sources.list.d/k6.list
  sudo apt update && sudo apt install k6
  ```

- **Windows** : `choco install k6`
- **Vérification** : `k6 version` (≥ 0.50 recommandé)
- Documentation d'installation : <https://grafana.com/docs/k6/latest/set-up/install-k6/>

## 3. Lancer le smoke

```bash
# Contre la production (défaut) — sans risque : ≈ 20-25 req/s sur 3 sondes
k6 run scripts/charge/k6-chat-smoke.js

# Contre un serveur local (après `npm run build && npm run start`)
BASE_URL=http://localhost:3000 k6 run scripts/charge/k6-chat-smoke.js

# Avec export brut des métriques (pour comparaison entre déploiements)
k6 run --out json=rapport-smoke.json scripts/charge/k6-chat-smoke.js
```

Alternativement, le workflow GitHub **manuel**
[`.github/workflows/load-test.yml`](../.github/workflows/load-test.yml)
(`Actions → Test de charge k6 · manuel → Run workflow`) exécute le même
scénario depuis un runner : input `url` (défaut `https://gen3ia.online`) +
`scenario` (défaut `smoke`). Il est **volontairement impossible à déclencher
automatiquement** : un test de charge est une décision, pas un effet de bord.

## 4. Interpréter les résultats

En fin d'exécution, k6 imprime un résumé et **sort avec un code non nul si un
seuil est franchi** (intégrable tel quel dans un job de validation).

| Métrique | Seuil | Lecture |
|---|---|---|
| `http_req_duration` p(95) | < 3 000 ms | Le contrat de latence du VPS 2 Go (rendu SSR + TLS + machine modeste). Au-delà : rendu perçu comme cassé. |
| `http_req_failed` | < 1 % | Erreurs réseau + 4xx/5xx. Un déploiement sain est à 0 % ; 1 % est la marge de micro-coupure, pas un droit. |
| `checks` | 100 % attendu | Un check rouge avec statut 200 = réponse dégradée (HTML au lieu du JSON attendu, `deploymentId` vide…). |
| `http_reqs` / `iterations` | — | Débit réel (~20-25 req/s attendus) : sert de référence entre deux déploiements. |
| `vus_max` | 10 | Sanity check que le scénario joué est bien celui versionné. |

**Si un seuil est franchi :**

1. Ne pas pousser / ne pas déployer le changement en cours (main toujours
   vert — cf. `docs/processus-ingenierie.md`).
2. Vérifier `/api/status` (service dégradé ?) et le dernier run
   `deploy-vps.yml` (rollback automatique appliqué ?).
3. Comparer avec un run précédent (export `--out json`) : régression de
   latence ou d'erreurs → investiguer le diff de la branche, pas la prod.
4. Si la production est touchée, suivre
   [`docs/runbooks/incident-response.md`](../docs/runbooks/incident-response.md)
   (postmortem sans blâme sous 72 h — cf. `docs/processus-ingenierie.md`).

## 5. Quand lancer

- **Avant chaque déploiement majeur** : migration de version Next.js,
  modification du middleware/CSP, changement d'infra (nginx, PM2, VPS),
  nouvelle route publique à fort trafic.
- **Après un incident de latence** : valider le retour à la normale avec le
  même scénario (comparaison JSON entre avant/après).
- **Après chaque montée de capacité** (changement de VPS, PHASE 2/3 de la
  feuille de route) : rebâtir la courbe de référence et réévaluer les seuils.

## 6. Cadre éthique (rappel)

Ne tester **QUE gen3ia.online** (ou localhost) — la plateforme est notre
propriété ; pointer k6 vers un domaine tiers est un délit, pas un test.
Le cadre complet (fenêtre, supervision pendant le run, exclusions du bug
bounty) est détaillé dans [`docs/load-testing.md` §7](../docs/load-testing.md).
