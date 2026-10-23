# Tracing distribué — corrélation de bout en bout (W3C traceparent ↔ Gen3ia)

> Runbook d'observabilité distribuée (Task K). Contexte d'exécution :
> VPS 2 Go RAM (AlmaLinux), PM2 (process `gen3ia`, port 3000), nginx,
> déploiement par swap atomique (`deploy-vps.yml`, NE PAS modifier).
>
> Compléments : `docs/sre/sli-slo.md` (SLI/SLO, endpoint `/api/metrics`),
> `.env.example` § « OBSERVABILITÉ DISTRIBUTUÉE » (interrupteurs).

---

## 1. Architecture de corrélation — qui porte quoi

Un même identifiant logique traverse **six** surfaces. La clé primaire est le
**traceId Gen3ia** ; le standard W3C est le véhicule inter-services.

| Surface | Champ | Posé par | Notes |
|---|---|---|---|
| En-tête HTTP custom | `x-gen3ia-trace-id` (`trc_<uuid>` ou id libre 8-64) | middleware (requêtes `/api/*`) | **Rétrocompatibilité** : continue de fonctionner seul, prioritaire |
| En-tête HTTP W3C | `traceparent` = `00-<trace-id>-<span-id>-<flags>` | middleware + `signServiceRequest` + client worker GPU | 32 hex = trace-id, **nouveau span-id par requête**, flags entrants préservés |
| Spans OTel | attribut `gen3ia.trace_id` | `lib/observability/otel.ts` (exécutions d'agents + spans `http.server`) | les spans d'exécution restent des racines volontaires (event-as-span) |
| Sentry | tag `gen3ia.trace_id` + en-têtes de requête | `onRequestError` (instrumentation.ts) | le scrubbing (`beforeSend`) ne touche pas ce tag |
| Logs pino | champ `traceId` (+ `orgId`/`userId`/`route`) | mixin AsyncLocalStorage (`contexte-requete.ts`) | automatique pour toute requête instrumentée ; `onRequestError` logge `request.error` avec le traceId |
| `/api/metrics` | classes de route agrégées (`chat`/`api`/`pages`/`static`) | hook middleware (Task G) | PAS de trace-id (cardinalité bornée) — on relie via les logs/nginx |

### Flux d'une requête

```
Client ──► nginx ──► MIDDLEWARE (Edge/Node isolé)
                      │ lit : x-gen3ia-trace-id entrant  (PRIORITÉ 1)
                      │       traceparent W3C entrant    (PRIORITÉ 2)
                      │       sinon génère trc_<uuid>
                      │ émet : traceparent 00-<dérivé(trc)>-<nouveau span>-<flags>
                      │        + x-gen3ia-trace-id  ── réponses /api/*, headers
                      │          aval (requestHeaders), 403 inclus
                      ▼
              Route handler (Node)
                      │ ALS: executerAvecContexteRequete (withContexteRoute)
                      │      → logs pino portent traceId automatiquement
                      │      → span OTel « http.server » si export activé
                      │      → erreurs → onRequestError (log + tag Sentry)
                      ▼
              Appels sortants signés (crons/worker) → traceparent émis
```

### Dérivation déterministe traceId Gen3ia → trace-id W3C

Un traceId Gen3ia (`trc_…`) n'est pas du hex 32 : le trace-id W3C émis est
une **dérivation FNV-1a 128 bits déterministe** (deux passes 64 bits,
`lib/observability/trace-w3c.ts`). Pourquoi déterministe : le même traceId
propagé sur plusieurs requêtes inter-services donne le **même arbre W3C** au
collecteur. La bijection est reconstructible :

```bash
node -e '
const fnv = (g, s) => { let h = g; for (const c of s) { h ^= BigInt(c.charCodeAt(0) & 255); h = (h * 0x100000001b3n) & 0xffffffffffffffffn; } return h.toString(16).padStart(16, "0"); };
const trc = process.argv[1];
console.log(fnv(0xcbf29ce484222325n, trc) + fnv(0x9e3779b97f4a7c15n, "gen3ia\u001f" + trc));
' trc_abc123
```

Cas identité : si le traceId retenu EST déjà 32 hex minuscules (trace-id W3C
entrant réutilisé), il est repris tel quel.

---

## 2. Ce qui est actif PAR DÉFAUT (zéro configuration)

Neutre mémoire : tout ce qui suit fonctionne sans aucune variable
d'environnement et sans collecteur.

1. **Middleware** : couple `x-gen3ia-trace-id` + `traceparent` émis sur les
   réponses `/api/*`, propagé en aval, présent sur les 403 (module pur
   `lib/observability/trace-w3c.ts` — exécutable Edge ET Node).
2. **onRequestError** : toute erreur non-401 produit un log pino
   `request.error` avec `traceId` + un événement Sentry taggé
   `gen3ia.trace_id` (l'objectif minimal de corrélation des logs d'erreur).
3. **Crons/worker signés** : `signServiceRequest(…, { traceId })` émet le
   traceparent ; `verifyServiceRequest` logge et expose le traceparent
   entrant.
4. **/api/metrics** : SLI Prometheus in-process (Task G).

## 3. Activer l'export OpenTelemetry (traces + métriques OTLP)

Interrupteur unique : `OTEL_EXPORTER_OTLP_ENDPOINT` (`.env.example` §
OBSERVABILITÉ DISTRIBUTUÉE). Sans lui : **aucun module SDK chargé** (zéro
surcoût RAM). Avec lui, le SDK est importé dynamiquement au boot
(`instrumentation.ts` → `initOtel()`), sampler
`ParentBased(TraceIdRatioBased(OTEL_TRACES_SAMPLER_ARG, défaut 0.1))`.

### Option A — backend distant (recommandé sur 2 Go)

Grafana Cloud / Datadog : zéro RAM locale.

```bash
# /opt/gen3ia/.env (source du process PM2)
OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp-gw-prod-xx.grafana.net/otlp
OTEL_TRACES_SAMPLER_ARG=0.1
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Basic <base64 id:token>"
```

### Option B — collecteur local léger (Grafana Alloy)

```bash
# Alloy ~60 Mo RAM — PAS un stack Prometheus+Loki+Tempo complet.
sudo dnf install -y grafana-alloy   # ou binaire statique
# /etc/alloy/config.alloy : receivers.otlp.http → endpoints Grafana Cloud
#   (Alloy fait relais : l'app pousse en local, Alloy exporte au loin)
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318/v1/traces
```

Puis `pm2 restart gen3ia --update-env` et vérifier :

```bash
pm2 logs gen3ia --lines 50 | grep -i otel   # pas de « init ignorée »
journalctl -u alloy -f                      # réception OTLP
```

### Option C — investigation ciblée

Passer temporairement `OTEL_TRACES_SAMPLER_ARG=1.0`, investiguer, revenir à
0.1. Le chemin no-op est verrouillé par les tests (`otel.test.ts`).

---

## 4. Dépannage — « relier une erreur Sentry aux logs et aux métriques »

**Scénario** : une erreur 500 apparaît dans Sentry, il faut les logs et le
contexte métrique correspondants.

1. **Sentry** : ouvrir l'événement → onglet *Request* → en-têtes
   `x-gen3ia-trace-id` (posés par le middleware). Le tag `gen3ia.trace_id`
   porte la même valeur (posé par `onRequestError`). Recherche Sentry :
   `gen3ia.trace_id:"trc_…"`.
2. **Logs pino** :
   ```bash
   pm2 logs gen3ia --err --lines 500 --nostream | grep '"traceId":"trc_…"'
   # ou, pour les lignes request.error en JSON :
   grep "request.error" /home/gen3ia/.pm2/logs/gen3ia-out.log | grep trc_…
   ```
   Toute la chaîne async d'une requête instrumentée (`withContexteRoute`)
   partage ce champ — sans `grep` de chemin ni d'horodatage.
3. **Métriques** : `/api/metrics` agrège PAR CLASSE (jamais par trace-id) —
   `curl -s -H "Authorization: Bearer $METRICS_TOKEN" http://127.0.0.1:3000/api/metrics
   | grep 'route="chat"'` donne le taux d'erreur/latence du périmètre ;
   la requête fautive est identifiée par sa classe + les logs ci-dessus.
4. **Collecteur OTel (si activé)** : rechercher le trace-id W3C =
   dérivation FNV du traceId Gen3ia (script § 1) OU la requête par attribut
   `gen3ia.trace_id = "trc_…"`. Les spans portent aussi
   `gen3ia.execution_id` / `gen3ia.org_id` (corrélation métier Task 59).
5. **Sens inverse** (support client) : le client lit `x-gen3ia-trace-id`
   dans la réponse de l'appel fautif → même grep côté serveur. Un
   `traceparent` reçu d'un service amont est réutilisé comme traceId
   Gen3ia (priorité 2) : la même valeur sert partout.

**Pièges connus**
- Un 401 `AUTH_REQUIRED` est volontairement exclu de Sentry/log d'erreur
  (bruit métier) — le trace-id reste disponible via les en-têtes de réponse.
- Les compteurs `/api/metrics` sont remis à zéro au redémarrage PM2.
- Le middleware mesure SON statut (200/307/403) ; les 5xx viennent des logs
  nginx (cf. `docs/sre/sli-slo.md`).

---

## 5. Propagation inter-services

| Appelant | Mécanisme | Traceparent |
|---|---|---|
| Crons système (Task I) | `signServiceRequest(descriptor{traceId}, …)` | émis si `traceId` fourni ; ne fait PAS partie du HMAC |
| Récepteur (routes système) | `verifyServiceRequest` | parse strict, log + retour dans le verdict `ok` |
| Moteur IA → worker GPU | `lib/training/providers/worker-http.ts` | émis automatiquement quand l'AsyncLocalStorage est remplie |

**Worker Python (training-worker/)** : son code n'a PAS été modifié
(volontaire — pas de fichier client unique, suite pytest non exécutable ici).
Le worker EST un serveur : pour lire le traceparent reçu, ajouter plus tard
une middleware FastAPI triviale dans `training_worker/app.py` :

```python
@app.middleware("http")
async def _tracer_traceparent(request, call_next):
    tp = request.headers.get("traceparent")
    if tp:
        logging.getLogger("training_worker").info("traceparent reçu : %s", tp)
    return await call_next(request)
```

(Pour de vraies spans côté worker : `opentelemetry-instrumentation-fastapi`
+ exporter OTLP vers le même collecteur — Phase 2.)

---

## 6. Adoption du contexte dans les routes (spans serveur + logs)

Les logs pino portent le traceId automatiquement dès que la chaîne async de
la requête vit dans l'AsyncLocalStorage. Deux mécanismes :

1. **Automatique** : `onRequestError` (erreurs) et les exécutions OTel
   (repli `traceIdRequeteCourant()`).
2. **Opt-in par route** — `withContexteRoute` (lib/observability/span-serveur.ts) :

   ```ts
   import { withContexteRoute } from "@/lib/observability/span-serveur";

   export const POST = withContexteRoute(async (request) => {
     // logs pino corrélés + span http.server (si export activé)
   });
   ```

   Coût : ~0 sans collecteur (span no-op). Adoption progressive, sans
   rupture ; `protectRoute` continue de fonctionner tel quel.

**Limite structurelle assumée** : le MIDDLEWARE ne peut pas remplir
l'AsyncLocalStorage (contexte d'isolation distinct, même au runtime
`nodejs`) — d'où le remplissage côté route/erreurs, et la propagation par
en-têtes (le seul canal universel).

**Limites HTTP** : `@opentelemetry/instrumentation-http` n'est PAS une
dépendance (choix RAM) → pas de spans HTTP automatiques au niveau
`http.Server`. Les spans `http.server` viennent de `withContexteRoute`.
Ajouter l'auto-instrumentation plus tard = `npm i
@opentelemetry/instrumentation-http` + `instrumentations: [...]` dans
`initOtel()` (scaffold prévu : le tableau configSdk l'accepte).

---

## 7. Phase 3 — GKE (migration cible)

Objectifs : corrélation conservée, instrumentation AUTO, backends managés.

| Volet | Cible GKE | Détails |
|---|---|---|
| Traces | **Cloud Trace** (endpoint OTLP géré) | `OTEL_EXPORTER_OTLP_ENDPOINT=https://telemetry.googleapis.com/...` via Workload Identity ; l'export OTLP/HTTP existant suffit |
| Métriques | **Managed Service for Prometheus** | `/api/metrics` scrappé par le collecteur GMP (annotation `prometheus.io/scrape`) ; les métriques OTel d'exécution continuent en push OTLP |
| Auto-instrumentation | **GKE automatic OTEL instrumentation** | injection sidecar/managée → spans HTTP `http.server` complètes sans `withContexteRoute` ; le sampler `TraceIdRatioBased` devient configurable au niveau du cluster |
| Logs | **Cloud Logging** | pino JSON déjà structuré : champ `traceId` détecté comme label de corrélation (Log Analytics : `jsonPayload.traceId`) |
| Contexte | GCP trace-id ↔ `gen3ia.trace_id` | la dérivation déterministe reste valable ; le traceparent émis par le middleware est continué par l'auto-instrumentation (continuité native W3C) |
| Sentry | inchangé | tag `gen3ia.trace_id` + scrubbing conservés |

Prérequis migration : garder le middleware et `trace-w3c.ts` tels quels (le
couple d'en-têtes est LE contrat), retirer les exports locaux Alloy,
mapper les variables env par namespace Helm (Task orchestration).

---

## 8. Contrats verrouillés par les tests

| Fichier | Contrats |
|---|---|
| `lib/observability/trace-w3c.test.ts` | parse strict (zéros, version ff, longueurs), dérivation déterministe, émission valide, span-id unique |
| `lib/security/middleware.test.ts` | priorité custom > W3C > génération, émission du couple (réponses + 403), malformé ignoré, span-id distincts |
| `lib/observability/otel.test.ts` | no-op sans endpoint, sampler câblé (+ dégradation gracieuse), spans serveur manuelles, repli ALS |
| `lib/observability/contexte-requete.test.ts` | héritage async ALS, enrichissement tenant, propagation sortante |
| `lib/security/service-identity.test.ts` | traceparent signé (hors HMAC), log entrant, malformé ni loggé ni exposé |
