import { FieldValue, Timestamp } from "firebase-admin/firestore";

import { adminDb } from "./admin";

export interface UserProfile {
  uid: string;
  email: string | null;
  displayName: string | null;
  firstName: string | null;
  lastName: string | null;
  username: string | null;
  photoURL: string | null;
  phoneNumber: string | null;
  country: string | null;
  bio: string | null;
  language: string;
  timezone: string;
  providers: string[];
  role: "user" | "developer" | "admin";
  plan: "free" | "pro" | "enterprise";
  credits: number;
  createdAt: Timestamp | FieldValue;
  updatedAt: Timestamp | FieldValue;
  lastLoginAt: Timestamp | FieldValue;
}

function clean(value: string | null | undefined, max = 120): string | null {
  const normalized = value?.trim().replace(/\s+/g, " ");
  return normalized ? normalized.slice(0, max) : null;
}

export async function ensureUserProfile(params: {
  uid: string;
  email?: string | null;
  displayName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  username?: string | null;
  photoURL?: string | null;
  phoneNumber?: string | null;
  country?: string | null;
  bio?: string | null;
  language?: string | null;
  timezone?: string | null;
  provider?: string;
}): Promise<void> {
  const ref = adminDb.collection("users").doc(params.uid);
  const snapshot = await ref.get();
  const provider = params.provider?.trim() || "unknown";

  const firstName = clean(params.firstName, 80);
  const lastName = clean(params.lastName, 80);
  const derivedDisplayName = clean(
    params.displayName || [firstName, lastName].filter(Boolean).join(" "),
    160,
  );

  if (!snapshot.exists) {
    const profile: UserProfile = {
      uid: params.uid,
      email: clean(params.email, 254),
      displayName: derivedDisplayName,
      firstName,
      lastName,
      username: clean(params.username, 32)?.toLowerCase() ?? null,
      photoURL: clean(params.photoURL, 2048),
      phoneNumber: clean(params.phoneNumber, 40),
      country: clean(params.country, 80),
      bio: clean(params.bio, 500),
      language: clean(params.language, 16) ?? "fr",
      timezone: clean(params.timezone, 80) ?? "UTC",
      providers: [provider],
      role: "user",
      plan: "free",
      credits: 0,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      lastLoginAt: FieldValue.serverTimestamp(),
    };
    await ref.set(profile);
    return;
  }

  const data = snapshot.data() as Partial<UserProfile>;
  const providers = Array.from(new Set([...(data.providers || []), provider]));

  await ref.update({
    email: clean(params.email, 254) ?? data.email ?? null,
    displayName: derivedDisplayName ?? data.displayName ?? null,
    ...(params.firstName !== undefined ? { firstName } : {}),
    ...(params.lastName !== undefined ? { lastName } : {}),
    ...(params.username !== undefined ? { username: clean(params.username, 32)?.toLowerCase() ?? null } : {}),
    ...(params.photoURL !== undefined ? { photoURL: clean(params.photoURL, 2048) } : {}),
    ...(params.phoneNumber !== undefined ? { phoneNumber: clean(params.phoneNumber, 40) } : {}),
    ...(params.country !== undefined ? { country: clean(params.country, 80) } : {}),
    ...(params.bio !== undefined ? { bio: clean(params.bio, 500) } : {}),
    ...(params.language !== undefined ? { language: clean(params.language, 16) ?? "fr" } : {}),
    ...(params.timezone !== undefined ? { timezone: clean(params.timezone, 80) ?? "UTC" } : {}),
    providers,
    updatedAt: FieldValue.serverTimestamp(),
    lastLoginAt: FieldValue.serverTimestamp(),
  });
}
