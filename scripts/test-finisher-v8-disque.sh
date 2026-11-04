#!/bin/bash
# =====================================================================
# Harnais fonctionnel du cd-finisher.sh v8 — SANS VPS, SANS /opt.
# Simule l'environnement VPS (arborescence + stubs de commandes) et
# vérifie les 5 comportements critiques ajoutés/vérifiés au blocage n°9 :
#   A. Disque insuffisant irrécupérable → échelle de libération EXÉCUTÉE
#      (effets filesystem vérifiés), exit 1, note disque-NNNmo,
#      AUCUN blacklist (cause environnementale).
#   B. Tar corrompu → échelle puis reprise d'extraction, échec final
#      honnête : blacklist écrit + note finisher-echec:extraction.
#   C. Chemin nominal : extraction → npm ci → swap → health 200 →
#      last-deployed écrit, note finisher-ok, prod sert le nouveau build.
#   D. Garde disque npm ci (NPM_MIN_MO non atteint) → npm ci SKIPPÉ
#      honnêtement (note dédiée), PAS de blacklist, déploiement continue.
#   E. Health check en échec → ROLLBACK appliqué (.next.old restauré),
#      SHA blacklisté, note finisher-echec:sante-rollback.
# Usage : bash scripts/test-finisher-v8-disque.sh
# =====================================================================
set -u
cd "$(dirname "$0")/.." || exit 1
FINISHER=infra/deploy/cd-finisher.sh
H=$(mktemp -d /tmp/finv8-harnais.XXXXXX)
SHA_NEW="aaaaaaaa$(printf 'b%.0s' $(seq 1 24))"   # 40 hex
SHA_OLD="eeeeeeee$(printf 'f%.0s' $(seq 1 24))"
PASS=0; FAIL=0

note() { echo "  → $*"; }
assert() { # $1=libellé, $2=attendu, $3=lu
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); note "OK  $1"; else FAIL=$((FAIL+1)); note "ÉCHEC $1 (attendu=$2 lu=$3)"; fi
}
assert_contains() {
  if printf '%s' "$3" | grep -q "$2"; then PASS=$((PASS+1)); note "OK  $1"; else FAIL=$((FAIL+1)); note "ÉCHEC $1 (motif '$2' absent de: $3)"; fi
}

# --- Stubs de commandes (PATH prioritaire) ---
mkdir -p "$H/bin"
cat > "$H/bin/npm" <<'EOF'
#!/bin/bash
case "${1:-}" in
  ci) mkdir -p "$GEN3IA_STAGING_DIR/node_modules/.bin" && echo stub > "$GEN3IA_STAGING_DIR/node_modules/.bin/next" && chmod +x "$GEN3IA_STAGING_DIR/node_modules/.bin/next" && exit 0 ;;
  *) exit 0 ;;
esac
EOF
cat > "$H/bin/pm2" <<'EOF'
#!/bin/bash
case "${1:-}" in stop|start|flush) exit 0 ;; restart) echo "pm2-stub restart $2" >> "$GEN3IA_H/pm2.log"; exit 0 ;; *) exit 0 ;; esac
EOF
cat > "$H/bin/git" <<'EOF'
#!/bin/bash
case "${1:-}" in
  fetch|gc) exit 0 ;;
  cat-file) exit 0 ;;
  reset) exit 0 ;;
  log) echo "deadbee stub commit" ;;
  rev-parse) echo "${GEN3IA_FAKE_HEAD:-deadbee}" ;;
  *) exit 0 ;;
esac
EOF
cat > "$H/bin/curl" <<'EOF'
#!/bin/bash
case "$*" in
  *127.0.0.1:3000*)
    if [ "$(cat "$GEN3IA_H/health.txt" 2>/dev/null)" = "ok" ]; then
      # -w '%{http_code}' → imprimer 200 ; -fsS -o /dev/null → exit 0
      printf '200'; exit 0
    fi
    exit 7 ;;
  *) exit 22 ;;
esac
EOF
for s in journalctl apt-get sleep; do printf '#!/bin/bash\nexit 0\n' > "$H/bin/$s"; done
chmod +x "$H/bin/"*

reset_tree() { # arborescence VPS factice fraîche
  rm -rf "$H/prod" "$H/staging" "$H/updater"
  mkdir -p "$H/prod/public" "$H/prod/.next" "$H/staging/.next" "$H/staging/node_modules/.bin" "$H/updater/state"
  echo "$SHA_OLD" > "$H/updater/state/last-deployed.txt"
  echo "BUILD_ANCIEN" > "$H/prod/.next/BUILD_ID"
  echo '{"version":"ancien"}' > "$H/prod/.next/version.json"
  echo "vieux" > "$H/prod/.next/cache-junk.txt"
  mkdir -p "$H/prod/.next/cache/fetch-cache" && echo junk > "$H/prod/.next/cache/fetch-cache/e.txt"
  echo '{"lock":1}' > "$H/staging/package-lock.json"
  echo '{"name":"gen3ia"}' > "$H/staging/package.json"
  echo stub > "$H/staging/node_modules/.bin/next" && chmod +x "$H/staging/node_modules/.bin/next"
  echo "$SHA_OLD" > "$H/updater/state/lock-hash.txt"   # npm ci ne doit PAS se déclencher par défaut
  echo "ok" > "$H/health.txt"                            # l'app fictive répond 200
}

fabriquer_tar() { # tar valide : .next du build + manifests (format CD v8)
  rm -rf "$H/src" && mkdir -p "$H/src/.next/static"
  echo "BUILD_NOUVEAU" > "$H/src/.next/BUILD_ID"
  echo '{"version":"nouveau"}' > "$H/src/.next/version.json"
  echo js > "$H/src/.next/static/app.js"
  echo '{"name":"gen3ia","deps":{}}' > "$H/src/package.json"
  echo '{"lock":2}' > "$H/src/package-lock.json"
  tar czf "$1" --exclude='.next/cache' -C "$H/src/.next" . -C "$H/src" package.json package-lock.json
}

run_finisher() { # $1= étiquette scénario, $2=tar, $3+= envs additionnels KEY=VALUE
  env GEN3IA_H="$H" GEN3IA_PROD_DIR="$H/prod" GEN3IA_STAGING_DIR="$H/staging" \
      GEN3IA_UPDATER_DIR="$H/updater" \
      PATH="$H/bin:$PATH" \
      ${*:3} \
      bash "$FINISHER" "$SHA_NEW" "$2" > "$H/out-$1.log" 2>&1
  echo $?
}

lire_note() { python3 -c "import json;print(json.load(open('$H/prod/public/poller-heartbeat.json'))['note'])" 2>/dev/null; }

echo "=== Harnais finisher v8 — racine $H ==="

# ---------- SCÉNARIO A : disque insuffisant irrécupérable ----------
echo "--- A. disque insuffisant : échelle exécutée, échec honnête, pas de blacklist ---"
reset_tree
# denrées que l'échelle doit purger :
mkdir -p "$H/staging/.next/partiel" && dd if=/dev/zero of="$H/staging/.next/partiel/blob" bs=1k count=64 2>/dev/null
: > "$H/updater/state/failed_commits.txt"
fabriquer_tar "$H/tar-A.tar.gz"
CODE=$(run_finisher A "$H/tar-A.tar.gz" GEN3IA_MIN_MO=999999999)
assert "A1 exit 1" "1" "$CODE"
assert_contains "A2 note disque-NNNmo" "finisher-echec:disque-" "$(lire_note)"
[ -e "$H/staging/.next/partiel" ] && r="présent" || r="purgé"
assert "A3 staging/.next purgé par l'échelle n1" "purgé" "$r"
[ -e "$H/prod/.next/cache/fetch-cache/e.txt" ] && r="présent" || r="purgé"
assert "A4 prod .next/cache purgé par l'échelle n4" "purgé" "$r"
grep -qxF "$SHA_NEW" "$H/updater/state/failed_commits.txt" && r="blacklisté" || r="non-blacklisté"
assert "A5 AUCUN blacklist (cause environnementale)" "non-blacklisté" "$r"
assert_contains "A6 log rapporte l'échelle" "RESCUE n1" "$(cat "$H/out-A.log")"

# ---------- SCÉNARIO B : tar corrompu → reprise d'extraction → échec honnête ----------
echo "--- B. tar corrompu : échelle + reprise, blacklist honnête ---"
reset_tree
echo "ceci n'est pas un tar gzip" > "$H/tar-B.tar.gz"
CODE=$(run_finisher B "$H/tar-B.tar.gz")
assert "B1 exit 1" "1" "$CODE"
assert_contains "B2 note finisher-echec:extraction" "finisher-echec:extraction" "$(lire_note)"
grep -qxF "$SHA_NEW" "$H/updater/state/failed_commits.txt" && r="blacklisté" || r="non-blacklisté"
assert "B3 SHA blacklisté après 2 échecs d'extraction" "blacklisté" "$r"
assert_contains "B4 log montre la reprise" "reprise" "$(cat "$H/out-B.log")"
assert "B5 prod intacte (ancien BUILD_ID servi)" "BUILD_ANCIEN" "$(cat "$H/prod/.next/BUILD_ID")"

# ---------- SCÉNARIO C : chemin nominal ----------
echo "--- C. chemin nominal : extraction + npm ci + swap + health OK ---"
reset_tree
fabriquer_tar "$H/tar-C.tar.gz"
CODE=$(run_finisher C "$H/tar-C.tar.gz")
assert "C1 exit 0" "0" "$CODE"
assert_contains "C2 note finisher-ok" "finisher-ok" "$(lire_note)"
assert "C3 last-deployed = SHA cible" "$SHA_NEW" "$(cat "$H/updater/state/last-deployed.txt")"
assert "C4 prod sert le nouveau BUILD_ID" "BUILD_NOUVEAU" "$(cat "$H/prod/.next/BUILD_ID")"
assert "C5 prod sert la nouvelle version.json" "nouveau" "$(python3 -c "import json;print(json.load(open('$H/prod/.next/version.json'))['version'])")"
assert "C6 lock-hash.txt aligné sur le lock du build" "$(sha256sum "$H/src/package-lock.json" | cut -d' ' -f1)" "$(cat "$H/updater/state/lock-hash.txt")"
[ -x "$H/prod/node_modules/.bin/next" ] && r="oui" || r="non"
assert "C7 node_modules basculés (cp -al)" "oui" "$r"
[ -e "$H/prod/.next.old" ] && r="présent" || r="supprimé"
assert "C8 .next.old supprimé au succès" "supprimé" "$r"
assert_contains "C9 manifests handoffés au staging" "manifests du build handoff" "$(cat "$H/out-C.log")"

# ---------- SCÉNARIO D : garde disque npm ci ----------
echo "--- D. garde disque : npm ci skippé honnêtement, pas de blacklist ---"
reset_tree
rm -f "$H/updater/state/lock-hash.txt"   # lock « changé » → npm ci serait déclenché
fabriquer_tar "$H/tar-D.tar.gz"
CODE=$(run_finisher D "$H/tar-D.tar.gz" GEN3IA_NPM_MO=999999999)
assert "D1 exit 0 (déploiement continue)" "0" "$CODE"
assert_contains "D2 npm ci skippé (garde disque, visible au log + battement de phase)" "npm ci SKIPPÉ (garde disque v8)" "$(cat "$H/out-D.log")"
grep -qxF "$SHA_NEW" "$H/updater/state/failed_commits.txt" && r="blacklisté" || r="non-blacklisté"
assert "D3 AUCUN blacklist sur skip" "non-blacklisté" "$r"

# ---------- SCÉNARIO E : health check en échec → rollback ----------
echo "--- E. health check KO : rollback .next.old + blacklist ---"
reset_tree
fabriquer_tar "$H/tar-E.tar.gz"
echo "ko" > "$H/health.txt"
CODE=$(run_finisher E "$H/tar-E.tar.gz")
assert "E1 exit 2" "2" "$CODE"
assert "E2 prod restaurée sur l'ANCIEN BUILD_ID" "BUILD_ANCIEN" "$(cat "$H/prod/.next/BUILD_ID")"
assert_contains "E3 note sante-rollback" "finisher-echec:sante-rollback" "$(lire_note)"
grep -qxF "$SHA_NEW" "$H/updater/state/failed_commits.txt" && r="blacklisté" || r="non-blacklisté"
assert "E4 SHA blacklisté" "blacklisté" "$r"
grep -q "pm2-stub restart gen3ia" "$H/pm2.log" && r="oui" || r="non"
assert "E5 pm2 restart exécuté (rollback fonctionnel)" "oui" "$r"

echo "=== RÉSULTAT : $PASS ok, $FAIL échec ==="
rm -rf "$H"
[ "$FAIL" -eq 0 ]
