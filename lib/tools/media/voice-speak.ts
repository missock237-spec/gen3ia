import { z } from "zod";
import type { ToolDefinition } from "@/lib/tools/types";
import { genererAudioNeuralEtPersister } from "@/lib/neural/media-service";
import { VOIX_PROFESSEUR, estVoixEspace, choisirVoixSelonPersonnage } from "@/lib/neural/professeur-media";
import { analyserIntentionAudio } from "@/lib/neural/audio-intention";

/**
 * Outil voice.speak — SYNTHÈSE AUDIO AVEC ROUTAGE AUTOMATIQUE DE L'INTENTION.
 *
 * Rend réel le contrat annoncé depuis longtemps au planificateur
 * (unified-agent AUDIO RULE, catalogue conversationnel) : l'outil
 * voice.speak était PROMIS mais aucun exécuteur n'existait — toute étape
 * planifiée échouait « Unknown tool: voice.speak » (audit multimodal).
 *
 * ROUTAGE AUTOMATIQUE (aucune consigne nécessaire à l'utilisateur) :
 * l'intention de la demande est analysée DÉTERMINISTEMENT
 * (lib/neural/audio-intention, lexique FR+EN) —
 *  - PAROLE (« lis ce texte », « raconte-moi ») → VOIX HUMAINE
 *    ultra-réaliste du professeur TTS (vitesse expressive automatique) ;
 *  - SONS (pluie, vagues, orage, feu…) → moteur de design sonore
 *    sémantique local (couches réelles) — JAMAIS lu à voix haute ;
 *  - MUSIQUE (piano, berceuse…) → moteur scénique local ;
 *  - hors vocabulaire → comportement historique.
 *
 * MODE PAROLE — VOIX HUMAINE RÉELLE (loi CONTRAINTE-ONDES) : le texte part
 * vers le TTS réel du professeur — voix humaine naturelle, choisie dans le
 * roster documenté (VOIX_PROFESSEUR : tongtong, chuichui, xiaochen, jam,
 * kazi, douji, luodo), vitesse réglable 0.5–2. VOIX CONTEXTUELLE (Task 2-a
 * AUDIO) : le REGISTRE est déduit du CONTENU (narration/annonceur/calme/
 * enthousiaste/professionnel — voir deduireRegistreVoix) et ajuste la
 * prosodie Edge-TTS (rate/pitch) ; la cascade existante reste intacte.
 *
 * MODE LOCAL HONNÊTE (sons/musique, ou parole sans cascade disponible) :
 * moteur scénique local — pour les SONS c'est le VRAI rendu demandé (design
 * sonore à couches) ; pour la PAROLE c'est un repli honnête (composition
 * harmonique déterministe) qui se dit explicitement NON parlé, pour que ni
 * le planner ni l'utilisateur ne soient trompés.
 *
 * Sortie compatible avec le contrat artefact du moteur conversationnel
 * (lib/domain/conversations/engine.ts) :
 *  - `url` = clé R2 PERMANENTE (users/<uid>/permanent/…) réutilisée
 *    telle quelle comme storagePath de l'artefact (Task 113) ;
 *  - `audioDataUri` = repli inline quand R2 est indisponible.
 */

/* ──────────────────────────────────────────────────────────────────────────
 * VOIX CONTEXTUELLE — REGISTRE DÉDUIT DU CONTENU (Task 2-a AUDIO)
 * ──────────────────────────────────────────────────────────────────────────
 * La voix doit être « ultra-réaliste et adaptée » : au-delà du choix du
 * personnage (féminin/masculin, déjà couvert par choisirVoixSelonPersonnage),
 * la PROSODIE Edge-TTS (rate, % et pitch, Hz) s'ajuste au REGISTRE du texte
 * à vocaliser. Déduction 100 % déterministe (zéro LLM, aucune latence) :
 * premières expressions qui matchent dans l'ordre de priorité ci-dessous.
 *
 * CORRESPONDANCE DOCUMENTÉE (rate/pitch bornés par les sliders de l'espace
 * Edge-TTS : rate ±50 % via vitesse 0.5–1.5, pitch ±50 Hz) :
 *  ┌────────────────┬──────────┬───────────┬─────────────────────────────┐
 *  │ Registre       │ rate     │ pitch     │ Textes détectés             │
 *  ├────────────────┼──────────┼───────────┼─────────────────────────────┤
 *  │ annonceur      │ +8 %     │ +3 Hz     │ annonce, publicité, promo,  │
 *  │                │ (1.08×)  │           │ jingle, radio, lancement    │
 *  │ calme          │ −22 %    │ −3 Hz     │ méditation, relaxation,     │
 *  │                │ (0.78×)  │           │ respiration, zen, sommeil   │
 *  │ enthousiaste   │ +15 %    │ +5 Hz     │ félicitations, bravo, super,│
 *  │                │ (1.15×)  │           │ bonne nouvelle, célébration │
 *  │ narration      │ −8 %     │ −2 Hz     │ récit, conte, histoire,     │
 *  │                │ (0.92×)  │           │ documentaire, légende       │
 *  │ professionnel  │ 0 %      │ 0 Hz      │ DÉFAUT — technique, courrier│
 *  │                │ (1.00×)  │           │ d'affaires, rapport, résumé │
 *  └────────────────┴──────────┴───────────┴─────────────────────────────┘
 * Priorité : registre du SUPPORT (annonceur) → humeur (calme, enthousiaste)
 * → forme (narration) → professionnel. Un registre imposé via l'entrée
 * `registre` du tool gagne sur la déduction ; une `vitesse` explicite gagne
 * sur la vitesse du registre (le pitch du registre reste appliqué).
 */

export const REGISTRES_VOIX = [
  "annonceur",
  "calme",
  "enthousiaste",
  "narration",
  "professionnel",
] as const;

export type RegistreVoix = (typeof REGISTRES_VOIX)[number];

export interface ProsodieRegistre {
  registre: RegistreVoix;
  /** Libellé français lisible (messages / meta). */
  label: string;
  /** Ajustement Edge-TTS « rate » en pourcentage entiers (−50..+50). */
  ratePourcent: number;
  /** Ajustement Edge-TTS « pitch » en Hz (−50..+50). */
  pitchHz: number;
  /** Multiplicateur de vitesse équivalent (rate 0 % = 1.0). */
  vitesse: number;
  /** Quand ce registre s'applique (documentation lisible par le planner). */
  quand: string;
}

export const PROSODIE_PAR_REGISTRE: Record<RegistreVoix, ProsodieRegistre> = {
  annonceur: {
    registre: "annonceur",
    label: "annonceur dynamique",
    ratePourcent: 8,
    pitchHz: 3,
    vitesse: 1.08,
    quand: "annonces, publicités, promotions, jingles, lancements, radio",
  },
  calme: {
    registre: "calme",
    label: "voix calme et posée",
    ratePourcent: -22,
    pitchHz: -3,
    vitesse: 0.78,
    quand: "méditation, relaxation, respiration, sommeil, apaisement",
  },
  enthousiaste: {
    registre: "enthousiaste",
    label: "voix enthousiaste",
    ratePourcent: 15,
    pitchHz: 5,
    vitesse: 1.15,
    quand: "félicitations, bonnes nouvelles, célébrations, encouragements",
  },
  narration: {
    registre: "narration",
    label: "voix de narration",
    ratePourcent: -8,
    pitchHz: -2,
    vitesse: 0.92,
    quand: "récits, contes, histoires, documentaires, légendes, lectures",
  },
  professionnel: {
    registre: "professionnel",
    label: "voix professionnelle neutre",
    ratePourcent: 0,
    pitchHz: 0,
    vitesse: 1,
    quand: "défaut : explications techniques, courriers, rapports, résumés",
  },
};

/** Détections par registre — PREMIER match dans l'ordre ci-dessous qui gagne. */
const DETECTION_REGISTRES: ReadonlyArray<{ registre: RegistreVoix; re: RegExp }> = [
  {
    registre: "annonceur",
    re: /annonc|publicit|\bpub\b|jingle|\bradio\b|sponsor|commerciale?|promotion|promo\b|lancement|invitation|[ée]v[ée]nement|vente flash|offre sp[ée]ciale/iu,
  },
  {
    registre: "calme",
    re: /m[ée]ditation|relax|respir|sommeil|endorm|dormir|zen|apais|d[ée]tent|calme|paisib|coh[ée]rence cardiaque/iu,
  },
  {
    registre: "enthousiaste",
    re: /f[ée]licit|bravo|\bsuper\b|g[ée]nial|excellent|magique|incroyable|bonne nouvelle|c[ée]l[ée]br|félicitons|merci beaucoup|bienvenue parmi/iu,
  },
  {
    registre: "narration",
    re: /r[ée]cit|\bconte\b|histoire|narrat|documentaire|l[ée]gende|lecture|\broman\b|chapitre|il [ée]tait une fois|intrigue/iu,
  },
];

/**
 * Déduit le registre vocal du texte à vocaliser (pur, déterministe) :
 * premier match dans l'ordre de priorité, sinon « professionnel ».
 */
export function deduireRegistreVoix(texte: string): ProsodieRegistre {
  const t = (texte ?? "").toLowerCase();
  for (const d of DETECTION_REGISTRES) {
    if (d.re.test(t)) return PROSODIE_PAR_REGISTRE[d.registre];
  }
  return PROSODIE_PAR_REGISTRE.professionnel;
}

const VoiceSpeakInput = z.object({
  text: z.string().min(1).max(4000).describe(
    "Le texte EXACT source de la synthèse (fidèle à la demande utilisateur).",
  ),
  dureeSecondes: z.number().int().min(1).max(30).optional().describe(
    "Durée souhaitée en secondes (défaut dérivé du texte, borné 4–30 s). " +
      "Mode voix humaine réelle : la durée suit le texte (ce paramètre est indicatif).",
  ),
  voix: z.string().optional().refine(
    (v) => v === undefined || (VOIX_PROFESSEUR as readonly string[]).includes(v) || estVoixEspace(v),
    { message: "Voix inconnue — rosters admis : passerelle (tongtong, chuichui, xiaochen, jam, kazi, douji, luodo) et espace public Edge-TTS (fr-FR-DeniseNeural, fr-FR-HenriNeural…)." },
  ).describe(
    "Voix humaine du mode voix réelle. Défaut : selon le PERSONNAGE décrit dans le texte " +
      "(« une femme… » → Denise, « un homme… » → Henri). Rosters : passerelle " +
      "(tongtong, chuichui, xiaochen, jam, kazi, douji, luodo) et espace public Edge-TTS " +
      "(13 voix françaises : Denise, Éloïse, Vivienne, Henri, Rémy + variantes BE/CA/CH).",
  ),
  vitesse: z.number().min(0.5).max(2).optional().describe(
    "Vitesse de parole en mode voix humaine réelle (0.5 = lent, 2 = rapide, défaut 1). " +
      "Si absente, la vitesse du REGISTRE déduit du contenu s'applique (calme 0.78, enthousiaste 1.15…).",
  ),
  registre: z.enum(REGISTRES_VOIX).optional().describe(
    "Registre vocal imposé (prosodie rate/pitch Edge-TTS) : " +
      REGISTRES_VOIX.join(", ") +
      ". Facultatif : par défaut le registre est DÉDUIT du contenu du texte " +
      "(annonce → annonceur +8 %/+3 Hz, méditation → calme −22 %/−3 Hz, récit → narration −8 %/−2 Hz…).",
  ),
});

/** Sortie typée de l'outil (contrat stable pour les planners). */
interface VoiceSpeakToolOutput {
  /** Clé R2 permanente (users/<uid>/permanent/ai-audio/…) quand archivé. */
  url?: string;
  /** "r2" = archivé en permanence ; "inline" = repli data URI. */
  storage: "r2" | "inline";
  /** Data URI audio (repli inline uniquement). */
  audioDataUri?: string;
  /** URL signée d'écoute immédiate (expire — le handle durable est url). */
  ecouterUrl: string;
  mimeType: "audio/wav" | "audio/mpeg";
  dureeSecondes: number;
  moteur: string;
  /** Note d'honnêteté sur la nature du rendu (voix TTS / design sonore / nappe). */
  note: string;
}

/** Durée par défaut dérivée du texte (≈ 0,45 s/mot, bornée 4–30 s). */
export function dureeDuTexte(texte: string): number {
  const mots = texte.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(4, Math.min(30, Math.round(mots * 0.45) || 6));
}

export const voiceSpeakTool: ToolDefinition<
  z.infer<typeof VoiceSpeakInput>,
  VoiceSpeakToolOutput
> = {
  id: "voice.speak",
  name: "voice.speak",
  description:
    "Synthétise un AUDIO à partir d'une demande : PAROLE → voix humaine ultra-réaliste (TTS réel du " +
    "professeur média, voix féminine/masculine selon le personnage — Denise/Henri — espace public " +
    "Edge-TTS ; roster " +
    "passerelle : tongtong, chuichui, xiaochen, jam, kazi, douji, luodo), prosodie CONTEXTUELLE au " +
    "contenu (registre déduit du texte — narration/annonceur/calme/enthousiaste/professionnel — avec " +
    "ajustement Edge-TTS rate/pitch ; imposable via `registre`), vitesse 0.5–2, archivage permanent. " +
    "Les demandes de SONS (pluie, vagues, orage, feu…) et de MUSIQUE sont AUTOMATIQUEMENT routées vers " +
    "le moteur de design sonore sémantique — jamais lues à voix haute. Repli local honnête quand la " +
    "cascade voix est indisponible : composition harmonique déterministe — ce n'est PAS de la parole, " +
    "et le résultat le signale.",
  category: "media",
  risk: "low",
  inputSchema: VoiceSpeakInput,
  async execute(input, context): Promise<VoiceSpeakToolOutput> {
    // ROUTAGE AUTOMATIQUE DE L'INTENTION (aucune consigne utilisateur) :
    // « voix » → cascade TTS réel ; « son » / « musique » → JAMAIS le TTS
    // (lire « le son de la pluie » à voix haute serait une erreur de rendu) ;
    // « inconnu » → comportement historique (cascade, puis moteur local).
    const intention = analyserIntentionAudio(input.text);
    const estDesignSonore = intention.nature === "son" || intention.nature === "musique";

    // Défaut INTELLIGENT : la voix suit le personnage décrit dans le texte
    // (féminine/masculine, déterministe) quand aucune voix n'est imposée.
    const voixRésolue = input.voix ?? choisirVoixSelonPersonnage(input.text).voixEspace;
    // VOIX CONTEXTUELLE (Task 2-a) : la prosodie (rate/pitch) suit le REGISTRE
    // déduit du contenu — ou le registre imposé par le planner. Une vitesse
    // explicite gagne sur celle du registre ; le pitch du registre reste.
    const prosodie = input.registre
      ? PROSODIE_PAR_REGISTRE[input.registre]
      : deduireRegistreVoix(input.text);
    const vitesseEffective = input.vitesse ?? prosodie.vitesse;

    // MODE PAROLE SANS CONFIGURATION (2026-11-12) : la cascade de PAROLE
    // seule (passerelle configurée → espace public Edge-TTS ANONYME) — la
    // vraie voix humaine ne dépend plus d'aucun fichier de configuration.
    // Les SONS et la MUSIQUE ne passent JAMAIS ici (routage automatique).
    if (!estDesignSonore) {
      const { genererVoixHumaineProfesseurEtPersister } = await import("@/lib/neural/media-service");
      const renduVoix = await genererVoixHumaineProfesseurEtPersister({
        userId: context.userId,
        texte: input.text.trim(),
        voix: voixRésolue,
        vitesse: vitesseEffective,
        pitch: prosodie.pitchHz,
      }).catch(() => null);
      if (renduVoix) {
        const { urlDurableAbsolue } = await import("@/lib/media/url-durable");
        const estPermanent = renduVoix.storage === "r2" && typeof renduVoix.cleStockage === "string";
        const ecouter =
          estPermanent && renduVoix.cleStockage ? (urlDurableAbsolue(renduVoix.cleStockage) ?? renduVoix.url) : renduVoix.url;
        return {
          ...(estPermanent ? { url: renduVoix.cleStockage } : {}),
          storage: renduVoix.storage,
          ...(renduVoix.storage === "inline" ? { audioDataUri: renduVoix.url } : {}),
          ecouterUrl: ecouter,
          mimeType: renduVoix.mime === "audio/mpeg" ? "audio/mpeg" : "audio/wav",
          dureeSecondes: typeof renduVoix.meta.duree === "number" ? renduVoix.meta.duree : 0,
          moteur: String(renduVoix.meta.moteur ?? "professeur-voix-espace-edge-tts"),
          note:
            "Voix humaine RÉELLE (loi CONTRAINTE-ONDES — échafaudage supprimable ; le signal d'onde gen3 prendra le relais après distillation)." +
            (typeof renduVoix.meta.voix === "string" ? ` Voix utilisée : ${renduVoix.meta.voix}.` : "") +
            ` Registre : ${prosodie.registre} (${prosodie.label}) — prosodie Edge-TTS rate ${prosodie.ratePourcent > 0 ? "+" : ""}${prosodie.ratePourcent} %, pitch ${prosodie.pitchHz > 0 ? "+" : ""}${prosodie.pitchHz} Hz${input.registre ? " (imposé)" : " (déduit du contenu)"}.`,
        };
      }
    }

    // MODE LOCAL : design sonore sémantique (sons/musique — le VRAI rendu
    // demandé) ou repli honnête (parole sans cascade disponible).
    const rendu = await genererAudioNeuralEtPersister({
      userId: context.userId,
      prompt: input.text.trim(),
      dureeSecondes: input.dureeSecondes ?? dureeDuTexte(input.text),
      frequenceEchantillonnage: 22050,
      nature: intention.nature,
      ...(estDesignSonore ? {} : { voix: voixRésolue, vitesse: vitesseEffective }),
    });

    const estPermanent = rendu.storage === "r2" && typeof rendu.cleStockage === "string";
    const estProfesseur = rendu.meta?.echafaudage === true;
    // LIVRAISON DURABLE (2026-11-12) : le texte final du planner cite
    // ecouterUrl — s'il était présigné (TTL 1 h), le lien du message
    // persisté mourrait (« l'audio n'est pas réellement envoyé »). Quand la
    // clé permanente existe, ecouterUrl = URL canonique re-signée à chaque
    // résolution ; repli : présignée d'origine (jamais de perte).
    const { urlDurableAbsolue } = await import("@/lib/media/url-durable");
    const ecouter =
      estPermanent && rendu.cleStockage ? (urlDurableAbsolue(rendu.cleStockage) ?? rendu.url) : rendu.url;
    return {
      // Contrat artefact : `url` = clé permanente résolvable (Task 113).
      ...(estPermanent ? { url: rendu.cleStockage } : {}),
      storage: rendu.storage,
      // Repli inline : data URI lisible par le lecteur embarqué (bornée).
      ...(rendu.storage === "inline" ? { audioDataUri: rendu.url } : {}),
      ecouterUrl: ecouter,
      mimeType: rendu.mime === "audio/mpeg" ? "audio/mpeg" : "audio/wav",
      dureeSecondes: typeof rendu.meta.duree === "number" ? rendu.meta.duree : 0,
      moteur: String(rendu.meta.moteur ?? "gen3-snn-audio-v1"),
      note: estProfesseur
        ? "Voix humaine RÉELLE générée par le professeur média temporaire (loi CONTRAINTE-ONDES — échafaudage supprimable ; le signal d'onde gen3 prendra le relais après distillation)." +
          (typeof rendu.meta?.voix === "string" ? ` Voix utilisée : ${rendu.meta.voix}.` : "")
        : estDesignSonore
          ? "Design sonore sémantique gen3 — couches réelles pluie/vagues/orage/feu… ; ce n'est pas une parole, le texte n'a jamais été lu à voix haute."
          : "Audio synthétisé localement par le moteur neuronal Gen3 (composition harmonique dérivée du texte). " +
            "Ce rendu n'est pas une parole humaine naturelle — le moteur local n'inclut pas de synthèse vocale parlée.",
    };
  },
};
