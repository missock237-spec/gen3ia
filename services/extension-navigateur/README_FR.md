# gen3ia — Extension navigateur (nœud de l'essaim) — MV3

Le nœud **navigateur** de l'essaim gen3ia (plan d'amélioration E-P0, 2026-10-24).
L'extension ouvre le chat Gen3 dans un panneau latéral sur n'importe quelle
page, exécute localement les tâches de ses spécialités, et remonte chaque
compte rendu au cortex (règle absolue de l'essaim : tout passe par Gen3).

## Installation (Chrome / Edge / Brave)

1. Ouvrir `chrome://extensions`
2. Activer **Mode développeur** (coin haut-droit)
3. **Charger l'extension non empaquetée** → sélectionner ce dossier
4. Cliquer sur l'icône gen3ia → renseigner :
   - **Instance** : `https://gen3ia.online` (ou `http://localhost:3000` en dev)
   - **Clé développeur** : `g3a_…` (créée depuis le portail développeur `/developer`)
   - **ID de projet** : le projet lié à la clé (header `X-Gen3ia-Project-Id`)
5. Ouvrir le **panneau latéral** depuis l'icône → discuter avec gen3.

## Confidentialité (contrat du nœud navigateur)

- Le contenu d'une page ne quitte JAMAIS le navigateur sans action
  explicite : case « Joindre la page courante » ou tâche d'essaim demandée.
- La clé `g3a_` est stockée dans `chrome.storage.local` et ne transite QUE
  vers l'instance gen3ia configurée (aucun tiers, aucune télémétrie).
- Aucun historique de navigation, aucune collecte en arrière-plan.
- Les tâches d'essaim (Sentinelle/Trieur/Calculateur) s'exécutent
  **localement** dans l'onglet ; seul le COMPTE RENDU synthétique est envoyé
  au cortex (`POST /api/v1/chat`).

## Architecture

| Fichier | Rôle |
|---|---|
| `manifest.json` | MV3 — sidePanel + service worker, permissions minimales (`sidePanel, storage, activeTab, scripting`) |
| `background.js` | Nœud d'essaim : config, manifeste (`GET /api/v1/essaim/manifeste`), tâches locales, compte rendus au cortex |
| `popup.html/js` | Configuration (instance, clé, projet) |
| `sidepanel.html/js` | Chat gen3 + contexte de page sur action + tâches d'essaim |

## Feuille de route (P1)

- WebRTC P2P via `app/api/ondes/signaling` : le nœud navigateur réclamera
  les tâches distribuées par onde comme tout pair de l'essaim.
- Multi-agents visibles dans le sidepanel (plan → agents spécialisés →
  résultats, via le planificateur de la plateforme).
- Publication Chrome Web Store (permissions déclaratives minimales, même
  modèle de sécurité que la marketplace : déclaratif, pas de code arbitraire).
