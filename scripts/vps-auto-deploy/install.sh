#!/bin/bash
# =====================================================================
# Installation unique du système de mise à jour automatique Gen3ia.
# À exécuter UNE FOIS en root sur le VPS (déjà fait le 2026-10-16).
# Idempotent : peut être relancé sans risque.
# =====================================================================
set -euo pipefail

UPDATER_DIR=/opt/gen3ia-updater

echo "=== Installation du système de mise à jour automatique ==="

# 1. Dépendances système
command -v rsync >/dev/null 2>&1 || dnf install -y rsync
command -v flock >/dev/null 2>&1 || dnf install -y util-linux

# 2. Copie des scripts
mkdir -p "$UPDATER_DIR/state"
cp /opt/deploy.sh "$UPDATER_DIR/deploy.sh"
cp /opt/auto-update.sh "$UPDATER_DIR/auto-update.sh"
chmod 700 "$UPDATER_DIR/deploy.sh" "$UPDATER_DIR/auto-update.sh"

# 3. État initial : le SHA actuellement servi par la production
cd /opt/gen3ia
git fetch origin --quiet
git rev-parse HEAD > "$UPDATER_DIR/state/last-deployed.txt"
touch "$UPDATER_DIR/state/failed_commits.txt"

# 4. PM2 : le poller tourne en continu, supervisé, redémarré au reboot
pm2 delete updater >/dev/null 2>&1 || true
pm2 start bash --name updater -- "$UPDATER_DIR/auto-update.sh"
pm2 save

echo "=== Installé : le poller vérifie GitHub toutes les 2 minutes ==="
pm2 ls | grep -E 'updater|gen3ia'
echo ""
echo "Journal des déploiements : tail -f $UPDATER_DIR/state/deploy.log"
echo "Blacklist des commits en échec : $UPDATER_DIR/state/failed_commits.txt"
