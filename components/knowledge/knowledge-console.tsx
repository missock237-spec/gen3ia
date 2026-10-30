"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { authFetch, readJsonSafely, useSessionAvailable } from "@/lib/firebase/auth-client";
import { SectionHeader } from "@/components/shells/section-header";
import { EmptyState, LoadingState } from "@/components/shells/states";

/**
 * Connaissances — espace Knowledge Spaces (LOT 6 du plan plateforme).
 *
 * La bibliothèque RAG du projet : liste des documents indexés, import de
 * fichiers réels (TXT/MD/CSV/JSON/HTML/DOCX — extraction, chunking et
 * miroir Qdrant côté serveur) et ajout d'une page web (garde SSRF
 * serveur). Les documents sont scopés par projet : l'outil
 * `knowledge.search` de l'agent ne retrouve que les documents du projet
 * courant (isolation stricte).
 *
 * it.50 — le même espace héberge les deux autres volets du LOT 6 :
 *  · DÉCLENCHEURS d'ingestion (concept post-SaaS #9) : une règle (tout
 *    document / nom de fichier contenant… / type MIME commençant…) enfile
 *    une mission RÉELLE pour un agent actif du Studio quand un document
 *    est ingéré — GET/POST /api/knowledge/triggers, PATCH/DELETE
 *    /api/knowledge/triggers/[id] (activer, mettre en pause, supprimer) ;
 *  · COMPÉTENCES : bibliothèque (GET /api/skills — système + privées
 *    actives), Skill Factory LOCALE déterministe (POST /api/skills/create,
 *    aucun service externe) et import idempotent du catalogue ouvert
 *    skills.sh (POST /api/skills/import).
 *
 * Conventions du fichier : authFetch same-origin (cookie gen3ia_session),
 * états honnêtes (401 connexion, 429 patientez, échec réseau affiché),
 * onglets chargés À LA DEMANDE (zéro requête au montage inutile).
 */

interface TrainingProject {
  id: string;
  name: string;
  family: string;
  updatedAt: string;
}

interface KnowledgeDocument {
  id: string;
  projectId: string;
  name: string;
  mimeType: string;
  source: "upload" | "url";
  charCount: number;
  chunkCount: number;
  status: "indexed" | "empty";
  createdAt: string;
}

interface ResultatImport {
  name: string;
  status: "indexed" | "empty" | "failed";
  documentId?: string;
  chunkCount?: number;
  error?: string;
}

interface AgentSummary {
  id: string;
  name: string;
  status: string;
}

interface KnowledgeTrigger {
  id: string;
  name: string;
  match: { kind: "any" | "filename_contains" | "mime_type"; pattern?: string };
  action: { type: string; agentId: string; objectiveTemplate: string };
  enabled: boolean;
  createdAtMs: number;
}

interface SkillItem {
  id: string;
  name: string;
  description: string;
  version: number;
  category: string;
  capabilities: Array<{ name: string; description: string }>;
  requiredTools: string[];
  triggers: string[];
  status: string;
  visibility: string;
  updatedAt: string;
}

interface ResultatCatalogue {
  id: string;
  name: string;
  version: number;
  skipped: boolean;
}

type TabId = "documents" | "declencheurs" | "competences";

const TABS: Array<{ id: TabId; label: string }> = [
  { id: "documents", label: "Documents" },
  { id: "declencheurs", label: "Déclencheurs" },
  { id: "competences", label: "Compétences" },
];

const formatDateFr = (iso?: string | null): string => {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("fr-FR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
};

function Badge({ label, className }: { label: string; className?: string }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${className ?? "bg-[var(--g3-elevated)] text-[var(--g3-muted)]"}`}>
      {label}
    </span>
  );
}

export function KnowledgeConsole() {
  const sessionDisponible = useSessionAvailable();

  const [projects, setProjects] = useState<TrainingProject[]>([]);
  const [selectedProject, setSelectedProject] = useState<string>("");
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Import fichiers + URL
  const [files, setFiles] = useState<FileList | null>(null);
  const [url, setUrl] = useState("");
  const [results, setResults] = useState<ResultatImport[] | null>(null);
  const fichierRef = useRef<HTMLInputElement | null>(null);

  // Onglets + volet déclencheurs (chargé À LA DEMANDE à l'entrée de l'onglet)
  const [tab, setTab] = useState<TabId>("documents");
  const [triggers, setTriggers] = useState<KnowledgeTrigger[]>([]);
  const [triggersLoaded, setTriggersLoaded] = useState(false);
  const [triggersError, setTriggersError] = useState<string | null>(null);
  const [triggerNom, setTriggerNom] = useState("");
  const [triggerKind, setTriggerKind] = useState<"any" | "filename_contains" | "mime_type">("any");
  const [triggerMotif, setTriggerMotif] = useState("");
  const [triggerAgent, setTriggerAgent] = useState("");
  const [triggerObjectif, setTriggerObjectif] = useState("");
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [agentsError, setAgentsError] = useState<string | null>(null);

  // Volet compétences (chargé À LA DEMANDE à l'entrée de l'onglet)
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [skillsLoaded, setSkillsLoaded] = useState(false);
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const [skillObjectif, setSkillObjectif] = useState("");
  const [skillType, setSkillType] = useState("automation");
  const [skillCapacites, setSkillCapacites] = useState("");
  const [skillOutils, setSkillOutils] = useState("");
  const [skillSortie, setSkillSortie] = useState("");
  const [catalogue, setCatalogue] = useState<{ total: number; created: number; items: ResultatCatalogue[] } | null>(null);
  const [catalogueBusy, setCatalogueBusy] = useState(false);

  const chargerProjets = useCallback(async () => {
    setLoadError(null);
    try {
      const response = await authFetch("/api/training/projects", { cache: "no-store" });
      if (response.ok) {
        const data = await readJsonSafely<{ projects?: TrainingProject[] }>(response);
        const list = data?.projects ?? [];
        setProjects(list);
        setSelectedProject((current) => current || list[0]?.id || "");
      } else if (response.status !== 401) {
        setLoadError("Impossible de charger vos projets.");
      }
    } catch {
      setLoadError("Connexion au serveur impossible. Vérifiez votre réseau puis réessayez.");
    } finally {
      setLoaded(true);
    }
  }, []);

  const chargerDocuments = useCallback(async (projectId: string) => {
    if (!projectId) { setDocuments([]); return; }
    setBusy(true);
    try {
      const response = await authFetch(`/api/knowledge?projectId=${projectId}`, { cache: "no-store" });
      if (response.status === 401) {
        setActionError("Connectez-vous pour gérer vos connaissances.");
        return;
      }
      if (response.ok) {
        const data = await readJsonSafely<{ documents?: KnowledgeDocument[] }>(response);
        setDocuments(data?.documents ?? []);
      } else if (response.status !== 401) {
        setActionError("Impossible de charger les documents de ce projet.");
      }
    } catch {
      setActionError("Connexion au serveur impossible. Réessayez.");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (sessionDisponible === false) return;
    void chargerProjets();
  }, [sessionDisponible, chargerProjets]);

  // Liens profonds (#declencheurs, #competences) : ouvrent directement
  // l'onglet demandé (même pattern que la console Automations).
  useEffect(() => {
    const appliquer = () => {
      const hash = window.location.hash.replace("#", "") as TabId;
      if (TABS.some((item) => item.id === hash)) setTab(hash);
    };
    appliquer();
    window.addEventListener("hashchange", appliquer);
    return () => window.removeEventListener("hashchange", appliquer);
  }, []);

  useEffect(() => {
    if (selectedProject) void chargerDocuments(selectedProject);
  }, [selectedProject, chargerDocuments]);

  /* Ingestion RAG réelle — POST /api/knowledge (multipart) : extraction,
   * chunking et indexation côté serveur, résultats par fichier restitués
   * tels quels (indexed / empty / failed). À la demande : le rate-limit
   * 30/h de la porte reste disponible. */
  const importerFichiers = async () => {
    if (!selectedProject || !files || files.length === 0 || busy) return;
    setBusy(true);
    setActionError(null);
    setNotice(null);
    setResults(null);
    try {
      const form = new FormData();
      form.append("projectId", selectedProject);
      Array.from(files).slice(0, 10).forEach((file) => form.append("files", file));
      const response = await authFetch("/api/knowledge", { method: "POST", body: form }, { timeoutMs: 180_000 });
      const data = await readJsonSafely<{ results?: ResultatImport[]; error?: string }>(response);
      if (response.status === 401) {
        setActionError("Connectez-vous pour gérer vos connaissances.");
        return;
      }
      if (response.status === 429) {
        setActionError(data?.error ?? "Trop de téléversements. Réessayez dans un instant.");
        return;
      }
      if (!response.ok || !data?.results) {
        throw new Error(data?.error ?? `L'import a échoué (erreur ${response.status}).`);
      }
      setResults(data.results);
      setFiles(null);
      if (fichierRef.current) fichierRef.current.value = "";
      const indexes = data.results.filter((resultat) => resultat.status === "indexed").length;
      setNotice(`${indexes} document${indexes > 1 ? "s" : ""} indexé${indexes > 1 ? "s" : ""} sur ${data.results.length} — l'agent y accède via l'outil knowledge.search du projet.`);
      await chargerDocuments(selectedProject);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "L'import des documents a échoué.");
    } finally {
      setBusy(false);
    }
  };

  /* Ingestion par URL — POST /api/knowledge (JSON) : la page est
   * téléchargée côté serveur (garde SSRF) puis convertie en texte. */
  const importerUrl = async () => {
    if (!selectedProject || !url.trim() || busy) return;
    setBusy(true);
    setActionError(null);
    setNotice(null);
    setResults(null);
    try {
      const response = await authFetch("/api/knowledge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: url.trim(), projectId: selectedProject }),
      });
      const data = await readJsonSafely<{ document?: KnowledgeDocument; error?: string }>(response);
      if (response.status === 401) {
        setActionError("Connectez-vous pour gérer vos connaissances.");
        return;
      }
      if (response.status === 429) {
        setActionError(data?.error ?? "Trop de téléversements. Réessayez dans un instant.");
        return;
      }
      if (!response.ok || !data?.document) {
        throw new Error(data?.error ?? `L'ajout de la page a échoué (erreur ${response.status}).`);
      }
      setNotice(`Page « ${data.document.name} » extraite et indexée : ${data.document.chunkCount} fragment${data.document.chunkCount > 1 ? "s" : ""} ajouté${data.document.chunkCount > 1 ? "s" : ""} à la base du projet.`);
      setUrl("");
      await chargerDocuments(selectedProject);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "L'ajout de la page a échoué.");
    } finally {
      setBusy(false);
    }
  };

  const supprimerDocument = async (id: string) => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const response = await authFetch(`/api/knowledge?id=${id}`, { method: "DELETE" });
      if (response.status === 401) {
        setActionError("Connectez-vous pour gérer vos connaissances.");
        return;
      }
      if (!response.ok) {
        const data = await readJsonSafely<{ error?: string }>(response);
        throw new Error(data?.error ?? `La suppression a échoué (erreur ${response.status}).`);
      }
      setNotice("Document supprimé : fragments et miroir vectoriel retirés.");
      await chargerDocuments(selectedProject);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "La suppression a échoué.");
    } finally {
      setBusy(false);
    }
  };

  /* DÉCLENCHEURS D'INGESTION (concept post-SaaS #9) — GET/POST
   * /api/knowledge/triggers, PATCH/DELETE /api/knowledge/triggers/[id] :
   * une règle de correspondance enfile une mission RÉELLE (file d'attente
   * serveur) pour un agent actif du Studio quand un document est ingéré.
   * L'agent cible est validé côté serveur (réel, actif, accessible) —
   * un agentId inventé obtient le 422 du serveur, restitué tel quel. */
  const chargerAgents = useCallback(async () => {
    setAgentsError(null);
    try {
      const response = await authFetch("/api/agents", { cache: "no-store" });
      if (response.ok) {
        const data = await readJsonSafely<{ agents?: AgentSummary[] }>(response);
        setAgents(data?.agents ?? []);
      } else if (response.status === 401) {
        setAgentsError("Connectez-vous pour retrouver vos agents.");
      } else {
        setAgentsError("Impossible de charger vos agents.");
      }
    } catch {
      setAgentsError("Connexion au serveur impossible. Réessayez.");
    }
  }, []);

  const chargerTriggers = useCallback(async () => {
    setTriggersError(null);
    try {
      const response = await authFetch("/api/knowledge/triggers", { cache: "no-store" });
      if (response.status === 401) {
        setTriggersError("Connectez-vous pour gérer vos connaissances.");
        return;
      }
      if (response.ok) {
        const data = await readJsonSafely<{ triggers?: KnowledgeTrigger[] }>(response);
        setTriggers(data?.triggers ?? []);
      } else {
        setTriggersError("Impossible de charger vos déclencheurs.");
      }
    } catch {
      setTriggersError("Connexion au serveur impossible. Réessayez.");
    } finally {
      setTriggersLoaded(true);
    }
  }, []);

  const creerTrigger = async () => {
    if (busy || !triggerNom.trim() || !triggerAgent || triggerObjectif.trim().length < 3) return;
    if (triggerKind !== "any" && !triggerMotif.trim()) return;
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const response = await authFetch("/api/knowledge/triggers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: triggerNom.trim(),
          match: { kind: triggerKind, ...(triggerKind === "any" ? {} : { pattern: triggerMotif.trim() }) },
          action: { type: "run_agent_mission", agentId: triggerAgent, objectiveTemplate: triggerObjectif.trim() },
          enabled: true,
        }),
      });
      const data = await readJsonSafely<{ trigger?: KnowledgeTrigger; error?: string }>(response);
      if (response.status === 401) {
        setActionError("Connectez-vous pour gérer vos connaissances.");
        return;
      }
      if (!response.ok || !data?.trigger) {
        throw new Error(data?.error ?? `La création a échoué (erreur ${response.status}).`);
      }
      const cree = data.trigger;
      setTriggers((prev) => [cree, ...prev]);
      setTriggerNom("");
      setTriggerMotif("");
      setTriggerObjectif("");
      setNotice(`Déclencheur « ${cree.name} » créé : le prochain document correspondant enfilera une mission pour l'agent.`);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "La création du déclencheur a échoué.");
    } finally {
      setBusy(false);
    }
  };

  const basculerTrigger = async (trigger: KnowledgeTrigger) => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const response = await authFetch(`/api/knowledge/triggers/${trigger.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: !trigger.enabled }),
      });
      const data = await readJsonSafely<{ trigger?: KnowledgeTrigger; error?: string }>(response);
      if (response.status === 401) {
        setActionError("Connectez-vous pour gérer vos connaissances.");
        return;
      }
      if (!response.ok || !data?.trigger) {
        throw new Error(data?.error ?? `La mise à jour a échoué (erreur ${response.status}).`);
      }
      const maj = data.trigger;
      setTriggers((prev) => prev.map((item) => (item.id === trigger.id ? maj : item)));
      setNotice(maj.enabled ? `Déclencheur « ${maj.name} » activé.` : `Déclencheur « ${maj.name} » mis en pause : les documents correspondants ne lanceront plus de mission.`);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "La mise à jour du déclencheur a échoué.");
    } finally {
      setBusy(false);
    }
  };

  const supprimerTrigger = async (id: string) => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const response = await authFetch(`/api/knowledge/triggers/${id}`, { method: "DELETE" });
      if (response.status === 401) {
        setActionError("Connectez-vous pour gérer vos connaissances.");
        return;
      }
      if (!response.ok) {
        const data = await readJsonSafely<{ error?: string }>(response);
        throw new Error(data?.error ?? `La suppression a échoué (erreur ${response.status}).`);
      }
      setTriggers((prev) => prev.filter((item) => item.id !== id));
      setNotice("Déclencheur supprimé : les futurs documents ne lanceront plus cette mission.");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "La suppression a échoué.");
    } finally {
      setBusy(false);
    }
  };

  /* COMPÉTENCES — GET /api/skills (bibliothèque : compétences système +
   * privées du compte, statut actif), POST /api/skills/create (Skill
   * Factory LOCALE déterministe — aucun service externe, la spécification
   * est construite depuis la requête elle-même), POST /api/skills/import
   * (catalogue ouvert skills.sh — idempotent, re-importer une compétence
   * inchangée n'écrit rien ; l'import peut prendre une minute). */
  const chargerSkills = useCallback(async () => {
    setSkillsError(null);
    try {
      const response = await authFetch("/api/skills?status=active", { cache: "no-store" });
      if (response.status === 401) {
        setSkillsError("Connectez-vous pour gérer vos compétences.");
        return;
      }
      if (response.ok) {
        const data = await readJsonSafely<{ skills?: SkillItem[] }>(response);
        setSkills(data?.skills ?? []);
      } else {
        setSkillsError("Impossible de charger la bibliothèque de compétences.");
      }
    } catch {
      setSkillsError("Connexion au serveur impossible. Réessayez.");
    } finally {
      setSkillsLoaded(true);
    }
  }, []);

  const creerSkill = async () => {
    if (busy || skillObjectif.trim().length < 10) return;
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const response = await authFetch("/api/skills/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          objective: skillObjectif.trim(),
          taskType: skillType,
          requiredCapabilities: skillCapacites.split(",").map((item) => item.trim()).filter(Boolean),
          requiredTools: skillOutils.split(",").map((item) => item.trim()).filter(Boolean),
          constraints: [],
          ...(skillSortie.trim() ? { expectedOutput: skillSortie.trim() } : {}),
        }),
      });
      const data = await readJsonSafely<{ skill?: SkillItem; error?: string }>(response);
      if (response.status === 401) {
        setActionError("Connectez-vous pour gérer vos compétences.");
        return;
      }
      if (response.status === 429) {
        setActionError(data?.error ?? "Trop de créations rapprochées. Réessayez dans quelques instants.");
        return;
      }
      if (!response.ok || !data?.skill) {
        throw new Error(data?.error ?? `La génération a échoué (erreur ${response.status}).`);
      }
      setNotice(`Compétence « ${data.skill.name} » créée (v${data.skill.version}) : elle rejoint la bibliothèque du compte et devient sélectionnable par le planificateur.`);
      setSkillObjectif("");
      setSkillSortie("");
      await chargerSkills();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "La génération de la compétence a échoué.");
    } finally {
      setBusy(false);
    }
  };

  const importerCatalogue = async () => {
    if (catalogueBusy) return;
    setCatalogueBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const response = await authFetch("/api/skills/import", { method: "POST" }, { timeoutMs: 120_000 });
      const data = await readJsonSafely<{ ok?: boolean; total?: number; created?: number; skills?: ResultatCatalogue[]; error?: string }>(response);
      if (response.status === 401) {
        setActionError("Connectez-vous pour importer le catalogue.");
        return;
      }
      if (!response.ok || !data?.ok) {
        throw new Error(data?.error ?? `L'import du catalogue a échoué (erreur ${response.status}).`);
      }
      const items = data.skills ?? [];
      setCatalogue({ total: data.total ?? items.length, created: data.created ?? 0, items });
      if ((data.created ?? 0) > 0) await chargerSkills();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "L'import du catalogue a échoué.");
    } finally {
      setCatalogueBusy(false);
    }
  };

  // Chargement À LA DEMANDE : chaque onglet secondaire interroge ses portes
  // à l'entrée (et à chaque re-visite — liste toujours fraîche). Zéro
  // requête au montage pour les volets non visités.
  useEffect(() => {
    if (sessionDisponible === false) return;
    if (tab === "declencheurs") {
      void chargerTriggers();
      void chargerAgents();
    }
    if (tab === "competences") {
      void chargerSkills();
    }
  }, [tab, sessionDisponible, chargerTriggers, chargerSkills, chargerAgents]);

  const projetActif = projects.find((project) => project.id === selectedProject);

  return (
    <main className="mx-auto w-full max-w-6xl px-4 pb-20 pt-6 sm:px-6">
      <SectionHeader
        eyebrow="GEN3IA · CONNAISSANCES"
        title="Espace"
        highlight="connaissances"
        description="La bibliothèque RAG de vos projets : importez des documents réels (fichiers ou pages web), ils sont extraits, découpés et indexés — l'agent les retrouve via l'outil knowledge.search du projet courant."
      />

      {notice && (
        <p className="mb-4 rounded-2xl border border-[var(--g3-success-soft)] bg-[var(--g3-success-soft)] px-4 py-3 text-sm text-[var(--g3-success-strong)]" role="status">
          {notice}
        </p>
      )}
      {actionError && (
        <div className="mb-4 rounded-2xl border border-[var(--g3-danger-soft)] bg-[var(--g3-danger-soft)] px-4 py-3 text-sm text-[var(--g3-danger-strong)]" role="alert">
          {actionError}
          <button type="button" onClick={() => selectedProject ? void chargerDocuments(selectedProject) : void chargerProjets()} className="ml-3 underline underline-offset-2">
            Réessayer
          </button>
        </div>
      )}

      {sessionDisponible === false ? (
        <EmptyState
          icon="❑"
          title="Connectez-vous pour gérer vos connaissances"
          description="Vos documents restent privés : ils sont scopés par compte ET par projet, et seuls les agents du projet peuvent les consulter."
          action={
            <a href="/login" className="inline-flex min-h-11 items-center rounded-full bg-[var(--g3-primary)] px-6 py-2.5 text-sm font-semibold text-white">
              Se connecter
            </a>
          }
        />
      ) : !loaded ? (
        <LoadingState label="Chargement de l'espace connaissances…" rows={3} />
      ) : loadError && projects.length === 0 ? (
        <EmptyState
          icon="⚠"
          title="Projets indisponibles"
          description={loadError}
          action={
            <button type="button" onClick={() => void chargerProjets()} className="inline-flex min-h-11 items-center rounded-full border border-[var(--g3-border)] px-5 py-2.5 text-sm font-semibold">
              Réessayer
            </button>
          }
        />
      ) : projects.length === 0 ? (
        <EmptyState
          icon="❑"
          title="Aucun projet d'entraînement"
          description="La base de connaissances se rattache à un projet : créez d'abord votre projet dans le Laboratoire de modèles."
          action={
            <a href="/lab" className="inline-flex min-h-11 items-center rounded-full bg-[var(--g3-primary)] px-6 py-2.5 text-sm font-semibold text-white">
              Ouvrir le Laboratoire →
            </a>
          }
        />
      ) : (
        <div className="space-y-5">
          {/* Onglets de l'espace (documents / déclencheurs / compétences) —
              les volets secondaires chargent leurs portes À LA DEMANDE. */}
          <nav className="flex flex-wrap gap-2" aria-label="Sections de l'espace connaissances">
            {TABS.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id)}
                aria-current={tab === item.id ? "page" : undefined}
                className={`inline-flex min-h-11 items-center rounded-full border px-5 py-2.5 text-sm font-semibold transition ${tab === item.id ? "border-[var(--g3-primary-border)] bg-[var(--g3-primary-soft)] text-[var(--g3-primary-strong)]" : "border-[var(--g3-border)] text-[var(--g3-muted)] enabled:hover:border-[var(--g3-primary-border)]"}`}
              >
                {item.label}
              </button>
            ))}
          </nav>

          {tab === "documents" && (
            <>
          {/* Sélecteur de projet */}
          <section className="rounded-3xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-5">
            <label className="text-sm font-medium text-[var(--g3-text-secondary)]">
              Projet
              <select
                value={selectedProject}
                onChange={(event) => setSelectedProject(event.target.value)}
                className="mt-1.5 w-full min-h-11 rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] px-3.5 py-2.5 text-sm text-[var(--g3-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--g3-primary)] sm:max-w-md"
              >
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>{project.name}</option>
                ))}
              </select>
            </label>
            {projetActif && (
              <p className="mt-2 text-xs text-[var(--g3-faint)]">
                {documents.length} document{documents.length > 1 ? "s" : ""} indexé{documents.length > 1 ? "s" : ""} pour ce projet · l&apos;outil knowledge.search de l&apos;agent les consulte pendant les conversations.
              </p>
            )}
          </section>

          {/* Import fichiers */}
          <section className="rounded-3xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-5">
            <h3 className="font-semibold text-[var(--g3-text)]">Importer des documents</h3>
            <p className="mt-1.5 text-sm text-[var(--g3-muted)]">
              Formats acceptés : txt, md, csv, json, html, docx. L&apos;extraction du texte, le découpage en fragments et l&apos;indexation vectorielle sont réellement effectués côté serveur.
            </p>
            <form
              className="mt-4 grid gap-4 sm:grid-cols-[1fr_auto]"
              onSubmit={(event) => { event.preventDefault(); void importerFichiers(); }}
            >
              <label className="text-sm font-medium text-[var(--g3-text-secondary)]">
                Fichiers (10 maximum par lot)
                <input
                  ref={fichierRef}
                  type="file"
                  multiple
                  accept=".txt,.md,.csv,.json,.html,.docx"
                  onChange={(event) => setFiles(event.target.files)}
                  className="mt-1.5 w-full rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] px-3 py-2.5 text-sm text-[var(--g3-text)] file:mr-3 file:rounded-full file:border-0 file:bg-[var(--g3-primary-soft)] file:px-3.5 file:py-1.5 file:text-xs file:font-semibold file:text-[var(--g3-primary-strong)]"
                />
              </label>
              <div className="flex items-end">
                <button
                  type="submit"
                  disabled={busy || !files || files.length === 0}
                  className="inline-flex min-h-11 w-full items-center justify-center rounded-full bg-[var(--g3-primary)] px-6 py-2.5 text-sm font-semibold text-white transition enabled:hover:brightness-110 disabled:opacity-50 sm:w-auto"
                >
                  {busy ? "Import…" : "Importer et indexer"}
                </button>
              </div>
            </form>

            {results && results.length > 0 && (
              <ul className="mt-3 space-y-1 text-xs">
                {results.map((resultat, index) => (
                  <li key={index} className={resultat.status === "failed" ? "text-[var(--g3-danger-strong)]" : "text-[var(--g3-muted)]"}>
                    {resultat.status === "indexed"
                      ? `✓ ${resultat.name} — indexé · ${resultat.chunkCount ?? "?"} fragment${resultat.chunkCount === 1 ? "" : "s"}`
                      : resultat.status === "empty"
                        ? `○ ${resultat.name} — vide (aucun texte extrait)`
                        : `✕ ${resultat.name} — échec : ${resultat.error ?? "ingestion impossible"}`}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Import par URL */}
          <section className="rounded-3xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-5">
            <h3 className="font-semibold text-[var(--g3-text)]">Ajouter une page web</h3>
            <p className="mt-1.5 text-sm text-[var(--g3-muted)]">
              La page est téléchargée puis convertie en texte côté serveur (protection SSRF) — seule la page fournie est consultée, jamais de navigation automatique.
            </p>
            <form
              className="mt-4 grid gap-4 sm:grid-cols-[1fr_auto]"
              onSubmit={(event) => { event.preventDefault(); void importerUrl(); }}
            >
              <label className="text-sm font-medium text-[var(--g3-text-secondary)]">
                Adresse de la page
                <input
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder="adresse complète de la page à indexer"
                  maxLength={2000}
                  className="mt-1.5 w-full min-h-11 rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] px-3.5 py-2.5 text-sm text-[var(--g3-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--g3-primary)]"
                />
              </label>
              <div className="flex items-end">
                <button
                  type="submit"
                  disabled={busy || !url.trim()}
                  className="inline-flex min-h-11 w-full items-center justify-center rounded-full border border-[var(--g3-border)] px-6 py-2.5 text-sm font-semibold transition enabled:hover:border-[var(--g3-primary-border)] disabled:opacity-50 sm:w-auto"
                >
                  {busy ? "Extraction…" : "Extraire et indexer"}
                </button>
              </div>
            </form>
          </section>

          {/* Liste des documents */}
          <section className="rounded-3xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-5">
            <h3 className="font-semibold text-[var(--g3-text)]">Documents du projet{projetActif ? ` : ${projetActif.name}` : ""}</h3>
            {busy && documents.length === 0 ? (
              <LoadingState label="Chargement des documents…" rows={2} />
            ) : documents.length === 0 ? (
              <p className="mt-3 text-sm text-[var(--g3-muted)]">Aucun document pour ce projet : importez un fichier ou ajoutez une page web pour alimenter l&apos;agent.</p>
            ) : (
              <ul className="mt-3 space-y-3">
                {documents.map((doc) => (
                  <li key={doc.id} className="rounded-2xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="min-w-0 truncate font-semibold text-[var(--g3-text)]">{doc.name}</span>
                      <span className="flex flex-wrap items-center gap-2">
                        <Badge label={doc.source === "url" ? "Page web" : "Fichier"} />
                        <Badge
                          label={doc.status === "indexed" ? "Indexé" : "Vide"}
                          className={doc.status === "indexed" ? "bg-[var(--g3-success-soft)] text-[var(--g3-success-strong)]" : "bg-[var(--g3-warning-soft)] text-[var(--g3-warning-strong)]"}
                        />
                        <button
                          type="button"
                          onClick={() => void supprimerDocument(doc.id)}
                          disabled={busy}
                          className="inline-flex min-h-9 items-center rounded-full border border-[var(--g3-border)] px-4 py-1.5 text-xs font-semibold transition enabled:hover:border-[var(--g3-danger-soft)] disabled:opacity-50"
                        >
                          Supprimer
                        </button>
                      </span>
                    </div>
                    <p className="mt-2 text-xs text-[var(--g3-muted)]">
                      {doc.mimeType} · {doc.charCount} caractères · {doc.chunkCount} fragment{doc.chunkCount > 1 ? "s" : ""}
                      {` · ajouté ${formatDateFr(doc.createdAt)}`}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>
            </>
          )}

          {tab === "declencheurs" && (
            <>
              <section className="rounded-3xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-5">
                <h3 className="font-semibold text-[var(--g3-text)]">Déclencheurs d&apos;ingestion</h3>
                <p className="mt-1.5 text-sm text-[var(--g3-muted)]">
                  Le réel qui entre dans la base de connaissances peut lancer une mission d&apos;agent : quand un document importé correspond à une règle active, une mission réelle est enfilée pour l&apos;agent cible (planificateur universel, outils, livrables). Une panne de déclencheur n&apos;invalide jamais l&apos;ingestion — chaque tentative est journalisée par document côté serveur.
                </p>
                {triggersError && (
                  <p className="mt-3 rounded-2xl border border-[var(--g3-danger-soft)] bg-[var(--g3-danger-soft)] px-4 py-3 text-sm text-[var(--g3-danger-strong)]" role="alert">
                    {triggersError}
                  </p>
                )}
                {!triggersLoaded ? (
                  <LoadingState label="Chargement des déclencheurs…" rows={2} />
                ) : triggers.length === 0 ? (
                  <p className="mt-3 text-sm text-[var(--g3-muted)]">Aucun déclencheur pour l&apos;instant : créez une règle ci-dessous pour automatiser le traitement des documents entrants.</p>
                ) : (
                  <ul className="mt-3 space-y-3">
                    {triggers.map((trigger) => (
                      <li key={trigger.id} className="rounded-2xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] p-4">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="min-w-0 truncate font-semibold text-[var(--g3-text)]">{trigger.name}</span>
                          <span className="flex flex-wrap items-center gap-2">
                            <Badge
                              label={trigger.enabled ? "Actif" : "En pause"}
                              className={trigger.enabled ? "bg-[var(--g3-success-soft)] text-[var(--g3-success-strong)]" : undefined}
                            />
                            <button
                              type="button"
                              onClick={() => void basculerTrigger(trigger)}
                              disabled={busy}
                              className="inline-flex min-h-9 items-center rounded-full border border-[var(--g3-border)] px-4 py-1.5 text-xs font-semibold transition enabled:hover:border-[var(--g3-primary-border)] disabled:opacity-50"
                            >
                              {trigger.enabled ? "Mettre en pause" : "Activer"}
                            </button>
                            <button
                              type="button"
                              onClick={() => void supprimerTrigger(trigger.id)}
                              disabled={busy}
                              className="inline-flex min-h-9 items-center rounded-full border border-[var(--g3-border)] px-4 py-1.5 text-xs font-semibold transition enabled:hover:border-[var(--g3-danger-soft)] disabled:opacity-50"
                            >
                              Supprimer
                            </button>
                          </span>
                        </div>
                        <p className="mt-2 text-xs text-[var(--g3-muted)]">
                          {trigger.match.kind === "any"
                            ? "Correspondance : tout document importé"
                            : trigger.match.kind === "filename_contains"
                              ? `Correspondance : nom de fichier contenant « ${trigger.match.pattern ?? ""} »`
                              : `Correspondance : type MIME commençant par « ${trigger.match.pattern ?? ""} »`}
                          {` · mission pour l'agent ${trigger.action.agentId}`}
                          {` · créé ${formatDateFr(new Date(trigger.createdAtMs).toISOString())}`}
                        </p>
                        <p className="mt-1 break-words font-mono text-xs text-[var(--g3-faint)]">{trigger.action.objectiveTemplate}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="rounded-3xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-5">
                <h3 className="font-semibold text-[var(--g3-text)]">Créer un déclencheur</h3>
                <p className="mt-1.5 text-sm text-[var(--g3-muted)]">
                  L&apos;agent cible doit exister et être actif — la validation est faite côté serveur, un refus est restitué tel quel. Jetons disponibles dans l&apos;objectif : {"{{document.name}}"}, {"{{document.mimeType}}"}, {"{{document.excerpt}}"}.
                </p>
                <form
                  className="mt-4 grid gap-4"
                  onSubmit={(event) => { event.preventDefault(); void creerTrigger(); }}
                >
                  <div className="grid gap-4 sm:grid-cols-2">
                    <label className="text-sm font-medium text-[var(--g3-text-secondary)]">
                      Nom de la règle
                      <input
                        value={triggerNom}
                        onChange={(event) => setTriggerNom(event.target.value)}
                        maxLength={120}
                        placeholder="ex. synthèse des comptes rendus"
                        className="mt-1.5 w-full min-h-11 rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] px-3.5 py-2.5 text-sm text-[var(--g3-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--g3-primary)]"
                      />
                    </label>
                    <label className="text-sm font-medium text-[var(--g3-text-secondary)]">
                      Correspondance
                      <select
                        value={triggerKind}
                        onChange={(event) => setTriggerKind(event.target.value as typeof triggerKind)}
                        className="mt-1.5 w-full min-h-11 rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] px-3.5 py-2.5 text-sm text-[var(--g3-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--g3-primary)]"
                      >
                        <option value="any">Tout document importé</option>
                        <option value="filename_contains">Nom de fichier contenant…</option>
                        <option value="mime_type">Type MIME commençant par…</option>
                      </select>
                    </label>
                  </div>
                  {triggerKind !== "any" && (
                    <label className="text-sm font-medium text-[var(--g3-text-secondary)]">
                      {triggerKind === "filename_contains" ? "Motif du nom de fichier" : "Préfixe du type MIME"}
                      <input
                        value={triggerMotif}
                        onChange={(event) => setTriggerMotif(event.target.value)}
                        maxLength={200}
                        placeholder={triggerKind === "filename_contains" ? "ex. compte-rendu" : "ex. application/pdf"}
                        className="mt-1.5 w-full min-h-11 rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] px-3.5 py-2.5 text-sm text-[var(--g3-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--g3-primary)]"
                      />
                    </label>
                  )}
                  <label className="text-sm font-medium text-[var(--g3-text-secondary)]">
                    Agent cible (actif)
                    <select
                      value={triggerAgent}
                      onChange={(event) => setTriggerAgent(event.target.value)}
                      className="mt-1.5 w-full min-h-11 rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] px-3.5 py-2.5 text-sm text-[var(--g3-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--g3-primary)] sm:max-w-md"
                    >
                      <option value="">— choisir un agent actif —</option>
                      {agents.filter((agent) => agent.status === "active").map((agent) => (
                        <option key={agent.id} value={agent.id}>{agent.name}</option>
                      ))}
                    </select>
                    {agentsError && <span className="mt-1 block text-xs text-[var(--g3-danger-strong)]" role="alert">{agentsError}</span>}
                  </label>
                  <label className="text-sm font-medium text-[var(--g3-text-secondary)]">
                    Objectif de la mission
                    <textarea
                      value={triggerObjectif}
                      onChange={(event) => setTriggerObjectif(event.target.value)}
                      rows={4}
                      maxLength={2000}
                      placeholder="ex. résume le document et envoie la synthèse à l&apos;équipe"
                      className="mt-1.5 w-full rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] px-3.5 py-2.5 text-sm text-[var(--g3-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--g3-primary)]"
                    />
                  </label>
                  <div className="flex justify-end">
                    <button
                      type="submit"
                      disabled={busy || !triggerNom.trim() || !triggerAgent || triggerObjectif.trim().length < 3 || (triggerKind !== "any" && !triggerMotif.trim())}
                      className="inline-flex min-h-11 items-center justify-center rounded-full bg-[var(--g3-primary)] px-6 py-2.5 text-sm font-semibold text-white transition enabled:hover:brightness-110 disabled:opacity-50"
                    >
                      {busy ? "Création…" : "Créer le déclencheur"}
                    </button>
                  </div>
                </form>
              </section>
            </>
          )}

          {tab === "competences" && (
            <>
              <section className="rounded-3xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-5">
                <h3 className="font-semibold text-[var(--g3-text)]">Bibliothèque de compétences</h3>
                <p className="mt-1.5 text-sm text-[var(--g3-muted)]">
                  Compétences système et privées (statut actif) que le planificateur peut sélectionner pour ses missions.
                </p>
                {skillsError && (
                  <p className="mt-3 rounded-2xl border border-[var(--g3-danger-soft)] bg-[var(--g3-danger-soft)] px-4 py-3 text-sm text-[var(--g3-danger-strong)]" role="alert">
                    {skillsError}
                  </p>
                )}
                {!skillsLoaded ? (
                  <LoadingState label="Chargement de la bibliothèque…" rows={2} />
                ) : skills.length === 0 ? (
                  <p className="mt-3 text-sm text-[var(--g3-muted)]">Aucune compétence visible : créez-en une avec la Skill Factory ci-dessous ou importez le catalogue ouvert.</p>
                ) : (
                  <ul className="mt-3 space-y-3">
                    {skills.map((skill) => (
                      <li key={skill.id} className="rounded-2xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] p-4">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="min-w-0 truncate font-semibold text-[var(--g3-text)]">{skill.name}</span>
                          <span className="flex flex-wrap items-center gap-2">
                            <Badge label={`v${skill.version}`} />
                            <Badge label={skill.visibility === "system" ? "Système" : "Privée"} />
                            <Badge label={skill.category} />
                          </span>
                        </div>
                        <p className="mt-1.5 text-sm text-[var(--g3-muted)]">{skill.description}</p>
                        {(skill.capabilities.length > 0 || skill.requiredTools.length > 0) && (
                          <p className="mt-1.5 text-xs text-[var(--g3-faint)]">
                            {skill.capabilities.length > 0 && `${skill.capabilities.length} capacité${skill.capabilities.length > 1 ? "s" : ""}`}
                            {skill.capabilities.length > 0 && skill.requiredTools.length > 0 && " · "}
                            {skill.requiredTools.length > 0 && `outils : ${skill.requiredTools.join(", ")}`}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="rounded-3xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-5">
                <h3 className="font-semibold text-[var(--g3-text)]">Skill Factory — créer une compétence</h3>
                <p className="mt-1.5 text-sm text-[var(--g3-muted)]">
                  La spécification est construite de façon DÉTERMINISTE par la Skill Factory locale (aucun service externe) : objectif, type, capacités, outils et contraintes deviennent les instructions réelles de la compétence.
                </p>
                <form
                  className="mt-4 grid gap-4"
                  onSubmit={(event) => { event.preventDefault(); void creerSkill(); }}
                >
                  <label className="text-sm font-medium text-[var(--g3-text-secondary)]">
                    Objectif (10 caractères minimum)
                    <textarea
                      value={skillObjectif}
                      onChange={(event) => setSkillObjectif(event.target.value)}
                      rows={3}
                      maxLength={2000}
                      placeholder="ex. produire une veille hebdomadaire des nouveautés du secteur"
                      className="mt-1.5 w-full rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] px-3.5 py-2.5 text-sm text-[var(--g3-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--g3-primary)]"
                    />
                  </label>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <label className="text-sm font-medium text-[var(--g3-text-secondary)]">
                      Type de tâche
                      <select
                        value={skillType}
                        onChange={(event) => setSkillType(event.target.value)}
                        className="mt-1.5 w-full min-h-11 rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] px-3.5 py-2.5 text-sm text-[var(--g3-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--g3-primary)]"
                      >
                        <option value="automation">Automatisation</option>
                        <option value="research">Recherche</option>
                        <option value="writing">Rédaction</option>
                        <option value="analysis">Analyse</option>
                        <option value="communication">Communication</option>
                      </select>
                    </label>
                    <label className="text-sm font-medium text-[var(--g3-text-secondary)]">
                      Capacités requises (séparées par des virgules)
                      <input
                        value={skillCapacites}
                        onChange={(event) => setSkillCapacites(event.target.value)}
                        placeholder="ex. analyse, rédaction"
                        className="mt-1.5 w-full min-h-11 rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] px-3.5 py-2.5 text-sm text-[var(--g3-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--g3-primary)]"
                      />
                    </label>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <label className="text-sm font-medium text-[var(--g3-text-secondary)]">
                      Outils requis (séparés par des virgules)
                      <input
                        value={skillOutils}
                        onChange={(event) => setSkillOutils(event.target.value)}
                        placeholder="ex. web.search, files.read"
                        className="mt-1.5 w-full min-h-11 rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] px-3.5 py-2.5 text-sm text-[var(--g3-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--g3-primary)]"
                      />
                    </label>
                    <label className="text-sm font-medium text-[var(--g3-text-secondary)]">
                      Sortie attendue (facultatif)
                      <input
                        value={skillSortie}
                        onChange={(event) => setSkillSortie(event.target.value)}
                        placeholder="ex. rapport structuré"
                        className="mt-1.5 w-full min-h-11 rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] px-3.5 py-2.5 text-sm text-[var(--g3-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--g3-primary)]"
                      />
                    </label>
                  </div>
                  <div className="flex justify-end">
                    <button
                      type="submit"
                      disabled={busy || skillObjectif.trim().length < 10}
                      className="inline-flex min-h-11 items-center justify-center rounded-full bg-[var(--g3-primary)] px-6 py-2.5 text-sm font-semibold text-white transition enabled:hover:brightness-110 disabled:opacity-50"
                    >
                      {busy ? "Génération…" : "Générer la compétence"}
                    </button>
                  </div>
                </form>
              </section>

              <section className="rounded-3xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-5">
                <h3 className="font-semibold text-[var(--g3-text)]">Importer le catalogue skills.sh</h3>
                <p className="mt-1.5 text-sm text-[var(--g3-muted)]">
                  Import idempotent du catalogue ouvert (écosystème Vercel Labs) vers la bibliothèque : re-importer une compétence inchangée n&apos;écrit rien. L&apos;opération peut prendre jusqu&apos;à une minute.
                </p>
                <button
                  type="button"
                  onClick={() => void importerCatalogue()}
                  disabled={catalogueBusy}
                  className="mt-3 inline-flex min-h-11 items-center justify-center rounded-full border border-[var(--g3-border)] px-6 py-2.5 text-sm font-semibold transition enabled:hover:border-[var(--g3-primary-border)] disabled:opacity-50"
                >
                  {catalogueBusy ? "Import en cours…" : "Importer le catalogue"}
                </button>
                {catalogue && (
                  <div className="mt-3" role="status">
                    <p className="text-sm text-[var(--g3-muted)]">
                      {catalogue.created} compétence{catalogue.created > 1 ? "s" : ""} importée{catalogue.created > 1 ? "s" : ""} sur {catalogue.total} — le reste était déjà présent (idempotence, rien n&apos;est réécrit).
                    </p>
                    <ul className="mt-2 space-y-1 text-xs">
                      {catalogue.items.map((item) => (
                        <li key={item.id} className="text-[var(--g3-muted)]">
                          {item.skipped
                            ? `○ ${item.name} (v${item.version}) — déjà dans la bibliothèque`
                            : `✓ ${item.name} (v${item.version}) — importée`}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      )}
    </main>
  );
}
