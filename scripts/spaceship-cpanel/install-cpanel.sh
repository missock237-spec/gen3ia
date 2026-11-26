#!/bin/bash
# =====================================================================
# Gen3ia — INSTALLATION sur l'hébergement web Spaceship (cPanel mutualisé)
# PLAN B (la voie principale est Hyperlift + workflows GitHub).
# À exécuter UNE FOIS dans le terminal cPanel (cPanel → Terminal) :
#   curl -fsSL https://raw.githubusercontent.com/missock237-spec/gen3ia/main/scripts/spaceship-cpanel/install-cpanel.sh | bash
#
# Ce que fait l'installation :
#   1. Détecte ou crée le clone du dépôt (~/gen3ia-repo) ;
#   2. Installe le poller pull-deploy-cpanel.sh (auto-mise à jour par le
#      canal pull lui-même) ;
#   3. Installe node_modules (npm ci --omit=dev) et le wrapper server.js
#      de démarrage Passenger ;
#   4. Prépare .env.production à partir du collage utilisateur (chmod 600,
#      jamais touché ensuite) ;
#   5. Pose le CRON cPanel (toutes les 3 min) — sinon affiche la ligne à
#      coller dans cPanel → Cron Jobs ;
#   6. Affiche la configuration exacte de l'app Node.js cPanel.
#
# Après : suivre docs/exploitation/mise-en-service-cpanel.md
# =====================================================================
set -u

REPO="${GEN3IA_REPO:-missock237-spec/gen3ia}"
BRANCHE="${GEN3IA_BRANCHE:-main}"
REPO_DIR="${GEN3IA_REPO_DIR:-$HOME/gen3ia-repo}"
UPDATER_DIR="$HOME/gen3ia-updater"

echo "== Gen3ia — installation cPanel (hôte: $(hostname), user: $(whoami)) =="

# 1. Clone du dépôt (réutilise le clone fait via cPanel → Git si présent)
if [ -d "$REPO_DIR/.git" ]; then
  echo "✓ Clone existant : $REPO_DIR (cPanel Git détecté)"
else
  echo "→ Clonage du dépôt dans $REPO_DIR…"
  git clone --depth 1 --branch "$BRANCHE" "https://github.com/$REPO.git" "$REPO_DIR" || { echo "✗ Clone impossible"; exit 1; }
fi
mkdir -p "$UPDATER_DIR/state" "$REPO_DIR/tmp" "$REPO_DIR/public"

# 2. Poller (auto-mise à jour par le canal pull)
curl -fsSL --max-time 60 "https://raw.githubusercontent.com/$REPO/$BRANCHE/scripts/spaceship-cpanel/pull-deploy-cpanel.sh" -o "$UPDATER_DIR/pull-deploy-cpanel.sh" || { echo "✗ Poller non téléchargé"; exit 1; }
chmod +x "$UPDATER_DIR/pull-deploy-cpanel.sh"
echo "✓ Poller : $UPDATER_DIR/pull-deploy-cpanel.sh"

# 3. Dépendances (une fois) + wrapper server.js pour Passenger
if [ ! -d "$REPO_DIR/node_modules" ]; then
  echo "→ npm ci --omit=dev (plusieurs minutes sur mutualisé)…"
  (cd "$REPO_DIR" && npm ci --omit=dev --no-audit --no-fund) || { echo "✗ npm ci échoué (RAM ? réessayer)"; exit 1; }
fi
if [ ! -f "$REPO_DIR/server.js" ]; then
  cat > "$REPO_DIR/server.js" <<'JS'
const next = require('next');
const http = require('http');
const app = next({ dev: false });
const handle = app.getRequestHandler();
const port = parseInt(process.env.PORT, 10) || 3000;
app.prepare().then(() => {
  http.createServer((req, res) => handle(req, res)).listen(port, () => {
    console.log(`gen3ia prêt sur ${port}`);
  });
});
JS
  echo "✓ Wrapper server.js créé (démarrage Passenger)"
fi

# 4. .env.production (une fois, jamais touché ensuite)
if [ ! -f "$REPO_DIR/.env.production" ]; then
  echo "→ Collez maintenant le .env.production (copie de DOTENV_PRODUCTION), terminez par Ctrl-D :"
  cat > "$REPO_DIR/.env.production"
  chmod 600 "$REPO_DIR/.env.production"
  echo "✓ .env.production écrit (chmod 600)"
else
  echo "✓ .env.production déjà présent — conservé"
fi

# 5. Cron cPanel (toutes les 3 minutes)
LIGNE_CRON="*/3 * * * * bash $UPDATER_DIR/pull-deploy-cpanel.sh >> $UPDATER_DIR/cron.log 2>&1"
if (crontab -l 2>/dev/null; echo "$LIGNE_CRON") | crontab - 2>/dev/null; then
  echo "✓ Cron installé (toutes les 3 min)"
else
  echo "⚠ crontab indisponible — collez cette ligne dans cPanel → Cron Jobs :"
  echo "  $LIGNE_CRON"
fi

# 6. Configuration de l'app Node.js cPanel
echo ""
echo "== Configuration cPanel → Setup Node.js App =="
echo "  Node.js version      : 20.x (ou la plus récente)"
echo "  Application mode     : Production"
echo "  Application root     : $REPO_DIR"
echo "  Application URL      : https://gen3ia.online"
echo "  Startup file         : server.js (wrapper créé ci-dessus)"
echo "  Variables            : NODE_ENV=production (le reste vient du .env.production)"
echo "  Puis « Restart »."
echo ""
echo "== Prochaines étapes =="
echo "  1. bash $UPDATER_DIR/pull-deploy-cpanel.sh   (premier déploiement, ~5 min)"
echo "  2. DNS : record A de gen3ia.online → IP du serveur (cPanel → Server Information)"
echo "  3. Vérifier https://gen3ia.online/version.json puis le site dans le navigateur"
