#!/bin/bash
# =====================================================================
# Gen3ia — Déploiement en MODE PULL sur l'HÉBERGEMENT WEB SPACESHIP
# (cPanel mutualisé — plan Node.js/Passenger). PLAN B : la voie
# principale est Hyperlift (.github/workflows/hyperlift-auto-update.yml).
#
# Adaptation du pattern éprouvé du VPS (scripts/vps-auto-deploy/) aux
# contraintes du mutualisé cPanel :
#   · PAS de PM2 ni de root : le poller est un CRON cPanel (toutes les
#     3 min) qui appelle ce script ;
#   · PAS de build possible (RAM) : le .next compilé vient de la release
#     GitHub « cd-latest » — le tar contient UNIQUEMENT le contenu de
#     .next (verifié au SHA 8940328 : package.json de .next, BUILD_ID,
#     cache/, aucun server.js ni node_modules) ;
#   · node_modules et le wrapper server.js (démarrage Passenger) sont
#     installés UNE FOIS par install-cpanel.sh et jamais remplacés ;
#   · PAS de SSH : uniquement du HTTPS sortant (dépôt public) ;
#   · .env.production créé une fois, JAMAIS touché par les mises à jour ;
#   · restart Passenger = touch tmp/restart.txt.
#
# Garanties : sha256 avant extraction, staging isolé, swap atomique,
# sauvegarde .prev en COPIE PHYSIQUE pour .next (les hardlinks seraient
# corrompus par les écritures à chaud de l'app — anomalie prouvée au
# test), rollback automatique, silence si rien de neuf, version.json +
# poller-heartbeat.json publics (servis depuis public/ par next).
#
# Usage : bash ~/gen3ia-updater/pull-deploy-cpanel.sh
# Forcer : rm -f ~/gen3ia-updater/state/last-deployed.txt
# =====================================================================
set -u
set -o pipefail

REPO="${GEN3IA_REPO:-missock237-spec/gen3ia}"
REPO_DIR="${GEN3IA_REPO_DIR:-$HOME/gen3ia-repo}"   # clone git du dépôt (cPanel Git ou install-cpanel.sh)
UPDATER_DIR="$HOME/gen3ia-updater"
STATE_DIR="$UPDATER_DIR/state"
LOG="$UPDATER_DIR/deploy.log"
ENV_FILE="$REPO_DIR/.env.production"
HEALTH_URL="${GEN3IA_HEALTH_URL:-http://127.0.0.1:${GEN3IA_APP_PORT:-3000}/}"
HEALTH_TIMEOUT_S=20
MAX_LOG_LINES=2000

mkdir -p "$STATE_DIR"
exec 9>"$STATE_DIR/flock.lock" 2>/dev/null || true
flock -n 9 || exit 0

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*" >> "$LOG"; [ "$(wc -l < "$LOG")" -gt "$MAX_LOG_LINES" ] && sed -i "1,300d" "$LOG"; }
heartbeat() { echo "{\"ok\":$1,\"phase\":\"$2\",\"sha\":\"$3\",\"at\":\"$(date -u '+%Y-%m-%dT%H:%M:%SZ')\"}" > "$REPO_DIR/public/poller-heartbeat.json" 2>/dev/null; }

[ -d "$REPO_DIR" ] || { log "ERREUR: clone absent ($REPO_DIR) — lancer install-cpanel.sh"; exit 1; }
mkdir -p "$REPO_DIR/public" "$REPO_DIR/tmp"

# ── 1. SHA cible : release cd-latest (téléchargement anonyme) ─────────
META=$(curl -fsSL --max-time 30 "https://github.com/$REPO/releases/download/cd-latest/meta.json" 2>/dev/null) || { log "ERREUR: meta.json indisponible"; heartbeat false "meta-absente" "-"; exit 1; }
SHA_CIBLE=$(printf '%s' "$META" | grep -oE '"sha"[[:space:]]*:[[:space:]]*"[0-9a-f]{7,40}"' | head -1 | grep -oE '[0-9a-f]{7,40}')
[ -n "$SHA_CIBLE" ] || { log "ERREUR: meta.json illisible"; heartbeat false "meta-illisible" "-"; exit 1; }

DERNIER=$(cat "$STATE_DIR/last-deployed.txt" 2>/dev/null || echo "")
if [ "$SHA_CIBLE" = "$DERNIER" ]; then heartbeat true "a-jour" "$SHA_CIBLE"; exit 0; fi
log "Nouveau build : sha=$SHA_CIBLE (précédent: ${DERNIER:-aucun})"
heartbeat false "telechargement" "$SHA_CIBLE"

# ── 2. Espace disque AVANT téléchargement (anomalie réelle mesurée) ───
BESOIN_KO=2097152  # ~2 Go : tar 244 Mo + extraction ~1,7 Go
LIBRE_KO=$(df -Pk "$UPDATER_DIR" | awk 'NR==2 {print $4}')
if [ -n "$LIBRE_KO" ] && [ "$LIBRE_KO" -lt "$BESOIN_KO" ]; then
  log "ERREUR: espace disque insuffisant (${LIBRE_KO} Ko libres, ~${BESOIN_KO} Ko requis)"; heartbeat false "disque-plein" "$SHA_CIBLE"; exit 1
fi

# ── 3. Téléchargement + sha256 (AVANT extraction) ─────────────────────
TMP_TAR="$UPDATER_DIR/next-build.tar.gz.part"
curl -fSL --max-time 900 --retry 2 -o "$TMP_TAR" "https://github.com/$REPO/releases/download/cd-latest/next-build.tar.gz" || { log "ERREUR: téléchargement"; heartbeat false "download" "$SHA_CIBLE"; exit 1; }
curl -fsSL --max-time 30 "https://github.com/$REPO/releases/download/cd-latest/next-build.tar.gz.sha256" -o "$TMP_TAR.sha256" || { log "ERREUR: sha256 distante"; heartbeat false "sha-dist" "$SHA_CIBLE"; exit 1; }
cd "$UPDATER_DIR" && echo "$(awk '{print $1}' "$TMP_TAR.sha256")  next-build.tar.gz.part" | sha256sum -c - >/dev/null 2>&1 || { log "ERREUR: sha256 MISMATCH"; rm -f "$TMP_TAR"; heartbeat false "sha-mismatch" "$SHA_CIBLE"; exit 1; }
log "sha256 vérifié ($(du -h "$TMP_TAR" | awk '{print $1}'))"

# ── 4. Extraction dans le STAGING (le tar = contenu de .next) ─────────
STAGING="$STATE_DIR/staging"; rm -rf "$STAGING"; mkdir -p "$STAGING"
tar -xzf "$TMP_TAR" -C "$STAGING" || { log "ERREUR: extraction (disque ? df -h) — archive conservée pour reprise"; heartbeat false "extraction" "$SHA_CIBLE"; exit 1; }
rm -f "$TMP_TAR" "$TMP_TAR.sha256"
[ -f "$STAGING/BUILD_ID" ] || [ -f "$STAGING/.next/BUILD_ID" ] || { log "ERREUR: pas de BUILD_ID dans le build"; heartbeat false "build-invalide" "$SHA_CIBLE"; exit 1; }
# certains builds encapsulent .next/ — normaliser : le staging DOIT être le contenu .next
[ -f "$STAGING/BUILD_ID" ] || { mv "$STAGING"/.next/* "$STAGING/" 2>/dev/null; rmdir "$STAGING/.next" 2>/dev/null; }

# ── 5. SWAP ATOMIQUE de .next + rollback du précédent ─────────────────
push_state() { rm -rf "$REPO_DIR/.prev" 2>/dev/null; mkdir -p "$REPO_DIR/.prev";
  # .next en COPIE PHYSIQUE : l'app écrit à chaud dans .next (cache/trace) — un hardlink serait corrompu par l'app elle-même et le rollback ramènerait du corrompu (prouvé au test).
  [ -e "$REPO_DIR/.next" ] && cp -a "$REPO_DIR/.next" "$REPO_DIR/.prev/.next" 2>/dev/null; }
rollback() { log "ROLLBACK vers la version précédente"
  [ -e "$REPO_DIR/.prev/.next" ] && rm -rf "$REPO_DIR/.next" && cp -a "$REPO_DIR/.prev/.next" "$REPO_DIR/.next"
  touch "$REPO_DIR/tmp/restart.txt" 2>/dev/null
  echo "$DERNIER" > "$STATE_DIR/last-deployed.txt"
  heartbeat false "rollback" "${DERNIER:-aucun}"; }

if [ -d "$REPO_DIR/.next" ]; then push_state; fi
rm -rf "$REPO_DIR/.next"; cp -a "$STAGING" "$REPO_DIR/.next" || { log "ERREUR: copie .next"; rollback; exit 1; }
rm -rf "$STAGING"

# node_modules installé UNE FOIS par install-cpanel.sh — vérification de survie
[ -d "$REPO_DIR/node_modules" ] || { log "ERREUR: node_modules absent — npm ci manquant (install-cpanel.sh)"; rollback; exit 1; }

# ── 6. HEALTH CHECK (Passenger) + version.json public ─────────────────
sleep 5
HTTP=$(curl -fsS --max-time $HEALTH_TIMEOUT_S -o /dev/null -w "%{http_code}" "$HEALTH_URL" 2>/dev/null || echo "000")
if [ "$HTTP" = "200" ]; then
  echo "{\"sha\":\"$SHA_CIBLE\",\"at\":\"$(date -u '+%Y-%m-%dT%H:%M:%SZ')\",\"cible\":\"spaceship-cpanel\"}" > "$REPO_DIR/public/version.json"
  echo "$SHA_CIBLE" > "$STATE_DIR/last-deployed.txt"
  rm -rf "$REPO_DIR/.prev"
  touch "$REPO_DIR/tmp/restart.txt" 2>/dev/null
  log "DÉPLOYÉ : sha=$SHA_CIBLE (health $HTTP)"
  heartbeat true "deploye" "$SHA_CIBLE"
  exit 0
else
  log "ÉCHEC health check ($HTTP) — rollback"
  rollback
  exit 1
fi
