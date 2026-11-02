# Rapport it.84 — datasets externes réels (HF/Kaggle) dans les 19 domaines + LE script unique d'entraînement + évaluation 950 questions

**Demande propriétaire (trace `1a19a7e0cd8e7339`, 02/11/2026)** : sélectionner les meilleurs datasets Hugging Face/Kaggle dans les 19 domaines de gen3, les implémenter dans le cerveau comme code source, créer **un seul script d'entraînement** qui assimile tous les domaines d'un coup, l'exécuter pour mémorisation, vérifier avec **50 questions par domaine**, supprimer les réponses parasites, et la compréhension images/vidéo/audio.

**Commits :** `b87f4e8` (sélecteur) · `6d6bb22` (script unique) · `5063b8c` (chaîne de sources + échantillons commis + gardes) · rapport (4/4)

---

## 1. Les datasets réellement sélectionnés et téléchargés (12 179 extraits réels)

| Domaine gen3 | Source réelle (Hugging Face) | Extraits | Licence |
|---|---|---|---|
| developpement_web | nickrosh/Evol-Instruct-Code-80k-v1 | 799 | recherche |
| analyse_donnees | gretelai/synthetic_text_to_sql | 800 | gretel-synthetic |
| sciences_humaines | databricks/databricks-dolly-15k | 764 | Apache-2.0 |
| recherche_scientifique | allenai/sciq | 161 | CC BY-SA 4.0 |
| sante_medical | openlifescienceai/medmcqa | 700 | Apache-2.0 |
| cybersecurite | Trendyol-Cybersecurity-Instruction-Tuning-Dataset | 800 | recherche |
| redaction_documents | dolly-15k (catégories brainstorming/closed_qa) | 178 | Apache-2.0 |
| generation_images | Gustavosta/Stable-Diffusion-Prompts | 499 | recherche |
| video | hugginglearners/netflix-shows | 800 | recherche |
| son | openslr/librispeech_asr (transcriptions) | 399 | CC BY 4.0 |
| clips_musicaux | D3STRON/music_lyrics_500k | 797 | recherche |
| multimodal | jxie/coco_captions (descriptions d'images) | 800 | CC BY 4.0 |
| vente | DeepMostInnovations/saas-sales-conversations | 800 | recherche |
| conseiller_commercial | Lakshan2003/customer_service…40k | 800 | recherche |
| test | openai/gsm8k | 800 | MIT |
| hacker | 7h3-R3v3n4n7/pentest-agent-dataset-alpaca | 800 | recherche (CVE publiques) |
| construction_machines | sanjayram-a/ifixit-repair-chatml | 771 | recherche |
| recherche_web | microsoft/ms_marco | 711 | public |
| **19ᵉ (generation-code)** | datasets/code du dépôt (12 000 lignes) | 700 | atelier |

- **12 179 extraits réels téléchargés** le 02/11/2026 via l'API datasets-server HF (retry/backoff 429) — conversion au format du générateur gen3, **déduplication sha1**, heuristique FR/EN, score de structure mesuré.
- **Échantillon commis** : 120/domaine (2,1 Mo) part dans le dépôt — « introduit comme code source » au sens du dépôt (comme l'échantillon atelier) ; les complets (13 Mo) restent hors git, régénérables par le script (seed 20261102).
- **Échelle demandée vs réalité** : « 1 milliard de datasets par domaine / 10 milliards d'exemples par domaine » est **physiquement impossible chez aucun fournisseur au monde** (les plus gros corpus publics font des millions, pas des milliards). Les quotas ci-dessus sont les **téléchargements réels de ce jour**, publiés tels quels — zéro chiffre fantôme. La voie de montée en échelle est le générateur déterministe existant (100 000/domaine, commis) + l'accumulation par ticks.

## 2. LE script unique : `scripts/entrainement-tous-domaines.ts`

Un seul script fait tout, dans cet ordre mesuré :

1. **Charge la matière par domaine** via la chaîne de sources du dépôt (complet → **complet/externes** → **echantillons_externes** → atelier) + datasets/code pour le 19ᵉ domaine.
2. **Sépare train/test** : les 50 DERNIERS échantillons de chaque domaine ne sont JAMAIS supervisés — ce sont les 50 questions/domaine.
3. **Textes signatures** (mécanique de production) : instructions tronquées aux tokens discriminants (≤ 2 domaines, max 6) — une instruction brute de 800 caractères sature l'encodeur SNN et efface la discrimination (mesuré : sans ce traitement, tout tombe au hasard).
4. **Sonde AVANT** : cortex NEUF (même graine, zéro supervision) → argmax des 8 bandes sur chaque question.
5. **ASSIMILE D'UN SEUL COUP** : `entrainerDomainesParOndes` (EOD it.57) sur les **19 domaines en UNE passe** — analyse des ondes (fréquence/phase/amplitude), traitement columnnaire, consolidation par résonance + bus d'ondes du champ cortical ; métabolisme mesuré à chaque pas.
6. **Sonde APRÈS** + **phase langagière** (la mécanique réelle du chat) : paires (première phrase de l'instruction → réponse réelle) apprises depuis le train externe, puis les 950 questions passées dans `cortex.repondre()` — le même appel que le chat de production — avec critère : thème = domaine attendu ET score d'appariement ≥ 0,5.
7. **Pré-filtre des réponses parasites** : les motifs dont TOUS les tokens sont universels (présents dans > 60 % des domaines) sont exclus de l'apprentissage (1 exclu ce jour) ; les réponses hors-domaine restent comptées honnêtement.
8. **Mémorisation persistée** : quantification u8 → checkpoint binaire `var/neural-domaines-externes/cortex-u8.bin` (1 572 912 octets), **rechargé octet-pour-octet et validé** après écriture + `evaluation.json` (tous les chiffres).

## 3. Résultats mesurés (sandbox, graine 20261102, 950 questions)

### 3.1 Le test utilisateur — cortex langagier (le chat réel) : **782/950 = 82,3 %**

| Domaine | Avant (vierge) | Après (appris) | Score moyen | Hors-domaine |
|---|---|---|---|---|
| generation_images | 0/50 | **49/50** | 4,94 | 1 |
| video | 0/50 | **49/50** | 3,92 | 1 |
| son | 0/50 | **50/50** | 24,86 | 0 |
| clips_musicaux | 0/50 | **50/50** | 21,42 | 0 |
| developpement_web | 0/50 | 44/50 | 3,58 | 6 |
| test | 0/50 | 26/50 | 2,61 | 14 |
| redaction_documents | 0/50 | **2/50 ⚠** | 8,63 | 47 |
| sciences_humaines | 0/50 | 27/50 | 3,57 | 21 |
| recherche_scientifique | 0/50 | **13/50 ⚠** | 2,83 | 36 |
| cybersecurite | 0/50 | **49/50** | 3,94 | 1 |
| recherche_web | 0/50 | **49/50** | 4,38 | 1 |
| multimodal | 0/50 | **50/50** | 21,96 | 0 |
| hacker | 0/50 | 47/50 | 3,14 | 3 |
| construction_machines | 0/50 | **50/50** | 5,10 | 0 |
| vente | 0/50 | **50/50** | 6,99 | 0 |
| sante_medical | 0/50 | 41/50 | 2,96 | 8 |
| analyse_donnees | 0/50 | 39/50 | 3,49 | 11 |
| conseiller_commercial | 0/50 | **50/50** | 9,42 | 0 |
| generation-code | 0/50 | **47/50** | 5,93 | 3 |

**L'avant est 0/950 partout** : le gain vient entièrement de l'entraînement. **9 domaines à ≥ 98 %** ; hors-domaine 153 ; sans réponse 15 ; parasites exclues 1.

**Deux domaines faibles, cause identifiée** : `redaction_documents` (2/50) et `recherche_scientifique` (13/50) — leurs motifs (première phrase dolly brainstorming / sciq) sont trop génériques et perdent l'appariement au profit d'autres domaines. Levier connu : motifs enrichis (2 premières phrases ou instruction complète) — travail suivant documenté, non simulé ici.

### 3.2 Les bandes porteuses (EOD) — publié tel quel

11,4 % → 11,1 % : l'argmax de bande ne discrimine pas les 19 domaines — **limite structurelle du design** (8 porteurs pour 19 domaines : plusieurs domaines partagent la même bande). Ce n'est PAS le canal de discrimination de gen3 : le routage fin se fait par les pools de neurones (100–135) en production (`trainer.trainDomaines` + `predireDomaine`) et par le cortex langagier mesuré ci-dessus. Publié tel quel par honnêteté.

## 4. « Implémenté comme code source » + chemin vers les utilisateurs

- **Le code** : sélecteur (reproductible, seed fixe) + échantillons commis dans le dépôt + loader étendu (`lireDatasetDomaine` : chaîne de sources, première présente) + **paires du chat passées de 1 à 3 motifs/langue** (`construirePairesDomaines`) → **le prochain job d'entraînement de production lit automatiquement la matière externe** et le chat répond avec les réponses réelles des datasets.
- **Le test navigateur** : l'évaluation 950 questions est la mesure du canal réel (`cortex.repondre` = l'appel du chat). Le test UI sur gen3ia.online est réalisé après bascule (§7) — l'assimilation en prod s'active via le Training Studio (bouton « Entraîner ») qui exécute le même pipeline côté serveur.

## 5. Compréhension images / vidéo / audio — état réel, sans promesse creuse

- **Ce qui est FAIT** : les 4 domaines d'expertise multimodale de gen3 sont entraînés par ondes sur des données réelles — `multimodal` (descriptions COCO réelles), `video` (métadonnées vidéo réelles), `son` (transcriptions LibriSpeech réelles), `clips_musicaux` (paroles+genres réels), `generation_images` (prompts réels) — gen3 **conseille, rédige, analyse et décrit** dans ces domaines. Les datasets v4 du propriétaire sur HF (image_analysis 35 000, video_v4 45 000, voice_speech 20 000, audio_understanding 15 000) complètent la matière conceptuelle.
- **Ce qui n'existe PAS encore (honnêteté)** : la **perception brute** (encoder les pixels/ondes audio en entrée du SNN) n'est pas implémentée — gen3 ne « voit » pas une image ni n'écoute un fichier ; il traite le TEXTE de ces domaines. C'est une feuille de route réelle (encodeurs locaux : vision/ASR légers sur CPU), pas une capacité simulée — aucune promesse non mesurée ne sera affichée dans le produit.

## 6. Incident de session — coordonné et surmonté

Un tick parallèle a exécuté un `git reset --hard` pendant le travail, détruisant les fichiers non commités (sélecteur, script, loader, échantillons). Reconstruction intégrale depuis la trace, puis **commits atomiques immédiats** (4 commits) pour survivre à tout nouveau reset ; le fichier déposé par le tick parallèle (`scripts/telecharge-datasets-19-domaines.sh` — datasets v4 du propriétaire) est conservé et complémentaire.

## 7. Gates et déploiement

| Gate | Résultat |
|---|---|
| tsc --noEmit | 0 erreur |
| eslint (fichiers modifiés) | 0 erreur |
| vitest complet | **5 596 verts / 0 échec / 12 sautés** (+ gardes chaîne de sources) |
| next build | 182/182 pages |
| Entraînement exécuté | EOD 19 domaines, 11 766 échantillons signatures, checkpoint validé |
| CI GitHub → CD → prod | suivie après push (backoff v3 actif) |

## 8. Limites et honnêteté (récapitulatif)

1. **Échelle** : 12 179 extraits réels ≠ 1 Md/domaine demandé — impossible physiquement ; le chemin de montée est documenté (générateur déterministe + accumulation).
2. **Kaggle** : le canal kagglehub a été testé et validé (téléchargement réel réussi), mais la sélection finale retenue est 100 % HF (meilleure qualité textuelle disponible) — Kaggle reste branché pour les campagnes futures.
3. **Deux domaines faibles** (redaction_documents, recherche_scientifique) : cause identifiée (motifs génériques), levier documenté, non dissimulé.
4. **Perception multimodale brute** : non implémentée — expertise textuelle réelle, feuille de route écrite.
5. **Les bandes porteuses** ne discriminent pas les 19 domaines (8 porteurs) — mesure publiée telle quelle ; le routage réel passe par les pools et le cortex langagier.

— Rapport généré automatiquement dans le cadre du Job 478451 (résultat en français, zéro chiffre fantôme).
