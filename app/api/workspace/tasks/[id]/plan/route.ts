import { NextRequest, NextResponse } from "next/server";
import { errorStatus } from "@/lib/security/http-errors";
import { z } from "zod";
import { requireUser } from "@/lib/security/authenticated-request";
import { updateWorkspacePlan } from "@/lib/agents/workspace";
import { RuntimePlanSchema } from "@/lib/agents/runtime";

const Schema=z.object({plan:RuntimePlanSchema});

export async function PUT(request:NextRequest,{params}:{params:Promise<{id:string}>}) {
  try {
    const user=await requireUser(request);
    const {id}=await params;
    const body=Schema.safeParse(await request.json());
    if(!body.success)return NextResponse.json({error:body.error.flatten()},{status:400});
    const task=await updateWorkspacePlan(user.uid,id,body.data.plan);
    return NextResponse.json({success:true,task});
  } catch(error) {
    return NextResponse.json({error:error instanceof Error?error.message:"Unable to update plan"},{status: errorStatus(error, 400)});
  }
}
