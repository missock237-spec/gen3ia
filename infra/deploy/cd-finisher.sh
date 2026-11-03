#!/bin/bash
# =====================================================================
# Gen3ia — Bascule en production d'un build compilé par le runner GitHub.
# Appelé par le workflow « Déploiement continu VPS » (deploy-vps.yml) et
# par le poller pull (pull-deploy.sh, qui le télécharge AU SHA CIBLE —
# tout correctif committé ici s'auto-livre au prochain cycle, sans SSH).
#
# v7 (2026-11-04, it.99 — blocage CD n°8 : échecs finisher < 60 s sur 2
# SHAs distincts, cause environnementale VPS, observables SSH épuisés) :
#   · ÉTAPES VISIBLES SANS SSH : chaque phase écrit le battement public
#     (public/poller-heartbeat.json, même format que le poller) — le
#     prochain échec se LIT depuis l'extérieur (note finisher-echec:<etape>),
#     fini l'angle mort deploy.log ;
#   · PRÉ-VOL DISQUE : si /opt a moins de MIN_LIBRE_MO, nettoyage sûr
#     (staging/.next, caches npm, tars /tmp de plus d'une heure) puis
#     re-check — un disque plein est le candidat n°1 d'une extraction
#     en échec instantané ; l'échec résiduel est documenté :disque ;
#   · FETCH BORNÉ : `timeout` sur git fetch (un fetch pendu tenait le
#     verrou indéfiniment) + repli sur l'URL ANONYME (dépôt public —
#     un jeton embarqué périmé dans origin ne doit plus bloquer un
#     déploiement) + mode dégradé (SHA déjà connu : bascule sans sync
#     source, averti en log) — candidat n°2 d'un échec en secondes ;
#   · Les GARANTIES « sans destruction d'état » sont INTACTES :
#     .env.production jamais touché ; l'app courante sert pendant tout
#     le transfert ; swap .next atomique avec .next.old conservé ;
#     health check + ROLLBACK automatique ; blacklist des SHAs en échec ;
#     updater PM2 suspendu puis relancé par trap dans tous les cas.
#
# Usage : bash cd-finisher.sh <SHA_DE_MAIN_A_DEPLOYER> [TAR_PATH]
# =====================================================================
set -u

TARGET_SHA="${1:?Usage: cd-finisher.sh <SHA> [TAR_PATH]}"
# Canal d'artefacts (séparation 2026-10-28, run 0c0e21aa) : le canal SSH du
# CD et le poller pull exécutent le MÊME finisher mais dans des répertoires
# DISTINCTS. Le trap purge les artefacts à l'exit — s'ils étaient partagés,
# le canal le plus rapide détruisait ceux de l'autre (race observée :
# poller déployé à 10:20 → purge → swap SSH du CD en 127 ×4 sur
# /tmp/cd-finisher.sh absent). 2e argument optionnel = chemin du tar.
TAR_PATH="${2:-/tmp/next-build.tar.gz}"
PROD_DIR=/opt/gen3ia
STAGING_DIR=/opt/gen3ia-staging
UPDATER_DIR=/opt/gen3ia-updater
STATE_DIR=$UPDATER_DIR/state
LAST_DEPLOYED=$STATE_DIR/last-deployed.txt
FAILED_COMMITS=$STATE_DIR/failed_commits.txt
DEPLOY_LOG=$STATE_DIR/deploy.log
HEARTBEAT=$PROD_DIR/public/poller-heartbeat.json
REPO_ANONYME="https://github.com/missock237-spec/gen3ia.git"
MIN_LIBRE_MO=1500          # plancher pour extraire (~500-800 Mo) + marge npm ci

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$DEPLOY_LOG"; echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

# v7 — télémétrie d'étape SANS SSH : même format que le battement du
# poller (champ poller identique pour la continuité des greps du
# guérisseur). Ne JAMAIS laisser un échec d'écriture tuer le déploiement.
etape() { # $1 = note courte (finisher-<phase> / finisher-echec:<phase>)
  local servi
  servi=$(cat "$LAST_DEPLOYED" 2>/dev/null || echo '')
  printf '{"ok":true,"ts":"%s","epoch":%s,"poller":"pull-deploy v6","targetSha":"%s","servedSha":"%s","note":"%s"}\n' \
    "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$(date +%s)" "$TARGET_SHA" "$servi" "$1" \
    > "$HEARTBEAT" 2>/dev/null || true
}

mkdir -p "$STATE_DIR"
touch "$FAILED_COMMITS"
export PATH=$PATH:/usr/local/bin:/usr/bin
export GIT_TERMINAL_PROMPT=0   # v7 : un fetch ne doit jamais attendre une saisie

# --- Un seul déploiement à la fois ---
exec 9>"$STATE_DIR/deploy.lock"
if ! flock -n 9; then log "CD: un déploiement est déjà en cours — abandon."; exit 1; fi
etape "finisher-debut"

# --- Suspendre l'updater (relancé par trap dans tous les cas) ---
pm2 stop updater >/dev/null 2>&1 || true
# trap combiné : updater relancé + artefacts temporaires purgés (aucun tar
# orphelin dans /tmp, même en cas d'échec) — durcissement 2026-10-22.
purge_canal() {
  rm -f "$TAR_PATH"
  # $0 purgé SEULEMENT s'il vit dans /tmp (copie SCP / téléchargement poller)
  # — jamais le script du dépôt si un dev l'exécute depuis son checkout.
  case "$0" in /tmp/*) rm -f "$0";; esac
}
trap 'pm2 start updater >/dev/null 2>&1 || true; purge_canal' EXIT

# --- Vérifier le SHA cible ---
[ -f "$TAR_PATH" ] || { log "CD ERREUR: $TAR_PATH absent (scp a échoué ?)"; etape "finisher-echec:tar-absent"; exit 1; }
cd "$PROD_DIR" || { log "CD ERREUR: $PROD_DIR introuvable"; etape "finisher-echec:prod-absent"; exit 1; }

# --- v7 : pré-vol disque (candidat n°1 d'un échec < 60 s : extraction en
#        ENOSPC). Nettoyage SÛR uniquement : le staging/.next (recréé du tar
#        à chaque déploiement), les caches npm (re-téléchargeables), les
#        tars /tmp de plus d'une heure (jamais le tar COURANT). Les paires
#        .next.old/node_modules.old (sécurité de rollback) ne sont PAS
#        touchées ici. ---
libre_mo() { df -m /opt 2>/dev/null | awk 'NR==2{print $4}' ; }
LIBRE=$(libre_mo)
if [ -n "$LIBRE" ] && [ "$LIBRE" -lt "$MIN_LIBRE_MO" ] 2>/dev/null; then
  log "CD PRÉ-VOL: ${LIBRE} Mo libres < ${MIN_LIBRE_MO} — nettoyage sûr avant extraction…"
  rm -rf "$STAGING_DIR/.next" 2>/dev/null || true
  timeout 90 npm cache clean --force >/dev/null 2>&1 || true
  find /tmp -maxdepth 1 -name 'next-build.tar.gz*' -mmin +60 -delete 2>/dev/null || true
  find /tmp -maxdepth 1 -name 'pull-deploy.*' -mmin +60 -delete 2>/dev/null || true
  find /tmp -maxdepth 1 -name 'cd-finisher.sh' -mmin +60 ! -path "$0" -delete 2>/dev/null || true
  LIBRE2=$(libre_mo)
  log "CD PRÉ-VOL: après nettoyage — ${LIBRE2} Mo libres (avant : ${LIBRE})."
  if [ -n "$LIBRE2" ] && [ "$LIBRE2" -lt "$MIN_LIBRE_MO" ] 2>/dev/null; then
    # Dernier recours non destructif : purger les vieux logs PM2 (pas deploy.log).
    timeout 30 pm2 flush >/dev/null 2>&1 || true
    LIBRE3=$(libre_mo)
    log "CD PRÉ-VOL: après pm2 flush — ${LIBRE3} Mo libres."
    if [ -n "$LIBRE3" ] && [ "$LIBRE3" -lt "$MIN_LIBRE_MO" ] 2>/dev/null; then
      log "CD ERREUR: disque insuffisant (${LIBRE3} Mo libres < ${MIN_LIBRE_MO}) — extraction avortée SANS blacklist (cause environnementale, pas le build)."
      etape "finisher-echec:disque-${LIBRE3}mo"
      exit 1
    fi
  fi
else
  log "CD PRÉ-VOL: ${LIBRE:-?} Mo libres — OK."
fi

# --- v7 : fetch borné + repli anonyme + mode dégradé (candidat n°2 :
#        jeton embarqué périmé dans l'origin du VPS — le dépôt est PUBLIC,
#        un fetch anonyme suffit ; un SHA déjà rapatrié permet même de
#        basculer sans réseau). ---
etape "finisher-fetch"
SYNC_SOURCE=1
if ! timeout 60 git fetch origin --quiet 2>>"$DEPLOY_LOG"; then
  log "CD AVERTISSEMENT: git fetch origin a échoué (borné 60 s) — repli URL anonyme (dépôt public)…"
  if timeout 60 git fetch "$REPO_ANONYME" --quiet 2>>"$DEPLOY_LOG"; then
    log "CD: fetch anonyme OK — l'origin configuré est vraisemblablement porteur d'un jeton périmé (à corriger en console, non bloquant)."
  elif git cat-file -e "$TARGET_SHA" 2>/dev/null; then
    SYNC_SOURCE=0
    log "CD MODE DÉGRADÉ: fetch impossible mais $TARGET_SHA déjà connu localement — bascule SANS sync source (le .next livré est autonome)."
  else
    log "CD ERREUR: git fetch a échoué (2 voies) et SHA inconnu du dépôt — backoff."
    etape "finisher-echec:fetch"
    exit 1
  fi
fi
git cat-file -e "$TARGET_SHA" 2>/dev/null || { log "CD ERREUR: SHA $TARGET_SHA inconnu du dépôt"; etape "finisher-echec:sha-inconnu"; exit 1; }

# --- BLACKLIST (durcissement 2026-10-22 : elle était écrite mais jamais lue)
# Un SHA ayant déjà échoué (npm ci, extraction, health check) n'est plus
# jamais re-basculé : exit 3 — le workflow distingue ce cas et n'insiste pas.
if grep -qxF "$TARGET_SHA" "$FAILED_COMMITS" 2>/dev/null; then
  log "CD: SHA $TARGET_SHA blacklisté (échec antérieur enregistré) — abandon sans bascule."
  etape "finisher-echec:blackliste"
  exit 3
fi

# --- Idempotence : déjà déployé + site sain → rien à faire (retry SSH sûrs) ---
DEPLOYED=$(cat "$LAST_DEPLOYED" 2>/dev/null || git rev-parse HEAD)
if [ "$TARGET_SHA" = "$DEPLOYED" ] && curl -fsS -m 10 -o /dev/null http://127.0.0.1:3000/ 2>/dev/null; then
  log "CD: $TARGET_SHA déjà déployé et site en bonne santé — rien à faire."
  rm -f "$TAR_PATH"
  case "$0" in /tmp/*) rm -f "$0";; esac
  exit 0
fi

log "CD === DÉPLOIEMENT $TARGET_SHA (runner GitHub) ==="

# --- Dépendances staging : npm ci UNIQUEMENT si le lockfile a changé ---
STAGING_LOCK_HASH=$(sha256sum "$STAGING_DIR/package-lock.json" | cut -d' ' -f1)
if [ ! -x "$STAGING_DIR/node_modules/.bin/next" ] || [ "$STAGING_LOCK_HASH" != "$(cat "$STATE_DIR/lock-hash.txt" 2>/dev/null)" ]; then
  etape "finisher-npm-ci"
  log "CD: npm ci staging (lockfile $STAGING_LOCK_HASH)…"
  if ! (cd "$STAGING_DIR" && npm ci --include=dev --no-audit --no-fund) >> "$DEPLOY_LOG" 2>&1; then
    log "CD ÉCHEC npm ci — SHA blacklisté, production intacte."
    echo "$TARGET_SHA" >> "$FAILED_COMMITS"
    etape "finisher-echec:npm-ci"
    exit 1
  fi
  echo "$STAGING_LOCK_HASH" > "$STATE_DIR/lock-hash.txt"
fi

# --- Extraction du build livré par le runner (dans le staging) ---
# Durcissement 2026-10-28 (CD #133) : le tar a échoué sur un transfert
# corrompu — le canal SSH ne vérifiait JAMAIS l'intégrité avant extraction
# (le canal pull, lui, vérifie via sha256sum -c). On vérifie désormais le
# checksum publié par le runner AVANT de toucher au staging : un transfert
# incomplet est détecté en 1 s au lieu d'un tar à moitié extrait.
log "CD: vérification de l'intégrité du build livré…"
if [ -f "$TAR_PATH.sha256" ]; then
  if ! (cd "$(dirname "$TAR_PATH")" && sha256sum -c "$(basename "$TAR_PATH").sha256" >/dev/null 2>&1); then
    # Code 4 = transfert SCP corrompu. AUCUN blacklist : la corruption est un
    # problème du CHEMIN de transfert SSH, pas du build lui-même — la release
    # cd-latest (téléchargée par le canal pull avec vérification checksum
    # propre) reste intègre et DOIT rester déployable pour ce même SHA.
    # Blacklister ici empoisonnerait le canal pull (FAILED_COMMITS partagé) —
    # c'est exactement le blocage observé sur 7d45b992/9b3df9ad (CD #133/#134).
    log "CD ERREUR: checksum du build INVALIDE (transfert SSH corrompu/incomplet) — PAS de blacklist (le canal pull reprendra ce même SHA depuis la release, intègre)."
    etape "finisher-echec:checksum"
    exit 4
  fi
  log "CD: checksum build OK."
else
  log "CD AVERTISSEMENT: .sha256 absent (ancien canal ?) — extraction sans vérification d'intégrité."
fi
etape "finisher-extraction"
log "CD: extraction du build runner dans staging…"
rm -rf "$STAGING_DIR/.next"
mkdir -p "$STAGING_DIR/.next"
if ! tar xzf "$TAR_PATH" -C "$STAGING_DIR/.next"; then
  LIBRE_TAR=$(libre_mo)
  log "CD ERREUR: extraction tar (libre restant : ${LIBRE_TAR:-?} Mo) — SHA blacklisté, production intacte."
  echo "$TARGET_SHA" >> "$FAILED_COMMITS"
  etape "finisher-echec:extraction"
  exit 1
fi
[ -f "$STAGING_DIR/.next/BUILD_ID" ] || { log "CD ERREUR: BUILD_ID absent — blacklist."; echo "$TARGET_SHA" >> "$FAILED_COMMITS"; etape "finisher-echec:build-id"; exit 1; }
log "CD: BUILD_ID=$(cat "$STAGING_DIR/.next/BUILD_ID")"

# --- Mise en production atomique ---
etape "finisher-swap"
log "CD: sync code source + swap .next + redémarrage…"
if [ "$SYNC_SOURCE" = "1" ]; then
  cd "$PROD_DIR"
  git reset --hard "$TARGET_SHA" >> "$DEPLOY_LOG" 2>&1 || { log "CD ERREUR: git reset — production intacte."; etape "finisher-echec:reset"; exit 1; }
else
  log "CD MODE DÉGRADÉ: sync source sautée (fetch impossible) — .next/node_modules restent la vérité servie."
fi
rm -rf .next.old
mv .next .next.old
cp -al "$STAGING_DIR/.next" .next || { log "CD ERREUR: cp -al — restauration."; mv .next.old .next; etape "finisher-echec:swap"; exit 1; }

# BASCULE COMPLÈTE de node_modules avec version précédente conservée
# (durcissement 2026-10-22) : l'ancien rsync mettait les NOUVELLES deps en
# place AVANT le health check — en cas de rollback, la prod restait avec
# l'ancien .next + les NOUVELLES deps (couple incohérent). Désormais :
# .next.old + node_modules.old = couple cohérent de rollback. cp -al =
# liens matériels (même FS) : coût quasi nul, cohérence exacte avec le
# node_modules validé du staging.
if [ -x "$STAGING_DIR/node_modules/.bin/next" ]; then
  rm -rf node_modules.old
  if [ -d node_modules ]; then
    mv node_modules node_modules.old || { log "CD AVERTISSEMENT: mv node_modules → .old impossible — l'ancien arbre reste en place."; }
  fi
  if ! cp -al "$STAGING_DIR/node_modules" node_modules; then
    log "CD ERREUR: bascule node_modules impossible — restauration de l'ancien arbre."
    if [ -d node_modules.old ] && [ ! -d node_modules ]; then mv node_modules.old node_modules; fi
    echo "$TARGET_SHA" >> "$FAILED_COMMITS"
    etape "finisher-echec:node-modules"
    exit 1
  fi
else
  log "CD AVERTISSEMENT: staging sans node_modules/.bin/next — node_modules inchangé."
fi

# --- Manifeste de version (mise à jour forcée navigateur, plan 4 étapes)
# 2026-10-23 : le runner l'a compilé à côté du BUILD_ID (.next/version.json,
# embarqué dans le tar car il ne contient que .next). Il est copié dans
# public/ APRÈS le git reset --hard (qui ne connaît que les fichiers
# suivis — le manifeste est un artefact gitignored). Absent (build
# antérieur au mécanisme) : repli silencieux sur la version suivie par git.
if [ -f "$STAGING_DIR/.next/version.json" ]; then
  cp "$STAGING_DIR/.next/version.json" "$PROD_DIR/public/version.json" \
    || log "CD AVERTISSEMENT: copie de version.json impossible — manifeste git conservé."
fi

pm2 restart gen3ia --update-env >> "$DEPLOY_LOG" 2>&1

# --- Health check : rollback si le nouveau build ne répond pas ---
etape "finisher-sante"
sleep 5
HEALTH_OK=0
for i in 1 2 3 4 5 6; do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -m 10 http://127.0.0.1:3000/ 2>/dev/null)
  if [ "$CODE" = "200" ]; then HEALTH_OK=1; break; fi
  log "CD health check $i/6 : HTTP $CODE — nouvelle tentative dans 15 s…"
  sleep 15
done

if [ "$HEALTH_OK" != "1" ]; then
  log "CD ÉCHEC DÉMARRAGE — ROLLBACK vers la version précédente."
  etape "finisher-echec:sante-rollback"
  rm -rf .next
  mv .next.old .next
  if [ -d node_modules.old ]; then
    rm -rf node_modules
    mv node_modules.old node_modules
  fi
  pm2 restart gen3ia --update-env >> "$DEPLOY_LOG" 2>&1
  echo "$TARGET_SHA" >> "$FAILED_COMMITS"
  log "CD Rollback appliqué (.next + node_modules cohérents) — site sur la version précédente, SHA blacklisté."
  exit 2
fi

# --- Succès ---
rm -rf .next.old node_modules.old
echo "$TARGET_SHA" > "$LAST_DEPLOYED"

# --- Auto-sync du poller pull (boucle d'auto-guérison sans SSH) ---
# Le poller PM2 exécute /opt/gen3ia-updater/pull-deploy.sh — une copie
# installée une fois, qui ne suit pas le dépôt. On la remplace par la
# version AU SHA DÉPLOYÉ : chaque déploiement réussi aligne le poller
# (correctifs pull-deploy v2, backoff, self-update…). Non fatal :
# un échec réseau ici n'invalide jamais un déploiement sain.
POLLER_SRC="https://raw.githubusercontent.com/missock237-spec/gen3ia/$TARGET_SHA/scripts/vps-auto-deploy/pull-deploy.sh"
if curl -fsSL -m 20 "$POLLER_SRC" -o "$UPDATER_DIR/pull-deploy.sh.new" 2>/dev/null \
   && [ -s "$UPDATER_DIR/pull-deploy.sh.new" ] \
   && head -1 "$UPDATER_DIR/pull-deploy.sh.new" | grep -q '^#!'; then
  if ! cmp -s "$UPDATER_DIR/pull-deploy.sh.new" "$UPDATER_DIR/pull-deploy.sh" 2>/dev/null; then
    mv "$UPDATER_DIR/pull-deploy.sh.new" "$UPDATER_DIR/pull-deploy.sh"
    chmod +x "$UPDATER_DIR/pull-deploy.sh"
    log "CD: poller pull-deploy.sh aligné sur le SHA $TARGET_SHA."
  else
    rm -f "$UPDATER_DIR/pull-deploy.sh.new"
  fi
else
  rm -f "$UPDATER_DIR/pull-deploy.sh.new" 2>/dev/null || true
  log "CD: sync du poller skippé (source inaccessible) — version courante conservée."
fi

log "CD DÉPLOIEMENT RÉUSSI : $(git log --oneline -1 | head -c 120)"
etape "finisher-ok"
exit 0
