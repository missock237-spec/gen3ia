FROM python:3.12-alpine

# PAS d'ENTRYPOINT : cf. docker/node/Dockerfile — le runner fournit
# la commande complète (["python", "/workspace/main.py"]).

RUN addgroup -S sandbox \
    && adduser -S sandbox -G sandbox

WORKDIR /workspace

USER sandbox
