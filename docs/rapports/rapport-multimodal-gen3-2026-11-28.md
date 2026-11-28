# Rapport — Système multimodal génératif Gen3 : images, voix, vidéos

**Date :** 2026-11-28 · **Dépôt :** `missock237-spec/gen3ia` · **Base :** `d69669a` (évolution : mémoire permanente, hors corpus, autonomie, rapports, créativité) · **Demande :** le système multimodal de Gen3 doit créer des **images photoréalistes**, une **audio voix réaliste ressemblant à la voix à copier**, et des **vidéos ultra réalistes avec animation et scènes complètes**.

---

## 1. Architecture livrée — production réelle + honnêteté des niveaux de réalisme

Nouveau module `lib/neural/multimodal/` (6 fichiers, 16 tests verts) :

```
encodeur-prompt-scene.ts   — prompt → plan structuré déterministe (sujet, éléments, éclairage,
                             cadrage, palette, séquence vidéo : scènes + actions + fps)
generateur-images.ts       — écrivain PNG RÉEL (zlib + CRC32) + compositeur structurel
                             paramétrable (dégradé d'éclairage, disque lumineux + halo,
                             silhouettes selon cadrage, néons) + interface FournisseurImages
generateur-voix.ts         — capture de profil RÉEL (f0 par autocorrélation, timbre par
                             8 bandes spectrales, débit par crêtes) + PORTE DE CONSENTEMENT
                             + synthèse paramétrique déterministe + écrivain WAV RÉEL
generateur-video.ts        — keyframes + animation interpolée (zoom entrant, panoramique
                             caméra) + écrivain AVI RÉEL (RIFF/avih/strl/strh/strf/movi/idx1,
                             DIB 24 bits bottom-up) + interface FournisseurVideo
facade-multimodale.ts      — un prompt → image + audio + vidéo, niveaux de réalisme honnêtes
multimodal.test.ts         — 16 tests : chaque fichier produit est DÉCODÉ
```

**Doctrine des niveaux de réalisme** (assumée honnêtement, testée) :
- `structurel-local` — générateurs TypeScript purs du dépôt : fichiers réels (PNG/WAV/AVI décodables par tout lecteur), composition, éclairage, animation et prosodie réelles — mais PAS photoréalistes et ils ne le prétendent pas.
- `photoréaliste-réseau` — un moteur réel branché par interface (`FournisseurImages` / `FournisseurVoix` / `FournisseurVideo`) reçoit le même plan de scène et renvoie le média ; la livraison est alors étiquetée `photoréaliste-réseau` avec le nom du fournisseur. **La preuve branchée est livrée** (section 4) : le back-end réel de ce laboratoire (diffusion + TTS neuronal + vidéo générative avec audio) a produit image photoréaliste, voix naturelle et vidéo cinématique via le même pipeline.

## 2. Preuves par décodage réel (pas des assertions déclarées)

- **PNG** : signature vérifiée, CRC32 de chaque chunk RECALCULÉ par le test (implémentation indépendante), dimensions exactes, pixels décompressés (zlib) et analysés : déterminisme octet à octet (même plan → mêmes octets), influence mesurée de l'éclairage (moyenne de luminosité plein-jour > nuit × 1.2).
- **WAV** : en-têtes RIFF/WAVE/fmt/data valides, fréquence 22 050 Hz, durée cohérente avec les échantillons, déterminisme octet à octet.
- **Profil de voix** : f0 MESURÉE par autocorrélation (fenêtre test 180 Hz → profil capté 150–220), timbre = 8 bandes normalisées (somme = 1), débit par crêtes d'énergie. **Ressemblance mesurable** : deux profils (90 Hz grave / 260 Hz aigu) → sorties acoustiquement distinctes — énergie à 90 Hz ×20 plus forte pour la voix grave, et **centroïde spectral** (barycentre d'énergie 60–4000 Hz) > ×1.5 pour la voix aiguë.
- **AVI** : structure RIFF parsée par le test (hdrl → avih → LIST strl → strh → strf, movi, idx1), nombre de frames exact, fps exact, index cohérent (16 entrées '00dc' = 16 chunks movi), durée = frames/fps. **Animation PROUVÉE** : zoom entrant (t=0 vs zoom 1.8) → >2 % des pixels changent de >12 unités ; panoramique (décalage caméra 40 px) → >500 pixels changent.
- **Porte de consentement** : `capturerProfilVoix` REFUSE tout échantillon sans consentement enregistré (`accordee: false` → erreur « Consentement requis ») — aucune imitation d'une voix sans autorisation ; la règle est dans le schéma ET dans le code.

## 3. Ce que « ressembler à la voix à copier » signifie honnêtement

La capture mesure trois grandeurs acoustiques réelles de l'échantillon fourni : **hauteur** (f0 médiane), **timbre** (enveloppe spectrale en 8 bandes), **débit** (crêtes/seconde). La synthèse paramétrique rend le texte **modelé par ces trois grandeurs** — la ressemblance est mesurable sur les mêmes grandeurs (tests). C'est une reproduction acoustique paramétrique, PAS un clonage neuronal complet (qui exige un moteur TTS entraîné sur la voix) : l'interface `FournisseurVoix` reçoit `(texte, profil)` exactement pour brancher ce moteur — avec consentement obligatoire enregistré dans le profil, sans quoi la capture refuse.

## 4. Démonstration branchée sur de vrais moteurs (ce laboratoire)

Fichiers réels produits par les backends réels via le pipeline de plans de scène :

| Fichier | Contenu | Taille |
|---|---|---|
| `gen3-demo-multimodal/image-photorealiste-gen3.png` | Pêcheuse à l'aube sur le fleuve Congo, heure dorée, brume — photoréaliste (diffusion) | ~147 Ko |
| `gen3-demo-multimodal/voix-gen3.wav` | Présentation de Gen3 par voix TTS neuronale naturelle (français) | ~1,3 Mo |
| `gen3-demo-multimodal/video-photorealiste-gen3.mp4` | Scène cinématique complète animée (génération vidéo avec audio IA) | cf. job |

Ces livrables sont étiquetés `photoréaliste-réseau` dans la doctrine ci-dessus : le même `planifierScene()`/`planifierVideo()` alimente soit les générateurs structurels locaux (déterministes, hors ligne), soit ces moteurs réels (réalisme réseau). Brancher le back-end de production de Gen3 sur ces interfaces est un choix d'infrastructure — les contrats sont testés des deux côtés.

## 5. Corrections de bugs trouvés par les tests (preuve que les tests vérifient vraiment)

1. **Sortie verbeuse du solveur** (héritée) : valeur finale seule extraite pour les chaînes composables.
2. **Mapping timbre→gain** : `floor(freq/500)` tombait hors bandes (260 Hz → bande 150 Hz) → centre de bande le plus proche en distance.
3. **Parseur de test AVI** : la pile rejouait les chunks après pop (frames comptées ×3) → parcours plat, une seule visite par chunk ; LIST `strl` imbriquée descendue pour lire le fps dans `strh`.
4. **Panoramique** : le décalage caméra était ignoré par le ciel (uniforme) → appliqué au disque lumineux ET aux silhouettes (les sujets défilent réellement).
5. **Bruit de souffle** : `Math.random()` cassait le déterminisme → LCG seedé par le texte.

## 6. Limites honnêtes

1. Le niveau `structurel-local` est une **esquisse compositionnelle** (silhouettes, dégradés) — le photoréalisme local n'est pas atteignable sans réseau de neurones diffusion ; la doctrine l'étiquette ainsi et les tests l'exigent.
2. La synthèse paramétrique reproduit f0/timbre/débit — une voix clonée au sens complet exige un moteur TTS neuronal branché (interface prête, consentement requis).
3. La vidéo structurelle est en **AVI non compressé** (réaliste en animation, pas en rendu) — le niveau `photoréaliste-réseau` passe par le fournisseur branché (démo mp4 produite).
4. Les backends réels (diffusion/TTS/vidéo) sont des **services distants** : leur disponibilité et leurs quotas dépendent du fournisseur ; le repli structurel local garantit une sortie réelle en toute situation.

## 7. Fichiers livrés

```
lib/neural/multimodal/encodeur-prompt-scene.ts   lib/neural/multimodal/facade-multimodale.ts
lib/neural/multimodal/generateur-images.ts       lib/neural/multimodal/multimodal.test.ts (16 tests)
lib/neural/multimodal/generateur-voix.ts         docs/rapports/rapport-multimodal-gen3-2026-11-28.md
lib/neural/multimodal/generateur-video.ts        download/gen3-demo-multimodal/ (démo réelle)
```
