# LIVRABLE 11 — RAPPORT DE STABILITÉ UCE V1.1

**Date** : 2026-11-25 · **Statut** : stabilité TESTÉE dans l'environnement de développement (reprise, idempotence, verrous, retries, annulation, fail-soft) ; **endurance 72 h NON EXECUTÉE** (voir limites).

## 1. Garanties de stabilité du cycle d'évolution (mission Phase 7 — toutes testées)

| Garantie | Implémentation | Test/preuve |
|---|---|---|
| Reprise après redémarrage | état persisté à CHAQUE transition (repository Firestore + journal local) ; `reprendreCyclesInterrompus()` | test autonomie (reprise §F) + scénario F réel (état restauré, historique conservé, trace de reprise) |
| Protection contre les doubles exécutions | verrou `cap_locks` (TTL 5 min, propriétaire) + idempotence par clé de besoin | tests dédiés verts ; scénario F (refus tracé « verrou détenu ») |
| Idempotence | clé sha256 du besoin — un cycle actif sur le même besoin est retourné, jamais dupliqué | test dédié vert |
| Timeout | 15 min par défaut par cycle ; échec `failed` avec cause persistée | codé + échec honnête observé (cycle hermétique) |
| Retries limités | max 2 tentatives ; au-delà → refus honnête « limite de tentatives atteinte » | test dédié vert |
| Gestion des erreurs | aucune étape ne lève : tout échec devient un état + cause persistés (également dans le moteur 14 étapes V1) | tests verts |
| Annulation | `annuler(cycleId, {raison, par})` — identifiant humain requis | test dédié vert |
| Historique complet | chaque transition datée (de → vers + détails bornés), ≥ 60 entrées conservées | test (historique relu depuis la persistance) |
| Sauvegarde de l'état | persistance Firestore/journal local versionné — aucune variable mémoire seule pour les cycles importants | conception + tests de relecture depuis le repository |
| Échec honnête du moteur | absence de candidat/benchmark → `failed` avec cause citée (jamais de succès inventé) | test « cycle hermétique » |

## 2. Stabilité du chemin d'exécution unifié

- La refactorisation vers le pont legacy a été conduite avec **parité vérifiée par tests** (mêmes refus, mêmes messages en environnement sain, même sortie sur chemin délégué) et **garde anti-contournement** pour empêcher toute régression future.
- Aucune régression observée sur les suites UCE (81 verts) ; le suite complète du dépôt : cf. livrable 8.
- Le gateway est fail-soft : persistance d'enregistrement échouée = non fatale (journalisée), vérification indépendante toujours tentée, réponse toujours structurée.

## 3. Surveillance disponible (dashboards et monitoring)

- Monitoring UCE V1 conservé : santé par capacité (échecs consécutifs), performance p95 mesurée, ressources avec limites, analyse d'échecs catégorisée, incidents anti-doublon.
- V1.1 ajoute : cycles (en cours/terminés/échoués), décisions du cerveau, plans, insuffisances, tentatives bloquées — tous mesurés (dashboard `/admin/capabilities`).

## 4. Endurance 72 h — NON EXECUTÉE (BLOCKED, environnement)

Le test d'endurance de 72 heures exige un environnement de production stable et persistant (VPS du projet) ; il n'est **pas exécutable** dans ce sandbox de développement (processus non persistant, VPS documenté injoignable pendant la période récente — cf. livrables 12 et 14). Aucun statut d'endurance n'est revendiqué. Les mécanismes requis par l'endurance (reprise, idempotence, verrous, bornes de ressources, journaux persistés) sont implémentés et testés unitairement ; le test continu reste à mener sur l'infrastructure du projet.

## 5. Fuites mémoire et ressources

- Mesure réelle à chaque exécution gateway (mémoire heap delta + durée) persistée dans `usage` et `cap_resources` ; limites mission appliquées (budget sortie, deadline ≤ 600 s, sandbox heap borné).
- Le monitoring de ressources (`resource-monitor`) signale les dépassements (testé V1).
- Aucune fuite détectée pendant les suites (workers isolés vitest) — une observation longue durée reste nécessaire sur le VPS (endurance).
