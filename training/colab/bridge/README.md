# Pont Colab pull-mode — protocole de télécommande de l'entraînement gen3

**Principe** : le même pattern que le pull-mode VPS du projet, appliqué à Google Colab.
L'agent (`training/colab/agent-pull-colab.sh`, lancé UNE fois par le propriétaire dans le
terminal Colab) consulte la boîte d'ordres de cette branche, exécute les commandes reçues
sur la GPU de la session Colab, et renvoie les logs ici — **HTTPS sortant uniquement,
aucun tunnel, aucun port ouvert**.

## Canaux

| Canal | Fichier (branche `colab-bridge`) | Qui écrit | Fréquence |
|---|---|---|---|
| **Ordres** | `inbox.json` | Le pilote distant (via API Contents) | à chaque nouvelle étape |
| **Résultats** | `out-<lot>-<n>.log` | L'agent Colab | après chaque commande |
| **État** | `out-stop.log` | L'agent Colab | à l'arrêt propre |

## Format de l'inbox

```json
{
  "id": "2026-10-31-a",
  "stop": false,
  "timeout_s": 14400,
  "commands": [
    "nvidia-smi",
    "python3 -c 'print(\"ok\")'"
  ]
}
```

- `id` : identifiant UNIQUE — un id nouveau déclenche l'exécution du lot.
- `stop: true` → l'agent fait un dernier rapport et se termine proprement.
- `timeout_s` : (option) timeout par commande, défaut 4 h (14400 s).

## Garanties de sécurité (documentées, honnêtes)

- Le **token GitHub reste dans la session Colab du propriétaire** (variable d'env ou
  saisie masquée) : jamais écrit sur disque, jamais dans les logs, envoyé uniquement à
  `api.github.com`. **Jamais commité dans ce dépôt.**
- Les ordres viennent **exclusivement de ce répertoire** (`training/colab/bridge/` sur
  `colab-bridge`) — donc de quiconque détient un accès en écriture au dépôt.
- Le propriétaire **opte** en lançant l'agent ; `Ctrl+C` l'arrête à tout instant ;
  `{"stop": true}` provoque un arrêt propre avec dernier rapport.
- Les logs renvoyés sont **tronqués à la fin** (380 Ko max, la fin contient les
  résultats). L'agent n'y écrit jamais le token.

## Durée de vie de session (honnêteté)

- Une session Colab GPU a des **limites de durée** (~12 h) et peut se déconnecter :
  si l'agent meurt avec la session, relancer la commande — le lot courant (dernier
  `id`) est réexécuté une fois au redémarrage (idempotence par `id` en mémoire).
- Variante persistante (survit à la fermeture de l'onglet terminal, pas à la mort de
  la VM) :
  ```bash
  curl -fsSL https://raw.githubusercontent.com/missock237-spec/gen3ia/main/training/colab/agent-pull-colab.sh -o /tmp/gen3ia-agent.sh
  GEN3IA_PAT=ton_token nohup bash /tmp/gen3ia-agent.sh > ~/gen3ia-agent.log 2>&1 &
  ```

## Pourquoi une branche dédiée

Les pushes sur `main` déclenchent la CI complète + le déploiement production. Les
ordres/logs du pont vivent sur **`colab-bridge`** : la CI de `main` n'est pas
martelée par le trafic d'entraînement.

## Lancement (la commande unique, côté Colab)

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/missock237-spec/gen3ia/main/training/colab/agent-pull-colab.sh)
```
