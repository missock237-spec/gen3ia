# GEN3IA COMPUTE FINAL ARCHITECTURE — consolidation (mission WEBGPU, Phase 1 finale)

**Date** : 2026-11-25 · **Base** : `main` `575dad3` (audit Phase 1 `1881fd9` + gestionnaire Phase 2) · Méthode : lecture du code, aucun moteur supprimé, aucun doublon inventé.

## 1. Cartographie complète des composants (rôles, aucun supprimé)

| Composant | Rôle exact | Statut intégration |
|---|---|---|
| `lib/neural/core/` (central-core, network, resonant-space, auto-oscillation) | cerveau neuronal Gen3 — déterministe, pur | cerveau |
| `lib/neural/engine.ts` (853 l.) | MoteurNeuralGen3 : cycles, injection, coucheRPIA optionnelle | cerveau |
| `lib/neural/runtime.ts` (821 l., **server-only**) | assemblage production : NoyauCentral + NeuralEngine + effecteurs (audio/visuel/vidéo/voix/media-bridge) | cerveau — **ne connaît pas encore compute/** |
| `lib/ondes/champ.ts` + `moteur-webgpu.ts` + `shader.ts` | champ d'ondes : miroir CPU exact ↔ compute WGSL (d'Alembert+Kuramoto) | moteur GPU/CPU autonome |
| `lib/ondes/moteur.ts` | fabrique `creerMoteur`/`reconfigurerMoteur` — **sélectionne elle-même** son matériel (`webgpuDisponible()`) | sélecteur concurrent n°1 |
| `lib/ondes/compilateur-hardware.ts` | sonde adaptateur réelle + classement famille/tier + WGSL spécialisé (cache) | sonde GPU du domaine ondes — à réutiliser |
| `lib/ondes/moteurs-webgpu.ts` (906 l.) | RPIA vidéo/audio : miroirs CPU + WebGPU + fabriques `creerMoteurVideoRPIA`/`creerMoteurAudioRPIA` — **sélectionnent elles-mêmes** | sélecteurs concurrents n°2-3 |
| `lib/ondes/entraineur-webgpu.ts` + `entrainement-rpia.ts` | entraînement RPIA GPU/CPU | moteur autonome |
| `lib/ondes/shaders-rpia.ts` | WGSL rasterisation vidéo (2 passes déterministes) + mix audio | shaders RPIA |
| `lib/neural/webgpu/detect.ts` | sonde navigateur honnête (`détecterWebGpu`, cache module) | **détecteur concurrent n°4** (doublon avec compute/hardware-detector) |
| `lib/neural/webgpu/image-engine / video-engine / voice-engine / manifest` | génération média sur le GPU utilisateur (SD fp16) | moteur média navigateur |
| `components/chat/use-webgpu-media.ts` (267 l.) | cascade navigateur : essaim → GPU local → repli serveur, jamais de faux succès | client média — **décide de son GPU via detect.ts** |
| `lib/neural/compute/` (7 modules + tests) | ComputeManager central : détection honnête, politique anti-« dispo donc GPU », fallback CPU systématique, métriques p50/p95 | **point central** (cette mission) |

## 2. Points d'entrée CPU et GPU (tous documentés)

- **CPU pur** : réseau neuronal + effecteurs + miroirs champ/RPIA + conditionnement texte→onde + RAG onde.
- **GPU réel** : MoteurWebGPU (ondes), MoteurVideo/AudioWebGPU (RPIA), EntraineurRPIA, moteurs média navigateur, pont média auto-hébergé (serveur, MEDIA_BRIDGE_URL).
- **Sélections matérielles** : 5 sites indépendants (fabriques ondes ×2, detect.ts, hook média, fabrique moteur) — **à unifier** : chaque site devient CLIENT du ComputeManager via des adaptateurs qui conservent les contrats existants (aucune API cassée).

## 3. Fonctions dupliquées (à éliminer progressivement)

1. **Sonde GPU ×3** : `webgpuDisponible()` (moteur.ts), `détecterWebGpu()` (detect.ts), `detecterCapacites()` (compute/) → compute/hardware-detector devient la sonde UNIQUE ; les deux autres deviennent des délégations.
2. **Politique locale** : les fabriques choisissent « dispo → GPU » sans coût de transfert ni taille de tâche → la politique centrale (compute-policy) prend le relais ; les fabriques gardent le shader spécialisé et le device du domaine.
3. **Métriques** : aucune commune avant `compute/` (compteurs dispersés : pasTotaux, essaim) → RegistreMetrics central.

## 4. Dépendances (aucune circulaire — sens unique)

```
components (chat/média) ──→ lib/neural/webgpu/* ──┐
lib/ondes/* (mot+compilateur+tests) ──────────────┤
                                                  ├──→ lib/neural/compute/ (détecteur/policy/fallback/metrics)
lib/neural/core|engine (pur) ─────────────────────┤         (aucune dépendance retour : sens unique)
runtime.ts (server-only) ─────────────────────────┘
```

compute/ n'importe rien des ondes ni du cerveau (vérifié) → pas de cycle. Les adaptateurs d'intégration (Phase 5) importeront compute/ DEPUIS les moteurs, jamais l'inverse.

## 5. Architecture cible du LOT 1→5

```
CERVEAU (runtime.ts / engine.ts / central-core.ts)
        → TASK ANALYZER (famille, taille, mémoire)
        → RESOURCE ESTIMATOR (coûts CPU/GPU estimés)
        → ComputeManager (profil énergétique, init GPU unique)
        → ComputeRouter (CPU | GPU | HYBRIDE-RÉEL partitionné)
        → moteurs EXISTANTS (ondes champ/RPIA, média navigateur, ONNX si runtime)
        → RESULT VALIDATOR (tolérance définie) → ComputeMetrics → retour cerveau
        → dashboard admin (observation, jamais décision)
```

## 6. Ce qui est déjà livré vs ce qui reste (honnêteté des phases)

| Livré et testé | Livré, tests à exécuter | Reste à construire |
|---|---|---|
| audit (ce doc + GEN3IA_WEBGPU_AUDIT.md), compute/ 7 modules | 18 tests compute (node_modules restauré dans ce tour) | webgpu/ unifié (device réel requestAdapter+requestDevice, pertes), router, hybride RÉEL, intégration cerveau, ONNX honnête, suite 20 tests, circuit breaker, API+dashboard, validation production |
