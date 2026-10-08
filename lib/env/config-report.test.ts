import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  describeEnvGroups,
  listRecognizedOptional,
  summarizeEnv,
} from "./config-report";

describe("lib/env/config-report", () => {
  it("signale les groupes complets comme présents", () => {
    const env = {
      RESEND_API_KEY: "re_test",
      EMAIL_FROM_ADDRESS: "no-reply@gen3ia.online",
    };
    const groups = describeEnvGroups(env);
    const email = groups.find((g) => g.group === "email-resend");
    expect(email?.present).toBe(true);
    expect(email?.missing).toEqual([]);
  });

  it("liste uniquement les NOMS des variables manquantes (jamais de valeur)", () => {
    const groups = describeEnvGroups({
      R2_ACCOUNT_ID: "abc",
      R2_ACCESS_KEY_ID: "def",
      // R2_SECRET_ACCESS_KEY et R2_BUCKET volontairement absents
    });
    const r2 = groups.find((g) => g.group === "storage-r2");
    expect(r2?.present).toBe(false);
    expect(r2?.missing).toEqual(["R2_SECRET_ACCESS_KEY", "R2_BUCKET"]);
  });

  it("traite les valeurs vides/espaces comme absentes", () => {
    const groups = describeEnvGroups({ OPENAI_API_KEY: "   " });
    const openai = groups.find((g) => g.group === "llm-openai");
    expect(openai?.present).toBe(false);
    expect(openai?.missing).toEqual(["OPENAI_API_KEY"]);
  });

  it("n'expose jamais la valeur d'une variable dans le rapport", () => {
    const report = summarizeEnv({
      FIREBASE_PROJECT_ID: "secret-project",
      FIREBASE_CLIENT_EMAIL: "svc@secret.iam.gserviceaccount.com",
      FIREBASE_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----SUPERSECRET",
      OPENAI_API_KEY: "sk-supersecret",
      GROQ_API_KEY: "gsk-supersecret",
      GLM_API_KEY: "glm-secret",
      AGNES_API_KEY: "agnes-secret",
      QDRANT_URL: "https://qdrant.secret.io",
      QDRANT_API_KEY: "qdrant-secret",
      R2_ACCOUNT_ID: "r2-id",
      R2_ACCESS_KEY_ID: "r2-key",
      R2_SECRET_ACCESS_KEY: "r2-secret",
      R2_BUCKET: "r2-bucket",
      RESEND_API_KEY: "re-secret",
      EMAIL_FROM_ADDRESS: "no-reply@gen3ia.online",
      TWILIO_ACCOUNT_SID: "AC-secret",
      TWILIO_AUTH_TOKEN: "tw-secret",
      TWILIO_PHONE_NUMBER: "+237600000000",
      ELEVENLABS_API_KEY: "el-secret",
      COMPOSIO_API_KEY: "co-secret",
      CHARIOW_API_BASE_URL: "https://chariow.secret",
      CHARIOW_TOPUP_PRODUCT_ID: "prod-secret",
      SANDBOX_URL: "https://sandbox.secret",
      SANDBOX_SHARED_SECRET: "sb-secret",
    });
    expect(report.ok).toBe(true);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("supersecret");
    expect(serialized).not.toContain("sk-");
    expect(serialized).not.toContain("BEGIN PRIVATE KEY");
    expect(serialized).not.toContain("secret-project");
    expect(serialized).not.toContain("+237600000000");
  });

  it("ok reste true tant que firebase-admin est présent, même avec des groupes dégradés", () => {
    const report = summarizeEnv({
      FIREBASE_PROJECT_ID: "p",
      FIREBASE_CLIENT_EMAIL: "e",
      FIREBASE_PRIVATE_KEY: "k",
      // tout le reste absent : replis assumés
    });
    expect(report.ok).toBe(true);
    const degraded = report.groups.filter((g) => !g.present).map((g) => g.group);
    expect(degraded).toContain("llm-openai");
    expect(degraded).toContain("storage-r2");
    expect(report.groups.every((g) => g.fallback.length > 0)).toBe(true);
  });

  it("ok passe à false si firebase-admin est incomplet (vital)", () => {
    const report = summarizeEnv({});
    expect(report.ok).toBe(false);
  });

  it("liste les optionnels reconnus réellement présents", () => {
    const optional = listRecognizedOptional({
      OPENROUTER_API_KEY: "ok-present",
      SENTRY_DSN: "https://sentry.example/1",
      UNKNOWN_VAR: "ignored",
    });
    expect(optional).toContain("OPENROUTER_API_KEY");
    expect(optional).toContain("SENTRY_DSN");
    expect(optional).not.toContain("UNKNOWN_VAR");
  });

  it("reconnaît les variables média lues par le code (AGNES_API_KEY n'est plus un faux écart)", () => {
    // Cas d'école de l'audit médias 103-c : AGNES_API_KEY est REQUISE dans le
    // groupe llm-agnes ET doit être reconnue par la liste optionnelle — sinon
    // /api/health/infra signale un écart fantôme entre câblage et reconnaissance.
    const env = { AGNES_API_KEY: "agnes-test-key", GEN3IA_APP_ORIGIN: "https://gen3ia.online" };
    const groups = describeEnvGroups(env);
    expect(groups.find((g) => g.group === "llm-agnes")?.present).toBe(true);
    const optional = listRecognizedOptional(env);
    expect(optional).toContain("AGNES_API_KEY");
    expect(optional).toContain("GEN3IA_APP_ORIGIN");
  });

  // ─── Gardes structurels (convention du dépôt) : la liste des variables ───
  // ─── reconnues doit couvrir TOUTE variable média réellement lue, sinon  ───
  // ─── la sonde d'infra produit un faux écart (audit médias 103-c).       ───
  const source = readFileSync(path.join(import.meta.dirname, "config-report.ts"), "utf8");

  it("garde : OPTIONAL_RECOGNIZED reconnaît AGNES_API_KEY et ses surcharges modèle/endpoint", () => {
    expect(source).toContain('"AGNES_API_KEY"');
    expect(source).toContain('"AGNES_IMAGE_MODEL"');
    expect(source).toContain('"AGNES_API_BASE"');
    expect(source).toContain('"AGNES_TEXT_MODEL"');
  });

  it("garde : OPTIONAL_RECOGNIZED reconnaît la voix/le rendu 21st et le pipeline vidéo", () => {
    expect(source).toContain('"ELEVENLABS_VOICE_ID"');
    expect(source).toContain('"TWENTY_FIRST_API_KEY"');
    expect(source).toContain('"VIDEO_FFMPEG_PATH"');
    expect(source).toContain('"VIDEO_FFPROBE_PATH"');
    expect(source).toContain('"VIDEO_FONT_PATH"');
    expect(source).toContain('"VIDEO_STATIC_RELEASE_TAG"');
  });

  it("garde : OPTIONAL_RECOGNIZED reconnaît l'origine publique GEN3IA_APP_ORIGIN", () => {
    expect(source).toContain('"GEN3IA_APP_ORIGIN"');
  });
});
