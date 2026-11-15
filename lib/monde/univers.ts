/**
 * L'Univers — l'orchestrateur du Monde.
 *
 * Une `SpecSimulation` décrit CE QU'IL FAUT simuler, indépendamment du
 * domaine. `simuler()` choisit le solveur, applique les caps stricts
 * (aucun calcul infini, jamais), exécute et renvoie le
 * `ResultatSimulation` universel. L'IA (Gen3) et l'interface parlent
 * tous deux cette même langue — l'intention traduit le français vers
 * la spécification.
 */

import * as eq from "./equations";
import * as em from "./electromagnetique";
import * as fluide from "./fluidique";
import * as meca from "./mecanique";
import * as onde from "./ondulaire";
import * as quantique from "./quantique";
import * as relativite from "./relativiste";
import * as thermique from "./thermique";
import { borner, CAPS_MONDE, type ResultatSimulation } from "./types";

/** Spécification d'une simulation — union discriminée par `type`. */
export type SpecSimulation =
  | { type: "projectile"; v0: number; angleDeg: number; altitude0?: number; trainee?: number; masse?: number }
  | { type: "nCorps"; duree: number; pas: number; scenario?: "terre-lune" | "double-etoile" }
  | { type: "pendule"; longueur: number; angleDeg: number; vitesseAngulaire?: number; amortissement?: number; masse?: number }
  | { type: "ressort"; raideur: number; masse: number; amortissement: number; x0: number }
  | { type: "chuteLibre"; masse: number; trainee: number; altitude0: number }
  | { type: "onde2D"; celerite?: number; taille?: number; resolution?: number; sourceX?: number; sourceY?: number; frequence: number; pas?: number; sourceSecondaire?: { x: number; y: number } }
  | { type: "fentesYoung"; largeurEcran: number; distanceEcran: number; espacement: number; longueurOnde: number }
  | { type: "ondeLumiere"; longueurOnde: number }
  | { type: "particuleBoite"; longueurBoite: number; masse?: number; niveaux?: number }
  | { type: "paquetOnde"; largeur?: number; positionInitiale?: number; impulsion: number; largeurPaquet?: number; duree: number; resolution?: number }
  | { type: "diffusionChaleur"; diffusivite: number; taille?: number; resolution?: number; sourceX?: number; sourceY?: number; temperatureSource: number; temperatureInitiale?: number; duree: number }
  | { type: "gazParfait"; moles: number; volume: number; temperature: number; processus: "isochore" | "isobare" | "isotherme" | "adiabatique"; facteurVariation: number }
  | { type: "champElectrique"; taille?: number; resolution?: number; charges: em.ChargePonctuelle[] }
  | { type: "circuitRLC"; resistance: number; inductance: number; capacite: number; tensionInitiale: number }
  | { type: "dilatationTemps"; vitesse: number; dureePropre: number }
  | { type: "energieRelativiste"; masse: number; vitesse: number }
  | { type: "redshift"; altitudeEmetteur: number; altitudeRecepteur: number }
  | { type: "ecoulementCylindre"; vitesseLointaine: number; rayon: number; densite: number; taille?: number; resolution?: number }
  | { type: "torricelli"; hauteurEau: number; hauteurOrifice: number; surfaceReservoir: number; surfaceOrifice: number }
  | ({ type: "ode"; ordre: 1 | 2 } & Omit<eq.DemandeOde, "ordre">)
  | { type: "racines"; expression: string; borneMin: number; borneMax: number }
  | { type: "integrale"; expression: string; borneMin: number; borneMax: number }
  | { type: "optimisation"; expression: string; borneMin: number; borneMax: number };

/** Double étoile prêt à l'emploi (deux masses égales en orbite mutuelle). */
function scenarioDoubleEtoile(): meca.ParamsNCorps {
  const masse = 1.98847e30; // masse solaire
  const separation = 1e11;
  // Orbite circulaire mutuelle : v = √(G·m/(4·d)) pour deux masses égales.
  const vitesse = Math.sqrt((6.6743e-11 * masse) / (4 * separation));
  return {
    corps: [
      { nom: "Étoile A", x: -separation / 2, y: 0, vx: 0, vy: -vitesse, masse },
      { nom: "Étoile B", x: separation / 2, y: 0, vx: 0, vy: vitesse, masse },
    ],
    duree: 3.15e7,
    pas: 3600,
  };
}

/**
 * Exécute une simulation du Monde. Les caps de `CAPS_MONDE` sont
 * appliqués QUOI QU'IL ARRIVE : une spécification hostile ne peut pas
 * déclencher un calcul infini côté client ni côté serveur.
 */
export function simuler(spec: SpecSimulation): ResultatSimulation {
  switch (spec.type) {
    case "projectile":
      return meca.projectile(
        {
          v0: spec.v0,
          angleDeg: spec.angleDeg,
          altitude0: spec.altitude0 ?? 0,
          trainee: spec.trainee ?? 0,
          masse: spec.masse ?? 1,
        },
        12 + 10 * Math.max(0, Math.sin((spec.angleDeg * Math.PI) / 180)),
      );
    case "nCorps": {
      const params =
        spec.scenario === "double-etoile"
          ? scenarioDoubleEtoile()
          : meca.systemeTerreLune(spec.duree, spec.pas);
      return meca.nCorps({
        corps: params.corps.slice(0, CAPS_MONDE.corpsMax),
        duree: borner(spec.duree, 60, 3.15e8),
        pas: borner(spec.pas, 1, 86400),
      });
    }
    case "pendule":
      return meca.pendule({
        longueur: spec.longueur,
        angleDeg: spec.angleDeg,
        vitesseAngulaire: spec.vitesseAngulaire ?? 0,
        amortissement: spec.amortissement ?? 0,
        masse: spec.masse ?? 1,
      });
    case "ressort":
      return meca.ressort(spec.raideur, spec.masse, spec.amortissement, spec.x0);
    case "chuteLibre":
      return meca.chuteLibre(spec.masse, spec.trainee, spec.altitude0);
    case "onde2D":
      return onde.onde2D({
        celerite: spec.celerite ?? 343,
        taille: spec.taille ?? 10,
        resolution: spec.resolution ?? 96,
        sourceX: spec.sourceX ?? 0.2,
        sourceY: spec.sourceY ?? 0.5,
        frequence: spec.frequence,
        pas: spec.pas ?? 1200,
        sourceSecondaire: spec.sourceSecondaire,
      });
    case "fentesYoung":
      return onde.fentesYoung(spec);
    case "ondeLumiere":
      return onde.ondeLumiere(spec.longueurOnde);
    case "particuleBoite":
      return quantique.particuleDansBoite(spec.longueurBoite, spec.masse ?? 9.1093837015e-31, spec.niveaux ?? 8);
    case "paquetOnde":
      return quantique.paquetOnde({
        largeur: spec.largeur ?? 1e-8,
        positionInitiale: spec.positionInitiale ?? 0.3,
        impulsion: spec.impulsion,
        largeurPaquet: spec.largeurPaquet ?? 1e-9,
        duree: spec.duree,
        resolution: spec.resolution ?? 96,
      });
    case "diffusionChaleur":
      return thermique.diffusionChaleur({
        diffusivite: spec.diffusivite,
        taille: spec.taille ?? 0.1,
        resolution: spec.resolution ?? 96,
        sourceX: spec.sourceX ?? 0.3,
        sourceY: spec.sourceY ?? 0.5,
        temperatureSource: spec.temperatureSource,
        temperatureInitiale: spec.temperatureInitiale ?? 20,
        duree: spec.duree,
      });
    case "gazParfait":
      return thermique.gazParfait(spec);
    case "champElectrique":
      return em.champElectrique({
        taille: spec.taille ?? 2e-9,
        resolution: spec.resolution ?? 96,
        charges: spec.charges,
      });
    case "circuitRLC":
      return em.circuitRLC(spec);
    case "dilatationTemps":
      return relativite.dilatationTemps(spec);
    case "energieRelativiste":
      return relativite.energieRelativiste(spec.masse, spec.vitesse);
    case "redshift":
      return relativite.redshiftGravitationnel(spec.altitudeEmetteur, spec.altitudeRecepteur);
    case "ecoulementCylindre":
      return fluide.ecoulementCylindre({
        vitesseLointaine: spec.vitesseLointaine,
        rayon: spec.rayon,
        densite: spec.densite,
        taille: spec.taille ?? 10 * spec.rayon,
        resolution: spec.resolution ?? 96,
      });
    case "torricelli":
      return fluide.torricelli(spec.hauteurEau, spec.hauteurOrifice, spec.surfaceReservoir, spec.surfaceOrifice);
    case "ode":
      return eq.resoudreOde({ ...spec, ordre: spec.ordre });
    case "racines":
      return eq.resoudreRacines(spec);
    case "integrale":
      return eq.resoudreIntegrale(spec);
    case "optimisation":
      return eq.resoudreOptimisation(spec);
    default: {
      // Exhaustivité : TypeScript garantit que ce cas est inaccessible.
      const impossible: never = spec;
      throw new Error(`Spécification de simulation inconnue : ${JSON.stringify(impossible)}`);
    }
  }
}

/** Ré-export des caps pour l'API et l'interface. */
export { CAPS_MONDE };
