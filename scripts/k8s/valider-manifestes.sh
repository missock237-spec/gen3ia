#!/usr/bin/env bash
# =============================================================================
# GEN3IA — Validation STATIQUE des manifestes Kubernetes (aucun cluster requis)
#
# Ce que fait ce script, dans l'ordre :
#   1. RENDU kustomize des 3 cibles (base, overlays/prod, overlays/staging) —
#      `kubectl kustomize` construit les manifests OFFLINE, sans contacter
#      d'API server (kubectl est préinstallé sur les runners GitHub Actions ;
#      en local, remplacer par le binaire `kustomize build` — géré ci-dessous) ;
#   2. VALIDATION de schéma OPTIONNELLE via kubeconform si installé
#      (`kubeconform -strict` — vérifie les champs contre les schémas
#      officiels ; les schémas se téléchargent sur github.com → réseau requis).
#      Installation locale (optionnel) :
#        brew install kubeconform
#        # ou : go install github.com/yannh/kubeconform/cmd/kubeconform@latest
#   3. Repli FINAL : si ni kubectl ni kustomize ne sont disponibles, contrôle
#      de la SYNTAXE YAML seule (python3 + pyyaml) — inférieur à un rendu
#      kustomize mais suffit pour attraper un YAML cassé dans un éditeur.
#
# AUCUNE application au cluster ici (pas de kubectl apply) : la validation
# est volontairement hors-ligne. Aucun workflow CI n'appelle ce script
# aujourd'hui — l'orchestrateur décidera s'il doit rejoindre ci.yml.
# =============================================================================
set -euo pipefail

# -----------------------------------------------------------------------------
# Chemins : le script vit dans scripts/k8s/, la racine du dépôt est ../..
# -----------------------------------------------------------------------------
RACINE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CIBLES=("k8s/base" "k8s/overlays/prod" "k8s/overlays/staging")
REPERTOIRE_RENDU="$(mktemp -d)"
trap 'rm -rf "${REPERTOIRE_RENDU}"' EXIT

echo "── GEN3IA — validation des manifestes Kubernetes ─────────────────────"
echo "   Racine : ${RACINE}"

# -----------------------------------------------------------------------------
# 0. Outils disponibles
# -----------------------------------------------------------------------------
OUTIL_RENDU=""
if command -v kubectl >/dev/null 2>&1; then
  OUTIL_RENDU="kubectl"
elif command -v kustomize >/dev/null 2>&1; then
  OUTIL_RENDU="kustomize"
fi

KUBECONFORM_DISPO=0
if command -v kubeconform >/dev/null 2>&1; then
  KUBECONFORM_DISPO=1
fi

echo "   Rendu   : ${OUTIL_RENDU:-« aucun — repli syntaxe YAML »}"
echo "   Schémas : $([ "${KUBECONFORM_DISPO}" = 1 ] && echo kubeconform || echo "non installé (optionnel)")"
echo ""

# -----------------------------------------------------------------------------
# 1. Rendu kustomize de chaque cible
# -----------------------------------------------------------------------------
ECHECS=0
for cible in "${CIBLES[@]}"; do
  chemin="${RACINE}/${cible}"
  rendu="${REPERTOIRE_RENDU}/$(echo "${cible}" | tr '/' '_').yaml"

  if [ ! -f "${chemin}/kustomization.yaml" ]; then
    echo "✗ ${cible} : kustomization.yaml introuvable."
    ECHECS=$((ECHECS + 1))
    continue
  fi

  case "${OUTIL_RENDU}" in
    kubectl)
      if kubectl kustomize "${chemin}" > "${rendu}" 2> "${rendu}.err"; then
        : # succès
      else
        echo "✗ ${cible} : échec du rendu kustomize —"
        cat "${rendu}.err"
        ECHECS=$((ECHECS + 1))
        continue
      fi
      ;;
    kustomize)
      if kustomize build "${chemin}" > "${rendu}" 2> "${rendu}.err"; then
        : # succès
      else
        echo "✗ ${cible} : échec du rendu kustomize —"
        cat "${rendu}.err"
        ECHECS=$((ECHECS + 1))
        continue
      fi
      ;;
    *)
      # Pas d'outil de rendu : repli syntaxe YAML sur les fichiers sources.
      if ! python3 - <<PYEOF
import glob, sys
try:
    import yaml
except ImportError:
    print("python3-pyyaml indisponible : impossible de valider")
    sys.exit(2)
erreur = False
for fichier in sorted(glob.glob("${chemin}/**/*.yaml", recursive=True)):
    try:
        with open(fichier, encoding="utf-8") as flux:
            for _ in yaml.safe_load_all(flux):
                pass
    except Exception as exc:
        print(f"  {fichier} : YAML invalide — {exc}")
        erreur = True
sys.exit(1 if erreur else 0)
PYEOF
      then
        echo "✗ ${cible} : syntaxe YAML invalide (repli python3/pyyaml)."
        ECHECS=$((ECHECS + 1))
        continue
      fi
      echo "✓ ${cible} : syntaxe YAML OK (repli python3/pyyaml — rendu kustomize non vérifié)."
      continue
      ;;
  esac

  nombre_documents="$(grep -c '^kind:' "${rendu}" || true)"
  echo "✓ ${cible} : rendu OK — ${nombre_documents} ressources."
done

# -----------------------------------------------------------------------------
# 2. Validation de schéma kubeconform (optionnelle, si installée)
# -----------------------------------------------------------------------------
if [ "${KUBECONFORM_DISPO}" = 1 ] && [ "${ECHECS}" = 0 ]; then
  echo ""
  echo "── kubeconform -strict (schémas officiels, réseau requis) ───────────"
  for cible in "${CIBLES[@]}"; do
    rendu="${REPERTOIRE_RENDU}/$(echo "${cible}" | tr '/' '_').yaml"
    if kubeconform -strict -summary -ignore-missing-schemas "${rendu}"; then
      echo "✓ ${cible} : schémas OK."
    else
      echo "✗ ${cible} : validation de schéma en échec."
      ECHECS=$((ECHECS + 1))
    fi
  done
elif [ "${KUBECONFORM_DISPO}" = 0 ]; then
  echo ""
  echo "(kubeconform non installé — validation de schéma ignorée."
  echo " Installation optionnelle : brew install kubeconform ou"
  echo " go install github.com/yannh/kubeconform/cmd/kubeconform@latest)"
fi

# -----------------------------------------------------------------------------
# 3. Bilan final clair
# -----------------------------------------------------------------------------
echo ""
if [ "${ECHECS}" = 0 ]; then
  echo "════════════════════════════════════════════════════════════════════"
  echo "✅ VALIDATION RÉUSSIE — base, overlays/prod et overlays/staging sont"
  echo "   cohérents (rendu kustomize / syntaxe YAML)."
  echo "   Rappel : aucune de ces vérifications ne remplace un apply sur un"
  echo "   cluster de staging réel (probes, ingress controller, cert-manager"
  echo "   ne s'observent qu'en ligne)."
  echo "════════════════════════════════════════════════════════════════════"
  exit 0
else
  echo "════════════════════════════════════════════════════════════════════"
  echo "❌ VALIDATION EN ÉCHEC — ${ECHECS} cible(s) invalide(s). Corriger"
  echo "   AVANT tout déploiement (voir messages ci-dessus)."
  echo "════════════════════════════════════════════════════════════════════"
  exit 1
fi
