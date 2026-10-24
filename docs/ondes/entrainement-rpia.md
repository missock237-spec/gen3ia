# Entraînement par résonance (RPIA) — le mode d'apprentissage natif de gen3

> Le W-DNN (`lib/ondes/`) savait PROPAGER des ondes (inférence). Ce module
> lui ajoute sa facette manquante : APPRENDRE par résonance. Un réseau de
> nœuds d'onde `[amplitude, fréquence, phase, amortissement]` se corrige
> pas à pas jusqu'à résonner vers une onde cible — dérivée de la requête
> utilisateur (texte, image, son) sans aucune API externe.

## Principe physique (RPIA)

RPIA = Règle d'apprentissage Par Interférence. À chaque pas, l'onde
produite est comparée à la cible :

| Interférence                             | Correction RPIA                                                   |
| ---------------------------------------- | ----------------------------------------------------------------- |
| Constructive (`\|onde − cible\| < 0.05`) | phase renforcée (`+= lr·(1−cos φ)`), amortissement relâché         |
| Destructive                              | déphasage adaptatif (`−= lr·sin(interf)`), amortissement renforcé  |
| Les deux                                 | amplitude `−= lr·interf·0.1`, bornée `[0, 2]`                      |

Trois déclinaisons fidèles aux sources (WebGPU + miroir CPU exact) :

1. **Entraînement générique** (`waveTrainer.wgsl`) — `SHADER_ENTRAINEMENT_RPIA` ↔ `entrainement-rpia.ts` ;
2. **Synthèse acoustique** (`node.amplitude.pdf`) — oscillateurs audibles 20 – 20 000 Hz : la phase cale le timing, la fréquence épouse le timbre, l'amortissement évite la saturation ↔ `synthese-acoustique.ts` (+ encodeur WAV 16 bits réel) ;
3. **Rendu spatiotemporel** (`node.amplitude (1).pdf`) — nœuds 3D `(x, y, t)` : la persistance de phase lie les trames successives (fluidité vidéo), trames RGBA prêtes pour un encodeur ↔ `rendu-spatiotemporel.ts`.

## Le pont vers le système neuronal

`lib/neural/core/couche-rpia.ts` — **un nœud d'onde par neurone** du
cerveau (100 par défaut) :

```
texte ──conditionneur──► onde cible ──RPIA──► résonance apprise
                                                    │
                                    energiesResonance()  (bornées [0, 0.5])
                                                    ▼
                              reseau.step({idNeurone: énergie}, t)
```

- l'apprentissage par résonance façonne **l'entrée** du cerveau ; la
  plasticité synaptique (`network.ts`) façonne ses **connexions** — les
  deux mécanismes se complètent sans se substituer ;
- deux requêtes différentes produisent deux motifs d'énergie distincts :
  le cerveau « ressent » la différence avant même le décodage lexical ;
- l'homéostasie du noyau central (alerte au-delà de 0.75 de moyenne)
  n'est jamais déclenchée par la couche.

## Points d'entrée

| Besoin                                  | API                                                                        |
| --------------------------------------- | -------------------------------------------------------------------------- |
| Entraîner une requête côté serveur       | `POST /api/ondes/rpia` `{texte, nbNoeuds?, epoques?, tauxApprentissage?}`  |
| Entraîner côté navigateur (GPU si dispo) | `creerEntraineurRPIA(n)` → `{type: "webgpu" \| "cpu"}`                      |
| Onde cible depuis un texte / une image   | `encoderTexteEnOndeCible` / `encoderImageEnOndeCible`                       |
| Son réel jouable                         | `SynthetiseurAcoustique.genererBuffer` + `versWav`                          |
| Trames vidéo RGBA                        | `MoteurRenduSpatiotemporel.genererSequence`                                 |
| Diagnostic complet                       | `executerSuiteValidationGen3()` (3 familles de tests)                       |
| Pont cerveau                             | `entrainerCerveauParResonance(taille, texte)`                               |

## Interface utilisateur

Le laboratoire `/ondes` expose un **panneau d'entraînement RPIA** :
requête → courbe d'erreur réelle (convergence ou non, rien n'est
décoré), grille d'énergie des 100 neurones après apprentissage, écoute
de la synthèse acoustique (WAV), suite de validation en un clic.

## Limites honnêtes

- L'entraînement RPIA façonne la **résonance** du champ et l'énergie
  injectée au cerveau — il ne remplace pas les poids d'un grand modèle
  de langage ni un moteur de diffusion ;
- la convergence dépend de la règle source : lente avec `lr = 0.01`
  (≈ 200 époques pour un progrès net), la courbe d'erreur est toujours
  retournée telle quelle ;
- la dynamique acoustique/vidéo à temps avançant n'est pas monotone —
  les tests n'affirment que ce qui est mesuré (mouvement, bornes,
  continuité inter-trames), jamais une « qualité » non prouvée ;
- le serveur exécute le miroir CPU (déterministe, graine 42) —
  le WebGPU ne tourne que dans le navigateur de l'utilisateur.
