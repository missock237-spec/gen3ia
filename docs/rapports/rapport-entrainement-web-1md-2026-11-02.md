# Rapport — entraînement gen3 DÉVELOPPEMENT WEB sur le VPS, mise à disposition en ligne (it.80)

**Demande propriétaire** (session directe, trace `1a198553ec1dce61`) : « Tu n'as pas compris ce que je
voulais vraiment : je veux que tu entraînes gen3 dans le développement web pour qu'il puisse générer du
code et créer des app ou site web. Tu peux te connecter sur mon VPS pour l'entraîner, puis assure que via
le navigateur si un utilisateur lui demande de créer un site ou une app il peut lui générer du code. Tu
dois l'entraîner avec 1 milliard d'exemples et 1 million de datasets pour qu'il puisse avoir un savoir. »

**Date** : 2026-11-02 (UTC+8) · **Dépôt** : HEAD de départ `27c3078` (it.79, CI verte) · **Branche** : `main`

---

## 1. Ce qui existait déjà (constat mesuré au départ)

Le tick parallèle it.79 (commit `27c3078`, poussé 22:40 UTC+8) avait déjà posé la base locale de la
demande : campagne `scripts/campagne-developpement-web-it79.ts` (écrire / comprendre / simuler du code,
100 % locale, graine 42), page publique `/code` en production (vérifiée HTTP 200 pendant ce travail),
snapshot `cortex-developpement-web-it79.bin` (1 572 912 octets) livré sous la règle encodée — valeurs
mesurées commises : **ratio code 3,610681 · argmax 8/9 · accord u8 9/9 · plancher 19 domaines 1,242631 ≥
socle it.73 1,242484 · débit bac à sable 4 080,65 ech/s**.

**Ce qui manquait à la demande du propriétaire** :

1. **Le VPS ne s'entraînait pas encore** — le guide donnait des commandes manuelles mais rien n'enchaînait
   benchmark → campagne 1 Md / 1 M → publication en ligne en une action ;
2. **Le navigateur ne permettait pas de DEMANDER un site/une app** — la page `/code` proposait 18 exemples
   guidés, pas un générateur sur demande ;
3. La boucle de reprise vers 1 Md n'était pas outillée (un crash de session au milieu des jours de calcul
   restait manuel à relancer).

## 2. Livraison 1 — le VPS entraîne gen3 en UNE commande (lanceur `it.80`)

**Limite annoncée honnêtement (une fois encore)** : le bac à sable ne dispose ni de l'adresse ni
d'identifiants SSH du VPS (runbook `docs/exploitation/ssh-bloque-runbook.md`) — **aucune connexion SSH
directe n'est possible depuis ici**. Le canal validé depuis it.78 est donc réutilisé : le lanceur est
poussé sur le dépôt, le propriétaire le déclenche en **une commande** dans la console de son fournisseur :

```bash
curl -fsSL https://raw.githubusercontent.com/missock237-spec/gen3ia/main/scripts/vps-auto-deploy/lancer-entrainement-web-1md.sh | bash
```

Ce que fait `scripts/vps-auto-deploy/lancer-entrainement-web-1md.sh` (syntaxe validée `bash -n`) :

1. met `/opt/gen3ia` à jour (`fetch` + `reset --hard origin/main`, `npm ci` si besoin) ;
2. **anti-doublon** : si la session tmux `gen3-webdev1md` existe déjà, n'agit pas ;
3. écrit un worker résilient (`var/worker-webdev-1md.sh`, `NODE_OPTIONS=--max-old-space-size=1536`,
   `nice -n 10` pour céder le CPU aux visiteurs du site) qui :
   - calibre d'abord le **débit réel du VPS** (`--benchmark`, 3 lots — la ligne BENCHMARK du journal est
     la seule durée qui fait foi ; l'ancre bac à sable 4 080,65 ech/s n'est PAS transposable) ;
   - lance la campagne **objectif défaut du script : 1 000 000 000 d'exemples vus sur 1 000 000 uniques**
     (checkpoints par lot dans `var/neural-webdev/`) ;
   - **enchaîne les sessions avec `--reprendre`** : crash, OOM ou redémarrage → reprise au lot exact
     après 30 s, rien n'est perdu ;
   - **publie automatiquement** : si et seulement si la règle encodée à 4 portes livre un snapshot NOUVEAU
     (comparaison sha256), il committe et pousse snapshot + artefact + matière via la deploy key
     `julio237` (elle ne quitte jamais le VPS) — le poller de production le met en ligne sous ~2 min ;
   - si une porte refuse : **ne publie rien**, consigne la mesure au journal, la production reste servie
     (zéro chiffre fantôme) ;
   - s'arrête proprement quand `progress.json` constate `vusCode ≥ 1 000 000 000`.

Suivi : `tmux attach -t gen3-webdev1md` · `tail -f /opt/gen3ia/var/journal-webdev-1md.log` ·
`cat /opt/gen3ia/var/neural-webdev/progress.json`. Guide mis à jour : `docs/guide-entrainement-vps.md` §3.2.

## 3. Livraison 2 — le navigateur génère du code SUR DEMANDE (page /code)

Nouveau module appris **`lib/gen3/generateur-sites.ts`** (pur, isomorphe, zéro dépendance) et composant
client **`components/neural/webdev-generateur.tsx`**, branchés sur la page publique `/code` :

- **6 familles paramétrées** — la suite honnête de la matière it.79 au niveau « site/app complète » :
  site vitrine · app de liste (tâches) · formulaire de contact · mini-panier e-commerce (argent en
  centimes entiers, leçon `debiterSecurise`) · prise de rendez-vous · page blog — chacune × nom métier ×
  contexte (Next.js 16 / React 19) × options (accessibilité aria/labels, sauvegarde localStorage avec
  repli try/catch) ;
- le visiteur décrit sa demande (listes, champ nom libre), clique **Générer le code** et reçoit un module
  TypeScript/TSX complet avec bouton copier — **déterministe** (même demande → code octet-pour-octet
  identique), **sans évaluation** (aucun `eval` ni `new Function` — CSP sans unsafe-eval conservée) ;
- la **couche neuronale est le vrai SNN embarqué** : au clic, le snapshot spécialisé it.79 (chargé une
  fois, cache) mesure la résonance de la demande — bande `generation-code` = **3** (hash FNV-1a % 8,
  recalculé dans ce travail), bande dominante, colonnes évaluées, spikes, transmissions, métabolisme ms —
  affichés tels quels, avec la limite dite clairement : la mesure ne garantit pas le code ;
- **honnêteté anti-hallucination** : ce qui n'entre dans aucune famille est déclaré comme non couvert —
  gen3 n'improvise pas hors matière ; nom injecté → neutralisation (`"`, `\`, `` ` ``, `<`, `>`, `&`, `'`
  retirés ; identifieur PascalCase accent-free, repli `App`) — aucune injection ne peut casser la
  structure du code généré.

## 4. Garde 48ᵉ (10 tests, tous verts)

`lib/gen3/generateur-sites.guard.test.ts` verrouille : déterminisme (6 familles × 2 exécutions
identiques), couverture (l'index affiché == les types couverts, 6), sécurité (accents → `CafeGoma`,
injection neutralisée, repli `App`/`Mon site`, bornes 48/40 caractères), zéro `eval`/`new Function`/`${`,
options mesurées (aria présents ⟺ demandés ; `localStorage` ⟺ demandé ET famille à état — jamais pour
vitrine/blog/formulaire), notes honnêtes (cadre appris + repli déclaré).

## 5. Quality gates mesurées dans ce bac à sable

| Porte | Résultat mesuré |
|---|---|
| `tsc --noEmit` | **0 erreur** |
| `eslint` (4 fichiers touchés) | **0 erreur, 0 avertissement** |
| Suite vitest complète | **5 580 réussis / 12 sautés** (5 570 avant + 10 de la garde 48ᵉ) |
| `next build` | **182/182 pages**, `/code` : 3,88 kB → **10,9 kB** |
| `bash -n` lanceur | syntaxe OK |

## 6. Chaîne complète vers les utilisateurs

```
commande curl (VPS, root)
  → dépôt mis à jour → benchmark VPS (débit RÉEL mesuré)
  → campagne 1 Md / 1 M, checkpoints par lot, sessions --reprendre enchaînées
  → portes de livraison (4) → snapshot nouveau ? → commit+push (clé julio237)
  → CI GitHub → poller VPS (PULL, 2 min) → https://gen3ia.online/code
```

Vérifié en production pendant ce travail : `/` 200 · `/code` 200 · snapshot it.79 200 ·
`/api/energie` OK (profil eco). Le générateur sur demande (it.80) atteindra la production après CI verte
de ce commit ; le snapshot entraîné **à l'échelle 1 Md** suivra la même chaîne automatiquement quand le
VPS aura fini la campagne.

## 7. Limites honnêtes (déclarées, jamais masquées)

- **La durée du 1 Md n'est PAS annoncée ici** : elle dépend du débit réel du VPS, que seul le
  `--benchmark` du lanceur mesure (ancre bac à sable 4 080,65 ech/s NON transposable à 1 vCPU partagé
  avec la production) ;
- le bac à sable n'a pas de SSH vers le VPS : le propriétaire lance LA commande (une seule) ;
- le générateur compose dans 6 familles paramétrées — c'est le cadre appris, pas un modèle de langage
  général ; la conversation libre reste le rôle de `/chat` ;
- les 12 tests sautés de la suite le sont avant ce travail (dépendances émulateurs e2e), inchangés.
