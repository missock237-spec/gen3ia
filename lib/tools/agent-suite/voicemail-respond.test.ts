import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Task 140 — Outil « voicemail.respond » (Asynchronous Voice Message
 * Responder).
 *
 * Verrous :
 *  - analyse LLM facturée (generateStructuredForUser, tâche « agent », schéma
 *    d'intake strict) ;
 *  - expédition UNIQUEMENT via les canaux réellement configurés :
 *    email (Resend) et messagerie (WhatsApp/Telegram/Slack) — mockés à la
 *    frontière des modules d'intégration ;
 *  - le canal « call » n'est JAMAIS composé ici : renvoi honnête vers l'outil
 *    d'appel téléphonique IA ;
 *  - dryRun : aucun envoi, propositions retournées telles quelles ;
 *  - statuts honnêtes par canal (sent / skipped / unavailable / failed).
 */

vi.mock("@/lib/billing/ai-execution", () => ({
  generateForUser: vi.fn(),
}));

vi.mock("@/lib/integrations/email/send", () => ({
  sendAgentEmail: vi.fn(),
  isEmailProviderConfigured: vi.fn(),
}));

vi.mock("@/lib/integrations/messaging", () => ({
  sendAgentMessage: vi.fn(),
  getMessagingChannelStatus: vi.fn(),
  // Réplique fidèle de la normalisation WhatsApp (espaces, tirets, parenthèses).
  normalizeWhatsAppRecipient: (value: string) => value.replace(/[\s()\-.]/g, ""),
}));

import { generateForUser } from "@/lib/billing/ai-execution";
import { isEmailProviderConfigured, sendAgentEmail } from "@/lib/integrations/email/send";
import { getMessagingChannelStatus, sendAgentMessage } from "@/lib/integrations/messaging";

import { voicemailRespondTool } from "./voicemail-respond";

const mockedGenerate = vi.mocked(generateForUser);
const mockedEmailConfigured = vi.mocked(isEmailProviderConfigured);
const mockedSendEmail = vi.mocked(sendAgentEmail);
const mockedMessagingStatus = vi.mocked(getMessagingChannelStatus);
const mockedSendMessage = vi.mocked(sendAgentMessage);

const CONTEXT = { userId: "user-1", executionId: "exec-1" };

/** Le runtime (lib/tools/executor.ts) PARSE l'entrée via inputSchema avant execute — idem ici. */
function vmInput(overrides: Record<string, unknown> = {}) {
  return voicemailRespondTool.inputSchema.parse({ ...BASE_INPUT, ...overrides });
}

const INTAKE_PAYLOAD = {
  intent: "Demander un devis pour une formation en présentiel",
  urgency: "high",
  requestedAction: "Rappeler avec un devis détaillé sous 24 h",
  sentiment: "pressé mais courtois",
  keyData: [
    { label: "Budget", value: "5 000 €" },
    { label: "Effectif", value: "12 personnes" },
  ],
  proposedReply: {
    emailSubject: "Votre demande de devis — formation présentiel",
    emailBody: "Bonjour,\n\nSuite à votre message, voici les premières pistes pour votre devis…",
    smsBody: "Bonjour, votre devis est prêt. Puis-je vous rappeler aujourd'hui ?",
    callObjective: "Confirmer le budget, la date et envoyer le devis détaillé",
  },
};

const BASE_INPUT = {
  transcript: "Bonjour, c'est Marie, je voudrais un devis pour une formation pour mon équipe, c'est assez urgent, merci de me rappeler.",
  callerName: "Marie Dupont",
  callerNumber: "+33612345678",
  destinationEmail: "marie@exemple.com",
};

function mockIntake(payload: unknown = INTAKE_PAYLOAD): void {
  mockedGenerate.mockResolvedValueOnce({
    response: {
      id: "resp-test",
      provider: "glm",
      model: "glm-test",
      text: JSON.stringify(payload),
      usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
      latencyMs: 5,
    },
    chargeMinor: 0,
    providerCostEur: 0,
  });
}

beforeEach(() => {
  // resetAllMocks (et non clearAllMocks) : les files d'implémentations « Once »
  // d'un test antérieur prématurément interrompu ne doivent jamais fuiter.
  vi.resetAllMocks();
  mockedEmailConfigured.mockReturnValue(false);
  mockedMessagingStatus.mockReturnValue({ whatsapp: false, telegram: false, slack: false });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------------ */
/* Schéma d'entrée                                                    */
/* ------------------------------------------------------------------ */

describe("outil voicemail.respond — schéma d'entrée", () => {
  it("valide le numéro au format E.164 et la taille de la transcription", () => {
    const parsed = voicemailRespondTool.inputSchema.parse(BASE_INPUT);
    expect(parsed.dryRun).toBe(false);
    expect(() =>
      voicemailRespondTool.inputSchema.parse({ ...BASE_INPUT, callerNumber: "0612345678" }),
    ).toThrow();
    expect(() =>
      voicemailRespondTool.inputSchema.parse({ ...BASE_INPUT, transcript: "trop cou" }),
    ).toThrow();
    expect(() =>
      voicemailRespondTool.inputSchema.parse({ ...BASE_INPUT, destinationEmail: "pas-un-email" }),
    ).toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* Analyse LLM                                                         */
/* ------------------------------------------------------------------ */

describe("outil voicemail.respond — analyse LLM facturée", () => {
  it("appelle generateForUser (tâche agent, 1500 tokens max) et propage l'intake", async () => {
    mockIntake();
    const output = await voicemailRespondTool.execute(vmInput({ ...BASE_INPUT, dryRun: true }), CONTEXT);

    expect(mockedGenerate).toHaveBeenCalledTimes(1);
    const [params] = mockedGenerate.mock.calls[0];
    expect(params.request.task).toBe("agent");
    expect(params.request.maxTokens).toBe(1_500);
    expect(params.userId).toBe("user-1");
    expect(params.request.messages[0]?.content).toContain(BASE_INPUT.transcript);

    expect(output.intake).toEqual(INTAKE_PAYLOAD);
    expect(output.drafts).toEqual(INTAKE_PAYLOAD.proposedReply);
    expect(output.dryRun).toBe(true);
  });

  it("refuse une intake non conforme au schéma (relance puis erreur française)", async () => {
    // urgency hors énumération : les deux tentatives échouent.
    mockedGenerate.mockResolvedValue({
      response: {
        id: "resp-test",
        provider: "glm",
        model: "glm-test",
        text: JSON.stringify({ ...INTAKE_PAYLOAD, urgency: "extrême" }),
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        latencyMs: 1,
      },
      chargeMinor: 0,
      providerCostEur: 0,
    });

    await expect(voicemailRespondTool.execute(vmInput(), CONTEXT)).rejects.toThrow(/format attendu/);
    expect(mockedGenerate).toHaveBeenCalledTimes(2);
  });
});

/* ------------------------------------------------------------------ */
/* dryRun : aucun envoi                                                */
/* ------------------------------------------------------------------ */

describe("outil voicemail.respond — dryRun sans aucun envoi", () => {
  it("n'expédie rien et retourne les propositions", async () => {
    mockIntake();
    const output = await voicemailRespondTool.execute(
      vmInput({ ...BASE_INPUT, dryRun: true, destinationEmail: "marie@exemple.com" }),
      CONTEXT,
    );

    expect(output.sent).toEqual([]);
    expect(mockedSendEmail).not.toHaveBeenCalled();
    expect(mockedSendMessage).not.toHaveBeenCalled();
    expect(mockedEmailConfigured).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/* Canal email                                                         */
/* ------------------------------------------------------------------ */

describe("outil voicemail.respond — canal email (Resend)", () => {
  it("envoie l'email via sendAgentEmail et rapporte l'identifiant réel", async () => {
    mockedEmailConfigured.mockReturnValue(true);
    mockedSendEmail.mockResolvedValueOnce({ id: "email-123", recipients: ["marie@exemple.com"] });
    mockIntake();

    const output = await voicemailRespondTool.execute(vmInput(), CONTEXT);

    expect(mockedSendEmail).toHaveBeenCalledWith({
      userId: "user-1",
      to: "marie@exemple.com",
      subject: INTAKE_PAYLOAD.proposedReply.emailSubject,
      text: INTAKE_PAYLOAD.proposedReply.emailBody,
    });
    const emailDispatch = output.sent.find((entry) => entry.channel === "email");
    expect(emailDispatch).toEqual({
      channel: "email",
      status: "sent",
      detail: "email envoyé via Resend (id email-123)",
    });
  });

  it("fournisseur email absent : unavailable avec le motif RESEND/EMAIL en français", async () => {
    mockedEmailConfigured.mockReturnValue(false);
    mockIntake();

    const output = await voicemailRespondTool.execute(vmInput(), CONTEXT);
    const emailDispatch = output.sent.find((entry) => entry.channel === "email");
    expect(emailDispatch?.status).toBe("unavailable");
    expect(emailDispatch?.detail).toContain("RESEND_API_KEY");
    expect(emailDispatch?.detail).toContain("EMAIL_FROM_ADDRESS");
    expect(mockedSendEmail).not.toHaveBeenCalled();
  });

  it("échec d'envoi Resend : failed avec l'erreur réelle, sans masquage", async () => {
    mockedEmailConfigured.mockReturnValue(true);
    mockedSendEmail.mockRejectedValueOnce(new Error("Resend API error: domain not verified"));
    mockIntake();

    const output = await voicemailRespondTool.execute(vmInput(), CONTEXT);
    const dispatch = output.sent.find((entry) => entry.channel === "email");
    expect(dispatch?.status).toBe("failed");
    expect(dispatch?.detail).toContain("domain not verified");
  });

  it("aucune adresse de destination : skipped explicite", async () => {
    mockIntake();
    const { destinationEmail: _omis, ...sansEmail } = BASE_INPUT;
    const output = await voicemailRespondTool.execute(voicemailRespondTool.inputSchema.parse(sansEmail), CONTEXT);
    const dispatch = output.sent.find((entry) => entry.channel === "email");
    expect(dispatch?.status).toBe("skipped");
    expect(dispatch?.detail).toContain("aucune adresse email");
  });
});

/* ------------------------------------------------------------------ */
/* Canal messagerie (sms)                                              */
/* ------------------------------------------------------------------ */

describe("outil voicemail.respond — canal messagerie (WhatsApp prioritaire)", () => {
  it("envoie le SMS via WhatsApp (premier canal configuré) au numéro normalisé", async () => {
    mockedMessagingStatus.mockReturnValue({ whatsapp: true, telegram: true, slack: false });
    mockedSendMessage.mockResolvedValueOnce({ channel: "whatsapp", providerMessageId: "wamid-42" });
    mockIntake();

    const output = await voicemailRespondTool.execute(vmInput({ ...BASE_INPUT, destinationEmail: undefined }), CONTEXT);

    expect(mockedSendMessage).toHaveBeenCalledWith({
      userId: "user-1",
      channel: "whatsapp",
      to: "+33612345678",
      text: INTAKE_PAYLOAD.proposedReply.smsBody,
    });
    const smsDispatch = output.sent.find((entry) => entry.channel === "sms");
    expect(smsDispatch?.status).toBe("sent");
    expect(smsDispatch?.detail).toContain("whatsapp");
    expect(smsDispatch?.detail).toContain("wamid-42");
  });

  it("transmet le numéro E.164 de l'appelant comme destinataire WhatsApp (normalisation appliquée)", async () => {
    mockedMessagingStatus.mockReturnValue({ whatsapp: true, telegram: false, slack: false });
    mockedSendMessage.mockResolvedValueOnce({ channel: "whatsapp" });
    mockIntake();

    await voicemailRespondTool.execute(
      vmInput({ ...BASE_INPUT, callerNumber: "+33123456789", destinationEmail: undefined }),
      CONTEXT,
    );
    expect(mockedSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "whatsapp", to: "+33123456789" }),
    );
  });

  it("repli honnête sur Telegram si WhatsApp n'est pas configuré", async () => {
    mockedMessagingStatus.mockReturnValue({ whatsapp: false, telegram: true, slack: false });
    mockedSendMessage.mockResolvedValueOnce({ channel: "telegram", providerMessageId: "777" });
    mockIntake();

    const output = await voicemailRespondTool.execute(vmInput({ ...BASE_INPUT, destinationEmail: undefined }), CONTEXT);
    expect(mockedSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "telegram", to: "+33612345678" }),
    );
    const smsDispatch = output.sent.find((entry) => entry.channel === "sms");
    expect(smsDispatch?.status).toBe("sent");
    expect(smsDispatch?.detail).toContain("telegram");
  });

  it("aucun canal configuré : unavailable avec le motif français", async () => {
    mockIntake();
    const output = await voicemailRespondTool.execute(vmInput({ ...BASE_INPUT, destinationEmail: undefined }), CONTEXT);
    const smsDispatch = output.sent.find((entry) => entry.channel === "sms");
    expect(smsDispatch?.status).toBe("unavailable");
    expect(smsDispatch?.detail).toContain("aucun canal de messagerie configuré");
    expect(mockedSendMessage).not.toHaveBeenCalled();
  });

  it("seul Slack est configuré : un numéro ne peut pas recevoir de message Slack (skipped honnête)", async () => {
    mockedMessagingStatus.mockReturnValue({ whatsapp: false, telegram: false, slack: true });
    mockIntake();

    const output = await voicemailRespondTool.execute(vmInput({ ...BASE_INPUT, destinationEmail: undefined }), CONTEXT);
    const smsDispatch = output.sent.find((entry) => entry.channel === "sms");
    expect(smsDispatch?.status).toBe("skipped");
    expect(smsDispatch?.detail).toContain("Slack");
    expect(mockedSendMessage).not.toHaveBeenCalled();
  });

  it("échec du provider de messagerie : unavailable avec l'erreur réelle", async () => {
    mockedMessagingStatus.mockReturnValue({ whatsapp: true, telegram: false, slack: false });
    mockedSendMessage.mockRejectedValueOnce(new Error("Messaging provider error: invalid recipient"));
    mockIntake();

    const output = await voicemailRespondTool.execute(vmInput({ ...BASE_INPUT, destinationEmail: undefined }), CONTEXT);
    const smsDispatch = output.sent.find((entry) => entry.channel === "sms");
    expect(smsDispatch?.status).toBe("unavailable");
    expect(smsDispatch?.detail).toContain("invalid recipient");
  });

  it("aucun numéro d'appelant : skipped explicite", async () => {
    mockIntake();
    const { callerNumber: _omis, destinationEmail: _nonPlus, ...sansNumero } = BASE_INPUT;
    const output = await voicemailRespondTool.execute(voicemailRespondTool.inputSchema.parse(sansNumero), CONTEXT);
    const smsDispatch = output.sent.find((entry) => entry.channel === "sms");
    expect(smsDispatch?.status).toBe("skipped");
    expect(smsDispatch?.detail).toContain("aucun numéro d'appelant");
  });
});

/* ------------------------------------------------------------------ */
/* Canal appel (jamais composé ici)                                    */
/* ------------------------------------------------------------------ */

describe("outil voicemail.respond — canal appel (renvoi vers phone.call)", () => {
  it("avec numéro : skipped avec le motif de renvoi vers l'outil d'appel IA", async () => {
    mockIntake();
    const output = await voicemailRespondTool.execute(vmInput({ ...BASE_INPUT, destinationEmail: undefined }), CONTEXT);
    const callDispatch = output.sent.find((entry) => entry.channel === "call");
    expect(callDispatch).toEqual({
      channel: "call",
      status: "skipped",
      detail: "lancement d'appel à effectuer via l'outil d'appel téléphonique IA avec un agent vocal",
    });
  });

  it("sans numéro : skipped avec l'autre motif", async () => {
    mockIntake();
    const { callerNumber: _omis, destinationEmail: _nonPlus, ...sansNumero } = BASE_INPUT;
    const output = await voicemailRespondTool.execute(voicemailRespondTool.inputSchema.parse(sansNumero), CONTEXT);
    const callDispatch = output.sent.find((entry) => entry.channel === "call");
    expect(callDispatch?.status).toBe("skipped");
    expect(callDispatch?.detail).toContain("aucun numéro à rappeler");
  });
});

/* ------------------------------------------------------------------ */
/* Canal préféré                                                      */
/* ------------------------------------------------------------------ */

describe("outil voicemail.respond — canal préféré en tête", () => {
  it("preferredChannel place le canal demandé en premier dans la liste", async () => {
    mockIntake();
    const output = await voicemailRespondTool.execute(
      vmInput({ ...BASE_INPUT, preferredChannel: "call" }),
      CONTEXT,
    );
    expect(output.sent[0]?.channel).toBe("call");
    expect(output.sent.map((entry) => entry.channel).sort()).toEqual(["call", "email", "sms"]);
  });
});
