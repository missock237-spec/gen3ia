/**
 * Formatage monétaire Gen3ia (UI) — source unique pour les prix affichés.
 *
 * Convention du dépôt : les montants transitent en unités MINEURES
 * (amountMinor = centimes, cf. lib/billing/wallet.ts). Or le XAF ( franc
 * CFA ) n'a PAS de sous-unité décimale (ISO 4217 : 0 chiffre) : l'ancien
 * affichage `amountMinor / 100` + suffixe manuel produisait « 12,5 XAF ».
 * `Intl.NumberFormat` avec maximumFractionDigits 0 garantit un prix entier
 * et le suffixe devise correct (« 1 250 XAF »), en fr-FR.
 */

/** XAF et XOF n'ont pas de décimales — tout autre code suit son défaut ISO. */
const ZERO_DECIMAL_CURRENCIES = new Set(["XAF", "XOF"]);

const formatters = new Map<string, Intl.NumberFormat>();

function getFormatter(currency: string, compact: boolean): Intl.NumberFormat {
  const key = `${currency}:${compact ? "compact" : "standard"}`;
  const cached = formatters.get(key);
  if (cached) return cached;
  const maximumFractionDigits = ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase()) ? 0 : undefined;
  const formatter = new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency,
    ...(compact ? { notation: "compact", maximumFractionDigits: 1 } : { maximumFractionDigits }),
  });
  formatters.set(key, formatter);
  return formatter;
}

/** Montant mineur (centimes) → prix affiché dans la devise, en français. */
function format(amountMinor: number, currency: string, compact: boolean): string {
  // Unités mineures non finies (API partielle, état de chargement) → 0.
  if (!Number.isFinite(amountMinor)) return getFormatter(currency, compact).format(0);
  return getFormatter(currency, compact).format(amountMinor / 100);
}

/**
 * Prix XAF (0 décimale) — remplace les `(amountMinor / 100).toLocaleString()`
 * manuels de la marketplace.
 */
export function formatXAF(amountMinor: number): string {
  return format(amountMinor, "XAF", false);
}

/** Prix XAF compact pour les espaces restreints (statistiques, badges). */
export function formatXAFShort(amountMinor: number): string {
  return format(amountMinor, "XAF", true);
}

/**
 * Prix multi-devises (le catalogue d'extensions peut déclarer une autre
 * devise que le XAF). Devise absente → XAF (marché principal).
 */
export function formatMoney(amountMinor: number, currency = "XAF"): string {
  return format(amountMinor, currency.toUpperCase() || "XAF", false);
}
