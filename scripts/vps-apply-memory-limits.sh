#!/bin/bash
# =====================================================================
# Gen3ia — Garde anti-OOM pour le process app « gen3ia » (VPS 2 Go).
#
# Problème (audit 2026-10-28) : le process app Next n'a PAS de
# max_memory_restart — une fuite/pointe mémoire monte jusqu'à faire
# intervenir l'OOM killer du noyau, qui tue N'IMPORTE QUEL process
# (souvent l'app elle-même, parfois nginx/mongod...). Le paramètre PM2
# fait redémarrer l'app PROPREMENT à son seuil AVANT l'intervention du
# noyau (rollback .next.old conservé côté finisher, sessions intactes).
#
# Budget mémoire cible (VPS 2 Go) :
#   app gen3ia ≤ 896 Mo · worker-ticks 256 Mo · nginx + système ~300 Mo
#   · pipeline (job entraînement, max_memory_restart 1G) : à lancer
#   hors pics de trafic ou après arbitrage (services/pipeline/).
#
# Usage (console du fournisseur OU SSH) :
#   bash scripts/vps-apply-memory-limits.sh          # limite 896 Mo
#   bash scripts/vps-apply-memory-limits.sh 768M     # limite custom
#
# Idempotent : réexécutable ; la limite est VÉRIFIÉE après application
# (aucun faux vert : si PM2 refuse l'option, le script le dit et sort 1).
# =====================================================================
set -eu
export PATH=$PATH:/usr/local/bin:/usr/bin

LIMITE="${1:-896M}"

command -v pm2 >/dev/null 2>&1 || { echo "ERREUR: pm2 introuvable (PATH ?)"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "ERREUR: node introuvable"; exit 1; }

echo "=== État actuel du process gen3ia ==="
pm2 describe gen3ia 2>/dev/null | grep -E "status|memory|script args|uptime" || true

echo "=== Application de max_memory_restart=${LIMITE} ==="
pm2 restart gen3ia --max-memory-restart="$LIMITE" --update-env

echo "=== Vérification (aucun faux vert) ==="
APPLIQUE=$(node -e '
const apps = JSON.parse(require("child_process").execSync("pm2 jlist").toString());
const a = apps.find((x) => x.name === "gen3ia");
if (!a) { console.error("Processus gen3ia introuvable"); process.exit(1); }
process.stdout.write(String(a.pm2_env.max_memory_restart || ""));
')
if [ "$APPLIQUE" = "$LIMITE" ]; then
  echo "OK : max_memory_restart=${APPLIQUE} actif sur gen3ia (vérifié via pm2 jlist)."
  echo "Pensez à « pm2 save » pour la persistance après reboot."
else
  echo "ÉCHEC : la limite lue est « ${APPLIQUE:-aucune} » (attendu ${LIMITE})."
  echo "PM2 a refusé l'option en CLI. Procédure alternative :"
  echo "  pm2 prettylist  # relever script/args/cwd du process gen3ia"
  echo "  créer infra/deploy/ecosystem.app.config.js à l'identique + max_memory_restart: \"${LIMITE}\""
  echo "  pm2 startOrReload infra/deploy/ecosystem.app.config.js --update-env"
  exit 1
fi

pm2 save >/dev/null 2>&1 || true
echo "=== Terminé ==="
