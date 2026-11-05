import { readFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/**
 * Garde-fou — TÉLÉMÉTRIE DE PHASE DU POLLER (pull-deploy v7, it.96→v7, Job 478451).
 *
 * Constat mesuré à it.95 : une livraison de 45 min (vs ~13 min habituels)
 * n'était pas diagnostiquable depuis l'extérieur — le battement v5 prouvait
 * que le poller VIVAIT, mais pas ce qu'il FAISAIT (« livraisons qui ne
 * finissent pas » : téléchargement lent ? finisher bloqué ? backoff ?).
 *
 * Ce test verrouille :
 * 1. la syntaxe exécutable réelle (bash -n) ;
 * 2. le heartbeat porte la version v6 ET la PHASE dans « note » ;
 * 3. les phases v6 sont émises aux bons endroits (dl-debut → dl-en-cours
 *    → dl-fin → finisher-debut → deploie / finisher-echec, plus
 *    echec-backoff à chaque échec transient) ;
 * 4. le batteur interne est BORNÉ (10 × 60 s, kill + trap EXIT) — jamais
 *    un orphelin infini qui écrirait des battements fantômes après la
 *    mort du script ;
 * 5. le battement reste JAMAIS bloquant (|| true) — une échec d'écriture
 *    ne peut toujours pas tuer un déploiement ;
 * 6. anti-injection : toutes les notes sont des littéraux ASCII fixes
 *    d'un ensemble fermé (aucune interpolation de variable) ;
 * 7. le guérisseur lit la phase (jq .note) et l'expose (battement_note)
 *    — le diagnostic « téléchargement lent vs finisher bloqué » arrive
 *    jusque dans les corps d'issue d'escalade.
 */

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

const PULL = "scripts/vps-auto-deploy/pull-deploy.sh";

describe("pull-deploy.sh v7 — télémétrie de phase", () => {
  const script = read(PULL);

  it("syntaxe bash valide (bash -n réel)", () => {
    expect(() =>
      execFileSync("bash", ["-n", path.join(process.cwd(), PULL)], { stdio: "pipe" }),
    ).not.toThrow();
  });

  it("le heartbeat porte la version v7 (le champ poller dit quoi lire)", () => {
    expect(script).toContain('"poller":"pull-deploy v7"');
    expect(script).not.toContain('"poller":"pull-deploy v6"');
  });

  it("les 7 phases v6 sont émises (ensemble fermé, aux bons endroits)", () => {
    for (const phase of [
      '"dl-debut"',
      '"dl-en-cours"',
      '"dl-fin"',
      '"finisher-debut"',
      '"deploie"',
      '"finisher-echec"',
      '"echec-backoff"',
    ]) {
      expect(script).toContain(`battement "$TARGET_SHA" ${phase}`);
    }
    // Ordonnement réel : dl-debut AVANT dl-en-cours AVANT dl-fin AVANT finisher
    // (on cible les ÉMISSIONS complètes — l'entête v6 cite aussi ces phases)
    const i = (s: string) => script.indexOf(s);
    const EM = (p: string) => `battement "$TARGET_SHA" "${p}"`;
    expect(i(EM("dl-debut"))).toBeLessThan(i(EM("dl-en-cours")));
    expect(i(EM("dl-en-cours"))).toBeLessThan(i(EM("dl-fin")));
    expect(i(EM("dl-fin"))).toBeLessThan(i(EM("finisher-debut")));
    // dl-fin APRES la validation d'intégrité (verrou final du tar)
    expect(i("sha256sum -c next-build.tar.gz.sha256")).toBeLessThan(i(EM("dl-fin")));
  });

  it("le batteur interne est BORNÉ (10×60 s) et stoppé (kill + trap EXIT + wait)", () => {
    expect(script).toContain("for i in 1 2 3 4 5 6 7 8 9 10");
    expect(script).toContain('battement "$TARGET_SHA" "dl-en-cours"; done ) &');
    expect(script).toContain("BATTEUR=$!");
    expect(script).toContain("trap 'kill \"${BATTEUR:-}\" 2>/dev/null || true' EXIT");
    // Stop explicite en fin de phase + le trap couvre les sorties précoces
    expect(script).toContain('kill "$BATTEUR" 2>/dev/null || true; wait "$BATTEUR" 2>/dev/null || true');
    // Le batteur n'émet que pendant le téléchargement (bornage = jamais un
    // heartbeat « dl-en-cours » fantôme après la mort du script).
  });

  it("le battement reste JAMAIS bloquant (|| true sur l'écriture)", () => {
    const fn = script.slice(script.indexOf("battement() {"), script.indexOf("mkdir -p \"$STATE_DIR\""));
    expect(fn).toContain("|| true");
    // Un échec d'écriture ne doit jamais interrompre le déploiement :
    expect(fn).toContain("> \"$HEARTBEAT\" 2>/dev/null || true");
  });

  it("anti-injection : toutes les notes sont des littéraux d'un ensemble fermé", () => {
    const notes = [...script.matchAll(/battement\s+"[^"]*"\s+"([^"]*)"/g)].map((m) => m[1]);
    const LEGALES = new Set([
      "",
      "release cd-latest indisponible",
      "meta.json illisible",
      "dl-debut",
      "dl-deja-complet",
      "dl-en-cours",
      "dl-fin",
      "finisher-debut",
      "deploie",
      "finisher-echec",
      "echec-backoff",
      "echec-fs-plein",
      // v7 — la ré-émission apparaît littéralement comme variable dans le
      // source : seule la valeur capturée "$NOTE_PRECEDENTE" est admise ici,
      // et le case ci-dessous borne son contenu à « finisher-echec:* ».
      "$NOTE_PRECEDENTE",
    ]);
    expect(notes.length).toBeGreaterThanOrEqual(10);
    for (const n of notes) expect(LEGALES.has(n)).toBe(true);
    // v7 — exception DOCUMENTÉE : ré-émission de la note précédente
    // ($NOTE_PRECEDENTE, préservation d'un échec finisher à travers un
    // cycle). Sûre par induction : cette variable ne peut contenir qu'une
    // valeur lue dans le heartbeat, elle-même issue de cet ensemble fermé.
    // Le case de garde doit rester borné aux notes d'échec.
    expect(script).toContain('NOTE_PRECEDENTE=$(grep -o \'"note":"[^"]*"\' "$HEARTBEAT"');
    expect(script).toMatch(/case "\$NOTE_PRECEDENTE" in\s*\n\s*finisher-echec:\*\)/);
  });

  it("l'entête documente le but : distinguer téléchargement lent vs finisher bloqué", () => {
    expect(script).toContain("TÉLÉMÉTRIE DE PHASE");
    expect(script).toContain("téléchargement lent d'un finisher bloqué");
  });

  it("le stub committé annonce v7 et la sémantique de la note (pas de valeur périmée)", () => {
    const stub = read("public/poller-heartbeat.json");
    expect(stub).toContain("pull-deploy v7");
    expect(stub).not.toContain("pull-deploy v6");
  });
});

describe("guérisseur — la phase arrive jusqu'aux escalades (diagnostic sans SSH)", () => {
  const wf = read(".github/workflows/guerisseur-production.yml");

  it("le step battement lit la note (jq .note) et la publie en output", () => {
    expect(wf).toContain(".note // \"\"");
    expect(wf).toContain("echo \"note=$NOTE\" >> \"$GITHUB_OUTPUT\"");
    expect(wf).toContain("battement_note: ${{ steps.battement.outputs.note }}");
  });

  it("la phase est transmise au job guerir et visible dans le corps d'issue", () => {
    expect(wf).toContain("BATTEMENT_NOTE: ${{ needs.verifier.outputs.battement_note }}");
    expect(wf).toContain("%HB_NOTE%");
    // Le remplacement du jeton est bien câblé
    expect(wf).toContain('${CORPS_POLLER//%HB_NOTE%/${BATTEMENT_NOTE:-—}}');
    // Le commentaire anti-spam porte aussi la phase
    expect(wf).toContain("phase ${BATTEMENT_NOTE:-—}");
  });
});
