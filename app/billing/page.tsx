"use client";

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { type User } from "firebase/auth";
import { watchAuth } from "@/lib/firebase/client";
import { authFetch, readJsonSafely, useSessionAvailable } from "@/lib/firebase/auth-client";
import ChariowWidget, { CHARIOW_PLAN_WIDGETS, CHARIOW_TOPUP_WIDGET } from "@/components/billing/chariow-widget";

interface Wallet {
  currency: string;
  balanceMinor: number;
  reservedMinor: number;
  availableMinor: number;
  welcomeGranted: boolean;
  welcomeAmountMinor: number;
}

interface PublicPlan {
  id: string;
  name: string;
  priceLabel: string;
  cycle: string;
  audience: string;
  features: string[];
  highlight: boolean;
  purchasable: boolean;
  current: boolean;
}

interface PlanStateInfo {
  planId: string;
  active: boolean;
  expiresAt: number | null;
}

/** Mode libre (GEN3IA_BILLING_ENABLED=false) : la plateforme ne facture plus l'usage (R2 porte tout). */
const FREE_MODE_BANNER = "Accès libre : Gen3ia ne débite plus de crédits. Toutes les exécutions d'agents, missions et générations sont gratuites tant que ce mode est actif.";

const COUNTRY_CODES = [
  { code: "CM", label: "Cameroun (+237)" },
  { code: "CI", label: "Côte d'Ivoire (+225)" },
  { code: "SN", label: "Sénégal (+221)" },
  { code: "GA", label: "Gabon (+241)" },
  { code: "CD", label: "RD Congo (+243)" },
  { code: "FR", label: "France (+33)" },
  { code: "BE", label: "Belgique (+32)" },
  { code: "US", label: "États-Unis (+1)" },
];

type TopupPhase = "idle" | "creating" | "phone" | "redirecting";
type PlanPhase = "idle" | "creating" | "redirecting";

const PLAN_LABELS: Record<string, string> = {
  gratuit: "Plan Gratuit",
  pro: "Plan Pro",
  entreprise: "Plan Entreprise",
  "modele-sur-mesure": "Modèle Sur-Mesure",
};

interface WalletTransaction {
  id: string;
  type: string;
  amountMinor: number;
  currency: string;
  provider?: string;
  reference?: string;
  createdAt: number;
}

export default function BillingPage() {
  const [user, setUser] = useState<User | null>(null);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [success, setSuccess] = useState("");
  const [phase, setPhase] = useState<TopupPhase>("idle");
  const [countryCode, setCountryCode] = useState("CM");
  const [phoneNumber, setPhoneNumber] = useState("");
  // Étape 20 — historique des transactions RÉELLEMENT affiché : le solde
  // seul ne dit pas où va l'argent (recharges, consommations, réservations).
  const [transactions, setTransactions] = useState<WalletTransaction[]>([]);
  const [billingEnabled, setBillingEnabled] = useState(true);
  const [plans, setPlans] = useState<PublicPlan[]>([]);
  const [planState, setPlanState] = useState<PlanStateInfo | null>(null);
  const [planPhase, setPlanPhase] = useState<PlanPhase>("idle");
  const [pendingPlan, setPendingPlan] = useState<string | null>(null);
  const [licenseKey, setLicenseKey] = useState("");
  const [licenseBusy, setLicenseBusy] = useState(false);
  // Repli boutique (CHARIOW_TOPUP_STORE_URL renvoyé par /api/billing/wallet) :
  // lien secondaire affiché sous le widget de recharge rapide.
  const [storeUrl, setStoreUrl] = useState<string | null>(null);
  const sessionDisponible = useSessionAvailable();

  const loadPlans = useCallback(async () => {
    try {
      const response = await authFetch("/api/billing/plans", { cache: "no-store" });
      const data = (await readJsonSafely<{ plans?: PublicPlan[]; activePlan?: string }>(response)) ?? {};
      if (response.ok) {
        setPlans(data.plans ?? []);
        if (data.activePlan) {
          setPlanState({ planId: data.activePlan, active: true, expiresAt: null });
        }
      }
    } catch { /* grille indisponible : cartes masquées */ }
  }, []);

  const loadWallet = useCallback(async () => {
    // authFetch : ID token Firebase si disponible, sinon cookie de session.
    // readJsonSafely : un 502 HTML du proxy ne doit pas masquer l'erreur
    // réelle par une SyntaxError sur response.json().
    const response = await authFetch("/api/billing/wallet", { cache: "no-store" });
    const data = (await readJsonSafely<{ error?: string; wallet?: Wallet | null; billingEnabled?: boolean; storeUrl?: string | null }>(response)) ?? {};
    if (!response.ok) throw new Error(data.error ?? "Impossible de charger le solde.");
    setWallet(data.wallet ?? null);
    setBillingEnabled(data.billingEnabled !== false);
    setStoreUrl(data.storeUrl?.trim() || null);
  }, []);

  const loadTransactions = useCallback(async () => {
    try {
      const response = await authFetch("/api/billing/transactions?limit=15", { cache: "no-store" });
      if (!response.ok) return;
      const data = (await readJsonSafely<{ transactions?: WalletTransaction[] }>(response)) ?? {};
      setTransactions(data.transactions ?? []);
    } catch { /* historique indisponible : section masquée */ }
  }, []);

  useEffect(() => watchAuth(async (current) => {
    setUser(current);
    // L'etat Firebase client peut etre perdu (webviews mobiles) : on charge
    // quand meme le solde via le cookie de session serveur.
    if (!current) {
      try { await loadWallet(); await loadTransactions(); await loadPlans(); } catch { /* aucune session : page de connexion affichee */ }
      finally { setLoading(false); }
      return;
    }
    try {
      await loadWallet();
      await loadTransactions();
      await loadPlans();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Impossible de charger le solde.");
    } finally { setLoading(false); }
  }), [loadWallet, loadTransactions, loadPlans]);

  // Retour de paiement Chariow : ?topup=success&sale=sal_xxx. Si Chariow
  // n'ajoute pas le saleId à l'URL de retour, on le retrouve via le
  // sessionStorage posé au moment de la création du checkout
  // (gen3ia_topup_sale — valable 30 min, effacé après usage).
  useEffect(() => {
    if (sessionDisponible === false) return;
    const params = new URLSearchParams(window.location.search);
    const topup = params.get("topup");
    const saleIdParam = params.get("sale");
    if (topup !== "success") return;

    const saleIdStocke = (() => {
      try {
        const raw = sessionStorage.getItem("gen3ia_topup_sale");
        if (!raw) return null;
        const parsed = JSON.parse(raw) as { saleId?: string; at?: number };
        if (!parsed?.saleId || !parsed.at || Date.now() - parsed.at > 30 * 60 * 1000) return null;
        return parsed.saleId;
      } catch { return null; }
    })();
    const saleId = saleIdParam ?? saleIdStocke;

    window.history.replaceState({}, "", "/billing");
    try { sessionStorage.removeItem("gen3ia_topup_sale"); } catch { /* stockage indisponible */ }
    if (!saleId) {
      // Differe d'un tick pour eviter un rendu en cascade synchrone (set-state-in-effect).
      const timer = setTimeout(() => setNotice("Paiement terminé. Le crédit apparaît dès la confirmation Chariow — le solde se mettra à jour automatiquement."), 0);
      return () => clearTimeout(timer);
    }
    let annule = false;
    (async () => {
      // Filet de sécurité post-paiement : vérification de la vente via
      // l'API Chariow (crédit idempotent, même clé de ledger que le
      // webhook). Si le paiement n'est pas encore confirmé, on SONDE :
      // jusqu'à 10 essais espacés de 6 s — le webhook Pulse crédite
      // normalement en quelques secondes et le solde s'affiche tout seul.
      for (let essai = 0; essai < 10 && !annule; essai += 1) {
        if (essai > 0) await new Promise((resolve) => setTimeout(resolve, 6000));
        if (annule) return;
        try {
          const response = await authFetch("/api/billing/topup/verify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ saleId }),
          });
          const data = await response.json();
          if (!response.ok) throw new Error(data.error ?? "Vérification du paiement impossible.");
          if (annule) return;
          if (data.wallet) setWallet(data.wallet);
          if (data.credited) {
            setSuccess(`Recharge confirmée : +${((data.wallet.balanceMinor ?? 0) / 100).toLocaleString("fr-FR")} ${data.wallet.currency} crédités sur votre portefeuille.`);
            void loadTransactions();
            return;
          }
          setNotice(data.reason ?? "Paiement reçu. Le crédit est en cours de confirmation — le solde se mettra à jour automatiquement.");
        } catch (e) {
          if (annule) return;
          setError(e instanceof Error ? e.message : "Vérification du paiement impossible.");
          return;
        }
      }
    })();
    return () => { annule = true; };
  }, [sessionDisponible, user, loadTransactions, loadWallet]);

  // Retour d'abonnement Chariow : ?plan=success&planId=… — le webhook Pulse
  // active l'accès ; on sonde la grille quelques secondes pour l'afficher.
  useEffect(() => {
    if (sessionDisponible === false) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("plan") !== "success") return;

    const planId = params.get("planId") ?? "";
    window.history.replaceState({}, "", "/billing");
    const label = PLAN_LABELS[planId] ?? "Votre offre";
    const timer = setTimeout(() => setNotice(`Paiement reçu pour ${label}. L'abonnement s'active dès la confirmation Chariow (quelques secondes).`), 0);
    const polls = [3000, 9000, 20000].map((delay) => setTimeout(() => { void loadPlans(); }, delay));
    return () => {
      clearTimeout(timer);
      polls.forEach(clearTimeout);
    };
  }, [sessionDisponible, loadPlans]);

  // Abonnement à une offre payante (même flux téléphones que la recharge).
  const startPlanCheckout = async (planId: string, phone?: { number: string; country_code: string }) => {
    if (sessionDisponible === false) return;
    setPlanPhase(phone ? "redirecting" : "creating");
    setError(""); setNotice(""); setSuccess("");
    try {
      const response = await authFetch("/api/billing/plans/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(phone ? { planId, phone } : { planId }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Impossible d'ouvrir le paiement Chariow.");
      if (data.requiresDetails) {
        setPendingPlan(planId);
        setPhase("phone");
        setPlanPhase("idle");
        return;
      }
      if (!data.checkoutUrl) throw new Error("Chariow n'a pas renvoyé de page de paiement.");
      setPlanPhase("redirecting");
      window.location.href = data.checkoutUrl;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Impossible d'ouvrir le paiement.");
      setPlanPhase("idle");
    }
  };

  // Activation d'une clé de licence achetée sur la boutique Chariow.
  const submitLicense = async (event: React.FormEvent) => {
    event.preventDefault();
    const key = licenseKey.trim();
    if (!key) { setError("Saisissez votre clé de licence."); return; }
    setLicenseBusy(true);
    setError(""); setNotice(""); setSuccess("");
    try {
      const response = await authFetch("/api/billing/plans/licence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ licenseKey: key }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Activation impossible.");
      setSuccess(data.alreadyActivated
        ? "Cette licence était déjà active sur votre compte."
        : `Offre ${PLAN_LABELS[data.planId] ?? data.planId} activée sur votre compte.`);
      setLicenseKey("");
      await loadPlans();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Activation impossible.");
    } finally {
      setLicenseBusy(false);
    }
  };

  const startTopup = async (phone?: { number: string; country_code: string }) => {
    if (sessionDisponible === false) return;
    setPhase(phone ? "redirecting" : "creating");
    setError(""); setNotice(""); setSuccess("");
    try {
      const response = await authFetch("/api/billing/topup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(phone ? { phone } : {}),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Impossible d'ouvrir le paiement Chariow.");
      if (data.requiresDetails) { setPhase("phone"); return; }
      if (!data.checkoutUrl) throw new Error("Chariow n'a pas renvoyé de page de paiement.");
      // Le saleId renvoyé à la création du checkout est mémorisé : au retour
      // sur /billing, la vérification post-paiement peut interroger CETTE
      // vente même si Chariow n'ajoute aucun paramètre à l'URL de retour.
      if (data.saleId) {
        try { sessionStorage.setItem("gen3ia_topup_sale", JSON.stringify({ saleId: String(data.saleId), at: Date.now() })); } catch { /* stockage indisponible */ }
      }
      setPhase("redirecting");
      window.location.href = data.checkoutUrl;
    } catch (e) {
      const message = e instanceof Error ? e.message : "Impossible d'ouvrir le paiement.";
      // Guidage réel vers la voie alternative (widget boutique prix libre) :
      // le produit de recharge étant en PRIX LIBRE, l'API de checkout Chariow
      // peut refuser la création — l'utilisateur doit alors passer par le
      // widget « Recharge rapide » affiché sur cette même page.
      setError(`${message} — utilisez plutôt le widget « Recharge rapide » ci-dessous (montant au choix), la recharge y est directe.`);
      setPhase("idle");
    }
  };

  const submitPhone = (event: React.FormEvent) => {
    event.preventDefault();
    const digits = phoneNumber.replace(/\D/g, "");
    if (!digits) { setError("Saisissez votre numéro de téléphone Mobile Money."); return; }
    // Le formulaire téléphone est partagé : une offre en attente route vers le
    // checkout d'abonnement, sinon vers la recharge du portefeuille.
    if (pendingPlan) { void startPlanCheckout(pendingPlan, { number: digits, country_code: countryCode }); return; }
    startTopup({ number: digits, country_code: countryCode });
  };

  if (sessionDisponible === false) {
    return <div style={styles.main}><section style={styles.card}><h1 className="font-serif">Financement Gen3ia</h1><p>Connectez-vous pour consulter votre solde et recharger votre compte.</p></section></div>;
  }

  const currency = wallet?.currency ?? "XAF";
  const free = billingEnabled === false;
  const amount = wallet ? (wallet.balanceMinor / 100).toLocaleString("fr-FR", { minimumFractionDigits: 0, maximumFractionDigits: 2 }) : "0";
  const reserved = wallet ? (wallet.reservedMinor / 100).toLocaleString("fr-FR") : "0";
  const available = wallet ? (wallet.availableMinor / 100).toLocaleString("fr-FR") : "0";
  const empty = Boolean(wallet && wallet.availableMinor <= 0);
  const welcome = wallet ? (wallet.welcomeAmountMinor / 100).toLocaleString("fr-FR") : "0";
  const busy = phase === "creating" || phase === "redirecting";

  const transactionLabel = (type: string): string =>
    ({
      topup: "Recharge",
      welcome_grant: "Solde de bienvenue",
      earning: "Gain plateforme",
      charge: "Consommation",
      reservation: "Réservation (mission en cours)",
      release: "Restitution de réservation",
    })[type] ?? type;

  // Signe par TYPE (le ledger stocke toujours un montant positif) :
  // + recharge, bienvenue et gain plateforme ; − consommation et réservation ;
  // ↺ restitution.
  const transactionSign = (type: string): string =>
    type === "topup" || type === "welcome_grant" || type === "earning" ? "+" : type === "charge" || type === "reservation" ? "−" : "↺";

  const formatAmount = (minor: number): string =>
    (Math.abs(minor) / 100).toLocaleString("fr-FR", { minimumFractionDigits: 0, maximumFractionDigits: 2 });

  return <div style={styles.main}>
    <div style={{ gridColumn: "1 / -1", width: "100%", maxWidth: 980, margin: "0 auto", justifySelf: "center" }}>
    </div>
    <section style={styles.card}>
      <div style={styles.eyebrow}>GEN3IA WALLET</div>
      <h1 className="font-serif">Solde de votre compte</h1>
      {free && <div style={styles.freeBanner}>{FREE_MODE_BANNER}</div>}
      {wallet?.welcomeGranted && !free && <div style={styles.welcome}>Solde de démonstration : {welcome} {currency} offerts une seule fois à l&apos;ouverture du compte.</div>}
      <div style={styles.balance}>{loading ? "…" : `${amount} ${currency}`}</div>
      <p style={styles.muted}>Disponible : {available} {currency} · Réservé : {reserved} {currency}</p>
      {empty && !free && <div style={styles.locked}><strong>Agents IA arrêtés</strong><br />Votre solde disponible est à 0. Rechargez votre portefeuille pour reprendre les exécutions.</div>}

      {!free && (phase === "phone"
        ? <form onSubmit={submitPhone} style={styles.phoneForm}>
            <label style={styles.label} htmlFor="country">Pays du numéro</label>
            <select id="country" value={countryCode} onChange={(e) => setCountryCode(e.target.value)} style={styles.input}>
              {COUNTRY_CODES.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
            </select>
            <label style={styles.label} htmlFor="phone">Numéro Mobile Money (sans indicatif)</label>
            <input id="phone" inputMode="numeric" autoComplete="tel-national" placeholder="6 90 00 00 00" value={phoneNumber} onChange={(e) => setPhoneNumber(e.target.value)} style={styles.input} />
            <button type="submit" disabled={busy} style={styles.button}>{busy ? "Ouverture du paiement…" : "Payer avec Chariow (Mobile Money)"}</button>
          </form>
        : <button onClick={() => startTopup()} disabled={busy || loading} style={styles.button}>{busy ? "Ouverture du paiement…" : "Recharger avec Chariow"}</button>)}

      {/* Recharge à MONTANT LIBRE (choix opérateur) : le produit Chariow est
          configuré en prix libre — l'utilisateur choisit lui-même le montant
          sur la page de paiement (Mobile Money ou widget boutique), et le
          webhook Pulse crédite le MONTANT RÉEL de la vente
          (sale.amount.value → applyTopup), jamais un palier prédéfini. */}
      {!free && <p style={styles.note}>Au montant de ton choix : sur la page de paiement Chariow, saisis librement le montant à recharger.</p>}

      {/* Recharge RAPIDE (demande n°4) : widget boutique officiel du produit
          « Recharge Wallet API » (prd_llfosdp1) — raccourci de paiement direct
          à côté du flux Mobile Money ci-dessus, qui reste disponible. Le
          webhook Pulse crédite le solde automatiquement (vente reconnue par
          identifiant produit, idempotence chariow_<saleId>). */}
      {!free && (
        <div style={styles.widgetsBlock}>
          <div style={styles.widgetsTitle}>Recharge rapide du wallet</div>
          <div style={styles.widgetCard}>
            <div style={styles.widgetLabel}>{CHARIOW_TOPUP_WIDGET.label}</div>
            <div style={styles.widgetNote}>{CHARIOW_TOPUP_WIDGET.note}</div>
            <ChariowWidget productId={CHARIOW_TOPUP_WIDGET.productId} />
          </div>
          <p style={styles.note}>C&apos;est toi qui choisis le montant : saisis-le librement sur la page de paiement — le crédit est ajouté automatiquement à ton solde après paiement (webhook Chariow).</p>
          {storeUrl && (
            <p style={styles.note}>
              Recharge également possible sur la boutique :{" "}
              <a href={storeUrl} target="_blank" rel="noopener noreferrer" style={styles.storeLink}>{storeUrl}</a>
            </p>
          )}
        </div>
      )}

      {success && <p style={styles.success}>{success}</p>}
      {notice && <p style={styles.notice}>{notice}</p>}
      {!free && <p style={styles.note}>Le paiement s&apos;effectue via la boutique Chariow (Mobile Money, carte ou wallet selon votre pays). Le solde est crédité après confirmation du paiement par Chariow — automatiquement via le webhook signé, ou à votre retour sur cette page.</p>}
      {!free && <p style={styles.note}>Le solde de démonstration est accordé une seule fois. Après épuisement, vous devez recharger votre portefeuille. Les exécutions sont facturées selon l&apos;utilisation réelle et aucune nouvelle allocation gratuite n&apos;est créée automatiquement.</p>}
      {error && <p style={styles.error}>{error}</p>}
    </section>

    {/* Grille tarifaire officielle Chariow : 4 offres, paiement Mobile Money/carte */}
    <section style={styles.card}>
      <div style={styles.eyebrow}>OFFRES GEN3IA</div>
      <h2 className="font-serif" style={{ fontSize: 24, margin: "4px 0 6px" }}>Choisissez votre offre</h2>
      {planState && (
        <p style={styles.note} >
          Offre active : <strong>{PLAN_LABELS[planState.planId] ?? planState.planId}</strong>
          {planState.expiresAt ? ` — jusqu'au ${new Date(planState.expiresAt).toLocaleDateString("fr-FR")}` : ""}
        </p>
      )}
      <div style={styles.plansGrid}>
        {plans.map((plan) => (
          <div key={plan.id} style={{ ...styles.planCard, ...(plan.highlight ? styles.planHighlight : {}) }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
              <h3 style={{ margin: 0, fontSize: 17 }}>{plan.name}</h3>
              {plan.current && <span style={styles.planBadge}>Active</span>}
            </div>
            <div style={styles.planPrice}>{plan.priceLabel}</div>
            <div style={styles.planAudience}>{plan.audience}</div>
            <ul style={styles.planFeatures}>
              {plan.features.map((feature) => <li key={feature}>{feature}</li>)}
            </ul>
            {plan.id === "gratuit" || !plan.purchasable ? (
              <span style={styles.planNote}>{plan.id === "gratuit" ? "Inclus par défaut" : "Bientôt disponible"}</span>
            ) : (
              <button
                type="button"
                onClick={() => { setPendingPlan(null); void startPlanCheckout(plan.id); }}
                disabled={planPhase !== "idle"}
                style={styles.button}
              >
                {planPhase !== "idle" ? "Ouverture du paiement…" : plan.current ? "Renouveler" : "Souscrire"}
              </button>
            )}
          </div>
        ))}
      </div>
      {plans.length === 0 && <p style={styles.note}>Chargement de la grille tarifaire…</p>}

      {/* Paiement DIRECT boutique : les 3 widgets officiels Chariow (style tap).
          La licence reçue après paiement s'active dans le formulaire ci-dessous. */}
      <div style={styles.widgetsBlock}>
        <div style={styles.widgetsTitle}>Paiement direct sur la boutique Chariow</div>
        <div style={styles.widgetsGrid}>
          {CHARIOW_PLAN_WIDGETS.map((widget) => (
            <div key={widget.productId} style={styles.widgetCard}>
              <div style={styles.widgetLabel}>{widget.label}</div>
              <div style={styles.widgetNote}>{widget.note}</div>
              <ChariowWidget productId={widget.productId} />
            </div>
          ))}
        </div>
        <p style={styles.note}>Le bouton ouvre le paiement sécurisé de la boutique Chariow (Mobile Money, carte ou wallet). Après paiement, collez la clé de licence reçue dans le formulaire d&apos;activation ci-dessous — ou reconnectez-vous, le webhook Chariow active l&apos;offre automatiquement.</p>
      </div>

      <form onSubmit={submitLicense} style={styles.licenseForm}>
        <label style={styles.label} htmlFor="license">Vous avez acheté une licence sur la boutique Chariow ?</label>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input
            id="license"
            value={licenseKey}
            onChange={(e) => setLicenseKey(e.target.value)}
            placeholder="Clé de licence (ex. GEN3IA-XXXX-XXXX)"
            style={{ ...styles.input, flex: 1, minWidth: 200 }}
            autoComplete="off"
          />
          <button type="submit" disabled={licenseBusy} style={{ ...styles.button, marginTop: 0, width: "auto", padding: "12px 22px" }}>
            {licenseBusy ? "Activation…" : "Activer"}
          </button>
        </div>
        <p style={styles.note}>La clé reçue après achat est vérifiée auprès de Chariow puis attachée à votre compte Gen3ia.</p>
      </form>
    </section>

    {/* Étape 20 — historique réel des mouvements du portefeuille */}
    <section style={styles.card}>
      <div style={styles.eyebrow}>HISTORIQUE</div>
      <h2 className="font-serif" style={{ fontSize: 22, margin: "4px 0 12px" }}>Dernières transactions</h2>
      {transactions.length === 0 ? (
        <p style={styles.note}>Aucune transaction pour le moment. Les recharges et les consommations d&apos;agents apparaîtront ici.</p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
          {transactions.map((transaction) => (
            <li key={transaction.id} style={{ display: "flex", alignItems: "baseline", gap: 12, padding: "10px 12px", borderRadius: 12, border: "1px solid var(--g3-border)", background: "#faf9f6" }}>
              <span style={{ fontWeight: 800, minWidth: 28, color: transactionSign(transaction.type) === "+" ? "#0A6E82" : transactionSign(transaction.type) === "−" ? "#5B2BE0" : "#0E5F73" }}>
                {transactionSign(transaction.type)}{formatAmount(transaction.amountMinor)}
              </span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: "block", fontSize: 14 }}>{transactionLabel(transaction.type)}</span>
                <span style={{ display: "block", fontSize: 12, opacity: .6 }}>
                  {new Date(transaction.createdAt).toLocaleString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                  {transaction.reference ? ` · ${transaction.reference.slice(0, 40)}` : ""}
                </span>
              </span>
              <span style={{ fontSize: 12, opacity: .6 }}>{transaction.currency}</span>
            </li>
          ))}
        </ul>
      )}
      <p style={styles.note}>{free ? "Historique conservé pour mémoire — aucune nouvelle consommation n&apos;est débitée en mode accès libre." : "Chaque exécution d&apos;outil ou de mission est facturée selon l&apos;utilisation réelle — une réservation est prise au démarrage puis ajustée au coût final (restitution visible en ↺)."}</p>
    </section>
  </div>;
}

const styles: Record<string, CSSProperties> = {
  main: { minHeight: "100%", display: "grid", placeItems: "center", padding: 24, background: "#f6f4ef", color: "#171717" },
  card: { width: "100%", maxWidth: 620, padding: 32, borderRadius: 24, border: "1px solid var(--g3-border)", background: "#ffffff", boxShadow: "0 14px 40px -18px rgba(28,27,24,0.22)" },
  eyebrow: { fontSize: 12, letterSpacing: 2, opacity: .65, marginBottom: 10 },
  freeBanner: { marginTop: 18, padding: 16, borderRadius: 12, background: "#E9F8EE", border: "1px solid rgba(26,148,74,0.35)", color: "#0A6E82", fontSize: 14, lineHeight: 1.5, fontWeight: 600 },
  welcome: { marginTop: 18, padding: 14, borderRadius: 12, background: "#E9F5F8", border: "1px solid rgba(8,153,180,0.35)", color: "#0A6E82", fontSize: 14, lineHeight: 1.5 },
  balance: { fontSize: 44, fontWeight: 800, margin: "24px 0 8px" },
  muted: { opacity: .7 },
  locked: { marginTop: 18, padding: 16, borderRadius: 12, background: "#F0EAFF", border: "1px solid rgba(91,43,224,0.35)", color: "#5B2BE0", lineHeight: 1.5 },
  note: { marginTop: 20, fontSize: 13, lineHeight: 1.6, opacity: .6 },
  phoneForm: { marginTop: 24, display: "grid", gap: 10 },
  label: { fontSize: 13, opacity: .75 },
  input: { width: "100%", boxSizing: "border-box", padding: "12px 14px", borderRadius: 10, border: "1px solid var(--g3-border)", background: "#ffffff", color: "#171717", fontSize: 15 },
  button: { marginTop: 8, width: "100%", border: 0, borderRadius: 999, padding: "14px 18px", fontWeight: 700, cursor: "pointer", background: "#171717", color: "white" },
  success: { marginTop: 16, padding: 12, borderRadius: 10, background: "#E9F5F8", border: "1px solid rgba(8,153,180,0.35)", color: "#0A6E82", lineHeight: 1.5 },
  notice: { marginTop: 16, padding: 12, borderRadius: 10, background: "#E9F5F8", border: "1px solid rgba(8,153,180,0.35)", color: "#0E5F73", lineHeight: 1.5 },
  error: { marginTop: 16, color: "#5B2BE0" },
  plansGrid: { marginTop: 18, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 14 },
  planCard: { display: "flex", flexDirection: "column", gap: 8, padding: 18, borderRadius: 16, border: "1px solid var(--g3-border)", background: "#faf9f6" },
  planHighlight: { border: "2px solid #0A6E82", background: "#f2fafa" },
  planBadge: { fontSize: 11, fontWeight: 800, letterSpacing: 1, textTransform: "uppercase", padding: "4px 10px", borderRadius: 999, background: "#0A6E82", color: "#fff" },
  planPrice: { fontSize: 20, fontWeight: 800 },
  planAudience: { fontSize: 12, opacity: 0.65, fontStyle: "italic" },
  planFeatures: { margin: 0, paddingLeft: 18, display: "grid", gap: 6, fontSize: 13, lineHeight: 1.45 },
  planNote: { fontSize: 13, fontWeight: 700, opacity: 0.6 },
  widgetsBlock: { marginTop: 26, padding: 18, borderRadius: 16, border: "1px dashed var(--g3-border)", background: "#faf9f6" },
  widgetsTitle: { fontSize: 14, fontWeight: 800, letterSpacing: 0.4, marginBottom: 12 },
  widgetsGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 },
  widgetCard: { display: "flex", flexDirection: "column", gap: 6, padding: 14, borderRadius: 12, border: "1px solid var(--g3-border)", background: "#ffffff" },
  widgetLabel: { fontSize: 14, fontWeight: 700 },
  widgetNote: { fontSize: 12, lineHeight: 1.45, opacity: 0.65, marginBottom: 6 },
  storeLink: { color: "#0A6E82", fontWeight: 700 },
  licenseForm: { marginTop: 24, display: "grid", gap: 8, paddingTop: 18, borderTop: "1px solid var(--g3-border)" },
};
