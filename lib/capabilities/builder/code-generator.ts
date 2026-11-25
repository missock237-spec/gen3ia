/**
 * CODE GENERATOR (UCE) — génération de code DÉTERMINISTE par archétypes.
 *
 * Pas de génération magique ni d'IA externe : l'UCE choisit un archétype
 * éprouvé (calcul déterministe, validation de texte, transformation JSON,
 * vérification de contenu), remplit ses champs depuis la spécification et
 * produit un module + son TEST sandbox. Tout le code généré s'exécute
 * D'ABORD en sandbox (réseau NONE) — jamais en production directe.
 *
 * Convention d'exécution sandbox du dépôt (ExecuteurSandbox) : le script
 * reçoit `donnees` (déjà `require()`-préfixé par la sandbox) et rend son
 * résultat via `emettre(...)`. Les corps d'archétypes lisent UNIQUEMENT
 * `donnees[...]` — aucune variable libre, donc aucun ReferenceError possible.
 */

import "server-only";

export type ArcheTypeCode =
  | "calcul-deterministe"
  | "validation-texte"
  | "transformation-json"
  | "verification-contenu";

export interface SpecCapaciteGeneree {
  nom: string;
  description: string;
  archeType: ArcheTypeCode;
  /** Paramètres typés de l'archétype (validation zod émise). */
  champs: Array<{ nom: string; type: "string" | "number" | "boolean"; requis: boolean; description?: string }>;
}

export interface CodeGenere {
  codeModule: string;
  codeTest: string;
  archeType: ArcheTypeCode;
  avertissements: string[];
  /** Jeux d'essai déterministes passés à la sandbox via `donnees`. */
  casSucces: Record<string, unknown>;
  casRefus: Record<string, unknown>;
}

const ARCHE_TYPES: ArcheTypeCode[] = ["calcul-deterministe", "validation-texte", "transformation-json", "verification-contenu"];

export function archetypesDisponibles(): ArcheTypeCode[] {
  return [...ARCHE_TYPES];
}

/** Génère module + test + jeux d'essai (déterministe, sans aléa). */
export function genererCode(spec: SpecCapaciteGeneree): CodeGenere {
  const avertissements = [
    "Code généré par l'UCE : doit passer la sandbox AVANT toute proposition d'intégration.",
    "Aucun accès réseau : cet archétype opère exclusivement sur ses entrées.",
  ];
  const champs = spec.champs.length > 0 ? spec.champs : champsDefaut(spec.archeType);
  const casSucces = casParArcheType(spec.archeType);
  const casRefus = casRefusParArcheType(spec.archeType);
  return {
    codeModule: moduleDepuisArcheType(spec, champs),
    codeTest: testDepuisArcheType(spec.archeType, champs),
    archeType: spec.archeType,
    avertissements,
    casSucces,
    casRefus,
  };
}

function champsDefaut(archeType: ArcheTypeCode): SpecCapaciteGeneree["champs"] {
  switch (archeType) {
    case "calcul-deterministe":
      return [{ nom: "expression", type: "string", requis: true, description: "expression arithmétique simple" }];
    case "validation-texte":
      return [{ nom: "texte", type: "string", requis: true }, { nom: "longueurMin", type: "number", requis: false }];
    case "transformation-json":
      return [{ nom: "objet", type: "string", requis: true, description: "JSON à normaliser" }];
    case "verification-contenu":
      return [{ nom: "contenu", type: "string", requis: true }];
  }
}

/** Lecture bornée d'un champ : donnees["nom"], jamais une variable libre. */
function lireChamp(nom: string): string {
  return `donnees[${JSON.stringify(nom)}]`;
}

function corpsArchetype(archeType: ArcheTypeCode, champs: SpecCapaciteGeneree["champs"]): string {
  switch (archeType) {
    case "calcul-deterministe":
      return `      // Calcul déterministe : arithmétique séquentielle, aucun eval, aucun réseau.
      const expression = String(${lireChamp(champs[0].nom)});
      if (!/^[0-9+\\-*/().\\s%]+$/.test(expression)) {
        return emettre({ ok: false, erreur: "expression non arithmétique (refusée)" });
      }
      const tokens = expression.match(/\\d+\\.?\\d*|[+\\-*/()%]/g) ?? [];
      let courant = 0; let op = "+";
      for (const t of tokens) {
        if (/^[+\\-*/%]$/.test(t)) { op = t; continue; }
        const v = parseFloat(t);
        if (op === "+") courant += v; else if (op === "-") courant -= v;
        else if (op === "*") courant *= v; else if (op === "/") courant /= v; else courant %= v;
        if (!Number.isFinite(courant)) return emettre({ ok: false, erreur: "résultat non fini" });
      }
      emettre({ ok: true, resultat: courant, memoireMo: Math.round(process.memoryUsage().rss / (1024 * 1024)) });`;
    case "validation-texte": {
      const champLongueur = champs.find((c) => c.nom === "longueurMin")?.nom ?? "longueurMin";
      return `      // Validation de texte : règles explicites, sans heuristique cachée.
      const texte = String(${lireChamp("texte")});
      const longueurMin = Number(${lireChamp(champLongueur)} ?? 1);
      const erreur = texte.trim().length === 0 ? "texte vide"
        : texte.trim().length < longueurMin ? "texte trop court (min " + longueurMin + ")"
        : null;
      emettre({ ok: erreur === null, valide: erreur === null, erreur, memoireMo: Math.round(process.memoryUsage().rss / (1024 * 1024)) });`;
    }
    case "transformation-json":
      return `      // Transformation JSON : parse + normalisation des clés.
      const brut = String(${lireChamp(champs[0].nom)});
      try {
        const objet = JSON.parse(brut);
        const normalise = {};
        for (const k of Object.keys(objet)) {
          normalise[k.trim().toLowerCase().replace(/\\s+/g, "_")] = objet[k];
        }
        emettre({ ok: true, resultat: normalise, memoireMo: Math.round(process.memoryUsage().rss / (1024 * 1024)) });
      } catch (e) {
        emettre({ ok: false, erreur: "JSON invalide : " + (e && e.message ? e.message : String(e)) });
      }`;
    case "verification-contenu":
      return `      // Vérification de contenu : cohérence basique et empreinte simple.
      const contenu = String(${lireChamp(champs[0].nom)});
      let somme = 0;
      for (let i = 0; i < contenu.length; i++) somme = (somme + contenu.charCodeAt(i)) % 0xFFFF;
      const nonVide = contenu.trim().length > 0;
      emettre({ ok: nonVide, nonVide, empreinte: somme.toString(16), taille: contenu.length, memoireMo: Math.round(process.memoryUsage().rss / (1024 * 1024)) });`;
  }
}

function typesZod(champs: SpecCapaciteGeneree["champs"]): string {
  return champs
    .map((c) => {
      const base = c.type === "string" ? "z.string()" : c.type === "number" ? "z.number()" : "z.boolean()";
      return `${c.nom}: ${c.requis ? base : base + ".optional()"}`;
    })
    .join(", ");
}

function moduleDepuisArcheType(spec: SpecCapaciteGeneree, champs: SpecCapaciteGeneree["champs"]): string {
  return `/**
 * CAPACITÉ GÉNÉRÉE PAR L'UCE — « ${spec.nom} » (archétype ${spec.archeType}).
 * ${spec.description}
 *
 * Statut : PROPOSITION — ce module n'est PAS intégré tant que le cycle
 * d'intégration UCE n'est pas complété avec autorisation humaine explicite.
 */
import { z } from "zod";

export const capaciteGenereeNom = ${JSON.stringify(spec.nom)};

export const capaciteGenereeSchema = z.object({ ${typesZod(champs)} });

/** Implémentation sandbox-compatible : appelle emettre(...) avec le résultat. */
export function executerCapaciteGeneree(donnees: Record<string, unknown>, emettre: (v: unknown) => void): void {
${corpsArchetype(spec.archeType, champs)}
}
`;
}

function testDepuisArcheType(archeType: ArcheTypeCode, champs: SpecCapaciteGeneree["champs"]): string {
  return `/**
 * TEST SANDBOX AUTO-GÉNÉRÉ (archétype ${archeType}).
 * La sandbox injecte \`donnees\` = { casSucces, casRefus }.
 * Exécute les deux jeux d'essai et émet un verdict booleéen.
 */
function verifierCas(entree, attenduOk) {
  const donnees = entree; // les corps d'archétypes lisent uniquement donnees[...]
  let emise = null;
  const emettre = (v) => { emise = v; };
${corpsArchetype(archeType, champs)}
  if (!emise) throw new Error("capacité n'a rien émis");
  if (Boolean(emise.ok) !== attenduOk) {
    throw new Error("résultat " + emise.ok + " ≠ attendu " + attenduOk + " : " + JSON.stringify(emise).slice(0, 120));
  }
  return emise;
}

const succes = verifierCas(donnees.casSucces, true);
const echec = verifierCas(donnees.casRefus, false);
emettre({ ok: true, succes, echec, memoireMo: Math.round(process.memoryUsage().rss / (1024 * 1024)) });
`;
}

function casParArcheType(archeType: ArcheTypeCode): Record<string, unknown> {
  switch (archeType) {
    case "calcul-deterministe":
      return { expression: "2 + 3 * 4" };
    case "validation-texte":
      return { texte: "texte valide", longueurMin: 3 };
    case "transformation-json":
      return { objet: '{"Nom Complet":"Gen3ia"}' };
    case "verification-contenu":
      return { contenu: "contenu non vide à vérifier" };
  }
}

function casRefusParArcheType(archeType: ArcheTypeCode): Record<string, unknown> {
  switch (archeType) {
    case "calcul-deterministe":
      return { expression: "alert('injection')" };
    case "validation-texte":
      return { texte: "  " };
    case "transformation-json":
      return { objet: "{pas du json}" };
    case "verification-contenu":
      return { contenu: "" };
  }
}
