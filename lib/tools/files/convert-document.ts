import { z } from "zod";
import type { ToolDefinition } from "../types";
import { getArtifactRecord } from "@/lib/documents/artifact-repository";
import { assertArtifactOwner } from "@/lib/documents/artifact-access";
import { generateArtifact } from "@/lib/documents/engine";
import { storeArtifactBuffer, getArtifactDownloadUrl } from "@/lib/documents/artifact-store";
import { downloadFromR2, isR2Configured } from "@/lib/storage/r2";
import { isOwnedPermanentKey } from "@/lib/files/import";
import { extraireContenuDocument, type ContenuExtrait } from "@/lib/documents/extraction";
import type { DocumentBlock } from "@/lib/documents/types";

const inputSchema = z.object({
  // Format cible : toute la matrice création du moteur documentaire.
  format: z.enum(["pdf", "docx", "xlsx", "pptx", "csv", "md", "txt", "json", "html", "odt", "ods", "odp", "rtf", "yaml"]),
  titre: z.string().min(1).max(300).optional(),
  // Source A : un livrable déjà produit (artifact du compte).
  artifactId: z.string().min(1).max(128).optional(),
  // Source B : un fichier du stockage PERMANENT du propriétaire (canal R2,
  // clé users/{uid}/permanent/… — même cloisonnement que l'import).
  cheminPermanent: z.string().min(1).max(500).optional(),
  nomFichier: z.string().min(1).max(255).optional(),
});

export const MAX_BLOCS_PARAGRAPHES = 200;
export const MAX_LIGNES_TABLEAU = 300;
const MAX_CARACTERES_PAR_BLOC = 1_500;

/**
 * Traduit un contenu extrait en plan de document (blocs) — fonction pure,
 * testée séparément de l'outillage stockage. Les tableaux deviennent des
 * blocs table, le texte des paragraphes découpés, les archives une liste
 * d'entrées ; chaque perte (troncature) est annoncée dans une note.
 */
export function construirePlanDepuisContenu(
  contenu: ContenuExtrait,
  format: string,
  titre: string,
): { title: string; format: string; blocks: DocumentBlock[]; description: string } {
  const blocks: DocumentBlock[] = [];
  const pertes: string[] = [];

  if (contenu.tableau && contenu.tableau.lignes.length > 0) {
    const lignes = contenu.tableau.lignes.slice(0, MAX_LIGNES_TABLEAU);
    if (contenu.tableau.lignes.length > MAX_LIGNES_TABLEAU) {
      pertes.push(`tableau tronqué à ${MAX_LIGNES_TABLEAU} lignes`);
    }
    blocks.push({
      type: "table",
      columns: contenu.tableau.colonnes.slice(0, 64),
      rows: lignes.map((ligne) => ligne.slice(0, 64).map((cellule) => String(cellule ?? ""))),
    });
  }

  if (contenu.texte.trim()) {
    const texte = contenu.texte.trim();
    const morceaux: string[] = [];
    // Découpe par paragraphes puis regroupement en blocs bornés.
    let courant = "";
    for (const paragraphe of texte.split(/\n{2,}/)) {
      if (courant && courant.length + paragraphe.length > MAX_CARACTERES_PAR_BLOC) {
        morceaux.push(courant);
        courant = "";
      }
      const nettoye = paragraphe.trim();
      if (nettoye) courant = courant ? `${courant}\n${nettoye}` : nettoye;
      while (courant.length > MAX_CARACTERES_PAR_BLOC * 4) {
        morceaux.push(courant.slice(0, MAX_CARACTERES_PAR_BLOC * 4));
        courant = courant.slice(MAX_CARACTERES_PAR_BLOC * 4);
      }
    }
    if (courant) morceaux.push(courant);

    const retenus = morceaux.slice(0, MAX_BLOCS_PARAGRAPHES);
    if (morceaux.length > MAX_BLOCS_PARAGRAPHES) {
      pertes.push(`texte tronqué à ${MAX_BLOCS_PARAGRAPHES} blocs (sur ${morceaux.length})`);
    }
    for (const morceau of retenus) blocks.push({ type: "paragraph", text: morceau });
  }

  if (contenu.entrees && contenu.entrees.length > 0) {
    const noms = contenu.entrees.slice(0, 200).map((e) => `${e.chemin} (${e.taille} o)`);
    blocks.push({ type: "list", ordered: false, items: noms });
    if (contenu.entrees.length > 200) pertes.push("liste des entrées tronquée à 200");
  }

  if (blocks.length === 0) {
    throw new Error(
      `Aucun contenu extractible dans la source (${contenu.kind}${contenu.note ? ` — ${contenu.note}` : ""}). Conversion impossible sans contenu.`,
    );
  }

  const description = [
    `Conversion ${contenu.kind} → ${format} par le moteur documentaire Gen3ia.`,
    contenu.note ? `Source : ${contenu.note}` : "",
    pertes.length ? `Limites appliquées : ${pertes.join(", ")}.` : "",
  ]
    .filter(Boolean)
    .join(" ");

  blocks.unshift({ type: "title", text: titre });

  return { title: titre, format, blocks, description };
}

async function chargerBufferSource(
  input: z.infer<typeof inputSchema>,
  userId: string,
): Promise<{ buffer: Buffer; nomFichier: string }> {
  if (input.artifactId) {
    const artifact = await getArtifactRecord(input.artifactId);
    if (!artifact) throw new Error("Livrable source introuvable.");
    assertArtifactOwner(artifact, userId);
    if (artifact.inlineData) {
      return { buffer: Buffer.from(artifact.inlineData, "base64"), nomFichier: artifact.name };
    }
    if (!isR2Configured()) throw new Error("Livrable en stockage objet mais R2 non configuré.");
    const buffer = await downloadFromR2(artifact.storageKey);
    if (!buffer || buffer.length === 0) throw new Error("Livrable source illisible (stockage vide).");
    return { buffer, nomFichier: artifact.name };
  }

  if (input.cheminPermanent) {
    if (!input.nomFichier) throw new Error("nomFichier requis avec cheminPermanent.");
    if (!isOwnedPermanentKey(userId, input.cheminPermanent)) {
      throw new Error("Chemin de stockage invalide pour ce compte.");
    }
    const buffer = await downloadFromR2(input.cheminPermanent);
    if (!buffer || buffer.length === 0) throw new Error("Fichier source introuvable dans le stockage permanent.");
    return { buffer, nomFichier: input.nomFichier };
  }

  throw new Error("Source manquante : fournissez artifactId OU cheminPermanent + nomFichier.");
}

export const convertDocumentTool: ToolDefinition = {
  id: "artifact.convert",
  name: "artifact.convert",
  description:
    "Convertit un document réel vers un autre format (pdf, docx, xlsx, pptx, csv, md, txt, json, html, odt, ods, odp, rtf, yaml) : extraction du contenu source (texte, tableaux, entrées d'archive), reconstruction en blocs, génération et stockage du livrable téléchargeable.",
  category: "files",
  risk: "medium",
  inputSchema,
  async execute(input, context) {
    const parsed = inputSchema.parse(input);
    const { buffer, nomFichier } = await chargerBufferSource(parsed, context.userId);
    const contenu = await extraireContenuDocument(buffer, nomFichier);
    const titre = parsed.titre?.trim() || `${nomFichier.replace(/\.[^.]+$/, "")} (${parsed.format.toUpperCase()})`;
    const plan = construirePlanDepuisContenu(contenu, parsed.format, titre);

    const genere = await generateArtifact({
      userId: context.userId,
      projectId: context.projectId,
      executionId: context.executionId,
      plan: plan as Parameters<typeof generateArtifact>[0]["plan"],
    });

    const stocke = await storeArtifactBuffer({
      ownerId: context.userId,
      executionId: context.executionId ?? "unknown",
      name: genere.filename,
      mimeType: genere.mimeType,
      data: genere.data,
    });
    const urlTelechargement = await getArtifactDownloadUrl(stocke.artifactId, context.userId);

    return {
      success: true,
      source: { kind: contenu.kind, nomFichier, note: contenu.note ?? null },
      artifactId: stocke.artifactId,
      filename: genere.filename,
      format: genere.format,
      sizeBytes: genere.sizeBytes,
      downloadUrl: urlTelechargement,
      description: plan.description,
    };
  },
};
