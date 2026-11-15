#!/bin/bash
# =====================================================================
# Gen3ia — Déploiement en MODE PULL v2 (aucun SSH entrant requis).
#
# Contexte : les IP de sortie GitHub Actions arrivent régulièrement
# pénalisées côté sshd du VPS (PerSourcePenalties, fail2ban) — le SCP
# du CD échoue alors pendant des heures (runs #79→#88, #114→#115).
#
# Principe : le runner GitHub compile ET publie le build sur la release
# GitHub « cd-latest » (dépôt public → téléchargement anonyme). Ce
# script tourne sur le VPS, appelé par le poller PM2 « updater »
# (toutes les 2 min) ou à la main. Uniquement du HTTPS SORTANT :
#   · github.com               (release assets)
#   · raw.githubusercontent.com (pull-deploy.sh + cd-finisher.sh au SHA cible)
#
# v2 (correctifs d'anomalies détectées à l'audit 2026-10-28) :
#   1. AUTO-MISE À JOUR : ce script se remplace par la version du SHA
#      cible AVANT tout téléchargement lourd — les correctifs du dépôt
#      atteignent le VPS par le canal pull lui-même, sans SSH.
#   2. SOURCE DE VÉRITÉ UNIQUE : les états du finisher
#      (last-deployed.txt / failed_commits.txt) décident — plus de stamp
#      local divergent.
#   3. BUG v1 « jamais de reprise » corrigé : v1 écrivait son stamp AVANT
#      le téléchargement — un échec réseau figeait le SHA pour toujours
#      (e49ca45 bloqué 2 h). Désormais : backoff 15 min puis réessai.
#   4. BUG v1 « retéléchargement en boucle » corrigé : v1 supprimait son
#      stamp après un succès — le même build (200 Mo) était retéléchargé
#      toutes les 2 min. Dernier SHA déployé + site sain → silence.
#
# Garanties inchangées (déléguées à cd-finisher.sh) :
#   swap atomique, .env.production jamais touché, health check,
#   rollback automatique, blacklist des SHA en échec, flock.
#
# Usage : bash pull-deploy.sh            (poller ou manuel)
# Forcer un retéléchargement : rm -f /opt/gen3ia-updater/state/pull-fail.txt
# =====================================================================
set -u

REPO=missock237-spec/gen3ia
UPDATER_DIR=/opt/gen3ia-updater
STATE_DIR=$UPDATER_DIR/state
LAST_DEPLOYED=$STATE_DIR/last-deployed.txt
FAILED_COMMITS=$STATE_DIR/failed_commits.txt
FAIL_FILE=$STATE_DIR/pull-fail.txt     # « <sha> <epoch> » du dernier échec TRANSIENT
BACKOFF_S=900                          # 15 min entre deux tentatives du même SHA
DL_TAR=/tmp/next-build.tar.gz
DL_SHA=/tmp/next-build.tar.gz.sha256

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$STATE_DIR/deploy.log"; echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }
mkdir -p "$STATE_DIR" 2>/dev/null || true

marquer_echec() {
  printf '%s %s\n' "$TARGET_SHA" "$(date +%s)" > "$FAIL_FILE" 2>/dev/null || true
}

# --- 1. Manifeste du dernier build publié (meta.json déposé en dernier
#        par le workflow : sa présence garantit un build complet) ---
CACHEBUST="$(date +%s)"
META=$(curl -fsSL -m 20 -H "Cache-Control: no-cache" \
  "https://github.com/$REPO/releases/download/cd-latest/meta.json?_=$CACHEBUST" 2>/dev/null) || {
  log "PULL: release cd-latest indisponible (aucun build runner publié ?) — silence."; exit 0; }

TARGET_SHA=$(printf '%s' "$META" | grep -o '"sha":"[0-9a-f]*"' | head -1 | sed 's/.*:"//; s/"$//')
[ -n "$TARGET_SHA" ] || { log "PULL: meta.json illisible — silence."; exit 0; }

# --- 2. AUTO-MISE À JOUR du script au SHA cible (AVANT tout le reste) :
#        la version qui s'exécute doit toujours être celle du build qu'elle
#        déploie. Différence détectée → remplacement + reprise propre.
#        Échec réseau ici : non fatal, on continue avec la version courante. ---
SELF=$(readlink -f "$0" 2>/dev/null || echo "$0")
NEWSELF=$(mktemp /tmp/pull-deploy.XXXXXX 2>/dev/null) || NEWSELF=""
if [ -n "$NEWSELF" ]; then
  if curl -fsSL -m 20 \
      "https://raw.githubusercontent.com/$REPO/$TARGET_SHA/scripts/vps-auto-deploy/pull-deploy.sh" \
      -o "$NEWSELF" 2>/dev/null && [ -s "$NEWSELF" ] && head -1 "$NEWSELF" | grep -q '^#!'; then
    if ! cmp -s "$NEWSELF" "$SELF"; then
      log "PULL: auto-mise à jour de pull-deploy.sh (version SHA $TARGET_SHA) — reprise."
      cat "$NEWSELF" > "$SELF" 2>/dev/null && chmod +x "$SELF" 2>/dev/null || true
      rm -f "$NEWSELF"
      exec bash "$SELF"
    fi
  fi
  rm -f "$NEWSELF"
fi
# Nettoyage des états de la v1 (stamp local remplacé par les états finisher)
rm -f "$STATE_DIR/pull-current.txt" 2>/dev/null || true

# --- 3. Blacklist : un SHA en échec enregistré par le finisher n'est plus
#        jamais téléchargé (zéro bande passante gaspillée). ---
if grep -qxF "$TARGET_SHA" "$FAILED_COMMITS" 2>/dev/null; then
  log "PULL: SHA $TARGET_SHA blacklisté (échec antérieur enregistré) — abandon sans téléchargement."
  exit 0
fi

# --- 4. Déjà déployé + site sain → rien à faire (zéro téléchargement).
#        Source de vérité : le finisher écrit last-deployed.txt au succès. ---
if [ -f "$LAST_DEPLOYED" ] && [ "$(cat "$LAST_DEPLOYED" 2>/dev/null)" = "$TARGET_SHA" ] \
   && curl -fsS -m 10 -o /dev/null http://127.0.0.1:3000/ 2>/dev/null; then
  exit 0
fi

# --- 5. Backoff transient : le même SHA a échoué il y a < 15 min
#        (réseau, intégrité, finisher non blacklistant) → attendre.
#        Un échec NE FIGE PLUS le SHA : la reprise est garantie. ---
if [ -f "$FAIL_FILE" ]; then
  FSHA=$(cut -d' ' -f1 "$FAIL_FILE" 2>/dev/null)
  FTS=$(cut -d' ' -f2 "$FAIL_FILE" 2>/dev/null)
  MAINTENANT=$(date +%s)
  if [ "$FSHA" = "$TARGET_SHA" ] && [ -n "$FTS" ] \
     && [ "$MAINTENANT" -ge 0 ] 2>/dev/null \
     && [ $((MAINTENANT - FTS)) -lt "$BACKOFF_S" ]; then
    exit 0
  fi
fi

# --- 6. Téléchargement + intégrité (échec = backoff, PAS de figeage) ---
log "PULL: nouveau build $TARGET_SHA — téléchargement depuis la release cd-latest…"
curl -fsSL -m 600 -o "$DL_TAR" \
  "https://github.com/$REPO/releases/download/cd-latest/next-build.tar.gz?_=$CACHEBUST" || {
  log "PULL ERREUR: téléchargement du tar impossible — nouvelle tentative au prochain poll (backoff ${BACKOFF_S}s)."
  marquer_echec; rm -f "$DL_TAR"; exit 1; }
[ -s "$DL_TAR" ] || { log "PULL ERREUR: tar vide — backoff."; marquer_echec; rm -f "$DL_TAR"; exit 1; }

curl -fsSL -m 30 -o "$DL_SHA" \
  "https://github.com/$REPO/releases/download/cd-latest/next-build.tar.gz.sha256?_=$CACHEBUST" || {
  log "PULL ERREUR: somme sha256 indisponible — backoff."; marquer_echec; rm -f "$DL_TAR"; exit 1; }
(cd /tmp && sha256sum -c next-build.tar.gz.sha256) || {
  log "PULL ERREUR: intégrité du tar invalide — fichiers purgés, backoff."
  marquer_echec; rm -f "$DL_TAR" "$DL_SHA"; exit 1; }

# --- 7. Finisher versionné AU MÊME SHA (jamais une copie obsolète) ---
curl -fsSL -m 30 -o /tmp/cd-finisher.sh \
  "https://raw.githubusercontent.com/$REPO/$TARGET_SHA/infra/deploy/cd-finisher.sh" || {
  log "PULL ERREUR: cd-finisher.sh inaccessible au SHA $TARGET_SHA — backoff."
  marquer_echec; exit 1; }

# --- 8. Bascule (swap atomique + health check + rollback + blacklist) ---
bash /tmp/cd-finisher.sh "$TARGET_SHA"
CODE=$?
if [ "$CODE" -eq 0 ]; then
  log "PULL: déploiement $TARGET_SHA terminé avec succès."
  rm -f "$FAIL_FILE"
else
  log "PULL: cd-finisher.sh a retourné $CODE (blacklist/rollback éventuel) — backoff ${BACKOFF_S}s."
  marquer_echec
fi
exit "$CODE"
