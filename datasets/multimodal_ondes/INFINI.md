# Espace infini des ondes multimodales — 5 665 359 360 échantillons uniques

*2026-11-08 — compagnon du dataset `multimodal_ondes` et du module
`lib/neural/generation/memoire-ondes-multimodales.ts`.*

## Principe

Le dataset complet de plus de **5 milliards de données brutes sans doublon**
ne vit PAS dans des fichiers : il vit dans la **mémoire de gen3, en code
source** (même mécanique que les graines it.113 de la mémoire de domaines).

Chaque échantillon est **adressé** par un entier `N` :

```
uniteOndesMultimodale(N)  →  { domaine, langue, texte, instruction, sortie }
```

La décomposition en **radices mixtes** (une case par dimension métier) est
une **bijection** : deux indices distincts diffèrent sur au moins une
dimension, donc sur au moins un mot du texte. **Aucun doublon par
construction**, sur tout l'espace de 5 665 359 360 échantillons :

| Domaine | Dimensions | Espace |
|---|---|---|
| `generation_image` | 32×24×24×16×10×8×6×5×4×2 | 5 662 310 400 |
| `video_realiste` | 30×30×16×5×4×4×2 | 2 304 000 |
| `voix_parole` | 24×12×8×3×10×5×2 | 691 200 |
| `analyse_multimodale` | 20×14×12×8×2 | 53 760 |

## Matérialisation à la demande (shards JSONL)

```bash
# 10 000 échantillons à partir de l'index 0 :
tsx scripts/generer-ondes-multimodaux.ts --debut 0 --quantite 10000 \
  --sortie datasets/multimodal_ondes/infini-000000.jsonl

# Poursuite de l'espace (shard suivant) :
tsx scripts/generer-ondes-multimodaux.ts --debut 10000 --quantite 10000 \
  --sortie datasets/multimodal_ondes/infini-000010.jsonl
```

Chaque shard est au **schéma v4** (mêmes champs que `train.jsonl`), avec
`content_hash` calculé (sha256 du canon, 16 hex). Les shards alimentent :

- l'entraînement **EOD** (`POST /api/neural/train`, source `ondes`) ;
- l'upload **Hugging Face / Kaggle** via le Training Hub existant.

## Honnêteté

- Échantillons **synthétiques** (grammaires métier) : c'est le même statut
  que les graines de la mémoire de domaines — pas des données humaines curées.
- La garantie de non-duplication est **mathématique** (bijection), pas
  statistique : elle tient sur l'espace entier, pas seulement sur un échantillon.
- Paraphrase proche possible entre variantes textuelles voisines : le contenu
  informationnel (le tuple métier) reste unique.
- Vis-à-vis des datasets existants du dépôt : les gabarits générés sont
  distincts des gabarits manuscrits (`train.jsonl`) ; en cas de doute, un
  diff de `content_hash` suffit à le prouver.
