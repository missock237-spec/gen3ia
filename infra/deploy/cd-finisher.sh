#!/bin/bash
# =====================================================================
# Gen3ia — Bascule en production d'un build compilé par le runner GitHub.
# Appelé par le workflow « Déploiement continu VPS » (deploy-vps.yml) et
# par le poller pull (pull-deploy.sh, qui le télécharge AU SHA CIBLE —
# tout correctif committé ici s'auto-livre au prochain cycle, sans SSH).
#
# v7 (2026-11-04, it.99 — blocage CD n°8 : échecs finisher < 60 s sur 2
# SHAs distincts, cause environnementale VPS, observables SSH épuisés) :
#   · ÉTAPES VISIBLES SANS SSH : chaque phase écrit le battement public
#     (public/poller-heartbeat.json, même format que le poller) — le
#     prochain échec se LIT depuis l'extérieur (note finisher-echec:<etape>),
#     fini l'angle mort deploy.log ;
#   · PRÉ-VOL DISQUE : si /opt a moins de MIN_LIBRE_MO, nettoyage sûr
#     (staging/.next, caches npm, tars /tmp de plus d'une heure) puis
#     re-check — un disque plein est le candidat n°1 d'une extraction
#     en échec instantané ; l'échec résiduel est documenté :disque ;
#   · FETCH BORNÉ : `timeout` sur git fetch (un fetch pendu tenait le
#     verrou indéfiniment) + repli sur l'URL ANONYME (dépôt public —
#     un jeton embarqué périmé dans origin ne doit plus bloquer un
#     déploiement) + mode dégradé (SHA déjà connu : bascule sans sync
#     source, averti en log) — candidat n°2 d'un échec en secondes ;
#   · Les GARANTIES « sans destruction d'état » sont INTACTES :
#     .env.production jamais touché ; l'app courante sert pendant tout
#     le transfert ; swap .next atomique avec .next.old conservé ;
#     health check + ROLLBACK automatique ; blacklist des SHAs en échec ;
#     updater PM2 suspendu puis relancé par trap dans tous les cas.
#
# v8 (2026-11-04 — blocage CD n°9 : prod gelée sur e78dd5d de 13:08Z à
# 20:30Z, SIX builds publiés sans bascule, diagnostic SANS SSH par les
# phases du battement v6 + trois signatures ENOSPC concordantes :
#   (a) AUCUN blacklist depuis 13:27 alors que les chemins extraction/
#       npm-ci blacklistent — l'écriture de failed_commits.txt échouait ;
#   (b) backoff cassé (retries serrés sans respecter le palier 900 s) —
#       l'écriture de pull-fail.txt échouait ;
#   (c) échec du téléchargement en ~6 s (écriture du tar en échec).
# Cause racine : le déploiement réussi de 13:08 (extraction ~900 Mo +
# npm ci) a SATURÉ le disque ; le pré-vol v7 était trop timide pour
# libérer les 1500 Mo exigés (il n'osait ni .next/cache runtime, ni
# journalctl, ni les vieux tars, ni node_modules.old/.next.old) et
# l'extraction ENOSPC n'avait AUCUNE reprise après libération) :
#   · ÉCHELLE DE LIBÉRATION progressive en 11 niveaux, du plus sûr au
#     plus instrusif, chaque niveau re-mesure et s'arrête dès le seuil :
#     staging/.next (extractions partielles) → npm cache → vieux tars
#     /tmp → .next/cache runtime de la prod (reconstruit à la volée) →
#     journalctl vacuum → apt cache → pm2 flush → rotation deploy.log →
#     git gc du dépôt prod → TOUS les vieux tars (sans âge, sauf le tar
#     courant) → EMERGENCY .next.old/node_modules.old (rollback
#     volontairement sacrifié, documenté dans le log) ;
#   · REPRISE D'EXTRACTION : si tar xzf échoue (ENOSPC), l'échelle est
#     rejouée puis l'extraction réessayée UNE fois — plus jamais un
#     disque presque plein ne transforme un build bon en SHA perdu ;
#   · GARDE npm ci : exigence disque NPM_MIN_MO (2600) — si le lockfile
#     a changé mais la place manque, npm ci est SKIPPÉ honnêtement
#     (note finisher-npm-ci-skip-disque) plutôt qu'un échec + blacklist
#     en cascade : le build reste déployable (deps bundlées) et le
#     health check arbitre ;
#   · HANDOFF des manifests : le tar du CD embarque désormais
#     package.json + package-lock.json (deploy-vps.yml v8) — le finisher
#     les copie dans le staging AVANT la décision npm ci : le lockfile
#     du staging ne peut plus diverger du build (trou structurel du
#     canal pull depuis sa création : le tar ne contenait que .next) ;
#   · ROLLBACK HONNÊTE : si .next.old a été purgé par l'échelle
#     d'urgence, le rollback est impossible — dit et noté tel quel
#     (finisher-echec:sante-sans-rollback), jamais simulé ;
#   · ROTATION deploy.log : cap 5 Mo (le log croissait sans borne —
#     sur un petit disque il devient lui-même une menace) ;
#   · Overrides GEN3IA_*_DIR : aucun effet sur le VPS (jamais définis),
#     mais rendent le finisher testable hors /opt (harnais).
# Usage : bash cd-finisher.sh <SHA_DE_MAIN_A_DEPLOYER> [TAR_PATH]
# =====================================================================
set -u

TARGET_SHA="${1:?Usage: cd-finisher.sh <SHA> [TAR_PATH]}"
# Canal d'artefacts (séparation 2026-10-28, run 0c0e21aa) : le canal SSH du
# CD et le poller pull exécutent le MÊME finisher mais dans des répertoires
# DISTINCTS. Le trap purge les artefacts à l'exit — s'ils étaient partagés,
# le canal le plus rapide détruisait ceux de l'autre (race observée :
# poller déployé à 10:20 → purge → swap SSH du CD en 127 ×4 sur
# /tmp/cd-finisher.sh absent). 2e argument optionnel = chemin du tar.
TAR_PATH="${2:-/tmp/next-build.tar.gz}"
# v8 — overrides de test (le VPS ne les définit jamais : zéro effet en prod)
PROD_DIR="${GEN3IA_PROD_DIR:-/opt/gen3ia}"
STAGING_DIR="${GEN3IA_STAGING_DIR:-/opt/gen3ia-staging}"
UPDATER_DIR="${GEN3IA_UPDATER_DIR:-/opt/gen3ia-updater}"
MIN_LIBRE_MO="${GEN3IA_MIN_MO:-1500}"      # plancher pour extraire (~900 Mo) + marge
NPM_MIN_MO="${GEN3IA_NPM_MO:-2600}"        # plancher pour npm ci (arbre + cache)
STATE_DIR=$UPDATER_DIR/state
LAST_DEPLOYED=$STATE_DIR/last-deployed.txt
FAILED_COMMITS=$STATE_DIR/failed_commits.txt
DEPLOY_LOG=$STATE_DIR/deploy.log
HEARTBEAT=$PROD_DIR/public/poller-heartbeat.json
REPO_ANONYME="https://github.com/missock237-spec/gen3ia.git"

log() {
  # v8 — rotation : le log ne peut plus croître sans borne (sur un petit
  # disque, le journal du déploiement devient lui-même une menace ENOSPC).
  if [ -f "$DEPLOY_LOG" ] && [ "$(stat -c%s "$DEPLOY_LOG" 2>/dev/null || echo 0)" -gt 5000000 ]; then
    tail -n 4000 "$DEPLOY_LOG" > "${DEPLOY_LOG}.rot" 2>/dev/null \
      && mv "${DEPLOY_LOG}.rot" "$DEPLOY_LOG" 2>/dev/null || true
  fi
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$DEPLOY_LOG" 2>/dev/null || true
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

# v7 — télémétrie d'étape SANS SSH : même format que le battement du
# poller (champ poller identique pour la continuité des greps du
# guérisseur). Ne JAMAIS laisser un échec d'écriture tuer le déploiement.
etape() { # $1 = note courte (finisher-<phase> / finisher-echec:<phase>)
  local servi
  servi=$(cat "$LAST_DEPLOYED" 2>/dev/null || echo '')
  printf '{"ok":true,"ts":"%s","epoch":%s,"poller":"pull-deploy v6","targetSha":"%s","servedSha":"%s","note":"%s"}\n' \
    "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$(date +%s)" "$TARGET_SHA" "$servi" "$1" \
    > "$HEARTBEAT" 2>/dev/null || true
}

libre_mo() { df -m "$PROD_DIR" 2>/dev/null | awk 'NR==2{print $4}' ; }

# v8 — ÉCHELLE DE LIBÉRATION DISQUE. Du plus sûr au plus instrusif ;
# chaque niveau re-mesure et TOUT s'arrête dès le seuil atteint.
# Résultat : variable globale RESCUE_LIBRE (Mo libres après échelle) ;
# RESCUE_ROLLBACK_PERDU=1 si le niveau d'urgence a sacrifié .next.old.
RESCUE_LIBRE=""
RESCUE_ROLLBACK_PERDU=0
rescue_disk() { # $1 = seuil Mo cible
  local cible="$1" libre
  libre=$(libre_mo)
  RESCUE_LIBRE="$libre"
  [ -z "$libre" ] && return 0
  [ "$libre" -ge "$cible" ] && return 0

  # — Niveau 1 : extractions partielles du staging (reconstruites du tar) —
  [ "$libre" -lt "$cible" ] && { rm -rf "$STAGING_DIR/.next" 2>/dev/null || true; libre=$(libre_mo); RESCUE_LIBRE="$libre"; \
    log "CD RESCUE n1: staging/.next purgé — ${libre:-?} Mo libres."; }

  # — Niveau 2 : cache npm (re-téléchargeable) —
  if [ "$libre" -lt "$cible" ]; then
    timeout 120 npm cache clean --force >/dev/null 2>&1 || true
    libre=$(libre_mo); RESCUE_LIBRE="$libre"
    log "CD RESCUE n2: cache npm purgé — ${libre:-?} Mo libres."
  fi

  # — Niveau 3 : tars /tmp de plus d'une heure (JAMAIS le tar courant) —
  if [ "$libre" -lt "$cible" ]; then
    find /tmp -maxdepth 1 -name 'next-build.tar.gz*' -mmin +60 ! -path "$TAR_PATH" -delete 2>/dev/null || true
    find /tmp/cd-channel -maxdepth 1 -name 'next-build.tar.gz*' -mmin +60 -delete 2>/dev/null || true
    find /tmp -maxdepth 1 -name 'pull-deploy.*' -mmin +60 -delete 2>/dev/null || true
    find /tmp -maxdepth 1 -name 'cd-finisher.sh' -mmin +60 ! -path "$0" -delete 2>/dev/null || true
    libre=$(libre_mo); RESCUE_LIBRE="$libre"
    log "CD RESCUE n3: vieux tars /tmp purgés — ${libre:-?} Mo libres."
  fi

  # — Niveau 4 (v8) : .next/cache RUNTIME de la prod (fetch/ISR cache —
  #    reconstruit à la volée par Next ; la prod continue de servir) —
  if [ "$libre" -lt "$cible" ]; then
    rm -rf "$PROD_DIR/.next/cache" 2>/dev/null || true
    libre=$(libre_mo); RESCUE_LIBRE="$libre"
    log "CD RESCUE n4: prod .next/cache purgé — ${libre:-?} Mo libres."
  fi

  # — Niveau 5 : journal systemd borné à 50 Mo —
  if [ "$libre" -lt "$cible" ]; then
    timeout 30 journalctl --vacuum-size=50M >/dev/null 2>&1 || true
    libre=$(libre_mo); RESCUE_LIBRE="$libre"
    log "CD RESCUE n5: journalctl vacuum 50 Mo — ${libre:-?} Mo libres."
  fi

  # — Niveau 6 : cache apt —
  if [ "$libre" -lt "$cible" ]; then
    timeout 30 apt-get clean >/dev/null 2>&1 || true
    libre=$(libre_mo); RESCUE_LIBRE="$libre"
    log "CD RESCUE n6: apt cache purgé — ${libre:-?} Mo libres."
  fi

  # — Niveau 7 : logs PM2 (JAMAIS deploy.log) —
  if [ "$libre" -lt "$cible" ]; then
    timeout 30 pm2 flush >/dev/null 2>&1 || true
    libre=$(libre_mo); RESCUE_LIBRE="$libre"
    log "CD RESCUE n7: pm2 flush — ${libre:-?} Mo libres."
  fi

  # — Niveau 8 : rotation immédiate du journal de déploiement —
  if [ "$libre" -lt "$cible" ] && [ -f "$DEPLOY_LOG" ] && [ "$(stat -c%s "$DEPLOY_LOG" 2>/dev/null || echo 0)" -gt 1000000 ]; then
    tail -n 3000 "$DEPLOY_LOG" > "${DEPLOY_LOG}.rot" 2>/dev/null \
      && mv "${DEPLOY_LOG}.rot" "$DEPLOY_LOG" 2>/dev/null || true
    libre=$(libre_mo); RESCUE_LIBRE="$libre"
    log "CD RESCUE n8: deploy.log rota — ${libre:-?} Mo libres."
  fi

  # — Niveau 9 (v8) : git gc du dépôt prod (les fetch répétés fragmentent
  #    les packs ; un gc borné récupère des centaines de Mo) —
  if [ "$libre" -lt "$cible" ]; then
    ( cd "$PROD_DIR" && timeout 90 git gc --prune=now --quiet >/dev/null 2>&1 ) || true
    libre=$(libre_mo); RESCUE_LIBRE="$libre"
    log "CD RESCUE n9: git gc prod — ${libre:-?} Mo libres."
  fi

  # — Niveau 10 (v8) : TOUS les tars /tmp SANS condition d'âge (sauf le
  #    courant) : sur un disque saturé, un tar de 208 Mo vieux de 5 min
  #    d'un AUTRE canal (SSH) ne doit pas bloquer la bascule — le canal
  #    auteur le re-télécharge, son intégrité reste le verrou final. —
  if [ "$libre" -lt "$cible" ]; then
    find /tmp -maxdepth 1 -name 'next-build.tar.gz*' ! -path "$TAR_PATH" -delete 2>/dev/null || true
    find /tmp/cd-channel -maxdepth 1 -type f -delete 2>/dev/null || true
    libre=$(libre_mo); RESCUE_LIBRE="$libre"
    log "CD RESCUE n10: tous tars /tmp (sauf courant) purgés — ${libre:-?} Mo libres."
  fi

  # — Niveau 11 (v8, EMERGENCY documentée) : les copies de rollback
  #    .next.old/node_modules.old. Sacrifier la capacité de rollback
  #    automatique est VRAIMENT plus acceptable qu'une prod gelée :
  #    le health check arbitre le nouveau build et, s'il échoue sans
  #    possibilité de rollback, l'échec est dit et noté tel quel. —
  if [ "$libre" -lt "$cible" ]; then
    if [ -d "$PROD_DIR/.next.old" ] || [ -d "$PROD_DIR/node_modules.old" ]; then
      rm -rf "$PROD_DIR/.next.old" "$PROD_DIR/node_modules.old" 2>/dev/null || true
      RESCUE_ROLLBACK_PERDU=1
      libre=$(libre_mo); RESCUE_LIBRE="$libre"
      log "CD RESCUE n11 EMERGENCY: .next.old/node_modules.old purgés (rollback sacrifié) — ${libre:-?} Mo libres."
    fi
  fi

  # — Rapport de consommation (diagnostic du prochain blocage sans SSH) —
  if [ "$libre" -lt "$cible" ]; then
    log "CD RESCUE: seuil NON atteint — top consommateurs :"
    timeout 45 du -sm "$PROD_DIR" "$STAGING_DIR" "$UPDATER_DIR" /tmp /var/log 2>/dev/null | sort -rn | head -8 \
      | while IFS= read -r l; do log "CD RESCUE du: $l"; done || true
  fi
  return 0
}

mkdir -p "$STATE_DIR" 2>/dev/null || true
touch "$FAILED_COMMITS" 2>/dev/null || true
export PATH=$PATH:/usr/local/bin:/usr/bin
export GIT_TERMINAL_PROMPT=0   # v7 : un fetch ne doit jamais attendre une saisie

# --- Un seul déploiement à la fois ---
exec 9>"$STATE_DIR/deploy.lock" 2>/dev/null || exec 9>/tmp/gen3ia-deploy.lock
if ! flock -n 9; then log "CD: un déploiement est déjà en cours — abandon."; exit 1; fi
etape "finisher-debut"

# --- Suspendre l'updater (relancé par trap dans tous les cas) ---
pm2 stop updater >/dev/null 2>&1 || true
# trap combiné : updater relancé + artefacts temporaires purgés (aucun tar
# orphelin dans /tmp, même en cas d'échec) — durcissement 2026-10-22.
purge_canal() {
  rm -f "$TAR_PATH" 2>/dev/null || true
  # $0 purgé SEULEMENT s'il vit dans /tmp (copie SCP / téléchargement poller)
  # — jamais le script du dépôt si un dev l'exécute depuis son checkout.
  case "$0" in /tmp/*) rm -f "$0";; esac
}
trap 'pm2 start updater >/dev/null 2>&1 || true; purge_canal' EXIT

# --- Vérifier le SHA cible ---
[ -f "$TAR_PATH" ] || { log "CD ERREUR: $TAR_PATH absent (scp a échoué ?)"; etape "finisher-echec:tar-absent"; exit 1; }
cd "$PROD_DIR" || { log "CD ERREUR: $PROD_DIR introuvable"; etape "finisher-echec:prod-absent"; exit 1; }

# --- Pré-vol disque v8 : échelle de libération progressive (11 niveaux).
#        Un disque plein est la cause racine PROUVÉE du blocage n°9
#        (trois signatures ENOSPC concordantes, cf. en-tête). ---
LIBRE=$(libre_mo)
if [ -n "$LIBRE" ] && [ "$LIBRE" -lt "$MIN_LIBRE_MO" ]; then
  log "CD PRÉ-VOL: ${LIBRE} Mo libres < ${MIN_LIBRE_MO} — échelle de libération v8…"
  rescue_disk "$MIN_LIBRE_MO"
  log "CD PRÉ-VOL: après échelle — ${RESCUE_LIBRE:-?} Mo libres (avant : ${LIBRE})."
  if [ -z "${RESCUE_LIBRE:-}" ] || [ "${RESCUE_LIBRE}" -lt "$MIN_LIBRE_MO" ] 2>/dev/null; then
    log "CD ERREUR: disque insuffisant (${RESCUE_LIBRE:-?} Mo libres < ${MIN_LIBRE_MO}) — extraction avortée SANS blacklist (cause environnementale, pas le build)."
    etape "finisher-echec:disque-${RESCUE_LIBRE:-?}mo"
    exit 1
  fi
else
  log "CD PRÉ-VOL: ${LIBRE:-?} Mo libres — OK."
fi

# --- v7 : fetch borné + repli anonyme + mode dégradé (candidat n°2 :
#        jeton embarqué périmé dans l'origin du VPS — le dépôt est PUBLIC,
#        un fetch anonyme suffit ; un SHA déjà rapatrié permet même de
#        basculer sans réseau). ---
etape "finisher-fetch"
SYNC_SOURCE=1
if ! timeout 60 git fetch origin --quiet 2>>"$DEPLOY_LOG"; then
  log "CD AVERTISSEMENT: git fetch origin a échoué (borné 60 s) — repli URL anonyme (dépôt public, branche main seule)…"
  if timeout 60 git fetch "$REPO_ANONYME" main --quiet 2>>"$DEPLOY_LOG"; then
    log "CD: fetch anonyme OK — l'origin configuré est vraisemblablement porteur d'un jeton périmé (à corriger en console, non bloquant)."
  elif git cat-file -e "$TARGET_SHA" 2>/dev/null; then
    SYNC_SOURCE=0
    log "CD MODE DÉGRADÉ: fetch impossible mais $TARGET_SHA déjà connu localement — bascule SANS sync source (le .next livré est autonome)."
  else
    log "CD ERREUR: git fetch a échoué (2 voies) et SHA inconnu du dépôt — backoff."
    etape "finisher-echec:fetch"
    exit 1
  fi
fi
git cat-file -e "$TARGET_SHA" 2>/dev/null || { log "CD ERREUR: SHA $TARGET_SHA inconnu du dépôt"; etape "finisher-echec:sha-inconnu"; exit 1; }

# --- BLACKLIST (durcissement 2026-10-22) : un SHA ayant déjà échoué
# (npm ci, extraction, health check) n'est plus jamais re-basculé :
# exit 3 — le workflow distingue ce cas et n'insiste pas. ---
if grep -qxF "$TARGET_SHA" "$FAILED_COMMITS" 2>/dev/null; then
  log "CD: SHA $TARGET_SHA blacklisté (échec antérieur enregistré) — abandon sans bascule."
  etape "finisher-echec:blackliste"
  exit 3
fi

# --- Idempotence : déjà déployé + site sain → rien à faire (retry SSH sûrs) ---
DEPLOYED=$(cat "$LAST_DEPLOYED" 2>/dev/null || git rev-parse HEAD)
if [ "$TARGET_SHA" = "$DEPLOYED" ] && curl -fsS -m 10 -o /dev/null http://127.0.0.1:3000/ 2>/dev/null; then
  log "CD: $TARGET_SHA déjà déployé et site en bonne santé — rien à faire."
  rm -f "$TAR_PATH" 2>/dev/null || true
  case "$0" in /tmp/*) rm -f "$0";; esac
  exit 0
fi

log "CD === DÉPLOIEMENT $TARGET_SHA (runner GitHub) ==="

# --- Extraction du build livré par le runner (dans le staging) ---
# Durcissement 2026-10-28 (CD #133) : checksum publié par le runner vérifié
# AVANT de toucher au staging. v8 : si l'extraction échoue (ENOSPC typique),
# l'échelle de libération est REJOUÉE puis l'extraction réessayée UNE fois.
log "CD: vérification de l'intégrité du build livré…"
if [ -f "$TAR_PATH.sha256" ]; then
  if ! (cd "$(dirname "$TAR_PATH")" && sha256sum -c "$(basename "$TAR_PATH").sha256" >/dev/null 2>&1); then
    # Code 4 = transfert SCP corrompu. AUCUN blacklist : la corruption est un
    # problème du CHEMIN de transfert SSH, pas du build lui-même — la release
    # cd-latest (téléchargée par le canal pull avec vérification checksum
    # propre) reste intègre et DOIT rester déployable pour ce même SHA.
    log "CD ERREUR: checksum du build INVALIDE (transfert SSH corrompu/incomplet) — PAS de blacklist (le canal pull reprendra ce même SHA depuis la release, intègre)."
    etape "finisher-echec:checksum"
    exit 4
  fi
  log "CD: checksum build OK."
else
  log "CD AVERTISSEMENT: .sha256 absent (ancien canal ?) — extraction sans vérification d'intégrité."
fi
etape "finisher-extraction"
log "CD: extraction du build runner dans staging…"
rm -rf "$STAGING_DIR/.next" 2>/dev/null || true
mkdir -p "$STAGING_DIR/.next"
if ! tar xzf "$TAR_PATH" -C "$STAGING_DIR/.next"; then
  LIBRE_TAR=$(libre_mo)
  log "CD ERREUR: extraction tar (libre restant : ${LIBRE_TAR:-?} Mo) — échelle de secours puis UNE reprise…"
  rescue_disk "$MIN_LIBRE_MO"
  rm -rf "$STAGING_DIR/.next" 2>/dev/null || true
  mkdir -p "$STAGING_DIR/.next"
  if ! tar xzf "$TAR_PATH" -C "$STAGING_DIR/.next"; then
    LIBRE_TAR2=$(libre_mo)
    log "CD ERREUR: extraction tar en échec après reprise (${LIBRE_TAR2:-?} Mo) — SHA blacklisté, production intacte."
    echo "$TARGET_SHA" >> "$FAILED_COMMITS" 2>/dev/null || log "CD AVERTISSEMENT: écriture blacklist impossible (fs plein ?)."
    etape "finisher-echec:extraction"
    exit 1
  fi
  log "CD RESCUE: reprise d'extraction RÉUSSIE après libération (${RESCUE_LIBRE:-?} Mo)."
fi
[ -f "$STAGING_DIR/.next/BUILD_ID" ] || { log "CD ERREUR: BUILD_ID absent — blacklist."; echo "$TARGET_SHA" >> "$FAILED_COMMITS" 2>/dev/null || true; etape "finisher-echec:build-id"; exit 1; }
log "CD: BUILD_ID=$(cat "$STAGING_DIR/.next/BUILD_ID")"

# --- v8 — HANDOFF des manifests du build vers le staging.
#        Le tar du CD embarque package.json + package-lock.json (racine de
#        l'archive, extraits dans staging/.next/) — copiés à la RACINE du
#        staging AVANT la décision npm ci : le lockfile du staging suit
#        désormais TOUJOURS le build (trou structurel du canal pull fermé :
#        son tar ne contenait que .next depuis sa création). Tars plus
#        anciens : repli silencieux sur les manifests existants.
#        v8 — ORDRE CORRIGÉ : extraction D'ABORD (les manifests voyagent
#        dans le tar), handoff, PUIS npm ci — on n'installe plus jamais
#        des dépendances pour un build dont le tar s'avérerait mauvais. ---
if [ -f "$STAGING_DIR/.next/package.json" ]; then
  cp "$STAGING_DIR/.next/package.json" "$STAGING_DIR/package.json" 2>/dev/null || true
  [ -f "$STAGING_DIR/.next/package-lock.json" ] \
    && cp "$STAGING_DIR/.next/package-lock.json" "$STAGING_DIR/package-lock.json" 2>/dev/null || true
  log "CD: manifests du build handoffés au staging (package.json + lock)."
fi

# --- Dépendances staging : npm ci UNIQUEMENT si le lockfile a changé.
#        v8 — GARDE DISQUE : npm ci exige NPM_MIN_MO libres (arbre ~2 Go +
#        cache de téléchargement). Place insuffisante → SKIP honnête (note
#        dédiée, PAS de blacklist) : le build reste déployable (deps
#        bundlées) et le health check arbitre réellement. ---
STAGING_LOCK_HASH=$(sha256sum "$STAGING_DIR/package-lock.json" 2>/dev/null | cut -d' ' -f1)
if [ ! -x "$STAGING_DIR/node_modules/.bin/next" ] || [ "$STAGING_LOCK_HASH" != "$(cat "$STATE_DIR/lock-hash.txt" 2>/dev/null)" ]; then
  LIBRE_NPM=$(libre_mo)
  if [ -n "$LIBRE_NPM" ] && [ "$LIBRE_NPM" -lt "$NPM_MIN_MO" ]; then
    log "CD AVERTISSEMENT: ${LIBRE_NPM} Mo libres < ${NPM_MIN_MO} — npm ci SKIPPÉ (garde disque v8) ; le staging garde ses dépendances actuelles, le health check jugera."
    etape "finisher-npm-ci-skip-disque"
  else
    etape "finisher-npm-ci"
    log "CD: npm ci staging (lockfile $STAGING_LOCK_HASH)…"
    if ! (cd "$STAGING_DIR" && npm ci --include=dev --no-audit --no-fund) >> "$DEPLOY_LOG" 2>&1; then
      log "CD ÉCHEC npm ci — SHA blacklisté, production intacte."
      echo "$TARGET_SHA" >> "$FAILED_COMMITS" 2>/dev/null || log "CD AVERTISSEMENT: écriture blacklist impossible (fs plein ?)."
      etape "finisher-echec:npm-ci"
      exit 1
    fi
    echo "$STAGING_LOCK_HASH" > "$STATE_DIR/lock-hash.txt" 2>/dev/null || true
  fi
fi

# --- Mise en production atomique ---
etape "finisher-swap"
log "CD: sync code source + swap .next + redémarrage…"
if [ "$SYNC_SOURCE" = "1" ]; then
  cd "$PROD_DIR"
  git reset --hard "$TARGET_SHA" >> "$DEPLOY_LOG" 2>&1 || { log "CD ERREUR: git reset — production intacte."; etape "finisher-echec:reset"; exit 1; }
else
  log "CD MODE DÉGRADÉ: sync source sautée (fetch impossible) — .next/node_modules restent la vérité servie."
fi
# v8 — si l'échelle d'urgence a déjà purgé .next.old, ce rm est un no-op
# inoffensif ; sinon le couple de rollback est reconstitué par le swap.
rm -rf .next.old 2>/dev/null || true
mv .next .next.old || { log "CD ERREUR: mv .next → .next.old impossible — production intacte."; etape "finisher-echec:swap"; exit 1; }
cp -al "$STAGING_DIR/.next" .next || { log "CD ERREUR: cp -al — restauration."; mv .next.old .next 2>/dev/null || true; etape "finisher-echec:swap"; exit 1; }

# BASCULE COMPLÈTE de node_modules avec version précédente conservée
# (durcissement 2026-10-22) : .next.old + node_modules.old = couple
# cohérent de rollback. cp -al = liens matériels (même FS) : coût quasi
# nul, cohérence exacte avec le node_modules validé du staging.
if [ -x "$STAGING_DIR/node_modules/.bin/next" ]; then
  rm -rf node_modules.old 2>/dev/null || true
  if [ -d node_modules ]; then
    mv node_modules node_modules.old || { log "CD AVERTISSEMENT: mv node_modules → .old impossible — l'ancien arbre reste en place."; }
  fi
  if ! cp -al "$STAGING_DIR/node_modules" node_modules; then
    log "CD ERREUR: bascule node_modules impossible — restauration de l'ancien arbre."
    if [ -d node_modules.old ] && [ ! -d node_modules ]; then mv node_modules.old node_modules 2>/dev/null || true; fi
    echo "$TARGET_SHA" >> "$FAILED_COMMITS" 2>/dev/null || true
    etape "finisher-echec:node-modules"
    exit 1
  fi
else
  log "CD AVERTISSEMENT: staging sans node_modules/.bin/next — node_modules inchangé."
fi

# --- Manifeste de version (mise à jour forcée navigateur, plan 4 étapes)
# 2026-10-23 : le runner l'a compilé à côté du BUILD_ID (.next/version.json,
# embarqué dans le tar car il ne contient que .next). Il est copié dans
# public/ APRÈS le git reset --hard (qui ne connaît que les fichiers
# suivis — le manifeste est un artefact gitignored). Absent (build
# antérieur au mécanisme) : repli silencieux sur la version suivie par git.
if [ -f "$STAGING_DIR/.next/version.json" ]; then
  cp "$STAGING_DIR/.next/version.json" "$PROD_DIR/public/version.json" 2>/dev/null \
    || log "CD AVERTISSEMENT: copie de version.json impossible — manifeste git conservé."
fi

pm2 restart gen3ia --update-env >> "$DEPLOY_LOG" 2>&1 || true

# --- Health check : rollback si le nouveau build ne répond pas ---
etape "finisher-sante"
sleep 5
HEALTH_OK=0
for i in 1 2 3 4 5 6; do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -m 10 http://127.0.0.1:3000/ 2>/dev/null)
  if [ "$CODE" = "200" ]; then HEALTH_OK=1; break; fi
  log "CD health check $i/6 : HTTP ${CODE:-?} — nouvelle tentative dans 15 s…"
  sleep 15
done

if [ "$HEALTH_OK" != "1" ]; then
  log "CD ÉCHEC DÉMARRAGE — ROLLBACK vers la version précédente."
  etape "finisher-echec:sante-rollback"
  if [ -d .next.old ]; then
    rm -rf .next 2>/dev/null || true
    mv .next.old .next || log "CD AVERTISSEMENT: restauration .next.old impossible — prod sur le nouveau build."
    if [ -d node_modules.old ]; then
      rm -rf node_modules 2>/dev/null || true
      mv node_modules.old node_modules 2>/dev/null || log "CD AVERTISSEMENT: restauration node_modules.old impossible."
    fi
    pm2 restart gen3ia --update-env >> "$DEPLOY_LOG" 2>&1 || true
    log "CD Rollback appliqué (.next + node_modules cohérents) — site sur la version précédente."
  else
    # v8 — rollback impossible (purge d'urgence ou couple absent) : HONNÊTETÉ
    # TOTALE — la prod reste sur le build en échec plutôt qu'une promesse
    # mensongère ; l'échec est blacklisté et visible dans le battement.
    log "CD ROLLBACK IMPOSSIBLE (.next.old absent — purge d'urgence v8 ?) : prod laissée sur le nouveau build en échec."
    etape "finisher-echec:sante-sans-rollback"
  fi
  echo "$TARGET_SHA" >> "$FAILED_COMMITS" 2>/dev/null || log "CD AVERTISSEMENT: écriture blacklist impossible (fs plein ?)."
  exit 2
fi

# --- Succès ---
rm -rf .next.old node_modules.old 2>/dev/null || true
echo "$TARGET_SHA" > "$LAST_DEPLOYED" 2>/dev/null || log "CD AVERTISSEMENT: écriture last-deployed impossible (fs plein ?)."

# --- Auto-sync du poller pull (boucle d'auto-guérison sans SSH) ---
# Le poller PM2 exécute /opt/gen3ia-updater/pull-deploy.sh — une copie
# installée une fois, qui ne suit pas le dépôt. On la remplace par la
# version AU SHA DÉPLOYÉ : chaque déploiement réussi aligne le poller
# (correctifs pull-deploy v2, backoff, self-update…). Non fatal :
# un échec réseau ici n'invalide jamais un déploiement sain.
POLLER_SRC="https://raw.githubusercontent.com/missock237-spec/gen3ia/$TARGET_SHA/scripts/vps-auto-deploy/pull-deploy.sh"
if curl -fsSL -m 20 "$POLLER_SRC" -o "$UPDATER_DIR/pull-deploy.sh.new" 2>/dev/null \
   && [ -s "$UPDATER_DIR/pull-deploy.sh.new" ] \
   && head -1 "$UPDATER_DIR/pull-deploy.sh.new" | grep -q '^#!'; then
  if ! cmp -s "$UPDATER_DIR/pull-deploy.sh.new" "$UPDATER_DIR/pull-deploy.sh" 2>/dev/null; then
    mv "$UPDATER_DIR/pull-deploy.sh.new" "$UPDATER_DIR/pull-deploy.sh" 2>/dev/null && chmod +x "$UPDATER_DIR/pull-deploy.sh" 2>/dev/null \
      && log "CD: poller pull-deploy.sh aligné sur le SHA $TARGET_SHA." \
      || log "CD AVERTISSEMENT: pose du poller aligné impossible (fs plein ?) — version courante conservée."
  else
    rm -f "$UPDATER_DIR/pull-deploy.sh.new" 2>/dev/null || true
  fi
else
  rm -f "$UPDATER_DIR/pull-deploy.sh.new" 2>/dev/null || true
  log "CD: sync du poller skippé (source inaccessible) — version courante conservée."
fi

log "CD DÉPLOIEMENT RÉUSSI : $(git log --oneline -1 2>/dev/null | head -c 120)"
etape "finisher-ok"
exit 0
