# Gen3 multimodal — texte, son, vidéo, image SANS GPU

> État réel de la plateforme. Aucune IA externe (supprimées du projet), aucun
> GPU requis : les quatre modalités sont générées **en CPU local** par le
> système neuronal Gen3. Ce document dit aussi ce que la plateforme **ne sait
> pas faire** — l'honnêteté passe avant l'optimisme.

## 1. Les quatre modalités

| Modalité | Moteur | Entrée → sortie | Repli assumé |
|---|---|---|---|
| **Texte** | Cortex langagier Gen3 (`lib/neural/generation/language.ts`) + noyau SNN v2 | prompt → réponse conversationnelle | refus honnête hors matière apprise |
| **Image** | Moteur visuel scénique v2 (`lib/neural/generation/visual-scene.ts`) | prompt → SVG vectoriel en calques → PNG (sharp) | constellation v1 si aucun sujet/cadre reconnu |
| **Son** | Moteur audio scénique v2 (`lib/neural/generation/audio-composition.ts`) | prompt → WAV PCM 16 bits mono | nappe pentatonique v1 si rien de sonore reconnu |
| **Vidéo** | Moteur vidéo scénique v2 (`lib/neural/generation/video-storyboard.ts`) | prompt → SVG animé SMIL (storyboard 1–4 scènes) | animation constellation v1 |

Le **texte** est le canal le plus mature (pré-entraînement `cortex-v2.bin`
committé, boucle de maîtrise HF/Kaggle, consolidation d'expérience). Les
trois autres modalités sont scéniques : elles rendent ce que l'analyseur
sémantique (`lib/neural/generation/scene-spec.ts`) comprend du prompt.

## 2. L'analyse sémantique (le cœur commun)

L'analyseur transforme un prompt FR/EN en spécification structurée :

```
« un chat noir au bord de la mer au coucher de soleil »
→ { sujet: chat, couleur: noir, cadre: océan, moment: crépuscule,
    couverture: 0.83 }
```

- vocabulaire **intégré** (~250 stems) + vocabulaire **appris hors
  production** (artefact committé, cf. §4) ;
- correspondance exacte puis **longest-prefix** (« château » ≠ « chat »,
  « enneigée » → neige) ;
- locutions multi-mots (« coucher du soleil », « noir et blanc »…) ;
- **cadres implicites** : un phare se dresse sur la mer, une vache à la
  campagne — si le prompt ne nomme pas de cadre, le sujet l'apporte ;
- chaque spécification porte sa **couverture** (part des mots porteurs de
  sens réellement interprétés) et ses mots reconnus — exposés dans les
  méta de génération (`meta.scene`).

Prompt hors vocabulaire → `sujet: null` → **repli v1 assumé** (constellation
abstraite), nommé comme tel dans les méta (`moteur:
"gen3-snn-visuel-v1-constellation"`). Aucune prétention.

## 3. Ce que les moteurs v2 rendent réellement

**Image** : illustration vectorielle stylisée en calques — ciel du moment,
astre (soleil/lune/planète), nuages, météo (pluie, neige, brouillard,
éclair), cadre (océan, montagnes, forêt, ville, désert, campagne, lac,
espace), sujet dessiné (25 types : chat, chien, oiseau, phare, voilier,
personnage, dragon…), style (gen3, minimal, aquarelle, néon, bande dessinée,
vintage). L'état du cerveau reste impliqué : graines de composition,
densité d'étoiles/fenêtres liées aux poids appris.

**Son** : design sonore en couches — SFX synthétisés par calcul (pluie,
vagues, vent, orage, feu, ruisseau, horloge, cloche, foule, pas, oiseaux),
ambiance de cadre, plus une musique structurée (tempo et mode
majeur/mineur selon l'ambiance, motif de 4 phrases tiré des synapses
apprises).

**Vidéo** : storyboard de 1 à 4 scènes (découpage du prompt), chaque scène
rendue par le moteur visuel v2 puis animée en SMIL — caméra (pan/zoom
alternés), sujet flottant, météo vivante (pluie qui tombe, neige, éclairs,
brouillard respirant), oiseaux en vol, fondus enchaînés entre scènes.

**Texte** : cortex conversationnel (worklog Task 164/165), Studio
d'entraînement (Gen entraîne VOS modèles, moteur gen3-local CPU), évolution
continue par consolidation.

## 4. Entraînement HORS PRODUCTION

**Directive** : la production **charge**, elle ne s'entraîne pas.

```bash
npx tsx scripts/pretrain-multimodal.ts
```

Le script (à exécuter en sandbox/CI, jamais sur le VPS) :

1. évalue l'analyseur sur un **corpus bilingue annoté** (48 phrases, jeu de
   test tenu à l'écart) ;
2. valide les **enseignements** (134 associations terme→valeur) : aucun
   conflit avec l'intégré, aucune valeur hors liste, **aucun nouveau type
   de sujet non rendable** ;
3. mesure la précision **avant/après** et commet :
   - `assets/neural-pretrained/multimodal-lexique-v1.json` — l'artefact
     chargé au runtime par `lib/neural/generation/lexique-serveur.ts` ;
   - `assets/neural-pretrained/pretrain-multimodal-report.json` — le
     rapport honnête (précisions mesurées, refus justifiés).

Dernier run : précision attendus 0.913 → **1.000** (train) et 1.000 (test)
après enrichissement. Pour étendre le vocabulaire : ajouter des
enseignements dans `lib/neural/generation/entrainement-lexique.ts`, relancer
le script, committer l'artefact (la PR passe la QA, le CD déploie).

Le **texte** suit l'autre voie (historique) : pré-entraînement
`scripts/pretrain-cortex-v2.ts` + boucle de maîtrise en production
(`lib/entrainement-auto/` — cette boucle-ci est explicitement autorisée en
ligne et s'arrête à maîtrise mesurée du catalogue).

## 5. Niveaux de référence — écarts documentés

La demande produit vise les niveaux ChatGPT (texte), Leonardo (image),
ElevenLabs (voix), Veo (vidéo). Comparaison honnête :

| Axe | Référence | Gen3 aujourd'hui | Écart assumé |
|---|---|---|---|
| Texte | ChatGPT | conversation fiable sur matière apprise, personnalisation persistante, évolution continue | pas de connaissance encyclopédique générale (corpus borné) ; pas de raisonnement multi-sauts |
| Image | Leonardo | sujet demandé réellement dessiné, cadrages, météo, styles, composition déterministe | illustration **vectorielle stylisée** : pas de photoréalisme, pas de textures, pas de déformations libres (visages exacts, mains, texte dans l'image) |
| Voix/son | ElevenLabs | design sonore sémantique réel + musique structurée ; lecture vocale du chat via Web Speech (voix navigateur) | **pas de voix synthétique naturelle** : aucun clone vocal, aucune prosodie humaine ; le son généré est de la musique/ambiance, étiqueté comme tel |
| Vidéo | Veo | storyboard multi-scènes animé (caméra, météo vivante, transitions) | animation **vectorielle SMIL** : pas de rendu photoréaliste, pas de cohérence inter-frames fine, pas de personnages animés articulés |

Ces écarts ne sont pas des défauts de réglage mais des limites de
principe : reproduire Leonardo/Veo/ElevenLabs exige des modèles
diffusion/TTS lourds (GPU ou APIs externes) — deux choses explicitement
exclues du projet. Les axes de progression **dans le cadre imposé** :
élargir le lexique (enseignements), enrichir les bibliothèques de
composants vectoriels (nouveaux sujets rendables), ajouter des couches
SFX, densifier le corpus langagier.

## 6. Contrat technique

- **Pur et déterministe** : les moteurs sont des fonctions
  (prompt, scène, snapshot neuronal) → contenu bit-à-bit identique. Un
  cerveau entraîné différemment produit une œuvre différente.
- **Cache de contenu** : clé SHA-256 (type, prompt, paramètres, empreinte
  neuronale) sous `users/<uid>/permanent/neural-media/cache/` — version
  **v2** des ingrédients (les rendus v1 ne sont jamais servis pour un
  prompt v2).
- **Méta honnête** : chaque génération expose `moteur` (v2-scène ou
  v1-constellation), la scène reconnue (sujet, cadre, moment, météo,
  style, ambiance, couverture) et ses calques/couches réels.
- **Points d'entrée** : `POST /api/neural/media` (studio du Cerveau IA),
  intercept chat (`/api/chat/message`), agents
  (`lib/agents/runtime/runner.ts`), outils
  (`lib/tools/media/generate-image-neural.ts`), pipeline vidéo
  (`lib/video/image-bridge.ts`) — tous passent par `lib/neural/media-service.ts`.
