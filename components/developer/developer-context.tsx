"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { User } from "firebase/auth";

import { watchAuth } from "@/lib/firebase/client";
import { authFetch, readJsonSafely } from "@/lib/firebase/auth-client";

/**
 * DeveloperContext — état partagé de l'espace développeur.
 * Extrait de l'ancien app/developer/page.tsx (monolithe ~900 lignes) : les
 * projets, clés, extensions, connecteurs et le projet sélectionné vivent ici
 * et alimentent les 7 onglets via de vraies routes /developer/*.
 */

export type Tab = "overview" | "projects" | "build" | "connectors" | "keys" | "extensions" | "monitor";

export type Project = { id: string; name: string; slug: string; description: string; framework: string; environment: string; status: string; updatedAt: number };
export type ApiKey = { prefix: string; name: string; status: string; createdAt: number; projectId?: string | null };
export type Extension = { id: string; name: string; status: string; latestVersion: string | null; stats: { installs: number; executions: number }; permissions: string[] };
export type Revenue = { totalNetMinor: number; currency: string; totalGrossMinor: number; totalFeeMinor: number; entries: number };
export type Connector = { toolkit: string; label: string; description: string; logo?: string | null; categories?: string[]; authSchemes?: string[]; managedBy?: string };
export type ProjectConnector = { id: string; toolkit: string; connectionId: string; status: string; updatedAt: number };
export type ProjectTool = { slug: string; name?: string; description?: string; toolkit?: string };
export type ResourceSummary = { extensions: number; activeApiKeys: number; executions: number; installations: number; approvedExtensions: number; draftExtensions: number };

interface DeveloperState {
  user: User | null;
  projects: Project[];
  keys: ApiKey[];
  extensions: Extension[];
  revenue: Revenue | null;
  selectedProject: string;
  resourceSummary: ResourceSummary | null;
  connectors: Connector[];
  projectConnectors: ProjectConnector[];
  projectTools: ProjectTool[];
  loadError: string | null;
  loaded: boolean;
  busy: boolean;
  message: string;
  project: Project | undefined;
  setSelectedProject: (id: string) => void;
  setMessage: (message: string) => void;
  setBusy: (busy: boolean) => void;
  api: (path: string, init?: RequestInit) => Promise<Response>;
  loadCore: () => Promise<void>;
  loadConnectors: (search?: string) => Promise<void>;
  loadProjectConnectors: () => Promise<void>;
  loadProjectTools: (search?: string) => Promise<void>;
}

const DeveloperContext = createContext<DeveloperState | null>(null);

export function useDeveloper(): DeveloperState {
  const state = useContext(DeveloperContext);
  if (!state) throw new Error("useDeveloper doit être utilisé dans DeveloperProvider.");
  return state;
}

export function DeveloperProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [extensions, setExtensions] = useState<Extension[]>([]);
  const [revenue, setRevenue] = useState<Revenue | null>(null);
  const [selectedProject, setSelectedProject] = useState("");
  const [resourceSummary, setResourceSummary] = useState<ResourceSummary | null>(null);
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [projectConnectors, setProjectConnectors] = useState<ProjectConnector[]>([]);
  const [projectTools, setProjectTools] = useState<ProjectTool[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const api = useCallback(async (path: string, init?: RequestInit) => {
    return authFetch(path, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  }, []);

  // Charge les ressources de base (projets, clés, extensions, revenus).
  // Robustesse conservée de l'original : chaque panneau charge ses données
  // indépendamment ; une panne est signalée au lieu de laisser des zéros muets.
  const loadCore = useCallback(async () => {
    setLoadError(null);
    const results = await Promise.allSettled([
      api("/api/developer/projects"),
      api("/api/developer/api-keys"),
      api(selectedProject ? `/api/developer/extensions?projectId=${encodeURIComponent(selectedProject)}` : "/api/developer/extensions"),
      api("/api/developer/revenue"),
    ]);
    const [p, k, e, r] = results.map((item) => (item.status === "fulfilled" ? item.value : null));
    try {
      if (p?.ok) {
        const data = await readJsonSafely<{ projects?: Project[] }>(p);
        const nextProjects = data?.projects ?? [];
        setProjects(nextProjects);
        setSelectedProject((current) => current || nextProjects[0]?.id || "");
      }
      if (k?.ok) setKeys((await readJsonSafely<{ keys?: ApiKey[] }>(k))?.keys ?? []);
      if (e?.ok) setExtensions((await readJsonSafely<{ extensions?: Extension[] }>(e))?.extensions ?? []);
      if (r?.ok) setRevenue((await readJsonSafely<{ revenue?: Revenue | null }>(r))?.revenue ?? null);
      if (selectedProject) {
        const summary = await api(`/api/developer/projects/${encodeURIComponent(selectedProject)}/resources`);
        if (summary.ok) setResourceSummary((await readJsonSafely<{ summary?: ResourceSummary }>(summary))?.summary ?? null);
      }
    } catch {
      /* JSON illisible : les valeurs par défaut restent en place */
    }
    const failures =
      results.filter((item) => item.status === "rejected").length +
      (p && !p.ok ? 1 : 0) +
      (k && !k.ok ? 1 : 0) +
      (e && !e.ok ? 1 : 0) +
      (r && !r.ok ? 1 : 0);
    if (failures > 0) {
      setLoadError(
        failures >= 4
          ? "Impossible de charger l'espace développeur (serveur momentanément indisponible)."
          : "Certains panneaux n'ont pas pu être chargés — les données affichées peuvent être incomplètes.",
      );
    }
    setLoaded(true);
  }, [api, selectedProject]);

  const loadConnectors = useCallback(
    async (search = "") => {
      const all: Connector[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 20; page++) {
        const query = new URLSearchParams({ limit: "1000" });
        if (search.trim()) query.set("search", search.trim());
        if (cursor) query.set("cursor", cursor);
        const response = await api("/api/integrations/catalog?" + query.toString());
        if (!response.ok) break;
        const data = await response.json();
        if (Array.isArray(data.items)) all.push(...data.items);
        const next = typeof data.nextCursor === "string" && data.nextCursor ? data.nextCursor : "";
        if (!next || next === cursor) break;
        cursor = next;
      }
      const unique = new Map<string, Connector>();
      for (const item of all) {
        if (item?.toolkit) unique.set(item.toolkit, item);
      }
      setConnectors(Array.from(unique.values()));
    },
    [api],
  );

  const loadProjectConnectors = useCallback(async () => {
    if (!selectedProject) {
      setProjectConnectors([]);
      return;
    }
    const response = await api(`/api/developer/projects/${encodeURIComponent(selectedProject)}/connectors`);
    if (response.ok) setProjectConnectors(((await response.json()) as { connectors?: ProjectConnector[] }).connectors ?? []);
  }, [api, selectedProject]);

  const loadProjectTools = useCallback(
    async (search = "") => {
      if (!selectedProject) {
        setProjectTools([]);
        return;
      }
      const query = search.trim() ? "?search=" + encodeURIComponent(search.trim()) : "";
      const response = await api("/api/developer/projects/" + encodeURIComponent(selectedProject) + "/connectors/tools" + query);
      if (response.ok) {
        const data = await response.json();
        const raw = data.tools?.items ?? data.tools ?? [];
        setProjectTools(
          raw.map((item: Record<string, unknown>) => ({
            slug: (item.slug ?? item.toolSlug ?? item.name ?? "unknown") as string,
            name: (item.name ?? item.displayName) as string | undefined,
            description: item.description as string | undefined,
            toolkit: (item.toolkit ?? item.toolkit_slug) as string | undefined,
          })),
        );
      }
    },
    [api, selectedProject],
  );

  useEffect(() => watchAuth((next) => setUser(next)), []);
  useEffect(() => {
    if (!loaded) void loadCore();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- chargement initial uniquement
  }, []);

  const project = useMemo(() => projects.find((candidate) => candidate.id === selectedProject), [projects, selectedProject]);

  const value: DeveloperState = {
    user,
    projects,
    keys,
    extensions,
    revenue,
    selectedProject,
    resourceSummary,
    connectors,
    projectConnectors,
    projectTools,
    loadError,
    loaded,
    busy,
    message,
    project,
    setSelectedProject,
    setMessage,
    setBusy,
    api,
    loadCore,
    loadConnectors,
    loadProjectConnectors,
    loadProjectTools,
  };

  return <DeveloperContext.Provider value={value}>{children}</DeveloperContext.Provider>;
}
