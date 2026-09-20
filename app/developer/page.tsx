"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { type User } from "firebase/auth";
import { watchAuth } from "@/lib/firebase/client";
import { authFetch, useSessionAvailable } from "@/lib/firebase/auth-client";

type Tab = "overview" | "projects" | "build" | "connectors" | "keys" | "extensions" | "monitor";
type Project = { id:string; name:string; slug:string; description:string; framework:string; environment:string; status:string; updatedAt:number };
type ApiKey = { prefix:string; name:string; status:string; createdAt:number; projectId?:string|null };
type Extension = { id:string; name:string; status:string; latestVersion:string|null; stats:{installs:number;executions:number}; permissions:string[] };
type Revenue = { totalNetMinor:number; currency:string; totalGrossMinor:number; totalFeeMinor:number; entries:number };
type Connector = { toolkit:string; label:string; description:string; logo?:string|null; categories?:string[]; authSchemes?:string[]; managedBy?:string };
type ProjectConnector = { id:string; toolkit:string; connectionId:string; status:string; updatedAt:number };


const TEMPLATE = JSON.stringify({
  id:"mon-extension", name:"Mon Extension", version:"1.0.0", author:"Moi",
  description:"Extension Gen3ia", category:"productivity", tags:["gen3ia"],
  permissions:["http.fetch:api.exemple.com"],
  secrets:{api_key:{description:"Clé API externe"}},
  tools:[{id:"search",name:"Recherche",description:"Interroge mon API",inputSchema:{query:{type:"string",required:true}},outputSchema:{result:{type:"string"}},endpoint:{method:"GET",url:"https://api.exemple.com/search?q={{input.query}}",headers:[{name:"Authorization",value:"Bearer {{secret.api_key}}"}],timeoutMs:8000}}],
  skills:[], workflows:[], settings:[], pricing:{model:"free",maxExecutionsPerDay:100}
},null,2);

export default function DeveloperPage(){
  const session = useSessionAvailable();
  const [user,setUser]=useState<User|null>(null);
  const [tab,setTab]=useState<Tab>("overview");
  const [projects,setProjects]=useState<Project[]>([]);
  const [keys,setKeys]=useState<ApiKey[]>([]);
  const [extensions,setExtensions]=useState<Extension[]>([]);
  const [revenue,setRevenue]=useState<Revenue|null>(null);
  const [selectedProject,setSelectedProject]=useState("");
  const [newProject,setNewProject]=useState({name:"",description:"",framework:"nextjs"});
  const [manifest,setManifest]=useState(TEMPLATE);
  const [newKey,setNewKey]=useState("");
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState("");
  const [resourceSummary,setResourceSummary]=useState<{extensions:number;activeApiKeys:number;executions:number;installations:number;approvedExtensions:number;draftExtensions:number}|null>(null);
  const [connectors,setConnectors]=useState<Connector[]>([]);
  const [projectConnectors,setProjectConnectors]=useState<ProjectConnector[]>([]);
  const [connectorSearch,setConnectorSearch]=useState("");
  const [connectorNextCursor,setConnectorNextCursor]=useState<string|null>(null);

  const api=useCallback(async(path:string,init?:RequestInit)=>{
    return authFetch(path,{...init,headers:{"content-type":"application/json",...(init?.headers??{})}});
  },[]);

  const loadConnectors=useCallback(async(search=connectorSearch)=>{
    const all: Connector[] = [];
    let cursor: string | undefined;
    for(let page=0; page<20; page++){
      const q=new URLSearchParams({limit:"1000"});
      if(search.trim())q.set("search",search.trim());
      if(cursor)q.set("cursor",cursor);
      const response=await api("/api/integrations/catalog?"+q.toString());
      if(!response.ok)break;
      const data=await response.json();
      if(Array.isArray(data.items)) all.push(...data.items);
      const next=typeof data.nextCursor==="string"&&data.nextCursor?data.nextCursor:"";
      if(!next || next===cursor) { cursor=undefined; break; }
      cursor=next;
    }
    const unique=new Map<string,Connector>();
    for(const item of all){ if(item?.toolkit) unique.set(item.toolkit,item); }
    setConnectors(Array.from(unique.values()));
    setConnectorNextCursor(null);
  },[api,connectorSearch]);

  const [projectTools,setProjectTools]=useState<Array<{slug:string;name?:string;description?:string;toolkit?:string}>>([]);
  const [toolSearch,setToolSearch]=useState("");
  const loadProjectTools=useCallback(async(search=toolSearch)=>{
    if(!selectedProject){setProjectTools([]);return;}
    const q=search.trim()?"?search="+encodeURIComponent(search.trim()):"";
    const r=await api("/api/developer/projects/"+encodeURIComponent(selectedProject)+"/connectors/tools"+q);
    if(r.ok){const d=await r.json();const raw=d.tools?.items??d.tools??[];setProjectTools(raw.map((x:any)=>({slug:x.slug??x.toolSlug??x.name??"unknown",name:x.name??x.displayName,description:x.description,toolkit:x.toolkit??x.toolkit_slug})));}
  },[api,selectedProject,toolSearch]);

  const loadProjectConnectors=useCallback(async()=>{if(!selectedProject){setProjectConnectors([]);return;}const r=await api(`/api/developer/projects/${encodeURIComponent(selectedProject)}/connectors`);if(r.ok)setProjectConnectors((await r.json()).connectors??[]);},[api,selectedProject]);

  const connectToolkit=async(toolkit:string)=>{if(!selectedProject){setMessage("Sélectionne un projet avant de connecter une application.");setTab("projects");return;}setBusy(true);try{const r=await api("/api/integrations/composio/connect",{method:"POST",body:JSON.stringify({toolkit,projectId:selectedProject})});const d=await r.json();if(!r.ok)throw new Error(d.error);if(d.authorizationUrl)window.location.assign(d.authorizationUrl);else await loadProjectConnectors();}catch(e){setMessage(e instanceof Error?e.message:"Connexion impossible");}finally{setBusy(false);}};

  const load=useCallback(async()=>{
    const [p,k,e,r]=await Promise.all([api("/api/developer/projects"),api("/api/developer/api-keys"),api(`/api/developer/extensions?projectId=${encodeURIComponent(selectedProject)}`),api("/api/developer/revenue")]);
    if(p.ok){const d=await p.json();setProjects(d.projects??[]);if(!selectedProject&&d.projects?.[0])setSelectedProject(d.projects[0].id);}
    if(k.ok)setKeys((await k.json()).keys??[]);
    if(e.ok)setExtensions((await e.json()).extensions??[]);
    if(r.ok)setRevenue((await r.json()).revenue??null);
    if(selectedProject){const rr=await api(`/api/developer/projects/${encodeURIComponent(selectedProject)}/resources`);if(rr.ok)setResourceSummary((await rr.json()).summary??null);}
  },[api,selectedProject]);

  useEffect(()=>{const u=watchAuth(x=>setUser(x));return()=>u();},[]);
  useEffect(()=>{void load();},[load]);
  useEffect(()=>{if(tab==="connectors"){void loadConnectors();void loadProjectConnectors();void loadProjectTools();}},[tab,loadConnectors,loadProjectConnectors,loadProjectTools]);

  const createProject=async()=>{
    setBusy(true);setMessage("");
    try{const r=await api("/api/developer/projects",{method:"POST",body:JSON.stringify(newProject)});const d=await r.json();if(!r.ok)throw new Error(d.error);setProjects(x=>[d.project,...x]);setSelectedProject(d.project.id);setNewProject({name:"",description:"",framework:"nextjs"});setMessage("Projet Gen3ia créé.");setTab("projects");}
    catch(e){setMessage(e instanceof Error?e.message:"Création impossible");}finally{setBusy(false);}
  };

  const createKey=async()=>{
    if(!selectedProject){setMessage("Sélectionne un projet Gen3ia.");setTab("projects");return;}
    setBusy(true);setMessage("");
    try{const r=await api("/api/developer/api-keys",{method:"POST",body:JSON.stringify({name:"SDK",projectId:selectedProject})});const d=await r.json();if(!r.ok)throw new Error(d.error);setNewKey(d.key);await load();setMessage("Clé créée : elle est liée au projet sélectionné.");}
    catch(e){setMessage(e instanceof Error?e.message:"Création impossible");}finally{setBusy(false);}
  };

  const revoke=async(prefix:string)=>{if(!confirm("Révoquer cette clé ?"))return;setBusy(true);try{const r=await api("/api/developer/api-keys",{method:"DELETE",body:JSON.stringify({prefix})});if(!r.ok)throw new Error((await r.json()).error);await load();setMessage("Clé révoquée.");}catch(e){setMessage(e instanceof Error?e.message:"Révocation impossible");}finally{setBusy(false);}};

  const createExtension=async()=>{
    setBusy(true);setMessage("");
    try{const parsed=JSON.parse(manifest);const r=await api("/api/extensions",{method:"POST",body:JSON.stringify({manifest:parsed,projectId:selectedProject})});const d=await r.json();if(!r.ok)throw new Error([d.error,...(d.details??[])].filter(Boolean).join(" — "));setMessage("Extension créée en brouillon.");await load();setTab("extensions");}
    catch(e){setMessage(e instanceof Error?e.message:"Manifest JSON invalide");}finally{setBusy(false);}
  };

  if(session===false)return <div className="flex min-h-full items-center justify-center p-6"><div className="rounded-3xl border bg-white p-8 text-center"><h1 className="text-2xl font-bold">Developer Studio</h1><p className="mt-2 text-sm text-neutral-500">Connectez-vous pour accéder à l&apos;espace développeur.</p><Link href="/login" className="mt-5 inline-flex rounded-full bg-neutral-900 px-5 py-3 text-sm text-white">Se connecter</Link></div></div>;

  const nav:[Tab,string,string][]=[["overview","⌂","Vue d'ensemble"],["projects","▦","Projets"],["build","＋","Build"],["connectors","◎","Connecteurs"],["keys","⚿","API & SDK"],["extensions","◇","Extensions"],["monitor","◷","Monitoring"]];
  const project=projects.find(p=>p.id===selectedProject);

  return <div className="min-h-full bg-[#f5f5f2] text-neutral-950"><div className="mx-auto flex min-h-full max-w-[1500px] flex-col lg:flex-row">
    <aside className="w-full border-b bg-[#11120f] p-4 text-white lg:min-h-screen lg:w-64 lg:border-b-0 lg:border-r lg:p-5">
      <Link href="/dashboard" className="flex items-center gap-2 text-lg font-bold"><span className="grid h-8 w-8 place-items-center rounded-xl bg-white text-black">G</span> Gen3ia</Link>
      <div className="mt-1 text-[10px] uppercase tracking-[.25em] text-neutral-500">Developer Studio</div>
      <nav className="mt-8 space-y-1">{nav.map(([id,icon,label])=><button key={id} onClick={()=>setTab(id)} className={"flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm "+(tab===id?"bg-white text-black":"text-neutral-400 hover:bg-neutral-800 hover:text-white")}><span className="w-5 text-center">{icon}</span>{label}</button>)}</nav>
      <div className="mt-8 border-t border-neutral-800 pt-5"><div className="text-[10px] uppercase tracking-widest text-neutral-600">Projet actif</div><select value={selectedProject} onChange={e=>setSelectedProject(e.target.value)} className="mt-2 w-full rounded-xl border border-neutral-700 bg-neutral-900 px-3 py-2 text-xs text-white"><option value="">Sélectionner</option>{projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
      <div className="mt-8 rounded-2xl border border-neutral-800 p-3 text-xs text-neutral-500">{user?.email||"Compte développeur"}</div>
    </aside>

    <main className="min-w-0 flex-1 p-5 md:p-8">
      <header className="mb-7 flex flex-col gap-4 md:flex-row md:items-end md:justify-between"><div><div className="text-xs font-semibold uppercase tracking-[.28em] text-sky-700">Gen3ia / Developer</div><h1 className="mt-2 text-3xl font-bold tracking-tight">{nav.find(x=>x[0]===tab)?.[2]}</h1><p className="mt-1 text-sm text-neutral-500">Construis, connecte, teste et déploie tes applications Gen3ia.</p></div><div className="flex gap-2"><Link href="/studio" className="rounded-xl border bg-white px-4 py-2 text-sm">Studio</Link><button onClick={()=>setTab("projects")} className="rounded-xl bg-black px-4 py-2 text-sm text-white">+ Nouveau projet</button></div></header>
      {message&&<div className="mb-5 rounded-2xl border border-sky-200 bg-sky-50 p-4 text-sm">{message}</div>}

      {tab==="overview"&&<section className="space-y-5">
        <div className="grid gap-4 md:grid-cols-4"><Card title="Projets" value={projects.length}/><Card title="Clés actives" value={resourceSummary?.activeApiKeys??keys.filter(k=>k.status==="active").length}/><Card title="Extensions" value={resourceSummary?.extensions??extensions.length}/><Card title="Revenus nets" value={revenue?((revenue.totalNetMinor/100).toLocaleString("fr-FR")+" "+revenue.currency):"—"}/></div>
        <div className="grid gap-5 lg:grid-cols-[1.4fr_.8fr]">
          <Panel title="Construire rapidement" subtitle="Les ressources sont persistées côté serveur."><div className="grid gap-3 sm:grid-cols-2">{[["Projet","Créer une application isolée","projects"],["API & SDK","Générer une clé liée à un projet","keys"],["Extension","Créer un tool déclaratif","extensions"],["Monitoring","Voir l'activité développeur","monitor"]].map(x=><button key={x[2]} onClick={()=>setTab(x[2] as Tab)} className="rounded-2xl border p-4 text-left hover:border-neutral-400"><div className="font-semibold">{x[0]}</div><div className="mt-1 text-xs text-neutral-500">{x[1]}</div></button>)}</div></Panel>
          <Panel title="Sécurité des clés" subtitle="Contrôle côté serveur"><div className="space-y-3"><Rule n="1" t="Chaque clé possède un projectId."/><Rule n="2" t="Chaque requête par clé doit envoyer X-Gen3ia-Project-Id."/><Rule n="3" t="Un projectId différent est refusé."/><Rule n="4" t="Une clé sans projet est refusée." /></div></Panel>
        </div>
      </section>}

      {tab==="projects"&&<section className="grid gap-5 lg:grid-cols-[.8fr_1.2fr]">
        <Panel title="Nouveau projet" subtitle="Un projet est l'unité de sécurité des clés."><div className="space-y-3"><input value={newProject.name} onChange={e=>setNewProject({...newProject,name:e.target.value})} placeholder="Nom du projet" className="w-full rounded-xl border p-3 text-sm"/><textarea value={newProject.description} onChange={e=>setNewProject({...newProject,description:e.target.value})} placeholder="Description" className="min-h-24 w-full rounded-xl border p-3 text-sm"/><select value={newProject.framework} onChange={e=>setNewProject({...newProject,framework:e.target.value})} className="w-full rounded-xl border p-3 text-sm"><option value="nextjs">Next.js</option><option value="node">Node.js</option><option value="python">Python</option><option value="other">Autre</option></select><button disabled={busy} onClick={createProject} className="w-full rounded-xl bg-black p-3 text-sm font-semibold text-white disabled:opacity-40">Créer le projet</button></div></Panel>
        <Panel title="Mes projets" subtitle="Projets enregistrés dans Gen3ia.">{projects.length===0?<Empty text="Aucun projet. Crée le premier à gauche."/>:<div className="space-y-2">{projects.map(p=><button key={p.id} onClick={()=>setSelectedProject(p.id)} className={"flex w-full items-center justify-between rounded-2xl border p-4 text-left "+(selectedProject===p.id?"border-sky-400 bg-sky-50":"bg-white")}><div><div className="font-semibold">{p.name}</div><div className="mt-1 text-xs text-neutral-500">{p.framework+" · "+p.environment+" · "+p.slug}</div></div><span className="rounded-full bg-neutral-100 px-2 py-1 text-[10px]">{p.status}</span></button>)}</div>}</Panel>
      </section>}

      {tab==="connectors"&&<section className="space-y-5"><Panel title="Connecteurs Composio" subtitle="Catalogue dynamique des applications disponibles dans Composio."><div className="flex gap-2"><input value={connectorSearch} onChange={e=>setConnectorSearch(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")void loadConnectors(e.currentTarget.value)}} placeholder="Rechercher une application..." className="flex-1 rounded-xl border p-3 text-sm"/><button onClick={()=>void loadConnectors(connectorSearch)} className="rounded-xl bg-black px-4 text-sm text-white">Rechercher</button></div><div className="mt-4 flex flex-wrap gap-2">{projectConnectors.map(c=><span key={c.id} className="rounded-full border bg-emerald-50 px-3 py-1.5 text-xs"><b>{c.toolkit}</b></span>)}</div><div className="mt-5 rounded-2xl border bg-neutral-50 p-4"><div className="font-semibold text-sm">Outils disponibles pour le projet</div><div className="mt-2 flex gap-2"><input value={toolSearch} onChange={e=>setToolSearch(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")void loadProjectTools(e.currentTarget.value)}} placeholder="Rechercher une action..." className="flex-1 rounded-xl border bg-white p-2.5 text-xs"/><button onClick={()=>void loadProjectTools(toolSearch)} className="rounded-xl border bg-white px-3 text-xs">Rechercher</button></div><div className="mt-3 grid gap-2 sm:grid-cols-2">{projectTools.slice(0,40).map((t,i)=><div key={t.slug+i} className="rounded-xl border bg-white p-3"><div className="font-mono text-[11px]">{t.slug}</div><div className="mt-1 text-xs text-neutral-500">{t.name||t.toolkit||"Composio tool"}</div></div>)}</div></div><div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{connectors.map(c=><div key={c.toolkit} className="rounded-2xl border p-4"><div className="flex items-center gap-3">{c.logo?<img src={c.logo} alt="" className="h-8 w-8 rounded-lg"/>:<div className="grid h-8 w-8 place-items-center rounded-lg bg-neutral-100 text-xs font-bold">{c.label.slice(0,1)}</div>}<div className="min-w-0"><div className="truncate font-semibold">{c.label}</div><div className="text-[10px] text-neutral-400">{c.toolkit}</div></div></div><p className="mt-3 line-clamp-2 text-xs text-neutral-500">{c.description||"Application Composio"}</p><button disabled={busy||projectConnectors.some(x=>x.toolkit===c.toolkit)} onClick={()=>void connectToolkit(c.toolkit)} className="mt-4 w-full rounded-xl bg-black px-3 py-2 text-xs font-semibold text-white disabled:opacity-40">{projectConnectors.some(x=>x.toolkit===c.toolkit)?"Connecté au projet":"Connecter au projet"}</button></div>)}</div>{connectorNextCursor&&<button onClick={()=>void loadConnectors(connectorSearch,connectorNextCursor)} className="mt-5 rounded-xl border bg-white px-4 py-2 text-sm">Charger 50 autres</button>}</Panel></section>}

      {tab==="keys"&&<section className="space-y-5"><Panel title="API & SDK" subtitle="Les clés Gen3ia ne sont pas globales : elles sont liées à un projet précis."><div className="flex flex-col gap-3 md:flex-row"><select value={selectedProject} onChange={e=>setSelectedProject(e.target.value)} className="flex-1 rounded-xl border p-3 text-sm"><option value="">Choisir le projet lié</option>{projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select><button disabled={busy||!selectedProject} onClick={createKey} className="rounded-xl bg-black px-5 py-3 text-sm font-semibold text-white disabled:opacity-40">Générer une clé</button></div>{newKey&&<div className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 p-4"><div className="text-xs font-semibold text-emerald-700">À copier maintenant — affichée une seule fois</div><code className="mt-2 block break-all font-mono text-xs">{newKey}</code></div>}</Panel>
        <Panel title="Clés existantes" subtitle="La révocation coupe immédiatement l'accès.">{keys.length===0?<Empty text="Aucune clé générée."/>:<div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b text-xs text-neutral-400"><th className="p-3">Clé</th><th className="p-3">Projet</th><th className="p-3">Statut</th><th className="p-3"></th></tr></thead><tbody>{keys.map(k=><tr key={k.prefix} className="border-b last:border-0"><td className="p-3 font-mono">{k.prefix}…</td><td className="p-3">{projects.find(p=>p.id===k.projectId)?.name||"Projet inconnu"}</td><td className="p-3">{k.status}</td><td className="p-3 text-right">{k.status==="active"&&<button onClick={()=>void revoke(k.prefix)} className="text-red-600">Révoquer</button>}</td></tr>)}</tbody></table></div>}</Panel>
        <Panel title="Contrat SDK" subtitle="Les deux éléments sont obligatoires pour une requête authentifiée par clé."><pre className="overflow-x-auto rounded-2xl bg-neutral-950 p-4 text-xs text-neutral-200">{"Authorization: Bearer g3x_...\nX-Gen3ia-Project-Id: <project_id>"}</pre></Panel>
      </section>}

      {tab==="build"&&<section className="grid gap-5 lg:grid-cols-[1.2fr_.8fr]"><Panel title="Extension / Tool Builder" subtitle="Création déclarative."><textarea value={manifest} onChange={e=>setManifest(e.target.value)} className="min-h-[520px] w-full rounded-2xl border bg-[#fbfbf9] p-4 font-mono text-xs" spellCheck={false}/><button disabled={busy} onClick={createExtension} className="mt-3 rounded-xl bg-black px-5 py-3 text-sm text-white">Créer le brouillon</button></Panel><Panel title="Surface développeur" subtitle="Modules"><div className="space-y-2">{["APIs & routes","Tools","Connecteurs OAuth","Extensions","Skills","Webhooks","Knowledge / RAG","Secrets","Sandbox","Evaluations","Deployments"].map(x=><div key={x} className="flex items-center justify-between rounded-xl border p-3 text-sm"><span>{x}</span><span className="text-xs text-neutral-400">{x==="Extensions"?"Disponible":"Workspace"}</span></div>)}</div></Panel></section>}

      {tab==="extensions"&&<section><Panel title="Extensions" subtitle="Versions, permissions, installations et exécutions.">{extensions.length===0?<Empty text="Aucune extension. Utilise Build pour créer la première."/>:<div className="grid gap-3 md:grid-cols-2">{extensions.map(e=><div key={e.id} className="rounded-2xl border p-4"><div className="flex justify-between"><b>{e.name}</b><span className="text-xs">{e.status}</span></div><div className="mt-2 text-xs text-neutral-500">{e.id+" · v"+(e.latestVersion||"—")}</div><div className="mt-3 text-xs">{e.stats.installs+" installations · "+e.stats.executions+" exécutions"}</div><div className="mt-3 flex flex-wrap gap-1">{e.permissions.map(p=><span key={p} className="rounded bg-neutral-100 px-2 py-1 font-mono text-[10px]">{p}</span>)}</div></div>)}</div>}</Panel></section>}

      {tab==="monitor"&&<section className="grid gap-5 md:grid-cols-3"><Card title="Exécutions extensions" value={extensions.reduce((n,e)=>n+e.stats.executions,0)}/><Card title="Installations" value={extensions.reduce((n,e)=>n+e.stats.installs,0)}/><Card title="Transactions" value={revenue?.entries??0}/><div className="md:col-span-3"><Panel title="Projet actif" subtitle={project?.name||"Aucun projet sélectionné"}><div className="text-sm text-neutral-600">{project?("ID: "+project.id+" · "+project.framework+" · "+project.environment):"Sélectionne un projet pour voir ses ressources."}</div>{resourceSummary&&<div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-5">{[["Extensions",resourceSummary.extensions],["Clés",resourceSummary.activeApiKeys],["Exécutions",resourceSummary.executions],["Installations",resourceSummary.installations],["Brouillons",resourceSummary.draftExtensions]].map(([label,value])=><div key={String(label)} className="rounded-xl bg-neutral-50 p-3"><div className="text-[10px] text-neutral-400">{label}</div><div className="mt-1 font-bold">{value}</div></div>)}</div>}</Panel></div></section>}
    </main>
  </div></div>;
}

function Card({title,value}:{title:string;value:string|number}){return <div className="rounded-3xl border bg-white p-5"><div className="text-xs text-neutral-500">{title}</div><div className="mt-2 text-2xl font-bold">{value}</div></div>}
function Panel({title,subtitle,children}:{title:string;subtitle?:string;children:React.ReactNode}){return <div className="rounded-3xl border bg-white p-6 shadow-sm"><h2 className="text-lg font-bold">{title}</h2>{subtitle&&<p className="mt-1 text-xs text-neutral-500">{subtitle}</p>}<div className="mt-5">{children}</div></div>}
function Empty({text}:{text:string}){return <div className="rounded-2xl border border-dashed p-8 text-center text-sm text-neutral-400">{text}</div>}
function Rule({n,t}:{n:string;t:string}){return <div className="flex gap-3"><span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-neutral-100 text-xs font-bold">{n}</span><span className="text-xs leading-5 text-neutral-600">{t}</span></div>}
