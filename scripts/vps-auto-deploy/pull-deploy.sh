#!/bin/bash
# =====================================================================
# Gen3ia — Déploiement en MODE PULL (aucun SSH entrant requis).
#
# Contexte : les IP de sortie GitHub Actions arrivent régulièrement
# déjà pénalisées/bannies côté sshd du VPS (PerSourcePenalties,
# fail2ban, bruit SSH partagé) — le transfert SCP du CD échoue alors
# pendant des heures (runs #79→#88, 2026-10-25).
#
# Principe : le runner GitHub compile ET publie le build sur la release
# GitHub « cd-latest » (dépôt public → téléchargement anonyme). Ce
# script tourne sur le VPS, appelé par le poller PM2 « updater »
# (toutes les 2 min) ou à la main. Uniquement du HTTPS SORTANT :
#   · github.com           (release assets)
#   · raw.githubusercontent.com (cd-finisher.sh au SHA cible)
#
# Garanties inchangées (déléguées à cd-finisher.sh) :
#   swap atomique, .env.production jamais touché, health check,
#   rollback automatique, blacklist des SHA en échec, flock.
#
# Usage : bash pull-deploy.sh            (poller ou manuel)
# Forcer un retéléchargement : rm -f /opt/gen3ia-updater/state/pull-current.txt
# =====================================================================
set -u

REPO=missock237-spec/gen3ia
UPDATER_DIR=/opt/gen3ia-updater
STATE_DIR=$UPDATER_DIR/state
PULL_STAMP=$STATE_DIR/pull-current.txt
DL_TAR=/tmp/next-build.tar.gz
DL_SHA=/tmp/next-build.tar.gz.sha256

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$STATE_DIR/deploy.log"; echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }
mkdir -p "$STATE_DIR" 2>/dev/null || true

# --- 1. Manifeste du dernier build publié (meta.json déposé en dernier
#        par le workflow : sa présence garantit un build complet) ---
CACHEBUST="$(date +%s)"
META=$(curl -fsSL -m 20 -H "Cache-Control: no-cache" \
  "https://github.com/$REPO/releases/download/cd-latest/meta.json?_=$CACHEBUST" 2>/dev/null) || {
  log "PULL: release cd-latest indisponible (aucun build runner publié ?) — silence."; exit 0; }

TARGET_SHA=$(printf '%s' "$META" | grep -o '"sha":"[0-9a-f]*"' | head -1 | sed 's/.*:"//; s/"$//')
[ -n "$TARGET_SHA" ] || { log "PULL: meta.json illisible — silence."; exit 0; }

# --- 2. Anti-reboucle poller : ce SHA est déjà en cours/échoué non
#        blacklisté par le finisher (un échec réseau ne doit pas faire
#        retélécharger 40 Mo toutes les 2 min) ---
if [ -f "$PULL_STAMP" ] && [ "$(cat "$PULL_STAMP" 2>/dev/null)" = "$TARGET_SHA" ]; then
  exit 0
fi
printf '%s' "$TARGET_SHA" > "$PULL_STAMP"

# --- 3. Téléchargement + intégrité ---
log "PULL: nouveau build $TARGET_SHA — téléchargement depuis la release cd-latest…"
curl -fsSL -m 600 -o "$DL_TAR" \
  "https://github.com/$REPO/releases/download/cd-latest/next-build.tar.gz?_=$CACHEBUST" || {
  log "PULL ERREUR: téléchargement du tar impossible — SHA laissé pour un poll suivant."; exit 1; }

curl -fsSL -m 30 -o "$DL_SHA" \
  "https://github.com/$REPO/releases/download/cd-latest/next-build.tar.gz.sha256?_=$CACHEBUST" || {
  log "PULL ERREUR: somme sha256 indisponible"; rm -f "$DL_TAR"; exit 1; }
(cd /tmp && sha256sum -c next-build.tar.gz.sha256) || {
  log "PULL ERREUR: intégrité du tar invalide — fichiers purgés."; rm -f "$DL_TAR" "$DL_SHA"; exit 1; }

# --- 4. Finisher versionné AU MÊME SHA (jamais une copie obsolète) ---
curl -fsSL -m 30 -o /tmp/cd-finisher.sh \
  "https://raw.githubusercontent.com/$REPO/$TARGET_SHA/infra/deploy/cd-finisher.sh" || {
  log "PULL ERREUR: cd-finisher.sh inaccessible au SHA $TARGET_SHA"; exit 1; }

# --- 5. Bascule (swap atomique + health check + rollback + blacklist) ---
bash /tmp/cd-finisher.sh "$TARGET_SHA"
CODE=$?
if [ "$CODE" -eq 0 ]; then
  log "PULL: déploiement $TARGET_SHA terminé avec succès."
  rm -f "$PULL_STAMP"
else
  log "PULL: cd-finisher.sh a retourné $CODE (blacklist/rollback éventuel) — stamp conservé."
fi
exit "$CODE"
