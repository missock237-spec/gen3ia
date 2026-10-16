#!/bin/bash
# =====================================================================
# Gen3ia — Installation du service sandbox d'exécution Docker (Task 151).
# Idempotent : peut être relancé sans risque.
#
# Produit :
#   /opt/gen3ia-sandbox/          : checkout dédié (clone local du prod)
#   images gen3ia-sandbox-node / gen3ia-sandbox-python
#   /etc/gen3ia-sandbox.env       : HOST/PORT/SECRET (chmod 600)
#   gen3ia-sandbox.service        : service systemd (auto-restart + boot)
#   /opt/gen3ia/.env.production   : + SANDBOX_URL + SANDBOX_SHARED_SECRET
#   pm2 restart gen3ia            : rechargement avec le nouvel env
# =====================================================================
set -euo pipefail

PROD_DIR=/opt/gen3ia
SBX_DIR=/opt/gen3ia-sandbox
ENV_FILE=/etc/gen3ia-sandbox.env
APP_ENV=$PROD_DIR/.env.production

log() { echo "[$(date '+%F %T')] $*"; }

# --- 1. Checkout dédié (clone local du commit prod — pas de réseau) ---
if [ ! -d "$SBX_DIR/.git" ]; then
  log "Clone local $PROD_DIR -> $SBX_DIR"
  git clone --quiet "$PROD_DIR" "$SBX_DIR"
fi
cd "$SBX_DIR"
git fetch origin --quiet 2>/dev/null || true
git reset --hard origin/main --quiet
log "Checkout sandbox : $(git log --oneline -1 | head -c 60)"

# --- 2. Build du service (npm ci + tsc) ---
cd "$SBX_DIR/sandbox"
if [ ! -f dist/server.js ] || [ "${FORCE_REBUILD:-0}" = "1" ]; then
  log "npm ci sandbox…"
  npm ci --no-audit --no-fund --loglevel=error
  log "Compilation TypeScript…"
  npm run build
fi
[ -f dist/server.js ] || { log "ERREUR: dist/server.js absent"; exit 1; }

# --- 3. Images Docker d'exécution (noms EXACTS attendus par le runner) ---
# --network=none : le daemon est durci ("bridge": "none" dans daemon.json —
# aucun conteneur ne peut jamais avoir de réseau au niveau du daemon).
# Les Dockerfiles n'ont besoin d'AUCUN réseau (adduser/addgroup seulement).
if ! docker image inspect gen3ia-sandbox-node:latest >/dev/null 2>&1; then
  log "Construction image gen3ia-sandbox-node…"
  DOCKER_BUILDKIT=0 docker build --network=none -t gen3ia-sandbox-node docker/node
fi
if ! docker image inspect gen3ia-sandbox-python:latest >/dev/null 2>&1; then
  log "Construction image gen3ia-sandbox-python…"
  DOCKER_BUILDKIT=0 docker build --network=none -t gen3ia-sandbox-python docker/python
fi
log "Images prêtes : $(docker images --format '{{.Repository}}:{{.Tag}}' | grep gen3ia-sandbox | tr '\n' ' ')"

# --- 4. Secret HMAC partagé (persisté, réutilisé si déjà présent) ---
if [ -f "$ENV_FILE" ] && grep -q '^SANDBOX_SHARED_SECRET=.' "$ENV_FILE"; then
  log "Secret existant réutilisé ($ENV_FILE)"
else
  SECRET=$(openssl rand -hex 32)
  mkdir -p /etc
  cat > "$ENV_FILE" <<EOF
HOST=127.0.0.1
PORT=8080
SANDBOX_SHARED_SECRET=$SECRET
EOF
  chmod 600 "$ENV_FILE"
  log "Nouveau secret HMAC généré"
fi

# --- 5. Service systemd (léger : node direct, pas de démon PM2 bonus) ---
cat > /etc/systemd/system/gen3ia-sandbox.service <<'EOF'
[Unit]
Description=Gen3ia sandbox d'execution Docker (terminal IA)
After=network.target docker.service
Wants=docker.service

[Service]
Type=simple
WorkingDirectory=/opt/gen3ia-sandbox/sandbox
EnvironmentFile=/etc/gen3ia-sandbox.env
ExecStart=/usr/bin/node dist/server.js
Restart=always
RestartSec=3
User=root
LimitNPROC=65535

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable gen3ia-sandbox --quiet
systemctl restart gen3ia-sandbox
sleep 2
if ! systemctl is-active --quiet gen3ia-sandbox; then
  log "ERREUR: service sandbox inactif"
  journalctl -u gen3ia-sandbox --no-pager -n 15
  exit 1
fi
log "Service sandbox actif (127.0.0.1:8080)"

# --- 6. Câblage application : SANDBOX_URL + secret partagé ---
SBX_SECRET=$(grep '^SANDBOX_SHARED_SECRET=' "$ENV_FILE" | cut -d= -f2)
if grep -q '^SANDBOX_URL=' "$APP_ENV"; then
  sed -i "s|^SANDBOX_URL=.*$|SANDBOX_URL=http://127.0.0.1:8080|" "$APP_ENV"
else
  echo "SANDBOX_URL=http://127.0.0.1:8080" >> "$APP_ENV"
fi
if grep -q '^SANDBOX_SHARED_SECRET=' "$APP_ENV"; then
  sed -i "s|^SANDBOX_SHARED_SECRET=.*$|SANDBOX_SHARED_SECRET=$SBX_SECRET|" "$APP_ENV"
else
  echo "SANDBOX_SHARED_SECRET=$SBX_SECRET" >> "$APP_ENV"
fi
chmod 600 "$APP_ENV"
log "App câblée au sandbox (SANDBOX_URL + SANDBOX_SHARED_SECRET)"

# --- 7. Rechargement de l'application avec le nouvel env ---
pm2 restart gen3ia --update-env >/dev/null
sleep 4
curl -fsS -o /dev/null -m 15 http://127.0.0.1:3000/ && log "App rechargée et saine" || { log "ERREUR: app ne répond pas"; exit 1; }

log "=== INSTALLATION SANDBOX TERMINÉE ==="
