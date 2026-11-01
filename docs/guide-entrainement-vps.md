# Guide — Entraîner gen3 sur votre propre VPS (AlmaLinux)

> Demande propriétaire (it.65) : « l'entraînement s'exécute depuis son propre
> serveur local ». Ce guide prépare un VPS AlmaLinux (typ. 1 vCPU / 2 Go RAM)
> comme **serveur d'entraînement dédié** — règle SNN respectée : tout tourne
> en local, zéro service d'IA externe.

## 1. Installation (2 commandes, console fournisseur, root)

```bash
curl -fsSL https://raw.githubusercontent.com/missock237-spec/gen3ia/main/scripts/vps-auto-deploy/preparer-entrainement-gen3.sh -o preparer.sh
bash preparer.sh
```

Le script est **idempotent** (relançable sans risque) et effectue : outils de
base, Node.js 22 LTS (engines `>=20.9.0 <23`), swap 4 Go (indispensable sur
2 Go de RAM), rangement de la clé SSH `julio237` générée dans la console,
clone du dépôt public dans `/opt/gen3ia`, `npm ci`, vérification du noyau
neuronal v2, et écrit `/opt/gen3ia/COMMANDES-ENTRAINEMENT.md`.

Si `GITHUB_TOKEN` est exporté avant l'exécution, la deploy key
`julio237.pub` est ajoutée automatiquement à
`github.com/missock237-spec/gen3ia/settings/keys` (lecture/écriture) ;
sinon la clé publique est affichée — copiez-la dans l'interface web GitHub.

## 2. Session persistante (console téléphone)

```bash
tmux new -s gen3        # démarrer ; se détacher : Ctrl-b puis d
tmux attach -t gen3     # se rattacher plus tard (session survit à la déconnexion)
```

## 3. Commandes d'entraînement

| Commande | Rôle | Reprise |
|---|---|---|
| `npx tsx scripts/preentrainement-million.ts --benchmark` | Calibrer le débit réel de CE serveur | — |
| `npx tsx scripts/preentrainement-million.ts` | **Session million : 19 domaines × ≥ 1 000 000 échantillons** (corpus procéduraux de la charte + datasets du dépôt) | `--reprendre` |
| `HF_TOKEN=hf_xxx npx tsx scripts/preentrainement-million.ts --reprendre` | Ajoute les sources RÉELLES Hugging Face (MedQuad, KisanVaani, legalbench) | `--reprendre` |
| `npx tsx scripts/campagne-telephone-it77.ts` | Cortex téléphone : supervision EOD + alignement inférence + sondes + quantification u8 (snapshot conditionnel) | relançable |
| `npx tsx scripts/entrainement-questions-gen3.ts` | Questions/réponses au sein du cadre d'apprentissage | relançable |
| `npx tsx scripts/pretrain-masse-1m-it63.ts` | Campagne masse historique (checkpoints toutes les 25 époques) | relancer = reprendre |

Environnement recommandé : `export NODE_OPTIONS="--max-old-space-size=1536"`.

## 4. Où sont les résultats

| Emplacement | Contenu |
|---|---|
| `assets/neural-pretrained/*.json` | Rapports honnêtes des campagnes (échantillons réellement traités, sondes, durées) |
| `var/neural-million/`, `var/neural/` | Checkpoints du cortex v2 et du champ cortical (hors git) — la reprise lit ici |
| `public/neural/cortex-telephone-*.bin` | Snapshots quantifiés livrés aux utilisateurs (écrits SEULEMENT si la règle de livraison est satisfaite) |

Référence mesurée : la session million commise
(`assets/neural-pretrained/preentrainement-eod-million-19-domaines.json`)
totalise **19 182 944 échantillons** pour 19 domaines, exécutée « par appels
successifs avec reprise par checkpoint » — c'est le mode d'emploi normal,
pas un contournement : sur 1 vCPU, lancez la session en plusieurs
poussées, `--reprendre` poursuit exactement là où la mesure s'est arrêtée.

## 5. Attentes honnêtes sur 1 vCPU / 2 Go

- `npm ci` : 10-20 min. La RAM + swap suffisent ; aucun `next build` n'est
  nécessaire pour l'entraînement (les scripts tournent sous `tsx`).
- La session million est longue par nature (~19,2 M échantillons) : le
  `--benchmark` d'abord, puis des sessions tmux successives avec
  `--reprendre`. Aucune estimation de durée n'est annoncée ici — seule la
  mesure du benchmark sur VOTRE serveur fait foi.
- Ce serveur d'entraînement est indépendant du serveur de production
  `gen3ia.online` (mode PULL). Si vous voulez PLUS TARD que ce VPS serve
  aussi l'application, utilisez `scripts/vps-auto-deploy/install-pull-mode.sh`
  (le build Next est fait par le runner GitHub — un VPS de 2 Go ne peut
  pas le faire lui-même) ; les deux rôles cohabitent sans conflit.

## 6. Sécurité

- La clé **privée** `julio237` ne quitte jamais le VPS ; seule `.pub` est
  copiée sur GitHub (deploy key limitée à ce dépôt).
- Le script n'affiche et ne stocke aucun jeton : exportez `GITHUB_TOKEN`
  vous-même au moment de l'exécution, il est retiré de l'environnement
  après usage.
- Le script ne touche pas à `/opt/gen3ia-updater` : si ce VPS héberge
  aussi le poller de production, il reste intact.
