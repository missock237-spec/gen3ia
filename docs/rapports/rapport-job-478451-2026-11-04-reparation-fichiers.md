# Rapport de réparation — Job 478451 — 2026-11-04 (intervention utilisateur, ~14:00Z)

> Signalement : « l'information d'artefact dit Réussi mais le fichier ne
> parvient pas à Gen3 lors de l'envoi du prompt — corriger pour que Gen3
> reçoive réellement les fichiers, les analyse et renvoie le résultat. »
> Sécurité : aucun token cité ; le harnais de test n'en utilise aucun.

## 1. Reproduction en production — harnais dédié (7/8, l'étape F échoue)

Nouveau harnais `scripts/test-flux-fichiers-prod.py` reproduisant EXACTEMENT
le canal client (nova-chat) sur https://gen3ia.online :

| Étape | Résultat |
|---|---|
| A0 signup + session | ✅ |
| A1 conversation créée | ✅ |
| B1 session multipart presignée | ✅ |
| B2 dépôt R2 (PUT part, ETag) | ✅ |
| C commit multipart (file.path) | ✅ |
| D import converti (fileId, kind=text, charCount=134) | ✅ |
| E tour de conversation (stream, attachment complet) | ✅ |
| **F Gen3 cite le marqueur secret du fichier** | ❌ |

Réponse de Gen3 à « Lis le fichier joint et réponds avec la phrase qui
commence par “le mot de passe du trésor est” » :
« Fichiers : 1 importé, récents : « rapport-test-a9bd6576.txt ». Je peux
agir dessus : demande-moi ce qu'il faut faire ensuite. »

**Le diagnostic est sans appel : l'import fonctionne, le contenu est
stocké (134 caractères convertis, fileId rendu) — mais la réponse est un
template de pilotage qui court-circuite la composition.**

## 2. Cause racine — une chaîne de deux défauts combinés

1. **Court-circuit de pilotage** (`lib/neural/pilotage/pilote.ts`) : la
   détection par mots-clés matche le simple mot « fichier » n'importe où ;
   dans le moteur neuronal Gen3 (`lib/neural/engine.ts`), la composition
   teste `pilotage ?? connaissances ?? corpus ?? vocation ?? cortex` — le
   template « Fichiers : N importés… Je peux agir dessus… » répond donc
   AVANT toute lecture du contenu, dès qu'un message mentionne un fichier.
2. **Le contenu n'atteignait jamais le moteur neuronal**
   (`lib/domain/conversations/engine-chat.ts`) : le contenu des fichiers
   importés (`filesContext`) était injecté UNIQUEMENT dans le system prompt
   des messages — or le moteur Gen3 (SNN interne, unique moteur du projet)
   compose depuis le canal `knowledgeContext` (pont connaissances), qui ne
   recevait que la base de connaissances du PROJET. Même sans le
   court-circuit, Gen3 n'aurait pas cité le fichier.

## 3. Correctif — trois pièces, une chaîne complète

1. **Garde « analyse d'un fichier joint »** (`pilote.ts`) : une demande
   d'action sur le contenu (« lis/analyse/résume/extrais/traduis/vérifie/
   compare/regarde » à frontière de mot + « fichier/document », ou les
   marqueurs « fichier joint », « pièce jointe »…) n'est JAMAIS du
   pilotage — `detecterIntentionPilotage` retourne null et la conversation
   suit avec le contenu réel. Les questions de STATISTIQUES restent du
   pilotage (« liste mes fichiers », « quels sont mes fichiers importés »).
2. **Canal du contenu** (`engine-chat.ts`, 3 call sites) :
   `knowledgeContext` du moteur neuronal reçoit désormais
   `filesContext + knowledgeContext` unifiés (stream principal, repli
   d'échec stream, chemin non-stream).
3. **Pont connaissances bilingue** (`connaissances-pont.ts`) : le parseur
   lit aussi les blocs « Fichier importé « nom » (…) : » de
   `loadImportedFilesContext` — chaque fichier devient un fragment du tour
   (score 1, pertinence maximale), cité MOT POUR MOT avec la source honnête
   (« votre fichier importé « … » »). Les notes de non-charge (« contenu
   non chargé… ») sont ignorées, jamais citées.

## 4. Tests — 9 nouveaux, 5 793 verts, 0 rouge

- `pilote.test.ts` : la garde (4 tests) — « lis le fichier joint… » → null,
  formulations d'analyse → null, statistiques → pilotage inchangé,
  exécution → null sur analyse de fichier joint.
- `connaissances-pont.test.ts` : blocs « Fichier importé » (5 tests) —
  fragment par fichier (score 1), contexte mixte sans confusion de blocs,
  métadonnées seules ignorées, citation mot pour mot du marqueur, titre
  honnête « D'après vos documents et vos fichiers joints ».
- Suite complète : **520 fichiers · 5 793 tests passés, 12 skippés,
  0 échec**. Gates : lint ✅, typecheck ✅, build ✅ (1900 Mo, même
  discipline que le tick 20:10).

## 5. Déploiement et validation finale

- Push `d6cac44..a9c663f` (premier essai) — le correctif est compilé par la
  CI au moment de la rédaction ; production saine sur `e78dd5d` (le SHA
  it.103 a basculé entre-temps : la file CD s'est vidée).
- Validation de clôture : harnais `test-flux-fichiers-prod.py` re-joué sur
  la production dès que `version.json` sert `a9c663f` — l'objectif est 8/8
  (le marqueur PONG cité mot pour mot).

## 6. Restes ouverts

- Fichiers binaires non textuels (images/PDF scannés) : honnêteté maintenue
  — « métadonnées seulement », aucune perception simulée ; l'analyse média
  locale (mesures sharp/ffprobe) reste branchée pour image/audio/vidéo.
- La fenêtre neuronale n'agrège pas encore l'« attention » sur de très
  gros fichiers (plafond 12 000 caractères/fichier, 60 000 au total —
  politique 10×50 Mo inchangée).
