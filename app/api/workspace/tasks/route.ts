import { NextRequest,NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/security/authenticated-request";
import { errorStatus } from "@/lib/security/http-errors";
import { createWorkspaceTask,listWorkspaceTasks } from "@/lib/agents/workspace";
const Schema=z.object({objective:z.string().min(3).max(20000)});
export async function GET(request:NextRequest){
  try{
    const user=await requireUser(request);
    const raw=Number(new URL(request.url).searchParams.get("limit")??"12");
    const limit=Number.isFinite(raw)?Math.min(Math.max(Math.floor(raw),1),50):12;
    return NextResponse.json({success:true,tasks:await listWorkspaceTasks(user.uid,limit)});
  }catch(e){return NextResponse.json({error:e instanceof Error?e.message:"Unable to load tasks"},{status:errorStatus(e)});}
}

export async function POST(request:NextRequest){try{const user=await requireUser(request);const body=Schema.parse(await request.json());return NextResponse.json({success:true,task:await createWorkspaceTask(user.uid,body.objective)},{status:201});}catch(e){return NextResponse.json({error:e instanceof Error?e.message:"Task creation failed"},{status:errorStatus(e,400)});}}