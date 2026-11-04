#!/bin/bash
# =====================================================================
# Harnais fonctionnel du pull-deploy.sh v7 — sans VPS, sans /opt, sans
# réseau. Vérifie les trois correctifs du blocage CD n°9 :
#   P1. PRÉSERVATION de la note d'échec du finisher : un finisher qui
#       échoue avec « finisher-echec:disque-NNNmo » voit sa note
#       SURVIVRE au battement de début du cycle suivant (v6 l'écrasait
#       en ≤ 2 min — l'angle mort du diagnostic).
#   P2. TAR DÉJÀ INTÈGRE : le téléchargement est sauté (log
#       « téléchargement sauté »), zéro re-téléchargement.
#   P3. FILET ANTI-FS-PLEIN : écriture pull-fail.txt impossible →
#       repli /tmp/pull-fail.txt + note « echec-fs-plein » visible.
# Usage : bash scripts/test-pull-deploy-v7.sh
# =====================================================================
set -u
cd "$(dirname "$0")/.." || exit 1
POLLER=scripts/vps-auto-deploy/pull-deploy.sh
H=$(mktemp -d /tmp/pd7-harnais.XXXXXX)
SHA_NEW="aaaaaaaa$(printf 'b%.0s' $(seq 1 24))"
SHA_OLD="eeeeeeee$(printf 'f%.0s' $(seq 1 24))"
PASS=0; FAIL=0
assert() { if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "  → OK  $1"; else FAIL=$((FAIL+1)); echo "  → ÉCHEC $1 (attendu=$2 lu=$3)"; fi; }
assert_contains() { if printf '%s' "$3" | grep -q "$2"; then PASS=$((PASS+1)); echo "  → OK  $1"; else FAIL=$((FAIL+1)); echo "  → ÉCHEC $1 (motif '$2' absent)"; fi; }

mkdir -p "$H/bin"
cat > "$H/bin/curl" <<EOF
#!/bin/bash
OUT=""; prev=""
for a in "\$@"; do [ "\$prev" = "-o" ] && OUT="\$a"; prev="\$a"; done
URL=\$(printf '%s\n' "\$@" | grep -E '^https?://' | head -1)
case "\$URL" in
  *"/releases/download/cd-latest/meta.json"*)
    printf '{"sha":"%s","buildId":"harnais","publishedAt":"2026-11-04T00:00:00Z"}' "$SHA_NEW"; exit 0 ;;
  *"next-build.tar.gz.sha256"*) [ -n "\$OUT" ] && cp "$H/tar.sha256" "\$OUT"; exit 0 ;;
  *"next-build.tar.gz"*) exit 28 ;;
  *"scripts/vps-auto-deploy/pull-deploy.sh"*) exit 22 ;;
  *"infra/deploy/cd-finisher.sh"*) [ -n "\$OUT" ] && cp "$H/fake-finisher.sh" "\$OUT"; exit 0 ;;
  *) exit 22 ;;
esac
EOF
chmod +x "$H/bin/curl"
# finisher factice : échec documenté disque + heartbeat propre
cat > "$H/fake-finisher.sh" <<EOF
#!/bin/bash
printf '{"ok":true,"ts":"%s","epoch":%s,"poller":"pull-deploy v7","targetSha":"%s","servedSha":"%s","note":"finisher-echec:disque-999mo"}\n' \
  "\$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "\$(date +%s)" "\$1" \
  "\$(cat "$H/updater/state/last-deployed.txt" 2>/dev/null || echo '')" \
  > "$H/prod/public/poller-heartbeat.json"
exit 1
EOF
chmod +x "$H/fake-finisher.sh"

reset_env() {
  rm -rf "$H/updater" "$H/prod"
  mkdir -p "$H/updater/state" "$H/prod/public"
  echo "$SHA_OLD" > "$H/updater/state/last-deployed.txt"
  : > "$H/updater/state/failed_commits.txt"
  : > "$H/prod/public/poller-heartbeat.json"
}
run_cycle() { # $1=étiquette ; envs additionnels via $2+
  env GEN3IA_UPDATER_DIR="$H/updater" GEN3IA_PROD_DIR="$H/prod" \
      PATH="$H/bin:$PATH" ${*:2} \
      bash "$POLLER" > "$H/out-$1.log" 2>&1
  echo $?
}
lire_note() { python3 -c "import json;print(json.load(open('$H/prod/public/poller-heartbeat.json'))['note'])" 2>/dev/null; }

echo "=== Harnais pull-deploy v7 — racine $H ==="

# ---------- P1 + P2 : tar intègre sauté + note d'échec préservée ----------
echo "--- P1/P2. tar déjà intègre → skip ; échec finisher → note préservée ---"
reset_env
rm -f /tmp/pull-fail.txt /tmp/next-build.tar.gz /tmp/next-build.tar.gz.sha256
mkdir -p "$H/src/.next" && echo "BID" > "$H/src/.next/BUILD_ID"
tar czf /tmp/next-build.tar.gz -C "$H/src/.next" .
(cd /tmp && sha256sum next-build.tar.gz > next-build.tar.gz.sha256)
C1=$(run_cycle P1a)
assert "P1.1 cycle 1 sort 1 (finisher en échec)" "1" "$C1"
assert_contains "P1.2 tar déjà intègre = téléchargement sauté" "téléchargement sauté" "$(cat "$H/out-P1a.log")"
assert "P1.3 note finisher-echec:disque-999mo écrite par le finisher" "finisher-echec:disque-999mo" "$(lire_note)"
sleep 1
C2=$(run_cycle P1b)   # < 60 s → backoff actif → sortie précoce APRÈS le battement de début
assert "P1.4 cycle 2 sort 0 (backoff, silencieux)" "0" "$C2"
assert "P1.5 LA NOTE SURVIT au battement de début de cycle (correctif v7)" "finisher-echec:disque-999mo" "$(lire_note)"
sleep 61
C3=$(run_cycle P1c)   # backoff expiré → re-finisher → échec → note réécrite
assert "P1.6 cycle 3 (backoff expiré) re-tente le finisher" "1" "$C3"
assert "P1.7 note d'échec fraîche" "finisher-echec:disque-999mo" "$(lire_note)"

# ---------- P3 : filet anti-fs-plein ----------
echo "--- P3. état de backoff illisible (fs plein) → repli /tmp + note echec-fs-plein ---"
reset_env
rm -f /tmp/next-build.tar.gz /tmp/next-build.tar.gz.sha256 /tmp/cd-finisher.sh   # forcer la branche TÉLÉCHARGEMENT (qui échoue)
chmod 555 "$H/updater/state"   # écritures impossibles dans STATE_DIR
C4=$(run_cycle P3)
chmod 755 "$H/updater/state"
assert "P3.1 cycle sort 1 (échec téléchargement)" "1" "$C4"
assert "P3.2 note echec-fs-plein visible" "echec-fs-plein" "$(lire_note)"
[ -f /tmp/pull-fail.txt ] && r="oui" || r="non"
assert "P3.3 repli /tmp/pull-fail.txt écrit" "oui" "$r"
assert_contains "P3.4 repli mentionné au log" "repli /tmp" "$(cat "$H/out-P3.log")"
head -1 /tmp/pull-fail.txt | grep -q "^$SHA_NEW " && r="sha correct" || r="sha incorrect"
assert "P3.5 pull-fail.txt porte le SHA cible" "sha correct" "$r"

echo "=== RÉSULTAT : $PASS ok, $FAIL échec ==="
rm -f /tmp/pull-fail.txt /tmp/next-build.tar.gz /tmp/next-build.tar.gz.sha256
rm -rf "$H"
[ "$FAIL" -eq 0 ]
