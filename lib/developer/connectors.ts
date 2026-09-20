import { adminDb } from "@/lib/firebase/admin";
const COL="developerProjectConnectors";
export interface DeveloperProjectConnector { id:string; projectId:string; userId:string; toolkit:string; connectionId:string; status:"pending"|"active"|"disabled"; createdAt:number; updatedAt:number; }
export async function upsertDeveloperProjectConnector(input:{projectId:string;userId:string;toolkit:string;connectionId:string}){
 const toolkit=input.toolkit.trim().toLowerCase(); const id=input.projectId+"__"+toolkit; const ref=adminDb.collection(COL).doc(id); const old=await ref.get(); const now=Date.now();
 const data:DeveloperProjectConnector={id,projectId:input.projectId,userId:input.userId,toolkit,connectionId:input.connectionId,status:old.exists?((old.data()?.status as DeveloperProjectConnector["status"])||"pending"):"pending",createdAt:old.exists?Number(old.data()?.createdAt||now):now,updatedAt:now};
 await ref.set(data,{merge:true}); return data;
}
export async function listDeveloperProjectConnectors(userId:string,projectId:string){
 const snap=await adminDb.collection(COL).where("projectId","==",projectId).limit(200).get();
 return snap.docs.map(d=>d.data() as DeveloperProjectConnector).filter(x=>x.userId===userId).sort((a,b)=>b.updatedAt-a.updatedAt);
}
export async function removeDeveloperProjectConnector(userId:string,projectId:string,toolkit:string){
 const ref=adminDb.collection(COL).doc(projectId+"__"+toolkit.trim().toLowerCase()); const snap=await ref.get();
 if(!snap.exists||snap.data()?.userId!==userId)throw new Error("Connecteur introuvable."); await ref.delete();
}