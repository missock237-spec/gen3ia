# SDK Gen3ia — `@gen3ia/sdk` et intégrations API

> Task 61 (priorité #4 de la feuille de route) : le SDK TypeScript officiel est
> distribué par l'application elle-même depuis `app/api/public`, et le flux
> **webhook → mission agent** y est documenté de bout en bout.

## 1. Vue d'ensemble

Gen3ia expose trois familles d'API publiques, couvertes par un unique client
typé (`@gen3ia/sdk`, zéro dépendance) :

| Famille | Authentification | Usage typique |
|---|---|---|
| **API développeur** `/api/v1/agents/{agentId}/run` | Clé `g3x_…` + `X-Gen3ia-Project-Id` | Backend, n8n, script serveur : exécuter un agent personnalisé et récupérer le résultat |
| **API de session** `/api/agents/run`, `/api/agents/runs/{runId}` (+ SSE) | Token ID Firebase (`Authorization: Bearer`) | Missions longues en file d'attente (QStash) : 202 immédiat, suivi par polling ou SSE |
| **Surface publique** `/api/public/*`, `/api/webhooks/agent-triggers/{token}` | Aucune / token d'URL | Sonde de santé, chat client (agents publics, salons commerciaux), déclencheurs webhook |

Le pipeline d'exécution est **le même partout** : plan personnalisé dérivé de
la configuration de l'agent, politique de sécurité dérivée de son type, mêmes
garde-fous (HITL, quotas, facturation, audit, cloisonnement multi-tenant par
`orgId`). Aucune intégration ne peut contourner ce que l'application elle-même
subit.

## 2. Installation du SDK

```bash
# La commande recommandée (l'URL est servie par l'application elle-même) :
npm install https://gen3ia.online/api/public/sdk/download

# Équivalents :
pnpm add https://gen3ia.online/api/public/sdk/download
yarn add https://gen3ia.online/api/public/sdk/download
```

- `GET /api/public/sdk` — métadonnées vivantes (version, commandes
  d'installation, surface d'API, quickstart). C'est le point d'entrée à
  communiquer aux intégrateurs.
- `GET /api/public/sdk/download` — redirection vers le tarball versionné
  `public/sdk/gen3ia-sdk-<version>.tgz` (asset statique CDN, immuable par
  construction puisque le nom porte la version).
- Node >= 20 ou navigateur moderne ; ESM (`import`) et CommonJS (`require`)
  fournis dans le même package.

## 3. Authentification en pratique

### 3.1 Clé développeur (serveur uniquement)

Émise depuis l'espace développeur Gen3ia, liée à **un** projet. Elle donne
accès à `POST /api/v1/agents/{agentId}/run` (l'agent doit appartenir au
propriétaire de la clé et être actif).

```ts
import { Gen3iaClient } from "@gen3ia/sdk";

const client = new Gen3iaClient({
  apiKey: process.env.GEN3IA_API_KEY!,   // g3x_…
  projectId: process.env.GEN3IA_PROJECT_ID!,
});

const result = await client.agents.run("<agentId>", { objective: "…" });
// result.outputs : sorties nommées ; result.billing : coût de l'exécution.
```

Règles de sécurité : la clé ne vit **jamais** côté navigateur ou application
mobile — proxifiez par votre backend. Révoquez et régénérez en cas de doute.
Taux limite : 30 exécutions / 5 minutes / compte.

### 3.2 Token Firebase (missions longues)

Le client accepte un token statique ou un **fournisseur** (résolu à chaque
requête — indispensable, l'ID token expire au bout d'une heure) :

```ts
const client = new Gen3iaClient({
  firebaseToken: () => firebaseAuth.currentUser!.getIdToken(),
});

const queued = await client.missions.run({ objective: "Audit du site client.", mode: "async" });
// → 202 { runId, statusUrl, streamUrl, pollSeconds }
```

Le mode `async` (défaut quand la file QStash est configurée) enregistre la
mission, l'enfile et renvoie **202 immédiatement** : la mission s'exécute par
tranches bornées dans `/api/queue/mission-tick`, survit aux fenêtres
serverless de 60 s et n'est **pas** tuée si le client se déconnecte. Le mode
`sync` conserve la compatibilité (exécution dans la requête, 60 s max).

Suivi :

```ts
// Polling — statut, timeline compacte, compteur d'étapes restantes :
const status = await client.missions.get(queued.runId);

// Attente bornée (lève Gen3iaTimeoutError au-delà) :
const final = await client.missions.waitFor(queued.runId, { timeoutMs: 600_000 });

// Temps réel SSE — reconnexion automatique gérée par le SDK (follow) :
await client.missions.follow(queued.runId, {
  onProgress: (p) => render(p.status, p.pendingCount, p.timeline),
  onFinal: (f) => done(f.status),
});
```

Le flux SSE est un simple miroir du document de file (~2 s de latence, aucun
coût de génération) ; il se ferme après ~50 s et le SDK se reconnecte
automatiquement jusqu'au `final`.

### 3.3 Sans authentification

```ts
const anon = new Gen3iaClient();
await anon.health();                                   // sonde de disponibilité
await anon.publicAgents.chat("<agentId>", { message: "Bonjour !" });
await anon.commercial.chat("<slug>", { message: "…", conversationId });
```

## 4. Flux webhook → mission agent

C'est le mécanisme qui relie **un système externe quelconque** (n8n, Make,
Zapier, Stripe, GitHub, un backend maison capable d'appeler une URL) à
**l'exécution d'un agent Gen3ia**, sans compte ni session.

### 4.1 Étape 1 — création du déclencheur

Le propriétaire crée un agent « toujours actif » avec un objectif fixe. Dans
l'application, cela passe par une demande en langage naturel à l'agent
d'orchestration (« exécute cette mission chaque fois que je t'appelle par
webhook »), qui invoque l'outil interne `schedule.create` avec
`enableWebhook: true`.

Le serveur génère alors un **token secret de 32 caractères hexadécimaux**
(`alwaysOnWebhookToken`), généré côté serveur uniquement — jamais soumis par
le client — et l'attache à la planification. L'URL de déclenchement a la
forme :

```
POST https://gen3ia.online/api/webhooks/agent-triggers/<token>
```

`GET` sur la même URL sert de sonde de santé pratique (vérification depuis
n8n/Make sans déclencher la mission).

### 4.2 Étape 2 — déclenchement externe

N'importe quel émetteur POSTe le payload de son choix (JSON ou texte brut —
un corps non JSON est transmis tel quel, tronqué à 4 000 caractères) :

```bash
curl -X POST "https://gen3ia.online/api/webhooks/agent-triggers/<token>" \
  -H "Content-Type: application/json" \
  -d '{"event":"invoice.paid","invoiceId":"in_123"}'
```

Réponses :

| Code | Signification |
|---|---|
| `202` | Mission acceptée — `{ ok: true, executionId, status: "accepted" }`. L'agent travaille en tâche de fond. |
| `409` | Une exécution est déjà en cours pour cet agent — déclenchement **ignoré** (pas de file d'attente ici : c'est un garde anti-martèlement explicite). |
| `429` | Taux limite dépassé — 20 déclenchements / heure / token. |
| `404` | Token inconnu ou planification supprimée. |
| `400` | Token malformé (format hex 16–120 attendu). |

### 4.3 Étape 3 — exécution en arrière-plan

La mission part dans le même pipeline que les exécutions internes (tranches
QStash, checkpoint, notifications de fin à l'utilisateur). Le webhook ne
bloque jamais sur la génération : il répond en quelques millisecondes.

### 4.4 Depuis le SDK

Le SDK expose le même mécanisme pour les intégrateurs qui déclenchent depuis
du code plutôt que depuis une plateforme d'automatisation :

```ts
const client = new Gen3iaClient();
try {
  const result = await client.webhooks.trigger("<token>", { event: "invoice.paid" });
  console.log("mission acceptée :", result.executionId);
} catch (error) {
  if (error instanceof Gen3iaApiError && error.status === 409) {
    // Déjà en cours — à ignorer silencieusement dans la plupart des intégrations.
  } else {
    throw error;
  }
}
```

### 4.5 Webhook ou API de session ?

| Besoin | Choix |
|---|---|
| Un système externe déclenche un objectif **fixe**, sans retour dans la boucle | **Webhook** (token d'URL, 202 feu et oublié) |
| L'appelant veut passer un **objectif variable** et suivre la mission (SSE/polling) | **`missions.run`** (token Firebase, 202 + runId) |
| Un backend exécute un agent **personnalisé** et lit le résultat final | **`agents.run`** (clé `g3x_`, synchrone) |

## 5. Erreurs et fiabilité côté intégrateur

- `Gen3iaApiError.status` — 400 (validation), 401 (auth), 402 (portefeuille
  insuffisant), 403 (accès refusé/orgue), 404 (anti-énumération), 409
  (conflit d'exécution), 429 (taux limite, `retryAfterMs`), 502 (file
  indisponible), 503 (dépendance indisponible).
- `error.requestId` — identifiant de corrélation serveur, à joindre à tout
  ticket support.
- Le SDK **retente les GET** transitoires (réseau, 502/503/504) avec backoff
  exponentiel, mais **jamais les POST** : ré-exécuter une mission facturée
  doublerait la facture. C'est une décision de conception assumée — un POST
  en échec réseau doit être réconcilié par l'intégrateur (par exemple via un
  identifiant d'idempotence de son côté).

## 6. Cycle de vie du SDK (dépôt)

Le SDK vit dans `sdk/` du dépôt principal ; la distribution repose sur trois
sources verrouillées ensemble par des tests :

1. `sdk/package.json` — version du package ;
2. `lib/public-sdk/manifest.ts` — version exposée par les routes ;
3. `public/sdk/gen3ia-sdk-<version>.tgz` — tarball committé.

```bash
npm run sdk:build   # typecheck strict + émission ESM/CJS
npm run sdk:test    # 36 tests (client, erreurs, retry, SSE, follow)
npm run sdk:pack    # régénère le tarball (après bump de version)
```

Procédure de publication : modifier `sdk/src` → bump des **deux** versions →
`npm run sdk:build && npm run sdk:pack` → commit + push (la CI typecheck,
build, teste et vérifie la cohérence tarball/version).
