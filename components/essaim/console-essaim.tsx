"use client";

/**
 * La Console de l'Essaim d'Agents Décentralisés.
 *
 * Cinq panneaux, un même principe : chaque navigateur est un nœud
 * complet, chaque agent spécialisé est connecté à l'IA principale
 * Gen3, et rien ne passe par un serveur — ni documents (coffre
 * chiffré), ni compétences (ondes exécutables), ni calcul (GPU local
 * + essaim P2P). Ouvrez un deuxième onglet de cette page : les deux
 * nœuds se découvrent, négocient en WebRTC et travaillent ensemble.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { authFetch } from "@/lib/firebase/auth-client";
import { safeClientTimezone, streamConversationTurn } from "@/lib/domain/conversations/stream-client";
import { tenterCompiler } from "@/lib/monde/expression";
import { demarrerEssaim, type EssaimDemarre } from "@/lib/essaim-agents/instance";
import { PasserelleVocale, type EtatPasserelle } from "@/lib/essaim-agents/vocal/passerelle";
import type { MicroAgent } from "@/lib/essaim-agents/types";
import type { DecisionCortex } from "@/lib/essaim-agents/orchestrateur";
import type { EvenementResilience } from "@/lib/essaim-agents/types";
import type { TraceAmplitude } from "@/lib/essaim-agents/resilience/sentinelle";
import type { CompetenceInstallee } from "@/lib/essaim-agents/competences/diffuseur";
import type { ResultatRecherche } from "@/lib/essaim-agents/rag/onde-semantique";

import { ToileEssaim } from "./toile-essaim";
import "./console-essaim.css";

type Onglet = "agents" | "rag" | "competences" | "resilience" | "voix";

const ONGLETS: Array<{ id: Onglet; label: string }> = [
  { id: "agents", label: "Agents & cortex" },
  { id: "rag", label: "RAG privé" },
  { id: "competences", label: "Compétences" },
  { id: "resilience", label: "Résilience" },
  { id: "voix", label: "Voix" },
];

const CODE_EXEMPLE = `function executer(entree, memoire, journal) {
  memoire.appels = (memoire.appels ?? 0) + 1;
  journal("appel n°" + memoire.appels);
  const n = Number(entree?.valeur ?? 0);
  return { double: n * 2, appels: memoire.appels };
}`;

interface EvenementUi {
  heure: string;
  type: string;
  detail: string;
}

interface EntreeCoffre {
  id: string;
  etiquette: string;
  taille: number;
  empreinte: string;
  ts: number;
}

const SNIPPET_CODE = `// Test de l'agent Lecteur de code
function spiral(n) {
  if (n <= 0) return [];
  const out = [];
  for (let i = 0; i < n; i++) out.push(i * i);
  return out; // TODO: vectoriser
}`;

export default function ConsoleEssaim() {
  const essaimRef = useRef<EssaimDemarre | null>(null);
  const passerelleRef = useRef<PasserelleVocale | null>(null);
  const conversationRef = useRef<string | null>(null);

  const [pret, setPret] = useState(false);
  const [onglet, setOnglet] = useState<Onglet>("agents");
  const [evenements, setEvenements] = useState<EvenementUi[]>([]);
  const [erreur, setErreur] = useState("");

  // ——— états pollés (1 s)
  const [stats, setStats] = useState({ tachesOuvres: 0, tachesExecutees: 0, resultatsRecus: 0, comptesRendus: 0, rechutes: 0, noeudsDistant: 0, fileLocale: 0 });
  const [microAgents, setMicroAgents] = useState<MicroAgent[]>([]);
  const [decisions, setDecisions] = useState<DecisionCortex[]>([]);
  const [dernierResume, setDernierResume] = useState("Aucun compte-rendu reçu.");
  const [indexTaille, setIndexTaille] = useState(0);
  const [journalResilience, setJournalResilience] = useState<EvenementResilience[]>([]);
  const [traces, setTraces] = useState<TraceAmplitude[]>([]);
  const [competences, setCompetences] = useState<CompetenceInstallee[]>([]);
  const [enReception, setEnReception] = useState<Array<{ id: string; fragments: number; attendu: number }>>([]);

  // ——— RAG
  const [phraseSecrete, setPhraseSecrete] = useState("");
  const [coffreOuvert, setCoffreOuvert] = useState(false);
  const [etiquette, setEtiquette] = useState("");
  const [documentTexte, setDocumentTexte] = useState("");
  const [entreesCoffre, setEntreesCoffre] = useState<EntreeCoffre[]>([]);
  const [questionRag, setQuestionRag] = useState("");
  const [reponseRag, setReponseRag] = useState<ResultatRecherche | null>(null);
  const [ragOccupe, setRagOccupe] = useState(false);

  // ——— compétences
  const [competenceId, setCompetenceId] = useState("mon-calcul");
  const [competenceNom, setCompetenceNom] = useState("Doubleur");
  const [competenceCode, setCompetenceCode] = useState(CODE_EXEMPLE);
  const [entreeCompetence, setEntreeCompetence] = useState('{"valeur": 21}');
  const [sortieCompetence, setSortieCompetence] = useState("");

  // ——— voix
  const [etatVocal, setEtatVocal] = useState<EtatPasserelle>("inactif");
  const [detailVocal, setDetailVocal] = useState("");
  const [questionVocale, setQuestionVocale] = useState("");
  const [reponseVocale, setReponseVocale] = useState("");

  const pousserEvenement = useCallback((e: { type: string; detail: string }) => {
    setEvenements((prev) =>
      [
        { heure: new Date().toLocaleTimeString("fr-FR"), type: e.type, detail: e.detail },
        ...prev,
      ].slice(0, 40),
    );
  }, []);

  /* ------------------------------- boot --------------------------- */

  useEffect(() => {
    if (essaimRef.current) return;
    const essaim = demarrerEssaim({ surEvenement: pousserEvenement });
    essaimRef.current = essaim;
    setPret(true);
    pousserEvenement({
      type: "demarrage",
      detail: `Nœud ${essaim.idNoeud} en ligne — 5 agents connectés au cortex Gen3.`,
    });

    const minuterie = setInterval(() => {
      const e = essaimRef.current;
      if (!e) return;
      setStats(e.orchestrateur.statistiques);
      setMicroAgents(e.orchestrateur.listeMicroAgents.map((a) => ({ ...a })));
      const etatCortex = e.cortex.etat();
      setDecisions(etatCortex.decisions);
      setDernierResume(etatCortex.dernierResume);
      setIndexTaille(e.index.taille);
      setJournalResilience(e.sentinelle.evenements.slice(0, 24));
      setTraces(e.sentinelle.tracesAmplitude.map((t) => ({ ...t })));
      setCompetences(e.registre.lister().map((c) => ({ ...c, module: { ...c.module } })));
      setEnReception(e.diffuseur.enReception);
      e.diffuseur.purger();
    }, 1000);

    return () => {
      clearInterval(minuterie);
      essaim.arreter();
      essaimRef.current = null;
      setPret(false);
    };
  }, [pousserEvenement]);

  const rafraichir = useCallback(() => {
    const e = essaimRef.current;
    if (!e) return;
    setStats(e.orchestrateur.statistiques);
    setMicroAgents(e.orchestrateur.listeMicroAgents.map((a) => ({ ...a })));
    setDernierResume(e.cortex.etat().dernierResume);
  }, []);

  /* --------------------------- tâches ----------------------------- */

  const ouvrir = useCallback(
    (type: "veille" | "tri" | "calcul" | "code" | "automatisation", charge: Record<string, unknown>) => {
      const essaim = essaimRef.current;
      if (!essaim) return;
      setErreur("");
      try {
        essaim.orchestrateur.ouvrirTache(type, charge, "normale");
        rafraichir();
      } catch (e) {
        setErreur(e instanceof Error ? e.message : "La tâche a échoué.");
      }
    },
    [rafraichir],
  );

  const tacheVeille = useCallback(() => {
    ouvrir("veille", {
      sujet: "flux de veille",
      avant: [
        { cle: "serveur-a", valeur: "v1.4" },
        { cle: "prix-api", valeur: "0.002" },
        { cle: "statut", valeur: "stable" },
      ],
      apres: [
        { cle: "serveur-a", valeur: "v1.6" },
        { cle: "prix-api", valeur: "0.002" },
        { cle: "statut", valeur: "stable" },
        { cle: "nouveau-pair", valeur: "détecté" },
      ],
    });
  }, [ouvrir]);

  const tacheTri = useCallback(() => {
    ouvrir("tri", {
      elements: ["facture janvier", "contrat fournisseur", "paie mars", "devis client", "budget annuel", "facture février"],
      criteres: ["facture", "contrat", "paie", "devis", "budget"],
    });
  }, [ouvrir]);

  const tacheCalcul = useCallback(() => {
    ouvrir("calcul", { expression: "sqrt(144) * (2^8) / 3 + 17" });
  }, [ouvrir]);

  const tacheCode = useCallback(() => {
    ouvrir("code", { code: SNIPPET_CODE, langage: "js" });
  }, [ouvrir]);

  const tacheAutomatisation = useCallback(() => {
    ouvrir("automatisation", {
      etapes: [
        { type: "calcul", charge: { expression: "(8500 - 3200) * 0.19" } },
        { type: "tri", charge: { elements: ["alerte disque", "nouveau pair", "alerte mémoire", "test ok"], criteres: ["alerte", "pair", "test"] } },
        { type: "veille", charge: { sujet: "service essaim", avant: [{ cle: "sante", valeur: "ok" }], apres: [{ cle: "sante", valeur: "ok" }] } },
      ],
    });
  }, [ouvrir]);

  /* ----------------------------- RAG ------------------------------ */

  const deverrouiller = useCallback(async () => {
    const essaim = essaimRef.current;
    if (!essaim || !phraseSecrete.trim()) return;
    setErreur("");
    try {
      await essaim.coffre.deverrouiller(essaim.entrepot, phraseSecrete);
      setCoffreOuvert(true);
      setEntreesCoffre(await essaim.coffre.lister(essaim.entrepot));
      pousserEvenement({ type: "coffre", detail: "Coffre déverrouillé — les documents restent chiffrés sur cet appareil." });
    } catch (e) {
      setErreur(e instanceof Error ? e.message : "Le coffre refuse cette phrase.");
    }
  }, [phraseSecrete, pousserEvenement]);

  const importerDocument = useCallback(async () => {
    const essaim = essaimRef.current;
    if (!essaim || !coffreOuvert) return;
    if (!documentTexte.trim()) {
      setErreur("Document vide : collez un texte à indexer.");
      return;
    }
    setErreur("");
    try {
      const et = etiquette.trim() || "sans étiquette";
      await essaim.coffre.ecrire(essaim.entrepot, documentTexte, et);
      const n = essaim.index.indexer(documentTexte, et);
      setEntreesCoffre(await essaim.coffre.lister(essaim.entrepot));
      setDocumentTexte("");
      setEtiquette("");
      pousserEvenement({
        type: "rag",
        detail: `Document chiffré dans le coffre local et indexé (${n} fragment(s)) — rien n'a quitté cet appareil.`,
      });
    } catch (e) {
      setErreur(e instanceof Error ? e.message : "L'import a échoué.");
    }
  }, [coffreOuvert, documentTexte, etiquette, pousserEvenement]);

  const poserQuestionRag = useCallback(async () => {
    const essaim = essaimRef.current;
    if (!essaim || !questionRag.trim() || ragOccupe) return;
    setRagOccupe(true);
    setErreur("");
    try {
      const resultat = await essaim.ondeSemantique.poserQuestion(questionRag);
      setReponseRag(resultat);
      pousserEvenement({
        type: "rag",
        detail: resultat.vide
          ? `Onde de requête diffusée (${resultat.dureeMs} ms) : aucun fragment au-dessus du seuil — l'essaim reste silencieux (zéro fuite).`
          : `Onde de requête : ${resultat.fragments.length} fragment(s) reçu(s) de ${resultat.respondants} répondant(s) en ${resultat.dureeMs} ms.`,
      });
    } finally {
      setRagOccupe(false);
    }
  }, [questionRag, ragOccupe, pousserEvenement]);

  /* ------------------------- compétences -------------------------- */

  const creerEtDiffuser = useCallback(async () => {
    const essaim = essaimRef.current;
    if (!essaim) return;
    setErreur("");
    try {
      const { creerModule } = await import("@/lib/essaim-agents/competences/module-competence");
      const mod = await creerModule({
        id: competenceId,
        nom: competenceNom,
        description: "Compétence créée dans la console par ce nœud.",
        code: competenceCode,
        emetteur: essaim.idNoeud,
      });
      essaim.registre.installer(mod);
      essaim.diffuseur.diffuser(mod);
      setCompetences(essaim.registre.lister().map((c) => ({ ...c, module: { ...c.module } })));
    } catch (e) {
      setErreur(e instanceof Error ? e.message : "Création impossible.");
    }
  }, [competenceCode, competenceId, competenceNom]);

  const executerCompetenceLocale = useCallback(() => {
    const essaim = essaimRef.current;
    if (!essaim) return;
    setErreur("");
    try {
      const entree = JSON.parse(entreeCompetence || "null");
      const resultat = essaim.registre.executer(competenceId, entree);
      setSortieCompetence(
        resultat.ok
          ? `✓ ${JSON.stringify(resultat.valeur)}\n${resultat.journal.map((l) => `· ${l}`).join("\n")}`
          : `✗ ${resultat.erreur ?? "échec"}`,
      );
    } catch (e) {
      setSortieCompetence(`✗ Entrée JSON invalide : ${e instanceof Error ? e.message : "erreur"}`);
    }
  }, [competenceId, entreeCompetence]);

  /* --------------------------- résilience ------------------------- */

  const simulerRupture = useCallback(() => {
    const essaim = essaimRef.current;
    if (!essaim) return;
    const vivants = essaim.orchestrateur.noeudsConnus.map((n) => n.id);
    if (vivants.length === 0) {
      setErreur(
        "Aucun pair à faire tomber : ouvrez un deuxième onglet de cette page, attendez qu'il apparaisse dans la toile, puis simulez sa rupture.",
      );
      return;
    }
    essaim.sentinelle.simulerRupture(vivants[0]);
    pousserEvenement({
      type: "simulation",
      detail: `Rupture simulée sur ${vivants[0].slice(0, 8)}… — observez le journal : l'onde orpheline est ré-attribuée.`,
    });
  }, [pousserEvenement]);

  /* ------------------------------ voix ---------------------------- */

  const consulterIA = useCallback(async (texte: string): Promise<string> => {
    const essaim = essaimRef.current;
    if (!essaim) throw new Error("Essaim non démarré.");

    // 1) Routage local déterministe : une expression mathématique
    //    passe direct par l'agent calcul (connecté au cortex).
    const expression = tenterCompiler(texte.replace(/^(calcule|résous|combien font?)\s*/i, "").trim());
    if (expression) {
      const tache = essaim.orchestrateur.ouvrirTache("calcul", { expression });
      rafraichir();
      return tache.resultat?.resume ?? "Calcul engagé dans l'essaim…";
    }

    // 2) Cortex Gen3 complet (connecté) — flux NDJSON du chat.
    try {
      let conversationId = conversationRef.current;
      if (!conversationId) {
        const reponse = await authFetch("/api/workspace/conversations", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: `Essaim vocal : ${texte.slice(0, 40)}` }),
        });
        if (reponse.status === 401 || reponse.status === 403) {
          throw new Error("Connexion requise pour le cortex Gen3 complet.");
        }
        if (!reponse.ok) throw new Error("Conversation indisponible.");
        const corps = (await reponse.json()) as { conversation?: { id?: string } };
        conversationId = corps.conversation?.id ?? null;
        if (!conversationId) throw new Error("Conversation indisponible.");
        conversationRef.current = conversationId;
      }
      let complet = "";
      await streamConversationTurn({
        conversationId,
        message: texte,
        timezone: safeClientTimezone(),
        onEvent: (evenement) => {
          if (evenement.type === "message_delta") complet += evenement.delta;
        },
      });
      return complet || "Le cortex n'a rien renvoyé — réessayez.";
    } catch {
      return (
        "En mode local, l'essaim répond aux calculs (« calcule 12*34 ») et aux tâches des agents. " +
        "Connectez-vous pour interroger le cortex Gen3 complet par la voix."
      );
    }
  }, [rafraichir]);

  const basculerMicro = useCallback(async () => {
    let passerelle = passerelleRef.current;
    if (!passerelle) {
      let dernierLog = 0;
      passerelle = new PasserelleVocale({
        consulterIA,
        surOndes: (impulsions, amplitude) => {
          const maintenant = Date.now();
          if (maintenant - dernierLog > 2200) {
            dernierLog = maintenant;
            pousserEvenement({
              type: "voix",
              detail: `${impulsions.length} impulsion(s) vocale(s) propagent des ondes (amplitude ${amplitude.toFixed(2)}).`,
            });
          }
        },
        surEtat: (etat, detail) => {
          setEtatVocal(etat);
          setDetailVocal(detail ?? "");
        },
        surReponse: (texte) => setReponseVocale(texte),
      });
      passerelleRef.current = passerelle;
    }
    if (passerelle.etatActuel === "inactif" || passerelle.etatActuel === "erreur") {
      await passerelle.demarrer();
    } else {
      await passerelle.arreter();
    }
  }, [consulterIA, pousserEvenement]);

  const demanderVoix = useCallback(async () => {
    const passerelle = passerelleRef.current;
    if (!passerelle || !questionVocale.trim()) return;
    try {
      const reponse = await passerelle.converser(questionVocale, { ordreR: 0.35, energie: 0.4 });
      setReponseVocale(reponse);
      setQuestionVocale("");
    } catch (e) {
      setErreur(e instanceof Error ? e.message : "La conversation vocale a échoué.");
    }
  }, [questionVocale]);

  /* ----------------------------- toile ---------------------------- */

  const lireEtatToile = useCallback(() => {
    const essaim = essaimRef.current;
    const rompus = new Set(
      essaim?.sentinelle.tracesAmplitude.filter((t) => t.rompu).map((t) => t.noeud) ?? [],
    );
    return {
      idNoeud: essaim?.idNoeud ?? "…",
      distants:
        essaim?.orchestrateur.noeudsConnus.map((n) => ({
          id: n.id,
          amplitude: n.amplitude,
          specialites: n.specialites.length,
          rompu: rompus.has(n.id),
        })) ?? [],
      agents: essaim?.orchestrateur.specialitesLocales.length ?? 5,
      dernierMessage: Date.now(),
    };
  }, []);

  /* ---------------------------- rendu ----------------------------- */

  return (
    <div className="essaim-console">
      <header className="essaim-entete">
        <div className="essaim-titre">
          <h1>Essaim d&apos;Agents Décentralisés</h1>
          <p>
            Chaque nœud de l&apos;essaim fait tourner des mini-agents spécialisés (veille, tri,
            calcul, code, automatisation) qui communiquent par impulsions d&apos;ondes légères en
            WebRTC direct — et TOUS sont raccordés à l&apos;IA principale Gen3. Zéro frais de
            cloud : le serveur ne fait que la signalisation.
          </p>
        </div>
        <div className="essaim-statut">
          <span className="essaim-puce">nœud <b>{essaimRef.current?.idNoeud.slice(0, 12) ?? "…"}</b></span>
          <span className="essaim-puce">pairs <b>{stats.noeudsDistant}</b></span>
          <span className="essaim-puce">{pret ? "essaim actif" : "démarrage…"}</span>
        </div>
      </header>

      <section className="essaim-stats">
        <div className="essaim-stat"><div className="valeur">{stats.tachesOuvres}</div><div className="etiquette">tâches ouvertes</div></div>
        <div className="essaim-stat"><div className="valeur">{stats.tachesExecutees}</div><div className="etiquette">exécutées localement</div></div>
        <div className="essaim-stat"><div className="valeur">{stats.resultatsRecus}</div><div className="etiquette">résultats reçus</div></div>
        <div className="essaim-stat"><div className="valeur">{stats.comptesRendus}</div><div className="etiquette">comptes-rendus au cortex</div></div>
        <div className="essaim-stat"><div className="valeur">{stats.rechutes}</div><div className="etiquette">ré-attributions</div></div>
        <div className="essaim-stat"><div className="valeur">{competences.length}</div><div className="etiquette">compétences installées</div></div>
      </section>

      <ToileEssaim lireEtat={lireEtatToile} />

      <section className="essaim-actions" aria-label="Actions rapides de l'essaim">
        <button className="bouton-onde" onClick={tacheVeille}>⌖ Lancer une veille</button>
        <button className="bouton-onde" onClick={tacheTri}>▦ Trier et classer</button>
        <button className="bouton-onde" onClick={tacheCalcul}>√ Calculer</button>
        <button className="bouton-onde" onClick={tacheCode}>⌗ Analyser du code</button>
        <button className="bouton-onde" onClick={tacheAutomatisation}>⛓ Chaîner une automatisation</button>
      </section>

      {erreur ? <div className="essaim-message erreur" role="alert">{erreur}</div> : null}

      <nav className="essaim-onglets" aria-label="Panneaux de l'essaim">
        {ONGLETS.map((o) => (
          <button
            key={o.id}
            className={`essaim-onglet${onglet === o.id ? " actif" : ""}`}
            onClick={() => setOnglet(o.id)}
          >
            {o.label}
          </button>
        ))}
      </nav>

      {/* ——————— Panneau AGENTS ——————— */}
      {onglet === "agents" ? (
        <section className="essaim-panneau">
          <h2>Les cinq agents, connectés au cortex Gen3</h2>
          <p className="note">
            Aucun agent ne décide seul : chaque résultat remonte à l&apos;IA principale, qui
            journalise, réfléchit et ordonne les tâches de suivi. Dernier compte-rendu reçu :{" "}
            <em>{dernierResume}</em>
          </p>
          <div className="essaim-grille">
            <ul className="essaim-liste">
              {microAgents.map((agent) => (
                <li key={agent.id} className="essaim-item">
                  <div className="titre">
                    <span>{agent.nom} <span className="badge violet">{agent.type}</span></span>
                    <span className={`badge ${agent.etat === "veille" ? "vert" : agent.etat === "actif" ? "cyan" : "jaune"}`}>
                      {agent.etat}
                    </span>
                  </div>
                  <div className="detail">{agent.description}</div>
                  <div className="detail">
                    traitées : {agent.tachesTraitees} · échecs : {agent.tachesEchouees} · charge : {(agent.charge * 100).toFixed(0)} %
                  </div>
                </li>
              ))}
            </ul>
            <div>
              <h3 style={{ margin: "0 0 8px", fontSize: "0.9rem", color: "#c4b5fd" }}>
                Décisions du cortex Gen3
              </h3>
              <ul className="essaim-liste">
                {decisions.length === 0 ? (
                  <li className="essaim-item detail">Le cortex attend ses premiers comptes-rendus — lancez une tâche.</li>
                ) : (
                  decisions.map((d, i) => (
                    <li key={i} className="essaim-item">
                      <div className="detail">{new Date(d.ts).toLocaleTimeString("fr-FR")} — {d.motif}</div>
                    </li>
                  ))
                )}
              </ul>
            </div>
          </div>
        </section>
      ) : null}

      {/* ——————— Panneau RAG ——————— */}
      {onglet === "rag" ? (
        <section className="essaim-panneau">
          <h2>RAG décentralisé et zéro-connaissance</h2>
          <p className="note">
            Vos documents sont chiffrés dans CE navigateur (AES-GCM 256, clé dérivée PBKDF2) et
            indexés localement. Une recherche diffuse une ONDE de signature hachée : les autres
            nœuds comparent en silence à leur propre index et ne renvoient qu&apos;un extrait —
            jamais leur document, jamais leur index. Le serveur ne voit rien.
          </p>
          <div className="essaim-grille">
            <div className="essaim-champ">
              <label htmlFor="phrase">Phrase secrète du coffre</label>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  id="phrase"
                  type="password"
                  value={phraseSecrete}
                  onChange={(e) => setPhraseSecrete(e.target.value)}
                  placeholder="une phrase que vous seul connaissez"
                />
                <button className="bouton-onde" onClick={() => void deverrouiller()}>
                  {coffreOuvert ? "re-déverrouiller" : "déverrouiller"}
                </button>
              </div>
              <p className="note">
                {coffreOuvert
                  ? `Coffre ouvert — ${entreesCoffre.length} document(s) chiffré(s), ${indexTaille} fragment(s) indexé(s) en mémoire.`
                  : "Le coffre est verrouillé : aucun contenu n'est lisible, même par vous, avant déverrouillage."}
              </p>
            </div>
            <div className="essaim-champ">
              <label htmlFor="etiquette">Étiquette du document</label>
              <input
                id="etiquette"
                value={etiquette}
                onChange={(e) => setEtiquette(e.target.value)}
                placeholder="ex. notes de réunion, devis fournisseurs…"
              />
              <label htmlFor="document" style={{ marginTop: 6 }}>Contenu (collez votre texte)</label>
              <textarea
                id="document"
                value={documentTexte}
                onChange={(e) => setDocumentTexte(e.target.value)}
                placeholder="Le texte est chiffré AVANT stockage, puis indexé localement…"
              />
              <button className="bouton-onde" disabled={!coffreOuvert} onClick={() => void importerDocument()}>
                Chiffrer, stocker et indexer localement
              </button>
            </div>
          </div>

          {entreesCoffre.length > 0 ? (
            <ul className="essaim-liste">
              {entreesCoffre.map((e) => (
                <li key={e.id} className="essaim-item">
                  <div className="titre">
                    <span>{e.etiquette}</span>
                    <span className="badge cyan">{e.taille} car.</span>
                  </div>
                  <div className="detail">empreinte {e.empreinte} · {new Date(e.ts).toLocaleTimeString("fr-FR")}</div>
                </li>
              ))}
            </ul>
          ) : null}

          <div className="essaim-champ">
            <label htmlFor="question">Interroger l&apos;essaim (onde de requête sémantique)</label>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                id="question"
                value={questionRag}
                onChange={(e) => setQuestionRag(e.target.value)}
                placeholder="ex. de quoi parle la réunion ?"
                onKeyDown={(e) => {
                  if (e.key === "Enter") void poserQuestionRag();
                }}
              />
              <button className="bouton-onde" disabled={ragOccupe} onClick={() => void poserQuestionRag()}>
                émettre l&apos;onde
              </button>
            </div>
          </div>

          {reponseRag ? (
            <ul className="essaim-liste">
              {reponseRag.vide ? (
                <li className="essaim-item detail">
                  Aucun fragment au-dessus du seuil — l&apos;essaim s&apos;est tu : personne ne
                  révèle quoi que ce soit, même pas l&apos;existence d&apos;un document proche.
                </li>
              ) : (
                reponseRag.fragments.map((f) => (
                  <li key={f.empreinte} className="essaim-item">
                    <div className="titre">
                      <span>fragment reçu</span>
                      <span className="badge jaune">score {f.score.toFixed(3)}</span>
                    </div>
                    <div className="detail">« {f.extrait} »{f.etiquette ? ` — ${f.etiquette}` : ""}</div>
                  </li>
                ))
              )}
            </ul>
          ) : null}
        </section>
      ) : null}

      {/* ——————— Panneau COMPÉTENCES ——————— */}
      {onglet === "competences" ? (
        <section className="essaim-panneau">
          <h2>Injection de compétences dans l&apos;essaim</h2>
          <p className="note">
            Un module créé ici est validé (plafond 32 Ko, motifs interdits), empreinté SHA-256,
            installé localement puis DIFFUSÉ en paquets d&apos;ondes exécutables : les autres
            nœuds le rassemblent, vérifient son intégrité et l&apos;exécutent dans leur bac à
            sable — les capacités globales augmentent sans mise à jour serveur.
          </p>
          <div className="essaim-grille">
            <div>
              <div className="essaim-champ">
                <label htmlFor="compId">Identifiant</label>
                <input id="compId" value={competenceId} onChange={(e) => setCompetenceId(e.target.value)} />
              </div>
              <div className="essaim-champ" style={{ marginTop: 8 }}>
                <label htmlFor="compNom">Nom</label>
                <input id="compNom" value={competenceNom} onChange={(e) => setCompetenceNom(e.target.value)} />
              </div>
              <div className="essaim-champ" style={{ marginTop: 8 }}>
                <label htmlFor="compCode">Code (fonction executer)</label>
                <textarea id="compCode" value={competenceCode} onChange={(e) => setCompetenceCode(e.target.value)} />
              </div>
              <button className="bouton-onde" style={{ marginTop: 8 }} onClick={() => void creerEtDiffuser()}>
                Installer ici et diffuser en ondes
              </button>
            </div>
            <div>
              <div className="essaim-champ">
                <label htmlFor="compEntree">Entrée JSON d&apos;exécution</label>
                <input id="compEntree" value={entreeCompetence} onChange={(e) => setEntreeCompetence(e.target.value)} />
              </div>
              <button className="bouton-onde" style={{ marginTop: 8 }} onClick={executerCompetenceLocale}>
                Exécuter dans le bac à sable
              </button>
              {sortieCompetence ? (
                <pre className="essaim-journal" style={{ marginTop: 10 }}>{sortieCompetence}</pre>
              ) : null}
            </div>
          </div>

          <ul className="essaim-liste">
            {competences.length === 0 ? (
              <li className="essaim-item detail">Aucune compétence installée — créez la vôtre ou attendez une onde.</li>
            ) : (
              competences.map((c) => (
                <li key={c.module.id} className="essaim-item">
                  <div className="titre">
                    <span>{c.module.nom} <span className="badge violet">{c.module.id}</span></span>
                    <span className="badge cyan">{c.executions} exéc.</span>
                  </div>
                  <div className="detail">
                    empreinte {c.module.empreinte.slice(0, 16)}… · {c.module.code.length} o · émise par {c.module.emetteur.slice(0, 10)}
                  </div>
                </li>
              ))
            )}
            {enReception.map((r) => (
              <li key={r.id} className="essaim-item">
                <div className="titre">
                  <span>réception en cours : {r.id}</span>
                  <span className="badge jaune">{r.fragments}/{r.attendu} fragments</span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* ——————— Panneau RÉSILIENCE ——————— */}
      {onglet === "resilience" ? (
        <section className="essaim-panneau">
          <h2>Auto-réparation par résonance de phase</h2>
          <p className="note">
            Chaque nœud émet une onde de vie dont l&apos;AMPLITUDE porte sa santé. Une chute
            d&apos;amplitude ou un silence signale la rupture : les ondes de calcul orphelines
            sont ré-attribuées à un autre nœud en millisecondes, sans intervention. Ouvrez un
            deuxième onglet pour voir la guérison en direct.
          </p>
          <div className="essaim-actions">
            <button className="bouton-onde danger" onClick={simulerRupture}>
              ⚡ Simuler la rupture d&apos;un pair
            </button>
          </div>
          <div className="essaim-grille">
            <div>
              <h3 style={{ margin: "0 0 8px", fontSize: "0.9rem", color: "#c4b5fd" }}>Journal de résonance</h3>
              <div className="essaim-journal">
                {journalResilience.length === 0 ? (
                  <div className="ligne"><span className="type">calme</span><span>aucune rupture — toutes les ondes sont en phase.</span></div>
                ) : (
                  journalResilience.map((e) => (
                    <div key={e.id} className="ligne">
                      <span className="heure">{new Date(e.ts).toLocaleTimeString("fr-FR")}</span>
                      <span className={`type ${e.type === "rupture" ? "rouge" : e.type === "reattribution" ? "jaune" : "vert"}`}>{e.type}</span>
                      <span>{e.detail}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
            <div>
              <h3 style={{ margin: "0 0 8px", fontSize: "0.9rem", color: "#c4b5fd" }}>Amplitudes observées</h3>
              <ul className="essaim-liste">
                {traces.length === 0 ? (
                  <li className="essaim-item detail">Aucune onde distante observée — le nœud local est le seul de l&apos;essaim.</li>
                ) : (
                  traces.map((t) => (
                    <li key={t.noeud} className="essaim-item">
                      <div className="titre">
                        <span>{t.noeud.slice(0, 12)}</span>
                        <span className={`badge ${t.rompu ? "rouge" : "vert"}`}>{t.rompu ? "hors phase" : "en phase"}</span>
                      </div>
                      <div className="detail">
                        amplitude {(t.amplitudes[t.amplitudes.length - 1] ?? 0).toFixed(2)} ·{" "}
                        {t.amplitudes.slice(-8).map((a) => a.toFixed(1)).join(" · ")}
                      </div>
                    </li>
                  ))
                )}
              </ul>
            </div>
          </div>
        </section>
      ) : null}

      {/* ——————— Panneau VOIX ——————— */}
      {onglet === "voix" ? (
        <section className="essaim-panneau">
          <h2>Passerelle Voice-to-Wave</h2>
          <p className="note">
            Votre voix est captée dans le navigateur, transformée en spectre (FFT locale) puis en
            impulsions d&apos;ondes injectées dans l&apos;essaim. La réponse de l&apos;IA
            principale est prononcée par synthèse LOCALE, avec une prosodie modulée par la
            résonance — aucune API vocale tierce, aucun frais.
          </p>
          <div className="essaim-actions">
            <button className="bouton-onde" onClick={() => void basculerMicro()}>
              {etatVocal === "inactif" || etatVocal === "erreur" ? "🎙 Activer le micro" : "⏹ Libérer le micro"}
            </button>
            <span className="essaim-puce">état <b>{etatVocal}</b></span>
            {detailVocal ? <span className="note">{detailVocal}</span> : null}
          </div>
          <div className="essaim-champ">
            <label htmlFor="vocal">Question parlée (ou tapée) pour l&apos;IA principale</label>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                id="vocal"
                value={questionVocale}
                onChange={(e) => setQuestionVocale(e.target.value)}
                placeholder="ex. calcule sqrt(841) + 59 — ou toute question si connecté"
                onKeyDown={(e) => {
                  if (e.key === "Enter") void demanderVoix();
                }}
              />
              <button className="bouton-onde" onClick={() => void demanderVoix()}>demander</button>
            </div>
          </div>
          {reponseVocale ? <div className="essaim-message">🔊 {reponseVocale}</div> : null}
        </section>
      ) : null}

      <section className="essaim-panneau">
        <h2>Journal de l&apos;essaim</h2>
        <div className="essaim-journal">
          {evenements.length === 0 ? (
            <div className="ligne"><span className="type">—</span><span>en attente d&apos;activité…</span></div>
          ) : (
            evenements.map((e, i) => (
              <div key={i} className="ligne">
                <span className="heure">{e.heure}</span>
                <span className="type">{e.type}</span>
                <span>{e.detail}</span>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
