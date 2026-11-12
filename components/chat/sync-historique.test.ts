import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * SYNCHRONISATION SERVEUR DE L'HISTORIQUE (suite repositionnement Gemini,
 * 2026-11-06) — conventions du dépôt : vitest en Node SANS jsdom. Deux
 * niveaux :
 *
 *  A. LOGIQUE PURE (import direct de components/chat/sync-historique.ts) :
 *     la fusion liste serveur ↔ cache local et le mapping messages serveur.
 *  B. VERROUS STRUCTURELS sur components/chat/nova-chat.tsx : la synchro au
 *     montage (authentifié uniquement), l'hydratation des stubs à la
 *     sélection, et les gardes de confidentialité / anti-écrasement.
 *
 * Garantie produit : l'historique « Récents » suit l'utilisateur entre ses
 * appareils (comme Gemini) sans jamais écraser une interaction locale, et
 * sans jamais exposer le compartiment « invite ».
 */

import {
  fusionnerHistoriqueServeur,
  messagesDepuisServeur,
  resoudreUidSession,
  type ConversationLocaleMinimale,
} from "@/components/chat/sync-historique";

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
const CHAT = "components/chat/nova-chat.tsx";

const id = (() => {
  let n = 0;
  return () => `loc-${++n}`;
})();
const T0 = 1_700_000_000_000;

function locale(partial: Partial<ConversationLocaleMinimale> & { id: string }): ConversationLocaleMinimale {
  return { titre: "Sans titre", maj: T0, messages: [], ...partial };
}

describe("fusion serveur ↔ cache local (fusionnerHistoriqueServeur)", () => {
  it("une conversation serveur inconnue devient un stub (méta seule, messages vides)", () => {
    const r = fusionnerHistoriqueServeur(
      [],
      [{ id: "srv-1", title: "Devis printemps", updatedAt: "2026-11-05T10:00:00.000Z" }],
      id,
      T0,
      60,
    );
    expect(r.convs).toHaveLength(1);
    expect(r.convs[0].serverId).toBe("srv-1");
    expect(r.convs[0].titre).toBe("Devis printemps");
    expect(r.convs[0].messages).toHaveLength(0);
    expect(r.nouvelles).toBe(1);
    expect(r.misesAJour).toBe(0);
  });

  it("titre de repli « Conversation » quand le titre serveur est vide", () => {
    const r = fusionnerHistoriqueServeur([], [{ id: "srv-1", title: "   " }], id, T0, 60);
    expect(r.convs[0].titre).toBe("Conversation");
  });

  it("une conversation déjà connue localement est mise à jour (titre serveur, maj = max) — jamais dupliquée", () => {
    const locales = [locale({ id: "l1", serverId: "srv-1", titre: "Ancien titre", maj: T0 })];
    const r = fusionnerHistoriqueServeur(
      locales,
      [{ id: "srv-1", title: "Nouveau titre", updatedAt: new Date(T0 + 5_000).toISOString() }],
      id,
      T0,
      60,
    );
    expect(r.convs).toHaveLength(1);
    expect(r.convs[0].id).toBe("l1"); // même identité locale, pas de stub
    expect(r.convs[0].titre).toBe("Nouveau titre");
    expect(r.convs[0].maj).toBe(T0 + 5_000);
    expect(r.nouvelles).toBe(0);
    expect(r.misesAJour).toBe(1);
  });

  it("la date locale plus récente gagne (jamais de régression de maj)", () => {
    const locales = [locale({ id: "l1", serverId: "srv-1", maj: T0 + 60_000 })];
    const r = fusionnerHistoriqueServeur(
      locales,
      [{ id: "srv-1", updatedAt: new Date(T0).toISOString() }],
      id,
      T0,
      60,
    );
    expect(r.convs[0].maj).toBe(T0 + 60_000);
  });

  it("les conversations locales pures (hors ligne, sans serverId) sont conservées", () => {
    const locales = [locale({ id: "l1", titre: "Brouillon hors ligne" })];
    const r = fusionnerHistoriqueServeur(
      locales,
      [{ id: "srv-1", title: "Distante" }],
      id,
      T0,
      60,
    );
    expect(r.convs.map((c) => c.titre).sort()).toEqual(["Brouillon hors ligne", "Distante"]);
  });

  it("les conversations locales présentes sur le serveur au-delà de la fenêtre de listage restent listées", () => {
    const locales = [
      locale({ id: "l1", serverId: "srv-vieux", maj: T0 - 10_000 }),
      locale({ id: "l2", serverId: "srv-recent", maj: T0 }),
    ];
    const r = fusionnerHistoriqueServeur(locales, [{ id: "srv-recent" }], id, T0, 60);
    expect(r.convs.map((c) => c.serverId).sort()).toEqual(["srv-recent", "srv-vieux"]);
  });

  it("résultat trié par maj décroissante et plafonné à maxConvs", () => {
    const serveurs = Array.from({ length: 10 }, (_, i) => ({
      id: `srv-${i}`,
      updatedAt: new Date(T0 + i * 1_000).toISOString(),
    }));
    const r = fusionnerHistoriqueServeur([], serveurs, id, T0, 3);
    expect(r.convs).toHaveLength(3);
    expect(r.convs[0].serverId).toBe("srv-9"); // la plus récente d'abord
    expect(r.convs[2].serverId).toBe("srv-7");
  });

  it("entrées serveur malformées ignorées (pas d'id, id vide)", () => {
    const r = fusionnerHistoriqueServeur(
      [],
      [{ title: "Fantôme" }, { id: "", title: "Vide" }, null as unknown as { id: string }],
      id,
      T0,
      60,
    );
    expect(r.convs).toHaveLength(0);
    expect(r.nouvelles).toBe(0);
  });
});

describe("mapping messages serveur → local (messagesDepuisServeur)", () => {
  it("rôle binaire, date parsée, serverId porté, contenu stringifié", () => {
    const msgs = messagesDepuisServeur(
      {
        conversation: { id: "srv-1" },
        messages: [
          { id: "m1", role: "user", content: "Bonjour", createdAt: "2026-11-05T10:00:00.000Z" },
          { id: "m2", role: "assistant", content: "Bonjour !", createdAt: "2026-11-05T10:00:05.000Z", model: "gen3-snn-v1" },
          { role: "inconnu", content: 42 as unknown as string },
        ],
      },
      T0,
      id,
    );
    expect(msgs).toHaveLength(3);
    expect(msgs[0]).toMatchObject({ id: "m1", serverId: "m1", role: "user", content: "Bonjour" });
    expect(msgs[0].date).toBe(Date.parse("2026-11-05T10:00:00.000Z"));
    expect(msgs[1].role).toBe("assistant");
    expect(msgs[1].modele).toBe("gen3-snn-v1");
    // message sans id : identifiant local synthétique (préfixe srv-), serverId absent
    expect(msgs[2].id).toMatch(/^srv-2-/);
    expect(msgs[2].serverId).toBeUndefined();
    // rôle inconnu → repli user (jamais de trou dans le fil)
    expect(msgs[2].role).toBe("user");
    expect(msgs[2].content).toBe("42");
  });
});

describe("verrous structurels du câblage UI (nova-chat.tsx)", () => {
  const chat = read(CHAT);

  it("la synchro serveur est branchée au montage, authFetch, limit=50", () => {
    expect(chat).toContain("/api/workspace/conversations?limit=50");
    expect(chat).toContain("fusionnerHistoriqueServeur(");
    expect(chat).toContain("SYNCHRONISATION SERVEUR DE L'HISTORIQUE");
  });

  it("confidentialité : la synchro n'a lieu QUE pour un utilisateur résolu (jamais l'invite)", () => {
    const section = chat.slice(chat.indexOf("cleActive = clePourUtilisateur(uid);"), chat.indexOf("/* ---- ÉCRITURE PROGRESSIVE"));
    expect(section).toContain("if (uid) {");
    // l'appel de liste est bien DANS la garde uid
    expect(section.indexOf("if (uid) {")).toBeLessThan(section.indexOf("/api/workspace/conversations?limit=50"));
  });

  it("échec réseau : le cache local reste la vérité affichée (aucune exception propagée)", () => {
    const section = chat.slice(chat.indexOf("if (uid) {"), chat.indexOf("/* ---- ÉCRITURE PROGRESSIVE"));
    expect(section).toContain("} catch {");
    expect(section).toContain("cache local reste affiché");
  });

  it("l'hydratation des stubs part de la sélection (jamais au montage)", () => {
    expect(chat).toContain("void hydraterSiStub(id);");
    // garde anti-double-vol par serverId
    expect(chat).toContain("hydratationEnCoursRef");
    expect(chat).toContain("hydratationEnCoursRef.current.has(sid)");
  });

  it("garde anti-écrasement : un fil local non vide n'est jamais remplacé par l'hydratation", () => {
    expect(chat).toContain("if (!actuelle || actuelle.messages.length > 0) return;");
  });

  it("l'import par recherche partage le même mapping (une seule source de vérité)", () => {
    expect(chat).toContain("messagesDepuisServeur(data, Date.now(), idSuivant)");
    expect((chat.match(/messagesDepuisServeur\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

describe("resoudreUidSession — les DEUX formes du payload /api/auth/session (fix sonde vidéo)", () => {
  const chat = read(CHAT);

  it("forme r2 RÉELLE : { authenticated, user: { uid } } → uid résolu (l'ancienne lecture racine échouait)", () => {
    const uid = resoudreUidSession({
      authenticated: true,
      user: { uid: "r2_941b511e76dfe8b3b8897c6c", email: "x@y.test" },
      wallet: { currency: "XAF" },
    });
    expect(uid).toBe("r2_941b511e76dfe8b3b8897c6c");
  });

  it("forme historique : { authenticated, uid } → uid résolu", () => {
    expect(resoudreUidSession({ authenticated: true, uid: "u_1" })).toBe("u_1");
  });

  it("non authentifié / UID absent / corps invalide → null (jamais d'invention)", () => {
    expect(resoudreUidSession({ authenticated: false, user: { uid: "r2_x" } })).toBeNull();
    expect(resoudreUidSession({ authenticated: true })).toBeNull();
    expect(resoudreUidSession({ authenticated: true, user: { uid: "" } })).toBeNull();
    expect(resoudreUidSession(null)).toBeNull();
    expect(resoudreUidSession("chaîne")).toBeNull();
    expect(resoudreUidSession(undefined)).toBeNull();
  });

  it("nova-chat utilise le helper (plus de lecture racine fautive)", () => {
    expect(chat).toContain("resoudreUidSession(await reponse.json())");
    expect(chat).not.toContain('typeof corps.uid === "string"');
  });
});
