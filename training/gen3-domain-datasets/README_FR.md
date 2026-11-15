# Les 18 domaines de gen3 — datasets bilingues FR/EN

Corpus d'entraînement supervisé des **18 domaines d'expertise de gen3** :
18 datasets JSONL de **100 000 lignes chacun** (1 800 000 lignes au total),
bilingue français/anglais (50/50), horodatage réaliste sur une fenêtre
glissante de 24 mois, dédupliqués par hachage de contenu.

## Structure d'une ligne JSONL

```json
{
  "id": "gen3ia-video-00042311",
  "domain": "video",
  "domain_fr": "vidéo",
  "language": "fr",
  "task_type": "storyboard",
  "instruction": "Prépare un storyboard de 30 s sur « le marché du poisson à l'aube », ton documentaire calme... Contexte : en atelier avec l'équipe ce matin.",
  "input": "",
  "output": "Storyboard 30 s — 4 plans...\nCritère de succès : ...",
  "metadata": {
    "created_at": "2025-11-03T14:22:00Z",
    "temporal_bucket": "2025-W45",
    "difficulty": "intermediaire",
    "quality_score": 0.91,
    "source_style": "atelier_gen3ia",
    "bilingual_pair_id": "bp-video-0023456",
    "dedup_hash": "sha1:7c9e66797425...",
    "safety_label": "sans_objet",
    "license": "CC-BY-4.0-synthetic-gen3ia"
  },
  "domain_fields": { "scene": { "duree_s": 30, "shots": [...] } }
}
```

### Schéma de qualité (commun à tous les domaines)

| Champ | Rôle |
|---|---|
| `task_type` | Type de tâche du domaine (2-6 par domaine, pondérés) |
| `metadata.created_at` | Horodatage réaliste : récence privilégiée, rythme hebdomadaire (semaine active, week-end calme), profil horaire de production |
| `metadata.difficulty` | debutant (20 %) / intermediaire (40 %) / avance (30 %) / expert (10 %) |
| `metadata.quality_score` | 0.70-0.99, cohérent avec difficulté et provenance |
| `metadata.source_style` | Registre rédactionnel : atelier / expert / communauté curatée / synthèse contrôlée |
| `metadata.bilingual_pair_id` | Lie la ligne FR et sa version EN (traduction décalée de quelques minutes) |
| `metadata.dedup_hash` | sha1 du contenu normalisé — unicité garantie |
| `metadata.safety_label` | `sans_objet` / `recherche_defensive` (cyber) / `ctf_educatif` (hacker) / `info_medicale_generale` (santé, disclaimer systématique) |
| `domain_fields` | Champs spécifiques du domaine (params d'image, shots de storyboard, réglages audio, Phases cyber...) |

## Les 18 domaines

| Domaine | Types de tâches | Particularités |
|---|---|---|
| generation_images | text_to_prompt, style_guide, critique_image, variations_prompt | prompts structurés (sujet/style/lumière/composition/usage/contrainte) |
| video | storyboard, scenario_video, parametres_rendu, feuille_montage | contraintes techniques réelles (crf, LUFS, poids) |
| son | synthese_sonore, voix_off, chaine_audio | repères dBFS/LUFS/EQ |
| clips_musicaux | concept_clip, structure_musicale, ecriture_paroles | genres réels, mesures/tonalités |
| developpement_web | implementation_web, debug_web, conception_api | contraintes mobile-first/a11y/poids |
| test | plan_test, cas_limite, ci_tests | pyramide, couvertures cibles |
| redaction_documents | plan_document, relecture | structures explicites, audiences |
| sciences_humaines | analyse_sh, pedagogie_sh | critique des sources, limites |
| recherche_scientifique | protocole_recherche, vulgarisation | falsifiabilité, taille d'effet |
| cybersecurite | reponse_incident, hygiene_numerique | **défensif uniquement** (safety_label) |
| hacker | ctf_educatif, analyse_defensive | **CTF éducatif uniquement** (safety_label) |
| multimodal | alignement_multimodal, pipeline_multimodal | références croisées, bornes temporelles |
| construction_machines | conception_machine, depannage_machine, programmation_controle | sécurité redondante, essais mesurés |
| vente | traitement_objection, pitch_vente | éthique (pas de fausse urgence) |
| sante_medical | information_sante, preparation_consultation | **disclaimer systématique** |
| analyse_donnees | nettoyage_donnees, plan_analyse, visualisation_donnees | journal de nettoyage, médiane avant moyenne |
| conseiller_commercial | recommandation_conseil, suivi_client | priorité racine → solution minimale |

## Reproduction

```bash
# Datasets complets (18 × 100 000 lignes, ~2,4 Go — hors git)
python3 training/gen3-domain-datasets/generateur.py

# Sous-ensemble / autre taille
python3 generateur.py --lignes 50000 --domaines video,son

# Échantillons commis uniquement (120 lignes/domaine, déjà dans git)
python3 generateur.py --lignes 1000 --sans-complet --echantillon 120
```

Le générateur est **déterministe** (graine 20261024) : un run reproduit les
mêmes fichiers bit-à-bit. `manifest.json` documente chaque run.

## Utilisation par gen3 (le système nerveux)

1. **Couche des 18 domaines du SNN** (v3) — réseau étendu à 140 neurones,
   pools `DOM_*` sur les neurones 100-135, entraînés par plasticité
   supervisée (`NeuralTrainer.trainDomaines`) via le Studio
   (Onglet Entraînement → « Entraîner sur mes 18 domaines ») ou
   `POST /api/neural/train {"source":"domaines"}`.
2. **Amorçage pré-entraîné** — `assets/neural-pretrained/brain-domaines-v1.json`
   (synapses de la couche, entraînées hors prod sur ces datasets) fusionné
   au démarrage du runtime si le cerveau local n'a jamais vu les domaines.
3. **Détection de domaine en conversation** — `predireDomaineLexical`
   (mots-clés réels des datasets, pattern `labelText` des actions) ;
   le domaine reconnu est tracé dans `raw.domaine` des réponses du moteur.
4. **Cortex langagier** — paires canoniques instruction → réponse des
   datasets apprises au démarrage et à chaque entraînement (plafond 220).

## Limites honnêtes (mesurées)

- La couche SNN (38 neurones de hachage d'entrée, pools de 2 neurones) ne
  sépare pas 18 classes aux vocabulaires recouvrants : son accuracy de
  classification reste proche du hasard et est **rapportée telle quelle**.
  Le routage de domaine fiable est **lexical** (comme la couche d'actions) ;
  la couche SNN reste le substrat en plasticité continue.
- Les datasets sont **synthétiques contrôlés** (gabarits métier + slots) :
  chaque ligne est un contenu distinct et vérifiable, rédigé dans des
  registres réalistes ; ils n'inventent aucune provenance humaine
  (`source_style` décrit le registre, pas une origine).
