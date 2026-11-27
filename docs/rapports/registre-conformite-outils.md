# Registre de conformité des outils Gen3ia — 2026-11-27

Inventaire généré par `scripts/registre-conformite-outils.ts` (audit outils v2). La synchronisation continue est gardée par `tests/unit/tool-registries-coherence.test.ts` en CI.

**Totaux :** catalogue 86 · sécurité 86 · registre toujours 64 · conditionnel 18 — statuts : **68 fonctionnels**, **18 partiellement fonctionnels** (exécuteur réel sous condition de configuration), **0 bloqués**, **0 manquants**.

| Outil | Catalogue | Sécurité (risque) | Exécuteur | Statut |
|---|---|---|---|---|
| `ads.read` | ✅ | ✅ (read) | toujours | fonctionnel |
| `artefacts.audit` | ✅ | ✅ (write) | toujours | fonctionnel |
| `artifact.convert` | ✅ | ✅ (write) | toujours | fonctionnel |
| `artifact.create` | ✅ | ✅ (write) | toujours | fonctionnel |
| `artifact.get` | ✅ | ✅ (read) | toujours | fonctionnel |
| `brain.train` | ✅ | ✅ (write) | toujours | fonctionnel |
| `browser.navigate` | ✅ | ✅ (read) | toujours | fonctionnel |
| `build.autofix` | ✅ | ✅ (external) | conditionnel | partiellement fonctionnel — exécuteur réel enregistré sous condition (clé API / connecteur configuré) — échec propre et honnête sinon |
| `cloudflare.dns.create` | ✅ | ✅ (external) | conditionnel | partiellement fonctionnel — exécuteur réel enregistré sous condition (clé API / connecteur configuré) — échec propre et honnête sinon |
| `cloudflare.dns.list` | ✅ | ✅ (read) | conditionnel | partiellement fonctionnel — exécuteur réel enregistré sous condition (clé API / connecteur configuré) — échec propre et honnête sinon |
| `cloudflare.zones.list` | ✅ | ✅ (read) | conditionnel | partiellement fonctionnel — exécuteur réel enregistré sous condition (clé API / connecteur configuré) — échec propre et honnête sinon |
| `code.exec` | ✅ | ✅ (write) | toujours | fonctionnel |
| `code.execute` | ✅ | ✅ (destructive) | absent | fonctionnel — exécution par surface dédiée (hors registre par défaut) : lib/agents/runtime/secure-tool-executor.ts (exécution sandbox dédiée, validation runtime/limits lignes 46-50) |
| `code.inspect` | ✅ | ✅ (read) | toujours | fonctionnel |
| `code.simulate` | ✅ | ✅ (read) | toujours | fonctionnel |
| `composio.execute` | ✅ | ✅ (external) | conditionnel | partiellement fonctionnel — exécuteur réel enregistré sous condition (clé API / connecteur configuré) — échec propre et honnête sinon |
| `content.package` | ✅ | ✅ (write) | toujours | fonctionnel |
| `custom_api.call` | ✅ | ✅ (read) | toujours | fonctionnel |
| `custom_api.write` | ✅ | ✅ (external) | toujours | fonctionnel |
| `decision.analyze` | ✅ | ✅ (read) | toujours | fonctionnel |
| `dev.fmt` | ✅ | ✅ (read) | toujours | fonctionnel |
| `dev.regex` | ✅ | ✅ (read) | toujours | fonctionnel |
| `email.send` | ✅ | ✅ (external) | conditionnel | partiellement fonctionnel — exécuteur réel enregistré sous condition (clé API / connecteur configuré) — échec propre et honnête sinon |
| `file.create` | ✅ | ✅ (write) | toujours | fonctionnel |
| `file.delete` | ✅ | ✅ (destructive) | toujours | fonctionnel |
| `file.read` | ✅ | ✅ (read) | toujours | fonctionnel |
| `github.create_repository` | ✅ | ✅ (external) | conditionnel | partiellement fonctionnel — exécuteur réel enregistré sous condition (clé API / connecteur configuré) — échec propre et honnête sinon |
| `handover.compose` | ✅ | ✅ (write) | toujours | fonctionnel |
| `image.generate` | ✅ | ✅ (write) | toujours | fonctionnel |
| `ivr.navigate` | ✅ | ✅ (read) | toujours | fonctionnel |
| `knowledge.graph` | ✅ | ✅ (write) | toujours | fonctionnel |
| `knowledge.search` | ✅ | ✅ (read) | toujours | fonctionnel |
| `mcp.call` | ✅ | ✅ (external) | toujours | fonctionnel |
| `media.analyze` | ✅ | ✅ (read) | toujours | fonctionnel |
| `memory.read` | ✅ | ✅ (read) | absent | fonctionnel — exécution par surface dédiée (hors registre par défaut) : lib/domain/conversations/engine-tools.ts (dispatch propre du moteur de conversation) |
| `memory.write` | ✅ | ✅ (write) | absent | fonctionnel — exécution par surface dédiée (hors registre par défaut) : lib/domain/conversations/engine-tools.ts (dispatch propre du moteur de conversation) |
| `messaging.send` | ✅ | ✅ (external) | conditionnel | partiellement fonctionnel — exécuteur réel enregistré sous condition (clé API / connecteur configuré) — échec propre et honnête sinon |
| `musique.creer` | ✅ | ✅ (write) | toujours | fonctionnel |
| `network.list` | ✅ | ✅ (read) | toujours | fonctionnel |
| `network.mark_read` | ✅ | ✅ (read) | toujours | fonctionnel |
| `network.read_inbox` | ✅ | ✅ (read) | toujours | fonctionnel |
| `network.send_message` | ✅ | ✅ (write) | toujours | fonctionnel |
| `notion.create_page` | ✅ | ✅ (external) | conditionnel | partiellement fonctionnel — exécuteur réel enregistré sous condition (clé API / connecteur configuré) — échec propre et honnête sinon |
| `notion.search` | ✅ | ✅ (read) | conditionnel | partiellement fonctionnel — exécuteur réel enregistré sous condition (clé API / connecteur configuré) — échec propre et honnête sinon |
| `registry.find` | ✅ | ✅ (read) | toujours | fonctionnel |
| `schedule.create` | ✅ | ✅ (write) | toujours | fonctionnel |
| `schedule.delete` | ✅ | ✅ (write) | toujours | fonctionnel |
| `schedule.list` | ✅ | ✅ (read) | toujours | fonctionnel |
| `schedule.update` | ✅ | ✅ (write) | toujours | fonctionnel |
| `schema.extract` | ✅ | ✅ (read) | toujours | fonctionnel |
| `servicenow_incident_create` | ✅ | ✅ (external) | conditionnel | partiellement fonctionnel — exécuteur réel enregistré sous condition (clé API / connecteur configuré) — échec propre et honnête sinon |
| `servicenow_incident_query` | ✅ | ✅ (read) | conditionnel | partiellement fonctionnel — exécuteur réel enregistré sous condition (clé API / connecteur configuré) — échec propre et honnête sinon |
| `servicenow_incident_update` | ✅ | ✅ (external) | conditionnel | partiellement fonctionnel — exécuteur réel enregistré sous condition (clé API / connecteur configuré) — échec propre et honnête sinon |
| `simulation.run` | ✅ | ✅ (write) | toujours | fonctionnel |
| `social.publish` | ✅ | ✅ (external) | conditionnel | partiellement fonctionnel — exécuteur réel enregistré sous condition (clé API / connecteur configuré) — échec propre et honnête sinon |
| `terminal.execute` | ✅ | ✅ (destructive) | absent | fonctionnel — exécution par surface dédiée (hors registre par défaut) : lib/agents/runtime/secure-tool-executor.ts (flux « commande autorisée » à validation explicite, ligne 115) |
| `terminal.guide` | ✅ | ✅ (write) | toujours | fonctionnel |
| `terminal.run` | ✅ | ✅ (write) | toujours | fonctionnel |
| `terminal.shield` | ✅ | ✅ (write) | toujours | fonctionnel |
| `transcript.redact` | ✅ | ✅ (read) | toujours | fonctionnel |
| `video.create` | ✅ | ✅ (write) | toujours | fonctionnel |
| `video.revise` | ✅ | ✅ (write) | toujours | fonctionnel |
| `video.status` | ✅ | ✅ (read) | toujours | fonctionnel |
| `voice.speak` | ✅ | ✅ (write) | toujours | fonctionnel |
| `voicemail.respond` | ✅ | ✅ (external) | toujours | fonctionnel |
| `watchdog.track` | ✅ | ✅ (write) | toujours | fonctionnel |
| `web.api` | ✅ | ✅ (read) | toujours | fonctionnel |
| `web.api.write` | ✅ | ✅ (external) | toujours | fonctionnel |
| `web.deep_research` | ✅ | ✅ (read) | toujours | fonctionnel |
| `web.dns` | ✅ | ✅ (read) | toujours | fonctionnel |
| `web.http` | ✅ | ✅ (read) | toujours | fonctionnel |
| `web.open` | ✅ | ✅ (read) | toujours | fonctionnel |
| `web.search` | ✅ | ✅ (read) | toujours | fonctionnel |
| `webhook.emit` | ✅ | ✅ (external) | toujours | fonctionnel |
| `webhook.heal` | ✅ | ✅ (external) | toujours | fonctionnel |
| `workflow.create` | ✅ | ✅ (write) | toujours | fonctionnel |
| `workflow.delete` | ✅ | ✅ (write) | toujours | fonctionnel |
| `workflow.list` | ✅ | ✅ (read) | toujours | fonctionnel |
| `workflow.run` | ✅ | ✅ (write) | toujours | fonctionnel |
| `zendesk_ticket_create` | ✅ | ✅ (external) | conditionnel | partiellement fonctionnel — exécuteur réel enregistré sous condition (clé API / connecteur configuré) — échec propre et honnête sinon |
| `zendesk_ticket_list` | ✅ | ✅ (read) | conditionnel | partiellement fonctionnel — exécuteur réel enregistré sous condition (clé API / connecteur configuré) — échec propre et honnête sinon |
| `zendesk_ticket_search` | ✅ | ✅ (read) | conditionnel | partiellement fonctionnel — exécuteur réel enregistré sous condition (clé API / connecteur configuré) — échec propre et honnête sinon |
| `zendesk_ticket_update` | ✅ | ✅ (external) | conditionnel | partiellement fonctionnel — exécuteur réel enregistré sous condition (clé API / connecteur configuré) — échec propre et honnête sinon |
| `zip.analyze` | ✅ | ✅ (read) | toujours | fonctionnel |
| `zip.create` | ✅ | ✅ (write) | toujours | fonctionnel |
| `zip.extract` | ✅ | ✅ (write) | toujours | fonctionnel |
