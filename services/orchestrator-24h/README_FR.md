# Gen3ia — orchestrateur 24/7 de tâches longues (v2)

## Ce que ce kit fait

- Met les tâches dans des files Redis persistantes séparées (`image`, `audio`, `video`, `data`) ; les entrées ne sont supprimées qu'après l'enregistrement du résultat et l'accusé de réception.
- Exécute les quatre workers simultanément dans des conteneurs séparés.
- **Priorité réelle (nouveau v2)** : `priority <= 3` publie dans une voie rapide dédiée (`gen3ia:queue:<modalité>:fast`) lue en premier par le worker — le champ n'est plus décoratif ; le seuil se règle avec `FAST_LANE_MAX_PRIORITY`.
- **Arrêt gracieux (nouveau v2)** : SIGTERM termine la tâche en cours avant de quitter ; au-delà du délai compose (`stop_grace_period: 90s`), la reprise passe par le re-claim des entrées pending.
- **Expiration des états terminaux (nouveau v2)** : `JOB_TTL_SECONDS` (défaut 7 jours) évite la croissance illimitée de Redis sur un petit VPS.
- **Supervision (nouveau v2)** : `GET /stats` renvoie la profondeur des files (voies rapide + normale par modalité), les quarantaines `gen3ia:dead:*` et la file de revue.
- **Clé API comparée à temps constant (nouveau v2)** (secrets.compare_digest).
- Reprend les tâches mises en attente si un worker meurt, nouvelles tentatives avec temporisation exponentielle, échecs définitifs en quarantaine (`gen3ia:dead:*`).
- Enregistre les états dans Redis et renvoie les tâches distantes sans les déclarer « de haute qualité » quand aucun score/indicateur n'est fourni (partent en `review_required`).
- Pour les lots de données : champs, textes vides/trop longs, URLs, doublons exacts, **lot vide refusé explicitement (v2)** ; lignes acceptées dans `data/cleaned/`, rejetées dans `data/rejected/` (rien n'est perdu).
- Relance automatique `restart: unless-stopped`.

## Limite essentielle

Ce projet est un **orchestrateur de tâches longues**, pas un modèle de génération ni un moteur d'entraînement. Il ne contient pas les poids des modèles image/audio/vidéo. Les trois variables `GEN3IA_*_ENDPOINT` doivent viser de vrais endpoints de génération de Gen3ia ou de fournisseurs GPU. Ces endpoints doivent accepter un POST JSON et renvoyer un objet JSON contenant un résultat (par exemple `output_url` ou `outputs`). Pour certifier automatiquement la qualité, le fournisseur doit aussi renvoyer `quality: {"score": 0.91}` ou `quality_passed: true` ; sinon la tâche passe en `review_required`.

## Rôle dans la chaîne gen3ia

```
Corpus / soumissions ──► POST /jobs (modality=data) ──► worker-data ──► data/cleaned/ ─┐
                                                                                       │
Soumissions créatives ─► POST /jobs (image/audio/video, priority 1-10) ─► workers ─────┤──► endpoints de
                                                                                        │    génération gen3ia
Entraînement de l'adaptateur gen3 : passe par le Training Studio / services/training-worker/     │
(ou le notebook Colab) — ce n'est PAS le rôle de cet orchestrateur.                     │
                                                                                        ▼
                                                                        résultats → qualité → review
```

L'orchestrateur est la **couche d'exécution longue durée** : files persistantes, reprises, priorités, quarantaine. Le corpus nettoyé par le worker `data` alimente directement les packs d'entraînement (`training/gen3-image-pack/`).

## Installation sur Linux

Prérequis : Docker et Docker Compose v2 installés, assez d'espace disque, et des endpoints de génération accessibles depuis le serveur.

```bash
unzip gen3ia_24h_orchestrator_ameliore.zip
cd gen3ia_24h_orchestrator
cp .env.example .env
nano .env
```

Dans `.env` :

1. Remplace `QUEUE_API_KEY` par une longue clé aléatoire.
2. Configure `GEN3IA_IMAGE_ENDPOINT`, `GEN3IA_AUDIO_ENDPOINT` et `GEN3IA_VIDEO_ENDPOINT` avec les URL réelles de tes routes backend.
3. Renseigne `PROVIDER_BEARER_TOKEN` seulement si ces routes demandent un token.
4. (v2) Ajuste `FAST_LANE_MAX_PRIORITY` et `JOB_TTL_SECONDS` si besoin.

Puis démarre :

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f --tail=100
```

L'API écoute uniquement sur `127.0.0.1:8000` pour éviter de publier l'interface sur Internet. Pour l'exposer, configure un reverse proxy HTTPS (Nginx/Caddy) et conserve l'authentification.

## Tester l'état

```bash
curl http://127.0.0.1:8000/health
```

## Envoyer une tâche image (priorité normale)

```bash
curl -X POST http://127.0.0.1:8000/jobs \
  -H 'Content-Type: application/json' \
  -H "X-API-Key: $QUEUE_API_KEY" \
  -H 'Idempotency-Key: test-image-001' \
  -d '{"modality":"image","priority":5,"payload":{"prompt":"Illustration d’une ville futuriste au lever du soleil","size":"1024x1024"}}'
```

Les exemples lisent la clé depuis l'environnement (`export QUEUE_API_KEY=...` une fois par session) : elle ne figure jamais en clair dans la documentation ni dans l'historique du shell. L'API répond par un `job_id` et la voie (`lane: normal|fast`). Consulte ensuite :

```bash
curl -H "X-API-Key: $QUEUE_API_KEY" http://127.0.0.1:8000/jobs/ID_DE_LA_TACHE
```

## Tâche urgente (voie rapide, v2)

```bash
# priority <= FAST_LANE_MAX_PRIORITY (défaut 3) → traitée en premier
curl -X POST http://127.0.0.1:8000/jobs \
  -H 'Content-Type: application/json' -H "X-API-Key: $QUEUE_API_KEY" \
  -d '{"modality":"video","priority":1,"payload":{"scene":"teaser 10s"}}'
```

## Supervision 24/7 (v2)

```bash
curl -H "X-API-Key: $QUEUE_API_KEY" http://127.0.0.1:8000/stats
# {"queues":{"image":{"normal":0,"fast":1,"total":1},...},"dead_letters":{...},"review":0,...}
docker compose ps
docker compose logs -f worker-image worker-audio worker-video worker-data
```

## Envoyer une tâche audio ou vidéo

Même endpoint, seulement `modality` change : `audio` ou `video`. Le contenu de `payload` dépend du contrat réel de ton endpoint Gen3ia.

## Traitement qualité d'un lot de données

```bash
curl -X POST http://127.0.0.1:8000/jobs \
  -H 'Content-Type: application/json' -H "X-API-Key: $QUEUE_API_KEY" \
  -d '{"modality":"data","payload":{"records":[{"caption":"Un chat noir sur un canapé","asset_url":"https://example.com/cat.jpg"},{"caption":"   "}]}}'
```

Le worker écrit les bonnes lignes dans `data/cleaned/<job_id>.jsonl` et les lignes à corriger dans `data/rejected/<job_id>.jsonl`. Un lot vide est refusé avec une erreur permanente explicite.

## Tests

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt pytest
python -m pytest        # 26 tests — logique pure, sans serveur Redis
```

## Important pour un VPS de 2 Go de RAM

Cette configuration ne fait que l'orchestration HTTP et le contrôle de données ; elle **ne charge pas** de modèles génératifs en mémoire. Un fichier d'override resserre les limites mémoire pour cohabiter avec gen3ia (PM2) :

```bash
docker compose -f docker-compose.yml -f docker-compose.vps-2g.override.yml up -d --build
# total ~870 Mo (redis 224 + api 160 + 4 workers 120)
```

Surveiller `free -m` après démarrage ; si swap ou latence, déployer l'orchestrateur sur une machine séparée. Augmente le nombre de workers seulement après avoir mesuré RAM, CPU, temps de réponse, limites et coût des fournisseurs.

## Fiabilité et qualité

- Redis AOF persiste l'état de la file, mais ce n'est pas une sauvegarde complète : configure des sauvegardes et une supervision disque.
- Les jobs doivent rester idempotents côté génération : ce système passe un `Idempotency-Key` égal à `job_id`, mais le backend doit réellement le respecter pour éviter des coûts/doublons lors d'une reprise.
- `CLAIM_IDLE_MS` doit être supérieur au temps maximal attendu d'une tâche distante, sinon un travail lent peut être repris deux fois.
- Le contrôle des données ici est structurel, pas une preuve de vérité, d'absence de biais, de qualité créative, ni de respect des droits. Ajoute des évaluateurs adaptés à chaque modalité et une validation humaine pour les cas incertains.
- Ne traite jamais les contenus des utilisateurs comme des instructions système ; valide les URLs/permissions et n'envoie pas de données privées à un fournisseur sans autorisation.
