// app/api/team/invite/route.ts
import { NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase/admin';

export async function POST(request: Request) {
  try {
    const { invitationId, email, teamName, token } = await request.json();

    // Vérifier que l'invitation existe
    const invDoc = await adminDb.collection('invitations').doc(invitationId).get();
    if (!invDoc.exists) {
      return NextResponse.json({ error: 'Invitation introuvable' }, { status: 404 });
    }

    const inviteUrl = `${process.env.NEXT_PUBLIC_APP_URL}/team/join?token=${token}`;

    // --- Envoi d'email (exemple avec Resend) ---
    // Décommentez et installez `resend` :
    //
    // import { Resend } from 'resend';
    // const resend = new Resend(process.env.RESEND_API_KEY);
    // await resend.emails.send({
    //   from: 'Gen3ia <noreply@gen3ia.com>',
    //   to: email,
    //   subject: `Invitation à rejoindre l'équipe "${teamName}"`,
    //   html: `
    //     <h2>Vous êtes invité à rejoindre "${teamName}"</h2>
    //     <p>Cliquez sur le lien ci-dessous pour accepter :</p>
    //     <a href="${inviteUrl}">Rejoindre l'équipe</a>
    //     <p>Ce lien expire dans 7 jours.</p>
    //   `,
    // });

    // Le lien contient un jeton secret : ne jamais le journaliser.
    console.log(`📧 Invitation créée pour ${email}`);

    return NextResponse.json({ success: true, inviteUrl });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
