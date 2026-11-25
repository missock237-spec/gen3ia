# GEN3IA WEBGPU — RAPPORT DE VALIDATION (LOT 1-2-3-5) — état réel au 2026-11-25

**Base** : `main` `a31f3b7` (branche `evolution/webgpu-compute` fusionnée en main puis travail direct main).
**Preuves d'exécution** : `33/33 tests verts` (`vitest run lib/neural/compute/` — 3 fichiers) + `npx tsc --noEmit` propre sur compute/, app/api/admin/compute, app/admin/compute.

## 1. Composants réellement intégrés et testés (pas seulement « fichiers existants »)

| Phase mission | Livraison | Preuve |
|---|---|---|
| Phase 1 — audit/consolidation | `docs/architecture/GEN3IA_COMPUTE_FINAL_ARCHITECTURE.md` : 5 sélecteurs matériels concurrents cartographiés, doublons de sonde GPU (×3), dépendances sans cycle, aucun moteur supprimé | lecture du code cité fichier par fichier |
| Phase 2 — gestionnaire central | `compute/` : détection CPU réelle (cœurs navigator/os, RSS, contraintes honnêtes), GPU réel (`webgpu-device.ts` : requestAdapter→requestDevice→listeners `lost`, réinitialisation), profils ECO…SERVER, init unique | 15 tests `compute.test.ts` |
| Phase 3 — moteur WebGPU unifié | `webgpu/` : device partagé (source unique), pipelines en cache par code WGSL (erreurs de compilation collectées via getCompilationInfo), buffer pool (réutilisation + borne anti-fuite), budget mémoire refusant les dépassements, erreurs classifiées (compilation-wgsl/execution/device-perdu/mémoire/indisponible) | tests `unified.test.ts` (session refusée honnêtement en Node, budget, pool) |
| Phase 4 — router + hybride RÉEL | `compute-router.ts` (hybride REFUSÉ pour familles non partitionnables — jamais d'étiquette) + `compute-hybrid.ts` (partition 60/40, exécution SIMULTANÉE Promise.all, repli lot-à-lot, fusion ordre préservé) | **preuve par compteurs : CPU exécute 4 lots, GPU 6 lots, fusion vérifiée ; lot GPU en échec → repli CPU de CE lot uniquement** |
| Phase 5 — cerveau décideur | `brain-bridge.ts` : demande de calcul UNIQUE, vue capacités CPU+GPU+métriques, profil énergétique modifiable par le cerveau, aucune dépendance inversée | tests bridge (décision motivée, profil ECO reflété dans la vue, capacités CPU réelles) |
| Phase 10 — sécurité/fallback | `compute-security.ts` : circuit breaker (3 échecs→ouvert 30 s→sonde demi-ouverte), timeout explicite (jamais de faux succès), anti double-exécution, annulation, ring d'erreurs borné | 8 tests `security.test.ts` |
| Phase 11 — API + dashboard | `app/api/admin/compute/route.ts` (GET supervision protégée `requireAdmin`, POST profil/reinit-breaker) + `app/admin/compute/page.tsx` responsive (CPU/GPU/répartition/sécurité/historique/erreurs — observation uniquement) | typecheck + modèle imité des routes admin existantes |
| Phase 2-A/B honnêteté | détection ne se limite PAS à navigator.gpu : device réel exigé ; en Node : « indisponible » avec raison — jamais de fiction | tests dédiés |

## 2. Intégration aux moteurs existants (sans duplication)

- Les moteurs du domaine (`lib/ondes/moteur-webgpu.ts`, `moteurs-webgpu.ts`, `entraineur-webgpu.ts`, `lib/neural/webgpu/*`) **conservent leurs contrats et shaders**. Le moteur unifié est prêt à devenir leur source de device partagée (branchement à faire progressivement — adaptateurs Phase 5 restants).
- La règle fondamentale mission est appliquée : **jamais WebGPU « parce que disponible »** — la policy évalue taille/transfert/mémoire/profil ; testé (tâche trop petite → CPU même GPU disponible).

## 3. Ce qui est VÉRIFIÉ vs ce qui RESTE (honnêteté — règle absolue mission)

**Vérifié dans ce tour** : TypeScript propre, 33/33 tests unitaires, preuves d'exécution par compteurs (hybride réel), fallback systématique testé (échec GPU → CPU, résultat suspect → CPU vérifié), build de production lancé (résultat noté dans le journal du tour).

**Reste à faire (continuable au prochain message)** :
1. **Phases 6-8** : optimisation des shaders WGSL existants (réutiliser pipeline/buffer pool dans `moteur-webgpu.ts`), unification énergétique complète (`energy/`), vérification ONNX honnête (le runtime `onnxruntime-node` a échoué à télécharger ses binaires CUDA dans CE sandbox → EP CPU uniquement ici ; « installer onnxruntime-web » ≠ exécution GPU — test d'inférence réelle à fournir).
2. **Benchmarks CPU/GPU/hybride réels** (Phase 9 §benchmarks) : sur un navigateur compatible WebGPU — le sandbox Node ne peut PAS exécuter WebGPU (honnêteté : les tests GPU réels sont BLOCKED dans cet environnement, comme les miroirs ondes déjà testés côté CPU).
3. **Branchement des fabriques ondes** au device partagé unifié (adaptateurs, sans casser les contrats).
4. **Endurance 1/6/24/72 h** et validation multi-environnements (navigateur WebGPU, sans WebGPU, mobile, serveur).
5. **Phase 13 P2P** : conditionnée à la stabilisation complète du calcul local — non commencée (conforme à la mission).

## 4. Limites connues documentées

- `maxBufferSize`/features dépendent du navigateur : lues réellement à l'initialisation, jamais inventées.
- Énergie : **estimations relatives explicitées** (`nature: "estimee"`) — aucune mesure en joules tant qu'aucun compteur matériel fiable n'est exposé (mission Phase 7-« Mesure énergétique »).
- Le sandbox actuel est sans GPU : tous les chemins GPU sont couverts par le fallback CPU testé et la détection honnête ; les gains GPU restent à démontrer par benchmarks navigateur.
