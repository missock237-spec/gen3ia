# Plan d'entraînement multimodal par ondes — gen3

*2026-11-08 — branche gen3-ondes-multimodal. Fait suite à l'analyse du dépôt et à la demande : conversation naturelle, analyse d'artefacts, images photoréalistes, vidéos réalistes, voix humaine réaliste, réflexion autonome — le tout 100 % interne.*

---

## 1. Principe directeur — les ondes décident, les organes exécutent

Gen3 est un SNN à ondes : la méthode EOD (it.57, `docs/entrainement/methode-ondes.md`) convertit chaque texte en **signature d'ondes** (paquets `[fréquence, phase, amplitude]`), stimule le cortex columnnaire v1M **par les ondes** (`colonne = f(sin φ, ω)`), puis consolide par plasticité supervisée vers la **bande-porteuse du domaine** et par le **bus d'ondes inter-régions** (renfort en phase, annulation en opposition).

Les capacités multimédias demandées ne remplacent pas ce substrat — elles s'y **branchent** :

```
                       ┌───────────────────────────────┐
 Message / artefact →  │  CERVEAU GEN3 (ondes, SNN)    │
                       │  intentions + domaines EOD +  │
                       │  orchestrateur de raisonnement│
                       └───────────────┬───────────────┘
         ┌───────────────┬─────────────┼────────────────┐
         ▼               ▼             ▼                ▼
   Cortex langagier  Percepteur    Effecteur        Effecteur
   (corpus + Gemma3  multimodal    MÉDIA (pont GPU) autonomie
   auto-hébergé)     (Gemma 3 IT)  SDXL / F5-Kokoro (agents, loop.ts,
                   analyse d'images  / LTX-Video     orchestrateur)
```

Deux voies d'entraînement, complémentaires et **déjà outillées dans le dépôt** :

| Voie | Substrat | Outil | GPU ? |
|---|---|---|---|
| **A — Ondes (EOD)** | cortex v1M + bus d'ondes | `POST /api/neural/train` (source ondes) | Non |
| **B — Modèles auto-hébergés** | Gemma 3 / SDXL / F5-TTS / LTX-Video | packs `training/` + notebooks Colab | Oui (L4/A100) |

---

## 2. Voie A — Entraîner le SNN par ondes (disponible immédiatement)

Les quatre nouveaux domaines du dataset `datasets/multimodal_ondes/train.jsonl` reçoivent **automatiquement** leur bande-porteuse (`bandeDuDomaine` : hash FNV-1a du label → porteur ω ∈ {0.25 … 1.75}) — la méthode s'étend sans changement de code, comme prévu par it.57.

```http
POST /api/neural/train
{
  "source": "ondes",
  "domainesOndes": ["analyse_multimodale", "generation_image", "voix_parole", "video_realiste"],
  "cyclesParEchantillon": 3,
  "lrBoost": 0.15,
  "maxParDomaine": 200
}
```

Le rapport rendu est honnête : échantillons traités, résonance moyenne du porteur, paquets émis, renforts/annulations du bus, métabolisme cumulé. La persistance sauvegarde le cortex v1M **et** la modulation régionale du champ — le cerveau retient ses ondes entre les redémarrages.

Avant toute session : recalculer les content_hash du dataset :

```bash
node scripts/gen3_ondes_finaliser_dataset.mjs datasets/multimodal_ondes/train.jsonl
node scripts/gen3_ondes_finaliser_dataset.mjs --check datasets/multimodal_ondes/train.jsonl
```

---

### Injection de la mémoire ondes multimodales (it.58)

L'option `ondesMultimodales` du job (`lib/neural/training/job.ts`, câblée — **FAIT**) complète les datasets JSONL par des échantillons **SYNTHÉTIQUES** adressables (grammaires métier — cf. `datasets/multimodal_ondes/INFINI.md`) :

```json
{
  "source": "ondes",
  "domainesOndes": ["generation_image"],
  "maxParDomaine": 2000,
  "ondesMultimodales": { "debut": 7488960, "quantite": 1000 }
}
```

**Honnêteté** : les synthétiques sont tracés dans `job.ondesMultimodales` (`nature: "synthetique"`, `source: "memoire-ondes-multimodales"`, répartition par domaine et par langue, quantité demandée vs réellement injectée après bornes et filtre de domaines) — **jamais** comptés dans `statsDomaines`, qui décrit uniquement les datasets JSONL commis. Le log de fin de job porte le décompte explicite « dont N SYNTHÉTIQUES ». La session EOD applique ensuite son propre cap par domaine (`maxParDomaine`, plafond dur 2 000). Bornes de l'API : `debut ∈ [0, 5 665 359 359]`, `quantite ≤ 50 000` par injection. Couvert par le test d'intégration `lib/neural/training/job.test.ts` (3ᵉ cas).

---

## 3. Voie B — Entraîner les organes GPU (Colab L4/A100, packs existants)

### gen3-core (conversation naturelle + analyse d'artefacts)

```bash
cd training/gen3-core
pip install -r requirements.txt
python scripts/validate_dataset.py data
python train_multimodal.py --profil auto --max_hours 6 --resume_from_checkpoint outputs/gen3-core-lora/checkpoint-XXXX
python bench_multimodal.py --adapter outputs/gen3-core-lora/final_adapter --comparer
```

Base Gemma 3 (4B profil L4 / 12B profil A100). Accepter la licence Google sur le Hub avant le premier entraînement (token HF dans les Secrets Colab).

### gen3-media-pack (images, voix, vidéos)

```bash
cd training/gen3-media-pack
python train_image_sdxl.py --profil auto      # images photoréalistes
python train_tts_f5.py --profil auto           # voix FR (⚠ CC-BY-NC → Kokoro si commercial)
python train_video_ltx.py --profil auto        # clips 2-5 s (LTX 0.9.7)
python bench_media.py                          # latence/RTF réels
MEDIA_BRIDGE_API_KEY=... python bridge/gen3_media_bridge.py --port 8787
```

Notebook prêt : `training/colab/gen3ia_gpu_media_training.ipynb` (secrets : `HF_TOKEN`, `GITHUB_TOKEN` ; checkpoints synchronisés vers Drive, reprise après coupure).

---

## 4. Intégration plateforme (VPS 2 Go sans GPU)

1. **Machine GPU** : lancer le pont (`gen3_media_bridge.py`) — il expose `/capabilities`, `/v1/image`, `/v1/tts`, `/v1/video` (média en base64, clé en temps constant, borne 30 min).
2. **Plateforme** : **FAIT** — `MEDIA_BRIDGE_URL` + `MEDIA_BRIDGE_API_KEY` sont lus par le runtime (`configPontMediaDepuisEnv()` dans `lib/neural/runtime.ts`) et injectés au constructeur pur de `EffecteurMediaBridge` (`lib/neural/effectors/media-bridge.ts`), qui est enregistré au noyau à chaque démarrage. Sans l'une des deux variables (les DEUX sont requises), l'effecteur déclare honnêtement `PONT_NON_CONFIGURE` — la mécanique (gating résonance ≥ 0.80, Tool OS, métriques) reste 100 % réelle ; la clé n'est jamais loggée. Couvert par les tests : `lib/neural/effectors/media-bridge.test.ts` (fetch injecté, 21 cas).
3. Le média reçu est archivé en R2 (chemin permanent utilisateur) puis servi au client ; `/capabilities` ne déclare que ce qui tourne réellement.
4. Sans pont configuré, chaque action retourne `PONT_NON_CONFIGURE` — la page Capacités et limites continue d'afficher la vérité.

Reste opérationnel (hors code) : renseigner les deux variables dans l'environnement du VPS (`.env`, cf. §5 étape 5) une fois la machine GPU en ligne.

---

## 5. Ordre d'exécution recommandé

1. Finaliser le hash du dataset (script ci-dessus) — 1 min.
2. Session EOD sur les 4 domaines (voie A) — quelques minutes sur le VPS.
3. Colab gen3-core : train + bench `--comparer` (preuve chiffrée du gain) — sessions de 6 h.
4. Colab media-pack : image → voix → vidéo, bench_media après chaque — 1 à 2 jours.
5. Brancher le pont : l'injection runtime et le test unitaire du stub fetch sont **commités** — il reste à renseigner `MEDIA_BRIDGE_URL`/`MEDIA_BRIDGE_API_KEY` sur le VPS puis tester les trois `/v1/*` contre le pont réel (et `/capabilities` pour la sonde honnête).
6. Itérer : bench → faiblesses → nouveaux échantillons → ré-entraînement (la seule boucle honnête).

---

## 6. Licences (à respecter avant commercialisation)

- **SDXL 1.0** : OpenRAIL++-XL — commercial autorisé avec restrictions d'usage.
- **LTX-Video 0.9.7** : LTXV Open Weights — commercial sous plafond de revenus.
- **F5-TTS** : CC-BY-NC-4.0 — **non commercial** ; voie Kokoro (Apache-2.0) fournie en alternative.
- **Gemma 3** : licence Google à accepter sur le Hub (token HF).

---

## 7. Limites honnêtes

- Le saut réaliste est de ~2/10 à ~6/10 en génération multimédia — pas Gemini/Veo, qui tournent sur des centaines de milliers d'heures GPU.
- Le corpus gen3-core (792k) est textuel : gen3 écrit les prompts/briefs/storyboards, les moteurs spécialisés produisent les fichiers.
- La piste AV-DiT « ondes » (`train_av_neural.py`, VAE audio sur la vraie waveform) reste **expérimentale** — des heures de GPU ne suffisent pas au photoréalisme from scratch.
- Aucune métrique inventée : chaque capacité est prouvée par `bench_multimodal.py` / `bench_media.py` / `GET /capabilities`.

---

## 8. Références

- Méthode ondes : `docs/entrainement/methode-ondes.md` — implémentation : `lib/neural/training/entrainement-ondes.ts`
- Bus d'ondes : `lib/neural/core/v2/bus-ondes-regions.ts` — champ cortical : `lib/neural/core/v2/champ-cortical.ts`
- Effecteur pont : `lib/neural/effectors/media-bridge.ts` — tests : `lib/neural/effectors/media-bridge.test.ts` — pont GPU : `training/gen3-media-pack/bridge/gen3_media_bridge.py`
- Dataset : `datasets/multimodal_ondes/` (MANIFEST + train.jsonl, hash via `scripts/gen3_ondes_finaliser_dataset.mjs`)
- Mémoire ondes multimodales : `lib/neural/generation/memoire-ondes-multimodales.ts` — injection au job : `lib/neural/training/job.ts` (option `ondesMultimodales`)
