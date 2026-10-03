import { NextRequest,NextResponse } from "next/server";
import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { getWorkspaceTask, resolveStaleRunningTask } from "@/lib/agents/workspace";

/**
 * Détail d'une tâche workspace. Un statut « running » orphelin (fonction
 * serveur tuée avant sa finalisation — kill plateforme, déploiement) est
 * résolu en « paused » après le délai de staleness : la reprise reste
 * possible au lieu d'une tâche fantôme bloquée pour toujours
 * (exigence production : la tâche ne doit jamais être perdue).
 */
export async function GET(request:NextRequest,{params}:{params:Promise<{id:string}>}){
  try{
    const user=await requireUser(request);
    const {id}=await params;
    const task=await resolveStaleRunningTask(user.uid,id).catch(()=>null) ?? await getWorkspaceTask(user.uid,id);
    return NextResponse.json({task});
  }catch(e){
    return NextResponse.json(errorBody(e,"Task not found"),{status:errorStatus(e,404)});
  }
}
