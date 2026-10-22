#!/bin/bash
# =====================================================================
# Gen3ia — Bascule en production d'un build compilé par le runner GitHub.
# Appelé par le workflow « Déploiement continu VPS » (deploy-vps.yml).
#
# Différence avec deploy.sh : PAS de build ici — le runner GitHub (7 Go)
# a déjà compilé, ce VPS (2 Go) ne le peut pas (OOM). Ce script applique
# les mêmes GARANTIES « sans destruction d'état » :
#   · .env.production (gitignored) jamais modifié ni supprimé ;
#   · le .next du runner arrive dans le worktree STAGING : l'app courante
#     continue de servir pendant tout le transfert ;
#   · swap de .next atomique (mv + cp -al) avec conservation de la version
#     précédente (.next.old) jusqu'au health check ;
#   · health check post-restart : en cas d'échec, ROLLBACK automatique
#     vers .next.old — le site reste en ligne ;
#   · un SHA en échec est blacklisté (failed_commits.txt) — jamais de
#     boucle de crash ;
#   · l'updater PM2 est suspendu pendant la bascule (trap : relancé dans
#     tous les cas) pour éviter la course avec le poller deploy.sh.
#
# Usage : bash cd-finisher.sh <SHA_DE_MAIN_A_DEPLOYER>
# =====================================================================
set -u

TARGET_SHA="${1:?Usage: cd-finisher.sh <SHA>}"
PROD_DIR=/opt/gen3ia
STAGING_DIR=/opt/gen3ia-staging
UPDATER_DIR=/opt/gen3ia-updater
STATE_DIR=$UPDATER_DIR/state
LAST_DEPLOYED=$STATE_DIR/last-deployed.txt
FAILED_COMMITS=$STATE_DIR/failed_commits.txt
DEPLOY_LOG=$STATE_DIR/deploy.log

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$DEPLOY_LOG"; echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

mkdir -p "$STATE_DIR"
touch "$FAILED_COMMITS"
export PATH=$PATH:/usr/local/bin:/usr/bin

# --- Un seul déploiement à la fois ---
exec 9>"$STATE_DIR/deploy.lock"
if ! flock -n 9; then log "CD: un déploiement est déjà en cours — abandon."; exit 1; fi

# --- Suspendre l'updater (relancé par trap dans tous les cas) ---
pm2 stop updater >/dev/null 2>&1 || true
# trap combiné : updater relancé + artefacts temporaires purgés (aucun tar
# orphelin dans /tmp, même en cas d'échec) — durcissement 2026-10-22.
trap 'pm2 start updater >/dev/null 2>&1 || true; rm -f /tmp/next-build.tar.gz /tmp/cd-finisher.sh' EXIT

# --- Vérifier le SHA cible ---
[ -f /tmp/next-build.tar.gz ] || { log "CD ERREUR: /tmp/next-build.tar.gz absent (scp a échoué ?)"; exit 1; }
cd "$PROD_DIR" || { log "CD ERREUR: $PROD_DIR introuvable"; exit 1; }
git fetch origin --quiet || { log "CD ERREUR: git fetch a échoué (réseau ?)"; exit 1; }
git cat-file -e "$TARGET_SHA" 2>/dev/null || { log "CD ERREUR: SHA $TARGET_SHA inconnu du dépôt"; exit 1; }

# --- BLACKLIST (durcissement 2026-10-22 : elle était écrite mais jamais lue)
# Un SHA ayant déjà échoué (npm ci, extraction, health check) n'est plus
# jamais re-basculé : exit 3 — le workflow distingue ce cas et n'insiste pas.
if grep -qxF "$TARGET_SHA" "$FAILED_COMMITS" 2>/dev/null; then
  log "CD: SHA $TARGET_SHA blacklisté (échec antérieur enregistré) — abandon sans bascule."
  exit 3
fi

# --- Idempotence : déjà déployé + site sain → rien à faire (retry SSH sûrs) ---
DEPLOYED=$(cat "$LAST_DEPLOYED" 2>/dev/null || git rev-parse HEAD)
if [ "$TARGET_SHA" = "$DEPLOYED" ] && curl -fsS -m 10 -o /dev/null http://127.0.0.1:3000/ 2>/dev/null; then
  log "CD: $TARGET_SHA déjà déployé et site en bonne santé — rien à faire."
  rm -f /tmp/next-build.tar.gz /tmp/cd-finisher.sh
  exit 0
fi

log "CD === DÉPLOIEMENT $TARGET_SHA (runner GitHub) ==="

# --- Dépendances staging : npm ci UNIQUEMENT si le lockfile a changé ---
STAGING_LOCK_HASH=$(sha256sum "$STAGING_DIR/package-lock.json" | cut -d' ' -f1)
if [ ! -x "$STAGING_DIR/node_modules/.bin/next" ] || [ "$STAGING_LOCK_HASH" != "$(cat "$STATE_DIR/lock-hash.txt" 2>/dev/null)" ]; then
  log "CD: npm ci staging (lockfile $STAGING_LOCK_HASH)…"
  if ! (cd "$STAGING_DIR" && npm ci --include=dev --no-audit --no-fund) >> "$DEPLOY_LOG" 2>&1; then
    log "CD ÉCHEC npm ci — SHA blacklisté, production intacte."
    echo "$TARGET_SHA" >> "$FAILED_COMMITS"
    exit 1
  fi
  echo "$STAGING_LOCK_HASH" > "$STATE_DIR/lock-hash.txt"
fi

# --- Extraction du build livré par le runner (dans le staging) ---
log "CD: extraction du build runner dans staging…"
rm -rf "$STAGING_DIR/.next"
mkdir -p "$STAGING_DIR/.next"
if ! tar xzf /tmp/next-build.tar.gz -C "$STAGING_DIR/.next"; then
  log "CD ERREUR: extraction tar — SHA blacklisté, production intacte."
  echo "$TARGET_SHA" >> "$FAILED_COMMITS"
  exit 1
fi
[ -f "$STAGING_DIR/.next/BUILD_ID" ] || { log "CD ERREUR: BUILD_ID absent — blacklist."; echo "$TARGET_SHA" >> "$FAILED_COMMITS"; exit 1; }
log "CD: BUILD_ID=$(cat "$STAGING_DIR/.next/BUILD_ID")"

# --- Mise en production atomique ---
log "CD: sync code source + swap .next + redémarrage…"
cd "$PROD_DIR"
git reset --hard "$TARGET_SHA" >> "$DEPLOY_LOG" 2>&1 || { log "CD ERREUR: git reset — production intacte."; exit 1; }
rm -rf .next.old
mv .next .next.old
cp -al "$STAGING_DIR/.next" .next || { log "CD ERREUR: cp -al — restauration."; mv .next.old .next; exit 1; }

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
    exit 1
  fi
else
  log "CD AVERTISSEMENT: staging sans node_modules/.bin/next — node_modules inchangé."
fi
pm2 restart gen3ia --update-env >> "$DEPLOY_LOG" 2>&1

# --- Health check : rollback si le nouveau build ne répond pas ---
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
log "CD DÉPLOIEMENT RÉUSSI : $(git log --oneline -1 | head -c 120)"
exit 0
