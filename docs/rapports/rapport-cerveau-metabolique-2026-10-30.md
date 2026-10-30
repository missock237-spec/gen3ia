# Rapport — Cerveau métabolique + Agent live sous le chat

**Demande directe du propriétaire (2026-10-30 ~12:30 +08:00)** · Commit `bbcc70b` · main → prod vérifiée
Précédé de : it.41 (`82900b1`, tick 11:10 — suppression /ai/generate). Ce rapport couvre la demande HORS tick cron.

---

## 1. La demande (verbatim, 2 volets)

1. « Maintenant le système agent live doit passer sous le chat pour l'activer dans le chat. »
2. « Je veux que tu crées un serveur à gen3 qui pourra fonctionner comme un cerveau humain tout en consommant une très faible quantité d'énergie ou de capacités mais on conserve de grande capacité et qualité de ses résultats — modifie l'architecture actuelle puis assure-toi que le système neuronal fonctionne ainsi. »

## 2. Livraison A — Agent live sous le chat

**Avant** : l'agent live vivait uniquement sur la page dédiée `/live` (tableau de bord + panneau Gemini Live). Pour l'activer, il fallait quitter la conversation.

**Après** (demande appliquée littéralement) :
- **6ᵉ commande « Agent Live »** dans le composer du chat (`nova-chat.tsx`), à côté d'Outils / Effort / Recherche web ;
- clic → **voile plein écran modal** (`role="dialog"`, `aria-modal`, fermeture par fond, croix) qui embarque **le VRAI panneau Gemini Live** (`@/app/live/live-gemini-panel` — écran PC / caméra Android + voix, clé API dans le sessionStorage du navigateur, jamais côté serveur) ;
- **chargement LAZY** (`next/dynamic`, `ssr:false`) : chunk séparé — aucun octet de la pile Gemini Live ne pèse sur le chat tant que l'utilisateur n'active pas (cohérence avec le volet métabolique) ;
- lien honnête vers le tableau de bord complet `/live` (page conservée, exigence 5 intacte — `services/live-agent/` non touché) ;
- **verrou structurel Exigence 6** (`tests/unit/nova-dashboard.test.ts`) : bouton, voile, lazy, accessibilité, CSS — toute régression future échoue en CI.

**Preuve production (agent-browser sur https://gen3ia.online/chat)** : bouton présent → clic → dialog « Agent live » avec le panneau réel (« Démarrer Live (écran + voix) ») → fermeture propre → **0 erreur console**.

## 3. Livraison B — Le cerveau métabolique (architecture « cerveau humain »)

### 3.1 Diagnostic avant modification

Le SNN Gen3 (`lib/neural/core/network.ts`) était fidèle à la source Python mais **métaboliquement humain seulement en apparence** : chaque `step()` scannait **tous** les neurones (O(N)) et **toutes** les synapses (O(S) ≈ 1 906 pour 140 neurones), même sans aucune activité — l'inverse d'un cerveau biologique (≈ 20 W pour 86 milliards de neurones : il ne paie que les spikes réels).

### 3.2 Deux mécanismes, fidélité mathématique préservée

1. **Propagation événementielle (index inverse)** : `Map<sourceId, Synapse[]>` construite paresseusement (reconstruite uniquement quand la longueur des synapses change — capte constructeur, `importState`, `importStateEtendu`, pushes directs du trainer/runtime). Seules les synapses des neurones qui SPIKENT transmettent : coût O(spike×degré) au lieu de O(S).
2. **Repos neuronal** : un neurone d'énergie nulle sans stimulation externe est sauté (`0 × (1−decay) = 0`, aucun spike possible — bit-exact ; seule sa `stateHistory`, non utilisée en production, n'est plus alimentée).

**Équivalence prouvée par test** (`network-metabolisme.test.ts`) : un `stepDense` (réplique exacte de l'ancien algorithme) et le nouveau pas événementiel sont exécutés sur des réseaux identiques (3 seeds, 12 pas, entrées variables) → **spikes, énergies, poids et lastActivation BIT-À-BIT identiques** (`toBe`, pas de `toBeCloseTo`).

### 3.3 Compteur métabolique (preuve mesurable, jamais estimée)

- `MetabolismePas` (par pas : évalués / reposés / spikes / transmissions / synapsesDenses) + `MetabolismeCumul` (cumul + transmissionsEvitees) dans `lib/neural/core/types.ts` ;
- `CycleReport.metabolisme` (noyau central) → **`raw.metabolisme` par tour** dans le moteur (`MetabolismeTour` : somme exacte des cycles + `tauxActivite`) ;
- consommateurs réels (garde anti-code-mort satisfaite **sans nouvel endpoint**) : `/api/neural/cycle` (spread de `raw` existant) et `/api/neural/brain` (cumulé) → **carte « Métabolisme cérébral »** dans la console `/neural` (% d'économie mesurée) + ligne métabolisme sous chaque réponse du cerveau.

### 3.4 Mesure réelle (scénario type tour de chat)

Réseau 140 neurones / 1 906 synapses (seed 42), volée de 16 tokens encodés + fusion résonance RPIA (chemin réel), 4 cycles :

| Indicateur | Scan dense (avant) | Événementiel (après) | Économie |
|---|---|---|---|
| Transmissions synaptiques | 7 624 | **60** | **99,2 %** |
| Évaluations neuronales | 560 | **176** | **68,6 %** |

Le pas sans entrée sur réseau frais coûte **zéro évaluation et zéro transmission** (140/140 neurones au repos) — la veille profonde ne coûte presque rien.

### 3.5 Décision RPIA — early-exit implémenté puis rejeté sur mesure

Conformément au principe « ne pas recycler un problème résolu », un early-exit de plateau a d'abord été écrit, puis **calibré empiriquement** : la courbe d'erreur RPIA **oscille** (interférence d'ondes) et ses minima apparaissent **tard** (encore en amélioration entre les époques 100 et 120 ; +2,3e-2 d'erreur finale si l'on coupe à 25 époques sur cible sinusoïdale ; le test existant 200 époques échouait). **Revert propre** — le budget complet d'époques EST le métabolisme correct de cette couche ; la décision est documentée dans `entrainement-rpia.ts` et **le comportement RPIA est strictement inchangé** (aucune perte de qualité).

### 3.6 Pourquoi la qualité est conservée

- **Chat** : même nombre de cycles (4), même encodage, même résonance RPIA, même décodage — seule la manière de dépenser change, pas le calcul (équivalence bit-à-bit testée) ;
- **Cortex/hippocampe/évolution** : intacts ;
- **5306/5306 tests** (+8 nouveaux), tsc 0, eslint 0, garde anti-code-mort inchangée (0 nouveau endpoint orphelin).

## 4. Validation et livraison

| Étape | Résultat |
|---|---|
| vitest complet | **5306/5306** (+8, 473 fichiers, 12 skipped) |
| tsc / eslint | 0 / 0 |
| CI GitHub | 13/13 success (`bbcc70b`) |
| CodeQL / Guérisseur / Surveillance | success |
| deploy-vps | 221ᵉ run success |
| prod `version.json` | **gitSha bbcc70b** (rattrapage < 2 min — 16ᵉ point vert poller) |
| sonde régression | **10/10** (3,7 s) |
| Vérification navigateur (prod) | bouton → voile → panneau réel → fermeture, 0 erreur console |

## 5. Limites honnêtes et suites

- La console `/neural` exige une session authentifiée : la carte métabolisme est vérifiée au niveau code + verrou vitest (pas en navigateur, faute de compte de test) ;
- l'économie mesurée (99,2 % transmissions) concerne un réseau peu entraîné ; un cerveau entraîné spicera davantage — le coût restera **proportionnel à l'activité** (c'est le principe), jamais à la taille ;
- le panneau live embarqué requiert la clé API Gemini opérateur (inchangé vs `/live`) ;
- suites proposées : extension du métabolisme aux effecteurs (coût par outil réel), élagage synaptique de consolidation (sommeil) — à décider sur une prochaine demande.

*Rappels owner en cours : rotation PAT (n°42), #109 poller (6 commentaires), sauvegardes it.23, PR #100–#103, phases #95–#97.*
