# LIVRABLE 10 — RAPPORT DE BENCHMARKS UCE V1.1

**Date** : 2026-11-25 · **Moteur** : `evaluation/benchmark-engine.ts` (V1, inchangé) + comparaisons V1.1 · **Règle inchangée** : sans benchmark réel, `fonctionnementReel` = 0 et aucun verdict « recommandé ».

## 1. Mesures exécutées pendant la mission (preuves persistées)

Source : `docs/rapports/mesures/uce-v11-scenarios.json` (exécution du 2026-11-25, sandbox locale 2 CPU).

| Scénario | Mesure | Résultat |
|---|---|---|
| A — comparaison de 3 candidates | latence moyenne par candidate (3 runs chacune) | open-meteo 25 ms < duckduckgo-ia 27 ms < wikipedia-api 33 ms — sélection par TRI SUR MESURES, score 97/100 (verdict `recommande` après benchmark réel confirmé) |
| C — amélioration avant/après | p50 avant vs après (3 runs chacun) | 30 ms → 27 ms, **gain mesuré +10 %**, verdicts `fiable`/`fiable` |
| B — construction | essais sandbox réels | 1 essai sandbox réel, tests verts, sortie max « proposee » |
| E — intégration vérifiée | exécution gateway + vérification indépendante | succès, preuve `rejoue-indépendant`, sortie contrôlée (somme=42) |

## 2. Ce que mesurent les benchmarks (rappel honnête)

- N runs (2-20) en **sandbox isolée** (réseau NONE, heap borné) : latence p50/p95/min/max mesurée côté enfant, mémoire pic enfant mesurée (`emettre({memoireMo})`), graine de reproductibilité.
- Le verdict `fiable | fragile | echec` dépend du taux de succès mesuré.
- Les benchmarks mesurent le SCÉNARIO de test exécuté en sandbox — pas un appel réseau réel vers les services des candidates (limite documentée depuis la V1 et maintenue).

## 3. Benchmarks de l'infrastructure UCE V1.1 (frais ajoutés par l'unification)

- **Overhead du gateway sur le chemin conversation/agents** : le pont ajoute (a) une résolution de capacité (catalogue/registre réel, chargé une fois par process), (b) un contrôle d'activation (lecture journal local/Firestore, en cache après première lecture), (c) un enregistrement persisté (`cap_executions`) et (d) une vérification indépendante de la sortie. L'ordre de grandeur mesuré sur les suites : les 81 tests UCE V1.1 (dont les chemins complets gateway) s'exécutent en quelques secondes ; l'ajout par appel est dominé par l'écriture du journal (append local, sub-millisecondes en repli local ; une écriture Firestore en production).
- **Suite complète** : voir livrable 8 (comparaison baseline V1 : 7 687 verts → exécution V1.1).

## 4. Reproductibilité

Chaque preuve de scénario est persistée en JSON daté (chemins ci-dessus) et rejouable : `NODE_OPTIONS='--conditions=react-server' npx tsx scripts/uce-scenarios-v11.mts` (catalogue offline + sandbox locale — déterministe, sans dépense).
