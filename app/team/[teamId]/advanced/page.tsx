'use client';

import { useCallback, useState } from 'react';
import { useParams } from 'next/navigation';
import { useSessionAvailable, authFetch } from '@/lib/firebase/auth-client';
import { FeatureAuthGate } from '@/components/auth/feature-auth-gate';

const MAX_OBJECTIVE_LENGTH = 20000;
const ALLOWED_PATHS = new Set(['orchestrator', 'memory', 'prediction']);
type AdvancedPath = 'orchestrator' | 'memory' | 'prediction';

export default function TeamAdvancedPage() {
  const sessionDisponible = useSessionAvailable();
  const params = useParams<{ teamId: string }>();
  const teamId = typeof params?.teamId === 'string' ? params.teamId.trim() : '';
  const [objective, setObjective] = useState(''); const [result, setResult] = useState<unknown>(null); const [busy, setBusy] = useState(false); const [error, setError] = useState('');

  const call = useCallback(async (path: AdvancedPath, body: Record<string, unknown>) => {
    if (sessionDisponible === false) { setError('Connexion requise'); return; }
    if (!teamId || teamId.length > 200 || /[/.#\[\]\\]/.test(teamId) || !ALLOWED_PATHS.has(path)) { setError('Contexte d’équipe invalide'); return; }
    setBusy(true); setError(''); setResult(null); const controller = new AbortController(); const timeout = window.setTimeout(() => controller.abort(), 60_000);
    try {
      // authFetch : ID token Firebase si disponible, sinon cookie de session.
      const response = await authFetch(`/api/team/${encodeURIComponent(teamId)}/${path}`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body), signal:controller.signal, credentials:'same-origin' });
      const contentType=response.headers.get('content-type')??''; const data:unknown=contentType.includes('application/json')?await response.json():{error:await response.text()};
      if(!response.ok){const message=typeof data==='object'&&data!==null&&'error'in data&&typeof data.error==='string'?data.error:'Erreur serveur';throw new Error(message);} setResult(data);
    } catch(e){setError(e instanceof DOMException&&e.name==='AbortError'?'La requête a expiré. Réessayez.':e instanceof Error?e.message:'Erreur inconnue');} finally{window.clearTimeout(timeout);setBusy(false);}
  },[teamId, sessionDisponible]);

  if (sessionDisponible === null) return <div className="min-h-full bg-[var(--g3-bg)] p-10 text-center text-neutral-500">Chargement…</div>;
  if (sessionDisponible === false) return <FeatureAuthGate feature="Studio d’équipe Gen3ia" description="Connectez-vous pour accéder à la coordination multi-agent, à la mémoire d’équipe et à l’analyse préventive des risques."><span/></FeatureAuthGate>;
  const safeObjective=objective.trim().slice(0,MAX_OBJECTIVE_LENGTH);
  return <div className="mx-auto max-w-5xl space-y-8 p-8"><header><p className="text-sm font-medium text-sky-700">Espace équipe</p><h1 className="font-serif text-3xl font-semibold">Intelligence d’équipe avancée</h1><p className="mt-2 text-gray-500">Coordination multi-agent, mémoire de travail optimisée et anticipation des échecs. L’accès aux opérations est réservé aux membres authentifiés de cette équipe.</p></header>
    <section className="space-y-4 rounded-3xl border border-[rgba(23,23,20,0.09)] bg-white p-6 shadow-[0_2px_10px_rgba(15,23,42,0.05)]"><h2 className="font-serif text-xl font-semibold">Coordination automatique</h2><textarea value={objective} onChange={e=>setObjective(e.target.value.slice(0,MAX_OBJECTIVE_LENGTH))} placeholder="Objectif à exécuter par l’équipe d’agents…" className="g3-textarea min-h-32 w-full" maxLength={MAX_OBJECTIVE_LENGTH}/><button disabled={busy||!safeObjective} onClick={()=>void call('orchestrator',{objective:safeObjective})} className="g3-btn g3-btn-primary">{busy?'Exécution…':'Lancer la coordination'}</button></section>
    <section className="space-y-4 rounded-3xl border border-[rgba(23,23,20,0.09)] bg-white p-6 shadow-[0_2px_10px_rgba(15,23,42,0.05)]"><h2 className="font-serif text-xl font-semibold">Réduction de la charge cognitive</h2><p className="text-sm text-gray-500">Déduplication, priorisation et compression du contexte avant transmission aux agents.</p><button disabled={busy} onClick={()=>void call('memory',{objective:safeObjective,memories:[],recentMessages:[],decisions:[],constraints:[]})} className="g3-btn g3-btn-ghost">Optimiser le contexte</button></section>
    <section className="space-y-4 rounded-3xl border border-[rgba(23,23,20,0.09)] bg-white p-6 shadow-[0_2px_10px_rgba(15,23,42,0.05)]"><h2 className="font-serif text-xl font-semibold">Anticipation des échecs</h2><p className="text-sm text-gray-500">Détection préventive des risques liés aux effets de bord, retries, délais, réseau, terminal et actions à fort impact.</p><button disabled={busy} onClick={()=>void call('prediction',{steps:[{id:'team-objective',type:'llm',timeoutMs:120000,maxRetries:2,sideEffect:false,requiresApproval:false}]})} className="g3-btn g3-btn-ghost">Analyser les risques</button></section>
    {error&&<div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-600">{error}</div>}{result!==null&&<pre className="max-h-[32rem] overflow-auto rounded-xl bg-gray-950 p-5 text-xs text-white">{JSON.stringify(result,null,2)}</pre>}
  </div>;
}
