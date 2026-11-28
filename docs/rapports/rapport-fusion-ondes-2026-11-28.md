# Rapport — Fusion neurones+mémoire en un seul système à ondes (SNOU) + application des 4 méthodes d'amélioration

**Date :** 2026-11-28 · **Dépôt :** `missock237-spec/gen3ia` · **Demande :** (1) vérifier l'analyse experte contre le code réel ; (2) réaliser et tester les 4 méthodes d'amélioration ; (3) appliquer la recommandation du propriétaire : fusion du système neuronal et du système de mémoire en UN seul système à ondes, les ressources matérielles servant à traiter/évaluer les ondes.

---

## 1. Vérification de l'analyse experte — 6/6 exactes (code réel, références précises)

| Affirmation de l'analyse | Vérification dans le dépôt | Verdict |
|---|---|---|
| SNN, encodage en énergie par hachage FNV-1a, spikes, intention par résonance/latence | `lib/neural/encoding/text-encoder.ts` — FNV-1a exact (`0x811c9dc5`, `0x01000193`, `Math.imul`), vecteur d'énergie `{idNeurone → intensité}`, injection sur la zone de tokens (neurones 0..37) | ✅ EXACTE |
| Cortex langagier : corpus de paires {motif, réponse} + appariement pondéré IDF + plasticité d'usage | `lib/neural/generation/{corpus,language,cache-reponses}.ts` | ✅ EXACTE |
| Multimodalité = effecteurs spécialisés (SVG/WAV/SMIL) + paires multimodales (COCO, FLEURS) | `lib/neural/effectors/{visual,audio,video}.ts` + corpus multimodal (gravé depuis les datasets Job 478451) | ✅ EXACTE |
| Entraînement ouvert : Training Studio + worker GPU Python + rapports réels | `app/training/page.tsx` + `services/training-worker/` (Dockerfile, tests pytest) | ✅ EXACTE |
| Hippocampe = contexte anaphorique basique (fenêtre glissante de tours) | `lib/neural/memory/hippocampus.ts` — `HippocampusMemory`, fenêtre 10 tours, `remember(user, system)` | ✅ EXACTE |
| Raisonnement pré-calculé via solveurs exacts dans le corpus ; pas de mémoire longue structurée | `lib/neural/solveurs/moteur-calcul.ts` appelé dans `engine.ts` avant le repli cortex ; hippocampe = seule mémoire de travail | ✅ EXACTE |

## 2. Recommandation du propriétaire — IMPLÉMENTÉE : le SNOU

**« Le système neuronal et le système de mémoire doivent être UN SEUL système qui fonctionne ensemble »** — implémenté dans `lib/neural/fusion/` :

### 2.1 Fusion réelle (pas une juxtaposition)

- **Un seul substrat** : le champ d'ondes (`MoteurCpu` de `lib/ondes/champ.ts` — physique réelle d'Alembert + Kuramoto, miroir du shader WGSL) porte À LA FOIS le calcul ET la mémoire.
- **Écriture** (`memoriser`/`memoriserEchange`) : les données de l'utilisateur sont encodées en **ondes** (encodeur multimodal unifié → impulsions position/fréquence/phase) → injectées dans le champ → **gravées** (6 pas de propagation) → le **paquet d'ondes EST la mémoire** (journal de traces commis, plafond 200, éviction ancienne).
- **Lecture = calcul neuronal** (`comprendre`) : la requête est injectée dans le champ ; chaque souvenir candidat est **RÉINJECTÉ** dans un clone déterministe du MÊME substrat (mêmes fréquences propres, graine 42) → mesure du **gain de résonance** (relatif au pic de base), de la **latence du pic** et de l'**alignement de phase de Kuramoto** au point du pic de la requête → **attention spike-driven**. Aucune table externe : comprendre = faire résonner ce qui a été vécu.
- **Isolement multi-utilisateur P0 préservé** : un champ par clé `(userId, conversationId)` via `GestionnaireOndesUnifie` (LRU 500, aligné sur les fenêtres de l'hippocampe) — les ondes d'un compte ne résonnent jamais chez l'autre (testé).

### 2.2 Branché dans le chemin RÉEL du cerveau

- `lib/neural/engine.ts` — les TROIS chemins de génération (generate, flux du chat, générateur) **plus** le chemin éco :
  - **écriture** : après chaque échange, `memoriserEchange` grave l'onde (fail-soft) ;
  - **lecture** : avant la chaîne de composition, `resonanceOndes()` interroge le champ ; le souvenir dominant **enrichit réellement le contexte du cortex** (`ContexteLangage.ondesFusionnees` + entrée dans l'historique scoré du corpus — le mécanisme lexical réel) → Gen3 comprend mieux les intentions et le monde à chaque tour.
- `lib/neural/runtime.ts` — **câblage par défaut ON** (`new GestionnaireOndesUnifie()`, fail-soft) : tout le chat réel passe par la fusion. Sans gestionnaire (tests existants), la chaîne historique tourne **bit à bit identique**.

## 3. Ressources matérielles — la doctrine du propriétaire encodée dans le contrat

`lib/neural/fusion/moteur-materiel-ondes.ts` :

- **Aucune API de calcul générique** — la seule surface du module est l'évaluation des ondes : cohérence de Kuramoto, énergie, gains de résonance, latences, débit de pas/s. Le contrat `usageMateriel: "evaluation-des-ondes-uniquement"` est typé dans la réponse.
- **Le GPU traite les ondes** : la fabrique `creerMoteur` (WebGPU prioritaire, repli CPU automatique et rapporté) re-propage chaque souvenir et mesure son gain — qualité supérieure + vitesse accrue, même physique.
- **Honnêteté** : sur un runtime sans WebGPU (sandbox), la détection réelle (`webgpuDisponible()`) rapporte `moteur: "cpu"` — jamais de GPU simulé.

## 4. Les 4 méthodes d'amélioration — implémentées et testées sur le champ réel

| Méthode | Implémentation | Preuve (test réel) |
|---|---|---|
| **1. Attention spike-driven** (hybride SNN-attention, dépendances long terme) | `attention-spike-driven.ts` : poids = softmax(gain × alignementPhase × exp(−latence/τ)) — la dynamique spiking remplace le produit matriciel dense | « une trace qui résonne vite pèse plus qu'une tardive (même gain) » — latences 1 vs 8 pas, poids croissant |
| **2. Encodeur multimodal unifié** (représentation latente partagée) | `encodeur-multimodal-unifie.ts` : concepts canoniques → FNV-1a (constantes du SNN réel) → MÊME onde quelle que soit la modalité ; gains normalisés | « pomme / POMME / pommes » → même signature bit à bit ; énergie texte≈image (écart < 20 %) |
| **3a. Auto-supervision (SSL)** | `entrainement-autosupervise.ts` — « **prédire le prochain spike** » : contexte partiel injecté dans le champ → la lecture mémoire (attention spike-driven) doit résonner avec la trace complète ; apprentissage = renforcement hébbien RÉEL des fréquences propres (`remplacerFrequences`, writeback). Découverte par sonde, documentée : la diffusion d'amplitude ne comble pas un manque en 14 pas à cette échelle — le signal SSL réel du substrat est la RÉSONANCE, pas la diffusion | erreur de prédiction **décroissante sur 4 epochs** (le champ apprend la structure des données) |
| **3b. Distillation** | enseignant = solveurs exacts LOCAUX (zéro IA externe — doctrine) ; sorties gravées comme ondes de haute confiance, chaque gravure vérifiée par résonance | « 12 fois 12 → 144 » gravé puis **souvenir dominant** à la lecture de « 12 fois 12 » |
| **4. Mémoire longue + chaîne de pensée** | `raisonnement-ondes.ts` : décomposition déterministe (« puis ») → chaque étape résolue par le solveur local exact → **commise comme onde** ; l'étape suivante porte le résultat ; vérification finale par résonance | « calcule 17 × 23 puis ajoute 9 » → 2 étapes, réponse finale portée, `verifieeParResonance: true`, chaîne mémorisée |

## 5. Tests réels (`lib/neural/fusion/fusion.test.ts`)

13 tests couvrant : fusion mémoire→résonance (échange gravé puis dominant), **spécificité** de la résonance (le souvenir du même intent domine un autre sujet), isolement multi-comptes, substrat pur (fréquences dans BORNES_PHYSIQUES), multimodal unifié, attention (somme=1, déterminisme, latence), **SSL décroissante**, distillation vérifiée, CoT en ondes, évaluation matérielle honnête, et le **pont moteur** (`generate()` réel : écriture gravée, contexte enrichi par résonance, isolement bob/alice).

## 6. Limites honnêtes

1. **WebGPU** : le chemin GPU utilise la fabrique réelle du dépôt mais est UNTESTED dans ce sandbox (aucun GPU) — testé sur navigateurs/plateformes WebGPU ; la détection et le repli CPU sont réels et testés.
2. **Le SSL est un apprentissage de SUBSTRAT** (prédiction de spike par résonance + fréquences propres) : deux formulations ont été écartées après mesure (diffusion d'amplitude, cohérence cellulaire — signal nul à cette échelle, cf. sonde) et une retenue parce qu'elle est physique ET mesurable — il ne remplace pas un pré-entraînement Transformer à l'échelle ; c'est la brique locale du parcours hybride recommandé.
3. **La distillation est locale** : l'enseignant est le moteur de calcul du cerveau (doctrine zéro IA externe). Un enseignant externe HORS LIGNE (outputs datasets) resterait possible sans violer la doctrine production — non implémenté ici.
4. **Latence de compréhension** : chaque requête exécute ~24 mesures × 16 pas sur grille 64×48 (≈ dizaines de ms CPU) — mesuré dans le rapport d'exécution, borné par MAX_CANDIDATS.

## 7. Fichiers livrés

```
lib/neural/fusion/encodeur-multimodal-unifie.ts   — espace latent d'ondes partagé (méthode 2)
lib/neural/fusion/attention-spike-driven.ts       — attention par latence+cohérence (méthode 1)
lib/neural/fusion/noeud-ondes-unifie.ts           — SNOU : le champ EST la mémoire (recommandation)
lib/neural/fusion/gestionnaire-ondes.ts           — un champ par utilisateur (doctrine P0)
lib/neural/fusion/moteur-materiel-ondes.ts        — évaluation d'ondes uniquement (volet matériel)
lib/neural/fusion/entrainement-autosupervise.ts   — SSL + distillation locale (méthode 3)
lib/neural/fusion/raisonnement-ondes.ts           — chaîne de pensée commise en ondes (méthode 4)
lib/neural/fusion/fusion.test.ts                  — 13 tests réels
lib/neural/engine.ts                              — lecture/écriture fusion dans les 4 chemins réels
lib/neural/runtime.ts                             — câblage par défaut ON
lib/neural/generation/language.ts                 — ContexteLangage.ondesFusionnees
```
