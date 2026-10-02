# @gen3ia/sdk

SDK TypeScript officiel de l'API **Gen3ia** — zéro dépendance, ESM + CommonJS, Node >= 20 et navigateurs modernes.

## Installation

```bash
npm install https://gen3ia.online/api/public/sdk/download
```

L'URL sert le tarball versionné de l'application elle-même (aucun registre public requis). Les métadonnées vivantes sont exposées par `GET /api/public/sdk`.

## Démarrage rapide

### Clé développeur — exécuter un agent personnalisé

```ts
import { Gen3iaClient } from "@gen3ia/sdk";

const client = new Gen3iaClient({
  apiKey: "g3x_…",        // clé API développeur (Facturation → API)
  projectId: "proj_…",    // projet Gen3ia lié à la clé
});

const result = await client.agents.run("agentId", {
  objective: "Rédige la veille concurrentielle du jour.",
});
console.log(result.outputs, result.billing);
```

### Missions longues — file d'attente + suivi SSE

```ts
const client = new Gen3iaClient({
  // Fournisseur async : le token est résolu À CHAQUE requête.
  firebaseToken: () => firebaseAuth.currentUser.getIdToken(),
});

// 202 immédiat : la mission vit dans la file (survit aux fenêtres serverless).
const queued = await client.missions.run({ objective: "Analyse 40 pages.", mode: "async" });
// queued.runId + queued.statusUrl + queued.streamUrl

// Suivi temps réel (reconnexion automatique entre fenêtres serveur) :
await client.missions.follow(queued.runId, {
  onProgress: (p) => console.log(p.status, p.pendingCount, p.timeline),
  onFinal: (f) => console.log("terminé :", f.status),
});

// … ou polling simple :
const final = await client.missions.waitFor(queued.runId, { timeoutMs: 600_000 });
```

### Webhook entrant — déclencher une mission « agent toujours actif »

```ts
const client = new Gen3iaClient({ baseUrl: "https://gen3ia.online" });
await client.webhooks.trigger("<token>", { event: "stripe.checkout.completed", id: "evt_…" });
// 202 { ok: true, executionId } — l'agent travaille en tâche de fond.
```

Le flux complet (création du token, plomberie n8n/Make/Stripe/GitHub, réponses 202/409) est documenté dans [`docs/sdk.md`](../docs/sdk.md#flux-webhook--mission-agent).

## Gestion des erreurs

| Classe | Signification | Réaction attendue |
|---|---|---|
| `Gen3iaConfigurationError` | SDK mal configuré (clé absente…) | Corriger l'intégration |
| `Gen3iaApiError` | Erreur HTTP structurée (`status`, `requestId`, `issues`, `retryAfterMs`) | Traiter selon `status` |
| `Gen3iaNetworkError` | Requête non aboutie (réseau, timeout) | Les GET sont déjà retentés ; ne PAS re-poster à l'aveugle |
| `Gen3iaTimeoutError` | Suivi dépassant le délai (`waitFor`, `follow`) | Reprendre le suivi |

## Garanties

- **POST jamais retentés** : ré-exécuter une mission facturée doublerait la facture. Les GET transitoires (réseau, 502/503/504) sont retentés avec backoff exponentiel.
- **Zéro dépendance** : `fetch`, `AbortSignal.timeout`, `ReadableStream` natifs.
- **Contrats typés** : chaque réponse serveur a son interface (`MissionRunStatus`, `AgentRunResult`, …).

## Développement (dépôt Gen3ia)

```bash
npm run sdk:build   # typecheck strict + émission dist/esm + dist/cjs
npm run sdk:test    # suite vitest dédiée
npm run sdk:pack    # tarball public/sdk/gen3ia-sdk-<version>.tgz
```

Après toute modification du SDK : bump de version dans `sdk/package.json` **ET** `lib/public-sdk/manifest.ts`, rebuild, repack — un test dédié échoue sinon.
