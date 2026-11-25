# LIVRABLE 7 — DOCUMENTATION DES POLITIQUES D'AUTORISATION (V1.1 Phase 8)

**Date** : 2026-11-25 · **Fichier** : `autonomy/autonomy-policy-engine.ts` (NOUVEAU) · **Statut** : IMPLEMENTED + INTEGRATED + TESTED (7 tests dédiés + usage réelle dans les décisions/plans/cycle).

## 1. Les cinq niveaux progressifs (mission, mot pour mot)

| Niveau | Nom | Capacités | Interdits |
|---|---|---|---|
| 1 | **Observation** | analyser, détecter les problèmes | toute modification |
| 2 | **Recherche** | chercher des solutions, recommander | toute intégration |
| 3 | **Expérimentation** | installer/tester en **sandbox isolée** | toute modification de production |
| 4 | **Intégration contrôlée** | préparer et proposer une intégration | opérations sensibles SANS autorisation |
| 5 | **Optimisation encadrée** | déployer automatiquement des modifications **à faible risque** uniquement si couvertes par une **politique préalablement approuvée**, avec tests, surveillance et rollback | tout le reste |

## 2. Évaluation d'une action (`evaluerAction`)

Ordre de décision (aucune zone grise) :
1. **Opérations TOUJOURS soumises à autorisation** (mission — quel que soit le niveau) : dépenses payantes, accès aux comptes externes, utilisation de secrets, publication publique, suppression de données, modification des permissions (cible sécurité), modification du cerveau central, modification des politiques de sécurité, déploiement de changements critiques → `approbationRequise = true` TOUJOURS.
2. **Niveau minimal par action** : monitor/evaluate ≥ 1, discover ≥ 2, build/improve ≥ 3, replace/disable ≥ 4 — en dessous : REFUS net (raison honnête citant le niveau requis).
3. **Actions sensibles par nature** : `disable`/`replace` → approbation humaine TOUJOURS.
4. **Niveau 5** : déploiement automatique UNIQUEMENT si `risqueFaible` ET `politiqueApprouvee` ; sinon approbation.
5. Actions de lecture/propose → autorisées sans approbation.

## 3. Le système ne modifie JAMAIS ses propres règles

`definirNiveauAutonomie(niveau, {par, raison})` : identifiant humain OBLIGATOIRE (≥ 4 caractères, refus testé d'une auto-élévation), raison obligatoire, changement persisté (`cap_registry`) + **trace d'audit datée** par changement (jamais écrasée). Aucun worker/aucune décision automatique n'appelle cette fonction : le niveau ne change que par la commande admin `niveau-autonomie` (identifiant humain) ou la variable d'environnement `AUTO_CAPABILITIES_LEVEL` (défaut 1 — le plus sûr). La désactivation de capacités est soumise à la même règle (identifiant humain, raison, trace).

## 4. Branchement réel

- **Décisions du cerveau** (`capability-decision.ts`) : chaque décision porte le verdict calculé ; une décision refusée par la politique ne peut pas être planifiée (le cycle échoue honnêtement avec la raison).
- **Plans** (`capability-improvement-planner.ts`) : chaque plan porte son verdict ; le choix d'un plan non autorisé est refusé.
- **Cycle persistant** : le gate `awaiting_approval` s'ajoute à la politique (double protection).
- **Gateway** : arrêt d'urgence → politique d'exécution → consentements (couches existantes, inchangées) AVANT tout adaptateur — la politique d'autonomie s'ajoute AU-DESSUS, elle ne remplace rien et ne contourne rien.

## 5. Historique et dashboard

`historiquePolitique()` retourne les traces datées de tous les changements. Le dashboard `/admin/capabilities` affiche le niveau courant (+ poseur) et expose le changement de niveau (boutons 1-5, identifiant humain exigé).

**Tests** : niveau 1 refuse la découverte ; opérations sensibles gated au niveau 5 ; niveau 5 = faible risque + politique pré-approuvée uniquement ; anti-auto-élévation ; descriptions honnêtes des 5 niveaux (7 tests verts).
