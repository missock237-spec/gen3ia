import { NextRequest,NextResponse } from "next/server";
import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { resolveStaleRunningTask } from "@/lib/agents/workspace";

/**
 * Détail d'une tâche workspace — lecture unique. Un statut « running »
 * orphelin (fonction serveur tuée avant sa finalisation — kill plateforme,
 * déploiement) est résolu en « paused » après le délai de staleness : la
 * reprise reste possible au lieu d'une tâche fantôme bloquée pour toujours
 * (exigence production : la tâche ne doit jamais être perdue).
 * La tâche LUE est retournée par resolveStaleRunningTask : l'ancien contrat
 * « null si pas concernée » forçait une seconde lecture du même document
 * (2 lectures Firestore par GET pour un détail affiché en boucle par le
 * polling UI — quota brûlé pour rien).
 */
export async function GET(request:NextRequest,{params}:{params:Promise<{id:string}>}){
  try{
    const user=await requireUser(request);
    const {id}=await params;
    const task=await resolveStaleRunningTask(user.uid,id);
    return NextResponse.json({task});
  }catch(e){
    return NextResponse.json(errorBody(e,"Task not found"),{status:errorStatus(e,404)});
  }
}
