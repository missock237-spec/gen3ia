/**
 * GARDE INSTANTANÉ DE FICHIERS (incidence réelle it.143, 2026-11-10,
 * production) — la pièce jointe du chat était perdue SILENCIEUSEMENT :
 * FileList est une vue LIVE vidée par `e.target.value = ""` avant que
 * l'updater différé de setFichiers ne la lise. La matérialisation
 * (instantaneFichiers) doit être appelée AVANT la mise en file d'état —
 * jamais un Array.from(live) différé.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { instantaneFichiers } from "./instantane-fichiers";

/** Vue LIVE qui imite FileList et peut être vidée après coup. */
function vueLive(files: File[]): FileList & { vider: () => void } {
  const sac = [...files];
  const vue = {
    get length() {
      return sac.length;
    },
    item(i: number): File | null {
      return sac[i] ?? null;
    },
    vider() {
      sac.length = 0;
    },
  } as FileList & { vider: () => void };
  sac.forEach((f, i) => {
    Object.defineProperty(vue, i, { get: () => sac[i], enumerable: true });
  });
  return vue;
}

describe("instantaneFichiers — matérialisation avant file d'attente d'état", () => {
  it("résiste à la mutation POSTÉRIEURE de la vue live (le poison it.143)", () => {
    const pdf = new File(["contenu pdf"], "artefact-e2e-gen3ia.pdf", {
      type: "application/pdf",
    });
    const vue = vueLive([pdf]);
    const instantane = instantaneFichiers(vue);
    // le handler vide l'input APRÈS la mise en file — la vue live est vide
    // au moment où l'updater s'exécuterait
    vue.vider();
    expect(Array.from(vue)).toHaveLength(0);
    // MAIS l'instantané, pris AVANT, conserve le fichier
    expect(instantane).toHaveLength(1);
    expect(instantane[0]!.nom).toBe("artefact-e2e-gen3ia.pdf");
    expect(instantane[0]!.taille).toBe(pdf.size);
    expect(instantane[0]!.type).toBe("application/pdf");
    expect(instantane[0]!.fichier).toBe(pdf);
    expect(instantane[0]!.image).toBe(false);
  });

  it("null / undefined → tableau vide (jamais d'exception)", () => {
    expect(instantaneFichiers(null)).toEqual([]);
    expect(instantaneFichiers(undefined)).toEqual([]);
  });

  it("accepte un tableau File[] direct (chemin dataTransfer/paste)", () => {
    const a = new File(["a"], "a.txt", { type: "text/plain" });
    const b = new File([new Uint8Array(4)], "b.png", { type: "image/png" });
    const instantane = instantaneFichiers([a, b]);
    expect(instantane).toHaveLength(2);
    expect(instantane[0]!.image).toBe(false);
    expect(instantane[1]!.image).toBe(true);
  });

  it("CÂBLAGE nova-chat : instantané pris AVANT setFichiers, handler laisse le value=\"\" (désormais inoffensif)", () => {
    const source = readFileSync(
      join(process.cwd(), "components/chat/nova-chat.tsx"),
      "utf-8",
    );
    // 1. l'import du helper est présent
    expect(source).toContain('import { instantaneFichiers } from "@/lib/files/instantane-fichiers";');
    // 2. dans ajouterFichiers, la matérialisation précède la mise en file
    const debut = source.indexOf("const ajouterFichiers = React.useCallback(");
    expect(debut).toBeGreaterThan(-1);
    const corps = source.slice(debut, debut + 2600);
    const posInstantane = corps.indexOf("const instantane = instantaneFichiers(liste);");
    const posSetFichiers = corps.indexOf("setFichiers((courants) => {");
    expect(posInstantane).toBeGreaterThan(-1);
    expect(posSetFichiers).toBeGreaterThan(posInstantane);
    // 3. plus AUCUN Array.from(liste) différé dans le composer (hors
    //    commentaires — on scanne le CODE)
    const sansCommentaires = corps
      .split("\n")
      .map((l) => l.replace(/\/\/.*$/, ""))
      .join("\n");
    expect(sansCommentaires.includes("Array.from(liste)")).toBe(false);
    // 4. le vidage de l'input reste en place (combiné à l'instantané, il est
    //    inoffensif — et il permet de re-joindre le même fichier)
    expect(source.includes('e.target.value = "";')).toBe(true);
  });
});
