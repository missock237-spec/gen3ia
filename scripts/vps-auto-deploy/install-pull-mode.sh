#!/bin/bash
# =====================================================================
# Gen3ia — Installation du MODE PULL sur le VPS (une seule fois).
#
# À exécuter en root depuis la console du fournisseur (spaceship.com)
# SANS jamais avoir besoin du SSH entrant :
#
#   curl -fsSL https://raw.githubusercontent.com/missock237-spec/gen3ia/main/scripts/vps-auto-deploy/install-pull-mode.sh | bash
#
# Effets :
#   1. sauvegarde l'ancien /opt/gen3ia-updater/deploy.sh (mode build,
#      no-op depuis le 2026-10-21) en deploy.sh.build ;
#   2. installe pull-deploy.sh et remplace deploy.sh par un shim — le
#      poller PM2 « updater » (toutes les 2 min) déploie désormais en
#      téléchargeant le build du runner (release cd-latest) ;
#   3. lance immédiatement un premier déploiement (sans attendre 2 min).
# Idempotent : réexécutable sans risque.
# =====================================================================
set -u

REPO=missock237-spec/gen3ia
BASE=https://raw.githubusercontent.com/$REPO/main/scripts/vps-auto-deploy
UPDATER_DIR=/opt/gen3ia-updater
export PATH=$PATH:/usr/local/bin:/usr/bin

echo "=== Gen3ia — installation du mode pull (sans SSH) ==="
mkdir -p "$UPDATER_DIR/state"

# 1. Sauvegarde de l'ancien mode build (une seule fois)
if [ -f "$UPDATER_DIR/deploy.sh" ] && [ ! -f "$UPDATER_DIR/deploy.sh.build" ]; then
  cp "$UPDATER_DIR/deploy.sh" "$UPDATER_DIR/deploy.sh.build"
  echo "• ancien deploy.sh sauvegardé → deploy.sh.build"
fi

# 2. Scripts
curl -fsSL "$BASE/pull-deploy.sh" -o "$UPDATER_DIR/pull-deploy.sh" \
  || { echo "ERREUR: pull-deploy.sh inaccessible"; exit 1; }
chmod +x "$UPDATER_DIR/pull-deploy.sh"
printf '#!/bin/bash\n# Shim posé par install-pull-mode.sh : le poller déploie en mode pull.\nexec bash %s/pull-deploy.sh\n' "$UPDATER_DIR" > "$UPDATER_DIR/deploy.sh"
chmod +x "$UPDATER_DIR/deploy.sh"
echo "• poller PM2 « updater » branché sur pull-deploy.sh (prise effet au prochain cycle ≤ 2 min)"

# 3. Premier déploiement immédiat
echo "=== premier déploiement pull (immédiat) ==="
bash "$UPDATER_DIR/pull-deploy.sh"
CODE=$?
echo "=== terminé (code $CODE) — vérification : curl -s http://127.0.0.1:3000/api/health ==="
tail -5 "$UPDATER_DIR/state/deploy.log" 2>/dev/null
exit "$CODE"
