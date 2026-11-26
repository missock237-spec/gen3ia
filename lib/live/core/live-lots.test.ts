import { beforeEach, describe, expect, it } from "vitest";

import { creerOrchestrateur } from "./live-orchestrator";
import { createStoreMemoire } from "./live-core-types";
import { obtenirBusEvenements, reinitialiserBus } from "./live-event-bus";
import { creerCollaborationLive } from "../collaboration/collaboration-manager";
import { contexteDepuisDescription, creerCerveauVocalContextualise } from "../vocal/pont-vocal-vision";
import { reinitialiserMoteurOcr } from "../vision/ocr-engine";
import type { DescriptionVisuelle } from "../vision/vision-engine";

/**
 * TESTS LOT 5/8/9/10 — pont vocal↔vision, collaboration partagée,
 * orchestrateur des cinq services (scénario obligatoire LOT 9 exécuté
 * réellement), arrêt d'urgence global.
 */

let store: ReturnType<typeof createStoreMemoire>;

beforeEach(() => {
  store = createStoreMemoire();
  reinitialiserBus();
  reinitialiserMoteurOcr();
});

describe("LOT 5 — pont vocal↔vision : réponses basées sur ce qui est RÉELLEMENT visible", () => {
  it("le contexte visuel transmis au cerveau est le texte borné du moteur vision (avec OCR branché)", async () => {
    const desc = {
      interpretation: "frame analysée (premiere-frame) — 3 bande(s) d'activité type texte sur 12 — contenu central dominant — thème clair",
      ocr: { disponible: true, moteur: "moteur-test", textes: [{ contenu: "Enregistrer", zone: { x: 0, y: 0, largeur: 1, hauteur: 1 }, confiance: 0.9 }], confiance: 0.9 },
      confiance: { score: 0.9, facteurs: ["signaux cohérents"] },
    } as unknown as DescriptionVisuelle;
    const contexte = contexteDepuisDescription(desc);
    expect(contexte).toContain("Vision de la scène");
    expect(contexte).toContain("textes lus : Enregistrer");
    expect(contexte).toContain("Confiance 90 %");
    // Sans description : aucun contexte fabriqué
    expect(contexteDepuisDescription(null)).toBeUndefined();
  });

  it("le cerveau vocal contextualisé publie l'échange dans le bus commun (un seul historique)", async () => {
    const bus = obtenirBusEvenements(store);
    const echanges: Array<{ question: string; contexteVisuelPresent: boolean }> = [];
    bus.abonner({ types: ["vocal.echange"] }, (e) => echanges.push(e.charge as { question: string; contexteVisuelPresent: boolean }));
    const visionFaux = { traiter: async () => null, contexte: () => [], reinitialiser: () => undefined };
    const cerveau = creerCerveauVocalContextualise({ sessionId: "s-bridge", cerveau: { repondre: async (t, ctx) => `réponse (${ctx ? "avec vision" : "sans vision"}) à « ${t} »` }, vision: visionFaux });
    const reponse = await cerveau.repondre("que vois-tu ?");
    expect(reponse).toContain("sans vision"); // aucune frame analysée par ce moteur factice : aucun contexte fabriqué
    expect(echanges).toHaveLength(1); // publié dans le bus commun
    expect(echanges[0].contexteVisuelPresent).toBe(false);
  });
});

describe("LOT 8 — collaboration : chat, annotations, pointeur, fichiers (rôles réels)", () => {
  it("chat collaborateur accepté, observateur REFUSÉ (lecture seule explicite)", async () => {
    const collab = creerCollaborationLive({ sessionId: "s-collab", storeEvenements: store });
    const ok = await collab.messageChat("u2", "collaborateur", "regarde la zone en haut à droite");
    expect(ok.accepte).toBe(true);
    const refuse = await collab.messageChat("u3", "observateur", "je ne peux rien écrire");
    expect(refuse.accepte).toBe(false);
    expect(refuse.raison).toContain("lecture seule");
  });

  it("annotation valide persistée, annotation invalide refusée avec raison", async () => {
    const collab = creerCollaborationLive({ sessionId: "s-collab", storeEvenements: store });
    const ok = await collab.annoter("u1", "proprietaire", { forme: "rectangle", debut: { x: 10, y: 10 }, fin: { x: 200, y: 100 }, couleur: "rouge" });
    expect(ok.accepte).toBe(true);
    const invalide = await collab.annoter("u1", "proprietaire", { forme: "spirale" });
    expect(invalide.accepte).toBe(false);
    expect(invalide.raison).toContain("invalide");
  });

  it("pointeur accessible à l'observateur (présence), fichier dangereux refusé, historique ordonné", async () => {
    const collab = creerCollaborationLive({ sessionId: "s-collab", storeEvenements: store });
    const pointeur = await collab.deplacerPointeur("u3", { x: 50, y: 80 });
    expect(pointeur.accepte).toBe(true);
    const fichier = await collab.partagerFichier("u1", "proprietaire", { nom: "../../etc/passwd", tailleOctets: 100, capsuleId: "c1" });
    expect(fichier.accepte).toBe(false);
    const fichierOk = await collab.partagerFichier("u1", "proprietaire", { nom: "rapport.pdf", tailleOctets: 2048, capsuleId: "capsule-1" });
    expect(fichierOk.accepte).toBe(true);
    const historique = await collab.historiquePartage();
    expect(historique.map((h) => h.type)).toEqual(["collab.pointeur", "collab.fichier"]);
  });
});

describe("LOT 9 — orchestrateur : scénario obligatoire exécuté réellement", () => {
  it("écran + micro + analyse Gen3ia + invitation — les modes restent indépendants", async () => {
    const orchestrateur = creerOrchestrateur({ store });
    const etat = await orchestrateur.ouvrir("proprio");
    expect(etat.sessionId).toBeTruthy();
    const scenario = await orchestrateur.scenarioIntegration({
      repondre: async (texte, contexte) => `Gen3ia a compris « ${texte} »${contexte ? " avec contexte" : ""}.`,
    });
    expect(scenario.etapes.map((e) => e.ok)).toEqual([true, true, true, true]); // écran, micro, analyse, invitation
    expect(scenario.reponseVocale).toContain("compris");
    const apres = await orchestrateur.etat();
    expect(apres.modesActifs).toContain("ecran");
    expect(apres.modesActifs).toContain("vocal");
    expect(apres.presents).toContain("invite-1");
    // Interruption entre services : arrêter l'écran ne coupe pas le vocal
    const r = await orchestrateur.desactiver("ecran", "proprio");
    expect(r.ok).toBe(true);
    const final = await orchestrateur.etat();
    expect(final.modesActifs).not.toContain("ecran");
    expect(final.modesActifs).toContain("vocal"); // le vocal survit
  });

  it("conflit de ressources partagées : un seul écran même via l'orchestrateur", async () => {
    const orchestrateur = creerOrchestrateur({ store });
    await orchestrateur.ouvrir("proprio");
    await orchestrateur.inviter("u2", "Collab", "collaborateur");
    const premier = await orchestrateur.activer("ecran", "proprio");
    expect(premier.ok).toBe(true);
    const second = await orchestrateur.activer("ecran", "u2");
    expect(second.ok).toBe(false);
    expect(second.raison).toContain("verrou de ressource refusé");
  });
});

describe("LOT 10 — arrêt d'urgence global (propriétaire uniquement, terminal)", () => {
  it("stoppe TOUS les modes, libère TOUS les verrous, verrouille la session, événement auditable", async () => {
    const orchestrateur = creerOrchestrateur({ store });
    await orchestrateur.ouvrir("proprio");
    await orchestrateur.activer("ecran", "proprio");
    await orchestrateur.activer("vocal", "proprio");
    await orchestrateur.activer("camera", "proprio");

    const bus = obtenirBusEvenements(store);
    const urgences: unknown[] = [];
    bus.abonner({ types: ["urgence.arret"] }, (e) => urgences.push(e.charge));

    const arret = await orchestrateur.arretUrgence("proprio");
    expect(arret.modesArretes).toEqual(["vocal", "camera", "ecran"]);
    expect(arret.verrousLiberes).toHaveLength(3);
    expect(urgences).toHaveLength(1); // auditable dans l'historique commun
    expect(orchestrateur.verrouilleUrgence()).toBe(true);

    const nonResurection = await orchestrateur.activer("vocal", "proprio");
    expect(nonResurection.ok).toBe(false);
    expect(nonResurection.raison).toContain("ARRÊT D'URGENCE");
    const vue = await orchestrateur.etat();
    expect(vue.modesActifs).toHaveLength(0);
  });

  it("un non-propriétaire NE PEUT PAS déclencher l'arrêt d'urgence", async () => {
    const orchestrateur = creerOrchestrateur({ store });
    await orchestrateur.ouvrir("proprio");
    await orchestrateur.inviter("u2", "Collab", "collaborateur");
    await expect(orchestrateur.arretUrgence("u2")).rejects.toThrow("seul le propriétaire");
    expect(orchestrateur.verrouilleUrgence()).toBe(false);
  });
});
