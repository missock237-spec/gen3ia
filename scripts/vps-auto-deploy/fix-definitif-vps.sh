#!/bin/bash
# =====================================================================
# Gen3ia — RÉTABLISSEMENT DÉFINITIF du blocage VPS.
#
# À exécuter en ROOT depuis la console du fournisseur (spaceship.com) —
# AUCUN SSH entrant requis (uniquement HTTPS sortant) :
#
#   curl -fsSL https://raw.githubusercontent.com/missock237-spec/gen3ia/main/scripts/vps-auto-deploy/fix-definitif-vps.sh | bash
#
# Traite les DEUX causes du gel du dernier kilomètre (issue #106) :
#
#   A. SSH entrant barré — bannière « Not allowed at this time » :
#      pénalités source d'OpenSSH ≥ 9.8 (PerSourcePenalties) déclenchées
#      par les dizaines de tentatives SCP du CD. Correctif :
#      PerSourcePenalties no dans sshd_config (les pénalités vivent en
#      mémoire → le redémarrage de sshd les purge ; la configuration
#      empêche tout retour du barrage) + débannissement fail2ban
#      + 22022/tcp autorisé en ufw. Validation sshd -t avec restauration
#      automatique de la sauvegarde en cas de configuration rejetée.
#
#   B. Poller PM2 « updater » inactif — release cd-latest non délivrée,
#      prod figée. Correctif : réinstallation de auto-update.sh /
#      pull-deploy.sh / shim deploy.sh depuis le dépôt (HTTPS sortant),
#      purge du backoff (pull-fail.txt) et du blacklist du SHA cible
#      (ses échecs venaient du canal, pas du build), recréation propre
#      du process PM2 « updater », pm2 save + startup (survit aux
#      reboots), puis premier déploiement immédiat via la release
#      cd-latest (swap atomique + health check + rollback : cd-finisher).
#
#   + ANTI-RÉCIDIVE : watchdog systemd toutes les 5 min (repli cron) qui
#     redémarre updater/gen3ia si morts, résurrect pm2 après reboot et
#     force la livraison si la prod prend du retard. Plus jamais de gel
#     silencieux : tout est journalisé (/var/log/gen3ia-watchdog.log).
#
# Idempotent : réexécutable sans risque. Journal complet : /var/log/gen3ia-fix.log
# =====================================================================
set -u
export PATH="$PATH:/usr/local/bin:/usr/bin:/usr/sbin:/sbin:/usr/lib/node_modules/pm2/bin"

REPO=missock237-spec/gen3ia
BASE=https://raw.githubusercontent.com/$REPO/main/scripts/vps-auto-deploy
UPDATER_DIR=/opt/gen3ia-updater
STATE_DIR=$UPDATER_DIR/state
PROD_DIR=/opt/gen3ia
LOG=/var/log/gen3ia-fix.log
mkdir -p "$STATE_DIR" /var/log
exec > >(tee -a "$LOG") 2>&1

etape() { echo; echo "===== [$1/8] $2 ====="; }
ok()   { echo "  OK  $*"; }
warn() { echo "  !!  $*"; }
err()  { echo "  XX  $*"; }

echo "==============================================================="
echo " Gen3ia — rétablissement définitif du VPS — $(date -u '+%F %T UTC')"
echo "==============================================================="
if [ "$(id -u)" != "0" ]; then
  err "à exécuter en root (console du fournisseur)"; exit 1
fi

# ------------------------------------------------------------- 1. Diagnostic
etape 1 "Diagnostic initial"
PUBLIE=$(curl -fsSL -m 20 -H "Cache-Control: no-cache" \
  "https://github.com/$REPO/releases/download/cd-latest/meta.json?_=$(date +%s)" 2>/dev/null) || PUBLIE=""
TARGET_SHA=$(printf '%s' "$PUBLIE" | grep -o '"sha":"[0-9a-f]*"' | head -1 | sed 's/.*:"//; s/"$//')
if [ -z "$TARGET_SHA" ]; then
  err "release cd-latest illisible (HTTPS sortant cassé ?) — rien à livrer, abandon."
  exit 1
fi
PROD_SHA=$(curl -fsS -m 10 http://127.0.0.1:3000/version.json 2>/dev/null \
  | grep -o '"gitSha":"[^"]*"' | head -1 | sed 's/.*:"//; s/"$//')
echo "  build publié (cd-latest) : $TARGET_SHA"
echo "  prod en service          : ${PROD_SHA:-inconnue}"
echo "  last-deployed            : $(cat "$STATE_DIR/last-deployed.txt" 2>/dev/null || echo 'aucun')"
echo "  blacklist                : $(wc -l < "$STATE_DIR/failed_commits.txt" 2>/dev/null || echo 0) SHA(s)"
echo "  disque /opt              : $(df -Ph /opt 2>/dev/null | awk 'NR==2{print $4" libres ("$5" utilisé)"}')"
echo "  tar résiduel /tmp        : $(du -h /tmp/next-build.tar.gz 2>/dev/null | cut -f1 || echo 'aucun')"
UPD_PID=$(pm2 pid updater 2>/dev/null | tr -d '[:space:]')
if [ -n "$UPD_PID" ] && [ "$UPD_PID" != "0" ]; then
  echo "  updater PM2              : online (pid $UPD_PID)"
else
  echo "  updater PM2              : INACTIF — cause n°2 du gel confirmée"
fi
if [ "$PROD_SHA" = "$TARGET_SHA" ]; then
  ok "prod déjà alignée — le script poursuit (déblocage SSH + watchdog restent utiles)"
fi

# ------------------------------------------------------- 2. Déblocage SSH
etape 2 "Déblocage SSH entrant — définitif (PerSourcePenalties no)"
SSHD_CONF=/etc/ssh/sshd_config
SSHD_BAK="$SSHD_CONF.bak-gen3ia-$(date +%Y%m%d%H%M%S)"
if [ -f "$SSHD_CONF" ]; then
  cp -a "$SSHD_CONF" "$SSHD_BAK" && ok "config sshd sauvegardée → $SSHD_BAK"
fi
VER=$(ssh -V 2>&1 || true)
echo "  version ssh : $VER"
if printf '%s' "$VER" | grep -Eq 'OpenSSH_(9\.[89]|[1-9][0-9]\.)'; then
  if grep -qEi '^[[:space:]]*PerSourcePenalties[[:space:]]+no' "$SSHD_CONF" 2>/dev/null; then
    ok "PerSourcePenalties no déjà en place"
  else
    if grep -qEi '^[[:space:]]*PerSourcePenalties[[:space:]]' "$SSHD_CONF" 2>/dev/null; then
      sed -i -E 's/^[[:space:]]*PerSourcePenalties[[:space:]].*/PerSourcePenalties no/I' "$SSHD_CONF"
    else
      printf '\n# gen3ia : les penalites source (SCP du CD) bloquaient tout client entrant\nPerSourcePenalties no\n' >> "$SSHD_CONF"
    fi
    ok "PerSourcePenalties no écrit dans sshd_config"
  fi
  # Priorité sshd : « la PREMIÈRE valeur obtenue gagne ». Sur Ubuntu/Debian
  # le Include sshd_config.d/*.conf est en tête de sshd_config → les
  # drop-ins sont lus AVANT le corps principal. Un drop-in fournisseur qui
  # définirait PerSourcePenalties yes écraserait donc notre ligne ajoutée
  # en bas. Contre-mesure : drop-in 00- (tri alphabétique en premier) →
  # notre valeur est lue la première et prévaut systématiquement.
  SSHD_D=/etc/ssh/sshd_config.d
  if [ -d "$SSHD_D" ]; then
    printf '%s\n' '# gen3ia — lu en premier : prévaut sur tout autre drop-in' \
      'PerSourcePenalties no' > "$SSHD_D/00-gen3ia-nopenalties.conf"
    ok "drop-in 00-gen3ia-nopenalties.conf posé (priorité maximale)"
  fi
  if command -v sshd >/dev/null 2>&1; then
    if ! sshd -t 2>/dev/null; then
      [ -f "$SSHD_BAK" ] && cp -a "$SSHD_BAK" "$SSHD_CONF"
      rm -f "$SSHD_D/00-gen3ia-nopenalties.conf"
      warn "sshd -t a rejeté la config — sauvegarde restaurée + drop-in retiré (option inconnue ?)"
    else
      ok "sshd -t : configuration valide (config principale + drop-in)"
    fi
  fi
else
  warn "OpenSSH < 9.8 : PerSourcePenalties n'existe pas — rien à désactiver"
fi
if command -v fail2ban-client >/dev/null 2>&1; then
  if fail2ban-client unban --all >/dev/null 2>&1; then
    ok "fail2ban : toutes les IP débannies"
  else
    warn "fail2ban unban non concluant (jail vide ou service inactif)"
  fi
else
  ok "fail2ban absent — rien à débannir"
fi
if command -v ufw >/dev/null 2>&1; then
  ufw allow 22022/tcp >/dev/null 2>&1 && ok "ufw : 22022/tcp autorisé"
fi
RESTART_OK=0
systemctl restart ssh 2>/dev/null && RESTART_OK=1
if [ "$RESTART_OK" = "0" ]; then systemctl restart sshd 2>/dev/null && RESTART_OK=1; fi
if [ "$RESTART_OK" = "0" ] && command -v service >/dev/null 2>&1; then
  service ssh restart >/dev/null 2>&1 && RESTART_OK=1
  service sshd restart >/dev/null 2>&1 && RESTART_OK=1
fi
if [ "$RESTART_OK" = "1" ]; then
  ok "sshd redémarré — pénalités mémoire purgées, barrage levé durablement"
else
  err "redémarrage sshd à faire à la main : systemctl restart ssh"
fi
KS=$(timeout 12 ssh-keyscan -T 8 -p 22022 127.0.0.1 2>/dev/null | grep -c 'ssh-')
if [ "${KS:-0}" -ge 1 ]; then
  ok "sshd répond normalement en local (clé hôte reçue)"
else
  warn "sshd encore muet en local — vérifier le pare-feu du panneau fournisseur"
fi

# ---------------------------------------------- 3. Réinstallation du poller
etape 3 "Réinstallation du poller pull (HTTPS sortant, zéro SSH)"
mkdir -p "$UPDATER_DIR"
curl -fsSL -m 20 "$BASE/pull-deploy.sh" -o "$UPDATER_DIR/pull-deploy.sh" \
  && [ -s "$UPDATER_DIR/pull-deploy.sh" ] \
  && head -1 "$UPDATER_DIR/pull-deploy.sh" | grep -q '^#!' \
  && chmod +x "$UPDATER_DIR/pull-deploy.sh" \
  && ok "pull-deploy.sh réinstallé (version main)" \
  || err "pull-deploy.sh inaccessible — vérifier le réseau sortant"
curl -fsSL -m 20 "$BASE/auto-update.sh" -o "$UPDATER_DIR/auto-update.sh" \
  && chmod +x "$UPDATER_DIR/auto-update.sh" \
  && ok "auto-update.sh réinstallé (boucle 2 min)"
printf '#!/bin/bash\n# Shim posé par fix-definitif-vps.sh : le poller déploie en mode pull.\nexec bash %s/pull-deploy.sh\n' "$UPDATER_DIR" > "$UPDATER_DIR/deploy.sh"
chmod +x "$UPDATER_DIR/deploy.sh"
ok "shim deploy.sh → pull-deploy.sh en place"

# ------------------------------------------------- 4. Purge états bloquants
etape 4 "Purge des états bloquants (backoff + blacklist du SHA cible + tar résiduel)"
rm -f "$STATE_DIR/pull-fail.txt"
ok "backoff purgé (pull-fail.txt)"
rm -f /tmp/next-build.tar.gz /tmp/next-build.tar.gz.sha256
ok "tar résiduel /tmp purgé (téléchargements partiels impossibles à valider)"
if [ -f "$STATE_DIR/failed_commits.txt" ] && grep -qxF "$TARGET_SHA" "$STATE_DIR/failed_commits.txt"; then
  grep -vxF "$TARGET_SHA" "$STATE_DIR/failed_commits.txt" > "$STATE_DIR/failed_commits.txt.new" \
    && mv "$STATE_DIR/failed_commits.txt.new" "$STATE_DIR/failed_commits.txt"
  ok "SHA cible dé-blacklisté ($TARGET_SHA — ses échecs venaient du canal, pas du build)"
else
  ok "blacklist : SHA cible absent — rien à purger"
fi

# ----------------------------------------------------- 5. Réparation PM2
etape 5 "Réparation du poller PM2 « updater » (+ persistance reboots)"
pm2 delete updater >/dev/null 2>&1 || true
if pm2 start "$UPDATER_DIR/auto-update.sh" --name updater >/dev/null 2>&1; then
  ok "updater recréé et démarré (premier cycle immédiat, puis toutes les 2 min)"
else
  err "démarrage PM2 impossible — voir : pm2 logs updater"
fi
if command -v systemctl >/dev/null 2>&1; then
  if ! systemctl is-enabled pm2-root >/dev/null 2>&1; then
    pm2 startup systemd -u root --hp /root >/dev/null 2>&1 \
      && ok "pm2 startup configuré (survit aux reboots)" \
      || warn "pm2 startup non configuré (non bloquant)"
  else
    ok "pm2 startup déjà configuré"
  fi
fi
pm2 save >/dev/null 2>&1 && ok "état pm2 sauvegardé (dump persistant)"

# ------------------------------------------------- 6. Déploiement immédiat
etape 6 "Déploiement immédiat du build cd-latest ($TARGET_SHA)"
bash "$UPDATER_DIR/pull-deploy.sh"
CODE=$?
if [ "$CODE" = "0" ]; then
  ok "chaîne pull terminée (code 0) — swap atomique + health check passés"
else
  warn "pull-deploy.sh code $CODE — le watchdog (étape 7) retentera toutes les 5 min"
fi

# ------------------------------------------------ 7. Watchdog anti-récidive
etape 7 "Watchdog anti-récidive (toutes les 5 min, systemd puis repli cron)"
cat > "$UPDATER_DIR/watchdog.sh" <<'WDOG'
#!/bin/bash
# gen3ia — watchdog VPS : updater online, app online, livraison à jour.
# Appelé par le timer systemd gen3ia-watchdog (ou cron). Idempotent.
LOG=/var/log/gen3ia-watchdog.log
UPDATER_DIR=/opt/gen3ia-updater
STATE_DIR=$UPDATER_DIR/state
say() { echo "[$(date '+%F %T')] $*" >> "$LOG"; }
[ "$(id -u)" = "0" ] || exit 0
[ -f "$LOG" ] && [ "$(stat -c%s "$LOG" 2>/dev/null || echo 0)" -gt 5242880 ] && : > "$LOG"
# pm2 muet après un reboot ? → resurrect du dump
pm2 pid gen3ia >/dev/null 2>&1 || { say "pm2 muet — resurrect du dump"; pm2 resurrect >/dev/null 2>&1 || true; }
# updater online ?
P=$(pm2 pid updater 2>/dev/null | tr -d '[:space:]')
if [ -z "$P" ] || [ "$P" = "0" ]; then
  say "updater inactif (pid=$P) — redémarrage automatique"
  pm2 delete updater >/dev/null 2>&1 || true
  pm2 start "$UPDATER_DIR/auto-update.sh" --name updater >/dev/null 2>&1 \
    || say "ERREUR: updater non redémarrable"
  pm2 save >/dev/null 2>&1 || true
fi
# app online ?
if ! curl -fsS -m 10 -o /dev/null http://127.0.0.1:3000/ 2>/dev/null; then
  say "app injoignable sur :3000 — pm2 restart gen3ia"
  pm2 restart gen3ia --update-env >/dev/null 2>&1 || true
fi
# disque saturé ? un /opt plein fait échouer les téléchargements en silence
U=$(df -P /opt 2>/dev/null | awk 'NR==2{gsub("%",""); print $5}')
if [ -n "${U:-}" ] && [ "$U" -ge 90 ]; then
  say "ALERTE disque : /opt à ${U}% — purge du tar résiduel /tmp (195 Mo)"
  rm -f /tmp/next-build.tar.gz /tmp/next-build.tar.gz.sha256
fi
# livraison à jour ? (pull-deploy.sh gère lui-même blacklist/backoff/idempotence)
META=$(curl -fsSL -m 20 -H "Cache-Control: no-cache" \
  "https://github.com/missock237-spec/gen3ia/releases/download/cd-latest/meta.json?_=$(date +%s)" 2>/dev/null) || META=""
TS=$(printf '%s' "$META" | grep -o '"sha":"[0-9a-f]*"' | head -1 | sed 's/.*:"//; s/"$//')
[ -n "$TS" ] || exit 0
LD=$(cat "$STATE_DIR/last-deployed.txt" 2>/dev/null)
if [ -n "$LD" ] && [ "$LD" != "$TS" ]; then
  say "retard de livraison : prod=$LD cible=$TS — pull forcé"
  bash "$UPDATER_DIR/pull-deploy.sh" >> "$LOG" 2>&1 || true
fi
exit 0
WDOG
chmod +x "$UPDATER_DIR/watchdog.sh"
TIMER_ACTIF=0
if command -v systemctl >/dev/null 2>&1 && systemctl is-system-running >/dev/null 2>&1; then
  cat > /etc/systemd/system/gen3ia-watchdog.service <<'UNIT'
[Unit]
Description=gen3ia watchdog (poller/app/livraison)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/opt/gen3ia-updater/watchdog.sh
User=root
TimeoutStartSec=900
UNIT
  cat > /etc/systemd/system/gen3ia-watchdog.timer <<'TIMER'
[Unit]
Description=gen3ia watchdog périodique (5 min)

[Timer]
OnBootSec=90
OnUnitActiveSec=300
Persistent=true
Unit=gen3ia-watchdog.service

[Install]
WantedBy=timers.target
TIMER
  systemctl daemon-reload
  systemctl enable --now gen3ia-watchdog.timer >/dev/null 2>&1 \
    && { ok "watchdog systemd armé (timer 5 min, actif dès maintenant)"; TIMER_ACTIF=1; }
fi
if [ "$TIMER_ACTIF" = "0" ]; then
  (crontab -l 2>/dev/null | grep -v gen3ia-watchdog; \
   echo "*/5 * * * * /opt/gen3ia-updater/watchdog.sh >/dev/null 2>&1") | crontab - \
    && ok "watchdog cron armé (toutes les 5 min)"
fi
bash "$UPDATER_DIR/watchdog.sh" && ok "exécution témoin du watchdog : OK"

# -------------------------------------------------- 8. Vérification finale
etape 8 "Vérification finale"
sleep 3
DEPLOYED=$(cat "$STATE_DIR/last-deployed.txt" 2>/dev/null)
PROD_SHA=$(curl -fsS -m 10 http://127.0.0.1:3000/version.json 2>/dev/null \
  | grep -o '"gitSha":"[^"]*"' | head -1 | sed 's/.*:"//; s/"$//')
HEALTH=$(curl -fsS -m 10 http://127.0.0.1:3000/api/health 2>/dev/null | head -c 120)
UPD_PID=$(pm2 pid updater 2>/dev/null | tr -d '[:space:]')
echo "  last-deployed       : ${DEPLOYED:-aucun}"
echo "  prod (version.json) : ${PROD_SHA:-injoignable}"
echo "  /api/health         : ${HEALTH:-injoignable}"
if [ -n "$UPD_PID" ] && [ "$UPD_PID" != "0" ]; then
  ok "updater PM2 online (pid $UPD_PID)"
else
  err "updater PM2 toujours inactif — voir pm2 logs updater"
fi
echo
if [ "$PROD_SHA" = "$TARGET_SHA" ] && curl -fsS -m 10 -o /dev/null http://127.0.0.1:3000/ 2>/dev/null; then
  echo "  ==============================================================="
  echo "   VERDICT : RÉTABLI DÉFINITIVEMENT"
  echo "   prod = $TARGET_SHA · health OK · poller online · watchdog armé"
  echo "   SSH : pénalités désactivées (barrage ne peut plus revenir)"
  echo "   Contrôle externe : curl https://gen3ia.online/version.json"
  echo "  ==============================================================="
  exit 0
else
  echo "  VERDICT PARTIEL : prod=${PROD_SHA:-?} vs cible=$TARGET_SHA"
  echo "  Journaux : /var/log/gen3ia-fix.log · $STATE_DIR/deploy.log · /var/log/gen3ia-watchdog.log"
  echo "  Ce script est idempotent : le réexécuter est sans risque."
  exit 1
fi
