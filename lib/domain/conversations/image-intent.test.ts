import { describe, expect, it } from "vitest";

import {
  hasImageAttachment,
  looksLikeImageEditRequest,
  shouldRouteImageEdit,
} from "./image-intent";
import type { MessageAttachment } from "./types";

/** Étape 8 du plan 20 — détection déterministe de l'intention d'édition d'image. */
describe("looksLikeImageEditRequest", () => {
  it("reconnaît une retouche explicite sur une image référencée", () => {
    expect(looksLikeImageEditRequest("Modifie cette image : rends le ciel bleu")).toBe(true);
    expect(looksLikeImageEditRequest("Retouche la photo pour enlever les passants")).toBe(true);
    expect(looksLikeImageEditRequest("Change le fond de ce logo en blanc")).toBe(true);
    expect(looksLikeImageEditRequest("Mets l'image en noir et blanc")).toBe(true);
    expect(looksLikeImageEditRequest("Édite cette image générée et ajoute un arc-en-ciel")).toBe(true);
  });

  it("reconnaît les modifications ciblées sans référence explicite", () => {
    expect(looksLikeImageEditRequest("Supprime l'arrière-plan")).toBe(true);
    expect(looksLikeImageEditRequest("Mets le fond flou")).toBe(true);
    expect(looksLikeImageEditRequest("Transforme la photo en haute définition")).toBe(true);
  });

  it("rejette les demandes de GÉNÉRATION pure (pas d'édition)", () => {
    expect(looksLikeImageEditRequest("Dessine-moi un chat qui porte un chapeau")).toBe(false);
    expect(looksLikeImageEditRequest("Génère un logo moderne pour ma marque")).toBe(false);
    expect(looksLikeImageEditRequest("Crée une bannière bleue pour ma boutique")).toBe(false);
  });

  it("rejette les questions explicatives et les modifications de documents", () => {
    expect(looksLikeImageEditRequest("Comment modifier une image sur Gen3ia ?")).toBe(false);
    expect(looksLikeImageEditRequest("Modifie ce rapport pour ajouter la section budget")).toBe(false);
    expect(looksLikeImageEditRequest("Change le titre du document")).toBe(false);
  });
});

describe("hasImageAttachment", () => {
  it("reconnaît une image par contentType ou extension, avec ressource", () => {
    const image: MessageAttachment = { filename: "produit.png", contentType: "image/png", path: "users/u1/permanent/imported-images/1.png" };
    expect(hasImageAttachment([image])).toBe(true);
    const remote: MessageAttachment = { filename: "photo.jpg", url: "https://exemple.com/photo.jpg" };
    expect(hasImageAttachment([remote])).toBe(true);
  });

  it("rejette les documents texte et les images sans ressource", () => {
    const csv: MessageAttachment = { filename: "ventes.csv", contentType: "text/csv", fileId: "f1" };
    expect(hasImageAttachment([csv])).toBe(false);
    const orphan: MessageAttachment = { filename: "produit.png", contentType: "image/png", fileId: "f2" };
    expect(hasImageAttachment([orphan])).toBe(false);
    expect(hasImageAttachment(undefined)).toBe(false);
  });
});

describe("shouldRouteImageEdit", () => {
  const editMessage = "Rends le ciel bleu sur cette photo";

  it("route l'édition avec image jointe OU image existante dans la conversation", () => {
    expect(shouldRouteImageEdit(editMessage, { hasImageAttachment: true, hasConversationImage: false })).toBe(true);
    expect(shouldRouteImageEdit(editMessage, { hasImageAttachment: false, hasConversationImage: true })).toBe(true);
    expect(shouldRouteImageEdit(editMessage, { hasImageAttachment: true, hasConversationImage: true })).toBe(true);
  });

  it("ne route PAS sans aucune source disponible (ni jointe, ni dans la conversation)", () => {
    expect(shouldRouteImageEdit(editMessage, { hasImageAttachment: false, hasConversationImage: false })).toBe(false);
  });

  it("ne route jamais une demande qui n'est pas une édition", () => {
    expect(shouldRouteImageEdit("Génère un logo de café", { hasImageAttachment: true, hasConversationImage: true })).toBe(false);
  });
});
