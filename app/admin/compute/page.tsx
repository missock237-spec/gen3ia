"use client";

/**
 * DASHBOARD COMPUTE (mission Phase 11) — supervision administrative du
 * moteur de calcul central. OBSERVATION UNIQUEMENT : ce tableau de bord
 * n'est jamais un second moteur de décision. Responsive (mobile/tablette/
 * desktop), données réelles de GET /api/admin/compute, contrôles limités
 * aux configurations autorisées (profil énergétique, reset du breaker).
 */

import { useCallback, useEffect, useState } from "react";

interface VueAdmin {
  profil: string;
  capacites: { webgpuDisponible: boolean; raisonIndisponibilite?: string; adaptateur?: string; environnement: string };
  capacitesCpu: { cœursLogiques: number; memoireDisponibleOctets?: number; contraintes: string[] };
  metrics: {
    parMoteur: Record<string, number>;
    fallbacks: number;
    executions: number;
    dureeMoyenneMs: number;
    dureeP50Ms: number;
    dureeP95Ms: number;
    recentes: Array<{ nomTache: string; moteur: string; dureeMs: number; fallback: boolean; energie: { valeur: number; nature: string; unite: string } }>;
  };
  gpu: {
    device: string;
    raison?: string;
    adaptateur?: string;
    pertes: number;
    memoireGen3ia: { budgetOctets: number; octetsUtilises: number; refus: number; peakOctets: number };
    buffersEnPool: { allocations: number; reutilisations: number; octetsActifs: number };
    pipelinesEnCache: number;
  };
  securite: { breaker: string; echecsGpuConsecutifs: number; seuilOuverture: number; tachesEnCours: string[]; erreursRecentes: Array<{ type: string; message: string }> };
}

const PROFILS = ["ECO", "BALANCED", "PERFORMANCE", "MOBILE", "SERVER"] as const;

export default function PageAdminCompute() {
  const [vue, setVue] = useState<VueAdmin | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [enChargement, setEnChargement] = useState(true);

  const charger = useCallback(async () => {
    setEnChargement(true);
    try {
      const res = await fetch("/api/admin/compute", { cache: "no-store" });
      const corps = await res.json();
      if (!res.ok) throw new Error(corps?.error ?? `HTTP ${res.status}`);
      setVue(corps.etat);
      setErreur(null);
    } catch (e) {
      setErreur(e instanceof Error ? e.message : "erreur");
    } finally {
      setEnChargement(false);
    }
  }, []);

  useEffect(() => {
    void charger();
    const minuteur = setInterval(() => void charger(), 10_000);
    return () => clearInterval(minuteur);
  }, [charger]);

  const changerProfil = async (profil: string) => {
    await fetch("/api/admin/compute", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profil }),
    });
    void charger();
  };

  const reinitialiserBreaker = async () => {
    await fetch("/api/admin/compute", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "reinitialiser-breaker" }),
    });
    void charger();
  };

  if (erreur) {
    return <main style={{ maxWidth: 960, margin: "2rem auto", padding: "0 1rem" }}>Accès refusé ou erreur : {erreur}</main>;
  }
  if (!vue) {
    return <main style={{ maxWidth: 960, margin: "2rem auto", padding: "0 1rem" }}>{enChargement ? "Chargement…" : "Aucune donnée"}</main>;
  }

  const mo = (o: number | undefined) => (o === undefined ? "—" : `${Math.round(o / 1024 / 1024)} Mo`);

  return (
    <main style={{ maxWidth: 1100, margin: "0 auto", padding: "clamp(0.75rem, 3vw, 2rem)" }}>
      <h1 style={{ fontSize: "clamp(1.4rem, 4vw, 2rem)" }}>Moteur de calcul central — supervision</h1>

      <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "0.75rem", margin: "1rem 0" }}>
        <Carte titre="CPU">
          <p>{vue.capacitesCpu.cœursLogiques} cœurs logiques · {mo(vue.capacitesCpu.memoireDisponibleOctets)} RSS</p>
          {vue.capacitesCpu.contraintes.map((c) => <p key={c} style={{ color: "#555" }}>{c}</p>)}
        </Carte>
        <Carte titre="GPU / WebGPU">
          <p>device : <strong>{vue.gpu.device}</strong>{vue.gpu.adaptateur ? ` (${vue.gpu.adaptateur})` : ""}</p>
          {vue.gpu.raison && <p style={{ color: "#555" }}>{vue.gpu.raison}</p>}
          <p>pertes : {vue.gpu.pertes} · pipelines : {vue.gpu.pipelinesEnCache} · buffers en pool : {vue.gpu.buffersEnPool.reutilisations} réutilisations</p>
          <p>mémoire Gen3ia : {mo(vue.gpu.memoireGen3ia.octetsUtilises)} / {mo(vue.gpu.memoireGen3ia.budgetOctets)} (refus : {vue.gpu.memoireGen3ia.refus})</p>
        </Carte>
        <Carte titre="Répartition des exécutions">
          <p>CPU {vue.metrics.parMoteur.cpu ?? 0} · GPU {vue.metrics.parMoteur.webgpu ?? 0} · hybride {vue.metrics.parMoteur.hybride ?? 0} · fallbacks {vue.metrics.fallbacks}</p>
          <p>p50 {vue.metrics.dureeP50Ms} ms · p95 {vue.metrics.dureeP95Ms} ms · moyen {vue.metrics.dureeMoyenneMs} ms</p>
        </Carte>
        <Carte titre="Sécurité">
          <p>circuit breaker : <strong>{vue.securite.breaker}</strong> ({vue.securite.echecsGpuConsecutifs}/{vue.securite.seuilOuverture})</p>
          <p>tâches en cours : {vue.securite.tachesEnCours.length}</p>
          <button onClick={() => void reinitialiserBreaker()} style={{ marginTop: "0.5rem", padding: "0.4rem 0.8rem", cursor: "pointer" }}>
            Réinitialiser le breaker
          </button>
        </Carte>
      </section>

      <section style={{ margin: "1rem 0" }}>
        <h2 style={{ fontSize: "1.1rem" }}>Profil énergétique actif : <strong>{vue.profil}</strong></h2>
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          {PROFILS.map((p) => (
            <button key={p} onClick={() => void changerProfil(p)} disabled={p === vue.profil}
              style={{ padding: "0.4rem 0.9rem", cursor: p === vue.profil ? "default" : "pointer", opacity: p === vue.profil ? 0.6 : 1 }}>
              {p}
            </button>
          ))}
        </div>
      </section>

      <section style={{ margin: "1rem 0" }}>
        <h2 style={{ fontSize: "1.1rem" }}>Historique récent ({vue.metrics.recentes.length} exécutions)</h2>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 520 }}>
            <thead>
              <tr>{["Tâche", "Moteur", "Durée", "Fallback", "Énergie"].map((h) => <th key={h} style={{ textAlign: "left", borderBottom: "1px solid #ccc", padding: "0.4rem" }}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {vue.metrics.recentes.map((m, i) => (
                <tr key={`${m.nomTache}-${i}`}>
                  <td style={{ padding: "0.35rem" }}>{m.nomTache}</td>
                  <td style={{ padding: "0.35rem" }}>{m.moteur}</td>
                  <td style={{ padding: "0.35rem" }}>{m.dureeMs} ms</td>
                  <td style={{ padding: "0.35rem" }}>{m.fallback ? "oui" : "—"}</td>
                  <td style={{ padding: "0.35rem" }}>{m.energie.valeur} {m.energie.unite} ({m.energie.nature})</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p style={{ color: "#555", fontSize: "0.85rem" }}>
          Énergie : estimations relatives explicitées (« estimee ») — aucune mesure physique en joules tant qu&apos;aucun compteur matériel fiable n&apos;expose les données (mission Phase 7).
        </p>
      </section>

      {vue.securite.erreursRecentes.length > 0 && (
        <section style={{ margin: "1rem 0" }}>
          <h2 style={{ fontSize: "1.1rem" }}>Erreurs GPU récentes</h2>
          <ul>{vue.securite.erreursRecentes.map((e, i) => <li key={i}><strong>{e.type}</strong> — {e.message}</li>)}</ul>
        </section>
      )}
    </main>
  );
}

function Carte(props: { titre: string; children: React.ReactNode }) {
  return (
    <div style={{ border: "1px solid #ddd", borderRadius: 10, padding: "0.9rem", background: "#fafafa" }}>
      <h3 style={{ marginTop: 0, fontSize: "1rem" }}>{props.titre}</h3>
      {props.children}
    </div>
  );
}
