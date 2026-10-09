import {
  FieldValue,
  Timestamp,
} from "@/lib/r2fs";

import { adminDb } from "@/lib/firebase/admin";
import {
  SkillDefinitionInput,
  SkillDefinitionSchema,
  SkillEvaluation,
} from "./schema";

// Collection references are created lazily so that importing this module
// never triggers Firebase Admin initialization (build-time safety).
let skillsCollection: FirebaseFirestore.CollectionReference | undefined;
let versionsCollection: FirebaseFirestore.CollectionReference | undefined;
let evaluationsCollection: FirebaseFirestore.CollectionReference | undefined;

function getSkillsCollection() {
  if (!skillsCollection) {
    skillsCollection = adminDb.collection("skills");
  }
  return skillsCollection;
}

function getVersionsCollection() {
  if (!versionsCollection) {
    versionsCollection = adminDb.collection("skillVersions");
  }
  return versionsCollection;
}

function getEvaluationsCollection() {
  if (!evaluationsCollection) {
    evaluationsCollection = adminDb.collection("skillEvaluations");
  }
  return evaluationsCollection;
}

export async function getSkill(
  skillId: string,
): Promise<SkillDefinitionInput | null> {
  const snapshot = await getSkillsCollection()
    .doc(skillId)
    .get();

  if (!snapshot.exists) {
    return null;
  }

  return SkillDefinitionSchema.parse({
    ...snapshot.data(),
    id: snapshot.id,
  });
}

export async function listSkills(params?: {
  visibility?: string;
  category?: string;
  status?: string;
}) {
  let query:
    FirebaseFirestore.Query = getSkillsCollection();

  if (params?.visibility) {
    query = query.where(
      "visibility",
      "==",
      params.visibility,
    );
  }

  if (params?.category) {
    query = query.where(
      "category",
      "==",
      params.category,
    );
  }

  if (params?.status) {
    query = query.where(
      "status",
      "==",
      params.status,
    );
  }

  const snapshot = await query.get();

  return snapshot.docs.map((doc) =>
    SkillDefinitionSchema.parse({
      ...doc.data(),
      id: doc.id,
    }),
  );
}

export async function createSkill(
  skill: SkillDefinitionInput,
) {
  const validated =
    SkillDefinitionSchema.parse(skill);

  const ref = getSkillsCollection().doc(validated.id);

  await ref.create({
    ...validated,
    createdAt: Timestamp.fromDate(
      new Date(validated.createdAt),
    ),
    updatedAt: FieldValue.serverTimestamp(),
  });

  await getVersionsCollection()
    .doc(`${validated.id}:v${validated.version}`)
    .set({
      skillId: validated.id,
      version: validated.version,
      definition: validated,
      createdAt: FieldValue.serverTimestamp(),
    });

  return validated;
}

export async function updateSkill(
  skillId: string,
  skill: SkillDefinitionInput,
) {
  const validated =
    SkillDefinitionSchema.parse(skill);

  const ref = getSkillsCollection().doc(skillId);

  await ref.update({
    ...validated,
    updatedAt: FieldValue.serverTimestamp(),
  });

  await getVersionsCollection()
    .doc(`${skillId}:v${validated.version}`)
    .set({
      skillId,
      version: validated.version,
      definition: validated,
      createdAt: FieldValue.serverTimestamp(),
    });

  return validated;
}

export async function saveSkillEvaluation(
  evaluation: SkillEvaluation,
) {
  const ref =
    getEvaluationsCollection().doc();

  await ref.set({
    ...evaluation,
    evaluatedAt: Timestamp.fromDate(
      new Date(evaluation.evaluatedAt),
    ),
  });

  return ref.id;
}
