/**
 * Génération OpenDocument RÉELLE (ODT / ODS / ODP) — demande « moteur
 * documentaire » : Gen3ia doit pouvoir CRÉER des documents dans les formats
 * libres autant que dans les formats Microsoft (pdf/docx/xlsx/pptx déjà
 * servis par generators/).
 *
 * Technique : un OpenDocument est un conteneur ZIP avec des contraintes
 * précises (spécification OASIS OpenDocument v1.2/1.3) :
 *  - la première entrée « mimetype » DOIT être stockée SANS compression et
 *    sans donnée extra ;
 *  - « content.xml » porte le contenu, « META-INF/manifest.xml » déclare
 *    les entrées, « styles.xml » les styles communs.
 *
 * Écrivain ZIP minimal embarqué (STORE uniquement, aucune dépendance) :
 * CRC-32 + en-têtes locaux + répertoire central + EOCD. Les entrées XML
 * restent non compressées (le format l'autorise, les lecteurs LibreOffice /
 * Word / Google Docs lisent les deux) — la taille des documents générés
 * reste modeste et le flux déterministe, testable octet par octet.
 */

import type { DocumentPlan } from "../types";

/* ------------------------------------------------------------------ */
/* Écrivain ZIP minimal (STORE)                                        */
/* ------------------------------------------------------------------ */

/** Table CRC-32 (polynôme 0xEDB88320) calculée une seule fois. */
const TABLE_CRC32 = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    crc = TABLE_CRC32[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface EntreeZip {
  nom: string;
  donnees: Buffer;
}

/**
 * Assemble un ZIP STORE (aucune compression) : mimetype en première entrée,
 * dates fixes (2026-01-01) pour un rendu déterministe — le même plan produit
 * le même fichier, propriété exploitée par les tests de régression.
 */
function assemblerZip(entrees: EntreeZip[]): Buffer {
  const locaux: Buffer[] = [];
  const centraux: Buffer[] = [];
  let offset = 0;

  for (const entree of entrees) {
    const nom = Buffer.from(entree.nom, "utf8");
    const crc = crc32(entree.donnees);
    const size = entree.donnees.length;

    const local = Buffer.alloc(30 + nom.length);
    local.writeUInt32LE(0x04034b50, 0); // signature
    local.writeUInt16LE(20, 4); // version nécessaire
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // méthode 0 = STORE
    local.writeUInt16LE(0, 10); // heure DOS (fixe)
    local.writeUInt16LE(0x5821, 12); // date DOS fixe (2026-01-01)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18); // compressé
    local.writeUInt32LE(size, 22); // brut
    local.writeUInt16LE(nom.length, 26);
    local.writeUInt16LE(0, 28); // nom extra
    nom.copy(local, 30);

    const central = Buffer.alloc(46 + nom.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version créée
    central.writeUInt16LE(20, 6); // version nécessaire
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x5821, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nom.length, 28);
    central.writeUInt32LE(0, 38); // offset local
    central.writeUInt32LE(offset, 42);
    nom.copy(central, 46);

    locaux.push(local, entree.donnees);
    centraux.push(central);
    offset += local.length + entree.donnees.length;
  }

  const repertoire = Buffer.concat(centraux);
  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0);
  fin.writeUInt16LE(entrees.length, 8);
  fin.writeUInt16LE(entrees.length, 10);
  fin.writeUInt32LE(repertoire.length, 12);
  fin.writeUInt32LE(offset, 16);

  return Buffer.concat([...locaux, repertoire, fin]);
}

/* ------------------------------------------------------------------ */
/* Échappement XML                                                     */
/* ------------------------------------------------------------------ */

export function xmlEchappe(texte: string): string {
  return texte
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
    // Caractères de contrôle interdits en XML 1.0 → espace (les retours
    // ligne/indentation légitimes sont conservés par le découpage en blocs).
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ");
}

/* ------------------------------------------------------------------ */
/* Corps de contenu par famille                                        */
/* ------------------------------------------------------------------ */

const NS_CONTENT =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ' +
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" ' +
  'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" ' +
  'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" ' +
  'xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" ' +
  'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" ' +
  'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"';

const NS_MANIFEST =
  'xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"';

function contenuTexte(plan: DocumentPlan): string {
  const parties: string[] = [];
  for (const bloc of plan.blocks) {
    const t = xmlEchappe(bloc.text ?? "");
    switch (bloc.type) {
      case "title":
        parties.push(`<text:h text:outline-level="1">${t}</text:h>`);
        break;
      case "heading":
        parties.push(
          `<text:h text:outline-level="${Math.min(6, Math.max(2, bloc.level ?? 2))}">${t}</text:h>`,
        );
        break;
      case "list":
        (bloc.items ?? []).forEach((item, index) => {
          const puce = bloc.ordered ? `${index + 1}. ` : "– ";
          parties.push(
            `<text:p text:style-name="Puce">${xmlEchappe(puce + item)}</text:p>`,
          );
        });
        break;
      case "table": {
        const colonnes = bloc.columns ?? [];
        parties.push('<table:table table:name="Tableau1">');
        for (const c of colonnes) {
          parties.push(`<table:table-column table:name="${xmlEchappe(c.slice(0, 20))}"/>`);
        }
        for (const ligne of [colonnes, ...(bloc.rows ?? [])]) {
          parties.push("<table:table-row>");
          for (const cellule of ligne) {
            parties.push(
              `<table:table-cell office:value-type="string"><text:p>${xmlEchappe(cellule)}</text:p></table:table-cell>`,
            );
          }
          parties.push("</table:table-row>");
        }
        parties.push("</table:table>");
        break;
      }
      case "code":
        parties.push(`<text:p text:style-name="Code">${t}</text:p>`);
        break;
      case "quote":
        parties.push(`<text:p text:style-name="Citation">${t}</text:p>`);
        break;
      case "image":
        parties.push(
          `<text:p>[Image : ${t || (bloc.url ? xmlEchappe(bloc.url) : "sans légende")}]</text:p>`,
        );
        break;
      case "pageBreak":
        parties.push('<text:p text:style-name="SautPage"/>');
        break;
      default:
        if (t) parties.push(`<text:p>${t}</text:p>`);
        break;
    }
  }
  return parties.join("\n");
}

function contenuClasseur(plan: DocumentPlan): string {
  const lignes: string[][] = [];
  const tableaux = plan.blocks.filter((b) => b.type === "table");
  if (tableaux.length > 0) {
    for (const tableau of tableaux) {
      lignes.push(tableau.columns ?? []);
      lignes.push(...(tableau.rows ?? []));
    }
  } else {
    for (const bloc of plan.blocks) {
      if (bloc.type === "list") {
        for (const item of bloc.items ?? []) lignes.push([item]);
      } else if (bloc.text) {
        for (const ligne of bloc.text.split(/\n+/)) lignes.push([ligne]);
      }
    }
  }
  const corps = lignes
    .map((ligne) => {
      const cellules = ligne.length
        ? ligne
            .map(
              (c) =>
                `<table:table-cell office:value-type="string"><text:p>${xmlEchappe(c)}</text:p></table:table-cell>`,
            )
            .join("")
        : '<table:table-cell/>';
      return `<table:table-row>${cellules}</table:table-row>`;
    })
    .join("\n");
  return `<table:table table:name="Feuille1">${corps}</table:table>`;
}

function contenuPresentation(plan: DocumentPlan): string {
  // Chaque titre ou intertitre de niveau 1-2 ouvre une diapositive ; les
  // blocs suivants alimentent son cadre de texte.
  const diapositives: { titre: string; lignes: string[] }[] = [];
  for (const bloc of plan.blocks) {
    const estTitre =
      bloc.type === "title" || (bloc.type === "heading" && (bloc.level ?? 2) <= 2);
    if (estTitre) {
      diapositives.push({ titre: bloc.text ?? "", lignes: [] });
    } else if (diapositives.length === 0) {
      diapositives.push({ titre: plan.title, lignes: [] });
    }
    const courante = diapositives[diapositives.length - 1];
    if (bloc.type === "list") {
      for (const item of bloc.items ?? []) courante.lignes.push(`• ${item}`);
    } else if (bloc.text && !estTitre) {
      for (const ligne of bloc.text.split(/\n+/)) courante.lignes.push(ligne);
    }
  }
  if (diapositives.length === 0) {
    diapositives.push({ titre: plan.title, lignes: [] });
  }
  return diapositives
    .map((d, i) => {
      const corps = d.lignes
        .map((l) => `<text:p>${xmlEchappe(l)}</text:p>`)
        .join("");
      return `<draw:page draw:name="Diapo${i + 1}"><draw:frame svg:x="2cm" svg:y="2cm" svg:width="22cm" svg:height="4cm"><draw:text-box><text:p text:style-name="Titre">${xmlEchappe(d.titre || `Diapositive ${i + 1}`)}</text:p></draw:text-box></draw:frame>${
        corps
          ? `<draw:frame svg:x="2cm" svg:y="7cm" svg:width="22cm" svg:height="10cm"><draw:text-box>${corps}</draw:text-box></draw:frame>`
          : ""
      }</draw:page>`;
    })
    .join("\n");
}

const MIME_PAR_FORMAT: Record<string, string> = {
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
};

function corpsContenu(plan: DocumentPlan): string {
  if (plan.format === "ods") return contenuClasseur(plan);
  if (plan.format === "odp") return contenuPresentation(plan);
  return contenuTexte(plan);
}

/**
 * Construit le buffer OpenDocument complet et valide pour le plan donné.
 * Le format (odt/ods/odp) pilote le type MIME et le corps de content.xml.
 */
export function generateOdf(plan: DocumentPlan): Buffer {
  const mimetype = MIME_PAR_FORMAT[plan.format];
  if (!mimetype) {
    throw new Error(`Format OpenDocument non pris en charge : ${plan.format}`);
  }

  const content = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content ${NS_CONTENT} office:version="1.2">
<office:automatic-styles>
<style:style style:name="Titre" style:family="presentation"><style:text-properties fo:font-size="28pt" fo:font-weight="bold"/></style:style>
<style:style style:name="Puce" style:family="paragraph"><style:text-properties/></style:style>
<style:style style:name="Code" style:family="paragraph"><style:text-properties style:font-name="Courier"/></style:style>
<style:style style:name="Citation" style:family="paragraph"><style:text-properties fo:font-style="italic"/></style:style>
<style:style style:name="SautPage" style:family="paragraph"><style:paragraph-properties fo:break-before="page"/></style:style>
</office:automatic-styles>
<office:body><office:${
    plan.format === "ods" ? "spreadsheet" : plan.format === "odp" ? "presentation" : "text"
  }>
${corpsContenu(plan)}
</office:${plan.format === "ods" ? "spreadsheet" : plan.format === "odp" ? "presentation" : "text"}></office:body>
</office:document-content>`;

  const styles = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-styles ${NS_CONTENT} office:version="1.2"><office:styles/></office:document-styles>`;

  const manifest = `<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest ${NS_MANIFEST}>
<manifest:file-entry manifest:full-path="/" manifest:media-type="${mimetype}"/>
<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
<manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>
</manifest:manifest>`;

  return assemblerZip([
    { nom: "mimetype", donnees: Buffer.from(mimetype, "utf8") },
    { nom: "META-INF/manifest.xml", donnees: Buffer.from(manifest, "utf8") },
    { nom: "styles.xml", donnees: Buffer.from(styles, "utf8") },
    { nom: "content.xml", donnees: Buffer.from(content, "utf8") },
  ]);
}
