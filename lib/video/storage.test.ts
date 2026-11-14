import { describe, expect, it } from "vitest";

import { videoObjectKey } from "./storage";

/**
 * Contrat des clés R2 vidéo — FIX sonde production (rendus concurrents
 * s'écrasant mutuellement) : un nom de fichier peut porter des SOUS-DOSSIERS
 * sûrs (« <jobId>/master.mp4 ») pour isoler chaque rendu de rendu ;
 * l'aplatissement historique faisait écrire tous les jobs du projet dans
 * le même dossier plat (master.mp4, artefacts.json, segments partagés).
 */
describe("videoObjectKey — sous-dossiers sûrs pour isoler les rendus", () => {
  it("préserve le sous-dossier jobId du rendu", () => {
    const cle = videoObjectKey({ userId: "u1", projectId: "p1", domain: "renders", fileName: "jobABC123/master.mp4" });
    expect(cle).toBe("users/u1/video/p1/renders/jobABC123/master.mp4");
    const segments = videoObjectKey({ userId: "u1", projectId: "p1", domain: "renders", fileName: "jobABC123/segments/segment_0001.mp4" });
    expect(segments.endsWith("/renders/jobABC123/segments/segment_0001.mp4")).toBe(true);
    const manifeste = videoObjectKey({ userId: "u1", projectId: "p1", domain: "renders", fileName: "jobABC123/artefacts.json" });
    expect(manifeste).toBe("users/u1/video/p1/renders/jobABC123/artefacts.json");
  });

  it("refuse toute traversée de chemin ou segment dangereux", () => {
    expect(() => videoObjectKey({ userId: "u1", projectId: "p1", domain: "renders", fileName: "../evil.bin" })).toThrow();
    expect(() => videoObjectKey({ userId: "u1", projectId: "p1", domain: "renders", fileName: "a/../b.bin" })).toThrow();
    expect(() => videoObjectKey({ userId: "u1", projectId: "p1", domain: "renders", fileName: "./relatif.bin" })).toThrow();
    expect(() => videoObjectKey({ userId: "u1", projectId: "p1", domain: "renders", fileName: "a//b.bin" })).toThrow();
    expect(() => videoObjectKey({ userId: "u1", projectId: "p1", domain: "renders", fileName: "/absolu.bin" })).toThrow();
    expect(() => videoObjectKey({ userId: "u1", projectId: "p1", domain: "renders", fileName: "dossier/" })).toThrow();
    expect(() => videoObjectKey({ userId: "u1", projectId: "p1", domain: "renders", fileName: "es pace.bin" })).toThrow();
  });

  it("conserve le comportement historique (nom plat, fichier par défaut)", () => {
    expect(videoObjectKey({ userId: "u1", projectId: "p1", domain: "images", fileName: "scene_001.png" })).toBe("users/u1/video/p1/images/scene_001.png");
    const defaut = videoObjectKey({ userId: "u1", projectId: "p1", domain: "tmp-uploads" });
    expect(defaut.startsWith("users/u1/video/p1/tmp-uploads/")).toBe(true);
    expect(defaut.split("/").pop()).toMatch(/^[a-f0-9-]{36}$/);
  });
});
