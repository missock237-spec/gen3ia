import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Publish QStash (Task 62) — le chemin de destination DOIT être BRUT :
 * la build QStash de ce compte rejette les chemins URL-encodés (vérifié
 * en sondes réelles : encodé = 400 « invalid scheme », brut = 201). Le
 * repli encodé sur 400 couvre les builds historiques.
 *
 * ORIGINE CANONIQUE (fix CodeQL js/request-forgery) : les publish* ne
 * prennent PLUS d'origine en paramètre — elle est résolue en interne
 * (GEN3IA_APP_ORIGIN, allowlist serveur) et toute destination hors
 * allowlist est rejetée par publishToDestination (défense en profondeur).
 */

const fetchMock = vi.fn();

vi.stubGlobal("fetch", fetchMock);

import {
  dispatchTickUrl,
  missionTickUrl,
  publishDispatchTick,
  publishMissionTick,
  publishToDestination,
  qstashConfig,
} from "./qstash";
import { assertSafeDestinationUrl } from "./origin";

const CONFIG = {
  token: "qstash-token-test",
  currentSigningKey: "current-signing-key",
  nextSigningKey: "next-signing-key",
};

function okPublish(messageId = "msg_test") {
  return new Response(JSON.stringify({ messageId }), { status: 201 });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.mocked(process.env, { getter: true });
  process.env.QSTASH_TOKEN = CONFIG.token;
  process.env.QSTASH_CURRENT_SIGNING_KEY = CONFIG.currentSigningKey;
  process.env.QSTASH_NEXT_SIGNING_KEY = CONFIG.nextSigningKey;
  process.env.GEN3IA_APP_ORIGIN = "https://gen3ia.online";
  delete process.env.GEN3IA_ALLOWED_ORIGINS;
});

afterEach(() => {
  delete process.env.QSTASH_TOKEN;
  delete process.env.QSTASH_CURRENT_SIGNING_KEY;
  delete process.env.QSTASH_NEXT_SIGNING_KEY;
  delete process.env.GEN3IA_APP_ORIGIN;
  delete process.env.GEN3IA_ALLOWED_ORIGINS;
});

describe("publishMissionTick — path brut (bug production corrigé)", () => {
  it("publie avec la destination BRUTE dans le path (jamais %2F ni %3A)", async () => {
    fetchMock.mockResolvedValue(okPublish());
    await publishMissionTick("run-1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(calledUrl).toBe("https://qstash.upstash.io/v2/publish/https://gen3ia.online/api/queue/mission-tick");
    expect(calledUrl).not.toContain("%2F");
    expect(calledUrl).not.toContain("%3A");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ runId: "run-1" });
  });

  it("retente en ENCODÉ uniquement sur 400 (compat builds historiques)", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('{"error":"invalid destination url"}', { status: 400 }))
      .mockResolvedValueOnce(okPublish("msg_encoded"));
    const result = await publishMissionTick("run-2");

    expect(result?.messageId).toBe("msg_encoded");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("%3A%2F%2F");
  });

  it("400 sur les DEUX formes → erreur propagée (pas de mission fantôme)", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('{"error":"invalid destination url"}', { status: 400 }))
      .mockResolvedValueOnce(new Response('{"error":"still bad"}', { status: 400 }));
    await expect(publishMissionTick("run-3")).rejects.toThrow(/QStash publish 400/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("délai QStash transmis via Upstash-Delay (ré-enfilement mission)", async () => {
    fetchMock.mockResolvedValue(okPublish());
    await publishMissionTick("run-4", { delaySeconds: 2 });
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers["Upstash-Delay"]).toBe("2s");
  });

  it("file non configurée → null (l'appelant garde son repli sync)", async () => {
    delete process.env.QSTASH_TOKEN;
    const result = await publishMissionTick("run-5");
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("origine canonique ABSENTE → null sans AUCUN appel réseau (anti request-forgery)", async () => {
    delete process.env.GEN3IA_APP_ORIGIN;
    const result = await publishMissionTick("run-6");
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("origine canonique HORS ALLOWLIST → null sans AUCUN appel réseau", async () => {
    process.env.GEN3IA_APP_ORIGIN = "https://attacker.example.net";
    const result = await publishMissionTick("run-7");
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("qstashConfig reste lisible à l'appel (env ajoutée sans redéploiement)", () => {
    expect(qstashConfig()).toMatchObject({ token: CONFIG.token });
  });
});

describe("publishDispatchTick — boucle de dispatch planifié", () => {
  it("publie { slotEpoch } vers /api/queue/dispatch-tick avec délai borné", async () => {
    fetchMock.mockResolvedValue(okPublish("msg_loop"));
    const result = await publishDispatchTick({ delaySeconds: 250, slotEpoch: 4_891_234 });

    expect(result?.messageId).toBe("msg_loop");
    const calledUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(calledUrl).toBe("https://qstash.upstash.io/v2/publish/https://gen3ia.online/api/queue/dispatch-tick");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ slotEpoch: 4_891_234 });
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers["Upstash-Delay"]).toBe("250s");
  });

  it("borne le délai à 24 h maximum", async () => {
    fetchMock.mockResolvedValue(okPublish());
    await publishDispatchTick({ delaySeconds: 500_000, slotEpoch: 1 });
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(Number(headers["Upstash-Delay"].replace("s", ""))).toBeLessThanOrEqual(86_400);
  });

  it("origine canonique non résolue → null (réservation libérable par l'appelant)", async () => {
    delete process.env.GEN3IA_APP_ORIGIN;
    const result = await publishDispatchTick({ delaySeconds: 250, slotEpoch: 7 });
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("les helpers d'URL sont stables (contrat receiver, fonctions pures)", () => {
    expect(missionTickUrl("https://gen3ia.online/")).toBe("https://gen3ia.online/api/queue/mission-tick");
    expect(dispatchTickUrl("https://gen3ia.online")).toBe("https://gen3ia.online/api/queue/dispatch-tick");
  });
});

describe("publishToDestination — défense en profondeur sur la destination", () => {
  it("rejette une destination http NON locale avant tout fetch", async () => {
    await expect(
      publishToDestination(CONFIG, "http://gen3ia.online/api/queue/mission-tick", "{}"),
    ).rejects.toThrow(/https requis hors dev local/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejette une destination dont l'hôte n'est pas dans l'allowlist", async () => {
    await expect(
      publishToDestination(CONFIG, "https://attacker.example.net/exfil", "{}"),
    ).rejects.toThrow(/non autorisé/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("tolère http pour le développement local", async () => {
    fetchMock.mockResolvedValue(okPublish("msg_local"));
    const result = await publishToDestination(CONFIG, "http://localhost:3000/api/queue/mission-tick", "{}");
    expect(result.messageId).toBe("msg_local");
  });

  it("assertSafeDestinationUrl lève une Error FR sur URL malformée", () => {
    expect(() => assertSafeDestinationUrl("pas-une-url")).toThrow(/Destination QStash invalide/);
  });
});
