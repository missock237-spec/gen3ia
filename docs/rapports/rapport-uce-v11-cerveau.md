# LIVRABLE 5 — DOCUMENTATION DE L'INTÉGRATION AU CERVEAU CENTRAL (V1.1 Phase 4)

**Date** : 2026-11-25 · **Fichiers** : `core/capability-decision.ts` (NOUVEAU), `core/capability-brain-bridge.ts` (étendu), `lib/autonomous/core/*` (cerveau existant, inchangé) · **Statut** : IMPLEMENTED + INTEGRATED + TESTED.

## 1. Architecture d'autorité (règles mission)

```
UTILISATEUR → CERVEAU CENTRAL (Gen3iaCoeurAutonome + modules-agents)
                    │  (données : rapport bridge — inventaire, performances,
                    │   échecs, besoins, incidents, ressources, recommandations)
                    v
       CENTRAL DECISION ENGINE (capability-decision.ts)
            — synthèse DÉTERMINISTE sur données MESURÉES
            — verdict réel de la politique d'autonomie par décision
            — persistance + audit (cap_decisions), rejet traçable
                    v
       CAPABILITY ORCHESTRATOR (cycle-persistant.ts)
            — coordonne les moteurs spécialisés (workers exécutants)
```

Le pont n'est plus un simple transmetteur : son tick produit le rapport AU cerveau PUIS applique le moteur de décision du cerveau (règles explicites sur mesures réelles) et émet `uce-decisions` vers les autres modules. Les workers (découverte, évaluation, builder, monitoring) sont exclusivement des exécutants : ils ne s'attribuent pas de permissions (gates mécaniques du permission-manager et de la machine à états) et ne peuvent pas intégrer leurs créations (sortie max « proposee »).

## 2. Contrat `CapabilityDecision` (mission, champ par champ)

```ts
interface CapabilityDecision {
  decisionId: string;
  objective: string;
  action: "discover" | "evaluate" | "build" | "improve" | "disable" | "replace" | "monitor";
  targetCapability?: string;
  constraints: { maxCost?; maxDurationMs?; maxMemoryMb?; requiresApproval: boolean };
  rationale: string;        // cite la MESURE source (ex. « 6 échecs consécutifs »)
  expectedOutcome: string;
  // traçabilité : statut (produite|planifiee|executee|rejetee), priorite,
  // verdictPolitique {autorise, approbationRequise, raison}, produiteLe,
  // produitePar: "cerveau-central"
}
```

## 3. Ce que le cerveau reçoit / produit

**Reçoit** (rapport `RapportPourCerveau`) : inventaire (total annoncé/enregistré/capacités UCE, par statut), défaillantes (état, échecs consécutifs, taux mesuré), performances (p95 mesuré), échecs (catégories du debugger, incidents ouverts), recommandations (masquées si secret), besoins non satisfaits remontés par événements (`besoin-capacite`), objectifs explicites.

**Produit** (synthèse déterministe, testée) : défaillante critique (≥5 échecs consécutifs) → `replace` ; défaillante modérée → `improve` ; p95 > 15 s avec fiabilité ≥ 90 % → `improve` ; besoin non satisfait → `discover` ; incidents ouverts → `monitor` ; objectif posé → `evaluate`. Tout besoin contenant un secret est refusé fail-closed (`refuserSiSecret`). Un document externe malveillant reste une DONNÉE : il ne peut produire qu'une action bornée (discover), jamais une action d'autorité (testé — scénario G).

## 4. Responsabilités (mission)

- **Cerveau** : identifier les insuffisances, prioriser (priorite basse→critique), définir les objectifs, choisir l'opération, autoriser selon le risque (via la politique d'autonomie), examiner les résultats (statuts + monitoring), conserver/rejeter une amélioration (rejet audité, jamais effacé).
- **Workers** : exécuter, retourner des résultats, rapporter les erreurs, mesurer — rien d'autre.

## 5. Preuves

- `autonomie.test.ts` : synthèse couvrant les 7 entrées mission, décisions persistées et auditées, rejet tracé, secrets refusés, contenu malveillant sans pouvoir (22 tests verts).
- Scénario A/G (`scripts/uce-scenarios-v11.mts`) : décision réelle `dec_*` produite depuis une insuffisance mesurée ; document malveillant sans action d'autorité — preuves dans `docs/rapports/mesures/uce-v11-scenarios.json`.
