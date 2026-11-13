import { describe, expect, it } from "vitest";

import { analyserIntentionAudio, type NatureAudio } from "./audio-intention";

/**
 * ANALYSE D'INTENTION AUDIO — verrous (table-driven) :
 *  1. CHAQUE RÈGLE du lexique FR+EN (phrases « son de », « bruit de »,
 *     « effet sonore », « sound of » + stems SFX ; parole ; musique) ;
 *  2. PRIORITÉ son > voix > musique (« voix de la pluie » = un SON —
 *     le TTS ne doit jamais lire un bruit à voix haute) ;
 *  3. ACCENTS et CASSE indifférents (« PLUIE », « ÉNERGIE ») ;
 *  4. VITESSE EXPRESSIVE automatique de la parole (posé 0.85, dynamique
 *     1.15, défaut neutre 1) ;
 *  5. GARDES d'ambiguïté (« je ne sais pas » ≠ pas, « il porte » ≠ porte,
 *     « en train de » ≠ train, « météo » seule ≠ bulletin) ;
 *  6. HONNÊTETÉ : motif FR toujours présent et non vide, « inconnu »
 *     assumé hors vocabulaire (aucune invention).
 */

interface Cas {
  nom: string;
  prompt: string;
  nature: NatureAudio;
  /** Vitesse attendue (voix uniquement) — absente = undefined attendu. */
  vitesse?: number;
  /** Fragment attendu dans le motif (traçabilité). */
  motif?: string;
}

const CAS: Cas[] = [
  /* — SON : déclencheurs phrase — */
  { nom: "phrase « son de »", prompt: "le son de la pluie sur les vitres", nature: "son", motif: "son de" },
  { nom: "phrase « bruit des »", prompt: "le bruit des vagues sur les rochers", nature: "son", motif: "bruit de" },
  { nom: "phrase « effet sonore »", prompt: "un effet sonore de tonnerre", nature: "son", motif: "effet sonore" },
  { nom: "phrase EN « sound of »", prompt: "the sound of ocean waves", nature: "son", motif: "sound of" },
  { nom: "déclencheur « ambiance »", prompt: "une ambiance de forêt au petit matin", nature: "son", motif: "ambiance" },

  /* — SON : lexique SFX (pluie, orage, foule, objets, eau, feu) — */
  { nom: "lexique averse (pluie)", prompt: "une averse sur les feuilles", nature: "son", motif: "(averse)" },
  { nom: "lexique orage + tonnerre", prompt: "un orage avec tonnerre et éclairs", nature: "son" },
  { nom: "lexique océan", prompt: "l'océan au crépuscule", nature: "son", motif: "ocean" },
  { nom: "lexique feu (crépitement)", prompt: "le crépitement du feu dans la cheminée", nature: "son", motif: "crepitement" },
  { nom: "lexique applaudissements", prompt: "des applaudissements dans la salle", nature: "son", motif: "applaudissement" },
  { nom: "lexique pas (bruits de pas)", prompt: "les pas dans le couloir vide", nature: "son", motif: "(pas)" },
  { nom: "lexique sirène et train", prompt: "la sirène et le train de nuit", nature: "son", motif: "sirene" },
  { nom: "lexique eau (cascade, rivière)", prompt: "cascades et rivière en montagne", nature: "son" },

  /* — PRIORITÉ son > voix — */
  { nom: "« voix de la pluie » = son (priorité)", prompt: "voix de la pluie", nature: "son", motif: "pluie" },

  /* — SON : casse et accents indifférents — */
  { nom: "casse indifférente", prompt: "LE SON DE LA PLUIE", nature: "son" },
  { nom: "accents indifférents", prompt: "Écoute les vagues de l'orage", nature: "son", motif: "vague" },

  /* — VOIX : demandes de parole — */
  { nom: "impératif « lis »", prompt: "lis ce poème", nature: "voix", vitesse: 1, motif: "(lis)" },
  { nom: "conjugaison « lit »", prompt: "il lit le journal du soir", nature: "voix", vitesse: 1, motif: "(lit)" },
  { nom: "impératif « dis »", prompt: "dis bonjour à la classe", nature: "voix", vitesse: 1, motif: "(dis)" },
  { nom: "« raconte-moi »", prompt: "raconte-moi une histoire", nature: "voix", vitesse: 1, motif: "(raconte)" },
  { nom: "« voix » seule", prompt: "je veux ta voix", nature: "voix", vitesse: 1, motif: "(voix)" },
  { nom: "« podcast »", prompt: "un podcast sur l'histoire de France", nature: "voix", vitesse: 1, motif: "(podcast)" },
  { nom: "phrase EN « tell me »", prompt: "tell me a story", nature: "voix", vitesse: 1, motif: "tell me" },

  /* — VOIX : vitesse expressive — */
  { nom: "ton posé (méditation, doucement)", prompt: "lis ce texte de méditation doucement", nature: "voix", vitesse: 0.85, motif: "ton posé" },
  { nom: "ton dynamique (annonce, énergie)", prompt: "lis l'annonce avec énergie", nature: "voix", vitesse: 1.15, motif: "ton dynamique" },
  { nom: "casse + accents sur la vitesse", prompt: "LIS CE TEXTE AVEC ÉNERGIE", nature: "voix", vitesse: 1.15 },

  /* — VOIX : ancre bulletin+météo — */
  { nom: "bulletin météo = parole", prompt: "bulletin météo du jour", nature: "voix", vitesse: 1, motif: "bulletin météo" },

  /* — MUSIQUE — */
  { nom: "musique de piano", prompt: "une musique de piano douce", nature: "musique", motif: "(musique)" },
  { nom: "berceuse", prompt: "une berceuse pour endormir bébé", nature: "musique", motif: "berceuse" },
  { nom: "musique EN (piano, melody)", prompt: "a melancholic piano melody", nature: "musique", motif: "piano" },

  /* — INCONNU : honnêteté + gardes d'ambiguïté — */
  { nom: "hors vocabulaire", prompt: "xyzzy florb quux", nature: "inconnu" },
  { nom: "« météo » seule sans bulletin → inconnu", prompt: "la météo du jour à paris", nature: "inconnu" },
  { nom: "garde « pas » (négation)", prompt: "je ne sais pas quoi faire", nature: "inconnu" },
  { nom: "garde « porte » (verbe)", prompt: "il porte un manteau", nature: "inconnu" },
  { nom: "garde « train » (en train de)", prompt: "en train de dormir", nature: "inconnu" },
];

describe("analyserIntentionAudio — cas du lexique (table-driven)", () => {
  it.each(CAS)("$nom", ({ prompt, nature, vitesse, motif }) => {
    const intention = analyserIntentionAudio(prompt);
    expect(intention.nature).toBe(nature);
    if (vitesse === undefined) {
      expect(intention.vitesse).toBeUndefined();
    } else {
      expect(intention.vitesse).toBe(vitesse);
    }
    // Traçabilité honnête : motif FR toujours présent et non vide.
    expect(typeof intention.motif).toBe("string");
    expect(intention.motif.trim().length).toBeGreaterThan(0);
    if (motif !== undefined) {
      expect(intention.motif).toContain(motif);
    }
  });
});

describe("analyserIntentionAudio — déterminisme", () => {
  it("même prompt → décision identique bit-à-bit", () => {
    const prompt = "raconte une histoire de pluie et de tonnerre";
    expect(analyserIntentionAudio(prompt)).toEqual(analyserIntentionAudio(prompt));
  });

  it("prompt vide ou sans mots porteurs → inconnu assumé", () => {
    expect(analyserIntentionAudio("").nature).toBe("inconnu");
    expect(analyserIntentionAudio("   ").nature).toBe("inconnu");
    expect(analyserIntentionAudio("... ! ?").nature).toBe("inconnu");
  });
});
