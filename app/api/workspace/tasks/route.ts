import { NextRequest,NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { createWorkspaceTask,listWorkspaceTasks } from "@/lib/agents/workspace";
import { acceptanceToOutcomeContract, contractForTemplate } from "@/lib/missions/templates";
const Schema=z.object({objective:z.string().min(3).max(20000),/** Organisation propriétaire (Task 58) — l'appelant doit en être membre (validé par le dépôt avant la transaction). */ orgId:z.string().trim().min(1).max(128).optional(),/** Système mission avancé : modèle professionnel choisi (critères d'acceptation traduits en contrat de résultat). */ templateId:z.string().trim().min(1).max(64).optional()});
export async function GET(request:NextRequest){
  try{
    const user=await requireUser(request);
    const raw=Number(new URL(request.url).searchParams.get("limit")??"12");
    const limit=Number.isFinite(raw)?Math.min(Math.max(Math.floor(raw),1),50):12;
    return NextResponse.json({success:true,tasks:await listWorkspaceTasks(user.uid,limit)});
  }catch(e){return NextResponse.json(errorBody(e,"Unable to load tasks"),{status:errorStatus(e)});}
}

export async function POST(request:NextRequest){try{const user=await requireUser(request);const body=Schema.parse(await request.json());// SYSTÈME MISSION AVANCÉ : un modèle professionnel porte un contrat de
// résultat (critères d'acceptation déterministes) — la mission ne sera
// « Terminée » que si les critères sont satisfaits (porte de sortie runtime).
const acceptance=body.templateId?contractForTemplate(body.templateId):undefined;
const contract=acceptance?acceptanceToOutcomeContract(acceptance):undefined;
return NextResponse.json({success:true,task:await createWorkspaceTask(user.uid,body.objective,{...(body.orgId?{orgId:body.orgId}:{}),...(contract?{outcomeContract:contract}:{}),...(body.templateId?{templateId:body.templateId}:{})})},{status:201});}catch(e){return NextResponse.json(errorBody(e,"Task creation failed"),{status:errorStatus(e,400)});}}