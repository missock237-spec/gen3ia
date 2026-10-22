#!/bin/bash
# =====================================================================
# Gen3ia — Déploiement d'un commit GitHub vers la production VPS.
# Conçu pour être appelé par auto-update.sh (poller) ou à la main.
#
# GARANTIES « sans destruction d'état » :
#   · .env.production (gitignored) n'est JAMAIS modifié ni supprimé ;
#   · le build se fait dans un worktree STAGING séparé : l'app courante
#     continue de servir pendant tout le build (~15 min) ;
#   · le swap de .next est atomique (mv) avec conservation de la version
#     précédente (.next.old) jusqu'au health check ;
#   · health check post-restart : en cas d'échec, ROLLBACK automatique
#     vers .next.old et redémarrage — le site reste en ligne ;
#   · un commit dont le build ou le démarrage échoue est blacklisté
#     (failed_commits.txt) : jamais de boucle de crash.
# =====================================================================
set -uo pipefail

PROD_DIR=/opt/gen3ia
STAGING_DIR=/opt/gen3ia-staging
UPDATER_DIR=/opt/gen3ia-updater
STATE_DIR=$UPDATER_DIR/state
LAST_DEPLOYED=$STATE_DIR/last-deployed.txt
FAILED_COMMITS=$STATE_DIR/failed_commits.txt
DEPLOY_LOG=$STATE_DIR/deploy.log
BRANCH=origin/main

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$DEPLOY_LOG"; echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

mkdir -p "$STATE_DIR"
touch "$FAILED_COMMITS"

# --- Un seul déploiement à la fois ---
exec 9>"$STATE_DIR/deploy.lock"
if ! flock -n 9; then log "Un déploiement est déjà en cours — abandon."; exit 0; fi

# --- 1. Synchronisation git ---
cd "$PROD_DIR" || { log "ERREUR: $PROD_DIR introuvable"; exit 1; }
git fetch origin --quiet || { log "ERREUR: git fetch a échoué (réseau ?)"; exit 1; }
TARGET_SHA=$(git rev-parse "$BRANCH") || exit 1
DEPLOYED_SHA=$(cat "$LAST_DEPLOYED" 2>/dev/null || git rev-parse HEAD)

if [ "$TARGET_SHA" = "$DEPLOYED_SHA" ]; then
  exit 0  # rien de neuf — silence pour le poller
fi

if grep -qxF "$TARGET_SHA" "$FAILED_COMMITS"; then
  log "SKIP: commit $TARGET_SHA précédemment en échec (blacklist)."
  exit 0
fi

log "=== DÉPLOIEMENT $TARGET_SHA (actuel: $DEPLOYED_SHA) ==="

# --- 2. Préparation du worktree staging (créé une seule fois) ---
if [ ! -d "$STAGING_DIR/.git" ] && [ ! -f "$STAGING_DIR/.git" ]; then
  log "Création initiale du worktree staging…"
  git worktree add --detach "$STAGING_DIR" "$BRANCH" >> "$DEPLOY_LOG" 2>&1 || { log "ERREUR: worktree add"; exit 1; }
fi
git -C "$STAGING_DIR" fetch origin --quiet >> "$DEPLOY_LOG" 2>&1
git -C "$STAGING_DIR" reset --hard "$BRANCH" >> "$DEPLOY_LOG" 2>&1 || { log "ERREUR: reset staging"; exit 1; }

# Variables d'environnement préservées : le staging build avec le
# .env.production de la production (symlink — jamais copié, jamais écrasé).
ln -sf "$PROD_DIR/.env.production" "$STAGING_DIR/.env.production"

# --- 3. Dépendances : npm ci UNIQUEMENT si le lockfile a changé ---
STAGING_LOCK_HASH=$(sha256sum "$STAGING_DIR/package-lock.json" | cut -d' ' -f1)
if [ ! -x "$STAGING_DIR/node_modules/.bin/next" ] || [ "$STAGING_LOCK_HASH" != "$(cat "$STATE_DIR/lock-hash.txt" 2>/dev/null)" ]; then
  log "Dépendances staging : npm ci (lockfile $STAGING_LOCK_HASH)…"
  if ! (cd "$STAGING_DIR" && npm ci --include=dev --no-audit --no-fund) >> "$DEPLOY_LOG" 2>&1; then
    log "ÉCHEC npm ci — commit blacklisté, production intacte."
    echo "$TARGET_SHA" >> "$FAILED_COMMITS"
    exit 1
  fi
  echo "$STAGING_LOCK_HASH" > "$STATE_DIR/lock-hash.txt"
fi

# --- 4. Build dans le staging (l'app en ligne continue de servir) ---
log "Build production (staging)…"
if ! (cd "$STAGING_DIR" && NODE_OPTIONS="--max-old-space-size=2560" npm run build) >> "$DEPLOY_LOG" 2>&1; then
  log "ÉCHEC BUILD — commit blacklisté, production intacte."
  echo "$TARGET_SHA" >> "$FAILED_COMMITS"
  exit 1
fi
[ -f "$STAGING_DIR/.next/BUILD_ID" ] || { log "ÉCHEC BUILD (.next/BUILD_ID absent) — blacklist."; echo "$TARGET_SHA" >> "$FAILED_COMMITS"; exit 1; }

# --- 5. Mise en production atomique ---
log "Swap .next + code + redémarrage…"
cd "$PROD_DIR"
git reset --hard "$BRANCH" >> "$DEPLOY_LOG" 2>&1   # code source + public/ (gitignore protège .env/.next/node_modules)
rm -rf .next.old
mv .next .next.old
cp -al "$STAGING_DIR/.next" .next
if [ -x "$STAGING_DIR/node_modules/.bin/next" ]; then
  rsync -a --delete "$STAGING_DIR/node_modules/" "$PROD_DIR/node_modules/" >> "$DEPLOY_LOG" 2>&1 || log "AVERTISSEMENT: rsync node_modules partiel (non bloquant)"
fi
pm2 restart gen3ia --update-env >> "$DEPLOY_LOG" 2>&1

# --- 6. Health check : rollback si le nouveau build ne répond pas ---
sleep 5
HEALTH_OK=0
for i in 1 2 3 4 5 6; do
  if curl -fsS -m 10 -o /dev/null http://127.0.0.1:3000/ 2>/dev/null; then HEALTH_OK=1; break; fi
  log "Health check $i/6 : pas encore prêt, nouvelle tentative dans 15 s…"
  sleep 15
done

if [ "$HEALTH_OK" != "1" ]; then
  log "ÉCHEC DÉMARRAGE — ROLLBACK vers la version précédente."
  rm -rf .next
  mv .next.old .next
  pm2 restart gen3ia --update-env >> "$DEPLOY_LOG" 2>&1
  echo "$TARGET_SHA" >> "$FAILED_COMMITS"
  log "Rollback appliqué — commit blacklisté, site sur la version précédente."
  exit 1
fi

# --- 7. Daemon pipeline d'auto-apprentissage (NON BLOQUANT) ---
# Le site est déjà swappé et sain : toute erreur ci-dessous est
# journalisée mais ne fait JAMAIS échouer le déploiement ni retenter
# un rollback. Le daemon scrape en tâche de fond et alimente le corpus
# (JSONL partagé) — cf. pipeline/README.md.
if [ -d "$PROD_DIR/pipeline" ]; then
  log "Pipeline : mise à jour du daemon d'auto-apprentissage…"
  (
    cd "$PROD_DIR/pipeline" || exit 0
    mkdir -p logs data

    # Secret d'ingestion : copie locale depuis .env.production (jamais
    # commité, jamais affiché) — permet au daemon de déclencher
    # /api/cron/knowledge-ingest (Bearer CRON_SECRET).
    if [ -f "$PROD_DIR/.env.production" ] && grep -q '^CRON_SECRET=' "$PROD_DIR/.env.production"; then
      grep '^CRON_SECRET=' "$PROD_DIR/.env.production" > .env.cron
      if [ -f .env ]; then
        grep -v '^CRON_SECRET=' .env >> .env.cron 2>/dev/null || true
      fi
      mv .env.cron .env
      chmod 600 .env
    fi

    # Dépendances : npm ci UNIQUEMENT si le lockfile du pipeline a changé.
    PIPELINE_LOCK_HASH=$(sha256sum package-lock.json 2>/dev/null | cut -d' ' -f1)
    if [ ! -d node_modules ] || [ "$PIPELINE_LOCK_HASH" != "$(cat "$STATE_DIR/pipeline-lock-hash.txt" 2>/dev/null)" ]; then
      log "Pipeline : npm ci (lockfile $PIPELINE_LOCK_HASH)…"
      npm ci --omit=dev --no-audit --no-fund >> "$DEPLOY_LOG" 2>&1 \
        || npm install --omit=dev --no-audit --no-fund >> "$DEPLOY_LOG" 2>&1 \
        || { log "AVERTISSEMENT: npm pipeline en échec (daemon non mis à jour)"; exit 0; }
      echo "$PIPELINE_LOCK_HASH" > "$STATE_DIR/pipeline-lock-hash.txt"
    fi

    # Build TypeScript du daemon (léger : winston seul).
    if npm run build >> "$DEPLOY_LOG" 2>&1; then
      pm2 restart gen3ia-pipeline --update-env >> "$DEPLOY_LOG" 2>&1 \
        || pm2 start "$PROD_DIR/pipeline/ecosystem.config.js" >> "$DEPLOY_LOG" 2>&1 \
        || log "AVERTISSEMENT: démarrage PM2 du pipeline en échec"
      log "Pipeline : daemon à jour et (re)démarré."
    else
      log "AVERTISSEMENT: build pipeline en échec (daemon sur la version précédente)"
    fi
  ) || true
fi

# --- 8. Succès ---
rm -rf .next.old
echo "$TARGET_SHA" > "$LAST_DEPLOYED"
log "DÉPLOIEMENT RÉUSSI : $(git log --oneline -1 | head -c 120)"
exit 0
