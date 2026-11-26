#!/bin/sh
# =====================================================================
# Gen3ia — entrypoint du conteneur Hyperlift (Spaceship).
#
# Principe : l'image ne contient PAS le build Next (le `next build`
# réclame > 3,5 Go de RSS — cf. .github/workflows/deploy-vps.yml).
# Au démarrage, l'entrypoint télécharge le build compilé par le runner
# GitHub depuis la release publique « cd-latest » (sha256 vérifié) :
#   · le build Docker reste léger et cache-stable (npm ci uniquement) ;
#   · chaque (re)start vérifie la FRAÎCHEUR du .next embarqué contre le
#     sha de la release — si différent, re-téléchargement : une image
#     Docker en cache ne peut donc jamais servir une version périmée ;
#   · l'auto-update complète vient du workflow hyperlift-auto-update
#     (POST /build à chaque push main → rebuild → restart → pull frais).
#
# Variables attendues (Hyperlift env) :
#   GEN3IA_REPO      dépôt GitHub (défaut missock237-spec/gen3ia)
#   PORT             port d'écoute imposé par la plateforme
# Les variables applicatives (Firestore, NextAuth…) sont fournies par
# l'environnement Hyperlift (PUT /environment) — jamais dans l'image.
# =====================================================================
set -u

REPO="${GEN3IA_REPO:-missock237-spec/gen3ia}"
APP_DIR="${GEN3IA_APP_DIR:-/app}"
NEXT_DIR="$APP_DIR/.next"
STATE_DIR="${GEN3IA_STATE_DIR:-$APP_DIR/.gen3ia-state}"
mkdir -p "$STATE_DIR"

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] entrypoint: $*"; }

# ── 1. SHA de la release courante ─────────────────────────────────────
SHA_CIBLE=$(curl -fsSL --max-time 30 "https://github.com/$REPO/releases/download/cd-latest/meta.json" 2>/dev/null \
  | grep -oE '"sha"[[:space:]]*:[[:space:]]*"[0-9a-f]{7,40}"' | head -1 | grep -oE '[0-9a-f]{7,40}' || true)
if [ -z "$SHA_CIBLE" ]; then
  log "ERREUR: meta.json cd-latest indisponible"
  if [ -d "$NEXT_DIR" ] && [ -f "$NEXT_DIR/BUILD_ID" ]; then
    log "repli: .next embarqué dans l'image"
  else
    log "aucun .next disponible — abandon"; exit 1
  fi
else
  ACTUEL=$(cat "$STATE_DIR/deployed-sha" 2>/dev/null || echo "")
  if [ "$SHA_CIBLE" = "$ACTUEL" ] && [ -d "$NEXT_DIR" ] && [ -f "$NEXT_DIR/BUILD_ID" ]; then
    log ".next déjà à jour (sha $SHA_CIBLE)"
  else
    log "téléchargement du build cd-latest (sha ${SHA_CIBLE:-inconnu}, précédent: ${ACTUEL:-aucun})"
    TAR="$STATE_DIR/next-build.tar.gz"
    curl -fSL --max-time 900 --retry 2 -o "$TAR" \
      "https://github.com/$REPO/releases/download/cd-latest/next-build.tar.gz" \
      || { log "ERREUR: téléchargement"; [ -d "$NEXT_DIR" ] && [ -f "$NEXT_DIR/BUILD_ID" ] && log "repli: .next embarqué" || exit 1; }
    curl -fsSL --max-time 30 "https://github.com/$REPO/releases/download/cd-latest/next-build.tar.gz.sha256" -o "$TAR.sha256" || true
    if [ -s "$TAR.sha256" ]; then
      (cd "$STATE_DIR" && awk '{print $1"  next-build.tar.gz"}' "$TAR.sha256" | sha256sum -c -) >/dev/null 2>&1 \
        || { log "ERREUR: sha256 MISMATCH"; rm -f "$TAR"; exit 1; }
      log "sha256 vérifié ($(du -h "$TAR" | awk '{print $1}'))"
    fi
    STAGING="$STATE_DIR/staging"; rm -rf "$STAGING"; mkdir -p "$STAGING"
    tar -xzf "$TAR" -C "$STAGING" && rm -f "$TAR" "$TAR.sha256" || { log "ERREUR: extraction"; exit 1; }
    # swap atomique : le conteneur n'est pas encore en train de servir
    rm -rf "$NEXT_DIR"; mv "$STAGING" "$NEXT_DIR"
    echo "$SHA_CIBLE" > "$STATE_DIR/deployed-sha"
    log ".next installé (BUILD_ID $(cat "$NEXT_DIR/BUILD_ID" 2>/dev/null || echo '?'))"
  fi
fi

# ── 2. Environnement : bundle GEN3IA_DOTENV_* → .env.production ───────
# Le workflow hyperlift-auto-update place tout le .env.production
# (gzip + base64) dans une à huit variables GEN3IA_DOTENV_<X> (limite
# API : valeur ≤ 16 384 chars). `next start` charge .env.production
# nativement quand NODE_ENV=production — process.env garde la priorité.
BUNDLE=""
for SFX in A B C D E F G H; do
  eval "VAL=\"\${GEN3IA_DOTENV_$SFX:-}\""
  [ -n "$VAL" ] && BUNDLE="$BUNDLE$VAL"
done
if [ -n "$BUNDLE" ]; then
  if printf '%s' "$BUNDLE" | base64 -d 2>/dev/null | gunzip > "$APP_DIR/.env.production.tmp" 2>/dev/null \
     && [ -s "$APP_DIR/.env.production.tmp" ]; then
    chmod 600 "$APP_DIR/.env.production.tmp"
    mv "$APP_DIR/.env.production.tmp" "$APP_DIR/.env.production"
    log "environnement restauré depuis GEN3IA_DOTENV_* ($(wc -l < "$APP_DIR/.env.production") lignes)"
  else
    log "AVERTISSEMENT: GEN3IA_DOTENV_* présent mais illisible (base64/gzip) — ignoré"
    rm -f "$APP_DIR/.env.production.tmp"
  fi
fi

# ── 3. Démarrage ───────────────────────────────────────────────────────
PORT_ARG="${PORT:-3000}"
log "next start -p $PORT_ARG"
cd "$APP_DIR"
exec node node_modules/.bin/next start -p "$PORT_ARG"
