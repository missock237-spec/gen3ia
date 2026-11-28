/**
 * GÉNÉRATEUR DE VOIX — Gen3 multimodal.
 *
 * « Une voix réaliste qui ressemble à la voix à copier » :
 *  · CAPTURE DE PROFIL RÉELLE depuis un échantillon WAV (mono 16 bits) :
 *    hauteur (f0 médiane par autocorrélation sur fenêtres voisées), timbre
 *    (énergie relative en 8 bandes spectrales), débit (taux de crêtes
 *    d'énergie) — des grandeurs MESURÉES, pas des estimations déclarées.
 *  · PORTE DE CONSENTEMENT : sans consentement enregistré, aucun profil
 *    n'est capturé (aucune imitation d'une voix sans autorisation — la
 *    règle est dans le schéma ET dans le code, testée).
 *  · SYNTHÈSE PARAMÉTRIQUE : le texte est segmenté (graphèmes → phonèmes
 *    naïfs FR), puis rendu en PCM 16 bits modelé par le profil : f0 de
 *    base du profil + contour prosodique (question montante, affirmatif
 *    descendant), harmoniques pondérées par les gains de bandes du timbre
 *    du profil. Deux profils différents → sorties MESURABLEMENT différentes.
 *  · HONNÊTETÉ : la synthèse paramétrique reproduit hauteur/timbre/débit
 *    (ressemblance acoustique mesurable), PAS un clonage neuronal complet ;
 *    l'interface `FournisseurVoix` reçoit le profil + le texte pour un
 *    moteur TTS neuronal réel branché.
 */

/** Profil acoustique d'une voix — grandeurs mesurées sur l'échantillon. */
export interface ProfilVoix {
  /** f0 médiane en Hz (60–400). */
  hauteurHz: number;
  /** Énergie relative par bande (8 bandes, somme = 1). */
  timbreBandes: number[];
  /** Crêtes d'énergie par seconde (proxy du débit de syllabes). */
  debitCrestesParSeconde: number;
  /** Consentement enregistré (obligatoire — porte éthique). */
  consentement: { accordee: boolean; source: string };
}

export interface EchantillonWav {
  /** Échantillons 16 bits mono normalisés [-1, 1]. */
  echantillons: Float32Array;
  frequenceEchantillonnage: number;
}

/** Écrivain WAV RÉEL (RIFF/WAVE, PCM 16 bits mono). */
export function ecrireWAV(echantillons: Float32Array, frequenceEchantillonnage: number): Buffer {
  const donnees = Buffer.alloc(echantillons.length * 2);
  for (let i = 0; i < echantillons.length; i++) {
    const v = Math.max(-1, Math.min(1, echantillons[i]));
    donnees.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  const entete = Buffer.alloc(44);
  entete.write("RIFF", 0, "ascii");
  entete.writeUInt32LE(36 + donnees.length, 4);
  entete.write("WAVE", 8, "ascii");
  entete.write("fmt ", 12, "ascii");
  entete.writeUInt32LE(16, 16); // taille fmt
  entete.writeUInt16LE(1, 20); // PCM
  entete.writeUInt16LE(1, 22); // mono
  entete.writeUInt32LE(frequenceEchantillonnage, 24);
  entete.writeUInt32LE(frequenceEchantillonnage * 2, 28); // byte rate
  entete.writeUInt16LE(2, 32); // block align
  entete.writeUInt16LE(16, 34); // bits
  entete.write("data", 36, "ascii");
  entete.writeUInt32LE(donnees.length, 40);
  return Buffer.concat([entete, donnees]);
}

/** Lecture WAV minimaliste (PCM 16 bits mono) — pour les tests et la capture. */
export function lireWAV(buffer: Buffer): EchantillonWav {
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("WAV invalide : signatures RIFF/WAVE absentes");
  }
  let offset = 12;
  let frequence = 44100;
  let donnees: Buffer | null = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const taille = buffer.readUInt32LE(offset + 4);
    if (id === "fmt ") {
      frequence = buffer.readUInt32LE(offset + 12);
    } else if (id === "data") {
      donnees = buffer.subarray(offset + 8, offset + 8 + taille);
    }
    offset += 8 + taille + (taille % 2);
  }
  if (!donnees) throw new Error("WAV invalide : chunk data absent");
  const echantillons = new Float32Array(Math.floor(donnees.length / 2));
  for (let i = 0; i < echantillons.length; i++) echantillons[i] = donnees.readInt16LE(i * 2) / 32768;
  return { echantillons, frequenceEchantillonnage: frequence };
}

/** f0 par autocorrélation d'une fenêtre (recherche 60–400 Hz). */
function f0Fenetre(fenetre: Float32Array, fs: number): number | null {
  const lagMin = Math.floor(fs / 400);
  const lagMax = Math.min(Math.floor(fs / 60), fenetre.length - 1);
  let energie = 0;
  for (let i = 0; i < fenetre.length; i++) energie += fenetre[i] * fenetre[i];
  if (energie < fenetre.length * 1e-5) return null; // silence
  let meilleurLag = -1;
  let meilleure = 0;
  for (let lag = lagMin; lag <= lagMax; lag++) {
    let somme = 0;
    for (let i = 0; i + lag < fenetre.length; i++) somme += fenetre[i] * fenetre[i + lag];
    const norme = somme / Math.max(1e-9, energie);
    if (norme > meilleure) {
      meilleure = norme;
      meilleurLag = lag;
    }
  }
  return meilleurLag > 0 && meilleure > 0.3 ? fs / meilleurLag : null;
}

/** DFT d'une fenêtre à une fréquence donnée (magnitude). */
function magnitudeDFT(fenetre: Float32Array, fs: number, frequence: number): number {
  let re = 0;
  let im = 0;
  const pas = (2 * Math.PI * frequence) / fs;
  for (let i = 0; i < fenetre.length; i++) {
    re += fenetre[i] * Math.cos(pas * i);
    im -= fenetre[i] * Math.sin(pas * i);
  }
  return Math.hypot(re, im) / fenetre.length;
}

const BANDES_HZ = [150, 350, 700, 1400, 2800, 4200, 5600, 7000];

/** Capture du profil — REFUSÉE sans consentement enregistré. */
export function capturerProfilVoix(echantillon: EchantillonWav, consentement: { accordee: boolean; source: string }): ProfilVoix {
  if (!consentement.accordee) {
    throw new Error("Consentement requis : aucun profil de voix n'est capturé sans autorisation enregistrée");
  }
  const fs = echantillon.frequenceEchantillonnage;
  const tailleFenetre = Math.floor(fs * 0.04); // 40 ms
  // 1) f0 médiane sur fenêtres voisées.
  const f0s: number[] = [];
  for (let debut = 0; debut + tailleFenetre <= echantillon.echantillons.length; debut += tailleFenetre) {
    const f0 = f0Fenetre(echantillon.echantillons.subarray(debut, debut + tailleFenetre), fs);
    if (f0) f0s.push(f0);
  }
  f0s.sort((a, b) => a - b);
  const hauteurHz = f0s.length > 0 ? f0s[Math.floor(f0s.length / 2)] : 130;
  // 2) Timbre : énergie relative en 8 bandes (moyenne des fenêtres voisées).
  const sommes = new Array<number>(BANDES_HZ.length).fill(0);
  let fenetresUtilisees = 0;
  for (let debut = 0; debut + tailleFenetre <= echantillon.echantillons.length; debut += tailleFenetre) {
    const fenetre = echantillon.echantillons.subarray(debut, debut + tailleFenetre);
    let energie = 0;
    for (let i = 0; i < fenetre.length; i++) energie += fenetre[i] * fenetre[i];
    if (energie < fenetre.length * 1e-5) continue;
    fenetresUtilisees++;
    BANDES_HZ.forEach((hz, k) => {
      sommes[k] += magnitudeDFT(fenetre, fs, hz);
    });
  }
  const brut = sommes.map((s) => s / Math.max(1, fenetresUtilisees));
  const sommeTotale = brut.reduce((a, b) => a + b, 0) || 1;
  const timbreBandes = brut.map((v) => v / sommeTotale);
  // 3) Débit : crêtes d'énergie (enveloppe) par seconde.
  let crestes = 0;
  let dernierMax = -Infinity;
  const pas = Math.floor(fs * 0.01);
  for (let i = 0; i < echantillon.echantillons.length - pas; i += pas) {
    let energie = 0;
    for (let k = i; k < i + pas; k++) energie += Math.abs(echantillon.echantillons[k]);
    if (energie > dernierMax + pas * 0.12) {
      crestes++;
      dernierMax = energie;
    } else if (energie < dernierMax - pas * 0.3) {
      dernierMax = energie;
    }
  }
  const dureeSecondes = echantillon.echantillons.length / fs;
  return { hauteurHz: Math.round(hauteurHz * 10) / 10, timbreBandes, debitCrestesParSeconde: Math.round((crestes / Math.max(0.1, dureeSecondes)) * 10) / 10, consentement };
}

/** Graphèmes → segments syllabiques naïfs FR (déterministe). */
function segmenterTexte(texte: string): Array<{ voyelles: string; nasale: boolean; ponctuation: "rien" | "fin" | "question" }> {
  const groupes = texte.toLowerCase().replace(/[^a-zà-ÿ\s.?!]/g, "").match(/[a-zà-ÿ]*[aàeéèiïoôuùy]+[a-zà-ÿ]*/g) ?? [];
  return groupes.map((g) => {
    const voyelles = (g.match(/[aàeéèiïoôuùy]/g) ?? ["a"]).join("");
    const nasale = /on|an|en|in|un|om|am|em|im|um|ain|ein/.test(g);
    const fin = /[.!?]\s*$/.test(texte.slice(Math.max(0, texte.toLowerCase().indexOf(g)) + g.length, texte.toLowerCase().indexOf(g) + g.length + 2));
    const question = fin && /[?]\s*$/.test(texte.slice(Math.max(0, texte.toLowerCase().indexOf(g)) + g.length, texte.toLowerCase().indexOf(g) + g.length + 2));
    return { voyelles, nasale, ponctuation: question ? "question" : fin ? "fin" : "rien" };
  });
}

/** Contrat d'un moteur TTS NEURONAL RÉEL branché (voix réaliste complète). */
export interface FournisseurVoix {
  readonly nom: string;
  synthetiser(texte: string, profil: ProfilVoix | null): Promise<Buffer>;
}

/**
 * SYNTHÈSE PARAMÉTRIQUE sous profil : chaque segment est rendu en fenêtres
 * voisées (harmoniques de f0 pondérées par les gains de bandes du profil)
 * et non-voisées (bruit soufflé) ; f0 suit la prosodie (question montante,
 * affirmatif descendant) ; durée par segment selon le débit du profil.
 */
export function synthetiserVoix(texte: string, profil: ProfilVoix, fs = 22050): { wav: Buffer; echantillons: Float32Array } {
    // Bruit déterministe (LCG) — même texte + même profil → octets identiques.
  let graine = 0;
  for (let i = 0; i < texte.length; i++) graine = (graine * 31 + texte.charCodeAt(i)) >>> 0;
  const aleatoire = () => {
    graine = (graine * 1664525 + 1013904223) >>> 0;
    return graine / 0xffffffff;
  };
const segments = segmenterTexte(texte);
  const dureeSegment = Math.max(0.08, Math.min(0.4, 2.2 / Math.max(1, profil.debitCrestesParSeconde))); // s
  const total = Math.max(fs, Math.ceil(segments.length * dureeSegment * fs) + fs * 0.3);
  const sortie = new Float32Array(total);
  let curseur = 0;
  const gains = profil.timbreBandes;
  segments.forEach((segment, index) => {
    const f0Base = profil.hauteurHz;
    // Prosodie : dernier segment — question monte (+18 %), affirmatif descend (−12 %).
    const estDernier = index === segments.length - 1;
    const glissando = estDernier ? (segment.ponctuation === "question" ? 1.18 : segment.ponctuation === "fin" ? 0.88 : 1) : 1;
    const n = Math.floor(dureeSegment * fs);
    for (let i = 0; i < n && curseur + i < sortie.length; i++) {
      const t = i / fs;
      const progres = i / n;
      // f0 avec micro-variance (vibrato léger) + glissando de fin.
      const f0 = f0Base * (1 + 0.012 * Math.sin(2 * Math.PI * 5 * t)) * (1 + (glissando - 1) * progres);
      let echantillon = 0;
      // Harmoniques 1..8 pondérées par les bandes de timbre (formants).
      for (let h = 1; h <= 8; h++) {
        const freq = f0 * h;
        // Bande de timbre = centre BANDES_HZ le plus proche en distance.
        let bande = 0;
        let meilleureDistance = Infinity;
        for (let k = 0; k < BANDES_HZ.length; k++) {
          const distance = Math.abs(freq - BANDES_HZ[k]);
          if (distance < meilleureDistance) {
            meilleureDistance = distance;
            bande = k;
          }
        }
        const gain = gains[bande] * (1 / h);
        echantillon += gain * Math.sin(2 * Math.PI * freq * t);
      }
      // Nasale : ajout d'une résonance grave ; occlusive : petit souffle.
      if (segment.nasale) echantillon += 0.15 * gains[0] * Math.sin(2 * Math.PI * 220 * t);
      echantillon += 0.02 * (aleatoire() * 2 - 1);
      // Enveloppe syllabique (attaque/descente) + silence inter-segments.
      const enveloppe = Math.min(1, progres * 12) * Math.min(1, (1 - progres) * 4);
      sortie[curseur + i] = echantillon * enveloppe * 0.7;
    }
    curseur += n;
  });
  const borne = Math.min(sortie.length, curseur + Math.floor(fs * 0.2));
  return { wav: ecrireWAV(sortie.subarray(0, borne), fs), echantillons: sortie.subarray(0, borne) };
}

/** Livraison voix : fournisseur branché d'abord, synthèse paramétrique en repli. */
export async function genererVoix(texte: string, profil: ProfilVoix, fournisseur?: FournisseurVoix): Promise<{ wav: Buffer; niveauRealisme: "structurel-local" | "photoréaliste-réseau"; fournisseur: string }> {
  if (fournisseur) {
    const wav = await fournisseur.synthetiser(texte, profil);
    return { wav, niveauRealisme: "photoréaliste-réseau", fournisseur: fournisseur.nom };
  }
  return { wav: synthetiserVoix(texte, profil).wav, niveauRealisme: "structurel-local", fournisseur: "gen3-parametrique" };
}
