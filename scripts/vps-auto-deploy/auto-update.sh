#!/bin/bash
# =====================================================================
# Gen3ia — Poller de mise à jour automatique GitHub → production.
# Lancé et supervisé par PM2 (name: updater). Vérifie origin/main
# toutes les 2 minutes ; délègue tout le travail sécurisé à deploy.sh.
# =====================================================================
UPDATER_DIR=/opt/gen3ia-updater

while true; do
  # deploy.sh est silencieux quand il n'y a rien à déployer (exit 0).
  # Toute erreur est loggée par deploy.sh lui-même — jamais de crash
  # du poller (un échec de déploiement ne doit pas arrêter la veille).
  bash "$UPDATER_DIR/deploy.sh" >/dev/null 2>&1 || true
  sleep 120
done
