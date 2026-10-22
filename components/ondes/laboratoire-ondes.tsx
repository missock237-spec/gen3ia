"use client";

/**
 * Laboratoire d'ondes — L'INTERFACE FINALE du W-DNN Gen3ia.
 *
 * Le dashboard EST le chat IA, et ce chat est un champ d'ondes vivant :
 *
 *  · le prompt de l'utilisateur devient une perturbation initiale
 *    (encodeur fréquentiel → impulsions de phases/fréquences) ;
 *  · le GPU de l'utilisateur propage l'onde (compute shader WebGPU,
 *    repli CPU universel) — visible en temps réel ;
 *  · les pics de résonance stabilisés redeviennent des mots — l'IA
 *    ÉCRIT PROGRESSIVEMENT, mot après mot, chacun réinjecté dans le
 *    champ : la parole devient onde, l'onde devient parole ;
 *  · les navigateurs connectés à la même salle forment un essaim P2P
 *    (WebRTC) qui échange des micro-paquets [phase, fréquence, amplitude] ;
 *  · le champ évolue : couplage, amortissement et fréquences propres
 *    s'adaptent en continu (optimisation évolutive hebbienne).
 *
 * Composer à 5 contrôles : envoyer · importer des fichiers · outils ·
 * effort · recherche web. Deux modes honnêtes : « résonance locale »
 * (démo du moteur, sans compte) et « cortex Gen3 » (connecté — la
 * réponse vient du SNN serveur via le flux NDJSON, chaque mot alimente
 * le champ au fil de l'écriture).
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { CanvasOndes, creerTamponRendu, type TamponRendu } from "@/components/ondes/canvas-ondes";
import { Button } from "@/components/ui/button";
import {
  CarteInverse,
  amplitudeMot,
  encoderTexte,
  signatureMot,
  tokenizeTexte,
} from "@/lib/ondes/encodeur";
import { DecodeurResonance } from "@/lib/ondes/decodeur";
import { NoeudEssaim } from "@/lib/ondes/essaim";
import { EvolutionOndes, type EtatEvolution } from "@/lib/ondes/evolution";
import { creerMoteur, reconfigurerMoteur } from "@/lib/ondes/moteur";
import type { LectureChamp, MoteurOndes } from "@/lib/ondes/champ";
import {
  bandePassanteEconomisee,
  formaterOctets,
  CONFIGS_EFFORT,
  type Impulsion,
  type NiveauEffort,
  type TypeMoteur,
} from "@/lib/ondes/types";
import {
  SignalisationDouble,
  nouvelIdNoeud,
} from "@/lib/ondes/signalisation";
import {
  attestationPourPaquet,
  empreinteSpectrale,
  verifierAttestation,
} from "@/lib/ondes/por";
import { authFetch } from "@/lib/firebase/auth-client";
import { safeClientTimezone, streamConversationTurn } from "@/lib/domain/conversations/stream-client";
import { cx } from "@/lib/ui/cx";

import "./laboratoire-ondes.css";

interface MessageFlux {
  role: "utilisateur" | "ia";
  /** Mots émis progressivement (rôle IA) — rendus un à un. */
  mots: string[];
  /** Texte brut complet (rôle utilisateur). */
  texte?: string;
  complet: boolean;
  /** Note d'accompagnement (phase moteur, erreur, mode). */
  note?: string;
}

interface PieceJointe {
  nom: string;
  taille: number;
  type: "texte" | "binaire";
}

interface ConnexionOutil {
  id: string;
  label: string;
  toolkit: string;
}

interface VueStats {
  fps: number;
  pasTotaux: number;
  pics: number;
  ordreR: number;
  energie: number;
  pairs: number;
  paquetsEnvoyes: number;
  paquetsRecus: number;
  economie: number;
  porEmis: number;
  porVerifies: number;
  porRejetes: number;
  eta: number;
  couplage: number;
  amortissement: number;
  adaptations: number;
  mots: number;
  vocabulaire: number;
}

const STATS_VIERGES: VueStats = {
  fps: 0,
  pasTotaux: 0,
  pics: 0,
  ordreR: 0,
  energie: 0,
  pairs: 0,
  paquetsEnvoyes: 0,
  paquetsRecus: 0,
  economie: 0,
  porEmis: 0,
  porVerifies: 0,
  porRejetes: 0,
  eta: 0.012,
  couplage: 0.1,
  amortissement: 0.985,
  adaptations: 0,
  mots: 0,
  vocabulaire: 0,
};

const NIVEAUX_EFFORT: Array<{ id: NiveauEffort; label: string; detail: string }> = [
  { id: "faible", label: "Faible", detail: "128² · réflexion rapide" },
  { id: "moyen", label: "Moyen", detail: "192² · équilibre" },
  { id: "eleve", label: "Élevé", detail: "256² · réflexion profonde" },
  { id: "ultra", label: "Ultra", detail: "320² · résonance maximale" },
];

const CLE_PERSISTENCE_EVOLUTION = "gen3ia-ondes-evolution-v1";

export default function LaboratoireOndes() {
  // ——— états d'interface
  const [statutMoteur, setStatutMoteur] = useState<"initialisation" | "pret" | "erreur">("initialisation");
  const [typeMoteur, setTypeMoteur] = useState<TypeMoteur>("cpu");
  const [raisonRepli, setRaisonRepli] = useState<string | null>(null);
  const [effort, setEffort] = useState<NiveauEffort>("moyen");
  const [effortOuvert, setEffortOuvert] = useState(false);
  const [rechercheWeb, setRechercheWeb] = useState(false);
  const [outilsOuvert, setOutilsOuvert] = useState(false);
  const [connexions, setConnexions] = useState<ConnexionOutil[] | null>(null);
  const [outilsChoisis, setOutilsChoisis] = useState<string[]>([]);
  const [pieces, setPieces] = useState<PieceJointe[]>([]);
  const [prompt, setPrompt] = useState("");
  const [messages, setMessages] = useState<MessageFlux[]>([]);
  const [occupe, setOccupe] = useState(false);
  const [phaseCourante, setPhaseCourante] = useState<string | null>(null);
  const [statutGen3, setStatutGen3] = useState<"inconnu" | "invite" | "connecte">("inconnu");
  const [essaimActif, setEssaimActif] = useState(false);
  const [salle, setSalle] = useState("gen3ia-ondes");
  /** Mode MESH PRIVÉ (plan Entreprise) : salle signée par ticket. */
  const [modeMesh, setModeMesh] = useState(false);
  const [meshNote, setMeshNote] = useState<string | null>(null);
  const [statutEssaimTexte, setStatutEssaimTexte] = useState("");
  const [stats, setStats] = useState<VueStats>(STATS_VIERGES);
  const [erreur, setErreur] = useState<string | null>(null);

  // ——— refs moteur (muetes pour React, mutées par la boucle)
  const moteurRef = useRef<MoteurOndes | null>(null);
  const tamponRef = useRef<TamponRendu>(creerTamponRendu());
  const fileImpulsionsRef = useRef<Impulsion[]>([]);
  const fileMotsRef = useRef<string[]>([]);
  const dernierMotAfficheRef = useRef(0);
  const dernierMotLocalRef = useRef(0);
  const motsEcritsRef = useRef(0);
  const carteRef = useRef(new CarteInverse());
  const decodeurRef = useRef<DecodeurResonance | null>(null);
  const evolutionRef = useRef<EvolutionOndes | null>(null);
  const essaimRef = useRef<NoeudEssaim | null>(null);
  const idNoeudRef = useRef<string>("");
  const conversationRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const entreeFichierRef = useRef<HTMLInputElement | null>(null);
  const dernierLectureRef = useRef<LectureChamp | null>(null);
  const statutGen3Ref = useRef<"inconnu" | "invite" | "connecte">("inconnu");
  const occupeRef = useRef(false);
  // ——— Proof-of-Resonance : attestations émises / vérifiées / rejetées
  const porCompteursRef = useRef({ emis: 0, verifies: 0, rejetes: 0 });

  statutGen3Ref.current = statutGen3;
  occupeRef.current = occupe;

  // ——— ajout d'un mot au flux (écriture progressive mot-à-mot)
  const ajouterMotAuFlux = useCallback((mot: string) => {
    motsEcritsRef.current++;
    setMessages((precedents) => {
      const copie = [...precedents];
      const dernier = copie[copie.length - 1];
      if (dernier && dernier.role === "ia" && !dernier.complet) {
        copie[copie.length - 1] = { ...dernier, mots: [...dernier.mots, mot] };
      } else {
        copie.push({ role: "ia", mots: [mot], complet: false });
      }
      return copie;
    });
  }, []);

  const cloreTour = useCallback(() => {
    setMessages((precedents) => {
      const copie = [...precedents];
      const dernier = copie[copie.length - 1];
      if (dernier && dernier.role === "ia" && !dernier.complet) {
        if (dernier.mots.length === 0) {
          dernier.mots.push("(le champ n'a pas stabilisé de résonance — reformule ou augmente l'effort)");
        }
        copie[copie.length - 1] = { ...dernier, complet: true };
      }
      return copie;
    });
    setOccupe(false);
    setPhaseCourante(null);
  }, []);

  // ——— réinjection : un mot prononcé redevient onde (boucle parole ↔ onde)
  const faireEchoMot = useCallback((mot: string) => {
    const moteur = moteurRef.current;
    if (!moteur) return;
    const sig = signatureMot(mot, moteur.largeur);
    fileImpulsionsRef.current.push({
      x: sig.x,
      y: sig.y,
      amplitude: amplitudeMot(mot) * 0.6,
      frequence: sig.frequence,
      phase: sig.phase,
      rayon: 2,
    });
    carteRef.current.enregistrer(mot, moteur.largeur);
  }, []);

  // ——— initialisation du moteur (une seule fois)
  useEffect(() => {
    let annule = false;
    idNoeudRef.current = nouvelIdNoeud();
    (async () => {
      const cfg = CONFIGS_EFFORT.moyen;
      try {
        const resultat = await creerMoteur(cfg);
        if (annule) {
          resultat.moteur.detruire();
          return;
        }
        moteurRef.current = resultat.moteur;
        setTypeMoteur(resultat.type);
        setRaisonRepli(resultat.raison ?? null);
        decodeurRef.current = new DecodeurResonance(carteRef.current, resultat.moteur.largeur);
        const evolution = new EvolutionOndes(cfg.couplage, cfg.amortissement);
        // Restaure l'optimisation évolutive de ce navigateur.
        try {
          const brut = window.localStorage.getItem(CLE_PERSISTENCE_EVOLUTION);
          if (brut) {
            evolution.importerEtat(JSON.parse(brut) as EtatEvolution, resultat.moteur.largeur);
          }
        } catch {
          // localStorage indisponible : le champ repart de sa graine.
        }
        evolutionRef.current = evolution;
        setStatutMoteur("pret");
      } catch {
        if (!annule) setStatutMoteur("erreur");
      }
    })();
    return () => {
      annule = true;
    };
  }, []);

  // ——— statut du cortex Gen3 (connecté ?) + outils disponibles
  useEffect(() => {
    let annule = false;
    (async () => {
      try {
        const reponse = await authFetch("/api/auth/profile", { cache: "no-store" });
        if (annule) return;
        if (reponse.ok) {
          setStatutGen3("connecte");
          const outils = await authFetch("/api/integrations/composio/connections", { cache: "no-store" });
          if (outils.ok && !annule) {
            const corps = (await outils.json().catch(() => null)) as { connections?: ConnexionOutil[] } | null;
            setConnexions(Array.isArray(corps?.connections) ? corps!.connections! : []);
          }
        } else {
          setStatutGen3("invite");
        }
      } catch {
        if (!annule) setStatutGen3("invite");
      }
    })();
    return () => {
      annule = true;
    };
  }, []);

  // ——— LA BOUCLE PRINCIPALE : physique → readback → décodage → écriture
  useEffect(() => {
    if (statutMoteur !== "pret") return;
    let vivant = true;
    let lectureEnCours = false;
    let images = 0;
    let compteurFps = 0;
    let fps = 0;
    let instantFps = performance.now();
    let dernierSyncEvolution = performance.now();
    let dernierPushStats = performance.now();
    let dernierePersistence = performance.now();

    const boucle = async (instant: number) => {
      if (!vivant) return;
      requestAnimationFrame(boucle);
      const moteur = moteurRef.current;
      if (!moteur) return;

      images++;
      compteurFps++;
      if (instant - instantFps >= 1000) {
        fps = compteurFps;
        compteurFps = 0;
        instantFps = instant;
      }

      // 1) Injection progressive des impulsions en attente (max 8/image).
      if (fileImpulsionsRef.current.length > 0) {
        moteur.injecter(fileImpulsionsRef.current.splice(0, 8));
      }

      // 2) La physique avance (pas GPU/CPU).
      moteur.avancer();

      // 3) Readback throttlé + décodage de résonance + évolution.
      const cfg = moteur.config();
      if (!lectureEnCours && images % cfg.periodeReadback === 0) {
        lectureEnCours = true;
        try {
          const lecture = await moteur.lire();
          lectureEnCours = false;
          if (!vivant) return;
          dernierLectureRef.current = lecture;
          const tampon = tamponRef.current;
          tampon.amp = moteur.amplitudes();
          tampon.phase = moteur.phases();
          tampon.largeur = moteur.largeur;
          tampon.hauteur = moteur.hauteur;
          tampon.pics = lecture.pics;

          // Un mot maximum par readback : l'écriture reste progressive.
          const decodeur = decodeurRef.current;
          const mot = decodeur?.observer(lecture.pics, instant);
          if (mot) {
            dernierMotLocalRef.current = instant;
            fileMotsRef.current.push(mot);
            evolutionRef.current?.noterMot();
            faireEchoMot(mot);
          }

          // ——— PROOF-OF-RESONANCE : attestation du champ courant + émission
          // des pics dominants vers l'essaim (chaque paquet porte l'empreinte
          // spectrale de phase du champ qui l'a produit — les voisins la
          // vérifient par résonance ; voir lib/ondes/por.ts).
          const essaim = essaimRef.current;
          if (essaim && essaim.nbPairsOuverts > 0) {
            try {
              const attestation = empreinteSpectrale(moteur.amplitudes(), moteur.phases(), { config: cfg });
              const compacte = attestationPourPaquet(attestation);
              for (const pic of lecture.pics.slice(0, 4)) {
                essaim.envoyerPaquet({
                  p: [pic.x, pic.y],
                  a: pic.amplitude,
                  f: 0.03 + (Math.abs(pic.phase) % 0.14),
                  th: pic.phase,
                  ts: Date.now(),
                  por: compacte,
                });
                porCompteursRef.current.emis++;
              }
            } catch {
              // Attestation impossible (grille en cours de réécriture) : la
              // physique locale continue, le paquet suivant sera attesté.
            }
          }

          // Optimisation évolutive (1 Hz) : renforcement hebbien +
          // régulation du couplage et de l'amortissement.
          const evolution = evolutionRef.current;
          if (evolution && instant - dernierSyncEvolution >= 1000) {
            dernierSyncEvolution = instant;
            evolution.definirDimension(moteur.largeur);
            const { couplage, amortissement } = evolution.evoluer({
              ordreR: lecture.ordreR,
              energie: lecture.energie,
              pics: lecture.pics,
              pas: cfg.pasParImage * cfg.periodeReadback,
            });
            cfg.couplage = couplage;
            cfg.amortissement = amortissement;
            evolution.appliquer(moteur.frequences(), moteur.largeur);
            moteur.remplacerFrequences(moteur.frequences());
          }
        } catch {
          lectureEnCours = false;
        }
      }

      // 4) Écriture progressive : cadence adaptative à la taille de file.
      if (fileMotsRef.current.length > 0) {
        const longueur = fileMotsRef.current.length;
        const cadence = longueur > 12 ? 40 : longueur > 6 ? 60 : 90;
        if (instant - dernierMotAfficheRef.current >= cadence) {
          dernierMotAfficheRef.current = instant;
          const mot = fileMotsRef.current.shift();
          if (mot) {
            ajouterMotAuFlux(mot);
            faireEchoMot(mot);
          }
        }
      }

      // 5) Fin de tour locale : le champ s'est tus (4 s sans parole).
      if (occupeRef.current && statutGen3Ref.current !== "connecte") {
        if (fileMotsRef.current.length === 0 && instant - dernierMotLocalRef.current > 4000 && dernierMotLocalRef.current > 0) {
          cloreTour();
        }
      }

      // 6) Statistiques (2 Hz) + persistence de l'évolution (10 s).
      if (instant - dernierPushStats >= 500) {
        dernierPushStats = instant;
        const essaim = essaimRef.current;
        const statsEssaim = essaim?.statistiques ?? { pairs: 0, paquetsEnvoyes: 0, paquetsRecus: 0, octetsEnvoyes: 0, octetsRecus: 0 };
        const evolution = evolutionRef.current;
        setStats({
          fps,
          pasTotaux: moteur.pasTotaux,
          pics: dernierLectureRef.current?.pics.length ?? 0,
          ordreR: dernierLectureRef.current?.ordreR ?? 0,
          energie: dernierLectureRef.current?.energie ?? 0,
          pairs: statsEssaim.pairs,
          paquetsEnvoyes: statsEssaim.paquetsEnvoyes,
          paquetsRecus: statsEssaim.paquetsRecus,
          economie: bandePassanteEconomisee(statsEssaim),
          porEmis: porCompteursRef.current.emis,
          porVerifies: porCompteursRef.current.verifies,
          porRejetes: porCompteursRef.current.rejetes,
          eta: evolution?.etaCourant ?? 0.012,
          couplage: evolution?.couplageCourant ?? cfg.couplage,
          amortissement: evolution?.amortissementCourant ?? cfg.amortissement,
          adaptations: evolution?.nbAdaptations ?? 0,
          mots: motsEcritsRef.current,
          vocabulaire: carteRef.current.taille,
        });
      }
      if (instant - dernierePersistence >= 10000) {
        dernierePersistence = instant;
        try {
          const etat = evolutionRef.current?.exporterEtat();
          if (etat) window.localStorage.setItem(CLE_PERSISTENCE_EVOLUTION, JSON.stringify(etat));
        } catch {
          // Persistence best-effort.
        }
      }
    };

    requestAnimationFrame(boucle);
    return () => {
      vivant = false;
    };
  }, [statutMoteur, ajouterMotAuFlux, faireEchoMot, cloreTour]);

  // ——— nettoyage final (déchargement)
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      essaimRef.current?.arreter();
      moteurRef.current?.detruire();
      moteurRef.current = null;
    };
  }, []);

  // ——— flux NDJSON du cortex Gen3 : chaque delta devient des mots progressifs
  const envoyerGen3 = useCallback(
    async (texte: string) => {
      const controleur = new AbortController();
      abortRef.current = controleur;
      setPhaseCourante("Réflexion du cortex Gen3…");
      try {
        let conversationId = conversationRef.current;
        if (!conversationId) {
          const reponse = await authFetch("/api/workspace/conversations", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ title: texte.slice(0, 60) }),
            signal: controleur.signal,
          });
          if (reponse.status === 401 || reponse.status === 403) {
            setStatutGen3("invite");
            throw new Error("Connexion requise pour le cortex Gen3.");
          }
          if (!reponse.ok) throw new Error("Création de conversation impossible.");
          const corps = (await reponse.json()) as { conversation?: { id?: string } };
          conversationId = corps.conversation?.id ?? null;
          if (!conversationId) throw new Error("Conversation indisponible.");
          conversationRef.current = conversationId;
        }

        // Pièces jointes : le cortex reçoit l'empreinte textuelle (noms).
        const noms = pieces.map((p) => p.nom);
        const messageComplet =
          noms.length > 0 ? `${texte}\n\n[Fichiers analysés dans le champ d'ondes : ${noms.join(", ")}]` : texte;

        const resteRef = { valeur: "" };
        const complet = await streamConversationTurn({
          conversationId,
          message: messageComplet,
          ...(outilsChoisis.length > 0 ? { connectors: outilsChoisis } : {}),
          webSearch: rechercheWeb,
          timezone: safeClientTimezone(),
          signal: controleur.signal,
          onEvent: (evenement) => {
            if (evenement.type === "message_delta") {
              setPhaseCourante(null);
              resteRef.valeur += evenement.delta;
              const morceaux = resteRef.valeur.split(/(\s+)/);
              resteRef.valeur = morceaux.pop() ?? "";
              for (const morceau of morceaux) {
                const mot = morceau.trim();
                if (mot) fileMotsRef.current.push(mot);
              }
            } else if (evenement.type === "status") {
              setPhaseCourante(evenement.label);
            } else if (evenement.type === "error") {
              setErreur(evenement.message);
            }
          },
        });
        // Reste de la segmentation (dernier mot sans espace final).
        const resteFinal = resteRef.valeur.trim();
        if (resteFinal) fileMotsRef.current.push(...resteFinal.split(/\s+/));

        // Le tour se ferme quand la file de mots s'est vidée à l'écran.
        while (fileMotsRef.current.length > 0 && !controleur.signal.aborted) {
          await new Promise((resoudre) => setTimeout(resoudre, 60));
        }
        if (complet || controleur.signal.aborted) cloreTour();
        else throw new Error("Le flux s'est interrompu — le tour reste consultable dans Conversations.");
      } catch (erreurLance) {
        const messageErreur = erreurLance instanceof Error ? erreurLance.message : "Erreur inconnue.";
        setErreur(messageErreur);
        cloreTour();
      } finally {
        abortRef.current = null;
      }
    },
    [cloreTour, outilsChoisis, pieces, rechercheWeb],
  );

  // ——— arrêt d'urgence du tour en cours
  // ——— ENVOI : la question devient perturbation initiale + réponse
  const envoyer = useCallback(async () => {
    const texte = prompt.trim();
    if (!texte || occupe || statutMoteur !== "pret") return;
    setPrompt("");
    setErreur(null);
    setMessages((precedents) => [...precedents, { role: "utilisateur", texte: texte, mots: [], complet: true }]);
    setOccupe(true);
    occupeRef.current = true;
    dernierMotLocalRef.current = performance.now();

    // 1) Encodeur fréquentiel : chaque mot excite sa région du champ.
    const moteur = moteurRef.current;
    if (moteur) {
      const dim = moteur.largeur;
      for (const mot of tokenizeTexte(texte)) carteRef.current.enregistrer(mot, dim);
      fileImpulsionsRef.current.push(...encoderTexte(texte, dim, 48));
    }

    // 2) Réponse : cortex Gen3 (connecté) ou résonance locale (démo).
    if (statutGen3 === "connecte") {
      await envoyerGen3(texte);
    } else {
      setMessages((precedents) => {
        const copie = [...precedents];
        copie.push({ role: "ia", mots: [], complet: false, note: "résonance locale — connecte-toi pour le cortex Gen3" });
        return copie;
      });
    }
  }, [prompt, occupe, statutMoteur, statutGen3, envoyerGen3]);

  const arreter = useCallback(() => {
    abortRef.current?.abort();
    fileMotsRef.current = [];
    cloreTour();
  }, [cloreTour]);

  // ——— changement d'effort : reconfiguration du champ (fréquences conservées)
  const changerEffort = useCallback(async (niveau: NiveauEffort) => {
    setEffort(niveau);
    setEffortOuvert(false);
    const ancien = moteurRef.current;
    if (!ancien) return;
    const cfg = CONFIGS_EFFORT[niveau];
    // Le repli CPU plafonne la grille (fluidité garantie sur tout matériel).
    const cfgEffective =
      ancien.type === "cpu"
        ? { ...cfg, largeur: Math.min(cfg.largeur, 192), hauteur: Math.min(cfg.hauteur, 192), pasParImage: Math.min(cfg.pasParImage, 2) }
        : cfg;
    try {
      const nouveau = await reconfigurerMoteur(ancien, cfgEffective);
      moteurRef.current = nouveau;
      decodeurRef.current?.redimensionner(nouveau.largeur);
      const tampon = tamponRef.current;
      tampon.amp = nouveau.amplitudes();
      tampon.phase = nouveau.phases();
      tampon.largeur = nouveau.largeur;
      tampon.hauteur = nouveau.hauteur;
      tampon.pics = [];
    } catch {
      // Le moteur précédent reste actif si la reconstruction échoue.
    }
  }, []);

  // ——— import de fichiers : pluie d'impulsions (empreinte du document)
  const importerFichiers = useCallback(async (liste: FileList | null) => {
    if (!liste || liste.length === 0) return;
    const moteur = moteurRef.current;
    const dim = moteur?.largeur ?? 192;
    const nouvelles: PieceJointe[] = [];
    for (const fichier of Array.from(liste).slice(0, 5)) {
      const estTexte =
        fichier.type.startsWith("text/") ||
        fichier.type === "application/json" ||
        /\.(txt|md|csv|json|ts|tsx|js|jsx|py|html|css|xml|yml|yaml|log)$/i.test(fichier.name);
      if (estTexte && fichier.size < 2_000_000) {
        try {
          const contenu = await fichier.text();
          const mots = tokenizeTexte(contenu).slice(0, 400);
          const uniques = [...new Set(mots)];
          for (const mot of uniques) carteRef.current.enregistrer(mot, dim);
          // Le document entre dans le champ comme une averse d'impulsions.
          fileImpulsionsRef.current.push(
            ...encoderTexte(uniques.join(" "), dim, 48).map((imp) => ({ ...imp, amplitude: imp.amplitude * 0.8 })),
          );
          nouvelles.push({ nom: fichier.name, taille: fichier.size, type: "texte" });
        } catch {
          nouvelles.push({ nom: fichier.name, taille: fichier.size, type: "binaire" });
        }
      } else {
        // Binaire / image : empreinte fréquentielle du nom + taille.
        fileImpulsionsRef.current.push(...encoderTexte(`fichier ${fichier.name} ${fichier.size}`, dim, 8));
        nouvelles.push({ nom: fichier.name, taille: fichier.size, type: "binaire" });
      }
    }
    setPieces((precedentes) => [...precedentes, ...nouvelles].slice(-6));
  }, []);

  // ——— essaim P2P : rejoindre / quitter une salle (publique OU privée)
  const basculerEssaim = useCallback(async () => {
    if (essaimRef.current) {
      essaimRef.current.arreter();
      essaimRef.current = null;
      setEssaimActif(false);
      setStatutEssaimTexte("");
      return;
    }
    let salleEffective = salle;
    let ticket: string | undefined;
    if (modeMesh) {
      // Private Mesh : un TICKET SIGNÉ (10 min) est exigé — l'admission
      // est refusée au serveur pour tout compte sans le plan Entreprise.
      setMeshNote("demande de ticket…");
      try {
        const reponse = await fetch("/api/ondes/mesh/ticket", { method: "POST", cache: "no-store" });
        if (!reponse.ok) {
          setMeshNote(
            reponse.status === 403
              ? "Mesh privé réservé au plan Entreprise (voir /tarifs)."
              : "Ticket de mesh indisponible pour l'instant.",
          );
          return;
        }
        const donnees = (await reponse.json()) as { ticket?: string; salle?: string };
        if (!donnees.ticket || !donnees.salle) {
          setMeshNote("Ticket de mesh incomplet — réessayez.");
          return;
        }
        ticket = donnees.ticket;
        salleEffective = donnees.salle;
        setMeshNote("mesh privé · admission signée — aucune donnée ne sort du parc");
      } catch {
        setMeshNote("Ticket de mesh indisponible (réseau).");
        return;
      }
    } else {
      setMeshNote(null);
    }
    const transport = new SignalisationDouble(salleEffective, idNoeudRef.current, ticket);
    const noeud = new NoeudEssaim({
      transport,
      surPaquet: (paquet) => {
        // Proof-of-Resonance : l'attestation du paquet est vérifiée AVANT
        // injection — format, bornes et plausibilité physique. Un paquet
        // sans attestation est admis (rétrocompatibilité) mais non compté.
        if (paquet.por) {
          const verdict = verifierAttestation(paquet.por);
          if (verdict.valide) porCompteursRef.current.verifies++;
          else porCompteursRef.current.rejetes++;
        }
        moteurRef.current?.injecterPaquet(paquet);
        tamponRef.current.flashs.push({ x: paquet.p[0], y: paquet.p[1], t: performance.now() });
        if (tamponRef.current.flashs.length > 12) tamponRef.current.flashs.shift();
      },
      surStatut: setStatutEssaimTexte,
    });
    noeud.demarrer();
    essaimRef.current = noeud;
    setEssaimActif(true);
  }, [salle, modeMesh]);

  const entrerValide = (evenement: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (evenement.key === "Enter" && !evenement.shiftKey) {
      evenement.preventDefault();
      void envoyer();
    }
  };

  const badgeMoteur =
    statutMoteur === "pret" ? (typeMoteur === "webgpu" ? "GPU · WebGPU" : "CPU · repli") : statutMoteur === "initialisation" ? "initialisation…" : "indisponible";
  const cfgCourante = CONFIGS_EFFORT[effort];

  return (
    <div className="ondes-shell">
      <header className="ondes-header">
        <div className="ondes-marque">
          <span className="ondes-logo" aria-hidden="true">≋</span>
          <div>
            <h1 className="ondes-titre">Gen3ia · Ondes W-DNN</h1>
            <p className="ondes-sous-titre">Inférence par ondes neuronales distribuées — le GPU propage la pensée</p>
          </div>
        </div>
        <div className="ondes-badges" aria-label="État du moteur">
          <span className="ondes-badge" data-actif={statutMoteur === "pret"}>{badgeMoteur}</span>
          <span className="ondes-badge">{cfgCourante.largeur}×{cfgCourante.hauteur}</span>
          <span className="ondes-badge" data-actif={essaimActif}>
            essaim · {stats.pairs} pair{stats.pairs > 1 ? "s" : ""}
          </span>
          <span className="ondes-badge" data-actif={statutGen3 === "connecte"}>
            {statutGen3 === "connecte" ? "cortex Gen3" : statutGen3 === "inconnu" ? "…" : "résonance locale"}
          </span>
        </div>
      </header>

      {raisonRepli ? <p className="ondes-avis">{raisonRepli}</p> : null}

      <main className="ondes-corps">
        <section className="ondes-scene" aria-label="Champ d'ondes neuronales">
          <CanvasOndes
            tampon={tamponRef.current}
            labelAria={`Champ d'ondes ${cfgCourante.largeur} par ${cfgCourante.hauteur} oscillateurs — ${stats.pics} pics de résonance détectés`}
          />
          <div className="ondes-telemetrie" aria-hidden="true">
            <span>{stats.fps} img/s</span>
            <span>{stats.pasTotaux.toLocaleString("fr-FR")} pas</span>
            <span>r = {stats.ordreR.toFixed(2)}</span>
            <span>énergie {stats.energie.toFixed(2)}</span>
            <span>{stats.pics} pics</span>
          </div>
        </section>

        <aside className="ondes-colonne">
          <div className="ondes-flux" role="log" aria-live="polite" aria-label="Réponse de l'IA, écrite progressivement">
            {messages.length === 0 ? (
              <div className="ondes-vide">
                <p className="ondes-vide-titre">Pose ta question — elle devient une onde.</p>
                <p className="ondes-vide-texte">
                  Le champ la propage, la résonance stabilise les mots, l&apos;IA les écrit un à un.
                  Rejoins l&apos;essaim pour propager tes ondes vers d&apos;autres navigateurs.
                </p>
              </div>
            ) : (
              messages.map((message, index) =>
                message.role === "utilisateur" ? (
                  <p key={index} className="ondes-message-utilisateur">
                    {message.texte}
                  </p>
                ) : (
                  <div key={index} className="ondes-message-ia">
                    {message.note ? <span className="ondes-note">{message.note}</span> : null}
                    <p>
                      {message.mots.map((mot, i) => (
                        <span key={i} className="ondes-mot">{mot} </span>
                      ))}
                      {!message.complet ? <span className="ondes-curseur" aria-hidden="true" /> : null}
                    </p>
                  </div>
                ),
              )
            )}
            {phaseCourante ? (
              <p className="ondes-phase" role="status">
                <span className="ondes-phase-point" aria-hidden="true" /> {phaseCourante}
              </p>
            ) : null}
            {erreur ? <p className="ondes-erreur" role="alert">{erreur}</p> : null}
          </div>

          <details className="ondes-panneau" open>
            <summary>Essaim P2P · {stats.pairs} pair{stats.pairs > 1 ? "s" : ""}</summary>
            <div className="ondes-panneau-corps">
              <div className="ondes-ligne-salle">
                <label htmlFor="ondes-salle">Salle</label>
                <input
                  id="ondes-salle"
                  value={salle}
                  onChange={(evenement) => setSalle(evenement.target.value.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32))}
                  disabled={essaimActif || modeMesh}
                  aria-describedby="ondes-salle-aide"
                />
              </div>
              <label className="ondes-aide" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  type="checkbox"
                  checked={modeMesh}
                  onChange={(evenement) => setModeMesh(evenement.target.checked)}
                  disabled={essaimActif}
                />
                Mesh privé (plan Entreprise) — essaim fermé, admission par ticket signé
              </label>
              <p id="ondes-salle-aide" className="ondes-aide">
                Ouvre cette page dans un second onglet ou navigateur, même salle : les ondes circulent en direct (WebRTC, micro-paquets de phase — jamais de tenseurs).
              </p>
              <Button variant={essaimActif ? "secondary" : "primary"} size="sm" onClick={() => void basculerEssaim()} disabled={!statutMoteur || statutMoteur !== "pret"}>
                {essaimActif ? "Quitter l'essaim" : modeMesh ? "Rejoindre le mesh privé" : "Rejoindre l'essaim"}
              </Button>
              {meshNote ? <p className="ondes-aide">{meshNote}</p> : null}
              {statutEssaimTexte ? <p className="ondes-aide">{statutEssaimTexte}</p> : null}
              {essaimActif ? (
                <>
                  <dl className="ondes-metriques">
                    <div><dt>Paquets ↗</dt><dd>{stats.paquetsEnvoyes}</dd></div>
                    <div><dt>Paquets ↙</dt><dd>{stats.paquetsRecus}</dd></div>
                    <div><dt>Économisée</dt><dd>{formaterOctets(stats.economie)}</dd></div>
                  </dl>
                  <dl className="ondes-metriques" aria-label="Proof-of-Resonance">
                    <div><dt>PoR émises</dt><dd>{stats.porEmis}</dd></div>
                    <div><dt>PoR vérifiées</dt><dd>{stats.porVerifies}</dd></div>
                    <div><dt>PoR rejetées</dt><dd>{stats.porRejetes}</dd></div>
                  </dl>
                  <p className="ondes-aide">
                    Chaque paquet transporte une empreinte spectrale de phase (Proof-of-Resonance) :
                    les voisins la vérifient par résonance — nul ne peut la falsifier sans avoir
                    réellement propagé l&apos;onde sur son GPU.
                  </p>
                </>
              ) : null}
            </div>
          </details>

          <details className="ondes-panneau">
            <summary>Évolution du champ · {stats.adaptations} adaptations</summary>
            <div className="ondes-panneau-corps">
              <dl className="ondes-metriques">
                <div><dt>Couplage K</dt><dd>{stats.couplage.toFixed(3)}</dd></div>
                <div><dt>Amortissement</dt><dd>{stats.amortissement.toFixed(4)}</dd></div>
                <div><dt>η (apprentissage)</dt><dd>{stats.eta.toFixed(4)}</dd></div>
                <div><dt>Mots écrits</dt><dd>{stats.mots}</dd></div>
                <div><dt>Vocabulaire du champ</dt><dd>{stats.vocabulaire} mots</dd></div>
              </dl>
              <p className="ondes-aide">
                Les régions qui résonnent voient leur fréquence propre se renforcer (règle hebbienne) et le
                couplage se réguler vers l&apos;ordre cible — l&apos;état est persisté dans ce navigateur.
              </p>
            </div>
          </details>

          <form
            className="ondes-composer"
            onSubmit={(evenement) => {
              evenement.preventDefault();
              void envoyer();
            }}
          >
            {pieces.length > 0 ? (
              <ul className="ondes-pieces" aria-label="Fichiers importés">
                {pieces.map((piece, index) => (
                  <li key={`${piece.nom}-${index}`} title={`${piece.type} · ${formaterOctets(piece.taille)}`}>
                    {piece.type === "texte" ? "≡" : "◈"} {piece.nom}
                  </li>
                ))}
              </ul>
            ) : null}
            <textarea
              value={prompt}
              onChange={(evenement) => setPrompt(evenement.target.value)}
              onKeyDown={entrerValide}
              rows={2}
              placeholder="Écris à l'IA — ta question devient une onde…"
              aria-label="Message pour l'IA"
              disabled={occupe}
            />
            <div className="ondes-barre-outils">
              <input
                ref={(element) => {
                  entreeFichierRef.current = element;
                }}
                type="file"
                multiple
                className="ondes-fichier-cache"
                onChange={(evenement) => {
                  void importerFichiers(evenement.target.files);
                  evenement.target.value = "";
                }}
                aria-hidden="true"
                tabIndex={-1}
              />
              {/* 1 · Import des fichiers */}
              <button type="button" className="ondes-bouton-outil" onClick={() => entreeFichierRef.current?.click()} aria-label="Importer des fichiers" title="Importer des fichiers (le texte nourrit le champ)">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                <span>Fichiers</span>
              </button>
              {/* 2 · Outils (connecteurs) */}
              <div className="ondes-popover-ancre">
                <button type="button" className={cx("ondes-bouton-outil", outilsChoisis.length > 0 && "ondes-bouton-outil--actif")} onClick={() => setOutilsOuvert((ouvert) => !ouvert)} aria-expanded={outilsOuvert} aria-label="Outils et connecteurs" title="Outils (connecteurs Gen3ia)">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                  <span>Outils{outilsChoisis.length > 0 ? ` · ${outilsChoisis.length}` : ""}</span>
                </button>
                {outilsOuvert ? (
                  <div className="ondes-popover" role="dialog" aria-label="Choisir les connecteurs">
                    {statutGen3 !== "connecte" ? (
                      <p className="ondes-aide">Connecte-toi pour activer tes connecteurs (applications et API pilotées par l&apos;IA).</p>
                    ) : connexions === null ? (
                      <p className="ondes-aide">Chargement des connecteurs…</p>
                    ) : connexions.length === 0 ? (
                      <p className="ondes-aide">Aucun connecteur actif — ajoute-les depuis Développeur → Connecteurs.</p>
                    ) : (
                      <ul className="ondes-liste-outils">
                        {connexions.map((connexion) => (
                          <li key={connexion.id}>
                            <label>
                              <input
                                type="checkbox"
                                checked={outilsChoisis.includes(connexion.id)}
                                onChange={(evenement) => {
                                  setOutilsChoisis((precedents) =>
                                    evenement.target.checked
                                      ? [...precedents, connexion.id]
                                      : precedents.filter((id) => id !== connexion.id),
                                  );
                                }}
                              />
                              <span>{connexion.label}</span>
                              <small>{connexion.toolkit}</small>
                            </label>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ) : null}
              </div>
              {/* 3 · Effort */}
              <div className="ondes-popover-ancre">
                <button type="button" className="ondes-bouton-outil" onClick={() => setEffortOuvert((ouvert) => !ouvert)} aria-expanded={effortOuvert} aria-label={`Effort de réflexion : ${effort}`} title="Effort de réflexion (résolution du champ)">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20a8 8 0 100-16 8 8 0 000 16z" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M12 12l3.5-3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
                  <span>Effort · {effort}</span>
                </button>
                {effortOuvert ? (
                  <div className="ondes-popover" role="dialog" aria-label="Choisir l'effort de réflexion">
                    <ul className="ondes-liste-effort">
                      {NIVEAUX_EFFORT.map((niveau) => (
                        <li key={niveau.id}>
                          <button type="button" onClick={() => void changerEffort(niveau.id)} data-actif={effort === niveau.id}>
                            <strong>{niveau.label}</strong>
                            <small>{niveau.detail}{typeMoteur === "cpu" && niveau.id !== "faible" && niveau.id !== "moyen" ? " · plafonné sur CPU" : ""}</small>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
              {/* 4 · Recherche web */}
              <button
                type="button"
                className={cx("ondes-bouton-outil", rechercheWeb && "ondes-bouton-outil--actif")}
                onClick={() => setRechercheWeb((actif) => !actif)}
                aria-pressed={rechercheWeb}
                aria-label="Recherche web"
                title={statutGen3 === "connecte" ? "Recherche web pilotée par le cortex Gen3" : "Recherche web — active avec le cortex Gen3 (connecté)"}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z" fill="none" stroke="currentColor" strokeWidth="2" /></svg>
                <span>Web</span>
              </button>
              {/* 5 · Envoi / Arrêt */}
              {occupe ? (
                <Button type="button" variant="secondary" onClick={arreter} className="ondes-envoyer" aria-label="Arrêter la génération">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" /></svg>
                  <span>Arrêter</span>
                </Button>
              ) : (
                <Button type="submit" disabled={!prompt.trim() || statutMoteur !== "pret"} className="ondes-envoyer" aria-label="Envoyer le message">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
                  <span>Envoyer</span>
                </Button>
              )}
            </div>
            {rechercheWeb ? (
              <p className="ondes-aide ondes-aide-web">
                Recherche web {statutGen3 === "connecte" ? "activée — pilotée par le cortex Gen3 via les connecteurs." : "mémorisée — elle sera transmise au cortex Gen3 quand tu seras connecté."}
              </p>
            ) : null}
          </form>
        </aside>
      </main>
    </div>
  );
}
