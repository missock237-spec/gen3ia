# Task 114-c — Marketplace d'agents P2P (listings, hire, escrow loyer, split, routes)

**Branche :** main (base 88de191 + travaux 114-a/114-b non commités dans l'arbre)
**Statut :** TERMINÉ — tsc 0 · eslint 0 (fichiers touchés, --max-warnings 0) · vitest complet 286 fichiers / 2 983 verts + 2 skipped / 0 échec (+51 tests)
**Périmètre respecté :** aucun git d'écriture ; fichiers interdits NON modifiés (imports lecture seuls : charter, personalized-plan, repository, unified-agent, pricing).

## Fichiers créés (NOUVEAU)

| Fichier | Contenu |
|---|---|
| `lib/marketplace/agent-listings.ts` | Annonces : schémas zod (AgentListing/AgentHire/ListingReview + corps de routes), collections r2fs `agentListings`/`agentListingHires`/`agentListingReviews`/`hireByExecution`, publishAgentListing (upsert 1 listing/agent), updateAgentListing (owner-only, 404 anti-énum), getAgentListing, listPublishedAgentListings (scan where + tri mémoire + curseur index), listOwnerListings, upsertListingReview (doc-ID `listing_hire` idempotent, stats CAS), PURES : canHireListing / canRateListing / rateForListing / compareListingsForSort |
| `lib/marketplace/hire.ts` | hireAgent (escrow loyer `hire_<hireId>` → planification sécurisée → enfilement, résultat discriminé {…} \| {error, status}), settleAgentHireByExecution (captured/released/skipped, IDEMPOTENT, FAIL-SOFT total, split via computeRevenueSplit + applyEarning, stats hires dans la transaction CAS du hire), marketplaceFeeBps (env, défaut 2 000, clamp 0..5 000), listTenantHires/listOwnerHires |
| `app/api/marketplace/agents/route.ts` | GET catalogue public (sort popular/newest/price_asc/rating, limit ≤50, cursor) ; POST publication → 201 |
| `app/api/marketplace/agents/mine/route.ts` | GET {listings, hiresReceived, hiresSent} |
| `app/api/marketplace/agents/[listingId]/route.ts` | GET détail (public published ; owner voit draft/suspended ; 404 anti-énum), PATCH owner, DELETE = suspension douce |
| `app/api/marketplace/agents/[listingId]/hire/route.ts` | POST {objective, conversationId?} → 202 {hireId, runId, executionId, priceMinor, pollUrl `/api/agents/runs/{runId}`} ; 400/401/402/403/404/409/503 FR |
| `app/api/marketplace/agents/[listingId]/rate/route.ts` | POST {hireId, rating 1..5, comment?} → 201 créé / 200 maj {review, rating} |
| `lib/marketplace/agent-listings.test.ts` | 29 tests (pures, bornes schémas, publication/upsert, update, avis/stats) |
| `lib/marketplace/hire.test.ts` | 22 tests (feeBps, hireAgent gardes + chemin nominal + compensations, settle table complète + idempotence + fail-soft) |

## Fichiers modifiés (ÉDITION ADDITIVE)

| Fichier | Changement |
|---|---|
| `lib/billing/wallet.ts` | `"earning"` dans WalletTransactionTypeSchema + `applyEarning` (clonée de applyTopup : ledger `earning_<reference>` idempotent, balance +=, réarmement alerte solde bas). RIEN d'autre. |
| `app/billing/page.tsx` | Libellé FR défensif « Gain marketplace » + signe « + » pour earning. |
| `app/api/queue/mission-tick/route.ts` | 2 blocs additifs try/catch `settleAgentHireByExecution` : ① après captureMissionEscrow du bloc terminal ({missionStatus: queueStatus}), ② sur le chemin state===undefined ({missionStatus: "failed"}) — sans ② le loyer d'une location échouée en throw runtime resterait bloqué sans TTL. Import statique, jamais bloquant. |
| `lib/env/config-report.ts` | `GEN3IA_MARKETPLACE_FEE_BPS` dans OPTIONAL_RECOGNIZED. |
| `worklog.md` | Entrée Task 114-c (template respecté). |

## Décisions clés

1. **Upsert listing** : UN SEUL listing par agent — republier met à jour l'existant (pas de doublon, pas de 409) ; l'opération est idempotente côté UI. 404 si l'agent n'appartient pas au propriétaire (anti-énumération), 409 si l'agent n'est pas `active`.
2. **Charte de location** : `buildAgentCharter(agent)` rebuild depuis le record (MÊME voie que planAgentTask) + contrainte FR « CONTEXTE DE LOCATION… ne jamais mentionner de données privées du propriétaire » ; `subAgents: []` (jamais les sous-agents privés) ; allowedTools = `policyForAgent(agent).allowedTools` + `composio.execute` (miroir planAgentTask) ; provider/model fixed du propriétaire. Exécution sous l'uid du **LOCATAIRE** → isolation mémoire/fichiers/facturation par construction.
3. **Ordre hireAgent** : gardes métier → file vérifiée → **réservation** → agent → plan → docs → enfilement ; TOUTE erreur post-réservation compense par `releaseReservation` (jamais de fonds bloqués) ; publishMissionTick null OU throw → release + hire `failed` + `markMissionEnqueueFailed`.
4. **Idempotence du settle** : wallet idempotent par doc-ID ledger (`settlement_/release_/earning_ + hire_<hireId>`) + garde hire.status !== "held" → skipped + stats listing incrémentées DANS la transaction CAS qui fige le hire (exactement-une-fois sous redélivrance QStash).
5. **Mapping absent = chemin rapide** : `hireByExecution/{executionId}` absent → `skipped` après UN seul GET — le cas général (missions ordinaires) ne paie quasiment rien au tick.
6. **{error, status}** : le résultat de hireAgent porte le statut HTTP canonique (superset du contrat `{error}` demandé) — la route ne devine rien.
7. **Commission figée** : commissionBps copié dans le hire à la création ; le settle utilise la valeur du document (changements d'env non rétroactifs).

## Points d'attention (pour les agents suivants)

- **UI non demandée** dans ce lot : API complète prête (catalogue/publication/détail/hire/rate/mine). Le locataire suit la mission via `/api/agents/runs/{runId}` (scopé locataire).
- **Fonds « held » sans tick final** (kill plateforme avant ré-enfilement) : pas de reaper dédié pour les loyers (le reaper 114-a couvre `walletHolds`, pas `agentListingHires`) — à couvrir si observé en prod.
- **Listing suspendu après enfilement** : la location déjà « held » s'exécute et se règle normalement (le settle lit le hire, pas le listing) — suspendre n'annule pas une location en cours (choix assumé).
- La mission marketplace paie normalement le **frais de résultat escrow 114-a** via le rattrapage au tick (pas de double réservation au lancement — 114-c ne réserve QUE le loyer).
- Tests : mocks adminDb pattern `mission-escrow.test.ts` / `outcome-credits.test.ts` ; `buildAgentCharter` NON mocké dans hire.test (agent mocké avec name/description/type/skills complets — la charte est rebuild réellement).
