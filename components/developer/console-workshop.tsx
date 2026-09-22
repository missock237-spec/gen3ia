"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { authFetch } from "@/lib/firebase/auth-client";

/**
 * Console de l'agent de code — deux panneaux :
 *  1. Terminal : historique de commandes, sortie, statut de mode
 *     (sandbox réel vs simulation) ;
 *  2. Simulation : éditeur de code + moteur sélectionnable + trace.
 *
 * Les deux consomment les routes /api/developer/terminal et
 * /api/developer/simulation (réservées aux propriétaires d'agent de code).
 */

type ModeBadge = "sandbox" | "simulation" | null;

interface TerminalEntry {
  command: string;

  success?: boolean;

  stdout?: string;

  stderr?: string;

  exitCode?: number;

  durationMs?: number;

  mode?: ModeBadge;

  engine?: string | null;

  error?: string;
}

interface SimulationResult {
  success: boolean;

  stdout: string;

  stderr: string;

  exitCode: number;

  durationMs: number;

  mode: ModeBadge;

  simulation: { engine: string; trace: string[]; warnings: string[] } | null;
}

const SAMPLE_PYTHON = `import json

def prix_avec_marge(prix_fournisseur, marge=0.2):
    return round(prix_fournisseur * (1 + marge), 2)

print('5.00 -> 6.00 ?')`;

const SAMPLE_NODE = `const panier = [5, 6, 12].reduce((a, b) => a + b, 0);
console.log('total panier:', panier);`;

export function ConsoleWorkshop() {
  const [tab, setTab] = useState<"terminal" | "simulation">("terminal");
  const [backend, setBackend] = useState<{ sandboxDeployed: boolean } | null>(null);

  // --- Terminal ---
  const [command, setCommand] = useState("");
  const [history, setHistory] = useState<TerminalEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [cwd, setCwd] = useState("/workspace");
  const historyEndRef = useRef<HTMLDivElement | null>(null);

  // --- Simulation ---
  const [runtime, setRuntime] = useState<"node" | "python" | "shell">("node");
  const [code, setCode] = useState(SAMPLE_NODE);
  const [simResult, setSimResult] = useState<SimulationResult | null>(null);
  const [simBusy, setSimBusy] = useState(false);
  const [simError, setSimError] = useState("");

  useEffect(() => {
    // Le badge de backend est mis à jour après la première commande —
    // l'information exacte (sandbox déployé ou non) vient du serveur.
    setBackend(null);
  }, []);

  const scrollHistory = useCallback(() => {
    requestAnimationFrame(() => {
      historyEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    });
  }, []);

  async function runCommand() {
    const value = command.trim();
    if (!value || busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await authFetch("/api/developer/terminal", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: value, cwd, timeoutMs: 30_000 }),
      });
      const data = await response.json();
      setBackend({ sandboxDeployed: Boolean(data.backend?.sandboxDeployed) });
      if (!response.ok) {
        setHistory((current) => [...current, { command: value, error: data.error || "Commande refusée." }]);
      } else {
        setHistory((current) => [
          ...current,
          {
            command: value,
            success: data.success,
            stdout: data.stdout,
            stderr: data.stderr,
            exitCode: data.exitCode,
            durationMs: data.durationMs,
            mode: data.mode,
            engine: data.simulation?.engine ?? null,
          },
        ]);
      }
      setCommand("");
      scrollHistory();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Terminal indisponible.");
    } finally {
      setBusy(false);
    }
  }

  function onTerminalKey(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void runCommand();
    }
  }

  async function runSimulation() {
    if (!code.trim() || simBusy) return;
    setSimBusy(true);
    setSimError("");
    setSimResult(null);
    try {
      const response = await authFetch("/api/developer/simulation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runtime, code, timeoutMs: 5_000 }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Simulation impossible.");
      setSimResult(data as SimulationResult);
    } catch (e) {
      setSimError(e instanceof Error ? e.message : "Simulation impossible.");
    } finally {
      setSimBusy(false);
    }
  }

  return (
    <section className="g3-console" aria-label="Console de code">
      <header className="g3-console-head">
        <div className="g3-console-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === "terminal"} className={tab === "terminal" ? "is-active" : ""} onClick={() => setTab("terminal")}>
            Terminal
          </button>
          <button type="button" role="tab" aria-selected={tab === "simulation"} className={tab === "simulation" ? "is-active" : ""} onClick={() => setTab("simulation")}>
            Simulation de code
          </button>
        </div>
        {backend && (
          <span className={"g3-console-backend " + (backend.sandboxDeployed ? "is-real" : "is-simulated")}>
            {backend.sandboxDeployed ? "Sandbox Docker connecté — exécution réelle isolée" : "Sandbox Docker non déployé — simulation intégrée"}
          </span>
        )}
      </header>

      {tab === "terminal" ? (
        <div className="g3-console-terminal">
          <div className="g3-console-output" aria-live="polite">
            {history.length === 0 && <p className="g3-console-empty">Aucune commande. Exemples : <code>ls -la</code>, <code>node script.js</code>, <code>git status</code>.</p>}
            {history.map((entry, index) => (
              <article key={index} className={"g3-console-entry " + (entry.error ? "is-error" : entry.success ? "is-ok" : "is-fail")}>
                <div className="g3-console-entry-cmd">
                  <span className="g3-console-prompt">$</span>
                  <code>{entry.command}</code>
                  {entry.mode && <small className={"g3-console-mode " + (entry.mode === "sandbox" ? "is-real" : "is-simulated")}>{entry.mode === "sandbox" ? "exécution réelle" : (entry.engine ?? "simulation")}</small>}
                  {typeof entry.exitCode === "number" && <small className={entry.exitCode === 0 ? "is-ok" : "is-fail"}>exit {entry.exitCode} · {entry.durationMs} ms</small>}
                </div>
                {entry.stdout && <pre>{entry.stdout}</pre>}
                {entry.stderr && <pre className="is-stderr">{entry.stderr}</pre>}
                {entry.error && <pre className="is-stderr">{entry.error}</pre>}
              </article>
            ))}
            <div ref={historyEndRef} />
          </div>

          <div className="g3-console-input">
            <span className="g3-console-prompt">$</span>
            <textarea
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              onKeyDown={onTerminalKey}
              placeholder="Commande… (Entrée pour exécuter, Maj+Entrée pour un retour à la ligne)"
              rows={2}
              maxLength={50_000}
              disabled={busy}
              aria-label="Commande du terminal"
            />
            <button type="button" onClick={() => void runCommand()} disabled={busy || !command.trim()}>
              {busy ? "…" : "Exécuter"}
            </button>
          </div>
          <div className="g3-console-meta">
            <label>
              Répertoire de travail
              <input value={cwd} onChange={(event) => setCwd(event.target.value)} maxLength={500} aria-label="Répertoire de travail" />
            </label>
            <small>Commandes contrôlées par la politique de sécurité Gen3ia (deny-list stricte, réseau désactivé).</small>
          </div>
        </div>
      ) : (
        <div className="g3-console-simulation">
          <div className="g3-console-sim-toolbar">
            <label>
              Moteur
              <select value={runtime} onChange={(event) => setRuntime(event.target.value as typeof runtime)}>
                <option value="node">Node.js — VM V8 restreinte (exécution réelle, contexte gelé)</option>
                <option value="python">Python — analyse statique structurée</option>
                <option value="shell">Shell — dry-run commandé par commande</option>
              </select>
            </label>
            <div className="g3-console-sim-samples">
              <button type="button" onClick={() => { setRuntime("node"); setCode(SAMPLE_NODE); }}>Ex. Node</button>
              <button type="button" onClick={() => { setRuntime("python"); setCode(SAMPLE_PYTHON); }}>Ex. Python</button>
            </div>
            <button type="button" className="g3-console-sim-run" onClick={() => void runSimulation()} disabled={simBusy || !code.trim()}>
              {simBusy ? "Simulation…" : "Simuler"}
            </button>
          </div>

          <textarea
            className="g3-console-editor"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            rows={14}
            spellCheck={false}
            maxLength={500_000}
            aria-label="Code à simuler"
          />

          {simError && <div className="g3-console-sim-error" role="alert">{simError}</div>}

          {simResult && (
            <div className={"g3-console-sim-result " + (simResult.success ? "is-ok" : "is-fail")}>
              <header>
                <strong>{simResult.success ? "Simulation réussie" : "Simulation en échec"}</strong>
                <span>
                  moteur {simResult.simulation?.engine ?? simResult.mode} · exit {simResult.exitCode} · {simResult.durationMs} ms
                </span>
              </header>
              {simResult.stdout && <pre>{simResult.stdout}</pre>}
              {simResult.stderr && <pre className="is-stderr">{simResult.stderr}</pre>}
              {simResult.simulation && simResult.simulation.trace.length > 0 && (
                <div>
                  <strong>Trace</strong>
                  <pre>{simResult.simulation.trace.join("\n")}</pre>
                </div>
              )}
              {simResult.simulation && simResult.simulation.warnings.length > 0 && (
                <div className="g3-console-sim-warnings">
                  <strong>Avertissements</strong>
                  <ul>{simResult.simulation.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {error && <div className="g3-console-error" role="alert">{error}</div>}
    </section>
  );
}
