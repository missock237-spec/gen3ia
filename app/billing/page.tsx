"use client";

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { onAuthStateChanged, type User } from "firebase/auth";
import { auth } from "@/lib/firebase/client";
import { authFetch, useSessionAvailable } from "@/lib/firebase/auth-client";

interface Wallet {
  currency: string;
  balanceMinor: number;
  reservedMinor: number;
  availableMinor: number;
  welcomeGranted: boolean;
  welcomeAmountMinor: number;
}

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

interface WalletTransaction {
  id: string;
  type: string;
  amountMinor: number;
  currency: string;
  provider?: string;
  reference?: string;
  createdAt: number;
}

const TRANSACTION_LABELS: Record<string, string> = {
  topup: "Recharge",
  charge: "Consommation",
  charge_confirmed: "Consommation confirmée",
  reserve: "Réservation",
  release: "Réservation annulée",
  refund: "Remboursement",
  welcome_credit: "Crédit de bienvenue",
  adjustment: "Ajustement",
};

function formatTransactionDate(ts: number) {
  return new Date(ts).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" });
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
  const [transactions, setTransactions] = useState<WalletTransaction[]>([]);
  const sessionDisponible = useSessionAvailable();

  const loadWallet = useCallback(async () => {
    // authFetch : ID token Firebase si disponible, sinon cookie de session.
    const response = await authFetch("/api/billing/wallet", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Impossible de charger le solde.");
    setWallet(data.wallet);
  }, []);

  const loadTransactions = useCallback(async () => {
    try {
      const response = await authFetch("/api/billing/transactions?limit=15", { cache: "no-store" });
      if (!response.ok) return;
      const data = await response.json();
      setTransactions(data.transactions ?? []);
    } catch { /* historique indisponible : section masquée */ }
  }, []);

  useEffect(() => onAuthStateChanged(auth, async (current) => {
    setUser(current);
    // L'etat Firebase client peut etre perdu (webviews mobiles) : on charge
    // quand meme le solde via le cookie de session serveur.
    if (!current) {
      try { await loadWallet(); await loadTransactions(); } catch { /* aucune session : page de connexion affichee */ }
      finally { setLoading(false); }
      return;
    }
    try {
      await loadWallet();
      await loadTransactions();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Impossible de charger le solde.");
    } finally { setLoading(false); }
  }), [loadWallet, loadTransactions]);

  // Retour de paiement Chariow : ?topup=success&sale=sal_xxx
  useEffect(() => {
    if (sessionDisponible === false) return;
    const params = new URLSearchParams(window.location.search);
    const topup = params.get("topup");
    const saleId = params.get("sale");
    if (topup !== "success") return;

    window.history.replaceState({}, "", "/billing");
    if (!saleId) {
      // Differe d'un tick pour eviter un rendu en cascade synchrone (set-state-in-effect).
      const timer = setTimeout(() => setNotice("Paiement terminé. Le crédit apparaît dès la confirmation Chariow."), 0);
      return () => clearTimeout(timer);
    }
    (async () => {
      try {
        const response = await authFetch("/api/billing/topup/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ saleId }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? "Vérification du paiement impossible.");
        setWallet(data.wallet);
        if (data.credited) {
          setSuccess(`Recharge confirmée : +${((data.wallet.balanceMinor ?? 0) / 100).toLocaleString("fr-FR")} ${data.wallet.currency} crédités sur votre portefeuille.`);
        } else {
          setNotice(data.reason ?? "Paiement reçu. Le crédit est en cours de confirmation.");
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Vérification du paiement impossible.");
      }
    })();
  }, [sessionDisponible, user]);

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
      setPhase("redirecting");
      window.location.href = data.checkoutUrl;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Impossible d'ouvrir le paiement.");
      setPhase("idle");
    }
  };

  const submitPhone = (event: React.FormEvent) => {
    event.preventDefault();
    const digits = phoneNumber.replace(/\D/g, "");
    if (!digits) { setError("Saisissez votre numéro de téléphone Mobile Money."); return; }
    startTopup({ number: digits, country_code: countryCode });
  };

  if (sessionDisponible === false) {
    return <div style={styles.main}><section style={styles.card}><h1 className="font-serif">Financement Gen3ia</h1><p>Connectez-vous pour consulter votre solde et recharger votre compte.</p></section></div>;
  }

  const currency = wallet?.currency ?? "XAF";
  const amount = wallet ? (wallet.balanceMinor / 100).toLocaleString("fr-FR", { minimumFractionDigits: 0, maximumFractionDigits: 2 }) : "0";
  const reserved = wallet ? (wallet.reservedMinor / 100).toLocaleString("fr-FR") : "0";
  const available = wallet ? (wallet.availableMinor / 100).toLocaleString("fr-FR") : "0";
  const empty = Boolean(wallet && wallet.availableMinor <= 0);
  const welcome = wallet ? (wallet.welcomeAmountMinor / 100).toLocaleString("fr-FR") : "0";
  const busy = phase === "creating" || phase === "redirecting";

  return <div style={styles.main}>
    <div style={{ gridColumn: "1 / -1", width: "100%", maxWidth: 980, margin: "0 auto", justifySelf: "center" }}>
    </div>
    <section style={styles.card}>
      <div style={styles.eyebrow}>GEN3IA WALLET</div>
      <h1 className="font-serif">Solde de votre compte</h1>
      {wallet?.welcomeGranted && <div style={styles.welcome}>Solde de démonstration : {welcome} {currency} offerts une seule fois à l&apos;ouverture du compte.</div>}
      <div style={styles.balance}>{loading ? "…" : `${amount} ${currency}`}</div>
      <p style={styles.muted}>Disponible : {available} {currency} · Réservé : {reserved} {currency}</p>
      {empty && <div style={styles.locked}><strong>Agents IA arrêtés</strong><br />Votre solde disponible est à 0. Rechargez votre portefeuille pour reprendre les exécutions.</div>}

      {phase === "phone"
        ? <form onSubmit={submitPhone} style={styles.phoneForm}>
            <label style={styles.label} htmlFor="country">Pays du numéro</label>
            <select id="country" value={countryCode} onChange={(e) => setCountryCode(e.target.value)} style={styles.input}>
              {COUNTRY_CODES.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
            </select>
            <label style={styles.label} htmlFor="phone">Numéro Mobile Money (sans indicatif)</label>
            <input id="phone" inputMode="numeric" autoComplete="tel-national" placeholder="6 90 00 00 00" value={phoneNumber} onChange={(e) => setPhoneNumber(e.target.value)} style={styles.input} />
            <button type="submit" disabled={busy} style={styles.button}>{busy ? "Ouverture du paiement…" : "Payer avec Chariow (Mobile Money)"}</button>
          </form>
        : <button onClick={() => startTopup()} disabled={busy || loading} style={styles.button}>{busy ? "Ouverture du paiement…" : "Recharger avec Chariow"}</button>}

      {success && <p style={styles.success}>{success}</p>}
      {notice && <p style={styles.notice}>{notice}</p>}
      <p style={styles.note}>Le paiement s&apos;effectue via la boutique Chariow (Mobile Money, carte ou wallet selon votre pays). Le solde est crédité après confirmation du paiement par Chariow — automatiquement via le webhook signé, ou à votre retour sur cette page.</p>
      <p style={styles.note}>Le solde de démonstration est accordé une seule fois. Après épuisement, vous devez recharger votre portefeuille. Les exécutions sont facturées selon l&apos;utilisation réelle et aucune nouvelle allocation gratuite n&apos;est créée automatiquement.</p>
      {error && <p style={styles.error}>{error}</p>}
    </section>
  </div>;
}

const styles: Record<string, CSSProperties> = {
  main: { minHeight: "100%", display: "grid", placeItems: "center", padding: 24, background: "#f6f4ef", color: "#171717" },
  card: { width: "100%", maxWidth: 620, padding: 32, borderRadius: 24, border: "1px solid rgba(23,23,20,0.09)", background: "#ffffff", boxShadow: "0 14px 40px -18px rgba(28,27,24,0.22)" },
  eyebrow: { fontSize: 12, letterSpacing: 2, opacity: .65, marginBottom: 10 },
  welcome: { marginTop: 18, padding: 14, borderRadius: 12, background: "#ecfdf5", border: "1px solid #a7f3d0", color: "#047857", fontSize: 14, lineHeight: 1.5 },
  balance: { fontSize: 44, fontWeight: 800, margin: "24px 0 8px" },
  muted: { opacity: .7 },
  locked: { marginTop: 18, padding: 16, borderRadius: 12, background: "#fef2f2", border: "1px solid #fecaca", color: "#b91c1c", lineHeight: 1.5 },
  note: { marginTop: 20, fontSize: 13, lineHeight: 1.6, opacity: .6 },
  phoneForm: { marginTop: 24, display: "grid", gap: 10 },
  label: { fontSize: 13, opacity: .75 },
  input: { width: "100%", boxSizing: "border-box", padding: "12px 14px", borderRadius: 10, border: "1px solid rgba(23,23,20,0.09)", background: "#ffffff", color: "#171717", fontSize: 15 },
  button: { marginTop: 8, width: "100%", border: 0, borderRadius: 999, padding: "14px 18px", fontWeight: 700, cursor: "pointer", background: "#171717", color: "white" },
  success: { marginTop: 16, padding: 12, borderRadius: 10, background: "#ecfdf5", border: "1px solid #a7f3d0", color: "#047857", lineHeight: 1.5 },
  notice: { marginTop: 16, padding: 12, borderRadius: 10, background: "#f0f9ff", border: "1px solid #bae6fd", color: "#0369a1", lineHeight: 1.5 },
  error: { marginTop: 16, color: "#dc2626" },
};
