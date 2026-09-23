import { describe, expect, it } from "vitest";

import { isRunnableHtmlApp, runnableAppsFrom } from "./app-detect";
import type { ConversationArtifact } from "./types";

function artifact(partial: Partial<ConversationArtifact>): ConversationArtifact {
  return {
    id: "a1",
    userId: "u1",
    type: "code",
    title: "Mon app",
    versions: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

describe("isRunnableHtmlApp", () => {
  it("reconnaît un artefact de code HTML", () => {
    expect(isRunnableHtmlApp(artifact({ type: "code", language: "html", content: "<!DOCTYPE html><html></html>" }))).toBe(true);
  });

  it("reconnaît un document html par son contenu même sans langage", () => {
    expect(isRunnableHtmlApp(artifact({ type: "code", content: "<html><body>hi</body></html>" }))).toBe(true);
  });

  it("rejette le code non html et les artefacts sans contenu", () => {
    expect(isRunnableHtmlApp(artifact({ type: "code", language: "python", content: "print(1)" }))).toBe(false);
    expect(isRunnableHtmlApp(artifact({ type: "code", language: "html" }))).toBe(false);
  });

  it("rejette les artefacts d'un autre type et les valeurs nulles", () => {
    expect(isRunnableHtmlApp(artifact({ type: "document", language: "html", content: "<!DOCTYPE html>" }))).toBe(false);
    expect(isRunnableHtmlApp(null)).toBe(false);
    expect(isRunnableHtmlApp(undefined)).toBe(false);
  });
});

describe("runnableAppsFrom", () => {
  it("ne conserve que les apps exécutables", () => {
    const list = [
      artifact({ id: "1", type: "code", language: "html", content: "<!DOCTYPE html>" }),
      artifact({ id: "2", type: "document", content: "rapport" }),
      artifact({ id: "3", type: "code", content: "<html></html>" }),
    ];
    expect(runnableAppsFrom(list).map((a) => a.id)).toEqual(["1", "3"]);
  });
});
