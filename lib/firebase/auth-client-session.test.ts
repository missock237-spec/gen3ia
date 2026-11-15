import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Sonde de session DÉDUPLIQUÉE (Task 101, audit quota Firestore) :
 * `useSessionAvailable` est monté dans ~20 composants — chaque page
 * déclenchait 2-3 requêtes GET /api/auth/session identiques. Le contrat
 * verrouillé ici :
 *  - N appels dans la fenêtre de 60 s → UNE seule requête réseau ;
 *  - `force` court-circuite la fenêtre (flux post-connexion) ;
 *  - au-delà du TTL, une nouvelle requête part (les refus 401 ne sont pas
 *    retenus plus longtemps que les succès) ;
 *  - la promesse ne rejette JAMAIS (panne réseau = résultat ok:false).
 *
 * firebase/auth et le client Firebase sont simulés (convention du dépôt) :
 * seule la logique de dédup est testée, en environnement node.
 */

vi.mock("firebase/auth", () => ({
  createUserWithEmailAndPassword: vi.fn(),
  getRedirectResult: vi.fn(),
  onAuthStateChanged: vi.fn(),
  sendEmailVerification: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
  signInWithEmailAndPassword: vi.fn(),
  signInWithPopup: vi.fn(),
  signInWithRedirect: vi.fn(),
  signOut: vi.fn(),
  updateProfile: vi.fn(),
}));

vi.mock("./client", () => ({
  auth: {},
  googleProvider: {},
  githubProvider: {},
  hasFirebaseClientConfig: () => false,
}));

import { sonderSessionServeur } from "./auth-client";

const reponseOk = () => new Response(null, { status: 200 });
const reponse401 = () => new Response(null, { status: 401 });

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("sonderSessionServeur — déduplication par onglet (Task 101)", () => {
  it("N appels rapprochés → une seule requête réseau, même réponse partagée", async () => {
    const fetchSimulé = vi.fn(async () => reponseOk());
    vi.stubGlobal("fetch", fetchSimulé);

    const [a, b, c] = await Promise.all([
      sonderSessionServeur(),
      sonderSessionServeur(),
      sonderSessionServeur(),
    ]);
    const d = await sonderSessionServeur();

    expect(fetchSimulatedCalls(fetchSimulé)).toBe(1);
    expect(a).toEqual({ ok: true, status: 200 });
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(d).toEqual(a);
  });

  it("force court-circuite la fenêtre partagée (flux post-connexion)", async () => {
    const fetchSimulé = vi.fn(async () => reponseOk());
    vi.stubGlobal("fetch", fetchSimulé);

    await sonderSessionServeur(true);
    await sonderSessionServeur(true);
    // Sans force : la réponse du dernier appel force est encore fraîche.
    await sonderSessionServeur();

    expect(fetchSimulatedCalls(fetchSimulé)).toBe(2);
  });

  it("au-delà du TTL de 60 s, une nouvelle requête part (succès comme refus)", async () => {
    const fetchSimulé = vi.fn(async () => reponseOk());
    vi.stubGlobal("fetch", fetchSimulé);
    const horloge = vi.spyOn(Date, "now");

    horloge.mockReturnValue(1_000_000_000);
    // force : repart d'une sonde neuve dont l'horodatage T0 est maîtrisé.
    await sonderSessionServeur(true);
    horloge.mockReturnValue(1_000_000_000 + 61_000);
    await sonderSessionServeur();

    expect(fetchSimulatedCalls(fetchSimulé)).toBe(2);
  });

  it("un refus 401 est partagé mais expiré au bout du TTL (2 tentatives, jamais rejeté)", async () => {
    vi.useFakeTimers();
    const fetchSimulé = vi.fn(async () => reponse401());
    vi.stubGlobal("fetch", fetchSimulé);

    const première = sonderSessionServeur(true);
    await vi.advanceTimersByTimeAsync(1_500);
    await expect(première).resolves.toEqual({ ok: false, status: 401 });
    expect(fetchSimulatedCalls(fetchSimulé)).toBe(2);

    // TTL expiré : la sonde refetch — le refus n'est pas retenu indéfiniment.
    await vi.advanceTimersByTimeAsync(61_000);
    const seconde = sonderSessionServeur();
    await vi.advanceTimersByTimeAsync(1_500);
    await expect(seconde).resolves.toEqual({ ok: false, status: 401 });
    expect(fetchSimulatedCalls(fetchSimulé)).toBe(4);
  });

  it("panne réseau persistante : la promesse résout ok:false (status 0), ne rejette jamais", async () => {
    vi.useFakeTimers();
    const fetchSimulé = vi.fn(async () => {
      throw new Error("network down");
    });
    vi.stubGlobal("fetch", fetchSimulé);

    const sonde = sonderSessionServeur(true);
    await vi.advanceTimersByTimeAsync(1_500);
    await expect(sonde).resolves.toEqual({ ok: false, status: 0 });
    expect(fetchSimulatedCalls(fetchSimulé)).toBe(2);
  });
});

/** Compte les appels fetch en tolérant les signatures variables. */
function fetchSimulatedCalls(fetchSimulé: ReturnType<typeof vi.fn>): number {
  return fetchSimulé.mock.calls.length;
}
