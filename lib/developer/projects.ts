import { adminDb } from "@/lib/firebase/admin";

export interface DeveloperProject {
  id: string;
  ownerId: string;
  name: string;
  slug: string;
  description: string;
  framework: string;
  environment: "development" | "preview" | "production";
  status: "active" | "archived";
  createdAt: number;
  updatedAt: number;
}

const COL = "developerProjects";
const now = () => Date.now();

function slugify(value: string) {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "project";
}

export async function listDeveloperProjects(ownerId: string) {
  const snap = await adminDb.collection(COL).where("ownerId", "==", ownerId).orderBy("updatedAt", "desc").limit(100).get();
  return snap.docs.map((d) => d.data() as DeveloperProject);
}

export async function getDeveloperProject(ownerId: string, projectId: string) {
  const snap = await adminDb.collection(COL).doc(projectId).get();
  if (!snap.exists) return null;
  const project = snap.data() as DeveloperProject;
  return project.ownerId === ownerId ? project : null;
}

export async function createDeveloperProject(ownerId: string, input: { name: string; description?: string; framework?: string }) {
  const name = input.name.trim().slice(0, 100);
  if (!name) throw new Error("Le nom du projet est requis.");
  const ref = adminDb.collection(COL).doc();
  const timestamp = now();
  const project: DeveloperProject = {
    id: ref.id,
    ownerId,
    name,
    slug: slugify(name),
    description: (input.description ?? "").trim().slice(0, 500),
    framework: (input.framework ?? "nextjs").trim().slice(0, 40),
    environment: "development",
    status: "active",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await ref.create(project);
  return project;
}

export async function updateDeveloperProject(ownerId: string, projectId: string, input: Partial<Pick<DeveloperProject, "name" | "description" | "framework" | "environment" | "status">>) {
  const existing = await getDeveloperProject(ownerId, projectId);
  if (!existing) throw new Error("Projet introuvable.");
  const patch: Record<string, unknown> = { updatedAt: now() };
  if (typeof input.name === "string" && input.name.trim()) patch.name = input.name.trim().slice(0, 100);
  if (typeof input.description === "string") patch.description = input.description.trim().slice(0, 500);
  if (typeof input.framework === "string") patch.framework = input.framework.trim().slice(0, 40);
  if (input.environment && ["development", "preview", "production"].includes(input.environment)) patch.environment = input.environment;
  if (input.status && ["active", "archived"].includes(input.status)) patch.status = input.status;
  await adminDb.collection(COL).doc(projectId).update(patch);
  return (await getDeveloperProject(ownerId, projectId))!;
}
