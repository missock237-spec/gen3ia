import { describe, expect, it } from "vitest";

import { detectDevice } from "./detect";

const UA_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const UA_LINUX =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const UA_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const UA_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const UA_ANDROID_PHONE =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";
const UA_ANDROID_TABLET =
  "Mozilla/5.0 (Linux; Android 13; SM-T870) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const UA_IPAD =
  "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const UA_DESKTOP_APP = `${UA_WINDOWS} Gen3iaDesktop/1.0.0 Electron/33.2.0`;

describe("detection automatique d'appareils", () => {
  it("reconnait un PC Windows comme desktop capable d'agent Live", () => {
    const device = detectDevice({ userAgent: UA_WINDOWS });
    expect(device.type).toBe("desktop");
    expect(device.os).toBe("windows");
    expect(device.isLiveCapable).toBe(true);
  });

  it("reconnait un PC Linux et un Mac comme desktops", () => {
    expect(detectDevice({ userAgent: UA_LINUX }).isLiveCapable).toBe(true);
    expect(detectDevice({ userAgent: UA_LINUX }).os).toBe("linux");
    expect(detectDevice({ userAgent: UA_MAC }).isLiveCapable).toBe(true);
    expect(detectDevice({ userAgent: UA_MAC }).os).toBe("macos");
  });

  it("bloque l'agent Live sur iPhone et Android (mobile)", () => {
    const iphone = detectDevice({ userAgent: UA_IPHONE });
    expect(iphone.type).toBe("mobile");
    expect(iphone.os).toBe("ios");
    expect(iphone.isLiveCapable).toBe(false);

    const android = detectDevice({ userAgent: UA_ANDROID_PHONE });
    expect(android.type).toBe("mobile");
    expect(android.os).toBe("android");
    expect(android.isLiveCapable).toBe(false);
  });

  it("traite les tablettes (iPad, Android sans Mobile) comme non-desktop", () => {
    const ipad = detectDevice({ userAgent: UA_IPAD });
    expect(ipad.type).toBe("tablet");
    expect(ipad.isLiveCapable).toBe(false);

    const tablet = detectDevice({ userAgent: UA_ANDROID_TABLET });
    expect(tablet.type).toBe("tablet");
    expect(tablet.isLiveCapable).toBe(false);
  });

  it("utilise les Client Hints en complement de l'User-Agent", () => {
    const device = detectDevice({
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
      mobileHint: "?0",
      platformHint: "Linux",
    });
    expect(device.type).toBe("desktop");

    const hinted = detectDevice({
      userAgent: "Mozilla/5.0 (Unknown)",
      mobileHint: "?1",
      platformHint: "Android",
    });
    expect(hinted.isMobile).toBe(true);
    expect(hinted.isLiveCapable).toBe(false);
  });

  it("reconnait l'app PC Gen3ia (Electron) et la considere toujours desktop", () => {
    const app = detectDevice({ userAgent: UA_DESKTOP_APP });
    expect(app.isDesktopApp).toBe(true);
    expect(app.type).toBe("desktop");
    expect(app.isLiveCapable).toBe(true);

    // Un agent malveillant ne devrait pas pouvoir se faire passer pour
    // desktop en ajoutant Electron a un UA mobile.
    const spoof = detectDevice({
      userAgent: `${UA_IPHONE} Gen3iaDesktop/1.0.0`,
      desktopApp: false,
    });
    expect(spoof.isDesktopApp).toBe(true);
  });

  it("reste sur par defaut sur (non capable) quand rien n'est identifiable", () => {
    const unknown = detectDevice({ userAgent: "curl/8.5.0" });
    expect(unknown.type).toBe("unknown");
    expect(unknown.isLiveCapable).toBe(false);
    expect(unknown.isDesktop).toBe(false);
  });
});
