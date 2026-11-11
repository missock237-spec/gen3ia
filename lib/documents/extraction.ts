/**
 * Cœur d'EXTRACTION unifié du moteur documentaire.
 *
 * La demande : « importer et reconnaître les différents formats, extraire
 * le texte, les tableaux et les images ». Le pipeline d'import de fichiers
 * (lib/files/import.ts) gère déjà le téléversement ; ce module donne aux
 * OUTILS neuronaux (artifact.convert, artifact.get, analyse) le même
 * pouvoir d'extraction sur un buffer quelconque — une seule vérité sur les
 * formats, réutilisée par la conversion et l'analyse.
 *
 * 100 % réutilisable et testable : fonctions pures, aucun accès base ni
 * réseau, échec HONNÊTE par format (message actionnable, jamais muet).
 */

import { pdfToText } from "@/lib/files/pdf-text";
import {
  epubToText,
  odsToText,
  opendocumentToText,
  pptxToText,
  rtfToText,
} from "@/lib/files/office-text";
import { docxToText, htmlToText } from "@/lib/knowledge/ingestion";
import { markupToText } from "@/lib/content/html-text";
import { metadonneesImage } from "@/lib/files/image-meta";
import { estArchive7z, lireTar, type EntreeTar } from "@/lib/files/tar-text";
import { parseCsv } from "@/lib/files/import";
import * as jsYaml from "js-yaml";

export interface ContenuExtrait {
  /** Famille reconnue (extension canonique ou signature). */
  kind: string;
  /** Texte principal extrait (vide si format sans texte). */
  texte: string;
  /** Structure (JSON/YAML parsé, CSV → lignes). */
  structured?: unknown;
  /** Tableau principal (CSV/XLSX/ODS) prêt pour un bloc document. */
  tableau?: { colonnes: string[]; lignes: string[][] };
  pages?: number;
  feuilles?: number;
  dimensions?: { format: string; largeur: number; hauteur: number };
  /** Entrées d'archive (zip/tar) : chemin + taille + type. */
  entrees?: EntreeTar[];
  conversion: "full" | "metadata-only";
  note?: string;
}

/** Extensions « texte de programmation / données » servies telles quelles. */
const EXTENSIONS_CODE = new Set([
  "py", "js", "jsx", "ts", "tsx", "html", "htm", "css", "scss", "json", "sh", "sql", "java", "go", "rs", "c", "cpp", "h", "rb", "php", "yml", "yaml", "toml", "ini", "env", "xml", "svg", "txt", "md", "markdown", "csv", "tsv", "log",
]);

function tableauDepuisLignes(entete: string[], lignes: string[][]) {
  return { colonnes: entete, lignes };
}

/** Limite de sécurité pour les textes injectés dans des blocs de document. */
const MAX_CARACTERES_TEXTE = 600_000;

/**
 * Reconnaît le format d'un buffer par SIGNATURE d'abord (l'extension peut
 * mentir), puis par extension, puis tente le texte.
 */
export async function extraireContenuDocument(
  buffer: Buffer,
  filename: string,
): Promise<ContenuExtrait> {
  const nom = filename.toLowerCase();
  const extension = nom.includes(".") ? nom.split(".").pop()! : "";

  // 1) Signatures binaires — l'extension ne fait pas autorité.
  if (metadonneesImage(buffer)) {
    const dimensions = metadonneesImage(buffer)!;
    return {
      kind: dimensions.format,
      texte: "",
      dimensions,
      conversion: "metadata-only",
      note: `Image ${dimensions.format.toUpperCase()} — dimensions réelles ${dimensions.largeur}×${dimensions.hauteur} px (ratio ${(dimensions.largeur / dimensions.hauteur).toFixed(2)}), ${Math.round(buffer.length / 1024)} Ko.`,
    };
  }
  if (estArchive7z(buffer)) {
    return {
      kind: "7z",
      texte: "",
      conversion: "metadata-only",
      note: "Archive 7z reconnue par sa signature, mais la décompression LZMA n'est pas incluse dans le moteur local. Convertissez-la en .zip ou .tar pour que Gen3ia liste et lise son contenu.",
    };
  }

  // 2) Familles déclarées par extension.
  switch (extension) {
    case "pdf": {
      const { text, pageCount } = pdfToText(buffer);
      const exploitable = text.replace(/[^A-Za-zÀ-ÿ0-9]/g, "").length >= 30;
      return {
        kind: "pdf",
        texte: exploitable ? text : "",
        pages: pageCount,
        conversion: exploitable ? "full" : "metadata-only",
        note: exploitable
          ? undefined
          : `PDF de ${pageCount} page(s) sans texte natif extractible (probablement scanné) — métadonnées seules.`,
      };
    }
    case "docx":
      return { kind: "docx", texte: await docxToText(buffer), conversion: "full" };
    case "odt":
      return { kind: "odt", texte: await opendocumentToText(buffer), conversion: "full" };
    case "odp":
      return { kind: "odp", texte: await opendocumentToText(buffer), conversion: "full" };
    case "ods": {
      const texte = await odsToText(buffer);
      const { headers, rows } = parseCsv(texte);
      return {
        kind: "ods",
        texte,
        tableau: tableauDepuisLignes(headers, rows),
        conversion: "full",
      };
    }
    case "pptx":
      return { kind: "pptx", texte: await pptxToText(buffer), conversion: "full" };
    case "epub":
      return { kind: "epub", texte: await epubToText(buffer), conversion: "full" };
    case "rtf": {
      const texte = rtfToText(buffer.toString("latin1"));
      return { kind: "rtf", texte, conversion: texte.trim() ? "full" : "metadata-only" };
    }
    case "xlsx":
    case "xlsm": {
      const ExcelJS = (await import("exceljs")).default;
      const classeur = new ExcelJS.Workbook();
      await classeur.xlsx.load(buffer as unknown as Parameters<typeof classeur.xlsx.load>[0]);
      const toutesLignes: string[][] = [];
      let feuilles = 0;
      classeur.eachSheet((feuille) => {
        feuilles += 1;
        feuille.eachRow((ligne) => {
          const valeurs = (ligne.values as unknown[]).slice(1).map((v) =>
            v === null || v === undefined ? "" : String(v instanceof Date ? v.toISOString().slice(0, 10) : v),
          );
          if (valeurs.some((v) => v !== "")) toutesLignes.push(valeurs);
        });
      });
      const entete = toutesLignes.shift() ?? [];
      const lignes = toutesLignes.slice(0, 500);
      const texte = [entete.join(","), ...lignes.map((l) => l.map((c) => `"${c.replaceAll('"', '""')}"`).join(","))].join("\n");
      return { kind: "xlsx", texte, tableau: tableauDepuisLignes(entete, lignes), feuilles, conversion: "full" };
    }
    case "csv":
    case "tsv": {
      const texte = buffer.toString("utf8");
      const { headers, rows } = parseCsv(texte, extension === "tsv" ? "\t" : undefined);
      return {
        kind: extension,
        texte,
        structured: { headers, rows: rows.slice(0, 500) },
        tableau: tableauDepuisLignes(headers, rows.slice(0, 500)),
        conversion: "full",
      };
    }
    case "json": {
      const texte = buffer.toString("utf8");
      try {
        return { kind: "json", texte, structured: JSON.parse(texte), conversion: "full" };
      } catch {
        return { kind: "json", texte, conversion: "full", note: "JSON invalide : conservé en texte brut." };
      }
    }
    case "yaml":
    case "yml": {
      const texte = buffer.toString("utf8");
      try {
        return { kind: "yaml", texte, structured: jsYaml.load(texte), conversion: "full" };
      } catch (error) {
        return {
          kind: "yaml",
          texte,
          conversion: "full",
          note: `YAML invalide (${error instanceof Error ? error.message : String(error)}) : conservé en texte brut.`,
        };
      }
    }
    case "zip": {
      // Réutilise l'analyseur ZIP existant (sécurité des chemins incluse).
      const { analyzeZip } = await import("@/lib/documents/zip");
      const resultat = await analyzeZip(buffer);
      const texte = resultat.textFiles
        .map((f) => `===== ${f.path} =====\n${f.content}`)
        .join("\n\n");
      return {
        kind: "zip",
        texte,
        entrees: resultat.files.map((f) => ({ chemin: f.path, taille: f.sizeBytes, type: f.isDirectory ? ("dossier" as const) : ("fichier" as const) })),
        conversion: texte ? "full" : "metadata-only",
        note: `Archive ZIP : ${resultat.fileCount} entrée(s), ${resultat.textFiles.length} fichier(s) texte lu(s).`,
      };
    }
    case "tar": {
      const lecture = lireTar(buffer);
      const texte = lecture.fichiersTexte
        .map((f) => `===== ${f.chemin} =====\n${f.contenu}`)
        .join("\n\n");
      return {
        kind: "tar",
        texte,
        entrees: lecture.entrees,
        conversion: texte ? "full" : "metadata-only",
        note: `Archive TAR : ${lecture.entrees.length} entrée(s), ${lecture.fichiersTexte.length} fichier(s) texte lu(s).${lecture.avertissements.length ? " " + lecture.avertissements.join(" ") : ""}`,
      };
    }
    case "xml":
    case "svg": {
      const texte = buffer.toString("utf8");
      const lisible = markupToText(texte).replace(/\n{3,}/g, "\n\n").trim();
      return { kind: extension, texte: lisible || texte, conversion: "full" };
    }
    case "html":
    case "htm":
      return { kind: "html", texte: htmlToText(buffer.toString("utf8")), conversion: "full" };
    default:
      break;
  }

  // 3) Tentative texte générique (code source, notes, logs…).
  const texte = buffer.subarray(0, MAX_CARACTERES_TEXTE).toString("utf8");
  const binaire = buffer.subarray(0, 2_000).includes(0);
  if (binaire) {
    return {
      kind: extension || "binaire",
      texte: "",
      conversion: "metadata-only",
      note: EXTENSIONS_CODE.has(extension)
        ? undefined
        : "Fichier binaire non reconnu : métadonnées seules (taille, empreinte). Formats analysables : pdf, docx, odt/ods/odp, pptx, rtf, epub, xlsx, csv/tsv, json/yaml/xml, images, zip/tar.",
    };
  }
  return { kind: extension || "txt", texte, conversion: "full" };
}
