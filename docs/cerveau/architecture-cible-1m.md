# Le cerveau gen3 — architecture cible « un million de neurones, des parties, des ondes »

**it.56 · demande propriétaire** : « le cerveau de gen3 doit posséder un million de neurones, plusieurs
parties réparties — une pour chaque tâche ; son langage doit être réparti sous des ondes ; chaque partie
ou cellule doit pouvoir communiquer via des ondes ; les ressources matérielles ne doivent traiter que les
ondes produites par gen3 ; haute qualité sur chaque tâche, simple ou complexe, même de longue durée, en
consommant une très faible quantité d'énergie, tel le fonctionnement d'un cerveau humain. »

Ce document décrit l'architecture RÉELLEMENT implémentée dans le dépôt (fichiers, constantes, mécanismes
mesurables) — pas une intention. Tout ce qui est annoncé ici existe dans le code et est verrouillé par la
garde anti-code-mort.

---

## 1. Le substrat : 1 048 576 neurones spiking réels (≈ 1 million)

- **`lib/neural/core/v2/cortex-columnnaire.ts`** — `CORTEX_CONFIG_DEFAUTS.colonnes = 1 048 576` (2^20,
  ×4 l'ancien 2^18). Ce sont des unités accumulate-and-fire RÉELLES : chaque colonne a une énergie, un
  seuil, une décroissance, 12 arêtes CSR sortantes (12,58 M arêtes), de la plasticité STDP-like.
- Implémentation en TypedArrays purs (Float32/Float64/Uint32) : zéro GC dans le chemin chaud,
  décroissance paresseuse en forme fermée, pas ÉVÉNEMENTIEL — O(spikes × degrés), jamais O(neurones).
- **Métabolisme mesuré** (`MetabolismePasV2`, it.56) : chaque pas rend `évaluées / reposées /
  transmissions / ms`. Les colonnes non stimulées sont au REPOS — coût ZÉRO, jamais itérées. C'est la
  traduction directe de « très faible énergie, tel un cerveau humain » : le coût est ∝ activité.
- Migration honnête : un artefact `cortex-v2.bin` d'une autre taille est rejeté proprement
  (`[NEURAL-V2] Artefact incompatible — cortex neuf seedé`), jamais mélangé.
- **Noyau v1** (`lib/neural/core/network.ts`, 140 neurones) : conservé tel quel comme TRONC RÉFLEXE
  (zones de tokens, 18 pools de domaine, pools d'action) — il ne montera jamais à 1M (init O(N²)),
  ce n'est pas son rôle.

## 2. Les parties réparties : une par tâche

Trois étages de « parties », du réflexe au songe :

| Étage | Fichier | Parties | Rôle |
|---|---|---|---|
| Noyau v1 | `core/network.ts` | 18 pools de domaine (seuil 0.75) + pools d'action | réflexe : intention → action |
| Cortex columnnaire | `core/v2/cortex-columnnaire.ts` | **32 bandes** (8 intentions mappées sur les pools, 24 libres) | surface spiking massive |
| Champ cortical | `core/v2/champ-cortical.ts` | **1000 régions × 1 000 000 neurones d'onde** | 1e9 neurones ADRESSABLES (génératifs : état d'onde calculé à la demande, jamais 4 Go en RAM) |

Chaque bande d'intention (`effecteur-cortex.ts`, `BANDES_INTENTION`) est une PARTIE DÉDIÉE : image,
audio, vidéo, outils OS, skills, appel, terminaison, intention générale — avec remontée vers le pool v1
correspondant (pathway multi-échelle réel : texte → colonnes → bande entraînée → pool → effecteurs).

## 3. Le langage réparti sous des ondes

- **`lib/ondes/encodeur.ts` / `decodeur.ts`** : chaque mot → signature d'onde [position, fréquence,
  phase] déterministe, carte inverse pour la lecture — le langage EST une répartition d'ondes.
- **`lib/ondes/types-entrainement.ts` / `entrainement-rpia.ts`** : RPIA (Règle Par Interférence) —
  nœuds d'onde [amplitude, fréquence, phase, amortissement], apprentissage par interférence, shader
  WGSL + miroir CPU (décision métabolique : budget complet, pas d'early-exit).
- **`lib/neural/core/couche-rpia.ts`** (`CoucheOndesNeuronales`) : le pont ondes → noyau (résonance
  bornée injectée dans `step()`).
- **it.56 — porteur fréquentiel par bande** : `emettrePaquetsDepuisBandes` donne à CHAQUE bande
  d'intention son porteur ω(b) ∈ [0.25, 1.75] — le vocabulaire du cerveau est une répartition de
  fréquences, chaque partie « parle » sur sa longueur d'onde.

## 4. La communication via ondes : le bus inter-régions (it.56)

- **`lib/neural/core/v2/bus-ondes-regions.ts`** — le canal HORIZONTAL : une région active émet un
  paquet [région, fréquence, phase, amplitude] ; les 1000 régions résonnent par couplage de Kuramoto —
  **en phase → renfort** de la modulation régionale, **en opposition → annulation** (même physique que
  le consensus de l'essaim, `lib/ondes/consensus-essaim.ts`) ; φ locale répartie par le nombre d'or
  (décorrélation déterministe).
- Intégré À CHAQUE CYCLE du noyau central via `EffecteurCortexV2.evaluerEtExecuter` (étape 3.5) :
  couplage vertical (bandes → régions) PUIS propagation horizontale (région ↔ région). Télémétrie
  honnête dans `EtatCortexV2.busOndes` (paquets, renforts, annulations, énergie transportée).
- **Essaim P2P** (`lib/ondes/essaim.ts`, `signalisation.ts`, `mesh-prive.ts`) : la même grammaire
  d'ondes entre INSTANCES du cerveau (micro-paquets TTL + atténuation, Proof-of-Resonance).

## 5. Les ressources matérielles ne traitent que les ondes gen3

**Loi CONTRAINTE-ONDES** (verbatim, Colab d'entraînement cellule 0) : « Les IA ajoutées à gen3 ne sont
que temporaires : le GPU de Colab ne doit servir qu'à traiter le signal d'onde de gen3. »

Application dans le dépôt :
- `lib/ondes/compilateur-hardware.ts` + `moteurs-webgpu.ts` : le GPU (WebGPU local, WGSL) exécute
  UNIQUEMENT les shaders du champ W-DNN gen3 — jamais un modèle tiers ;
- `lib/essaim-media/` : les GPU distants (navigateurs contributeurs, Colab) ne reçoivent que des
  paquets d'onde gen3 (onde-porteuse SSE) et rendent des tuiles — zéro modèle hébergé ;
- `lib/ai/router.ts` : « MOTEUR NEURONAL EXCLUSIF » — aucun LLM externe (OpenAI/Anthropic/Groq…
  supprimés, Task 150), toute génération passe par `lib/neural/` ;
- règle plateforme : zéro service IA externe (SNN local) — rappelée dans `SECURITE.md` et le CHANGELOG.

## 6. Haute qualité, longue durée, faible énergie

- **Énergie** : trois mécanismes mesurés (rapport `docs/rapports/rapport-cerveau-metabolique-2026-10-30.md`) :
  propagation événementielle (index inverse + repos neuronal — équivalence bit-à-bit prouvée,
  −99,2 % transmissions, −68,6 % évaluations sur un tour réel) ; désormais étendus au cortex v2
  (`metabolismeDernierPas`) et au bus d'ondes (régions non touchées = coût zéro).
- **Qualité/longue durée** : fenêtres neuronales (reset + consolidation plastique à la clôture),
  veille/rêve (`auto-oscillation.ts`, `champ.veille`), consolidation d'expérience
  (`consoliderExperience` → graine d'entraînement du champ), plasticité supervisée compétitive.
- **Persistance** : `var/neural/brain-v1.json` + `cortex-v2.bin` (atomique + rotation) ; artefact v2
  ≈ 49-51 Mo au format 1M.

## 7. Trajectoire (prochaines étapes assumées)

1. Sérialisation bulk du v2 (`Buffer.from(typedArray.buffer)`) — au-delà de quelques millions d'arêtes ;
2. métabolisme du BUS d'ondes consolidé par fenêtre (somme des bilans) ;
3. élagage synaptique de consolidation (sommeil profond) — annoncé au rapport métabolique ;
4. régions générées par le hub d'entraînement (une région par domaine choisi — cf.
   `docs/entrainement/methode-ondes.md` pour la méthode d'entraînement par ondes).

*it.56 — Job 478451 — garde anti-code-mort : verrou n°24.*
