import "server-only";

import { adminDb } from "@/lib/firebase/admin";

export type TeamFeature = "orchestrator" | "memory" | "prediction";
export type TeamRole = "owner" | "admin" | "editor" | "viewer";
export interface TeamAccess { teamId:string; userId:string; role:TeamRole; feature:TeamFeature; }
const ROLES=new Set<TeamRole>(["owner","admin","editor","viewer"]);
const EXECUTION_ROLES=new Set<TeamRole>(["owner","admin","editor"]);

export async function requireTeamFeatureAccess(input:{userId:string;teamId:string;feature:TeamFeature}):Promise<TeamAccess>{
 const userId=input.userId.trim(); const teamId=input.teamId.trim();
 if(!userId||!teamId)throw new Error("Team context is required");
 const teamSnap=await adminDb.collection("teams").doc(teamId).get();
 if(!teamSnap.exists)throw new Error("Team not found");
 if(teamSnap.data()?.isArchived===true)throw new Error("Team is archived");
 const memberSnap=await adminDb.collection("teams").doc(teamId).collection("members").where("userId","==",userId).limit(1).get();
 if(memberSnap.empty)throw new Error("Team membership required");
 const role=memberSnap.docs[0].data().role as TeamRole;
 if(!ROLES.has(role))throw new Error("Invalid team role");
 if(!EXECUTION_ROLES.has(role))throw new Error("Team role does not have execution permission");
 return {teamId,userId,role,feature:input.feature};
}
