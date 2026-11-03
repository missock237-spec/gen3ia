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
#      (e49ca45 bloqué 2 h). Désormais : backoff puis réessai — la
#      reprise est garantie.
#   4. BUG v1 « retéléchargement en boucle » corrigé : v1 supprimait son
#      stamp après un succès — le même build (200 Mo) était retéléchargé
#      toutes les 2 min. Dernier SHA déployé + site sain → silence.
#   5. v3 (2026-11-02, levier identifié par it.81-c) : BACKOFF PROGRESSIF.
#      v2 imposait 15 min fixes après un échec transient — une livraison
#      mesurée à ~21 min (e256e55) alors que la cible est ≤ 2 min.
#      Désormais : retry rapide 60 s, puis 2 min, 5 min, plafond 15 min
#      (inchangé : 200 Mo par essai, la bande passante reste protégée).
#      Le compteur d'échecs est persisté PAR SHA (remis à zéro si le
#      build cible change), et un succès efface l'état d'échec.
#
# Garanties inchangées (déléguées à cd-finisher.sh) :
#   swap atomique, .env.production jamais touché, health check,
#   rollback automatique, blacklist des SHA en échec, flock.
#
# Usage : bash pull-deploy.sh            (poller ou manuel)
# Forcer un retéléchargement : rm -f /opt/gen3ia-updater/state/pull-fail.txt
#
# Politique de backoff (v3, mesurée et documentée) :
#   échec #1 → 60 s · #2 → 2 min · #3 → 5 min · #4+ → 15 min (plafond)
#
# v5 (it.92, 2026-11-03) — TÉLÉMÉTRIE SORTANTE (heartbeat HTTPS) :
#   fait mesuré au 6e blocage (04:34→10:05Z, 5 h 30) : le poller est
#   mort SANS AUCUN SIGNAL observable — deploy.log n'est lisible que
#   par SSH, et le SSH était muet. Désormais ce script écrit à CHAQUE
#   cycle (y compris « rien à faire ») un heartbeat dans le répertoire
#   servi par le site (/poller-heartbeat.json) : sa fraîcheur PROUVE
#   que le poller vit, son silence PROUVE qu'il est mort — observable
#   par le guérisseur en HTTPS pur, sans SSH, sans sonde à risque
#   d'auto-bannissement (guérisseur v9).
# =====================================================================
set -u

REPO=missock237-spec/gen3ia
UPDATER_DIR=/opt/gen3ia-updater
STATE_DIR=$UPDATER_DIR/state
LAST_DEPLOYED=$STATE_DIR/last-deployed.txt
FAILED_COMMITS=$STATE_DIR/failed_commits.txt
FAIL_FILE=$STATE_DIR/pull-fail.txt     # « <sha> <epoch> <compteur> » du dernier échec TRANSIENT
PROD_DIR=/opt/gen3ia
# v5 — heartbeat sortant : servi par l'app à https://gen3ia.online/poller-heartbeat.json
HEARTBEAT=$PROD_DIR/public/poller-heartbeat.json
# v3 — backoff progressif : retry rapide (un échec transient réseau se
# répare en secondes), puis paliers ; le plafond v2 reste la protection
# bande passante (200 Mo par essai, 2 Go de RAM).
BACKOFF_PLAFOND_S=900                  # plafond : 15 min entre deux tentatives du même SHA
PALIERS_S=(60 120 300)                 # retry rapide 60 s, puis 2 min, 5 min
DL_TAR=/tmp/next-build.tar.gz
DL_SHA=/tmp/next-build.tar.gz.sha256

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$STATE_DIR/deploy.log"; echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

# v5 — battement : écrit le heartbeat. Ne JAMAIS laisser un échec
# d'écriture tuer le déploiement (|| true). Les notes sont des chaînes
# ASCII fixes maîtrisées ici — pas d'injection JSON possible.
battement() { # $1 = sha cible lu du meta.json ("" si release absente), $2 = note courte
  printf '{"ok":true,"ts":"%s","epoch":%s,"poller":"pull-deploy v5","targetSha":"%s","servedSha":"%s","note":"%s"}\n' \
    "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$(date +%s)" "$1" \
    "$(cat "$LAST_DEPLOYED" 2>/dev/null || echo '')" "$2" \
    > "$HEARTBEAT" 2>/dev/null || true
}
mkdir -p "$STATE_DIR" 2>/dev/null || true

palier_pour() {
  # $1 = compteur d'échecs (≥1) → secondes à attendre avant la prochaine
  # tentative : 60 s, 2 min, 5 min, puis plafond 15 min (v2 inchangé).
  case "${1:-1}" in
    1) echo 60 ;;
    2) echo 120 ;;
    3) echo 300 ;;
    *) echo "$BACKOFF_PLAFOND_S" ;;
  esac
}

marquer_echec() {
  # Incrémente le compteur d'échecs du SHA courant (repart à 1 si le
  # build cible a changé — un nouveau SHA repart avec le retry rapide).
  local ancien_sha ancien_n nouveau_n palier
  ancien_sha=$(cut -d' ' -f1 "$FAIL_FILE" 2>/dev/null || true)
  ancien_n=$(cut -d' ' -f3 "$FAIL_FILE" 2>/dev/null || true)
  case "$ancien_n" in ''|*[!0-9]*) ancien_n=0 ;; esac
  if [ "$ancien_sha" = "$TARGET_SHA" ]; then nouveau_n=$((ancien_n + 1)); else nouveau_n=1; fi
  printf '%s %s %s\n' "$TARGET_SHA" "$(date +%s)" "$nouveau_n" > "$FAIL_FILE" 2>/dev/null || true
  palier=$(palier_pour "$nouveau_n")
  log "PULL: échec #$nouveau_n sur $TARGET_SHA — prochaine tentative dans ${palier}s (backoff progressif)."
}

# --- 1. Manifeste du dernier build publié (meta.json déposé en dernier
#        par le workflow : sa présence garantit un build complet) ---
CACHEBUST="$(date +%s)"
META=$(curl -fsSL -m 20 -H "Cache-Control: no-cache" \
  "https://github.com/$REPO/releases/download/cd-latest/meta.json?_=$CACHEBUST" 2>/dev/null) || {
  log "PULL: release cd-latest indisponible (aucun build runner publié ?) — silence."
  battement "" "release cd-latest indisponible"; exit 0; }

TARGET_SHA=$(printf '%s' "$META" | grep -o '"sha":"[0-9a-f]*"' | head -1 | sed 's/.*:"//; s/"$//')
[ -n "$TARGET_SHA" ] || { log "PULL: meta.json illisible — silence."; battement "" "meta.json illisible"; exit 0; }

# --- v5 : heartbeat écrit CHAQUE cycle, AVANT toute sortie précoce
#        (self-update, blacklist, « déjà déployé + site sain », backoff)
#        — c'est le cas majoritaire « rien à faire » qui doit prouver la
#        vie du poller. Un téléchargement long (600 s max) ou une bascule
#        (finisher, updater suspendu) peuvent porter l'écart entre deux
#        battements à ~17 min : le guérisseur v9 ne conclut au silence
#        qu'au-delà de 1200 s. ---
battement "$TARGET_SHA" ""

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

# --- 5. Backoff transient progressif (v3) : le même SHA a échoué —
#        l'attente dépend du compteur d'échecs persisté (60 s, puis
#        2/5/15 min) au lieu des 15 min fixes de v2 qui portaient les
#        livraisons à ~21 min. Un état v2 (2 champs, sans compteur) est
#        lu avec le compteur par défaut 1 (retry rapide). Un échec NE
#        FIGE PLUS le SHA : la reprise est garantie. ---
if [ -f "$FAIL_FILE" ]; then
  FSHA=$(cut -d' ' -f1 "$FAIL_FILE" 2>/dev/null)
  FTS=$(cut -d' ' -f2 "$FAIL_FILE" 2>/dev/null)
  FN=$(cut -d' ' -f3 "$FAIL_FILE" 2>/dev/null)
  case "$FN" in ''|*[!0-9]*) FN=1 ;; esac
  PALIER=$(palier_pour "$FN")
  MAINTENANT=$(date +%s)
  if [ "$FSHA" = "$TARGET_SHA" ] && [ -n "$FTS" ] \
     && [ "$MAINTENANT" -ge 0 ] 2>/dev/null \
     && [ $((MAINTENANT - FTS)) -lt "$PALIER" ]; then
    exit 0
  fi
fi

# --- 6. Téléchargement + intégrité (échec = backoff, PAS de figeage).
#        v4 (issue #120, 2026-11-02) — REPRISE : un tar partiel d'un
#        essai interrompu n'est plus jeté ; curl -C - reprend au bon
#        octet au prochain poll. Repartir de zéro à chaque échec
#        (200 Mo × N essais) était la vraie cause des livraisons
#        dépassant le SLE du CD. Le marqueur pull-partial.txt garantit
#        qu'on ne « reprend » jamais le tar d'un AUTRE SHA (un resume
#        croisé produirait un tar invalide). L'intégrité sha256 reste
#        le verrou final : un tar corrompu ne peut JAMAIS atteindre le
#        finisher ; après une intégrité invalide, le tar est purgé —
#        l'essai suivant repart proprement de zéro. ---
log "PULL: nouveau build $TARGET_SHA — téléchargement depuis la release cd-latest…"
curl -fsSL -m 60 -o "$DL_SHA" \
  "https://github.com/$REPO/releases/download/cd-latest/next-build.tar.gz.sha256?_=$CACHEBUST" || {
  log "PULL ERREUR: somme sha256 indisponible — backoff."; marquer_echec; rm -f "$DL_SHA"; exit 1; }
PARTIAL_MARK=$STATE_DIR/pull-partial.txt
# set -u : pas d'élément dans un tableau vide — `${OPT[@]}` est sûr en
# bash ≥ 4.4 (AlmaLinux EL8+/Ubuntu runners : bash 4.4+ / 5.x).
if [ -s "$DL_TAR" ] && [ "$(cat "$PARTIAL_MARK" 2>/dev/null)" = "$TARGET_SHA" ]; then
  log "PULL: reprise du téléchargement interrompu ($(stat -c%s "$DL_TAR" 2>/dev/null || echo 0) octets déjà obtenus)."
  OPT_RESUME=(-C -)
else
  rm -f "$DL_TAR" "$PARTIAL_MARK"
  OPT_RESUME=()
fi
printf '%s\n' "$TARGET_SHA" > "$PARTIAL_MARK" 2>/dev/null || true
if ! curl -fsSL -m 600 ${OPT_RESUME[@]+"${OPT_RESUME[@]}"} -o "$DL_TAR" \
    "https://github.com/$REPO/releases/download/cd-latest/next-build.tar.gz?_=$CACHEBUST"; then
  # Le marqueur est posé (posé AVANT le curl) : le prochain poll reprendra
  # au bon octet. Seule exception : le tar est DÉJÀ complet (exit 416 de
  # « resume sur fichier complet ») — l'intégrité le prouve, on poursuit.
  if (cd /tmp && sha256sum -c next-build.tar.gz.sha256) >/dev/null 2>&1; then
    log "PULL: curl en échec mais le tar est complet et intègre — poursuite."
  else
    log "PULL ERREUR: téléchargement du tar impossible — tar partiel CONSERVÉ pour reprise — nouvelle tentative au prochain poll."
    marquer_echec; exit 1;
  fi
fi
[ -s "$DL_TAR" ] || { log "PULL ERREUR: tar vide — backoff."; marquer_echec; rm -f "$DL_TAR" "$PARTIAL_MARK"; exit 1; }
(cd /tmp && sha256sum -c next-build.tar.gz.sha256) || {
  log "PULL ERREUR: intégrité du tar invalide — fichiers purgés, backoff."
  marquer_echec; rm -f "$DL_TAR" "$DL_SHA" "$PARTIAL_MARK"; exit 1; }
rm -f "$PARTIAL_MARK"   # tar complet et intègre : la reprise n'a plus d'objet

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
  log "PULL: cd-finisher.sh a retourné $CODE (blacklist/rollback éventuel)."
  marquer_echec
fi
exit "$CODE"
