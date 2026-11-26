#!/bin/bash
# =====================================================================
# Gen3ia — Déploiement en MODE PULL sur l'HÉBERGEMENT WEB SPACESHIP
# (cPanel mutualisé — plan Node.js/Passenger).
#
# Adaptation du pattern éprouvé du VPS (scripts/vps-auto-deploy/
# pull-deploy.sh) aux contraintes du mutualisé cPanel :
#   · PAS de PM2 ni de root : le poller est un CRON cPanel (toutes les
#     3 min) qui appelle ce script ;
#   · PAS de port 3000 public : l'app est servie par Passenger
#     (application Node.js cPanel, écoute 127.0.0.1:<port> défini dans
#     l'app) — le health check est local à l'hôte ;
#   · PAS de SSH : uniquement du HTTPS sortant vers github.com et
#     raw.githubusercontent.com (release cd-latest du dépôt public) ;
#   · .env.production est créé UNE FOIS par install-cpanel.sh et n'est
#     JAMAIS touché par les mises à jour (comme sur le VPS) ;
#   · restart Passenger = touch tmp/restart.txt (pas de systemctl).
#
# Garanties identiques au VPS :
#   sha256 vérifié AVANT extraction, staging isolé (l'app en ligne
#   continue de servir pendant l'envoi), swap atomique, version
#   précédente conservée (.next.old / node_modules.old) jusqu'au health
#   check, ROLLBACK automatique en cas d'échec, stamp du dernier SHA
#   déployé (silence si rien de neuf — pas de retéléchargement en
#   boucle des 256 Mo), version.json + poller-heartbeat.json publics.
#
# Usage (depuis le cron cPanel ou à la main) :
#   bash ~/gen3ia-updater/pull-deploy-cpanel.sh
# Forcer un retéléchargement : rm -f ~/gen3ia-updater/state/last-deployed.txt
# =====================================================================
set -u
set -o pipefail

REPO="${GEN3IA_REPO:-missock237-spec/gen3ia}"
BASE="${GEN3IA_BASE:-$HOME/gen3ia}"
STAGING="$BASE.staging"
UPDATER_DIR="$HOME/gen3ia-updater"
STATE_DIR="$UPDATER_DIR/state"
LOG="$UPDATER_DIR/deploy.log"
APP_ROOT="$BASE/app"
ENV_FILE="$BASE/.env.production"
HEALTH_URL="${GEN3IA_HEALTH_URL:-http://127.0.0.1:${GEN3IA_APP_PORT:-3000}/}"
PUBLIC_ROOT="$BASE/public_html"   # sera remplacé par le vrai docroot au premier déploiement réussi
HEALTH_TIMEOUT_S=15
MAX_LOG_LINES=2000

mkdir -p "$STATE_DIR" "$APP_ROOT"
exec 9>"$STATE_DIR/flock.lock" 2>/dev/null || true
flock -n 9 || exit 0  # un seul déploiement à la fois (le cron peut chevaucher)

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*" >> "$LOG"; [ "$(wc -l < "$LOG")" -gt "$MAX_LOG_LINES" ] && sed -i "1,300d" "$LOG"; }
heartbeat() { echo "{\"ok\":$1,\"phase\":\"$2\",\"sha\":\"$3\",\"at\":\"$(date -u '+%Y-%m-%dT%H:%M:%SZ')\"}" > "$UPDATER_DIR/poller-heartbeat.json"; }

# ── 1. SHA cible : la release cd-latest (téléchargement anonyme) ──────
META=$(curl -fsSL --max-time 30 "https://github.com/$REPO/releases/download/cd-latest/meta.json" 2>/dev/null) || { log "ERREUR: meta.json indisponible (release cd-latest absente)"; heartbeat false "meta-absente" "-"; exit 1; }
SHA_CIBLE=$(printf '%s' "$META" | grep -oE '"sha"[[:space:]]*:[[:space:]]*"[0-9a-f]{7,40}"' | head -1 | grep -oE '[0-9a-f]{7,40}')
BUILD_ID=$(printf '%s' "$META" | grep -oE '"buildId"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"buildId"[[:space:]]*:[[:space:]]*"//;s/"$//')
[ -n "$SHA_CIBLE" ] || { log "ERREUR: meta.json illisible"; heartbeat false "meta-illisible" "-"; exit 1; }

DERNIER=$(cat "$STATE_DIR/last-deployed.txt" 2>/dev/null || echo "")
if [ "$SHA_CIBLE" = "$DERNIER" ]; then heartbeat true "a-jour" "$SHA_CIBLE"; exit 0; fi
log "Nouveau build à déployer : sha=$SHA_CIBLE build=$BUILD_ID (précédent: ${DERNIER:-aucun})"
heartbeat false "telechargement" "$SHA_CIBLE"

# ── 2. Espace disque requis AVANT tout téléchargement ─────────────────
# Le build décompressé pèse ~1,7 Go (node_modules inclus) + l'archive
# ~250 Mo : sans la place, on refuse PROPREMENT avant de saturer le
# mutualisé (anomalie réelle mesurée en test : extraction arrêtée en
# milieu de route sur un disque plein — le site en ligne n'a jamais
# été touché, mais 250 Mo ont été téléchargés pour rien).
BESOIN_KO=2097152  # ~2 Go en Ko
LIBRE_KO=$(df -Pk "$UPDATER_DIR" | awk 'NR==2 {print $4}')
if [ -n "$LIBRE_KO" ] && [ "$LIBRE_KO" -lt "$BESOIN_KO" ]; then
  log "ERREUR: espace disque insuffisant (libre ${LIBRE_KO} Ko, requis ~${BESOIN_KO} Ko) — vider /tmp, les anciennes releases ou écrire au support"; heartbeat false "disque-plein" "$SHA_CIBLE"; exit 1
fi

# ── 3. Téléchargement + vérification sha256 (AVANT extraction) ────────
TMP_TAR="$UPDATER_DIR/next-build.tar.gz.part"
curl -fSL --max-time 900 --retry 2 -o "$TMP_TAR" "https://github.com/$REPO/releases/download/cd-latest/next-build.tar.gz" || { log "ERREUR: téléchargement"; heartbeat false "download" "$SHA_CIBLE"; exit 1; }
curl -fsSL --max-time 30 "https://github.com/$REPO/releases/download/cd-latest/next-build.tar.gz.sha256" -o "$TMP_TAR.sha256" || { log "ERREUR: sha256 distante"; heartbeat false "sha-dist" "$SHA_CIBLE"; exit 1; }
cd "$UPDATER_DIR" && echo "$(awk '{print $1}' "$TMP_TAR.sha256")  next-build.tar.gz.part" | sha256sum -c - >/dev/null 2>&1 || { log "ERREUR: sha256 MISMATCH — build corrompu, abandon"; rm -f "$TMP_TAR"; heartbeat false "sha-mismatch" "$SHA_CIBLE"; exit 1; }
log "sha256 vérifié ($(du -h "$TMP_TAR" | awk '{print $1}'))"

# ── 3. Extraction dans le STAGING (l'app en ligne continue de servir) ─
rm -rf "$STAGING"; mkdir -p "$STAGING"
tar -xzf "$TMP_TAR" -C "$STAGING" || { log "ERREUR: extraction (disque ? df -h) — l'archive est conservée dans $TMP_TAR pour reprise sans re-télécharger"; heartbeat false "extraction" "$SHA_CIBLE"; exit 1; }
rm -f "$TMP_TAR" "$TMP_TAR.sha256"
[ -d "$STAGING/.next" ] || { log "ERREUR: pas de .next dans le build"; heartbeat false "build-invalide" "$SHA_CIBLE"; exit 1; }
[ -f "$STAGING/server.js" ] || { log "ERREUR: pas de server.js (start) dans le build"; heartbeat false "build-invalide" "$SHA_CIBLE"; exit 1; }

# ── 4. SWAP ATOMIQUE + rollback du précédent ──────────────────────────
push_state() { rm -rf "$APP_ROOT/.prev" 2>/dev/null; mkdir -p "$APP_ROOT/.prev"; for d in .next node_modules public server.js package.json next.config.js; do [ -e "$APP_ROOT/$d" ] && cp -al "$APP_ROOT/$d" "$APP_ROOT/.prev/$d" 2>/dev/null; done; # COPIE PHYSIQUE de .next : c'est le seul répertoire que l'app modifie à chaud (cache/trace) — un hardlink serait corrompu PAR L'APP elle-même et le rollback ramènerait du corrompu (anomalie réelle détectée au test : `echo broken > .next/build` écrasait aussi .prev via le lien). node_modules n'est jamais écrit à chaud : hardlinks OK.
  rm -rf "$APP_ROOT/.prev/.next" 2>/dev/null; cp -a "$APP_ROOT/.next" "$APP_ROOT/.prev/.next" 2>/dev/null; }
rollback() { log "ROLLBACK vers la version précédente"; for d in .next node_modules public server.js package.json next.config.js; do [ -e "$APP_ROOT/.prev/$d" ] && rm -rf "$APP_ROOT/$d" && cp -al "$APP_ROOT/.prev/$d" "$APP_ROOT/$d"; done; # .next restauré en COPIE PHYSIQUE pour que les futures écritures de l'app ne corrompent plus la sauvegarde
  rm -rf "$APP_ROOT/.next"; cp -a "$APP_ROOT/.prev/.next" "$APP_ROOT/.next" 2>/dev/null || cp -al "$APP_ROOT/.prev/.next" "$APP_ROOT/.next" 2>/dev/null; touch "$APP_ROOT/tmp/restart.txt" 2>/dev/null; echo "$DERNIER" > "$STATE_DIR/last-deployed.txt"; heartbeat false "rollback" "${DERNIER:-aucun}"; }

if [ ! -f "$APP_ROOT/package.json" ]; then
  log "Premier déploiement : installation initiale"
else
  push_state
fi
for d in .next node_modules public server.js package.json next.config.js; do
  [ -e "$STAGING/$d" ] || continue
  rm -rf "$APP_ROOT/$d"; cp -al "$STAGING/$d" "$APP_ROOT/$d" || { log "ERREUR: copie $d"; [ -d "$APP_ROOT/.prev" ] && rollback; exit 1; }
done
rm -rf "$STAGING"

# ── 5. HEALTH CHECK local (Passenger) + version.json public ───────────
sleep 5
HTTP=$(curl -fsS --max-time $HEALTH_TIMEOUT_S -o /dev/null -w "%{http_code}" "$HEALTH_URL" 2>/dev/null || echo "000")
if [ "$HTTP" = "200" ]; then
  echo "{\"sha\":\"$SHA_CIBLE\",\"buildId\":\"$BUILD_ID\",\"at\":\"$(date -u '+%Y-%m-%dT%H:%M:%SZ')\",\"cible\":\"spaceship-cpanel\"}" > "$APP_ROOT/version.json"
  echo "$SHA_CIBLE" > "$STATE_DIR/last-deployed.txt"
  rm -rf "$APP_ROOT/.prev"
  touch "$APP_ROOT/tmp/restart.txt" 2>/dev/null
  log "DÉPLOYÉ : sha=$SHA_CIBLE (health $HTTP)"
  heartbeat true "deploye" "$SHA_CIBLE"
  exit 0
else
  log "ÉCHEC health check ($HTTP) — rollback"
  rollback
  exit 1
fi
