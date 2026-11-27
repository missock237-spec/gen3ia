# @infrastructure/pp-sdk

SDK client de l'infrastructure PP (Gen3ia). Aucun secret dans le code source :
uniquement un AppID public ; la clé privée naît dans le matériel.

```ts
import { PPNode } from "@infrastructure/pp-sdk";

const node = new PPNode({
  appId: "app_client_8942",       // identifiant public (non sensible)
  targetPeer: "peer_system_01",   // cible à contacter
  hardwareBinding: true           // force l'ancrage sur la puce de l'appareil
});

await node.connect();             // clé matérielle + tunnel Noise + défi signé
const response = await node.send("DEPLOY_WORKFLOW", { workflowId: "wf_402", priority: "high" });
```

Statut : intégré au dépôt Gen3ia (`lib/pp/sdk/pp-node.ts`) — la publication
npm autonome est une étape propriétaire (non effectuée).
