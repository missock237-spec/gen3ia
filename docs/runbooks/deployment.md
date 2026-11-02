# Runbook — Déploiement

> Procédure opérationnelle de mise en production
> (<https://gen3ia.online>) : du push GitHub à la vérification post-déploiement,
> puis rollback si nécessaire. Le déploiement est **entièrement automatisé** —
> ce runbook décrit ce qui doit être **vérifié** à chaque étape, pas ce qui est
> exécuté à la main.

---

## 1. Vue d'ensemble du flux

```
push/PR GitHub (main)
   └─ CI GitHub Actions (.github/workflows/ci.yml + codeql.yml)
        ├─ job « ci » : 6 checks — Typecheck · Lint · Tests (couverture) · Audit · Build · Budget
        ├─ job « e2e » : E2E auth contre émulateur Firebase (jamais la production)
        ├─ job « a11y » : scan axe-core WCAG 2.1 AA
        └─ job « secrets-scan » : gitleaks (scan de l'historique complet)
   └─ CD (deploy-vps.yml) : build runner → publication release `cd-latest`
        (tar + sha256 + meta.json — meta.json téléversé EN DERNIER :
        sa présence = build complet) → canaux de livraison :
          · SSH (accélérateur best-effort, swap atomique cd-finisher) ;
          · POLLER PULL (faisant autorité) : le VPS relit la release
            toutes les 120 s et bascule (pull-deploy.sh v3, backoff
            progressif sur échec transient : retry 60 s, puis 2 min,
            5 min, plafond 15 min).
   └─ MESURE POST-PUBLICATION (issue #109) : si verify_build est sauté
        (SSH muet), le step « Contrôle de livraison PULL » sonde
        gen3ia.online/version.json toutes les 30 s pendant le SLE
        (600 s) ; SLE violé = run ROUGE + issue d'escalade (refermée
        automatiquement à l'alignement par le guérisseur).
   └─ Smoke test post-deploy (§4) → vert = terminé / rouge = §5 rollback
```

Règle d'or : **une CI rouge ne déploie jamais correctement ce qu'elle n'a pas
validé** — si la CI échoue, le problème se règle sur la branche, pas en
production. (Protection de branche : historique linéaire, branches à jour et
5 checks requises.)

---

## 2. Étape CI — les 6 checks du job principal

Exécutés à chaque push/PR sur `main` (Node 22, cache npm + build Next.js) :

| # | Check | Commande | Bloque si |
|---|---|---|---|
| 1 | **Typecheck** | `npm run typecheck` (tsc strict, 0 erreur) | toute erreur de type |
| 2 | **Lint** | `npm run lint` (ESLint 9, next/core-web-vitals + TS) | toute erreur/warning |
| 3 | **Tests** | `npm run test:coverage` (vitest 5, ~3 245 tests + seuils de couverture) | tout échec ou seuil non atteint |
| 4 | **Audit** | `npm audit --omit=dev --audit-level=high` | toute vulnérabilité haute/critique en prod |
| 5 | **Build** | `npm run build` (production Next.js) | tout échec de build |
| 6 | **Budget bundle** | `npm run check:bundle` (First Load JS par route, gzip — 240 kB max) | tout dépassement de budget |

Le job construit aussi le SDK public `@gen3ia/sdk` (`npm run sdk:build`) et
installe les dépendances isolées de `services/sandbox/` en amont de ces checks.

Jobs satellites en parallèle : **E2E** (émulateur Firebase auth — les tests e2e
ne touchent JAMAIS la production), **a11y** (axe-core sur les pages publiques
contre un serveur local), **secrets-scan** (gitleaks sur l'historique complet),
et **CodeQL** (`security-extended`, chaque push/PR + hebdomadaire lundi 03:00
UTC, résultats dans l'onglet Security GitHub).

Avant de pousser sur `main`, l'équivalent local existe :
`make qa` (lint + typecheck + tests + build + budget bundle).

---

## 3. Étape CD — publication et livraison (production = VPS)

- La production est le **VPS** (PM2, nginx, gen3ia.online) — pas Vercel.
- Le CD publie la release `cd-latest` ; le **poller PULL** du VPS
  (`/opt/gen3ia-updater`, cycle 120 s) télécharge et bascule. Le SLA de
  livraison : **cible ≤ 2 min** après publication (1 cycle du poller +
  téléchargement/swap) ; **SLE d'alerte 600 s** — au-delà, le CD (step v8)
  ou le guérisseur déclenche une escalade publique (issue + run rouge),
  refermée automatiquement dès l'alignement. Historique des mesures :
  `$GITHUB_STEP_SUMMARY` de chaque run CD (« LIVRAISON PULL MESURÉE »).
- Si l'escalade s'ouvre : `curl -fsSL https://raw.githubusercontent.com/missock237-spec/gen3ia/main/scripts/vps-auto-deploy/install-pull-mode.sh | bash`
  (console VPS, réarme le poller) — l'issue se referme seule au
  re-spondage du guérisseur.
- Ne jamais modifier des variables d'environnement en même temps qu'un
  déploiement : changer du code ET de la config dans la même fenêtre rend
  l'attribution de cause impossible si le smoke test échoue.

---

## 4. Vérifications post-déploiement (smoke test)

À exécuter sur chaque déploiement de production (moins de 5 minutes au total).
Toutes les commandes doivent être exécutées contre `https://gen3ia.online` et
re-parties de zéro à chaque déploiement.

| # | Route attendue | Commande | Résultat attendu |
|---|---|---|---|
| 1 | `/` (vitrine) | `curl -s -o /dev/null -w "%{http_code}" https://gen3ia.online/` | `200` |
| 2 | `/login` | `curl -s -o /dev/null -w "%{http_code}" https://gen3ia.online/login` | `200` |
| 3 | `/studio` (app protégée) | `curl -s -o /dev/null -w "%{http_code}" https://gen3ia.online/studio` | `307` (redirection auth attendue) |
| 4 | `/api/health` | `curl -s https://gen3ia.online/api/health` | `200` + `{ "status": "ok", "timestamp": … }` |
| 5 | `/api/status` | `curl -s https://gen3ia.online/api/status` | `200` + `status: "ok"` et `services.auth/r2/ticks` à `true` — vérifier aussi que `version` correspond au déploiement du jour |
| 6 | `manifest.webmanifest` (PWA) | `curl -s -o /dev/null -w "%{http_code}" https://gen3ia.online/manifest.webmanifest` | `200` (asset statique servi) |
| 7 | `/version.json` (mise à jour forcée) | `curl -s https://gen3ia.online/version.json` | `200` + `"version"` ÉGALE au `deploymentId` de `/api/deploy-info` et au BUILD_ID affiché par le run de déploiement |

Contrôle d'alignement de bout en bout (les trois empreintes doivent être
identiques — sinon le mécanisme de rechargement automatique est aveugle) :

```bash
echo "deploy-info : $(curl -s https://gen3ia.online/api/deploy-info | grep -o '"deploymentId":"[^"]*"')"
echo "version.json : $(curl -s https://gen3ia.online/version.json | grep -o '"version":"[^"]*"')"
```

D'une ligne, pour copier-coller :

```bash
for r in / /login /studio /api/health /api/status /manifest.webmanifest /version.json; do
  printf "%-25s %s\n" "$r" "$(curl -s -o /dev/null -w "%{http_code}" "https://gen3ia.online$r")"
done
```

Compléments recommandés (non bloquants, à l'appréciation) : `/robots.txt` et
`/sitemap.xml` en `200` ; connexion manuelle à l'application et lancement
d'une conversation d'agent ; Sentry sans nouvelle issue post-déploiement.

> **Attention** : `/api/status` est mise en cache CDN 30 s (`s-maxage=30`) —
> le champ `version` peut rester celui du déploiement précédent pendant
> quelques dizaines de secondes. Ce n'est pas un échec.

**Interprétation** :

- Tout vert → déploiement terminé, consigner la date + SHA + numéro de
  déploiement dans le fil de suivi.
- Un rouge quelconque → ne PAS « attendre que ça passe » : passer au §5.

---

## 5. Rollback

### 5.1 Quand

- Smoke test rouge après un déploiement valide la veille ;
- incident P1/P2 dont la cause est le dernier déploiement
  (voir `docs/runbooks/incident-response.md` §4).

Principe : **on rollback d'abord, on diagnostique ensuite** — un déploiement
précédent connu-sain vaut mieux qu'un correctif écrit sous pression.

### 5.2 Comment (rollback d'un déploiement fautif)

1. Identifier le **dernier commit sain** (le SHA servi est lisible sur
   `https://gen3ia.online/version.json` et dans `/api/status`).
2. Le rollback passe par `main` : `git revert` du/des commits fautifs (ou
   restauration du commit sain) puis push — le CD republie la release et
   le poller bascule (≤ 2 min visés, alerte à 10 min si non livré).
3. Urgence console VPS (sans attendre le CD) : redéployer le précédent tar
   `cd-finisher` / relancer `install-pull-mode.sh`, puis vérifier §4.
4. Après bascule : relancer le **smoke test complet** (§4) — notamment
   `GET /api/status` et `version.json` (fenêtre cache 30 s) — et vérifier
   que `main` reflète ce qui tourne en production (écart nul).

### 5.3 Après un rollback

- Consigner la cause racine du déploiement fautif (post-mortem si P1/P2 —
  voir `docs/runbooks/incident-response.md` §7).
- Ne re-pousser le contenu fautif qu'avec un correctif + test de
  non-rgression, après une CI verte complète.

---

## 6. Rappels d'architecture utiles au déploiement

| Sujet | Détail |
|---|---|
| Durée des exécutions | routes lourdes jusqu'à 300 s (`maxDuration`), missions longues par file de ticks R2 — un déploiement n'interrompt pas les missions en cours (checkpoint + reprise) |
| Persistance | Cloudflare R2 pour les fichiers, artefacts et files durables ; Firebase Admin pour l'auth — les variables `R2_*` et `FIREBASE_*` sont requises en production |
| Statut | `/api/status` expose la `version` du déploiement courant : c'est la référence pour vérifier qu'un rollback a bien pris effet |

---

## 7. Crons VPS auto-hébergé (durcissement 2026-10-22)

La production tourne sur le VPS (`deploy-vps.yml` → `cd-finisher.sh`) : les
`crons` de `vercel.json` ne s'y exécutent PAS (inertes hors Vercel). Ils y
restent pour la parité si la plateforme repasse sur Vercel. Sur le VPS, le
cron `/api/cron/training-sweep` (balayage global des tâches d'entraînement :
dispatch des tâches en attente, rafraîchissement des tâches en cours pour
TOUS les utilisateurs, même onglet fermé — indispensable dès qu'un worker
GPU est câblé) doit être planifié en crontab :

```cron
*/5 * * * * curl -fsS -m 290 -H "Authorization: Bearer $CRON_SECRET" http://127.0.0.1:3000/api/cron/training-sweep -o /dev/null -w '%{http_code}\n' >> /var/log/gen3ia-cron.log 2>&1
```

Installation (une fois, en root sur le VPS) :

```bash
# 1. Charger le secret depuis .env.production (CRON_SECRET y figure déjà)
grep -q CRON_SECRET /etc/environment || echo "CRON_SECRET=$(grep '^CRON_SECRET=' /opt/gen3ia/.env.production | cut -d= -f2-)" >> /etc/environment

# 2. Crontab : toutes les 5 minutes
( crontab -l 2>/dev/null; echo '*/5 * * * * . /etc/environment && curl -fsS -m 290 -H "Authorization: Bearer $CRON_SECRET" http://127.0.0.1:3000/api/cron/training-sweep -o /dev/null -w "%{http_code}\n" >> /var/log/gen3ia-cron.log 2>&1' ) | crontab -

# 3. Vérifier : une ligne 200 toutes les 5 min après le prochain cycle
tail -f /var/log/gen3ia-cron.log
```

Notes :
- `CRON_SECRET` doit rester identique à celui du `.env.production` du VPS
  (comparaison à temps constant côté route — `timingSafeStringEqual`).
- Sans ce cron, le sweep ne progresse qu'opportunistement (onglet Studio
  ouvert) : les tâches d'entraînement en attente restent en attente et les
  quotas restent bloqués par des tâches non rafraîchies.
- Les autres crons (`agent-schedules`, `cleanup-invitations`) méritent la
  même treatment si leurs effets sont attendus en continu sur le VPS.

---

## 8. Mise à jour forcée navigateur (version.json + nginx — plan 4 étapes)

Depuis le 2026-10-23, chaque navigateur se recharge TOUT SEUL à chaque
nouvelle version, par une chaîne à triple redondance :

1. **Au build** : `npm run build` écrit `public/version.json` dont la
   `version` finale est EXACTEMENT le `.next/BUILD_ID` du build
   (`scripts/version-manifest.mjs init` avant `next build`, `finalize`
   après). Le manifeste est embarqué dans le tar CD (`.next/version.json`)
   et `cd-finisher.sh` le copie dans `public/` sur le VPS après son
   `git reset --hard`.
2. **Côté client** : le `DeployWatcher` (monté dans `app/layout.tsx`) sonde
   EN PARALLÈLE `/api/deploy-info` ET `/version.json?t=<timestamp>`
   (no-store) toutes les ~90 s ; il compare aussi à la version persistée
   en `localStorage` (`gen3ia-app-version`) — une page chargée depuis un
   cache avec un build périmé est détectée dès le premier relevé. La
   version nouvelle est écrite dans le stockage AVANT tout rechargement
   (jamais de boucle). Les deux sources divergent (bascule/rollback en
   cours) : aucune décision ce cycle.
3. **Côté serveur web** : le dépôt fournit
   `infra/deploy/nginx/gen3ia-cache.conf` — à intégrer au vhost `server { }` de
   gen3ia.online. La couche Next impose déjà `no-store` sur
   `/version.json` ; le bloc nginx est la double ceinture (et protège du
   jour où un CDN/intermédiaire s'insérera).

Application sur le VPS (une fois, en root — le bloc doit être adapté au
`proxy_pass` existant du vhost, cf. commentaires du fichier) :

```bash
# 1. Sauvegarder le vhost actuel, y intégrer les blocs du snippet
#    (assets immuables ^~ /_next/static/, location = /version.json,
#    regex \.(html|json)$ — cf. infra/deploy/nginx/gen3ia-cache.conf)
cp /etc/nginx/conf.d/gen3ia.conf /etc/nginx/conf.d/gen3ia.conf.bak
#    … éditer le vhost pour y coller les blocs …

# 2. Valider puis recharger
nginx -t && systemctl reload nginx

# 3. Vérifier : le manifeste n'est plus cachable, les assets hashés le
#    restent (commandes de vérification en tête de
#    infra/deploy/nginx/gen3ia-cache.conf)
curl -sI https://gen3ia.online/version.json | grep -i cache-control
```

> Si ce §8 n'a pas encore été appliqué sur le VPS, le mécanisme reste
> OPÉRATIONNEL : les en-têtes `no-store` de la couche Next suffisent
> (vérifiables par `curl -sI https://gen3ia.online/version.json |
> grep -i cache-control` → `no-store, no-cache, must-revalidate`).
