# PROCÉDURES DE ROLLBACK — GEN3IA BRAIN

## 1. Rollback applicatif (code)

```bash
# Revenir au commit fusionné précédent (jamais de force-push sur main) :
git revert <sha_du_commit_coupable>   # revert explicite, PR de revert si étendu
# ou re-déploiement d'un tag connu-bon :
git checkout GEN3_INFRASTRUCTURE_STABLE_V1   # (tags de livraison, cf. rapport)
pm2 restart gen3ia
```

Le CD du dépôt redéploie main à chaque fusion — en cas de régression post-fusion,
`git revert` + push déclenche le même pipeline validé.

## 2. Rollback des paramètres appris (persistance versionnée)

Les paramètres du cerveau sont versionnés (`lib/neural/persistance-versions.ts`) :

```bash
# Lister les versions figées (manifestes SHA-256 vérifiables) :
npx tsx -e 'import {listerVersions, lireManifeste} from "./lib/neural/persistance-versions"; console.table(listerVersions().map(v => ({v, integre: lireManifeste(v)?.integre})))'
# Restaurer une version (rollback des paramètres appris) :
npx tsx -e 'import {restaurerVersion} from "./lib/neural/persistance-versions"; console.log(restaurerVersion("<version>"))'
pm2 restart gen3ia   # le cerveau recharge l'état restauré au boot
```

Garanties : un manifeste dont le SHA-256 ne correspond plus refuse le rollback
(fail-closed). La rotation `.bak` de la persistance v1 est un second filet.

## 3. Rollback du cerveau autonome (état du core)

- L'état du core vit dans `var/autonomous/` (etat.json, file des lots, mémoire) —
  sauvegarder avant intervention : `cp -r var/autonomous var/autonomous.bak-$(date +%s)`.
- Une restauration vide est sûre : au boot, le cœur reprend les tâches
  orphelines (RETRY→QUEUED) et reconstruit son état ; les sources conservent
  leurs débits.

## 4. Vérification post-rollback

1. `curl -f https://gen3ia.online/api/neural/brain` → stats du cerveau chargé.
2. `pm2 logs gen3ia --lines 50` → armement des 5 modules (AUTO_CORE/COLLECTE/CONTINU/SKILLS).
3. `/admin/autonomous` → santé du core, cycles, file, mémoire.
4. `npm run brain:eval` → score global du banc indépendant (comparé au dernier rapport connu).

## 5. Endurance 72 h

Commande (VPS, process permanent PM2) :
`ESSAI_HEURES=72 npx tsx --conditions=react-server scripts/essai-continu.ts`
Checkpoints à chaque observation (60 s), reprise après interruption (compteur
cumulé), resume.json final avec RAM pic et charge. Session bornée de référence :
`var-copie/essai-continu/` (sandbox).
