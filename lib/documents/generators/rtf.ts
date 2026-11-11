/**
 * Génération RTF RÉELLE — demande « moteur documentaire » : le RTF figure
 * dans la liste des formats de création cibles (PDF, DOCX, ODT, RTF).
 *
 * Rich Text Format v1.x : texte pur balisé, lisible par Word, WordPad,
 * LibreOffice et TextEdit. Échappements obligatoires : \{ \} \\ ; tout
 * caractère hors CP1252 part en \uN? (Unicode signé 16 bits + substitut).
 * Titre/intertitres en gras (\b), listes à puces, sauts de page (\page).
 */

import type { DocumentPlan } from "../types";

/** \uN? : N est le point de code signé 16 bits (« ? » est le substitut). */
function code16(code: number): string {
  // \u attend un entier signé 16 bits (−32768…32767).
  const signé = code > 32767 ? code - 65536 : code;
  return `\\u${signé}`;
}

function rtfEchappe(texte: string): string {
  let out = "";
  for (const ch of texte) {
    const code = ch.codePointAt(0) ?? 32;
    if (ch === "\\" || ch === "{" || ch === "}") {
      out += `\\${ch}`;
    } else if (ch === "\t") {
      out += "\\tab ";
    } else if (code >= 32 && code < 128) {
      out += ch;
    } else if (code > 0xffff) {
      // Hors BMP : paire UTF-16 → deux \uN consécutifs.
      const haut = Math.floor((code - 0x10000) / 0x400) + 0xd800;
      const bas = ((code - 0x10000) % 0x400) + 0xdc00;
      out += `${code16(haut)}?${code16(bas)}?`;
    } else {
      out += `${code16(code)}?`;
    }
  }
  return out;
}

function paragraphe(texte: string, options: { gras?: boolean } = {}): string {
  const corps = rtfEchappe(texte);
  return options.gras ? `{\\b ${corps}}\\par` : `${corps}\\par`;
}

export function generateRtf(plan: DocumentPlan): Buffer {
  const parties: string[] = [];
  // Préambule : RTF1, ANSI, police par défaut, table de polices.
  parties.push(
    "{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0\\fswiss Helvetica;}}\\fs22",
  );
  parties.push(paragraphe(plan.title, { gras: true }));
  for (const bloc of plan.blocks) {
    switch (bloc.type) {
      case "title":
        parties.push(paragraphe(bloc.text ?? "", { gras: true }));
        break;
      case "heading":
        parties.push(paragraphe(bloc.text ?? "", { gras: true }));
        break;
      case "list":
        // ordered → numérotation réelle (1., 2., …) ; sinon puce « • »
        // (échappée en \u8226? par rtfEchappe, hors CP1252).
        (bloc.items ?? []).forEach((item, index) => {
          const puce = bloc.ordered ? `${index + 1}. ` : "• ";
          parties.push(paragraphe(`${puce}${item}`));
        });
        break;
      case "table": {
        const colonnes = bloc.columns ?? [];
        for (const ligne of [colonnes, ...(bloc.rows ?? [])]) {
          parties.push(paragraphe(ligne.map((c) => c).join("\t")));
        }
        break;
      }
      case "code":
        parties.push(paragraphe(bloc.text ?? ""));
        break;
      case "quote":
        parties.push(paragraphe(`« ${bloc.text ?? ""} »`));
        break;
      case "image":
        parties.push(paragraphe(`[Image : ${bloc.text || bloc.url || "sans légende"}]`));
        break;
      case "pageBreak":
        parties.push("\\page");
        break;
      default:
        if (bloc.text) {
          for (const ligne of bloc.text.split(/\n+/)) parties.push(paragraphe(ligne));
        }
        break;
    }
  }
  parties.push("}");
  return Buffer.from(parties.join("\n"), "latin1");
}
