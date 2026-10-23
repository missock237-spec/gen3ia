# syntax=docker/dockerfile:1
###############################################################################
# GEN3IA — Image Docker multi-stage (node:22-alpine)
#
# ⚠️ CONTEXTE (lire avant d'utiliser) :
#   - La production ACTUELLE reste PM2 + nginx sur le VPS (deploy/cd-finisher.sh,
#     swap atomique .next) — ce Dockerfile N'EST PAS le runtime de prod.
#   - Objectif : PORTABILITÉ (reproductibilité locale, future GKE Phase 3,
#     environnements de pré-prod jetables).
#
# Choix structurel (cohérence avec next.config.ts vérifiée) :
#   next.config.ts n'utilise PAS output:'standalone' (le CD actuel ne s'appuie
#   que sur .next). On NE l'active PAS (règle projet : ne pas modifier
#   next.config.ts pour Docker) → l'étape runner embarque donc :
#     .next + node_modules PROD (npm ci --omit=dev) + `next start`.
#
# node:22 : borne haute du champ engines du projet (">=20.9.0 <23").
###############################################################################

# -----------------------------------------------------------------------------
# ÉTAPE 1 — deps : installation REPRODUCTIBLE des dépendances (npm ci verrouillé
# par package-lock.json). Étape isolée : le cache Docker ne rejoue l'installation
# que si les manifests changent, jamais à chaque édition de code source.
# -----------------------------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# -----------------------------------------------------------------------------
# ÉTAPE 2 — builder : compilation Next.js (npm run build = version-manifest init
# + next build + version-manifest finalize).
#   - NEXT_TELEMETRY_DISABLED=1 : aucune télémétrie Next.js envoyée au build ;
#   - Sentry : sans SENTRY_AUTH_TOKEN, withSentryConfig dégrade proprement
#     (pas d'upload de source maps, build vert) — comportement déjà prévu par
#     next.config.ts, aucun secret requis pour compiler ;
#   - assets/neural-pretrained/*.bin et var/ sont absents du contexte
#     (.dockerignore) : les replis runtime « amorcé à neuf » du runtime
#     neuronal (lib/neural/runtime.ts) sont prévus pour ça ;
#   - scripts/version-manifest.mjs tolère l'absence de .git (repli « nogit »).
# -----------------------------------------------------------------------------
FROM node:22-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# -----------------------------------------------------------------------------
# ÉTAPE 3 — deps-prod : node_modules de PRODUCTION SEULES (sans devDependencies :
# vitest, eslint, playwright… n'ont rien à faire dans l'image d'exécution).
# Stage séparé pour que le runner copie un arbre propre, sans purger à la main.
# -----------------------------------------------------------------------------
FROM node:22-alpine AS deps-prod
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# -----------------------------------------------------------------------------
# ÉTAPE 4 — runner : exécution en utilisateur NON-ROOT (user `node` fourni par
# l'image officielle). Surface minimale : .next, public, node_modules prod,
# package.json, next.config.ts — rien d'autre du dépôt.
# -----------------------------------------------------------------------------
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000

# curl : requis par le HEALTHCHECK (l'image alpine ne l'embarque pas).
RUN apk add --no-cache curl

# Dépendances de production, artefacts de build et fichiers requis par
# `next start` (next.config.ts est lu au démarrage ; public/ sert les
# fichiers statiques, dont version.json généré par le build).
COPY --from=deps-prod /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/next.config.ts ./next.config.ts

# Même sémantique que deploy/cd-finisher.sh : la version FINALE (BUILD_ID)
# écrite dans .next/version.json par version-manifest finalize devient la
# sonde /version.json. Sans ce fichier (build atypique), on garde le
# manifeste provisoire — la sonde reste servie.
RUN if [ -f .next/version.json ]; then cp .next/version.json public/version.json; fi \
    && mkdir -p /app/var \
    && chown -R node:node /app

# /app/var : état persistant du runtime neuronal (var/neural). Dans le
# conteneur il est ÉPHÉMÈRE (recrée l'état à neuf après redémontage) —
# monter un volume nommé ici si l'on veut conserver l'état pré-entraîné.
USER node
EXPOSE 3000

# Sonde de vie : la même que la production (endpoint public sans dépendance
# externe, app/api/health/route.ts) — les monitorings PM2 et Docker
# observent donc exactement le même signal.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD curl -f http://localhost:3000/api/health || exit 1

# `next start` (sans output:'standalone' — cf. note d'en-tête).
CMD ["npm", "run", "start"]
