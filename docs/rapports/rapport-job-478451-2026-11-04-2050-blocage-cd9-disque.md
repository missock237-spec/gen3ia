# Rapport Job 478451 — Blocage CD n°9 : disque VPS saturé, prod gelée 7 h 49

**Date** : 2026-11-04 · **Fenêtre d'incident** : 13:08:59Z → 21:00:14Z (7 h 49 min)
**Signalement** : « Vérifie ce qui ne va pas car en production il n'y a pas de changement, corrige ça »
**Résolution** : production basculée sur `59f650c` à 21:00:14Z, site sain, harnais flux fichiers 8/8.

## 1. Symptôme constaté

- `gen3ia.online/version.json` figé : `gitSha = e78dd5d` (build 13:08:59Z).
- Six builds pourtant publiés sur la release `cd-latest` sans bascule :
  `d6cac44` (13:27Z), `a9c663f` (14:12Z), `7542f5e` (14:58Z), `0a6d059` (17:11Z),
  `63e754e` (17:57Z), `a271715` (19:03Z — le repositionnement Gemini demandé).
- Le poller VIVAIT : battement HTTPS frais toutes les 2 min, `targetSha` correct,
  mais `note = ""` en permanence — aucune phase de téléchargement ni de finisher
  observable, et surtout **aucune bascule**.

## 2. Diagnostic sans SSH (phases du battement v6)

L'échantillonnage serré du battement public a capturé le cycle d'échec complet :

| Heure (UTC) | Phase observée | Lecture |
|---|---|---|
| 19:43:04 | `dl-debut` | téléchargement démarré |
| 19:43:33 | `finisher-debut` | tar déjà complet (reprise) → finisher lancé |
| ~19:46:5x | `echec-backoff` | **finisher échoué après ~3,5 min** |
| 20:03:17 / 20:23:21 | `finisher-debut` | retry, même échec déterministe |
| 20:26:57 → 20:27:03 | `dl-debut` → `echec-backoff` en 6 s | échec d'écriture du tar |

Trois signatures **indépendantes et concordantes d'un système de fichiers saturé (ENOSPC)** :

1. **Zéro blacklist depuis 13:27** alors que les chemins d'échec extraction/npm-ci
   écrivent normalement dans `failed_commits.txt` → l'écriture de la blacklist échouait ;
2. **Backoff cassé** (retries serrés sans respecter le palier 900 s) → l'écriture
   de `pull-fail.txt` échouait ;
3. **Échec de téléchargement en ~6 s** (au lieu de ~10 min) → l'écriture du tar échouait.

**Cause racine** : le déploiement réussi de 13:08 (extraction ~900 Mo + npm ci) a
saturé le disque du VPS. Le pré-vol v7 du finisher n'a jamais pu libérer les
1500 Mo exigés : son périmètre de nettoyage était trop timide (il n'osait ni le
`.next/cache` runtime de la prod, ni `journalctl`, ni les vieux tars, ni
`node_modules.old`/`.next.old`), et l'extraction ENOSPC n'avait **aucune reprise**
après libération. Résultat : boucle muette échec → retry → échec, six heures durant.

## 3. Correctifs (auto-livrés par le canal pull lui-même)

### finisher v8 (`infra/deploy/cd-finisher.sh`)
- **Échelle de libération disque progressive, 11 niveaux** (du plus sûr au plus
  instrusif, chaque niveau re-mesure et s'arrête au seuil) : staging/.next → cache
  npm → vieux tars /tmp → `.next/cache` runtime de la prod → `journalctl
  --vacuum-size=50M` → cache apt → `pm2 flush` → rotation `deploy.log` → `git gc`
  → TOUS les vieux tars (sauf le courant) → EMERGENCY documentée
  `.next.old`/`node_modules.old` (rollback volontairement sacrifié). Rapport `du`
  des plus gros consommateurs en fin d'échelle si le seuil reste inaccessible.
- **Reprise d'extraction** : échec `tar xzf` → échelle rejouée → UNE seconde
  tentative. Plus jamais un disque presque plein ne transforme un build bon en SHA perdu.
- **Garde disque npm ci** (`NPM_MIN_MO=2600`) : place insuffisante → skip **honnête**
  (note `finisher-npm-ci-skip-disque`), PAS de blacklist — le health check arbitre.
- **Ordre corrigé** : extraction AVANT npm ci (on n'installe plus jamais les deps
  d'un build dont le tar s'avère mauvais).
- **Rollback honnête** : si `.next.old` a été purgé par l'échelle d'urgence,
  l'impossibilité de rollback est dite et notée (`finisher-echec:sante-sans-rollback`),
  jamais simulée.
- Rotation `deploy.log` (cap 5 Mo).

### pull-deploy v7 (`scripts/vps-auto-deploy/pull-deploy.sh`)
- **Préservation des notes d'échec** : le battement de début de cycle ne broie plus
  les notes `finisher-echec:<etape>` (l'angle mort qui a rendu le blocage n°9
  indiagnostiquable de l'extérieur). Une note d'échec survit désormais jusqu'à la
  réussite suivante.
- **Tar déjà présent et intègre = téléchargement sauté** (fin du churn de 208 Mo
  par tentative sur un disque saturé).
- **Filet anti-fs-plein** : `pull-fail.txt` illisible → repli `/tmp/pull-fail.txt`
  + note `echec-fs-plein` visible de l'extérieur.
- Rotation `deploy.log` (cap 5 Mo).

### CD (`deploy-vps.yml`)
- Le tar embarque désormais **`package.json` + `package-lock.json`** (racine de
  l'archive ; handoff par le finisher vers le staging avant la décision npm ci).
  Fermeture du trou structurel du canal pull : son tar ne contenait que `.next`,
  le lockfile du staging ne suivait donc jamais le build après un merge de
  dépendances (np. `ffcd103` : sentry 11 / eslint 10 / firebase 13).

## 4. Preuves de non-régression (harnais sans VPS, sans `/opt`, sans réseau)

| Harnais | Scénarios | Résultat |
|---|---|---|
| `scripts/test-finisher-v8-disque.sh` | disque insuffisant (échelle exécutée + effets filesystem vérifiés + pas de blacklist), tar corrompu (reprise + blacklist honnête), chemin nominal (handoff manifests + lock-hash aligné), garde disque npm ci, rollback sanitaire | **28/28** |
| `scripts/test-pull-deploy-v7.sh` | note d'échec SURVIVANT au cycle suivant (prouvé), tar intègre sauté, filet fs-plein (repli `/tmp` + note) | **12/12** |
| Garde-fous structurels vitest `ci-pipeline.test.ts` | | **53/53** |
| `bash -n` sur les deux scripts | | OK |

## 5. Livraison et convergence mesurée

- Push `59f650c` (correctif) → CD runner → publication release ~20:54Z.
- Poller : téléchargement → **finisher v8 exécuté au SHA cible** (phases observées
  : `finisher-sante` à 20:59:55Z) → **bascule à 21:00:14Z**.
- `version.json` : `gitSha = 59f650c…`, build 20:54:56Z. Battement : `poller:
  pull-deploy v7` (auto-aligné par le finisher au succès), `target == served`.
- Santé : accueil HTTP 200 (0,74 s), `/vitrine` HTTP 200.
- **Harnais flux fichiers en production : 8/8** (création conversation, session
  presignée, dépôt R2, commit multipart, import converti, tour de conversation,
  contenu réellement reçu et analysé par GEN3).

La production sert donc désormais **tout le retard accumulé** : le
repositionnement plateforme IA style Gemini (`a271715`, racine = chat, sidebar
« Récents » + « Capacités », vitrine déplacée vers `/vitrine`), les trois modules
souverains (`0a6d059`), la fusion des dépendances (`ffcd103`) et la réparation du
flux fichiers (`a9c663f`).

## 6. Suites

- L'escalade `#130` se referme automatiquement au prochain tick guérisseur
  (production réalignée → `besoin=false`).
- Le diagnostic comme la réparation se sont faits **sans aucun SSH** : phases du
  battement public → correctifs → auto-livraison par le canal pull. La boucle
  d'auto-guérison visée par les itérations précédentes a fonctionné de bout en bout.
