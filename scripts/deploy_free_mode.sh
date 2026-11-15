#!/usr/bin/env bash
# Déploiement du MODE LIBRE de facturation sur le VPS Gen3ia.
# UNE seule session SSH : env + pull + build + reload + vérification.
# Idempotent : peut être relancé sans risque.

set -euo pipefail

APP_DIR="/opt/gen3ia"
ENV_FILE="/opt/gen3ia/.env.production"

echo "=== 1. État avant déploiement ==="
pm2 status gen3ia | tail -3
cd "$APP_DIR"
echo "Commit actuel : $(git rev-parse --short HEAD)"

echo "=== 2. Variable d'environnement GEN3IA_BILLING_ENABLED=false ==="
if grep -q "^GEN3IA_BILLING_ENABLED=" "$ENV_FILE" 2>/dev/null; then
  # Déjà présente : forcer la valeur false (sed idempotent)
  sed -i 's/^GEN3IA_BILLING_ENABLED=.*/GEN3IA_BILLING_ENABLED=false/' "$ENV_FILE"
  echo "Variable existante mise à jour -> false"
else
  printf '\n# Mode libre de facturation (migration R2 totale) : aucun débit, aucun blocage\nGEN3IA_BILLING_ENABLED=false\n' >> "$ENV_FILE"
  echo "Variable ajoutée -> false"
fi
chmod 600 "$ENV_FILE"
grep "^GEN3IA_BILLING_ENABLED=" "$ENV_FILE"

echo "=== 3. Récupération du code (git pull) ==="
git fetch origin
git reset --hard origin/main
echo "Nouveau commit : $(git rev-parse --short HEAD)"

echo "=== 4. Dépendances (si nécessaire) ==="
# npm ci uniquement si package-lock.json a changé depuis la dernière install
LOCK_HASH_FILE="/opt/gen3ia/.last-lock-hash"
NEW_HASH=$(sha256sum package-lock.json | cut -d' ' -f1)
OLD_HASH=$(cat "$LOCK_HASH_FILE" 2>/dev/null || echo "none")
if [ "$NEW_HASH" != "$OLD_HASH" ]; then
  echo "package-lock.json a changé -> npm ci"
  npm ci --no-audit --no-fund 2>&1 | tail -2
  echo "$NEW_HASH" > "$LOCK_HASH_FILE"
else
  echo "package-lock.json inchangé -> npm ci sauté"
fi

echo "=== 5. Build production ==="
# NODE_OPTIONS identique au build initial (swap-backed, 1 vCPU / 2 Go RAM)
NODE_OPTIONS="--max-old-space-size=2560" npm run build 2>&1 | tail -5

echo "=== 6. Rechargement PM2 ==="
pm2 reload gen3ia --update-env
sleep 3
pm2 status gen3ia | tail -3

echo "=== 7. Vérification application ==="
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 20 http://127.0.0.1:3000/api/health || echo "ERR")
echo "Santé locale /api/health : $HTTP_CODE"
HTTP_EXT=$(curl -s -o /dev/null -w "%{http_code}" --max-time 20 https://gen3ia.online/api/health || echo "ERR")
echo "Santé externe gen3ia.online : $HTTP_EXT"

echo "=== 8. Vérification du mode libre ==="
# La route wallet exige l'auth : 401 attendu (preuve que la route répond)
WALLET_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 20 http://127.0.0.1:3000/api/billing/wallet || echo "ERR")
echo "Route /api/billing/wallet (sans auth, 401 attendu) : $WALLET_CODE"
grep -c "GEN3IA_BILLING_ENABLED=false" "$ENV_FILE"

echo "=== DÉPLOIEMENT TERMINÉ ==="
