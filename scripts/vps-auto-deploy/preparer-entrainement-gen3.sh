#!/usr/bin/env bash
# =====================================================================
# PRÉPARATION VPS ALMALINUX — SERVEUR D'ENTRAÎNEMENT LOCAL GEN3
# Job 478451 · 2026-11-01 · à exécuter en root (console fournisseur)
#
# Rôle : transformer un VPS AlmaLinux neuf (typ. 1 vCPU / 2 Go RAM) en
# serveur d'entraînement local de gen3 — règle SNN : TOUT est exécuté
# en local, zéro service d'IA externe.
#
# Ce que fait ce script (idempotent — relançable sans risque) :
#   1. outils de base (git, curl, tmux, gcc-c++, make, python3)
#   2. Node.js 22 LTS (engines du projet : >=20.9.0 <23)
#   3. swap 4 Go (la RAM seule ne suffit pas pour npm ci et les sessions)
#   4. clé SSH « julio237 » (déjà générée dans votre console) rangée et
#      déclarée dans ~/.ssh/config (alias github-gen3ia)
#   5. enregistrement optionnel de la deploy key GitHub si GITHUB_TOKEN
#      est exporté (sinon instructions pour l'interface web)
#   6. clone du dépôt public dans /opt/gen3ia
#   7. npm ci + vérification du noyau neuronal v2
#   8. feuille de commandes écrite dans /opt/gen3ia/COMMANDES-ENTRAINEMENT.md
#
# Sécurité : la clé PRIVÉE ne quitte jamais le VPS ; GITHUB_TOKEN n'est
# jamais affiché ni stocké ; le script ne touche pas à /opt/gen3ia-updater
# (si ce VPS héberge aussi le poller de production, il reste intact).
# =====================================================================
set -euo pipefail

REPO="missock237-spec/gen3ia"
DIR_REPO="/opt/gen3ia"
CLE_SSH="julio237"

log()  { printf '\n\033[1;36m[gen3ia] %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m  [OK] %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m  [!]  %s\033[0m\033[0m\n' "$*"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "À exécuter en root (console fournisseur : bash preparer-entrainement-gen3.sh)"; exit 1
fi

# ------------------------------------------------ 1. outils de base
log "1/8 · Outils de base (git, curl, tmux, compilation)"
dnf install -y git curl tar tmux gcc-c++ make python3 ca-certificates diffutils
ok "outils système prêts"

# ------------------------------------------------ 2. Node.js 22 LTS
log "2/8 · Node.js (engines du projet : >=20.9.0 <23)"
BESOIN_NODE=1
if command -v node >/dev/null 2>&1; then
  V="$(node -v | sed 's/^v//')"; MAJ="${V%%.*}"; RESTE="${V#*.}"; MIN="${RESTE%%.*}"
  if [ "$MAJ" -eq 22 ] || [ "$MAJ" -eq 21 ] || { [ "$MAJ" -eq 20 ] && [ "$MIN" -ge 9 ]; }; then
    BESOIN_NODE=0; ok "Node $V déjà conforme"
  else
    warn "Node $V hors plage >=20.9 <23 → réinstallation"
  fi
fi
if [ "$BESOIN_NODE" -eq 1 ]; then
  curl -fsSL https://rpm.nodesource.com/setup_22.x -o /tmp/nodesource-setup.sh
  bash /tmp/nodesource-setup.sh >/dev/null
  dnf install -y nodejs
  ok "Node $(node -v) installé (NodeSource 22 LTS)"
fi
ok "npm $(npm -v)"

# ------------------------------------------------ 3. swap 4 Go
log "3/8 · Mémoire : swap 4 Go (indispensable sur 2 Go de RAM)"
SWAP_MB="$(free -m | awk '/^Swap:/{s+=$2} END{print s+0}')"
if [ "$SWAP_MB" -lt 2000 ]; then
  if [ ! -f /swapfile ]; then
    fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap -q /swapfile
  fi
  swapon /swapfile 2>/dev/null || true
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo 'vm.swappiness = 20' > /etc/sysctl.d/99-gen3ia.conf
  sysctl --system >/dev/null 2>&1 || true
  ok "swap 4 Go actif (swappiness 20)"
else
  ok "swap déjà suffisant (${SWAP_MB} Mo)"
fi
free -h | sed -n '1,3p'

# ------------------------------------------------ 4. clé SSH julio237
log "4/8 · Clé SSH « ${CLE_SSH} » (générée dans votre console)"
mkdir -p ~/.ssh && chmod 700 ~/.ssh
SRC=""
for CAND in "$HOME/.ssh/$CLE_SSH" "$HOME/$CLE_SSH" "/root/$CLE_SSH" "./$CLE_SSH"; do
  if [ -f "$CAND" ]; then SRC="$CAND"; break; fi
done
if [ -z "$SRC" ]; then
  warn "clé introuvable → génération d'une nouvelle clé (ed25519)"
  ssh-keygen -t ed25519 -C "gen3ia-vps" -f "$HOME/.ssh/$CLE_SSH" -N "" -q
else
  cp -f "$SRC" "$HOME/.ssh/$CLE_SSH"
  [ -f "${SRC}.pub" ] && cp -f "${SRC}.pub" "$HOME/.ssh/$CLE_SSH.pub" || ssh-keygen -y -f "$HOME/.ssh/$CLE_SSH" > "$HOME/.ssh/$CLE_SSH.pub"
  ok "clé rangée depuis $SRC"
fi
chmod 600 "$HOME/.ssh/$CLE_SSH" && chmod 644 "$HOME/.ssh/$CLE_SSH.pub"
if ! grep -q "Host github-gen3ia" ~/.ssh/config 2>/dev/null; then
  { echo ""; echo "Host github-gen3ia";
    echo "  HostName github.com";
    echo "  User git";
    echo "  IdentityFile ~/.ssh/${CLE_SSH}";
    echo "  IdentitiesOnly yes"; } >> ~/.ssh/config
fi
chmod 600 ~/.ssh/config
ssh-keyscan -t ed25519 github.com >> ~/.ssh/known_hosts 2>/dev/null || true
echo "----------------------------------------------------------"
echo " CLÉ PUBLIQUE (${CLE_SSH}.pub) — à déclarer sur GitHub :"
cat "$HOME/.ssh/$CLE_SSH.pub"
echo "----------------------------------------------------------"

# ------------------------------------------------ 5. deploy key GitHub (optionnel)
log "5/8 · Deploy key GitHub (lecture/écriture sur ${REPO})"
if [ -n "${GITHUB_TOKEN:-}" ]; then
  PUB="$(cat "$HOME/.ssh/$CLE_SSH.pub")"
  CODE="$(curl -s -o /tmp/dk-response.json -w '%{http_code}' \
    -H "Authorization: Bearer ${GITHUB_TOKEN}" -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/${REPO}/keys" \
    -d "{\"title\":\"vps-almalinux-gen3\",\"key\":\"${PUB}\",\"read_only\":false}")" || CODE="000"
  case "$CODE" in
    201) ok "deploy key ajoutée via l'API" ;;
    422) ok "deploy key déjà déclarée (idempotent)" ;;
    *)  warn "API GitHub code ${CODE} → ajoutez la clé ci-dessus via https://github.com/${REPO}/settings/keys (Read/write)" ;;
  esac
  unset GITHUB_TOKEN   # jamais conservé au-delà de cette étape
else
  warn "GITHUB_TOKEN non exporté → déclarez la clé publique affichée ci-dessus sur"
  warn "  https://github.com/${REPO}/settings/keys  (bouton « Add deploy key », Read/write)"
  warn "  … puis relancez ce script : il passera directement à la suite."
fi

# ------------------------------------------------ 6. clone du dépôt
log "6/8 · Dépôt gen3ia → ${DIR_REPO}"
if [ -d "$DIR_REPO/.git" ]; then
  git -C "$DIR_REPO" fetch origin && git -C "$DIR_REPO" reset --hard origin/main
  ok "dépôt existant mis à jour"
else
  if [ -d "$DIR_REPO" ]; then
    echo "  ${DIR_REPO} existe déjà sans .git — déplacez-le puis relancez."; exit 1
  fi
  git clone "https://github.com/${REPO}.git" "$DIR_REPO"
  ok "clone HTTPS terminé (dépôt public — la clé SSH servira aux pushes futurs)"
fi
git -C "$DIR_REPO" log --oneline -1

# ------------------------------------------------ 7. dépendances + noyau
log "7/8 · npm ci (comptez 10-20 min sur 1 vCPU — patientez)"
cd "$DIR_REPO"
npm config set fund false
npm ci --no-audit --no-fund 2>&1 | tail -3
ok "dépendances installées"
if npx tsx -e "import { CORTEX_CONFIG_DEFAUTS } from './lib/neural/core/v2/cortex-columnnaire'; console.log('  [OK] noyau neuronal v2 importé — ' + Object.keys(CORTEX_CONFIG_DEFAUTS).length + ' paramètres par défaut');" 2>/dev/null; then
  ok "vérification du noyau réussie"
else
  warn "vérification du noyau non conclurante (non bloquant — à relancer plus tard)"
fi

# ------------------------------------------------ 8. feuille de commandes
log "8/8 · Feuille de commandes"
cat > "$DIR_REPO/COMMANDES-ENTRAINEMENT.md" <<'FEUILLE'
# Entraînement local de gen3 — commandes (VPS)

cd /opt/gen3ia
export NODE_OPTIONS="--max-old-space-size=1536"

# 0) session persistante (survit à la déconnexion du téléphone/console)
tmux new -s gen3            # se détacher : Ctrl-b puis d — se rattacher : tmux attach -t gen3

# 1) calibrer le débit de CE serveur (rapide, mesuré, sans engagement)
npx tsx scripts/preentrainement-million.ts --benchmark

# 2) LA session million — 19 domaines x ~1 000 000+ échantillons (reprise intégrée)
npx tsx scripts/preentrainement-million.ts             # session complète
npx tsx scripts/preentrainement-million.ts --reprendre # reprendre après interruption

# 3) (optionnel) données RÉELLES Hugging Face en plus des corpus procéduraux
export HF_TOKEN=hf_xxx                                 # token personnel
npx tsx scripts/preentrainement-million.ts --reprendre

# 4) campagnes complémentaires
npx tsx scripts/campagne-telephone-it77.ts             # cortex téléphone (alignement + sondes)
npx tsx scripts/entrainement-questions-gen3.ts         # questions/réponses

# 5) résultats
ls assets/neural-pretrained/   # rapports JSON des campagnes
ls var/ var/neural-million/    # checkpoints (hors git)

# mise à jour du code
git fetch origin && git reset --hard origin/main && npm ci --no-audit --no-fund
FEUILLE
ok "feuille écrite : ${DIR_REPO}/COMMANDES-ENTRAINEMENT.md"

echo
echo "====================================================================="
echo " PRÊT. Pour commencer l'entraînement :"
echo "   cd ${DIR_REPO} && tmux new -s gen3"
echo "   npx tsx scripts/preentrainement-million.ts --benchmark   (d'abord)"
echo "   npx tsx scripts/preentrainement-million.ts               (session)"
echo " Guide complet : cat ${DIR_REPO}/COMMANDES-ENTRAINEMENT.md"
echo "====================================================================="
