# GEN3IA WEBGPU AUDIT — Phase 1 (audit et cartographie des calculs)

**Date** : 2026-11-25 · **Base** : `main` = `1369852` (après fusion UCE V1.1 + observabilité Job 478451) · **Méthode** : lecture réelle du code (aucun branchement supposé — chaque affirmation cite le fichier).

---

## 1. Écart de nomenclature mission → réalité du dépôt

| Chemin mission | Existe ? | Équivalent réel (code lu) |
|---|---|---|
| `lib/neural/brain/cerveau-ondulatoire.ts` | **NON** | le cerveau = `lib/neural/engine.ts` (MoteurNeuralGen3, 853 l.) + `lib/neural/core/central-core.ts` (NoyauCentralGen3, 224 l.) + `lib/neural/core/couche-rpia.ts` (CoucheOndesNeuronales — le pont cerveau↔ondes) |
| `lib/ondes/performance.ts` | **NON** | mesures réparties : `lib/ondes/compilateur-hardware.ts` (sonde matérielle), `lib/ondes/suite-validation.ts`, métriques temps réel (`MoteurWebGPU.pasTotaux`) |

Le reste de la liste mission existe exactement aux chemins donnés.

## 2. Tous les moteurs identifiés (code vérifié)

| Moteur | Fichier | Rôle | GPU/CPU |
|---|---|---|---|
| MoteurCpu (champ d'ondes) | `lib/ondes/champ.ts` | miroir CPU exact de la physique (d'Alembert + Kuramoto + gain) | CPU |
| MoteurWebGPU (champ) | `lib/ondes/moteur-webgpu.ts` (398 l.) | compute WGSL sur la grille : propagation, couplage, gain, impulsions ; triple bufferisation ; readback throttlé ; analyse CPU du champ (pics, r, énergie) | GPU |
| Fabrique `creerMoteur` / `reconfigurerMoteur` | `lib/ondes/moteur.ts` | bascule CPU↔GPU : `webgpuDisponible()` → WebGPU sinon CPU (+raison honnête) ; conservation des fréquences au changement d'effort | hybride |
| Swarm-Edge Hardware Compiler | `lib/ondes/compilateur-hardware.ts` (313 l.) | sonde adaptateur réel (vendor/architecture/limites), classe famille (apple-metal/vulkan/directx12/inconnu) + tier 1-3, compile un WGSL spécialisé (constantes foldées, workgroup calibré, cache par (GPU, effort)) | GPU |
| SHADER_ONDES | `lib/ondes/shader.ts` (95 l.) | compute WGSL standard, miroir exact de `champ.ts` | GPU |
| MoteurVideoCpu / MoteurAudioCpu | `lib/ondes/moteurs-webgpu.ts` (906 l.) | miroirs CPU testables (guidage RPIA, mix oscillateurs) | CPU |
| MoteurVideoWebGPU / MoteurAudioWebGPU | idem | dynamique des nœuds sur GPU : rasterisation 2 passes déterministes (atomicAdd entier), mix audio réel (corrections documentées vs sources) | GPU |
| Fabriques `creerMoteurVideoRPIA` / `creerMoteurAudioRPIA` | idem (l. 850/880) | WebGPU si dispo, sinon miroir CPU — même contrat, même physique | hybride |
| SHADERS_RPIA | `lib/ondes/shaders-rpia.ts` | rasterisation vidéo, finalisation, mix audio, rendu spatiotemporel, synthèse acoustique | GPU |
| EntraineurRPIA (GPU) | `lib/ondes/entraineur-webgpu.ts` (327 l.) + `entrainement-rpia.ts` | entraînement de la couche d'ondes | GPU/CPU |
| Moteurs média navigateur | `lib/neural/webgpu/` (861 l. : detect.ts, image-engine, video-engine, voice-engine, manifest) | génération média sur le GPU de l'utilisateur (SD fp16 ≈ 2 Go), sonde honnête `détecterWebGpu` (navigateur, adaptateur, mémoire, features), repli annoncé | GPU |
| Cerveau neuronal | `lib/neural/core/*` (central-core, network, resonant-space, auto-oscillation), `lib/neural/engine.ts` | réseau de neurones Gen3, cycles, plasticité — **PUR CPU, module sans dépendance Node** | CPU |

**Tests GPU/hybrides existants** : `lib/ondes/__tests__/` — champ.test, compilateur-hardware.test, moteurs-webgpu.test (miroirs CPU déterministes : « la vitesse change, pas le résultat »), + 15 autres suites ondes.

## 3. Chemins d'exécution documentés

```
Cerveau (engine.ts / central-core.ts) ── (coucheRPIA optionnelle) ── couche-rpia.ts
        │                                                        │
        │ entraînement RPIA                            entrainement-rpia.ts → EntraineurRPIA (GPU si dispo)
        │                                                        │
Chat/agents/média ──→ moteurs-webgpu.ts (fabriques vidéo/audio) ──→ WebGPU ou miroir CPU
Laboratoire ondes ──→ moteur.ts (creerMoteur) ──→ MoteurWebGPU (shader spécialisé) ou MoteurCpu
Média utilisateur ──→ lib/neural/webgpu/* (detect → image/video/voice engines)
```

**Déconnexions constatées (composants GPU non connectés au cerveau principal)** :
1. le champ d'ondes WebGPU n'est pas piloté par le cerveau : chaque fabrique décide LOCALEMENT par `webgpuDisponible()` (« dispo → utiliser ») — contredit la règle mission « jamais WebGPU uniquement parce qu'il est disponible » ;
2. aucun gestionnaire central de calcul (coût de transfert CPU/GPU, taille de tâche, énergie) ;
3. aucune métrique énergétique ni profil ECO/BALANCED/PERFORMANCE/MOBILE/SERVER ;
4. les moteurs média navigateur (`lib/neural/webgpu/`) et les moteurs RPIA n'ont ni router ni politique commune.

## 4. Classification des opérations (mission Phase 1 §4-5)

| Opération | Classification | Justification (code) |
|---|---|---|
| Propagation ondulatoire (grille dense) | **GPU** (déjà fait) | compute shader 2D, grille régulière, triple bufferisation — `moteur-webgpu.ts` |
| Calculs de fréquence/phase/amplitude | **GPU** (déjà fait) | buffers persistants read_write + readback throttlé |
| Rasterisation vidéo / mix audio RPIA | **GPU** (déjà fait) | 2 passes déterministes (`shaders-rpia.ts`) |
| Entraînement RPIA | **GPU** si dispo (déjà fait) | `entraineur-webgpu.ts` |
| Génération média (image/voix/vidéo SD) | **GPU navigateur** (déjà fait) | `lib/neural/webgpu/*` |
| Réseau neuronal Gen3 (steps, plasticité, injection) | **CPU** (reste) | graphe clairsemé + séquentiel + horloge virtuelle déterministe (`central-core.ts` « module PUR ») — parallélisation = régression déterminisme, hors P0 |
| Propagation ondulatoire à petite grille | **CPU** | coût transfert > calcul (règle mission Phase 2) |
| Encodage/conditionnement texte→onde | **CPU** (reste) | séquentiel, faible volume (`conditionneur.ts`) |
| Recherche associative / RAG onde | **CPU** (reste au P0/P1) | index clairsemé — étude GPU en P3 (`rag-onde.ts`) |
| Similarité de vecteurs en lot | **GPU hybride candidat (P1/P3)** | matvec/produit scalaire par lot — noyau générique à créer |
| Détection pics / analyse champ | **CPU** (reste) | post-readback, échantillonnage pair — déjà CPU |

## 5. Dépendances, shaders, fallback (état vérifié)

- **Fallback** : existant et honnête aux fabriques (`moteur.ts` : raison « Navigateur sans WebGPU — moteur CPU actif » ; `moteurs-webgpu.ts` : même contrat CPU/GPU) ; `detect.ts` : sonde honnête par raison. **Mais aucune politique centralisée ni mesure de fallback systématique.**
- **Types WebGPU** : `lib/ondes/webgpu.d.ts` + `@webgpu/types` (à confirmer au build) ; modules GPU « use client » ou garde `typeof navigator === "undefined"`.
- **Déterminisme** : garantie documentée (mirroirs CPU identiques, atomicAdd entier, garde-deterministe.ts, PoR) — à préserver dans tout nouveau kernel.

## 6. Conclusions → Phases 2-3

1. Créer `lib/neural/compute/` (détecteur + manager + router + policy + fallback + metrics + types) et rendre les fabriques existantes des CLIENTS du manager (pas de duplication — réutiliser `sonderMateriel`, `compilerWGSL`, les contrats CPU/GPU).
2. Créer `lib/neural/compute/webgpu/` (moteur unifié : device/shader/buffer/pipeline/kernel registries + erreurs + mémoire) — le moteur champ existant reste l'exécuteur du domaine ondes ; le moteur unifié porte les génériques (matvec, elementwise, réduction) et le cycle de vie.
3. Règle fondamentale mission : le router évalue (taille, coût transfert, mémoire, état matériel, énergie) AVANT de choisir GPU — jamais « dispo → GPU ».
