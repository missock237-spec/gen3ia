import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * RECHERCHE GLOBALE DU CHAT (it.44, LOT 13) — conventions du dépôt :
 * vitest tourne en Node SANS jsdom ni @testing-library/react (cf.
 * components/developer/tabs/secrets-panel.test.tsx). Le câblage du champ
 * de recherche de la sidebar à la porte sémantique
 * /api/workspace/conversations/search est verrouillé structurellement sur
 * les sources de components/chat/nova-chat.tsx :
 *
 *  1. LA PORTE SÉMANTIQUE EST APPELÉE : requête débouncée (350 ms),
 *     paramètre q encodé via encodeURIComponent — on retrouve une
 *     conversation par le SENS de son contenu (mode sémantique) avec
 *     repli textuel sur les titres (badge « titres »).
 *  2. L'OUVERTURE D'UN RÉSULTAT EST SÛRE : sélection locale par serverId
 *     si la conversation est déjà en cache ; sinon import fidèle via la
 *     porte détail GET /api/workspace/conversations/[id] (ownership
 *     re-vérifié côté route — la conversation d'un autre compte reste
 *     impossible à ouvrir, 404 serveur).
 *  3. AUTH PAR SESSION : les appels passent par authFetch (session
 *     Firebase) — aucun fetch brut pour la recherche.
 *  4. ANTI-RÉPONSE PÉRIMÉE : compteur d'ordre — une réponse arrivée après
 *     une frappe plus récente est ignorée (jamais de résultats
 *     contradictoires à l'écran).
 */

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

const CHAT = "components/chat/nova-chat.tsx";

describe("Recherche globale du chat (câblage /api/workspace/conversations/search, it.44)", () => {
  const chat = read(CHAT);

  it("la porte sémantique est appelée en débouncé avec un paramètre q encodé", () => {
    expect(chat).toContain("/api/workspace/conversations/search?q=");
    expect(chat).toContain("encodeURIComponent(requete)");
    // Débounce réel (350 ms) — une requête par pause de frappe, pas par
    // caractère tapé (économise le quota rate-limit 60/5 min de la porte).
    expect(chat).toContain("setTimeout(async () => {");
    expect(chat).toContain("350");
    // Le rendu affiche l'extrait du message retrouvé et le badge de mode.
    expect(chat).toContain("r.excerpt");
    expect(chat).toContain("sémantique");
    expect(chat).toContain("nova-rg-badge");
  });

  it("l'ouverture d'un résultat est sûre : cache local par serverId, sinon import via la porte détail", () => {
    // 1) Sélection directe quand la conversation est déjà dans le cache
    //    local (même appareil).
    expect(chat).toContain("c.serverId === resultat.conversationId");
    // 2) Import réel depuis la porte détail (ownership re-vérifié serveur)
    //    pour une conversation créée sur un autre appareil.
    expect(chat).toContain(
      "/api/workspace/conversations/${encodeURIComponent(resultat.conversationId)}",
    );
    expect(chat).toContain("convImportee");
    // Anti-doublon : un double-clic ne crée pas deux conversations locales.
    expect(chat).toContain("Anti-doublon");
  });

  it("les appels passent par la session utilisateur (authFetch) — jamais de fetch brut pour la recherche", () => {
    // La recherche et l'import passent par authFetch (session Firebase).
    expect(chat).toContain("authFetch(");
    const sectionRecherche = chat.slice(
      chat.indexOf("Recherche globale (LOT 13, it.44)"),
      chat.indexOf("supprimerConversation = React.useCallback"),
    );
    expect(sectionRecherche).toContain("authFetch(");
    expect(sectionRecherche).not.toMatch(/(?<!\.)\bfetch\(/);
  });

  it("anti-réponse périmée : un compteur d'ordre ignore les réponses obsolètes", () => {
    expect(chat).toContain("ordreRechercheRef");
    expect(chat).toContain("monOrdre !== ordreRechercheRef.current");
  });
});
