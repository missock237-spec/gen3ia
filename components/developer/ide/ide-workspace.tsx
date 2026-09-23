"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { authFetch } from "@/lib/firebase/auth-client";
import { maskSecrets } from "@/lib/security/secret-masking";
import { extractTestRuns, parseErrorRefs, type ErrorRef } from "@/lib/developer/ide";
import type { TerminalEntry, TerminalSession } from "@/lib/agents/runtime/terminal-sessions";

import { FileExplorer, type IdeFile } from "./file-explorer";
import { CodeEditor, type IdeMarker, type OpenFileTab } from "./code-editor";
import { TerminalView } from "./terminal-view";
import { CommandPalette } from "./command-palette";

/**
 * Workshop IDE unifié — remplace les deux panneaux indépendants
 * (terminal + simulation) par un espace de travail intégré façon
 * VS Code/Cursor :
 *
 *  - barre d'onglets persistante : Terminal, Code, Logs, Aperçu, Tests ;
 *  - panneau gauche : explorateur de fichiers (recherche, favoris, versions) ;
 *  - zone centrale : éditeur Monaco (onglets, minimap, annotations d'erreurs) ;
 *  - panneau droit redimensionnable : exécution, logs, tests, aperçu ;
 *  - terminal partagé par projet, alimenté EXCLUSIVEMENT par les agents ;
 *  - synchronisation contextuelle : une erreur du terminal ouvre le
 *    fichier à la ligne concernée dans l'éditeur ;
 *  - sécurité entreprise : secrets masqués, arrêt de session, arrêt
 *    d'urgence, piste d'audit complète côté serveur.
 */

type MainTab = "terminal" | "code" | "logs" | "preview" | "tests";
type RightSubTab = "execution" | "logs" | "tests" | "preview";
type Connection = "connected" | "offline" | "polling-error";

const MAIN_TABS: Array<{ id: MainTab; label: string; icon: string; shortcut?: string }> = [
  { id: "terminal", label: "Terminal", icon: "❯_" },
  { id: "code", label: "Code", icon: "▤", shortcut: "K" },
  { id: "logs", label: "Logs", icon: "≡" },
  { id: "preview", label: "Aperçu", icon: "▶" },
  { id: "tests", label: "Tests", icon: "✓" },
];

const RIGHT_TABS: Array<{ id: RightSubTab; label: string }> = [
  { id: "execution", label: "Exécution" },
  { id: "logs", label: "Logs" },
  { id: "tests", label: "Tests" },
  { id: "preview", label: "Aperçu" },
];

const FAVORITES_KEY = "g3-ide-favorites";
const RIGHT_WIDTH_KEY = "g3-ide-right-width";

function basename(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] ?? path;
}

export function IdeWorkspace() {
  /* ---------------- Données ---------------- */
  const [files, setFiles] = useState<IdeFile[]>([]);
  const [filesLoading, setFilesLoading] = useState(true);
  const [filesError, setFilesError] = useState("");
  const [favorites, setFavorites] = useState<string[]>([]);

  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [entries, setEntries] = useState<TerminalEntry[]>([]);
  const [live, setLive] = useState(true);
  const [connection, setConnection] = useState<Connection>("connected");
  const [entriesLoading, setEntriesLoading] = useState(false);
  const [sessionError, setSessionError] = useState("");
  const [stopping, setStopping] = useState(false);

  const [openTabs, setOpenTabs] = useState<OpenFileTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [gotoTarget, setGotoTarget] = useState<{ artifactId: string; line: number } | null>(null);
  const [saveNote, setSaveNote] = useState("");

  const [mainTab, setMainTab] = useState<MainTab>("terminal");
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightVisible, setRightVisible] = useState(true);
  const [rightWidth, setRightWidth] = useState(340);
  const [rightSubTab, setRightSubTab] = useState<RightSubTab>("execution");
  const [selectedEntryIndex, setSelectedEntryIndex] = useState<number | null>(null);
  const [previewAppId, setPreviewAppId] = useState<string | null>(null);
  const [previewContent, setPreviewContent] = useState<string | null>(null);
  const [previewDevice, setPreviewDevice] = useState<"mobile" | "desktop">("desktop");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");

  const [paletteOpen, setPaletteOpen] = useState(false);
  const contentCache = useRef<Map<string, string>>(new Map());

  const [online, setOnline] = useState(true);

  /* ---------------- Favoris (persistants) ---------------- */
  useEffect(() => {
    try {
      const raw = localStorage.getItem(FAVORITES_KEY);
      if (raw) setFavorites(JSON.parse(raw) as string[]);
      const width = localStorage.getItem(RIGHT_WIDTH_KEY);
      if (width) setRightWidth(Math.min(Math.max(Number(width) || 340, 240), 620));
    } catch {
      /* stockage indisponible */
    }
  }, []);

  const toggleFavorite = useCallback((artifactId: string) => {
    setFavorites((current) => {
      const next = current.includes(artifactId) ? current.filter((id) => id !== artifactId) : [...current, artifactId];
      try {
        localStorage.setItem(FAVORITES_KEY, JSON.stringify(next));
      } catch {
        /* stockage indisponible */
      }
      return next;
    });
  }, []);

  /* ---------------- Indicateur de connexion ---------------- */
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  /* ---------------- Chargement fichiers ---------------- */
  const loadFiles = useCallback(async () => {
    setFilesLoading(true);
    setFilesError("");
    try {
      const response = await authFetch("/api/developer/ide/files");
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Explorateur indisponible. Vérifiez votre connexion puis réessayez.");
      setFiles((data.files ?? []) as IdeFile[]);
    } catch (e) {
      setFilesError(e instanceof Error ? e.message : "Explorateur indisponible. Vérifiez votre connexion puis réessayez.");
    } finally {
      setFilesLoading(false);
    }
  }, []);

  /* ---------------- Chargement sessions ---------------- */
  const loadSessions = useCallback(async () => {
    try {
      const response = await authFetch("/api/developer/terminal/sessions");
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Sessions indisponibles.");
      const list = (data.sessions ?? []) as TerminalSession[];
      setSessions(list);
      setActiveSessionId((current) => (current && list.some((s) => s.id === current) ? current : list[0]?.id ?? null));
      setConnection(online ? "connected" : "offline");
    } catch (e) {
      setSessionError(e instanceof Error ? e.message : "Sessions indisponibles.");
      setConnection("polling-error");
    }
  }, [online]);

  useEffect(() => {
    void loadFiles();
    void loadSessions();
  }, [loadFiles, loadSessions]);

  /* ---------------- Chargement + polling des entrées ---------------- */
  const lastIndexRef = useRef(-1);

  const fetchEntries = useCallback(
    async (sessionId: string, since: number) => {
      const response = await authFetch(`/api/developer/terminal/sessions/${sessionId}?since=${since}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Entrées indisponibles.");
      return (data.entries ?? []) as TerminalEntry[];
    },
    [],
  );

  useEffect(() => {
    if (!activeSessionId) return;
    let cancelled = false;
    lastIndexRef.current = -1;
    setEntries([]);
    setEntriesLoading(true);
    setSessionError("");

    const pull = async (initial: boolean) => {
      try {
        const fresh = await fetchEntries(activeSessionId, lastIndexRef.current);
        if (cancelled) return;
        if (fresh.length > 0) {
          lastIndexRef.current = fresh[fresh.length - 1].index;
          setEntries((current) => {
            const known = new Set(current.map((e) => e.index));
            const merged = [...current, ...fresh.filter((e) => !known.has(e.index))];
            return merged.sort((a, b) => a.index - b.index);
          });
        }
        setConnection(online ? "connected" : "offline");
        setSessionError("");
      } catch (e) {
        if (cancelled) return;
        setConnection("polling-error");
        if (initial) setSessionError(e instanceof Error ? e.message : "Entrées indisponibles. Vérifiez votre connexion puis réessayez.");
      } finally {
        if (!cancelled) setEntriesLoading(false);
      }
    };

    void pull(true);
    if (!live) return () => {
      cancelled = true;
    };
    const interval = setInterval(() => void pull(false), 2_500);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [activeSessionId, live, fetchEntries, online]);

  /* ---------------- Ouvrir un fichier ---------------- */
  const openFile = useCallback(async (file: IdeFile, line?: number) => {
    const existing = openTabs.find((t) => t.artifactId === file.artifactId);
    setMainTab("code");
    if (existing) {
      setActiveTabId(file.artifactId);
      if (line) setGotoTarget({ artifactId: file.artifactId, line });
      return;
    }
    try {
      const response = await authFetch(`/api/developer/ide/files/${file.artifactId}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Fichier indisponible.");
      const artifact = data.artifact as { content: string; language?: string; versions: Array<{ version: number }> };
      const tab: OpenFileTab = {
        artifactId: file.artifactId,
        path: file.path,
        content: artifact.content ?? "",
        language: artifact.language ?? file.language,
        dirty: false,
        saving: false,
        savedVersion: artifact.versions?.[0]?.version ?? file.version,
      };
      contentCache.current.set(file.artifactId, artifact.content ?? "");
      setOpenTabs((current) => [...current, tab]);
      setActiveTabId(file.artifactId);
      if (line) setGotoTarget({ artifactId: file.artifactId, line });
    } catch (e) {
      setSaveNote(e instanceof Error ? e.message : "Fichier indisponible.");
      setTimeout(() => setSaveNote(""), 4_000);
    }
  }, [openTabs]);

  const closeTab = useCallback((artifactId: string) => {
    setOpenTabs((current) => {
      const next = current.filter((t) => t.artifactId !== artifactId);
      setActiveTabId((active) => (active === artifactId ? next[next.length - 1]?.artifactId ?? null : active));
      return next;
    });
  }, []);

  /* ---------------- Sauvegarde (nouvelle version) ---------------- */
  const saveActiveTab = useCallback(async () => {
    const tab = openTabs.find((t) => t.artifactId === activeTabId);
    if (!tab || !tab.dirty || tab.saving) return;
    setOpenTabs((current) => current.map((t) => (t.artifactId === tab.artifactId ? { ...t, saving: true } : t)));
    try {
      const response = await authFetch("/api/developer/ide/files", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ artifactId: tab.artifactId, content: tab.content }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Sauvegarde impossible. Réessayez dans un instant.");
      const version = Number(data.version ?? tab.savedVersion + 1);
      setOpenTabs((current) =>
        current.map((t) => (t.artifactId === tab.artifactId ? { ...t, dirty: false, saving: false, savedVersion: version } : t)),
      );
      contentCache.current.set(tab.artifactId, tab.content);
      setSaveNote(`Enregistré · version ${version}`);
      void loadFiles();
    } catch (e) {
      setOpenTabs((current) => current.map((t) => (t.artifactId === tab.artifactId ? { ...t, saving: false } : t)));
      setSaveNote(e instanceof Error ? e.message : "Sauvegarde impossible. Réessayez dans un instant.");
    } finally {
      setTimeout(() => setSaveNote(""), 3_500);
    }
  }, [openTabs, activeTabId, loadFiles]);

  /* ---------------- Contrôles session ---------------- */
  const stopSession = useCallback(async (sessionId: string) => {
    setStopping(true);
    try {
      const response = await authFetch(`/api/developer/terminal/sessions/${sessionId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "stop" }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Arrêt impossible.");
      setSessions((current) => current.map((s) => (s.id === sessionId ? { ...s, status: "stopped" } : s)));
      setSaveNote("Session arrêtée — les agents ne peuvent plus y exécuter de commandes.");
    } catch (e) {
      setSaveNote(e instanceof Error ? e.message : "Arrêt impossible.");
    } finally {
      setStopping(false);
      setTimeout(() => setSaveNote(""), 4_000);
    }
  }, []);

  const emergencyStop = useCallback(async () => {
    if (!window.confirm("Arrêt d'urgence : interrompre immédiatement toutes les exécutions en cours de vos agents ?")) return;
    try {
      const response = await authFetch("/api/security/emergency-stop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope: "user", reason: "Arrêt d'urgence depuis le Workshop IDE" }),
      });
      const data = await response.json();
      setSaveNote(response.ok ? "Arrêt d'urgence activé — toutes les exécutions sont interrompues." : data.error || "Arrêt impossible.");
    } catch {
      setSaveNote("Arrêt d'urgence indisponible. Réessayez.");
    } finally {
      setTimeout(() => setSaveNote(""), 4_500);
    }
  }, []);

  /* ---------------- Synchronisation terminal → éditeur ---------------- */
  const openErrorRef = useCallback(
    (ref: ErrorRef) => {
      const target =
        files.find((f) => f.path === ref.path) ??
        files.find((f) => f.path.endsWith("/" + ref.path) || basename(f.path) === basename(ref.path));
      if (target) void openFile(target, ref.line);
      else {
        setSaveNote(`Fichier « ${ref.path} » introuvable dans l'explorateur. Rafraîchissez la liste des fichiers.`);
        setTimeout(() => setSaveNote(""), 4_000);
      }
    },
    [files, openFile],
  );

  /* ---------------- Marqueurs d'erreurs (onglet actif) ---------------- */
  const markers = useMemo<IdeMarker[]>(() => {
    if (!activeTabId) return [];
    const activeTab = openTabs.find((t) => t.artifactId === activeTabId);
    if (!activeTab) return [];
    const base = basename(activeTab.path).toLowerCase();
    const found: IdeMarker[] = [];
    for (const entry of entries) {
      if (entry.success) continue;
      for (const ref of [...parseErrorRefs(entry.stderr), ...parseErrorRefs(entry.stdout)]) {
        const refBase = basename(ref.path).toLowerCase();
        const matches = refBase === base || activeTab.path.toLowerCase().endsWith(ref.path.toLowerCase());
        if (!matches || !ref.line) continue;
        found.push({
          startLine: ref.line,
          startColumn: ref.column,
          message: ref.source,
          severity: /error|exception|failed|échec/i.test(ref.source) ? "error" : "warning",
          source: `terminal · commande #${entry.index}`,
        });
        if (found.length >= 30) return found;
      }
    }
    return found;
  }, [entries, activeTabId, openTabs]);

  /* ---------------- Tests dérivés ---------------- */
  const testRuns = useMemo(() => extractTestRuns(entries), [entries]);

  /* ---------------- Applications prévisualisables ---------------- */
  const previewApps = useMemo(() => files.filter((f) => f.language === "html" || f.path.toLowerCase().endsWith(".html")), [files]);

  const loadPreview = useCallback(
    async (artifactId: string) => {
      setPreviewLoading(true);
      setPreviewError("");
      try {
        const cached = contentCache.current.get(artifactId);
        if (cached !== undefined) {
          setPreviewContent(cached);
          return;
        }
        const response = await authFetch(`/api/developer/ide/files/${artifactId}`);
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Aperçu indisponible.");
        const content = (data.artifact?.content as string) ?? "";
        contentCache.current.set(artifactId, content);
        setPreviewContent(content);
      } catch (e) {
        setPreviewError(e instanceof Error ? e.message : "Aperçu indisponible.");
      } finally {
        setPreviewLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (!previewAppId) return;
    void loadPreview(previewAppId);
  }, [previewAppId, loadPreview]);

  // Si aucun app sélectionné, prendre la plus récente automatiquement.
  useEffect(() => {
    if (previewApps.length > 0 && (!previewAppId || !previewApps.some((a) => a.artifactId === previewAppId))) {
      setPreviewAppId(previewApps[0].artifactId);
    }
    if (previewApps.length === 0) {
      setPreviewAppId(null);
      setPreviewContent(null);
    }
  }, [previewApps, previewAppId]);

  /* ---------------- Palette & raccourcis ---------------- */
  const searchContents = useCallback(
    (query: string) => {
      const q = query.toLowerCase();
      const results: Array<{ file: IdeFile; line: number; excerpt: string }> = [];
      for (const file of files.slice(0, 80)) {
        const cached = contentCache.current.get(file.artifactId);
        const content = cached ?? (openTabs.find((t) => t.artifactId === file.artifactId)?.content ?? "");
        if (!content) continue;
        const lines = content.split("\n");
        for (let i = 0; i < lines.length && results.length < 40; i++) {
          if (lines[i].toLowerCase().includes(q)) {
            results.push({ file, line: i + 1, excerpt: lines[i].trim().slice(0, 120) });
            break;
          }
        }
      }
      return results;
    },
    [files, openTabs],
  );

  const paletteActions = useMemo(
    () => [
      { id: "tab-terminal", label: "Aller au Terminal", hint: "" },
      { id: "tab-code", label: "Aller à l'éditeur de code" },
      { id: "tab-logs", label: "Aller aux logs" },
      { id: "tab-preview", label: "Aller à l'aperçu" },
      { id: "tab-tests", label: "Aller aux tests" },
      { id: "save", label: "Enregistrer le fichier actif", hint: "⌘S" },
      { id: "toggle-right", label: rightVisible ? "Masquer le panneau droit" : "Afficher le panneau droit" },
      { id: "stop-session", label: "Arrêter la session terminal active" },
      { id: "emergency", label: "Arrêt d'urgence (toutes exécutions)" },
    ],
    [rightVisible],
  );

  const pickAction = useCallback(
    (id: string) => {
      if (id.startsWith("tab-")) setMainTab(id.slice(4) as MainTab);
      else if (id === "save") void saveActiveTab();
      else if (id === "toggle-right") setRightVisible((v) => !v);
      else if (id === "stop-session" && activeSessionId) void stopSession(activeSessionId);
      else if (id === "emergency") void emergencyStop();
    },
    [saveActiveTab, activeSessionId, stopSession, emergencyStop],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      if (!mod) return;
      const key = event.key.toLowerCase();
      if (key === "k" || key === "p" || (event.shiftKey && key === "f")) {
        event.preventDefault();
        setPaletteOpen(true);
      } else if (key === "s") {
        event.preventDefault();
        void saveActiveTab();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [saveActiveTab]);

  /* ---------------- Redimensionnement panneau droit ---------------- */
  const resizingRef = useRef(false);
  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      if (!resizingRef.current) return;
      const width = Math.min(Math.max(window.innerWidth - event.clientX - 12, 240), 620);
      setRightWidth(width);
    };
    const onUp = () => {
      if (resizingRef.current) {
        resizingRef.current = false;
        try {
          localStorage.setItem(RIGHT_WIDTH_KEY, String(rightWidth));
        } catch {
          /* stockage indisponible */
        }
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [rightWidth]);

  /* ---------------- Dérivés ---------------- */
  const activeTab = openTabs.find((t) => t.artifactId === activeTabId) ?? null;
  const lastEntry = entries.length > 0 ? entries[entries.length - 1] : null;
  const selectedEntry = selectedEntryIndex !== null ? entries.find((e) => e.index === selectedEntryIndex) ?? lastEntry : lastEntry;
  const dirtyCount = openTabs.filter((t) => t.dirty).length;
  const openIds = useMemo(() => new Set(openTabs.map((t) => t.artifactId)), [openTabs]);


  /* ---------------- Rendu ---------------- */
  return (
    <section className="flex h-[calc(100vh-190px)] min-h-[560px] flex-col overflow-hidden rounded-2xl border border-neutral-800 bg-[#11120f]" aria-label="Workshop IDE">
      {/* Barre d'onglets persistante */}
      <header className="flex items-center gap-1 border-b border-neutral-800 bg-[#181917] px-2 py-1.5">
        <div className="flex items-center gap-0.5" role="tablist" aria-label="Sections de l'IDE">
          {MAIN_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={mainTab === tab.id}
              onClick={() => setMainTab(tab.id)}
              className={
                "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition " +
                (mainTab === tab.id ? "bg-neutral-800 text-white" : "text-neutral-400 hover:bg-neutral-800/60 hover:text-neutral-200")
              }
            >
              <span aria-hidden className="text-[10px] opacity-70">{tab.icon}</span>
              {tab.label}
              {tab.id === "code" && dirtyCount > 0 && (
                <span className="rounded-full bg-amber-500/20 px-1.5 text-[9px] text-amber-300">{dirtyCount} non enreg.</span>
              )}
              {tab.id === "tests" && testRuns.length > 0 && (
                <span className={"rounded-full px-1.5 text-[9px] " + (testRuns[testRuns.length - 1].passed === false ? "bg-red-500/20 text-red-300" : "bg-emerald-500/20 text-emerald-300")}>
                  {testRuns.length}
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-2">
          {saveNote && <span className="max-w-[320px] truncate text-[10px] text-neutral-400" role="status">{saveNote}</span>}
          <span className="flex items-center gap-1.5 rounded-full border border-neutral-800 px-2 py-1 text-[9px] text-neutral-500" title="État de la connexion aux sessions">
            <span className={"inline-block size-1.5 rounded-full " + (online ? "bg-emerald-500" : "bg-red-500")} aria-hidden />
            {online ? "En ligne" : "Hors ligne"}
          </span>
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="flex items-center gap-1.5 rounded-lg border border-neutral-800 px-2 py-1 text-[10px] text-neutral-500 transition hover:text-neutral-200"
            aria-label="Ouvrir la palette de commandes"
          >
            ⌕ <kbd className="rounded bg-neutral-900 px-1 py-0.5">Ctrl/⌘ K</kbd>
          </button>
          <button
            type="button"
            onClick={() => setLeftCollapsed((v) => !v)}
            className="rounded-lg border border-neutral-800 px-2 py-1 text-[10px] text-neutral-500 hover:text-neutral-200"
            aria-pressed={leftCollapsed}
            title={leftCollapsed ? "Afficher l'explorateur" : "Masquer l'explorateur"}
          >
            {leftCollapsed ? "»" : "«"}
          </button>
          <button
            type="button"
            onClick={() => setRightVisible((v) => !v)}
            className="rounded-lg border border-neutral-800 px-2 py-1 text-[10px] text-neutral-500 hover:text-neutral-200"
            aria-pressed={rightVisible}
            title={rightVisible ? "Masquer le panneau droit" : "Afficher le panneau droit"}
          >
            {rightVisible ? "▤›" : "‹▤"}
          </button>
        </div>
      </header>

      {/* Corps : explorateur + zone centrale + panneau droit */}
      <div className="flex min-h-0 flex-1">
        {!leftCollapsed && (
          <aside className="w-[260px] shrink-0">
            <FileExplorer
              files={files}
              loading={filesLoading}
              error={filesError}
              openIds={openIds}
              activeId={activeTabId}
              favorites={favorites}
              onOpen={(file) => void openFile(file)}
              onToggleFavorite={toggleFavorite}
              onReload={() => void loadFiles()}
            />
          </aside>
        )}

        <main className="flex min-w-0 flex-1 flex-col">
          {mainTab === "terminal" && (
            <TerminalView
              sessions={sessions}
              activeSessionId={activeSessionId}
              entries={entries}
              live={live}
              connection={connection}
              loadingEntries={entriesLoading}
              error={sessionError}
              stopping={stopping}
              onSelectSession={(id) => setActiveSessionId(id)}
              onToggleLive={() => setLive((v) => !v)}
              onStopSession={(id) => void stopSession(id)}
              onEmergencyStop={() => void emergencyStop()}
              onRetry={() => {
                void loadSessions();
                if (activeSessionId) void fetchEntries(activeSessionId, -1).then((all) => {
                  lastIndexRef.current = all[all.length - 1]?.index ?? -1;
                  setEntries(all);
                  setSessionError("");
                  setConnection("connected");
                });
              }}
              onOpenErrorRef={openErrorRef}
            />
          )}

          {mainTab === "code" && (
            <CodeEditor
              tabs={openTabs}
              activeId={activeTabId}
              markers={markers}
              goto={gotoTarget}
              onGotoHandled={() => setGotoTarget(null)}
              onSelectTab={setActiveTabId}
              onCloseTab={closeTab}
              onChange={(artifactId, content) =>
                setOpenTabs((current) => current.map((t) => (t.artifactId === artifactId ? { ...t, content, dirty: true } : t)))
              }
            />
          )}

          {mainTab === "logs" && (
            <LogsView entries={entries} selected={selectedEntry?.index ?? null} onSelect={setSelectedEntryIndex} onOpenErrorRef={openErrorRef} />
          )}

          {mainTab === "preview" && (
            <PreviewFrame
              previewApps={previewApps}
              previewAppId={previewAppId}
              onAppChange={setPreviewAppId}
              previewDevice={previewDevice}
              onDeviceChange={setPreviewDevice}
              previewContent={previewContent}
              previewLoading={previewLoading}
              previewError={previewError}
              onReload={() => void loadPreview(previewAppId as string)}
              onOpenInTab={() => {
                const blob = new Blob([previewContent ?? ""], { type: "text/html" });
                window.open(URL.createObjectURL(blob), "_blank", "noopener");
              }}
            />
          )}

          {mainTab === "tests" && <TestsView testRuns={testRuns} onOpenEntry={(index) => { setMainTab("logs"); setSelectedEntryIndex(index); }} />}
        </main>

        {/* Poignée + panneau droit redimensionnable */}
        {rightVisible && (
          <>
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Redimensionner le panneau droit"
              className="w-1 cursor-col-resize bg-neutral-800 transition hover:bg-neutral-600"
              onPointerDown={() => {
                resizingRef.current = true;
              }}
            />
            <aside style={{ width: rightWidth }} className="flex shrink-0 flex-col bg-[#0d0e0c]">
              <div className="flex items-center gap-0.5 border-b border-neutral-800 px-1.5 py-1.5" role="tablist" aria-label="Panneau d'inspection">
                {RIGHT_TABS.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={rightSubTab === tab.id}
                    onClick={() => setRightSubTab(tab.id)}
                    className={
                      "rounded-md px-2 py-1 text-[10px] font-medium transition " +
                      (rightSubTab === tab.id ? "bg-neutral-800 text-white" : "text-neutral-500 hover:text-neutral-300")
                    }
                  >
                    {tab.label}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setRightVisible(false)}
                  className="ml-auto rounded px-1.5 text-neutral-600 hover:text-neutral-300"
                  aria-label="Masquer le panneau droit"
                >
                  ×
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                {rightSubTab === "execution" && <ExecutionPane entry={selectedEntry} onOpenErrorRef={openErrorRef} entries={entries} onSelect={setSelectedEntryIndex} />}
                {rightSubTab === "logs" && <MiniLogs entries={entries} onSelect={(index) => { setSelectedEntryIndex(index); setRightSubTab("execution"); }} />}
                {rightSubTab === "tests" && <MiniTests testRuns={testRuns} onOpenEntry={(index) => { setSelectedEntryIndex(index); setRightSubTab("execution"); }} />}
                {rightSubTab === "preview" && (
                  <PreviewFrame
                    compact
                    previewApps={previewApps}
                    previewAppId={previewAppId}
                    onAppChange={setPreviewAppId}
                    previewDevice={previewDevice}
                    onDeviceChange={setPreviewDevice}
                    previewContent={previewContent}
                    previewLoading={previewLoading}
                    previewError={previewError}
                    onReload={() => void loadPreview(previewAppId as string)}
                    onOpenInTab={() => {
                      const blob = new Blob([previewContent ?? ""], { type: "text/html" });
                      window.open(URL.createObjectURL(blob), "_blank", "noopener");
                    }}
                  />
                )}
              </div>
            </aside>
          </>
        )}
      </div>

      <CommandPalette
        open={paletteOpen}
        files={files}
        actions={paletteActions}
        searchContents={searchContents}
        onPickFile={(file) => void openFile(file)}
        onPickAction={pickAction}
        onClose={() => setPaletteOpen(false)}
      />
    </section>
  );
}


interface PreviewFrameProps {
  compact?: boolean;
  previewApps: IdeFile[];
  previewAppId: string | null;
  onAppChange: (artifactId: string) => void;
  previewDevice: "mobile" | "desktop";
  onDeviceChange: (device: "mobile" | "desktop") => void;
  previewContent: string | null;
  previewLoading: boolean;
  previewError: string;
  onReload: () => void;
  onOpenInTab: () => void;
}

export function PreviewFrame({ compact, previewApps, previewAppId, onAppChange, previewDevice, onDeviceChange, previewContent, previewLoading, previewError, onReload, onOpenInTab }: PreviewFrameProps) {
  if (previewApps.length === 0) {
    return (
      <div className="grid h-full place-items-center px-6 text-center">
        <div className="max-w-xs">
          <p className="text-2xl" aria-hidden>▶</p>
          <p className="mt-2 text-xs text-neutral-400">Aucune application à prévisualiser</p>
          <p className="mt-1 text-[11px] leading-relaxed text-neutral-600">
            Demandez à un agent de créer une application (page HTML) : un bouton « Voir le résultat en direct » apparaîtra aussi directement dans la conversation.
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-neutral-800 px-3 py-2">
        <select
          value={previewAppId ?? ""}
          onChange={(event) => onAppChange(event.target.value)}
          className="max-w-[240px] rounded-lg border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs text-neutral-200 focus:border-neutral-600 focus:outline-none"
          aria-label="Choisir l'application à prévisualiser"
        >
          {previewApps.map((app) => (
            <option key={app.artifactId} value={app.artifactId}>
              {app.path}
            </option>
          ))}
        </select>
        <div className="flex overflow-hidden rounded-lg border border-neutral-800" role="group" aria-label="Taille d'aperçu">
          {(["mobile", "desktop"] as const).map((device) => (
            <button
              key={device}
              type="button"
              onClick={() => onDeviceChange(device)}
              className={"px-2 py-1 text-[10px] transition " + (previewDevice === device ? "bg-neutral-800 text-white" : "text-neutral-500 hover:text-neutral-300")}
            >
              {device === "mobile" ? "Mobile" : "Plein"}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={onReload}
          className="rounded px-1.5 py-1 text-[10px] text-neutral-500 hover:text-neutral-200"
          title="Recharger l'aperçu"
        >
          ⟳
        </button>
        {previewAppId && (
          <button
            type="button"
            onClick={() => {
              const content = previewContent ?? "";
              const blob = new Blob([content], { type: "text/html" });
              window.open(URL.createObjectURL(blob), "_blank", "noopener");
            }}
            className="ml-auto rounded border border-neutral-700 px-2 py-1 text-[10px] text-neutral-400 hover:text-white"
          >
            Ouvrir dans un onglet
          </button>
        )}
      </div>
      <div className="grid min-h-0 flex-1 place-items-center overflow-auto bg-neutral-950 p-2">
        {previewLoading && <p className="text-xs text-neutral-500">Chargement de l&apos;aperçu…</p>}
        {previewError && (
          <div className="rounded-lg border border-amber-900/60 bg-amber-950/40 p-3 text-[11px] text-amber-300" role="alert">
            {previewError}
            <button type="button" onClick={onReload} className="mt-1 block underline underline-offset-2">
              Réessayer
            </button>
          </div>
        )}
        {!previewLoading && !previewError && previewContent !== null && (
          <iframe
            key={previewAppId}
            title="Aperçu de l'application"
            sandbox="allow-scripts allow-forms allow-modals allow-popups"
            srcDoc={previewContent}
            className={"h-full rounded-lg border border-neutral-800 bg-white " + (previewDevice === "mobile" ? "w-[390px] max-w-full" : "w-full")}
          />
        )}
      </div>
    </div>
  );
}

/* ================================================================== */
/* Vues secondaires : logs structurés, tests, panneaux d'inspection    */
/* ================================================================== */

function statusBadge(success: boolean | undefined) {
  if (success) return <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-400">OK</span>;
  return <span className="rounded-full bg-red-500/15 px-1.5 py-0.5 text-[9px] font-semibold text-red-400">ÉCHEC</span>;
}

function LogsView({ entries, selected, onSelect, onOpenErrorRef }: { entries: TerminalEntry[]; selected: number | null; onSelect: (index: number) => void; onOpenErrorRef: (ref: ErrorRef) => void }) {
  const [filter, setFilter] = useState("");
  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((e) => `${e.command} ${e.stdout ?? ""} ${e.stderr ?? ""}`.toLowerCase().includes(q));
  }, [entries, filter]);
  const selectedEntry = selected !== null ? entries.find((e) => e.index === selected) : null;

  return (
    <div className="flex h-full min-h-0 bg-[#0d0e0c]">
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="border-b border-neutral-800 px-3 py-2">
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filtrer les logs (commande ou sortie)…"
            aria-label="Filtrer les logs"
            className="w-full rounded-lg border border-neutral-800 bg-neutral-900 px-2.5 py-1.5 text-xs text-neutral-200 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none"
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2" role="list" aria-label="Logs structurés">
          {filtered.length === 0 && <p className="py-6 text-center text-xs text-neutral-500">{filter ? "Aucun log ne correspond au filtre." : "Aucun log — les exécutions de vos agents apparaîtront ici."}</p>}
          {filtered.map((entry) => (
            <button
              key={entry.index}
              type="button"
              role="listitem"
              onClick={() => onSelect(entry.index)}
              className={"flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[11px] transition " + (selected === entry.index ? "bg-neutral-800" : "hover:bg-neutral-800/50")}
            >
              <span className="w-[64px] shrink-0 text-neutral-600">{new Date(entry.createdAt).toLocaleTimeString("fr-FR")}</span>
              {statusBadge(entry.success)}
              <code className="min-w-0 flex-1 truncate text-neutral-300">{entry.command}</code>
              {entry.mode && <span className="shrink-0 text-[9px] text-neutral-600">{entry.mode === "sandbox" ? "réel" : entry.engine ?? "simulation"}</span>}
              {typeof entry.exitCode === "number" && <span className={"shrink-0 " + (entry.exitCode === 0 ? "text-emerald-600" : "text-red-400")}>exit {entry.exitCode}</span>}
            </button>
          ))}
        </div>
      </div>
      {selectedEntry && (
        <div className="w-[340px] shrink-0 overflow-y-auto border-l border-neutral-800 p-3">
          <h3 className="text-[10px] font-semibold uppercase tracking-widest text-neutral-500">Détail · #{selectedEntry.index}</h3>
          <pre className="mt-2 rounded-lg bg-neutral-900 p-2.5 text-[11px] text-neutral-300">{maskSecrets(selectedEntry.command)}</pre>
          {selectedEntry.stdout && <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded-lg bg-neutral-900 p-2.5 text-[11px] text-neutral-400">{maskSecrets(selectedEntry.stdout)}</pre>}
          {selectedEntry.stderr && <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded-lg bg-neutral-900 p-2.5 text-[11px] text-red-300">{maskSecrets(selectedEntry.stderr)}</pre>}
          {(parseErrorRefs(selectedEntry.stderr).length > 0 || parseErrorRefs(selectedEntry.stdout).length > 0) && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {[...parseErrorRefs(selectedEntry.stderr), ...parseErrorRefs(selectedEntry.stdout)].slice(0, 6).map((ref) => (
                <button
                  key={`${ref.path}-${ref.line ?? ""}`}
                  type="button"
                  onClick={() => onOpenErrorRef(ref)}
                  className="rounded-full border border-sky-900 bg-sky-950/50 px-2 py-0.5 text-[10px] text-sky-300 hover:bg-sky-900/60"
                >
                  ↗ {ref.path}{ref.line ? `:${ref.line}` : ""}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TestsView({ testRuns, onOpenEntry }: { testRuns: ReturnType<typeof extractTestRuns>; onOpenEntry: (index: number) => void }) {
  if (testRuns.length === 0) {
    return (
      <div className="grid h-full place-items-center bg-[#0d0e0c] px-6 text-center">
        <div className="max-w-sm">
          <p className="text-2xl" aria-hidden>✓</p>
          <p className="mt-2 text-sm font-medium text-neutral-300">Aucune commande de test exécutée</p>
          <p className="mt-1 text-xs leading-relaxed text-neutral-500">
            Les résultats (vitest, jest, pytest…) détectés dans les exécutions de vos agents seront résumés ici : réussites, échecs, durée.
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="h-full overflow-y-auto bg-[#0d0e0c] p-3">
      <ul className="space-y-2" role="list">
        {[...testRuns].reverse().map((run) => (
          <li key={run.entryIndex}>
            <button type="button" onClick={() => onOpenEntry(run.entryIndex)} className="w-full rounded-xl border border-neutral-800 bg-neutral-900/60 p-3 text-left transition hover:border-neutral-700">
              <div className="flex items-center gap-2">
                {run.passed === true && <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-400">RÉUSSI</span>}
                {run.passed === false && <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-[10px] font-semibold text-red-400">ÉCHEC</span>}
                {run.passed === null && <span className="rounded-full bg-neutral-700/40 px-2 py-0.5 text-[10px] font-semibold text-neutral-400">INDÉTERMINÉ</span>}
                {run.summary && <span className="text-[11px] text-neutral-300">{run.summary}</span>}
                <span className="ml-auto text-[9px] text-neutral-600">{new Date(run.createdAt).toLocaleString("fr-FR")}</span>
              </div>
              <code className="mt-1.5 block truncate text-[11px] text-neutral-400">{run.command}</code>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ExecutionPane({ entry, entries, onSelect, onOpenErrorRef }: { entry: TerminalEntry | null; entries: TerminalEntry[]; onSelect: (index: number) => void; onOpenErrorRef: (ref: ErrorRef) => void }) {
  if (!entry) {
    return <p className="p-3 text-[11px] leading-relaxed text-neutral-500">Aucune exécution sélectionnée. Le dernier résultat de vos agents apparaîtra ici automatiquement.</p>;
  }
  const refs = [...parseErrorRefs(entry.stderr), ...parseErrorRefs(entry.stdout)];
  return (
    <div className="space-y-2.5 p-3">
      <div>
        <div className="flex items-center gap-2">
          {statusBadge(entry.success)}
          <span className="text-[9px] text-neutral-600">#{entry.index} · {new Date(entry.createdAt).toLocaleTimeString("fr-FR")}</span>
        </div>
        <pre className="mt-1.5 whitespace-pre-wrap rounded-lg bg-neutral-900 p-2 text-[11px] text-neutral-300">{maskSecrets(entry.command)}</pre>
      </div>
      {typeof entry.exitCode === "number" && (
        <p className="text-[10px] text-neutral-500">
          exit <span className={entry.exitCode === 0 ? "text-emerald-500" : "text-red-400"}>{entry.exitCode}</span> · {entry.durationMs} ms · {entry.mode === "sandbox" ? "exécution réelle" : entry.engine ?? "simulation"}
        </p>
      )}
      {entry.stdout && <pre className="max-h-52 overflow-auto whitespace-pre-wrap rounded-lg bg-neutral-900 p-2 text-[10px] text-neutral-400">{maskSecrets(entry.stdout)}</pre>}
      {entry.stderr && <pre className="max-h-52 overflow-auto whitespace-pre-wrap rounded-lg bg-neutral-900 p-2 text-[10px] text-red-300">{maskSecrets(entry.stderr)}</pre>}
      {refs.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {refs.slice(0, 5).map((ref) => (
            <button key={`${ref.path}-${ref.line ?? ""}`} type="button" onClick={() => onOpenErrorRef(ref)} className="rounded-full border border-sky-900 bg-sky-950/50 px-2 py-0.5 text-[10px] text-sky-300 hover:bg-sky-900/60">
              ↗ {ref.path}{ref.line ? `:${ref.line}` : ""}
            </button>
          ))}
        </div>
      )}
      {entries.length > 1 && (
        <div>
          <h4 className="text-[9px] font-semibold uppercase tracking-widest text-neutral-600">Précédentes</h4>
          <ul className="mt-1 space-y-0.5">
            {entries.slice(-8, -1).reverse().map((e) => (
              <li key={e.index}>
                <button type="button" onClick={() => onSelect(e.index)} className="w-full truncate rounded px-1.5 py-1 text-left text-[10px] text-neutral-500 hover:bg-neutral-800/60 hover:text-neutral-300">
                  <span className={e.success ? "text-emerald-600" : "text-red-400"}>●</span> {e.command}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function MiniLogs({ entries, onSelect }: { entries: TerminalEntry[]; onSelect: (index: number) => void }) {
  if (entries.length === 0) return <p className="p-3 text-[11px] text-neutral-500">Aucun log pour l&apos;instant.</p>;
  return (
    <ul className="space-y-0.5 p-2" role="list">
      {[...entries].reverse().map((entry) => (
        <li key={entry.index}>
          <button type="button" onClick={() => onSelect(entry.index)} className="w-full rounded px-2 py-1.5 text-left hover:bg-neutral-800/60">
            <div className="flex items-center gap-1.5">
              <span className={"text-[8px] " + (entry.success ? "text-emerald-500" : "text-red-400")} aria-hidden>●</span>
              <code className="min-w-0 flex-1 truncate text-[10px] text-neutral-400">{entry.command}</code>
            </div>
            <span className="pl-3 text-[8px] text-neutral-600">{new Date(entry.createdAt).toLocaleTimeString("fr-FR")}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function MiniTests({ testRuns, onOpenEntry }: { testRuns: ReturnType<typeof extractTestRuns>; onOpenEntry: (index: number) => void }) {
  if (testRuns.length === 0) return <p className="p-3 text-[11px] text-neutral-500">Aucun test détecté dans l&apos;historique.</p>;
  return (
    <ul className="space-y-1.5 p-2" role="list">
      {[...testRuns].reverse().map((run) => (
        <li key={run.entryIndex}>
          <button type="button" onClick={() => onOpenEntry(run.entryIndex)} className="w-full rounded-lg border border-neutral-800 p-2 text-left hover:border-neutral-700">
            <div className="flex items-center gap-1.5">
              {run.passed === true && <span className="text-[9px] font-bold text-emerald-400">✓</span>}
              {run.passed === false && <span className="text-[9px] font-bold text-red-400">✗</span>}
              {run.passed === null && <span className="text-[9px] font-bold text-neutral-500">?</span>}
              <span className="min-w-0 flex-1 truncate text-[10px] text-neutral-400">{run.command}</span>
            </div>
            {run.summary && <span className="mt-0.5 block pl-4 text-[9px] text-neutral-500">{run.summary}</span>}
          </button>
        </li>
      ))}
    </ul>
  );
}
