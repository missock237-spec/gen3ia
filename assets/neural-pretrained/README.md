# assets/neural-pretrained/ — artefacts d'amorçage neuronal

Artefacts de pré-entraînement du moteur Gen3 (SNN local). Ils sont chargés
**au démarrage du runtime** (`lib/neural/runtime.ts`) pour amorcer le cortex
columnnaire v2 avec un état appris hors production, avant que la boucle de
maîtrise en ligne (`lib/entrainement-auto/`) ne le consolide.

## Contenu du dossier

| Fichier | Versionné ? | Rôle |
|---|---|---|
| `cortex-v2.bin` | **NON** (≈ 12 Mo, gitignored) | Poids du cortex columnnaire v2 + champ cortical (sérialisation binaire v2, cf. `lib/neural/core/v2/persistance-v2.ts`) — généré par `scripts/pretrain-cortex-v2.ts` |
| `multimodal-lexique-v1.json` | oui | Lexique multimodal appris hors production (chargé au runtime par `lib/neural/generation/lexique-serveur.ts`) |
| `pretrain-report.json` | oui | Rapport du pré-entraînement cortex v2 (précision train/test, époques) |
| `pretrain-multimodal-report.json` | oui | Rapport honnête du pré-entraînement multimodal |

> **Pourquoi `cortex-v2.bin` n'est plus versionné ?** À ≈ 12 Mo, il alourdissait
> chaque clone et chaque exécution CI. Il est désormais **hors dépôt git** :
> le runtime fonctionne SANS lui (repli propre : « cortex columnnaire amorcé
> à neuf », cf. `lib/neural/runtime.ts`), et l'état appris en production est
> persisté à part dans `var/neural/cortex-v2.bin` (lui aussi jamais committé).

## Récupérer `cortex-v2.bin`

### Option 1 — script de téléchargement (recommandé)

```bash
bash assets/neural-pretrained/download-model.sh
```

Le script télécharge l'artefact depuis le stockage objet du projet
(Cloudflare R2) et vérifie son empreinte SHA-256. L'URL est surchargable via
`GEN3IA_CORTEX_V2_URL` (utile en CI ou pour un miroir).

> ⚠️ **URL placeholder** : tant que le client n'a pas publié l'artefact sur
> son bucket R2/S3, la variable `GEN3IA_MODEL_BASE_URL` (ou l'URL par défaut
> du script) doit être renseignée avec l'URL réelle de diffusion. Voir
> recommandations dans `docs/multimodal/gen3-multimodal.md` et le rapport de
> la tâche hygiène (2026-10-23).

### Option 2 — régénérer localement

```bash
npx tsx scripts/pretrain-cortex-v2.ts
```

Régénère `assets/neural-pretrained/cortex-v2.bin` + `pretrain-report.json`
(hors production — à exécuter en sandbox/CI, jamais sur le VPS).

## Empreinte de référence

Artefact du dépôt historique (dernière version suivie par git, avant
déversionnage, SHA du commit 590ddc70) :

```
SHA-256  000ff807b988a91c5b7c1862ee15ab2c28eea058203a12f6d8721bbeab91cc14
Taille   12 586 950 octets (≈ 12 Mo)
```

Tout artefact téléchargé dont l'empreinte diffère est soit un
ré-entraînement plus récent (legitime — vérifier alors `pretrain-report.json`
accompagnateur), soit un fichier corrompu (le script de téléchargement
échouera).

## Impact déploiement

- **Build Next.js** : aucun — le binaire est lu au *runtime* via
  `readFileSync` (jamais importé au build) ; `npm run build` n'en dépend pas.
- **VPS existant** : la copie locale de `/opt/gen3ia/assets/neural-pretrained/`
  est préservée par le CD (`git reset --hard` ne supprime pas les fichiers
  non suivis) — la production continue de charger l'état pré-entraîné.
- **Nouvelles installations** : sans le fichier, le runtime démarre avec un
  cortex v2 neuf (repli non fatal, message `[NEURAL-V2] Cortex columnnaire
  amorcé à neuf`) puis réapprend en ligne.
- **Historique git** : l'objet lourd reste dans l'historique (aucune
  réécriture effectuée). L'espace sera récupéré plus tard par une opération
  dédiée (ex. `git filter-repo`) si le client le souhaite.
