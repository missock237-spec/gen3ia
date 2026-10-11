# Référence API — Gen3ia

> Référence humaine de l'API publique Gen3ia (production : `https://gen3ia.online`).
> La spécification machine complète est disponible dans [`docs/api/openapi.json`](./api/openapi.json) (OpenAPI 3.1) — les deux documents décrivent les mêmes contrats.

---

## 1. Introduction

Gen3ia expose une API publique v1 qui permet d'exécuter vos agents depuis n'importe quel client externe : backend, n8n, script serveur, app mobile, webhook… Le pipeline d'exécution est **exactement celui de l'application** : plan personnalisé dérivé de la configuration réelle de l'agent, politique de sécurité dérivée de son type, et les mêmes garde-fous (approbations humaines HITL, quotas, facturation, audit, cloisonnement multi-tenant). Aucune intégration ne peut contourner ce que l'application elle-même subit.

| Endpoint | Authentification | Rôle |
|---|---|---|
| `POST /api/v1/agents/{agentId}/run` | Clé `g3a_…` (scope `agents`) | Exécuter une mission sur un agent personnalisé |
| `GET /api/status` | Aucune (public) | Statut plateforme pour moniteurs d'uptime (200/503) |
| `GET /api/health` | Aucune (public) | Heartbeat ultra-léger sans dépendance |

Pour les autres familles d'API (API de session avec missions longues + SSE, webhooks, surface publique), consultez [`docs/sdk.md`](./sdk.md).

---

## 2. Authentification

### 2.1 Créer une clé API

1. Connectez-vous à l'application puis ouvrez **Paramètres → Clés API**.
2. Donnez un nom à la clé, cochez les **scopes** nécessaires (voir §2.2) et choisissez le quota (req/min).
3. La clé complète `g3a_…` est affichée **une seule fois** à la création — copiez-la immédiatement. Ensuite, seul le préfixe `g3a_XXXXXX` reste listable ; la clé ne peut plus être relue (seul son hash SHA-256 est persisté côté serveur).
4. Vous pouvez **révoquer** une clé à tout moment (révocation immédiate et auditable).

Bonnes pratiques :

- Une clé ne vit **jamais** côté navigateur ou application mobile — proxifiez toujours par votre backend.
- Révoquez et régénérez en cas de doute.
- Limite d'hygiène : 10 clés actives maximum par compte.

### 2.2 Scopes

| Scope | Autorisation |
|---|---|
| `agents` | Exécuter des agents via `POST /api/v1/agents/{agentId}/run` |
| `media` | Opérations médias (image, vidéo, audio) via `/api/v1/**` |
| `terminal` | Exécution de commandes terminal via `/api/v1/**` |
| `read` | Lectures seule (sans effet de bord) via `/api/v1/**` |

Une clé présentée sans le scope requis reçoit `403` avec un message explicite.

### 2.3 Utiliser la clé

Deux en-têtes équivalents sont acceptés :

```bash
# En-tête Authorization (Bearer)
Authorization: Bearer g3a_exemple

# Ou en-tête dédié
X-API-Key: g3a_exemple
```

> Note : la route d'exécution accepte également la chaîne développeur extensions
> (`Authorization: Bearer g3x_…` + `X-Gen3ia-Project-Id: <projet lié>`) en repli
> quand aucune clé `g3a_` n'est fournie. Les exemples ci-dessous utilisent la
> chaîne `g3a_` recommandée.

---

## 3. Quotas et limites

| Limite | Valeur | Au-delà |
|---|---|---|
| Quota par clé | `rateLimitPerMinute` req/min (défaut **60**, configurable de 1 à 600 à la création) | `429` |
| Taux d'exécution d'agents | **30 exécutions / 5 minutes / compte** | `429` |
| Clés actives | 10 par compte | `409` à la création |
| Objectif de mission | 3 à 20 000 caractères | `400` |
| Durée d'exécution | jusqu'à 300 s (synchrone) | — |

Le quota par clé est vérifié **avant toute exécution métier**. En cas de dépassement, attendez la fin de la fenêtre (quelques secondes à quelques minutes selon la limite touchée) et réessayez.

---

## 4. Endpoints

### 4.1 Exécuter un agent — `POST /api/v1/agents/{agentId}/run`

Exécute une mission sur un agent personnalisé (créé via le Studio ou Agent gen). L'agent doit :

- appartenir au propriétaire de la clé — sinon `404` (réponse d'anti-énumération : un agent appartenant à un autre compte renvoie aussi 404, sans révéler son existence) ;
- être **actif** — sinon `409`.

Corps de la requête :

```json
{ "objective": "Surveille le marché des drones et rédige un résumé en 10 points." }
```

Exemple complet :

```bash
curl -X POST "https://gen3ia.online/api/v1/agents/agent_1/run" \
  -H "Authorization: Bearer g3a_exemple" \
  -H "Content-Type: application/json" \
  -H "x-request-id: mon-correlateur-42" \
  -d '{"objective": "Surveille le marché des drones et rédige un résumé en 10 points."}'
```

Réponse `200` — le statut **de la requête HTTP** est 200 dès que l'exécution s'est déroulée ; le statut **de la mission** est dans le corps :

```json
{
  "executionId": "0192f7c1-7b2e-7a41-9d3f-6f9c1d4b8e01",
  "requestId": "mon-correlateur-42",
  "agent": { "id": "agent_1", "name": "Veilleur", "type": "research" },
  "status": "completed",
  "outputs": { "s1": "Rapport de veille réel" },
  "observations": [
    { "stepId": "s1", "success": true, "output": "Rapport de veille réel", "latencyMs": 4210, "timestamp": "2026-10-12T09:41:22.000Z" }
  ],
  "billing": {
    "currency": "XAF",
    "totalChargeMinor": 12,
    "totalProviderCostEur": 0.0031,
    "llmInputTokens": 1840,
    "llmOutputTokens": 512
  },
  "durationMs": 4396
}
```

Champs de la réponse :

| Champ | Description |
|---|---|
| `executionId` | Identifiant de l'exécution — à conserver pour toute réclamation. |
| `requestId` | Identifiant de corrélation (votre `x-request-id` ou un UUID généré). |
| `agent` | Résumé de l'agent exécuté (`id`, `name`, `type`). |
| `status` | Statut de la mission : `completed`, `failed`, `cancelled`… |
| `outputs` | Sorties nommées de la mission (clé = étape du plan, valeur = livrable). |
| `observations` | Observations d'exécution étape par étape — les approbations humaines requises (HITL) y apparaissent. |
| `billing` | Facturation réelle : devise, charge (unités mineures), coût fournisseur, tokens. |
| `durationMs` | Durée totale d'exécution. |

Exemple d'erreur — quota de la clé dépassé (`429`) :

```bash
curl -X POST "https://gen3ia.online/api/v1/agents/agent_1/run" \
  -H "Authorization: Bearer g3a_exemple" \
  -H "Content-Type: application/json" \
  -d '{"objective": "Nouvelle mission."}' -i
```

```http
HTTP/1.1 429 Too Many Requests
content-type: application/json
x-request-id: c14b0d5a-9f31-4d8a-b6e2-2b7a8c9d0e11

{
  "error": "Quota de la clé API g3a_Exemp dépassé (60 req/min). Réessayez dans quelques secondes.",
  "requestId": "c14b0d5a-9f31-4d8a-b6e2-2b7a8c9d0e11"
}
```

Pour les missions longues, préférez l'API de session (`202` immédiat + suivi par polling/SSE) documentée dans [`docs/sdk.md`](./sdk.md).

### 4.2 Statut plateforme — `GET /api/status`

Public, sans authentification. Conçu pour les moniteurs d'uptime : `200` quand tout va bien, `503` dès qu'un service est dégradé — alerte sur le code HTTP sans parser le corps.

```bash
curl -s "https://gen3ia.online/api/status" | jq
```

```json
{
  "status": "ok",
  "version": "dpl-4f8a1c2e9b",
  "services": {
    "auth": { "ok": true },
    "r2": { "ok": true },
    "ticks": { "ok": true }
  },
  "checkedAt": "2026-10-12T09:41:22.000Z"
}
```

Services sondés : `auth` (initialisation Firebase Admin), `r2` (sonde de stockage bornée 3 s), `ticks` (file de ticks R2 configurée et joignable). En dégradation, chaque service porte une `reason` stable : `not_configured`, `timeout` ou `error`. La réponse est mise en cache par le CDN 30 s (`s-maxage=30`).

### 4.3 Heartbeat — `GET /api/health`

Public, sans authentification. Ultra-léger : aucune dépendance externe, aucune donnée sensible, répond en quelques millisecondes.

```bash
curl -s "https://gen3ia.online/api/health"
```

```json
{ "status": "ok", "timestamp": "2026-10-12T09:41:22.000Z" }
```

Les vérifications d'infrastructure détaillées (protégées) sont dans `/api/health/infra`.

---

## 5. Codes d'erreur

Toutes les erreurs renvoient un JSON structuré `{ error, requestId }` — jamais de stack trace. Joignez le `requestId` à tout ticket support.

| Code | Cause | Message type |
|---|---|---|
| `400` | Objectif invalide (3 à 20 000 caractères) ou corps illisible | `Objectif invalide (3 à 20000 caractères).` — avec `issues` détaillant les champs |
| `401` | Clé `g3a_` absente, invalide ou révoquée ; chaîne `g3x_` invalide | `Clé API invalide ou révoquée.` |
| `402` | Solde du portefeuille insuffisant | `Solde du portefeuille insuffisant. Rechargez votre wallet dans Facturation.` |
| `403` | Clé sans le scope requis (`agents` pour l'exécution) | `La clé API (g3a_Exemp) n'autorise pas le scope « agents ».` |
| `404` | Agent introuvable **ou** appartenant à un autre compte (anti-énumération) | `Agent introuvable ou inaccessible avec cette clé.` |
| `409` | Agent non actif (en pause, archivé…) | `L'agent est paused. Activez-le avant de l'exécuter via l'API.` |
| `429` | Quota par clé (req/min) ou taux d'exécution (30 / 5 min / compte) | `Quota de la clé API g3a_Exemp dépassé (60 req/min). Réessayez dans quelques secondes.` |
| `500` | Erreur interne inattendue (corps structuré néanmoins) | message sûr, non technique |
| `503` | *(réservé à `/api/status`)* Un service sondé est dégradé | corps `StatusResponse` avec `status: "degraded"` |

---

## 6. Spécification machine

La source de vérité complète (schémas, exemples, en-têtes) est la spécification
OpenAPI 3.1 : [`docs/api/openapi.json`](./api/openapi.json). Elle est validée en
CI par `docs/openapi.test.ts`, qui vérifie notamment que chaque chemin documenté
existe réellement dans `app/api/` et que chaque méthode documentée correspond à
un export HTTP du code — la spécification ne peut pas dériver du code réel.
