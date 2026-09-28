/**
 * Seed de développement — Firebase ÉMULATEURS (Task 39, Rec 6.1).
 *
 * Peuple l'émulateur avec un jeu de données réaliste :
 *   - 5 utilisateurs (rôles variés) + profils + portefeuilles provisionnés ;
 *   - 2 équipes (propriétaire + membres avec rôles différents) ;
 *   - 3 agents pré-configurés (types universel/recherche/contenu) ;
 *   - 10 conversations d'exemple avec messages ;
 *   - recharge de portefeuille factice (ledger "topup").
 *
 * IMPORTANT : ne cible JAMAIS la production — les variables d'émulateur
 * (FIRESTORE_EMULATOR_HOST / FIREBASE_AUTH_EMULATOR_HOST) sont posées par
 * `firebase emulators:exec`. Par précaution, le script REFUSE de tourner
 * si ces variables sont absentes.
 *
 * Usage : npm run db:reset   (émulateurs:exec → npm run seed)
 *         npm run seed       (émulateurs déjà lancés via make emulators)
 */

import { generateKeyPairSync } from "node:crypto";

import { describeEnvGroups } from "../lib/env/config-report";

const PROJECT_ID = "demo-gen3ia";
const AUTH_EMULATOR_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || "127.0.0.1:9099";

// Identités admin factices MAIS cryptographiquement valides : firebase-admin
// `cert()` parse le PEM dès l'import. Acceptable UNIQUEMENT car le garde-fou
// émulateur ci-dessous refuse tout run hors émulateur.
if (!process.env.FIREBASE_PROJECT_ID) process.env.FIREBASE_PROJECT_ID = PROJECT_ID;
if (!process.env.FIREBASE_CLIENT_EMAIL) {
  process.env.FIREBASE_CLIENT_EMAIL = `seed@${PROJECT_ID}.iam.gserviceaccount.com`;
}
if (!process.env.FIREBASE_PRIVATE_KEY) {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  process.env.FIREBASE_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

const USERS = [
  { email: `alice.dev@gen3ia.test`, name: "Alice Martin", role: "owner équipe A" },
  { email: `bob.dev@gen3ia.test`, name: "Bob Nkoulou", role: "éditeur équipe A" },
  { email: `chloe.dev@gen3ia.test`, name: "Chloé Fadimatou", role: "viewer équipe A" },
  { email: `david.dev@gen3ia.test`, name: "David Essomba", role: "owner équipe B" },
  { email: `eva.dev@gen3ia.test`, name: "Eva Tchoumi", role: "membre équipe B" },
] as const;

const AGENTS: Array<{
  name: string;
  type: "universal" | "code" | "content" | "research" | "automation";
  description: string;
  skills: string[];
  ownerIndex: number;
}> = [
  {
    name: "Gen IA Universel",
    type: "universal",
    description: "Agent généraliste de démonstration : questions, recherches, rédaction.",
    skills: ["web.search", "file.create"],
    ownerIndex: 0,
  },
  {
    name: "Analyste Recherche",
    type: "research",
    description: "Recherche approfondie multi-sources avec synthèse citée.",
    skills: ["web.search", "web.api"],
    ownerIndex: 0,
  },
  {
    name: "Rédacteur Contenu",
    type: "content",
    description: "Production d'articles et de newsletters en français.",
    skills: ["file.create"],
    ownerIndex: 3,
  },
];

interface SeedUser {
  uid: string;
  email: string;
  name: string;
}

async function signUpEmu(email: string): Promise<{ idToken: string; localId: string }> {
  const res = await fetch(
    `http://${AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=seed`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "SeedPass123!", returnSecureToken: true }),
    },
  );
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 400 && body.includes("EMAIL_EXISTS")) {
      const signIn = await fetch(
        `http://${AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=seed`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, password: "SeedPass123!", returnSecureToken: true }),
        },
      );
      return (await signIn.json()) as { idToken: string; localId: string };
    }
    throw new Error(`signUp ${email}: ${res.status} ${body}`);
  }
  return (await res.json()) as { idToken: string; localId: string };
}

async function main(): Promise<void> {
  // Garde-fou : jamais contre la production.
  const groups = describeEnvGroups();
  const emulatorMode =
    Boolean(process.env.FIRESTORE_EMULATOR_HOST) &&
    Boolean(process.env.FIREBASE_AUTH_EMULATOR_HOST);
  if (!emulatorMode) {
    console.error(
      "✖ Seed refusé : les émulateurs ne sont pas détectés.\n" +
        "  Lance : npm run db:reset  (émulateurs:exec → seed)\n" +
        "  ou    : make emulators  puis make seed dans un autre terminal.",
    );
    process.exit(1);
  }
  if (!groups.find((g) => g.group === "firebase-admin")?.present) {
    console.error("✖ Seed refusé : FIREBASE_PROJECT_ID / CLIENT_EMAIL / PRIVATE_KEY requis (identités factices acceptées).");
    process.exit(1);
  }

  // Imports dynamiques APRÈS pose des variables d'émulateur : firebase-admin
  // lit FIRESTORE_EMULATOR_HOST à l'initialisation.
  // NOTE : on n'importe PAS lib/chat/repository (garde `server-only` actif
  // hors React Server Components) — les conversations sont écrites via
  // adminDb avec le MÊME schéma que createConversation/appendMessage.
  const { adminDb } = await import("../lib/firebase/admin");
  const { ensureUserProfile } = await import("../lib/firebase/users");
  const { createTeamForUser, createTeamInvitation, acceptTeamInvitation } = await import(
    "../lib/teams/repository"
  );
  const { createAgentRecord } = await import("../lib/agents/repository");
  const { getWallet, applyTopup } = await import("../lib/billing/wallet");

  const users: SeedUser[] = [];
  for (const spec of USERS) {
    const { localId } = await signUpEmu(spec.email);
    // Provisionne profil + portefeuille avec les MÊMES fonctions serveur
    // que /api/auth/session (ensureUserProfile + getWallet).
    await ensureUserProfile({ uid: localId, email: spec.email, displayName: spec.name, provider: "password" });
    await getWallet(localId);
    users.push({ uid: localId, email: spec.email, name: spec.name });
    console.log(`+ utilisateur ${spec.email} (${spec.role})`);
  }

  // Portefeuilles : recharge factice pour tester les chemins payants.
  for (const user of users.slice(0, 3)) {
    await getWallet(user.uid);
    await applyTopup({
      userId: user.uid,
      amountMinor: 50_000_00,
      currency: "XAF",
      providerReference: `seed_topup_${user.uid.slice(0, 8)}`,
      metadata: { source: "seed" },
    });
  }
  console.log("+ recharges factices (3 × 50 000 XAF)");

  // Équipe A (alice owner, bob éditeur, chloé viewer) — Équipe B (david owner, eva éditeur).
  const teamA = await createTeamForUser(
    { uid: users[0].uid, email: users[0].email, name: users[0].name },
    { name: "Studio Gen3ia", description: "Équipe de démonstration A" },
  );
  for (const [idx, role] of [
    [1, "editor"],
    [2, "viewer"],
  ] as const) {
    const { token } = await createTeamInvitation(users[0].uid, {
      teamId: teamA.id,
      email: users[idx].email,
      role,
    });
    await acceptTeamInvitation({ uid: users[idx].uid, email: users[idx].email, name: users[idx].name }, token);
  }
  const teamB = await createTeamForUser(
    { uid: users[3].uid, email: users[3].email, name: users[3].name },
    { name: "Ops Gen3ia", description: "Équipe de démonstration B" },
  );
  const { token: tokenEva } = await createTeamInvitation(users[3].uid, {
    teamId: teamB.id,
    email: users[4].email,
    role: "editor",
  });
  await acceptTeamInvitation({ uid: users[4].uid, email: users[4].email, name: users[4].name }, tokenEva);
  console.log("+ 2 équipes (A : owner/éditeur/viewer · B : owner/éditeur)");

  // Agents pré-configurés.
  for (const spec of AGENTS) {
    const owner = users[spec.ownerIndex];
    await createAgentRecord(owner.uid, {
      name: spec.name,
      type: spec.type,
      description: spec.description,
      skills: spec.skills,
    });
    console.log(`+ agent « ${spec.name} » (${spec.type}) pour ${owner.email}`);
  }

  // 10 conversations avec messages (réparties sur les 2 premiers utilisateurs).
  const sujets = [
    "Stratégie de lancement produit",
    "Analyse concurrentielle marché camerounais",
    "Rédaction newsletter hebdomadaire",
    "Plan de recrutement trimestriel",
    "Veille tarifaire fournisseurs",
    "Préparation réunion investisseurs",
    "Automatisation factures mensuelles",
    "Diagnostic performance site web",
    "Cahier des charges app mobile",
    "Revue des objectifs semestriels",
  ];
  for (let i = 0; i < 10; i++) {
    const user = users[i % 2];
    const now = new Date();
    const convRef = adminDb.collection("chatConversations").doc();
    await convRef.set({
      userId: user.uid,
      title: sujets[i].slice(0, 120),
      messageCount: 2,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const messages: Array<{ role: "user" | "assistant"; content: string }> = [
      { role: "user", content: `Bonjour, j'ai besoin d'aide pour : ${sujets[i]}.` },
      {
        role: "assistant",
        content: `Avec plaisir ! Voici comment je propose d'aborder « ${sujets[i]} » : (1) cadrage des objectifs, (2) collecte des données, (3) plan d'action en trois semaines.`,
      },
    ];
    for (const message of messages) {
      await adminDb.collection("chatMessages").add({
        conversationId: convRef.id,
        userId: user.uid,
        role: message.role,
        content: message.content,
        generationStatus: "complete",
        createdAt: now,
      });
    }
  }
  console.log("+ 10 conversations avec messages");

  console.log("\n✔ Seed terminé — 5 utilisateurs, 2 équipes, 3 agents, 10 conversations.");
  console.log("  Connexion locale : utilisez ces comptes dans l'émulateur Auth (mot de passe SeedPass123!).");
}

main().catch((error: unknown) => {
  console.error("✖ Seed échoué :", error);
  process.exit(1);
});
