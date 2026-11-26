#!/bin/bash
# =====================================================================
# Gen3ia — INSTALLATION sur l'hébergement web Spaceship (cPanel mutualisé).
# À exécuter UNE FOIS dans le terminal cPanel (cPanel → Terminal) :
#   curl -fsSL https://raw.githubusercontent.com/missock237-spec/gen3ia/<SHA>/scripts/spaceship-cpanel/install-cpanel.sh | bash
#
# Ce que fait l'installation :
#   1. Crée les répertoires ~/gen3ia (app) et ~/gen3ia-updater (état) ;
#   2. Installe le poller pull-deploy-cpanel.sh (auto-mise à jour par
#      le canal pull lui-même, comme sur le VPS) ;
#   3. Prépare .env.production à partir des variables demandées (jamais
#      de secret dans ce script — il sont collés à la main, chmod 600) ;
#   4. Installe le CRON cPanel (toutes les 3 min) — si crontab n'est pas
#      accessible, la ligne à coller dans cPanel → Cron Jobs est affichée ;
#   5. Affiche la configuration EXACTE de l'app Node.js cPanel
#      (Application root, Startup file) et le .htaccess Passenger à
#      coller dans le docroot du domaine.
#
# Après l'installation, suivre docs/exploitation/mise-en-service-cpanel.md
# =====================================================================
set -u

REPO="${GEN3IA_REPO:-missock237-spec/gen3ia}"
BRANCHE="${GEN3IA_BRANCHE:-main}"
BASE="$HOME/gen3ia"
UPDATER_DIR="$HOME/gen3ia-updater"

echo "== Gen3ia — installation cPanel (hôte: $(hostname), user: $(whoami)) =="

# 1. Répertoires
mkdir -p "$UPDATER_DIR/state" "$BASE/tmp"
echo "✓ Répertoires : $BASE (app) + $UPDATER_DIR (poller)"

# 2. Poller (auto-mise à jour par le canal pull)
curl -fsSL --max-time 60 "https://raw.githubusercontent.com/$REPO/$BRANCHE/scripts/spaceship-cpanel/pull-deploy-cpanel.sh" -o "$UPDATER_DIR/pull-deploy-cpanel.sh" || { echo "✗ Impossible de télécharger le poller"; exit 1; }
chmod +x "$UPDATER_DIR/pull-deploy-cpanel.sh"
echo "✓ Poller installé : $UPDATER_DIR/pull-deploy-cpanel.sh"

# 3. .env.production (créé une fois, jamais touché par les mises à jour)
if [ ! -f "$BASE/.env.production" ]; then
  echo "→ Collez maintenant le contenu du .env.production (voir DOTENV_PRODUCTION dans les secrets GitHub), terminez par Ctrl-D :"
  cat > "$BASE/.env.production"
  chmod 600 "$BASE/.env.production"
  echo "✓ .env.production écrit (chmod 600)"
else
  echo "✓ .env.production déjà présent — conservé tel quel"
fi

# 4. Cron cPanel (toutes les 3 minutes)
LIGNE_CRON="*/3 * * * * /usr/local/bin/bash $UPDATER_DIR/pull-deploy-cpanel.sh >> $UPDATER_DIR/cron.log 2>&1"
if (crontab -l 2>/dev/null; echo "$LIGNE_CRON") | crontab - 2>/dev/null; then
  echo "✓ Cron installé (toutes les 3 min)"
else
  echo "⚠ crontab indisponible — collez cette ligne dans cPanel → Cron Jobs (toutes les 3 min) :"
  echo "  $LIGNE_CRON"
fi

# 5. Configuration de l'app Node.js cPanel + .htaccess Passenger
echo ""
echo "== Configuration à créer dans cPanel → Setup Node.js App =="
echo "  Node.js version : 20.x (ou la plus récente disponible)"
echo "  Application mode : Production"
echo "  Application root : $BASE/app"
echo "  Application URL  : https://gen3ia.online"
echo "  Startup file     : server.js"
echo "  Environment variables : PORT=<port affiché par cPanel>, NODE_ENV=production"
echo "  Puis lancez « Run NPM Install » (node_modules du build est déjà fourni — cette étape est un no-op) et « Restart »."
echo ""
echo "== .htaccess à coller dans le docroot du domaine (public_html ou le répertoire du sous-domaine) =="
cat <<EOF
PassengerAppRoot $BASE/app
PassengerStartupFile server.js
PassengerNodejs $(command -v node || echo /usr/local/bin/node)
PassengerEnabled On
EOF
echo ""
echo "== Prochaines étapes =="
echo "  1. Créer l'app Node.js ci-dessus dans cPanel (démarrage immédiat : elle sert l'app tant que le premier build n'est pas arrivé — pas de build, donc elle peut renvoyer 503 ; c'est normal)."
echo "  2. Lancer le premier déploiement à la main : bash $UPDATER_DIR/pull-deploy-cpanel.sh"
echo "  3. Pointer le DNS de gen3ia.online vers ce serveur (cPanel → Domains, ou chez le registrar : record A = l'IP du serveur d'hébergement, visible dans cPanel → Server Information)."
echo "  4. Vérifier : https://gen3ia.online/version.json (doit afficher le SHA de main) et https://gen3ia.online/ dans un navigateur."
