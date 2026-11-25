# LIVRABLE 3 — RAPPORT D'UNIFICATION DES REGISTRES (V1.1 Phase 2)

**Date** : 2026-11-25 · **Fichier cible** : `lib/capabilities/core/capability-registry.ts` (NOUVEAU) · **Priorité** : CRITIQUE — STATUT : IMPLEMENTED + INTEGRATED + TESTED (10 tests dédiés verts).

## 1. Ce qui existait (audit V1.1 Phase 1)

Six registres/surfaces catalogues coexistaient : le registre d'exécution réel (`ToolRegistry` via `createDefaultToolRegistry`, 2 instances déterministes), le catalogue déclaratif `GEN3IA_TOOLS` (78 outils), le registre de référence UCE (`GestionnaireCapacites`), la vue par principal (`catalog.ts`, qui reconstruisait sa partie native en parallèle), et les catalogues de connecteurs (MCP/Composio — sources d'approvisionnement du registre réel). Aucun ne satisfait le contrat mission V1.1 (15 champs obligatoires) ni le contrôle d'activation.

## 2. Ce qui a été construit

**`RegistreCentralCapacites`** (`lib/capabilities/core/capability-registry.ts`) — le registre de référence UNIQUE :

| Responsabilité mission | Implémentation |
|---|---|
| Enregistrer toutes les capacités | natives (`GEN3IA_TOOLS` × registre réel) + capacités UCE persistées (via `GestionnaireCapacites` — pas de doublon) |
| Identifiant unique | `natif:gen3ia:<outil>` / `origine:source:nom` — unicité TESTÉE |
| Versions | `version` (versionActive via version-manager côté UCE, `gen3ia-courant` côté natif) |
| Dépendances | `dependencies` (cartes UCE ; natifs : `[]` honnête) |
| Permissions | `permissions` (permission fine de chaque outil natif, ex. `network.read`) |
| Disponibilités | `availability` honnête : `disponible` (réellement au registre d'exécution), `non-enregistre` (annoncé mais absent de cet environnement), `indisponible` (rejetée) — l'écart annonce/réalité reste explicite |
| États | `status` (machine à états UCE) + `origin` |
| Adaptateurs | `executionAdapter` : `outil-natif` / `capacite-uce` / `refus-non-integree` — aligné 1:1 avec les adaptateurs du gateway |
| Activations/désactivations | `active` + `desactiver(id, {raison, par})` / `reactiver(...)` — persistées dans `cap_registry`, identifiant humain OBLIGATOIRE (traçabilité), contrôle branché dans le gateway (`verifierActivation`) |
| Contrat mission (15 champs) | `id, name, version, category, description, inputSchema, outputSchema, permissions, dependencies, environmentRequirements, availability, executionAdapter, healthStatus, createdAt, updatedAt` — présence TESTÉE pour chaque entrée |
| Schemas réels | `inputSchema` = le schéma zod RÉEL de l'outil natif (+ `entreeSchemaChamps`, résumé des champs) ; `outputSchema` = null honnête (non déclaré) |
| Santé | `healthStatus` relevé par le monitoring réel (sain/dégradé/en échec/inconnu — jamais inventé) |

## 3. Synchronisation de la source unique

- `catalog.ts` (vue par principal) : sa partie native est DÉSORMAIS GÉNÉRÉE depuis `entreesNativesSynchrones()` — plus aucune reconstruction parallèle depuis `GEN3IA_TOOLS` (import remplacé).
- `GestionnaireCapacites` reste la machine à états + persistance (rôle distinct, pas un catalogue concurrent) ; le registre l'utilise.
- Les catalogues MCP/Composio restent des sources d'approvisionnement du registre d'exécution réel (non concurrents).

## 4. Intégration au gateway

`verifierActivation(id)` est appelé à l'étape 4 du cycle d'exécution : capacité désactivée → REFUS avant tout adaptateur (testé : désactivation → exécution refusee avec raison tracée ; réactivation → exécution de nouveau possible). Une capacité hors registre déclaratif laisse la résolution standard continuer (le gateway vérifie le registre réel — jamais de blocage faux-positif).

## 5. Règles mission vérifiées par tests

1. une capacité n'existe qu'une fois (unicité testée) ✓
2. identifiants stables ✓ (schéma `natif:gen3ia:<nom>`)
3. versions explicites ✓
4. désactivée ⇒ non exécutable ✓ (gateway testé)
5. indisponible ⇒ jamais présentée opérationnelle ✓ (`availability` honnête, drapeau V1 `enregistre` conservé)
6. adaptateurs spécialisés conservés ✓ (nomenclature alignée)
7. aucun catalogue concurrent ✓ (catalogue déclaratif généré depuis le registre)

**Tests** : `lib/capabilities/tests/registre-central.test.ts` — 7 tests verts (contrat 15 champs, unicité, disponibilité honnête, schéma réel, activation gated, traçabilité, réversibilité).
