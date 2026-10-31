#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# GEN3IA — AGENT COLAB PULL-MODE (pont d'exécution à distance, zéro tunnel)
# ═══════════════════════════════════════════════════════════════════════
#
# PRINCIPE (même pattern que le pull-mode VPS du projet) : cet agent tourne
# DANS ton terminal Colab, consulte la boîte d'ordres du dépôt
# (training/colab/bridge/inbox.json sur la branche colab-bridge), exécute
# les commandes reçues sur la GPU de ta session, puis renvoie les logs
# (training/colab/bridge/out-*.log) par l'API GitHub.
#
#  - Sortant HTTPS uniquement (api.github.com) : AUCUN tunnel, AUCUN port ouvert.
#  - Le token reste dans TA session (variable/passphrase) : jamais écrit,
#    jamais affiché, jamais envoyé ailleurs qu'à api.github.com.
#  - Les ordres viennent UNIQUEMENT du dépôt (training/colab/bridge/) —
#    donc de quiconque détient un accès en écriture. Tu y optes en lançant
#    cet agent ; Ctrl+C l'arrête à tout instant.
#  - Arrêt propre : mettre {"stop": true} dans l'inbox (l'agent fait un
#    dernier rapport et se termine) — ou Ctrl+C.
#
# Usage (terminal Colab) :
#   bash <(curl -fsSL https://raw.githubusercontent.com/missock237-spec/gen3ia/main/training/colab/agent-pull-colab.sh)
# Variante persistante (survit à la fermeture de l'onglet terminal) :
#   curl -fsSL <url> -o /tmp/gen3ia-agent.sh
#   GEN3IA_PAT=ton_token nohup bash /tmp/gen3ia-agent.sh > ~/gen3ia-agent.log 2>&1 &
#
# Env optionnelles : GEN3IA_PAT (token), GEN3IA_INTERVAL (défaut 30 s),
# GEN3IA_WORKDIR (défaut ~/gen3ia-train), GEN3IA_TIMEOUT (défaut 14400 s = 4 h).
# ═══════════════════════════════════════════════════════════════════════

set -u

REPO="missock237-spec/gen3ia"
BRANCH="colab-bridge"
BRIDGE_DIR="training/colab/bridge"
API_BASE="https://api.github.com/repos/${REPO}/contents"
INTERVAL="${GEN3IA_INTERVAL:-30}"
WORKDIR="${GEN3IA_WORKDIR:-$HOME/gen3ia-train}"
CMD_TIMEOUT="${GEN3IA_TIMEOUT:-14400}"
LOG_CAP=380000   # octets de log conservés par rapport (limite API ~1 Mo, marge)

mkdir -p "$WORKDIR"

echo "[gen3ia] $(date -u +%H:%M:%SZ) agent Colab pull-mode — dépôt ${REPO}, branche ${BRANCH}"
echo "[gen3ia] répertoire de travail : ${WORKDIR} (timeout commande : ${CMD_TIMEOUT}s)"

# ── Token (jamais affiché) ──────────────────────────────────────────────
PAT="${GEN3IA_PAT:-}"
if [ -z "$PAT" ]; then
  read -rsp "[gen3ia] Token GitHub (PAT, saisie masquée) : " PAT
  echo
fi
if [ -z "$PAT" ]; then
  echo "[gen3ia] ERREUR : aucun token fourni — arrêt." >&2
  exit 1
fi
AUTH="Authorization: Bearer ${PAT}"
API_HEADER="Accept: application/vnd.github+json"
RAW_HEADER="Accept: application/vnd.github.raw+json"

# Vérification d'accès honnête (une seule requête, message clair).
CODE=$(curl -sS -o /dev/null -w "%{http_code}" -H "$AUTH" "https://api.github.com/repos/${REPO}" || echo "ERR")
if [ "$CODE" != "200" ]; then
  echo "[gen3ia] ERREUR : accès au dépôt impossible (HTTP ${CODE}) — vérifie le token (scope repo) et le réseau." >&2
  exit 1
fi
echo "[gen3ia] accès dépôt vérifié (HTTP 200)."

# ── Helpers ─────────────────────────────────────────────────────────────
horodatage() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# GET inbox → fichier ; retourne le code HTTP.
fetch_inbox() {
  curl -sS -H "$AUTH" -H "$RAW_HEADER" -o "$WORKDIR/inbox.json" \
    -w "%{http_code}" "${API_BASE}/${BRIDGE_DIR}/inbox.json?ref=${BRANCH}" 2>/dev/null
}

# lecture de champs JSON via python3 (toujours présent sur Colab)
json_champ() { # $1 fichier, $2 champ
  python3 - "$1" "$2" <<'PY'
import json, sys
try:
    data = json.load(open(sys.argv[1]))
    key = sys.argv[2]
    val = data.get(key, "")
    if isinstance(val, bool):
        print("true" if val else "false")
    elif isinstance(val, list):
        print(json.dumps(val, ensure_ascii=False))
    else:
        print(val)
except Exception:
    print("")
PY
}

# PUT d'un fichier (base64) sur la branche via l'API Contents.
put_fichier() { # $1 chemin dans le dépôt, $2 fichier local, $3 message de commit
  python3 - "$1" "$2" "$3" "$PAT" "$REPO" "$BRANCH" <<'PY'
import base64, json, sys, urllib.request

path, local, message, pat, repo, branch = sys.argv[1:7]
url = f"https://api.github.com/repos/{repo}/contents/{path}"
data_bytes = open(local, "rb").read()
body = {
    "message": message,
    "branch": branch,
    "content": base64.b64encode(data_bytes).decode(),
}
# Si le fichier existe déjà, récupérer son SHA (mise à jour propre).
req = urllib.request.Request(url + f"?ref={branch}", headers={
    "Authorization": f"Bearer {pat}",
    "Accept": "application/vnd.github+json",
})
try:
    with urllib.request.urlopen(req, timeout=30) as r:
        body["sha"] = json.load(r)["sha"]
except Exception:
    pass  # 404 = création
req2 = urllib.request.Request(url, data=json.dumps(body).encode(), headers={
    "Authorization": f"Bearer {pat}",
    "Accept": "application/vnd.github+json",
    "Content-Type": "application/json",
}, method="PUT")
try:
    with urllib.request.urlopen(req2, timeout=60) as r:
        print(r.status)
except Exception as e:
    print(f"ERR:{e}")
PY
}

# ── Exécution d'un lot d'ordres ─────────────────────────────────────────
executer_lot() { # $1 id de l'inbox
  local lot_id="$1"
  local i=0
  local nb
  nb=$(json_champ "$WORKDIR/inbox.json" commands | python3 -c "import json,sys;print(len(json.load(sys.stdin)))" 2>/dev/null || echo 0)
  echo "[gen3ia] $(horodatage) LOT ${lot_id} — ${nb} commande(s)."
  for ((i=0; i<nb; i++)); do
    local cmd
    cmd=$(json_champ "$WORKDIR/inbox.json" commands | python3 -c "import json,sys;print(json.load(sys.stdin)[$i])" 2>/dev/null)
    [ -z "$cmd" ] && continue
    local t0 log_file code
    t0=$(date +%s)
    log_file="$WORKDIR/out-${lot_id}-${i}.log"
    {
      echo "═══ gen3ia Colab — lot ${lot_id} · commande ${i}/${nb} ═══"
      echo "Début (UTC) : $(horodatage)"
      echo "\$ ${cmd}"
      echo "─────────────────────────────────────────────"
    } > "$log_file"
    echo "[gen3ia] ▶ cmd ${i}: ${cmd:0:120}"
    timeout "${CMD_TIMEOUT}" bash -c "$cmd" >> "$log_file" 2>&1
    code=$?
    {
      echo "─────────────────────────────────────────────"
      echo "Fin (UTC)   : $(horodatage) — durée : $(( $(date +%s) - t0 ))s — exit : ${code}"
    } >> "$log_file"
    # Cap honnête du log (garder la FIN — c'est là que sont les résultats).
    if [ "$(stat -c%s "$log_file" 2>/dev/null || echo 0)" -gt "$LOG_CAP" ]; then
      tail -c "$LOG_CAP" "$log_file" > "$log_file.tmp" && mv "$log_file.tmp" "$log_file"
      echo "[log tronqué à ${LOG_CAP} octets (fin conservée)]" >> "$log_file"
    fi
    echo "[gen3ia] ✓ cmd ${i} terminée (exit ${code}) — envoi du log…"
    put_fichier "${BRIDGE_DIR}/out-${lot_id}-${i}.log" "$log_file" \
      "gen3ia-colab: log lot ${lot_id} cmd ${i} (exit ${code})" >/dev/null 2>&1 \
      || echo "[gen3ia] ⚠ envoi du log ${i} échoué (il reste local : ${log_file})"
  done
}

# ── Boucle principale ───────────────────────────────────────────────────
LAST_ID=""
echo "[gen3ia] agent démarré — en attente d'ordres (Ctrl+C pour arrêter)."
while true; do
  HTTP=$(fetch_inbox)
  case "$HTTP" in
    200)
      ID=$(json_champ "$WORKDIR/inbox.json" id)
      STOP=$(json_champ "$WORKDIR/inbox.json" stop)
      if [ "$STOP" = "true" ]; then
        echo "[gen3ia] ordre d'arrêt reçu (stop=true) — dernier rapport, puis sortie."
        echo "agent arrêté proprement à $(horodatage) après le lot ${LAST_ID:-aucun}." \
          > "$WORKDIR/out-stop.log"
        put_fichier "${BRIDGE_DIR}/out-stop.log" "$WORKDIR/out-stop.log" \
          "gen3ia-colab: agent arrêté (stop)" >/dev/null 2>&1
        exit 0
      fi
      if [ -n "$ID" ] && [ "$ID" != "$LAST_ID" ]; then
        LAST_ID="$ID"
        executer_lot "$ID"
        echo "[gen3ia] $(horodatage) LOT ${ID} terminé — retour à l'écoute."
      fi
      ;;
    404)
      # inbox pas encore publiée : silencieux et patient.
      ;;
    *)
      echo "[gen3ia] ⚠ inbox HTTP ${HTTP} — nouvelle tentative dans ${INTERVAL}s."
      ;;
  esac
  sleep "$INTERVAL"
done
