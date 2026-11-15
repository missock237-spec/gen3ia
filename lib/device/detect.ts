/**
 * Detection automatique d'appareils pour Gen3ia AI Studio.
 *
 * Module 100% pur (aucune API Node, aucune dependance externe) : il est
 * utilise a la fois dans le proxy Next.js (runtime edge), dans les routes
 * API (runtime node) et cote client via `lib/device/use-device.ts`.
 *
 * Sources de verite combinees :
 * - User-Agent ( toujours present, marqueur `Gen3iaDesktop/` pour l'app PC)
 * - Client Hints serveur : sec-ch-ua-mobile, sec-ch-ua-platform ( Chromium )
 * - Indices client : pont Electron (window.gen3iaDesktop), mode standalone PWA
 */

export type DeviceType = "desktop" | "mobile" | "tablet" | "unknown";

export type DeviceOs =
  | "windows"
  | "macos"
  | "linux"
  | "android"
  | "ios"
  | "ipados"
  | "chromeos"
  | "unknown";

export interface DeviceInfo {
  type: DeviceType;
  os: DeviceOs;
  browser: string;
  /** Vrai si l'app PC Gen3ia (Electron) est detectee. */
  isDesktopApp: boolean;
  /** Vrai si la page tourne comme application installee (PWA standalone). */
  isPwaStandalone: boolean;
  isDesktop: boolean;
  isMobile: boolean;
  isTablet: boolean;
  /**
   * L'agent Live (capture d'ecran + controle clavier/souris) exige un vrai
   * ordinateur : Windows, Linux ou macOS. Bloque sur mobile, tablette et
   * environnements inconnus.
   */
  isLiveCapable: boolean;
}

export interface DetectDeviceInput {
  userAgent: string;
  /** Header `sec-ch-ua-mobile` : "?1" sur mobile. */
  mobileHint?: string | null;
  /** Header `sec-ch-ua-platform` : "Windows", "Android", "macOS", ... */
  platformHint?: string | null;
  /** Pont preload Electron detecte cote client (window.gen3iaDesktop). */
  desktopApp?: boolean;
  /** Page en mode application installee (display-mode: standalone). */
  pwaStandalone?: boolean;
}

/** Marqueur ajoute a l'User-Agent par l'app desktop (desktop/main.js). */
export const DESKTOP_APP_UA_FLAG = "Gen3iaDesktop";

const TABLET_UA =
  /iPad|Tablet|PlayBook|Silk|Kindle|Nexus (?:7|9|10)|SM-T\d{3}/i;
const MOBILE_UA =
  /iPhone|iPod|Windows Phone|Windows Mobile|IEMobile|BlackBerry|Opera Mini|Opera Mobi|Mobile Safari|FxiOS/i;
const ANDROID_UA = /Android/i;
const IOS_UA = /iPhone|iPod|iPad/i;
const WINDOWS_UA = /Windows NT|Windows Phone/i;
const MAC_UA = /Macintosh|Mac OS X/i;
const CROS_UA = /CrOS/i;
const LINUX_UA = /X11; Linux|Linux x86_64|Ubuntu|Fedora|Debian/i;

const BROWSERS: Array<[RegExp, string]> = [
  [/Gen3iaDesktop[/\s]([\d.]+)/i, "Gen3ia Desktop"],
  [/Edg(?:e|A|iOS)?[/\s]([\d.]+)/, "Microsoft Edge"],
  [/OPR[/\s]([\d.]+)/, "Opera"],
  [/SamsungBrowser[/\s]([\d.]+)/, "Samsung Internet"],
  [/Firefox[/\s]([\d.]+)/, "Firefox"],
  [/CriOS[/\s]([\d.]+)/, "Chrome iOS"],
  [/FxiOS[/\s]([\d.]+)/, "Firefox iOS"],
  [/Chrome[/\s]([\d.]+)/, "Chrome"],
  [/Version[/\s]([\d.]+).*Safari/, "Safari"],
  [/Safari[/\s]([\d.]+)/, "Safari"],
  [/Electron[/\s]([\d.]+)/, "Electron"],
];

function detectOs(userAgent: string, platformHint?: string | null): DeviceOs {
  const platform = (platformHint ?? "").toLowerCase();
  if (platform.includes("windows") || WINDOWS_UA.test(userAgent)) {
    if (/Windows Phone/i.test(userAgent) && !/Windows NT/.test(userAgent)) return "unknown";
    return "windows";
  }
  if (platform.includes("android") || ANDROID_UA.test(userAgent)) return "android";
  if (IOS_UA.test(userAgent)) return /iPad/i.test(userAgent) ? "ipados" : "ios";
  if (platform.includes("chrome os") || CROS_UA.test(userAgent)) return "chromeos";
  if (platform.includes("macos") || MAC_UA.test(userAgent)) return "macos";
  if (platform.includes("linux") || LINUX_UA.test(userAgent)) return "linux";
  return "unknown";
}

function detectBrowser(userAgent: string): string {
  for (const [pattern, name] of BROWSERS) {
    const match = userAgent.match(pattern);
    if (match) {
      const version = match[1] ? match[1].split(".")[0] : "";
      return version ? `${name} ${version}` : name;
    }
  }
  return "Navigateur inconnu";
}

/**
 * Detecte l'appareil a partir de l'User-Agent et des indices disponibles.
 * Le resultat est deterministe et sur : en cas de doute, l'appareil est
 * traite comme non-desktop (l'agent Live reste ainsi protege par defaut).
 */
export function detectDevice(input: DetectDeviceInput): DeviceInfo {
  const userAgent = input.userAgent ?? "";
  const os = detectOs(userAgent, input.platformHint);

  // 1) App PC officielle (Electron) : marqueur UA ou pont preload.
  const isDesktopApp =
    input.desktopApp === true ||
    userAgent.includes(`${DESKTOP_APP_UA_FLAG}/`) ||
    /\bElectron\b/.test(userAgent);

  // 2) Tablette : iPad, ou Android sans "Mobile" (convention des UAs Android).
  const androidTablet = ANDROID_UA.test(userAgent) && !/Mobile/i.test(userAgent);
  const isTablet = !isDesktopApp && (TABLET_UA.test(userAgent) || androidTablet);

  // 3) Mobile : UAs explicites, ou Client Hint sec-ch-ua-mobile "?1".
  const mobileHint = (input.mobileHint ?? "").trim() === "?1";
  const androidMobile = ANDROID_UA.test(userAgent) && /Mobile/i.test(userAgent);
  const isMobile =
    !isDesktopApp && !isTablet && (mobileHint || MOBILE_UA.test(userAgent) || androidMobile);

  // 4) Desktop : OS de bureau et ni mobile ni tablette.
  const desktopOs: DeviceOs[] = ["windows", "macos", "linux", "chromeos"];
  const isDesktop =
    isDesktopApp ||
    (!isMobile && !isTablet && desktopOs.includes(os) && userAgent.length > 0);

  const type: DeviceType = isDesktop
    ? "desktop"
    : isTablet
      ? "tablet"
      : isMobile
        ? "mobile"
        : "unknown";

  return {
    type,
    os: isDesktopApp && os === "unknown" ? "linux" : os,
    browser: detectBrowser(userAgent),
    isDesktopApp,
    isPwaStandalone: input.pwaStandalone === true,
    isDesktop,
    isMobile,
    isTablet,
    // L'agent Live est reserve aux vrais ordinateurs (Windows/Linux/macOS).
    isLiveCapable: isDesktop && (os === "windows" || os === "linux" || os === "macos"),
  };
}

/** Detecte depuis les headers d'une requete (proxy, route handler, RSC). */
export function detectDeviceFromHeaders(headers: {
  get(name: string): string | null;
}): DeviceInfo {
  return detectDevice({
    userAgent: headers.get("user-agent") ?? "",
    mobileHint: headers.get("sec-ch-ua-mobile"),
    platformHint: headers.get("sec-ch-ua-platform"),
  });
}
