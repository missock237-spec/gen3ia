# =====================================================================
# GEN3IA — image Hyperlift (Spaceship)
#
# Pourquoi PAS de `next build` ici : il réclame > 3,5 Go de RSS et le
# build officiel est déjà compilé par le runner GitHub (7 Go) et publié
# sur la release publique « cd-latest » (déployé aussi sur le VPS).
# L'image installe les dépendances au build et télécharge le .next au
# démarrage avec vérification de fraîcheur (cf. docker-entrypoint.sh) :
# un rebuild Hyperlift est donc TOUJOURS la dernière version de main,
# même si les couches Docker sont servies depuis le cache.
#
# Requis par Hyperlift : ce Dockerfile au racine du dépôt, l'app écoute
# sur $PORT, health check HTTP natif sur /api/health.
# =====================================================================
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dépendances de production (couche cache-stable : seulement invalidated
# si package.json / package-lock.json changent).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# Fichiers requis par `next start` au runtime.
COPY next.config.ts tsconfig.json ./
COPY public ./public
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production \
    GEN3IA_REPO=missock237-spec/gen3ia \
    NEXT_TELEMETRY_DISABLED=1

# .next est téléchargé au démarrage par l'entrypoint (build runner).
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=300s --retries=5 \
  CMD curl -fsS "http://127.0.0.1:${PORT:-3000}/api/health" || exit 1

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
