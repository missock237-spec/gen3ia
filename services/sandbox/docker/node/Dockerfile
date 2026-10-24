FROM node:22-alpine

# PAS d'ENTRYPOINT : le runner du service sandbox fournit la commande
# complète (ex. ["node", "/workspace/main.mjs"] ou ["sh", "/workspace/main.sh"]) —
# un ENTRYPOINT ici serait PRÉFIXÉ par Docker et casserait l'exécution
# (bug vu en production : « Cannot find module '/workspace/sh' »).

RUN addgroup -S sandbox \
    && adduser -S sandbox -G sandbox

WORKDIR /workspace

USER sandbox
