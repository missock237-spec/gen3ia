# Pipeline d'auto-apprentissage gen3ia

Système autonome de collecte de données web + entraînement incrémental, **découplé** du serveur d'inférence : gen3 apprend en continu sans jamais ralentir les réponses aux utilisateurs.

## Architecture (découplage asynchrone)

```
┌─────────────────────────────────────┐      ┌──────────────────────────────────────┐
│  PROCESS DE FOND (PM2)              │      │  PROCESS PRINCIPAL (Next.js, PM2)    │
│  gen3ia-pipeline                    │      │  gen3ia — inférence & WebSocket      │
│                                     │      │                                      │
│  cycle toutes les 60 min :          │      │  · utilisateurs, streaming, réponses │
│  1. config/targets.json (déclaratif)│      │  · route /api/cron/knowledge-ingest  │
│  2. scraping (fetch OU Puppeteer)   │      │    (CRON_SECRET) :                   │
│  3. nettoyage + SHA-256 + append    │─────▶│    - lit output.jsonl PAR OFFSET     │
│     atomique output.jsonl           │ JSONL│    - Firestore + index Qdrant        │
│  4. Queue & Batching :              │ partagé   - périmètre global gen3ia-corpus │
│     seuil 1 000 docs OU 60 min      │      │  · searchKnowledge FUSIONNE le corpus│
│     → POST knowledge-ingest         │      │    (fail-soft, kill-switch env)      │
└─────────────────────────────────────┘      └──────────────────────────────────────┘
```

Les deux mondes **ne partagent que le fichier JSONL** (`var/pipeline/output.jsonl` sur le VPS) — aucun couplage mémoire, aucun impact CPU/RAM du scraping sur l'inférence.

## Garanties

| Garantie | Mécanisme |
|---|---|
| Jamais de doublon | SHA-256 du contenu (daemon `cache_hashes.json` + serveur `ingest-state.json`) |
| Jamais de ligne à moitié lue | Append-only `\n` + serveur par offset **octets**, lignes complètes uniquement |
| Jamais de re-ingestion après crash | État `.tmp + rename` réécrit après **chaque** document |
| Jamais de saturation serveur | Cap 60 docs / passage + timebox 240 s + mutex d'ingestion |
| Jamais de dégradation des réponses | Fusion corpus **fail-soft** ; kill-switch `PIPELINE_CORPUS_OFF=1` |
| Jamais de boucle d'échec | Document échoué = avancé (journalisé), lot toujours terminé |

## Le daemon (ce dossier)

```bash
cd pipeline
npm install            # winston seul — ~0 Chromium (léger, VPS 2 Go friendly)
npm run build          # tsc → dist/
npm start              # boucle continue (PM2 recommandé)
npm run once           # cycle unique (debug/cron externe)
```

- **Moteur fetch** (défaut) : pages statiques, ~60 Mo RAM, aucune dépendance native.
- **Moteur Puppeteer** (optionnel) : uniquement pour les cibles `"requiresJs": true` —
  `npm install puppeteer` dans `pipeline/` pour l'activer ; absence = dégradation
  gracieuse (cibles requiresJs sautées avec avertissement).
- **`config/targets.json`** : cibles déclaratives (url, customSelector, selectorsToRemove,
  rateLimitMs, requiresJs). Politesse : délais humanisés ±30 %, User-Agent rotatif.
- **`ecosystem.config.js`** : PM2 `gen3ia-pipeline`, `max_memory_restart: '1G'`,
  autorestart — le serveur `gen3ia` n'est PAS géré ici.

### Variables d'environnement (pipeline/.env, jamais commité)

| Variable | Défaut | Rôle |
|---|---|---|
| `PIPELINE_INTERVAL_MINUTES` | `60` | Cycle de scraping |
| `PIPELINE_BATCH_THRESHOLD` | `1000` | Déclenchement ingestion (documents accumulés) |
| `PIPELINE_TRAIN_INTERVAL_MINUTES` | `60` | Déclenchement ingestion (temps écoulé) |
| `GEN3IA_INGEST_URL` | `https://gen3ia.online/api/cron/knowledge-ingest` | Endpoint serveur |
| `GEN3IA_CRON_SECRET` | — | **Requis** pour déclencher (= `CRON_SECRET` du serveur) |

Sur le VPS, `deploy.sh` synchronise automatiquement `CRON_SECRET` depuis `.env.production` vers `pipeline/.env`.

## Côté serveur (dans le dépôt principal)

- `app/api/cron/knowledge-ingest` — POST/GET Bearer `CRON_SECRET` : consomme le JSONL
  par offset → `ingestKnowledgeDocument` (Firestore + Qdrant) sous `gen3ia-corpus`.
  Deux déclencheurs équivalents (daemon OU cron externe), mutex interne.
- `lib/pipeline/corpus.ts` — protocole pur (format, qualité ≥ 100 mots, dédup).
- `lib/pipeline/ingest.ts` — orchestration (offset octets, état atomique, cap, timebox).
- `lib/knowledge/search.ts` — fusion du corpus dans les recherches utilisateur (fail-soft).

## Vérification en production

```bash
# 1. Route protégée (doit répondre 401 sans secret) :
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://gen3ia.online/api/cron/knowledge-ingest

# 2. Daemon vivant :
pm2 ls | grep gen3ia-pipeline
pm2 logs gen3ia-pipeline --lines 20

# 3. Déclencher manuellement (avec le secret du serveur) :
curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" https://gen3ia.online/api/cron/knowledge-ingest
# → {"ok":true,"offset":…,"ingested":…,"duplicates":…,"skipped":…,"failures":[…]}

# 4. Corpus indexé (log Firestore/Qdrant côté serveur) :
tail -f /opt/gen3ia/pipeline/logs/combined.log
```
