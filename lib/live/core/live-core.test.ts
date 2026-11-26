import { beforeEach, describe, expect, it } from "vitest";

import { LiveEngine } from "./live-engine";
import { obtenirBusEvenements } from "./live-event-bus";
import { acquerirVerrou, libererVerrou, marquerDeconnexion, marquerPresence } from "./live-state-manager";
import { creerGestionnaireSessions } from "./live-session-manager";
import { createStoreMemoire, nouvelleSession } from "./live-core-types";

/**
 * TESTS PHASE 0/1 — GEN3IA LIVE : Live Engine central (cycle de vie unique,
 * bus d'événements, permissions/verrous, expiration automatique, récupération
 * après déconnexion). Fondation commune aux CINQ services (mission §1).
 */

const options = () => ({ store: storeLocal });
let storeLocal: ReturnType<typeof createStoreMemoire>;

beforeEach(() => {
  storeLocal = createStoreMemoire();
  LiveEngine.reinitialiserMemoire();
});

describe("cycle de vie unique des sessions (mission Phase 1)", () => {
  it("création → démarrage → pause → reprise → arrêt, avec autorisations", async () => {
    const session = await LiveEngine.ouvrirSession({ ...options(), proprietaireId: "u1", dureeMaxMs: 60_000 });
    expect(session.statut).toBe("pending");
    const gestionnaire = creerGestionnaireSessions(storeLocal);
    await gestionnaire.demarrer(session.id, "u1");
    expect((await gestionnaire.lire(session.id)).statut).toBe("active");
    await gestionnaire.pauser(session.id, "u1");
    expect((await gestionnaire.lire(session.id)).statut).toBe("pause");
    await gestionnaire.reprendre(session.id, "u1");
    expect((await gestionnaire.lire(session.id)).statut).toBe("active");
    await gestionnaire.arreter(session.id, "u1");
    expect((await gestionnaire.lire(session.id)).statut).toBe("terminee");
  });

  it("un non-propriétaire ne peut pas arrêter la session", async () => {
    const session = await LiveEngine.ouvrirSession({ ...options(), proprietaireId: "u1" });
    const gestionnaire = creerGestionnaireSessions(storeLocal);
    await expect(gestionnaire.arreter(session.id, "intrus")).rejects.toThrow("non autorisé");
  });

  it("expiration automatique par balayage (mission : expiration)", async () => {
    let t = 1_000_000;
    const gestionnaire = creerGestionnaireSessions(storeLocal, () => t);
    const session = await gestionnaire.creer({ proprietaireId: "u1", dureeMaxMs: 10_000, maintenant: t });
    await gestionnaire.demarrer(session.id, "u1");
    t += 11_000;
    const res = await gestionnaire.balayage();
    expect(res.expirees).toContain(session.id);
    expect((await gestionnaire.lire(session.id)).statut).toBe("expiree");
  });
});

describe("cinq services indépendants, infrastructure commune (mission §1)", () => {
  it("les modes s'activent/désactivent indépendamment (vocal+écran+caméra ensemble)", async () => {
    const session = await LiveEngine.ouvrirSession({ ...options(), proprietaireId: "u1" });
    await LiveEngine.activerMode({ ...options(), sessionId: session.id, mode: "vocal", demandeurId: "u1" });
    await LiveEngine.activerMode({ ...options(), sessionId: session.id, mode: "ecran", demandeurId: "u1" });
    await LiveEngine.activerMode({ ...options(), sessionId: session.id, mode: "camera", demandeurId: "u1" });
    const vue = await LiveEngine.vue({ ...options(), sessionId: session.id });
    expect([...vue.session.modesActifs]).toEqual(["vocal", "ecran", "camera"]);
    // désactiver l'écran ne coupe pas vocal ni caméra (mission Phase 9)
    await LiveEngine.desactiverMode({ ...options(), sessionId: session.id, mode: "ecran", demandeurId: "u1" });
    const vue2 = await LiveEngine.vue({ ...options(), sessionId: session.id });
    expect([...vue2.session.modesActifs]).toEqual(["vocal", "camera"]);
  });

  it("verrou de ressource : un seul écran par session, refus explicite", async () => {
    const session = await LiveEngine.ouvrirSession({ ...options(), proprietaireId: "u1" });
    await LiveEngine.rejoindre({ ...options(), sessionId: session.id, participantId: "u2", nom: "C", role: "collaborateur" });
    await LiveEngine.activerMode({ ...options(), sessionId: session.id, mode: "ecran", demandeurId: "u1" });
    await expect(
      LiveEngine.activerMode({ ...options(), sessionId: session.id, mode: "ecran", demandeurId: "u2" })
    ).rejects.toThrow("verrou de ressource refusé");
    await LiveEngine.desactiverMode({ ...options(), sessionId: session.id, mode: "ecran", demandeurId: "u1" });
    // libéré : u2 peut maintenant activer
    await LiveEngine.activerMode({ ...options(), sessionId: session.id, mode: "ecran", demandeurId: "u2" });
  });

  it("participation multi-rôles (propriétaire, observateur, agent) et pouls", async () => {
    const session = await LiveEngine.ouvrirSession({ ...options(), proprietaireId: "u1" });
    const observateur = await LiveEngine.rejoindre({ ...options(), sessionId: session.id, participantId: "u2", nom: "Obs", role: "observateur" });
    expect(observateur.role).toBe("observateur");
    await LiveEngine.rejoindre({ ...options(), sessionId: session.id, participantId: "agent1", nom: "Gen3ia", role: "agent" });
    const presents = await LiveEngine.pouls({ ...options(), sessionId: session.id, participantId: "agent1" });
    expect(presents).toContain("agent1");
    const restants = await LiveEngine.deconnexion({ ...options(), sessionId: session.id, participantId: "agent1" });
    expect(restants).not.toContain("agent1");
  });
});

describe("bus d'événements : un historique commun (mission Phase 9)", () => {
  it("publication + abonnement filtré + historique persisté dans l'ordre", async () => {
    const bus = obtenirBusEvenements(storeLocal);
    const recus: string[] = [];
    const desabonner = bus.abonner({ types: ["mode.active"] }, (e) => recus.push(`${e.type}:${(e.charge as { mode: string }).mode}`));
    await bus.publier({ sessionId: "s1", type: "session.creee", source: "systeme" });
    await bus.publier({ sessionId: "s1", type: "mode.active", source: "vocal", charge: { mode: "vocal" } });
    await bus.publier({ sessionId: "s1", type: "mode.active", source: "ecran", charge: { mode: "ecran" } });
    desabonner();
    await bus.publier({ sessionId: "s1", type: "mode.active", source: "camera", charge: { mode: "camera" } });
    expect(recus).toEqual(["mode.active:vocal", "mode.active:ecran"]); // filtre + désabonnement
    const historique = await bus.historique("s1");
    expect(historique.map((e) => e.type)).toEqual(["session.creee", "mode.active", "mode.active", "mode.active"]);
  });

  it("un abonné défaillant ne bloque pas le bus", async () => {
    const bus = obtenirBusEvenements();
    bus.abonner({}, () => { throw new Error("abonné cassé"); });
    const e = await bus.publier({ sessionId: "s2", type: "test", source: "systeme" });
    expect(e.type).toBe("test"); // publication délivrée malgré l'erreur
  });
});

describe("état temporaire et récupération après déconnexion", () => {
  it("présence et verrous TTL (double usage refusé, libération restaure)", () => {
    expect(marquerPresence("s3", "a")).toEqual(["a"]);
    expect(marquerPresence("s3", "b")).toEqual(["a", "b"]);
    expect(marquerDeconnexion("s3", "a")).toEqual(["b"]);
    expect(acquerirVerrou("s3", "camera", "a")).toBe(true);
    expect(acquerirVerrou("s3", "camera", "b")).toBe(false);
    libererVerrou("s3", "camera", "a");
    expect(acquerirVerrou("s3", "camera", "b")).toBe(true);
  });

  it("session ré-joinable après déconnexion (mission : récupération)", async () => {
    const session = await LiveEngine.ouvrirSession({ ...options(), proprietaireId: "u1" });
    await LiveEngine.rejoindre({ ...options(), sessionId: session.id, participantId: "u2", nom: "X", role: "collaborateur" });
    await LiveEngine.deconnexion({ ...options(), sessionId: session.id, participantId: "u2" });
    const rejoint = await LiveEngine.rejoindre({ ...options(), sessionId: session.id, participantId: "u2", nom: "X", role: "collaborateur" });
    expect(rejoint.present).toBe(true);
  });

  it("sessions fermées refusent l'adhésion", async () => {
    const s = nouvelleSession({ proprietaireId: "u1" });
    s.statut = "terminee";
    await storeLocal.creer(s);
    const gestionnaire = creerGestionnaireSessions(storeLocal);
    await expect(gestionnaire.rejoindre({ sessionId: s.id, participantId: "u2", nom: "n", role: "observateur" })).rejects.toThrow("fermée");
  });
});
