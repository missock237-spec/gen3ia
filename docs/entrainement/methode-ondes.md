# La méthode d'entraînement par ondes de gen3 (EOD — Entraînement par Ondes de Domaine)

**it.57 · demande propriétaire** : « créer un tout nouveau moyen d'entraînement de gen3, pour qu'il
puisse être entraîné selon les domaines que l'on choisira, basé sur l'analyse des ondes et le
traitement de ces ondes » — et « donner un fichier qui explique ce moyen d'entraînement ».

**Ce document EST ce fichier.** La méthode est implémentée, testée et verrouillée dans le dépôt :
`lib/neural/training/entrainement-ondes.ts` (+ tests unitaires), branchée sur la porte
`POST /api/neural/train` (source « ondes ») et documentée dans le code.

---

## 1. L'idée en une phrase

Au lieu d'apprendre à gen3 par des listes de mots-clés, on lui fait **entendre** chaque leçon : le
texte de l'exemple est converti en **signature d'ondes** (analyse), ces ondes **stimulent
physiquement** le cortex à un million de neurones (traitement), puis le domaine choisi est
**consolidé par résonance** — la « partie » du cerveau qui lui correspond grandit, à la manière d'une
trace sonore qui s'imprime dans la matière.

## 2. Les trois phases (toutes réelles, mesurées, déterministes)

### Phase 1 — ANALYSE DES ONDES (`analyserOndeTexte`)

Chaque token du texte devient un **paquet d'onde** `[fréquence, phase, amplitude]` :

| Paramètre | Comment il est calculé | Ce qu'il représente |
|---|---|---|
| **fréquence** ω | hash FNV-1a du token, mappé dans [0.25, 1.75] rad/cycle | la « note » du mot — son porteur dans le vocabulaire |
| **phase** φ₀ | hash × 2π, décalée par la position du mot (× nombre d'or) | la position du mot dans la mélodie de la phrase |
| **amplitude** A | 0.25 + longueur du token / 24, bornée à 1 | l'intensité (un mot long pèse plus) |

Deux propriétés garanties par les tests : **le même texte produit toujours la même signature**
(l'entraînement est reproductible) et **deux textes distincts produisent deux signatures distinctes**
(l'information est réellement portée par les ondes).

### Phase 2 — TRAITEMENT DES ONDES (`colonnesDepuisOndes` + `cortex.pas`)

La signature pilote l'injection dans le cortex columnnaire v1M :

- **colonne cible = f(onde)** : `colonne = ⌊((sin φ + 1)/2 + ω/1.75) mod 1 × nbColonnes⌋` — la PHASE
  décide où l'énergie tombe, la FRÉQUENCE décale le balayage. Ce n'est pas un hash direct : c'est la
  valeur physique de l'onde qui détermine où la stimulation atterrit.
- **intensité = amplitude** × gain (cap 3.0, mêmes règles que le langage courant).
- Le pas columnnaire (CSR push, décroissance paresseuse) propage l'énergie pendant
  `cyclesParEchantillon` cycles (1..8). **Coût ∝ activité** : les colonnes non touchées restent au
  repos — coût zéro (métabolisme `MetabolismePasV2` mesuré à chaque pas).

### Phase 3 — CONSOLIDATION ONDULAIRE (`plasticiteSupervisee` + `champ.propagerOndes`)

1. **Lecture graduée** : après les cycles, la résonance des 32 bandes est lue (part d'énergie reçue
   par bande, somme = 1).
2. **Plasticité supervisée** : les colonnes stimulées sont renforcées vers la **bande-porteuse du
   domaine** ; les bandes concurrentes sur-résonantes sont punies (×0.95) — le mécanisme éprouvé de
   l'entraînement v1, appliqué au substrat v1M.
3. **Le domaine parle dans le bus d'ondes** (it.56) : un paquet au porteur du domaine est émis dans
   les 1000 régions du champ cortical — **en phase → renfort** de la modulation régionale, **en
   opposition → annulation**. C'est ainsi que « la partie du domaine » grandit physiquement dans le
   cerveau.

## 3. Chaque domaine a sa longueur d'onde

Il n'y a pas de table magique : la bande-porteuse d'un domaine est **dérivée du nom du domaine**
(hash FNV-1a du label, réparti sur 8 porteurs ω ∈ {0.25, 0.44, 0.63, …, 1.75}). Deux conséquences :

- le vocabulaire fréquentiel est **partagé** avec le bus d'ondes du cerveau (même loi `porteurBande`) ;
- un NOUVEAU domaine choisi demain (ex. « astronomie ») obtient automatiquement son porteur — la
  méthode s'étend sans changement de code.

## 4. Comment entraîner gen3 sur les domaines de votre choix

La porte admin existante devient le point d'entrée de la méthode :

```http
POST /api/neural/train
{
  "source": "ondes",
  "domainesOndes": ["mathematiques", "programmation", "medecine"],
  "cyclesParEchantillon": 3,
  "lrBoost": 0.15,
  "maxParDomaine": 200
}
```

- `domainesOndes` : **les domaines que VOUS choisissez** (vide = les 18 domaines du dépôt :
  mathématiques, programmation, médecine, droit, finance, etc. — datasets JSONL commis dans
  `datasets/` et chargeables depuis le Training Hub).
- Le job tourne en arrière-plan (`GET /api/neural/train` pour la progression) et rend un
  **`rapportOndes`** par domaine : échantillons traités, résonance moyenne du porteur, paquets émis,
  renforts/annulations du bus, métabolisme cumulé (évaluées / reposées / transmissions / ms).
- La persistance existante sauvegarde automatiquement le cortex v1M ET la modulation régionale du
  champ (le cerveau « retient » ses ondes entre les redémarrages).

## 5. Pourquoi c'est fidèle à la demande « très faible énergie, tel un cerveau humain »

| Principe cérébral | Implémentation | Preuve mesurable |
|---|---|---|
| Le repos est gratuit | pas ÉVÉNEMENTIEL : seules les colonnes stimulées sont évaluées | `metabolisme.reposes` ≈ 1M − activité, coût 0 |
| Le coût suit l'activité | O(spikes × degrés) par pas | `metabolisme.evaluees` / `ms` par pas |
| Les parties communiquent sans fil costeux | bus d'ondes : O(paquets × régions), plafonné à 64 paquets | `bilan.energieTransportee` |
| La consolidation se fait « en dormant » | veille/rêve + consolidation de fenêtre existants | `champ.veille`, `consoliderFenetre` |

## 6. Limites honnêtes

- Le substrat est **simulé sur CPU/GPU généraliste** (TypedArrays + WGSL quand disponible) : la
  fidélité biologique est fonctionnelle (spikes, interférence, métabolisme), pas moléculaire.
- L'analyse des ondes est **déterministe par hash** : deux synonymes distincts ont des signatures
  distinctes — la généralisation sémantique vient des échantillons, pas d'un plongement pré-entraîné.
- La méthode **complète** l'entraînement par corpus existant (intentions v1) et par domaines
  (trainDomaines) ; elle ne les remplace pas — les trois sources restent disponibles sur la même porte.

## 7. Références dans le dépôt

- Implémentation : `lib/neural/training/entrainement-ondes.ts`
- Tests : `lib/neural/training/entrainement-ondes.test.ts`
- Branchement : `app/api/neural/train/route.ts` (source « ondes ») → `lib/neural/training/job.ts`
- Bus d'ondes sous-jacent : `lib/neural/core/v2/bus-ondes-regions.ts` (it.56)
- Architecture du cerveau : `docs/cerveau/architecture-cible-1m.md`

*it.57 — Job 478451 — garde anti-code-mort : verrou n°25.*
