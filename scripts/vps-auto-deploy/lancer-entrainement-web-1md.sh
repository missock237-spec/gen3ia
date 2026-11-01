#!/usr/bin/env bash
# ============================================================================
# LANCEUR VPS ONE-COMMAND — ENTRAÎNEMENT GEN3 DÉVELOPPEMENT WEB (1 Md / 1 M)
#
# DEMANDE PROPRIÉTAIRE (trace 1a198553ec1dce61) : « entraîne gen3 dans le
# développement web pour qu'il puisse générer du code et créer des app ou
# site web ; connecte-toi sur mon VPS pour l'entraîner ; assure que via le
# navigateur un utilisateur qui demande de créer un site ou une app reçoit
# du code ; 1 milliard d'exemples et 1 million de datasets ».
#
# CE SCRIPT FAIT, EN UNE COMMANDE, SUR LE VPS (root) :
#   1. met /opt/gen3ia à jour (fetch + reset --hard origin/main, npm ci au
#      besoin) ;
#   2. écrit un worker résilient (var/worker-webdev-1md.sh) qui :
#        a. calibre d'abord le DÉBIT RÉEL du serveur (--benchmark, 3 lots) ;
#        b. lance la campagne développement web it.79 avec l'objectif
#           DÉFAUT du script : 1 000 000 000 d'exemples vus sur un corpus
#           de 1 000 000 d'exemples uniques (3 capacités : écrire /
#           comprendre / simuler — sorties et traces exécutées réellement) ;
#        c. enchaîne les sessions avec --reprendre (checkpoints par lot dans
#           var/neural-webdev/) : un crash, un OOM ou un redémarrage ne
#           perdent rien ;
#        d. si — et seulement si — la RÈGLE DE LIVRAISON ENCODÉE du script
#           de campagne passe (ratio code > 1 · argmax ≥ 7/9 · accord u8
#           9/9 · plancher 19 domaines ≥ socle it.73), commite et pousse le
#           snapshot livré + artefact + matière : le poller de production
#           (PULL toutes les 2 min) le déploie alors sur https://gen3ia.online
#           — les utilisateurs reçoivent la version entraînée sur le VPS ;
#        e. si les portes refusent, ne publie RIEN : la production reste
#           inchangée et la mesure est consignée au journal (zéro chiffre
#           fantôme) ;
#        f. s'arrête proprement quand progress.json constate
#           vusCode ≥ objectif (1 Md).
#   3. lance le worker dans tmux (session « gen3-webdev1md »).
#
# HONNÊTETÉ : le bac à sable du propriétaire ne peut PAS ouvrir de SSH vers
# ce VPS (aucune adresse/identifiant — runbook docs/exploitation/
# ssh-bloque-runbook.md). Ce lanceur est le moyen pour le propriétaire de
# déclencher l'entraînement complet en UNE commande ; toutes les mesures
# publiées (débit, extrapolation) viennent des sorties réelles du script de
# campagne — aucune durée n'est inventée ici.
#
# USAGE (sur le VPS, en root) :
#   curl -fsSL https://raw.githubusercontent.com/missock237-spec/gen3ia/main/scripts/vps-auto-deploy/lancer-entrainement-web-1md.sh | bash
#
# SUIVI :
#   tmux attach -t gen3-webdev1md          (Ctrl-b d pour se détacher)
#   tail -f /opt/gen3ia/var/journal-webdev-1md.log
#   cat /opt/gen3ia/var/neural-webdev/progress.json
# ARRÊT :
#   tmux send-keys -t gen3-webdev1md C-c ; tmux kill-session -t gen3-webdev1md
#   (relancer plus tard la même commande — --reprendre reprend au lot exact)
# ============================================================================

set -euo pipefail

REPO="/opt/gen3ia"
SESSION="gen3-webdev1md"
BRANCHE="main"
ORIGIN_GIT="git@github.com:missock237-spec/gen3ia.git"
SCRIPT_CAMPAGNE="scripts/campagne-developpement-web-it79.ts"

echo "== gen3 — entraînement développement web (1 Md / 1 M) =="

# --- 0. Contrôles -----------------------------------------------------------
if [ "$(id -u)" -ne 0 ]; then
  echo "ERREUR : à lancer en root (sudo -i puis relancer la commande)." >&2
  exit 1
fi
if [ ! -d "$REPO/.git" ]; then
  echo "ERREUR : $REPO absent — lance d'abord preparer-entrainement-gen3.sh (même canal curl|bash)." >&2
  exit 1
fi
if [ ! -f "$REPO/$SCRIPT_CAMPAGNE" ]; then
  echo "ERREUR : $SCRIPT_CAMPAGNE absent après mise à jour — dépôt inattendu." >&2
  exit 1
fi

# --- 1. Mise à jour du dépôt ------------------------------------------------
echo "[1/4] Mise à jour du dépôt…"
git -C "$REPO" fetch origin "$BRANCHE" --quiet
git -C "$REPO" reset --hard "origin/$BRANCHE" --quiet
if [ ! -x "$REPO/node_modules/.bin/tsx" ]; then
  echo "      npm ci (installation des dépendances)…"
  (cd "$REPO" && npm ci --no-audit --no-fund --quiet)
fi

# --- 2. Anti-doublon ---------------------------------------------------------
if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "[2/4] Session tmux '$SESSION' déjà ACTIVE — rien lancé (anti-doublon)."
  echo "      Suivi : tmux attach -t $SESSION"
  echo "      Journal : tail -f $REPO/var/journal-webdev-1md.log"
  echo "      État :   cat $REPO/var/neural-webdev/progress.json"
  exit 0
fi

# --- 3. Worker résilient ------------------------------------------------------
echo "[3/4] Écriture du worker résilient…"
mkdir -p "$REPO/var/neural-webdev"
cat > "$REPO/var/worker-webdev-1md.sh" <<'WORKER'
#!/usr/bin/env bash
# Worker — entraînement gen3 développement web vers 1 Md / 1 M (généré par
# lancer-entrainement-web-1md.sh). Survit aux crashes par --reprendre.
set -uo pipefail
cd /opt/gen3ia
export NODE_OPTIONS="--max-old-space-size=1536"
export GIT_SSH_COMMAND="ssh -i /root/.ssh/julio237 -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
LOG="/opt/gen3ia/var/journal-webdev-1md.log"
BIN="public/neural/cortex-developpement-web-it79.bin"
ART="assets/neural-pretrained/cortex-developpement-web-it79.json"
MAT="public/neural/webdev-it79-matiere.json"
ORIGIN_GIT="git@github.com:missock237-spec/gen3ia.git"

log() { echo "[$(date '+%F %T')] $*" | tee -a "$LOG"; }

lire_json() { # lire_json champ — progress.json est écrit avec indent 2
  sed -n "s/.*\"$1\": \([0-9][0-9]*\).*/\1/p" var/neural-webdev/progress.json | tail -n 1
}

# --- Benchmark une fois : le DÉBIT RÉEL de CE serveur fait foi ---------------
if [ ! -f var/neural-webdev/benchmark-fait ]; then
  log "BENCHMARK — calibration du débit réel de ce serveur (3 lots, aucun checkpoint)…"
  nice -n 10 npx tsx scripts/campagne-developpement-web-it79.ts --benchmark 2>&1 | tee -a "$LOG" | grep -E "BENCHMARK|essai lot" || true
  touch var/neural-webdev/benchmark-fait
fi

# --- Boucle de sessions reliées par checkpoints ------------------------------
while true; do
  log "SESSION — campagne développement web (objectif : 1 Md d'exemples / 1 M uniques) --reprendre"
  nice -n 10 npx tsx scripts/campagne-developpement-web-it79.ts --reprendre 2>&1 | tee -a "$LOG"
  CODE="${PIPESTATUS[0]}"
  log "SESSION terminée (code de sortie $CODE)"

  # --- Publication SI (et seulement si) la règle encodée a livré un snapshot
  if [ -f "$BIN" ]; then
    H1="$(sha256sum "$BIN" | cut -d' ' -f1)"
    HPRECEDENT="$(cat var/neural-webdev/dernier-bin-publie.sha 2>/dev/null || echo "")"
    if [ "$H1" != "$HPRECEDENT" ]; then
      git config user.name >/dev/null 2>&1 || git config user.name "gen3-vps"
      git config user.email >/dev/null 2>&1 || git config user.email "gen3-vps@gen3ia.online"
      git add "$BIN" "$ART" "$MAT"
      VUS="$(lire_json vusCode || echo '?')"
      git commit \
        -m "feat(gen3): snapshot développement web entraîné SUR LE VPS — ${VUS} exemples code vus (corpus 1 M uniques, checkpoints var/neural-webdev/), portes de livraison satisfaites (ratio code > 1 · argmax ≥ 7/9 · accord u8 9/9 · plancher 19 domaines ≥ socle it.73) — objectif 1 Md / 1 M (demande propriétaire)" \
        || log "COMMIT — rien à committer"
      if git push "$ORIGIN_GIT" HEAD:main; then
        echo "$H1" > var/neural-webdev/dernier-bin-publie.sha
        log "PUBLICATION — snapshot poussé (sha $H1) — le poller de production le déploie sous ~2 min : https://gen3ia.online/code"
      else
        log "PUBLICATION — push REFUSÉ : vérifier la clé julio237 et les droits de la deploy key (aucune perte : les checkpoints restent locaux)."
      fi
    else
      log "Session terminée, snapshot inchangé (portes déjà publiées) — rien à pousser."
    fi
  else
    log "Portes de livraison refusées ou session interrompue : AUCUN snapshot publié — la production reste servie, les checkpoints conservés (zéro chiffre fantôme)."
  fi

  # --- Objectif atteint ? ---------------------------------------------------
  VUS="$(lire_json vusCode || echo 0)"; VUS="${VUS:-0}"
  OBJ="$(lire_json objectif || echo 1000000000)"; OBJ="${OBJ:-1000000000}"
  if [ "$VUS" -ge "$OBJ" ] 2>/dev/null; then
    log "OBJECTIF ATTEINT — ${VUS} exemples code vus (objectif ${OBJ}). Le worker s'arrête proprement ; relancer le lanceur relance la mesure des sondes sans re-superviser."
    break
  fi
  log "Reprise dans 30 s (--reprendre reprend au lot exact — rien n'est perdu)."
  sleep 30
done
log "Worker terminé — journal : $LOG"
WORKER
chmod +x "$REPO/var/worker-webdev-1md.sh"

# --- 4. Lancement tmux -------------------------------------------------------
echo "[4/4] Lancement de la session tmux '$SESSION'…"
tmux new-session -d -s "$SESSION" -c "$REPO" "bash $REPO/var/worker-webdev-1md.sh"
sleep 2
if ! tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "ERREUR : la session s'est arrêtée immédiatement — journal :" >&2
  tail -n 20 "$REPO/var/journal-webdev-1md.log" >&2 || true
  exit 1
fi

echo
echo "== ENTRAÎNEMENT LANCÉ =="
echo "  Suivi live   : tmux attach -t $SESSION      (Ctrl-b puis d pour détacher)"
echo "  Journal      : tail -f $REPO/var/journal-webdev-1md.log"
echo "  Progression  : cat $REPO/var/neural-webdev/progress.json"
echo "  Débit réel   : c'est la ligne BENCHMARK du journal (mesurée sur CE serveur)"
echo "  Publication  : quand les portes de livraison passent, le snapshot est poussé"
echo "                 et le poller de production le met en ligne sur https://gen3ia.online/code"
echo "  Arrêt        : tmux send-keys -t $SESSION C-c && tmux kill-session -t $SESSION"
echo "                 (relancer plus tard la même commande : --reprendre reprend au lot exact)"
