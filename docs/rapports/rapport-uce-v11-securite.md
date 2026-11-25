# LIVRABLE 9 — RAPPORT DE SÉCURITÉ UCE V1.1

**Date** : 2026-11-25 · **Périmètre** : Phases 1-13 V1.1 sur la branche `evolution/uce-v11` · **Statut global** : sécurité TESTED (tests automatiques verts) ; production VPS NON VÉRIFIÉE (cf. livrable 12).

## 1. Contrôles vérifiés (tous testés automatiquement)

| Contrôle mission | Implémentation | Preuve |
|---|---|---|
| Aucun worker ne peut devenir décideur | décision réservée au moteur du cerveau (`produitePar: "cerveau-central"`) ; workers = exécutants ; sortie builder max « proposee » | autonomie.test.ts (décisions + statuts) ; scénario B (statut final « proposee ») |
| Aucun outil ne peut modifier ses permissions | changement de niveau d'autonomie et désactivations gated par identifiant humain ≥ 4 caractères ; anti-auto-élévation testée | autonomie.test.ts (anti-auto-élévation) |
| Aucun contenu externe ne modifie les instructions centrales | découvertes/besoins/documents = DONNÉES ; `refuserSiSecret` fail-closed sur besoins/requêtes ; contenu malveillant → au plus une action `discover` bornée, JAMAIS disable/replace/improve | scénario G (20/20) ; autonomie.test.ts (secret fail-closed) |
| Opérations sensibles contrôlées | 9 catégories TOUJOURS gated (payant, comptes externes, secrets, publication, suppression, permissions, cerveau, politiques sécurité, changements critiques) — quel que soit le niveau | autonomie.test.ts (toujours gated) |
| Rollback fonctionnel | version défaillante non promue, stable conservée ; rollback tracé `cap_rollbacks` ; `annulerParRollback` au niveau cycle | scénario D (promotion REFUSÉE, v1 ACTIVE) ; suite V1 (rollback réel) |
| Secrets protégés | `refuserSiSecret` (motifs ghp_/hf_/KGAT_/sk-/xox-/PEM) sur besoins, requêtes admin, journaux ; masque systématique ; hook gitleaks au commit | scénario G (fail-closed) ; security.test.ts V1 |
| Un seul point d'entrée exécutable | garde automatique anti-contournement (scan du code source) ; 9 surfaces redressées vers le pont | gateway-monopole.test.ts (VERTE) |
| Capacité désactivée non exécutable | registre central `desactiver` (identifiant humain) → gateway REFUSE avant tout adaptateur | registre-central.test.ts (refus tracé) |
| Découverte ≠ autorisation | adaptateur `refus-non-integree` ; exécution d'une capacité découverte → refusee | scénario E/G ; execution.test.ts V1 |
| Sandbox obligatoire pour code non fiable | `executerEnSandboxUce` (réseau NONE, heap borné, timeout, répertoire détruit) ; builder 10 étapes testés en sandbox | scénario B (1 essai sandbox réel) ; suite V1 |
| SSRF | `assertPublicHttpUrl` (DNS résolu, IP privées/metadata bloquées) sur les vérifications API | conservé V1, suite security V1 verte |
| Permissions homogènes | les 4 chemins historiques convergent vers le même pipeline de couches (arrêt d'urgence → politique → consentements) + politiques par surface transmises | graphe des appels (livrable 2) ; parité gateway-monopole |

## 2. Résultats de tests de sécurité

- Suites UCE V1.1 : security.test.ts (6 tests) + autonomie.test.ts (22) + registre-central (7) + gateway-monopole (7) — **42 tests de sécurité/comportement verts** sur les 81 tests UCE V1.1.
- Suite complète du dépôt : voir livrable 8 (exécution du 2026-11-25).
- Gitleaks/hygiène : hook de commit actif ; aucun motif de secret réel dans les nouveaux fichiers (motifs de test = faux 32 caractères, comme à la V1).

## 3. Incidents et détections pendant la mission

- **0 incident de sécurité**. 1 correction préventive : le chemin direct historique (conversation/API) contournait l'enregistrement UCE — redressé vers le pont (Phase 3), garde automatique ajoutée.
- Les refus réels sont traçés : `cap_executions` (status `refusee` — compteur dashboard « tentatives bloquées »), incidents monitoring, historiques de désactivations et de niveau d'autonomie.

## 4. Limites de sécurité (honnêtes)

1. Les verrous de cycle sont best-effort (TTL 5 min) — le backend réel (Firestore `merge:true` / journal local « dernier gagne ») ne fournit pas de test-et-pose atomique ; l'idempotence par clé de besoin et les états persistés compensent (documenté livrable 6).
2. La garde anti-contournement est un test de code source (CI) : elle couvre le dépôt au moment de l'exécution CI, pas les exécutions dynamiques (`await import` construits) — les 3 modules dynamiques vers `executor` sont les adaptateurs internes autorisés.
3. Environnement de développement fail-closed (r2fs/R2 absent) : les contrôles réels en production (kill switch lisible) restent à revérifier au déploiement VPS (livrable 12).
