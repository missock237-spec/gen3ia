#!/usr/bin/env bash
# =====================================================================
# Gen3ia — Téléchargement de l'artefact neuronal pré-entraîné
# cortex-v2.bin (plus versionné dans git — cf. README.md du dossier).
#
# Usage :
#   bash assets/neural-pretrained/download-model.sh
#
# Variables :
#   GEN3IA_CORTEX_V2_URL  URL directe du fichier (prioritaire)
#   GEN3IA_MODEL_BASE_URL base du stockage objet (R2/S3) du projet
#
# L'URL par défaut est un PLACEHOLDER : la publier sur le bucket R2 du
# projet puis ajuster MODELE_URL ci-dessous (ou exporter
# GEN3IA_CORTEX_V2_URL). Sans artefact, l'application démarre quand même
# (cortex v2 amorcé à neuf — repli non fatal).
# =====================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CIBLE="$REPO_ROOT/assets/neural-pretrained/cortex-v2.bin"

# PLACEHOLDER — remplacer par l'URL réelle de diffusion (R2/S3 projet).
MODELE_URL="${GEN3IA_CORTEX_V2_URL:-${GEN3IA_MODEL_BASE_URL:-https://assets.gen3ia.online}/neural/cortex-v2.bin}"

SHA256_ATTENDU="000ff807b988a91c5b7c1862ee15ab2c28eea058203a12f6d8721bbeab91cc14"

echo "[download-model] Source : $MODELE_URL"
echo "[download-model] Cible  : $CIBLE"

if [ -f "$CIBLE" ]; then
  local_sha="$(sha256sum "$CIBLE" | cut -d' ' -f1)"
  if [ "$local_sha" = "$SHA256_ATTENDU" ]; then
    echo "[download-model] L'artefact est déjà présent et conforme — rien à faire."
    exit 0
  fi
  echo "[download-model] Un artefact local d'empreinte différente existe (ré-entraînement plus récent ?) — écrasement."
fi

command -v curl >/dev/null 2>&1 || { echo "[download-model] ERREUR : curl requis." >&2; exit 1; }

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

# -f : échoue sur 4xx/5xx ; -L : suit les redirections (R2/S3 signées).
if ! curl -fSL --retry 3 --progress-bar -o "$tmp" "$MODELE_URL"; then
  echo "[download-model] ERREUR : téléchargement impossible." >&2
  echo "[download-model] → Vérifiez GEN3IA_CORTEX_V2_URL (placeholder ? artefact publié sur R2 ?)." >&2
  echo "[download-model] → Alternative : npx tsx scripts/pretrain-cortex-v2.ts" >&2
  echo "[download-model] → Sans cet artefact, l'app démarre avec un cortex v2 neuf (repli non fatal)." >&2
  exit 1
fi

local_sha="$(sha256sum "$tmp" | cut -d' ' -f1)"
if [ "$local_sha" != "$SHA256_ATTENDU" ]; then
  echo "[download-model] AVERTISSEMENT : empreinte $local_sha ≠ référence $SHA256_ATTENDU." >&2
  echo "[download-model] → artefact corrompu OU ré-entraînement plus récent (vérifier pretrain-report.json)." >&2
  if [ "${GEN3IA_ACCEPT_ANY_SHA:-0}" != "1" ]; then
    echo "[download-model] Installation refusée (exportez GEN3IA_ACCEPT_ANY_SHA=1 pour forcer)." >&2
    exit 1
  fi
fi

mkdir -p "$(dirname "$CIBLE")"
mv "$tmp" "$CIBLE"
echo "[download-model] OK — cortex-v2.bin installé (sha256 $local_sha)."
