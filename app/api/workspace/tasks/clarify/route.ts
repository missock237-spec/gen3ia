import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/security/authenticated-request";
import { errorStatus } from "@/lib/security/http-errors";
import { analyzePlanClarifications } from "@/lib/agents/planner/clarification";

const Schema=z.object({objective:z.string().trim().min(3).max(20000),context:z.string().max(20000).optional()});
export async function POST(request:NextRequest){
  try{
    await requireUser(request);
    const parsed=Schema.safeParse(await request.json());
    if(!parsed.success)return NextResponse.json({error:parsed.error.flatten()},{status:400});
    const clarification=await analyzePlanClarifications(parsed.data.objective,parsed.data.context);
    return NextResponse.json({success:true,...clarification});
  }catch(error){
    return NextResponse.json({error:error instanceof Error?error.message:"Clarification failed"},{status:errorStatus(error)});
  }
}