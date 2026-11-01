#!/usr/bin/env bash
# =====================================================================
# Gen3ia — INSTALLATION DU SOUS-DOMAINE DE STATUT status.gen3ia.online
# (axe 5, audit 2 nov. 2026). Idempotent : relançable sans risque.
#
# USAGE (console VPS, root) :
#   curl -fsSL https://raw.githubusercontent.com/missock237-spec/gen3ia/main/scripts/vps-auto-deploy/install-status-domain.sh | bash
#
# CE QUE FAIT LE SCRIPT :
#   1. Vérifie root + nginx présents ;
#   2. Dépose infra/deploy/nginx/status.gen3ia.online.conf dans
#      /etc/nginx/conf.d/ (mise à jour si déjà présent) ;
#   3. nginx -t (jamais de reload sur conf cassée) puis reload ;
#   4. Vérifie localement : curl -H "Host: status.gen3ia.online"
#      http://127.0.0.1/status → attendu 200 avec « État du service » ;
#   5. AFFICHE (sans exécuter) les 2 actions opérateur restantes :
#      DNS status.gen3ia.online → IP du VPS, puis
#      certbot --nginx -d status.gen3ia.online --expand (TLS).
#
# L'URL de référence gen3ia.online/status reste servie pendant toute
# l'opération — le sous-domaine est un accès supplémentaire, pas une
# dépendance.
# =====================================================================
set -euo pipefail

CONF_SRC_NAME="status.gen3ia.online.conf"
CONF_SRC="https://raw.githubusercontent.com/missock237-spec/gen3ia/main/infra/deploy/nginx/${CONF_SRC_NAME}"
CONF_DST="/etc/nginx/conf.d/${CONF_SRC_NAME}"

[ "$(id -u)" -eq 0 ] || { echo "✗ à exécuter en root (sudo)"; exit 1; }
command -v nginx >/dev/null || { echo "✗ nginx absent"; exit 1; }

echo "→ Téléchargement de la conf…"
curl -fsSL -o "${CONF_DST}.new" "$CONF_SRC"
[ -s "${CONF_DST}.new" ] || { echo "✗ conf vide — abandon"; rm -f "${CONF_DST}.new"; exit 1; }

if [ -f "$CONF_DST" ] && diff -q "$CONF_DST" "${CONF_DST}.new" >/dev/null 2>&1; then
  echo "✓ conf déjà en place, rien à changer"
  rm -f "${CONF_DST}.new"
else
  mv "${CONF_DST}.new" "$CONF_DST"
  echo "✓ conf déposée : $CONF_DST"
fi

echo "→ Test de syntaxe nginx…"
if ! nginx -t; then
  echo "✗ syntaxe nginx invalide — conf QUITTÉE en place mais nginx NON rechargé."
  echo "  Retirez $CONF_DST puis relancez après correction."
  exit 1
fi

echo "→ Rechargement nginx…"
nginx -s reload || systemctl reload nginx
echo "✓ nginx rechargé"

echo "→ Vérification locale (Host: status.gen3ia.online)…"
sleep 1
CODE=$(curl -s -o /tmp/g3status.html -w '%{http_code}' -H "Host: status.gen3ia.online" http://127.0.0.1/status || true)
if [ "$CODE" = "200" ] && grep -q "État du service" /tmp/g3status.html; then
  echo "✓ sous-domaine serviable en local (HTTP 200, page État du service)"
else
  echo "⚠ réponse inattendue (code ${CODE:-aucun}) — vérifiez que gen3ia.online tourne sur 127.0.0.1:3000"
fi
rm -f /tmp/g3status.html

IP_PUB=$(curl -fsSL -m 10 https://ifconfig.me 2>/dev/null || echo "<IP publique du VPS>")
cat <<EOF

═══════════════════════════════════════════════════════════════════
Actions restantes CÔTÉ REGISTRAR (hors VPS — à faire vous-même) :
  1. DNS : enregistrement A  status.gen3ia.online  →  ${IP_PUB}
     (ou CNAME vers gen3ia.online)
  2. TLS (après propagation DNS) :
       certbot --nginx -d status.gen3ia.online --expand
En attendant : https://gen3ia.online/status reste LA page de référence.
═══════════════════════════════════════════════════════════════════
EOF
