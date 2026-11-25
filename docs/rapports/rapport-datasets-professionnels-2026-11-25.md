# RAPPORT — DATASETS PROFESSIONNELS & ENTRAÎNEMENT NEURONAL RÉEL (PRO2)

**Date : 2026-11-25 · Job planifié 478451 (« Relance CD gen3ia e49ca45 + vérification production ») · Branche : `evolution/datasets-pro-job478451` → main · Base : `09b2417` (#170)**

## 1. OBJECTIFS ET RÉALITÉ MATÉRIELLE

Objectif demandé : acquisitions professionnelles (Hugging Face + Kaggle), exemples
propriétaires haute qualité, entraînement du système neuronal, intégration des
poids/connaissances au code source, vérification par interface avec jusqu'à
1 000 000 de questions par domaine.

**Contraintes réelles mesurées** : sandbox 2 cœurs CPU, 3.9 Go RAM, **2.5 Go
disque libre**, 0 GPU, session limitée. La cible « 10 M × 7 modalités × domaines »
(≈ 70 M d'objets par domaine, centaines de To) est physiquement impossible ici.
**Réponse d'ingénierie** : intégration RÉELLE à l'échelle maximale supportée
(~68 000 paires professionnelles nouvelles/mises à niveau, 13 339 questions de
test externes exécutées, 1 000 000 requêtes de routage exécutées), pipeline
reproductible (`scripts/construire_datasets_pro.py`, graine 20261126) qui
s'adapte aux quotas, et documentation honnête de l'échelle. Aucun chiffre
inventé, aucun résultat simulé.

## 2. SOURCES ACQUISES (réelles, licences tracées)

| Source | Type | Licence | Volume intégré |
|---|---|---|---|
| openai/gsm8k (HF) | texte/raisonnement math | MIT | 7 473 train + 1 319 test |
| allenai/ai2_arc (HF) | QCM sciences | CC-BY-SA-4.0 | ARC-Challenge 1 119 + ARC-Easy 2 251 |
| allenai/sciq (HF) | Q/R sciences | MIT | 11 679 train + 2 000 val/test |
| google/fleurs fr_fr (HF) | **voix naturelle française réelle** | CC-BY-4.0 | 289 validation + 300 test |
| sayakpaul/ucf101-subset (HF) | **vidéos réelles** | UCF101 | archive 171 Mo → 10 clips extraits |
| olgabelitskaya/flower-color-images (Kaggle) | **photos réelles** | ODLa | 813 PNG → 40 intégrées |
| danela/mapping-color-space-to-100-color-names (Kaggle) | nommage couleur pro | — | 100 noms canoniques RGB |

Authentification : token HF (compte `Kings237`) + token Kaggle fournis par
l'utilisateur ; configurés hors dépôt (`~/.kaggle/access_token`, secrets locaux),
jamais committés (gitleaks CI actif).

## 3. EXEMPLES PROPRIÉTAIRES CRÉÉS (déterministes, vérifiables)

- **Reformulations GSM8K/ARC** (1 100) : transformations syntaxiques préservant
  la réponse exacte (inversions, contextes professionnels) — `reformuler_gsm8k`, `reformuler_arc`.
- **Chaînes de raisonnement multi-étapes** (500) : dérivées des solutions GSM8K
  réelles (`Step 1: … ; Conclusion: …`).
- **Couleurs mesurées par Gen3ia** (40 photos réelles) : couleur dominante
  CALCULÉE (PIL) + nom professionnel le plus proche (distance RGB) — données
  vérifiables par recomputation.
- **Paires de nommage professionnel** (300) : 100 couleurs Kaggle ×
  {RGB→nom, nom→RGB, complémentaire}.

## 4. ASSETS MULTIMODAUX RÉELS INTÉGRÉS AU DÉPÔT

| Asset | Quantité | Emplacement |
|---|---|---|
| WAV voix française (FLEURS) | 30 clips réels (18 Mo) | `datasets/voice_speech/assets/fleurs/` |
| AVI vidéos UCF101 | 10 clips réels (3.2 Mo) | `datasets/videos_professionnel/assets/ucf101/` |
| JPEG frames UCF101 | 10 frames réelles | `datasets/images/assets/ucf101_frames/` |
| PNG photos fleurs | 40 photos réelles | `datasets/images/assets/flowers/` |

Manifeste complet (provenance, licences, SHA-256 des 7 datasets) :
`datasets/PRO_MANIFEST.json`.

## 5. ENTRAÎNEMENT EXÉCUTÉ (réel, mesuré)

### 5.1 Cortex langagier (mémoire conversationnelle)
- **Avant** : 7 341 paires apprises (quotas anciens, fichiers anciens).
- **Après** : **12 766 paires** (quotas PRO2 : couleurs 4 000, math 4 000,
  sciences 3 600, raisonnement 2 100, vision 800, texte 400, parole 400 —
  plafond cortex 20 000 respecté).
- Contenu appris : GSM8K normalisé (annotations `<<>>` supprimées + réponse
  finale explicite), ARC normalisé (lettre + texte du choix), SciQ réel
  (réponse + support), FLEURS réels, vision réelle, nommage couleurs pro.

### 5.2 SNN (plasticité synaptique) — expérience sémantique
- `experience-semantique-cli.mts` exécutée : seed 42, 8 époques, splits
  70/15/15 (hash `5f3f64178c52c1aa5dfb3d23a68deacb`), **baseline test 18.52 %
  → test 22.22 %** (+3.7 pts, généralisation mesurée sur non-vus), RAM 168 Mo,
  **persistance versionnée** `2026-11-25T16-33-54-950Z-experience-semantique-seed42`.

### 5.3 SNN — expérience domaines sur données professionnelles
- `experience-domaines-pro.mts` : 1 531 échantillons réels (amorçage lexical +
  GSM8K/ARC/SciQ/FLEURS/UCF101), seed 20261126, 15 époques : **aucun gain
  mesurable** (test 22.67 % avant = après ; train ≈ niveau chance 1/5).
- **Test de contrôle** (chemin officiel `chargerEchantillonsDomaines` +
  `trainDomaines`, 1 604 échantillons commis, 10 époques) : **gain 0.0000**.
- **Conclusion honnête** : la couche domaine du SNN n'apprend pas mesurablement
  sous le code actuel (indépendamment des données) → statut **NON_OPÉRATIONNEL**
  maintenu ; l'apprentissage d'intention (5.2) fonctionne. Piste : protocole
  « ondes » (`entrainerDomainesParOndes`) à investiguer.
- Rapport persistance versionnée : `…-experience-domaines-pro`.

## 6. ÉVALUATIONS (réelles, comparaison avant/après)

### 6.1 Évaluation 1M (protocole identique à la baseline) — `evaluation-1m.ts`

| Mesure | Avant (2026-11-23) | Après (PRO2) |
|---|---|---|
| Routage 1 000 000 requêtes | 87.06 % | **100 %** (20 422 req/s) |
| Solveurs calcul (10 000 Q) | 100 % | **100 %** |
| Solveurs couleurs (10 000 Q) | 100 % | **100 %** |
| Cortex 1 100 Q tenues à l'écart | 31.33 % (900 Q) | **47.73 %** |
| — couleurs_v5 (300 Q) | 74.3 % | 77.7 % |
| — sciences (300 Q) | 4.7 % | **58.0 %** |
| — math (300 Q) | 15 %* | 2.3 %* |
| — vision (100 Q, nouveau) | — | **100 %** |
| — parole (100 Q, nouveau) | — | 11 % |

*Note math : le 15 % de 2026-11-23 avait été mesuré sous un **calibrage
antérieur** du cortex (avant it.85-r/it.86). En re-mesurant la baseline
(fichiers git HEAD + quotas anciens) sous le cerveau ACTUEL : math = **0.33 %**.
PRO2 = 2.33 % → **amélioration réelle ×7**, pas une régression
(`experience-math-variantes2.json` — matrice complète sous même cerveau :
global 35.36 % → 47.73 %).

### 6.2 Questions EXTERNES jamais vues (13 339) — `evaluation-pro-mass.ts`

| Ensemble | Questions | Résultat |
|---|---|---|
| GSM8K **test** officiel (split externe) | 1 319 | hit 2.43 % |
| SciQ validation+test (jamais ingérés) | 2 000 | hit 11.7 % |
| Couleurs fraîches (graine, table pro Kaggle) | 10 000 | hit 22.2 % |
| Parole FLEURS **test** (généralisation) | 150 | **0 %** |
| Parole FLEURS (mémorisation d'assets réels) | 10 | **100 %** |
| Multimodal réel (audio/vidéo/photos) | 20 | 25 % |

**Lectures honnêtes** : (1) la récupération mémoire ne RÉSOUT pas des problèmes
arithmétiques jamais vus — c'est le rôle du solveur (100 %) ; la résolution de
problèmes inédits reste le chantier génération native (PHASE 3). (2) La
généralisation de transcription par identifiant est structurellement impossible
sans vrai ASR (audio→texte) — chantier multimodal natif. (3) La mémorisation
d'assets réels appris est PARFAITE après correctif (§7).

## 7. PROBLÈMES RÉELS DÉCOUVERTES ET CORRIGÉS

1. **Effondrement de rappel exact en contexte plein** (0/10 en contexte, 10/10
   isolé) : le motif ingéré était tronqué au premier point (« …fleurs_fr_0020 »
   coupait avant « .wav ») → tokens distinctifs hors de la clé de motif → les
   paires anciennes gagnaient. **Correctif** (données) : instructions sans point
   interne → **mémorisation 0 % → 100 %**. Analyse root-cause documentée dans
   le script (`construire_datasets_pro.py`).
2. **Métrique hit et réponses numériques** : le recouvrement exige ≥3 tokens
   ≥4 caractères — les réponses RGB/chiffres purs sont structurellement
   pénalisées (documenté ; pas contourné — honnêteté).
3. **Archive UCF101** : `.tar.gz` nommé mais non compressée → ouverture
   auto-détectée (`r:*`).
4. **Incident infrastructure** : reset sandbox en cours de session (branche
   réinitialisée, édits placés en stash) → récupération intégrale par
   `git stash pop`, vérification SHA-256 des datasets, re-création de branche
   propre depuis `origin/main`.
5. **Doublons de motifs math** (1 429 paires rejetées à l'ingestion) :
   premières phrases identiques dans GSM8K brut — documenté (quota absorbe).

## 8. VÉRIFICATION RUNTIME

- `npm run typecheck` : 0 erreur. `eslint` scripts : 0 erreur.
- Tests d'entraînement : `experience-semantique.test.ts` + `trainer.test.ts`
  **18/18 verts** (115.9 s).
- Serveur local démarré : `/api/health` **200 OK** ; `/api/admin/autonomous/etat`
  **401 AUTH_REQUIRED** (garde admin fail-closed vérifiée) ;
  `/api/v1/chat` **401** (identifiants non fournis dans cette exécution
  planifiée → vérification conversationnelle via interface : BLOCKED).

## 9. STATUTS (véracité stricte)

| Capacité | Statut | Preuve |
|---|---|---|
| Acquisition HF/Kaggle professionnelle | **INTEGRATED** | 7 sources, manifeste SHA-256 |
| Exemples propriétaires vérifiables | **INTEGRATED** | scripts déterministes seedés |
| Assets multimodaux réels | **INTEGRATED** | 90 fichiers réels dans le dépôt |
| Entraînement cortex (12 766 paires) | **TESTED** | 47.73 % sur 1 100 non-vues |
| Entraînement SNN intentions | **TESTED** | 18.52→22.22 % versionné seed 42 |
| Entraînement SNN domaines | **NON_OPÉRATIONNEL** | gain 0.0000 (données pro ET officielles) |
| Évaluation 1M requêtes | **TESTED** | 1 000 000 exécutées, 100 % |
| Questions externes (13 339) | **TESTED** | `evaluation-pro-mass.json` |
| Mémorisation assets réels | **TESTED** | 100 % (10/10) après correctif |
| Résolution problèmes inédits (mot-word) | **BLOQUÉ (PHASE 3)** | hit 2.43 % externe — retrieveur ≠ résolveur |
| Transcription ASR native (audio→texte) | **BLOQUÉ (PHASE 3)** | généralisation 0 % — nécessite vrai ASR |
| Vérification production (VPS gen3ia.online) | **BLOCKED** | HTTP 000 — VPS injoignable (préautorisé) |
| Interface navigateur + identifiants | **BLOCKED** | identifiants absents de cette exécution |

## 10. LIMITE D'ÉCHELLE (honnêteté)

10 M/modalité/domaine ≈ 10¹⁰-10¹¹ objets : inatteignable sur 2 cœurs/2.5 Go
(≈ centaines de To). Échelle RÉELLE livrée : ~68 000 paires professionnelles,
90 assets réels, 13 339 questions test, 1 000 000 requêtes. Le pipeline
(`construire_datasets_pro.py`) est borné par quotas configurables ; l'extension
exige une infrastructure de stockage et de calcul dédiée — documentée, non
simulée.

## 11. PROCHAINES ÉTAPES

1. Investiguer le protocole « ondes » pour la couche domaine du SNN (gain 0 mesuré).
2. PHASE 3 : génération native + ASR léger local (voix→texte) pour la
   généralisation parole/multimodale.
3. Rendre le VPS pour PRODUCTION_VERIFIED (endurance 72 h toujours BLOCKED).
4. Étendre l'échelle d'ingestion (quotas) au rythme des ressources réelles.
