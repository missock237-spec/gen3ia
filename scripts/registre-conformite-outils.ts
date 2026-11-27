/**
 * REGISTRE DE CONFORMITÉ DES OUTILS GEN3IA (v2 — 2026-11-27, audit outils).
 *
 * Génère l'inventaire de conformité recommandé par l'audit : pour CHAQUE
 * outil, l'état réel des trois couches (catalogue du planificateur,
 * définition de sécurité, exécuteur au registre) et un statut à quatre
 * états : fonctionnel / partiellement fonctionnel (conditionnel) / bloqué /
 * manquant.
 *
 * Exécution : npx tsx scripts/registre-conformite-outils.ts
 * Sorties   : docs/rapports/registre-conformite-outils.json (+ .md)
 *
 * La synchronisation elle-même est gardée en continu par
 * tests/unit/tool-registries-coherence.test.ts (CI) — ce script produit
 * l'INVENTAIRE lisible, pas le garde.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { GEN3IA_TOOLS } from "../lib/tools/registry";
import { getToolSecurityDefinition, KNOWN_TOOL_SECURITY_NAMES } from "../lib/security/tool-permissions";
import { PROJECT_SERVICE_TOOLS } from "../lib/agents/services/bridge";
import { createDefaultToolRegistry } from "../lib/tools";

const ENV_GENEREUSES: Record<string, string> = {
  COMPOSIO_API_KEY: "audit-composio-key",
  NOTION_API_TOKEN: "audit-notion-token",
  CLOUDFLARE_API_TOKEN: "audit-cloudflare-token",
  GITHUB_TOKEN: "audit-github-token",
  WHATSAPP_ACCESS_TOKEN: "audit-whatsapp-token",
  WHATSAPP_PHONE_NUMBER_ID: "audit-whatsapp-id",
  RESEND_API_KEY: "audit-resend-key",
  EMAIL_FROM_ADDRESS: "audit@gen3ia.test",
};

function idsRegistre(env: Record<string, string>): Set<string> {
  const sauvegarde: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    sauvegarde[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    return new Set(createDefaultToolRegistry().list().map((t) => t.id ?? t.name));
  } finally {
    for (const [k, v] of Object.entries(sauvegarde)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const catalogue = GEN3IA_TOOLS.map((t) => t.name);
const toujours = idsRegistre({});
const avecEnv = idsRegistre(ENV_GENEREUSES);
const dateIso = new Date().toISOString().slice(0, 10);

/**
 * Outils exécutés par une surface DÉDIÉE hors registre par défaut — chaque
 * référence est vérifiée dans le code (audit v2). Ils sont fonctionnels :
 * le registre par défaut n'est pas la seule voie d'exécution légitime.
 */
const SURFACES_ALTERNATIVES: Record<string, string> = {
  "code.execute": "lib/agents/runtime/secure-tool-executor.ts (exécution sandbox dédiée, validation runtime/limits lignes 46-50)",
  "terminal.execute": "lib/agents/runtime/secure-tool-executor.ts (flux « commande autorisée » à validation explicite, ligne 115)",
  "memory.read": "lib/domain/conversations/engine-tools.ts (dispatch propre du moteur de conversation)",
  "memory.write": "lib/domain/conversations/engine-tools.ts (dispatch propre du moteur de conversation)",
};

type Statut = "fonctionnel" | "partiellement fonctionnel" | "bloqué" | "manquant";

interface LigneConformite {
  outil: string;
  catalogue: boolean;
  securite: boolean;
  risque?: string;
  permissions?: string[];
  registre: "toujours" | "conditionnel" | "absent";
  serviceProjet: boolean;
  statut: Statut;
  note: string;
}

const lignes: LigneConformite[] = [];
const noms = new Set<string>([...catalogue, ...KNOWN_TOOL_SECURITY_NAMES, ...toujours, ...avecEnv]);
for (const nom of [...noms].sort()) {
  const auCatalogue = catalogue.includes(nom);
  let securite = true;
  let risque: string | undefined;
  let permissions: string[] | undefined;
  try {
    const def = getToolSecurityDefinition(nom);
    risque = def.risk;
    permissions = def.requiredPermissions;
  } catch {
    securite = false;
  }
  const auRegistreToujours = toujours.has(nom);
  const auRegistreEnv = avecEnv.has(nom);
  const registre = auRegistreToujours ? "toujours" : auRegistreEnv ? "conditionnel" : "absent";
  const serviceProjet = PROJECT_SERVICE_TOOLS.includes(nom);

  let statut: Statut;
  let note = "";
  if (auCatalogue && securite && SURFACES_ALTERNATIVES[nom]) {
    statut = "fonctionnel";
    note = `exécution par surface dédiée (hors registre par défaut) : ${SURFACES_ALTERNATIVES[nom]}`;
  } else if (auCatalogue && securite && auRegistreToujours) {
    statut = "fonctionnel";
  } else if (auCatalogue && securite && auRegistreEnv) {
    statut = "partiellement fonctionnel";
    note = "exécuteur réel enregistré sous condition (clé API / connecteur configuré) — échec propre et honnête sinon";
  } else if (auCatalogue && securite && registre === "absent") {
    statut = "bloqué";
    note = "annoncé + sécurisé mais AUCUN exécuteur au registre ni surface dédiée connue — fantôme résiduel";
  } else if (auRegistreToujours || auRegistreEnv) {
    statut = "bloqué";
    note = "exécutable mais hors catalogue et/ou sans définition de sécurité — invisible du planificateur ou rejeté par authorizeTool";
  } else {
    statut = "manquant";
    note = "référencé sans exécuteur ni annonce — résidu de registre";
  }

  lignes.push({ outil: nom, catalogue: auCatalogue, securite, risque, permissions, registre, serviceProjet, statut, note });
}

const compte = (s: Statut) => lignes.filter((l) => l.statut === s).length;
const resume = {
  date: dateIso,
  garde: "tests/unit/tool-registries-coherence.test.ts (CI — synchronisation continue)",
  methodes: {
    registreToujours: "createDefaultToolRegistry() sans variables d'environnement",
    registreConditionnel: "createDefaultToolRegistry() avec clés API/connecteurs simulées",
  },
  totaux: {
    catalogue: catalogue.length,
    securite: KNOWN_TOOL_SECURITY_NAMES.size,
    registreToujours: toujours.size,
    registreAvecEnv: avecEnv.size,
    serviceProjet: PROJECT_SERVICE_TOOLS.length,
    fonctionnel: compte("fonctionnel"),
    partiellementFonctionnel: compte("partiellement fonctionnel"),
    bloque: compte("bloqué"),
    manquant: compte("manquant"),
  },
  outils: lignes,
};

const dossier = join(process.cwd(), "docs", "rapports");
mkdirSync(dossier, { recursive: true });
writeFileSync(join(dossier, "registre-conformite-outils.json"), JSON.stringify(resume, null, 2) + "\n", "utf8");

const lignesMd = lignes
  .map((l) => `| \`${l.outil}\` | ${l.catalogue ? "✅" : "—"} | ${l.securite ? `✅ (${l.risque})` : "❌"} | ${l.registre} | ${l.statut}${l.note ? ` — ${l.note}` : ""} |`)
  .join("\n");
const md = `# Registre de conformité des outils Gen3ia — ${dateIso}

Inventaire généré par \`scripts/registre-conformite-outils.ts\` (audit outils v2). La synchronisation continue est gardée par \`tests/unit/tool-registries-coherence.test.ts\` en CI.

**Totaux :** catalogue ${resume.totaux.catalogue} · sécurité ${resume.totaux.securite} · registre toujours ${resume.totaux.registreToujours} · conditionnel ${resume.totaux.registreAvecEnv - resume.totaux.registreToujours} — statuts : **${resume.totaux.fonctionnel} fonctionnels**, **${resume.totaux.partiellementFonctionnel} partiellement fonctionnels** (exécuteur réel sous condition de configuration), **${resume.totaux.bloque} bloqués**, **${resume.totaux.manquant} manquants**.

| Outil | Catalogue | Sécurité (risque) | Exécuteur | Statut |
|---|---|---|---|---|
${lignesMd}
`;
writeFileSync(join(dossier, "registre-conformite-outils.md"), md, "utf8");

console.log(`Registre généré : ${resume.totaux.fonctionnel} fonctionnels, ${resume.totaux.partiellementFonctionnel} partiels, ${resume.totaux.bloque} bloqués, ${resume.totaux.manquant} manquants (${lignes.length} outils inventoriés).`);
if (resume.totaux.bloque > 0 || resume.totaux.manquant > 0) {
  for (const l of lignes.filter((x) => x.statut === "bloqué" || x.statut === "manquant")) console.log(`  ⚠️ ${l.outil} : ${l.note}`);
  process.exitCode = 1;
}
