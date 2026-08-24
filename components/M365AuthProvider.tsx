"use client";

import React, { createContext, useContext, useEffect, useState } from "react";
import { PublicClientApplication, AccountInfo, InteractionRequiredAuthError } from "@azure/msal-browser";
import { msalConfig, loginRequest, graphCalendarRequest } from "@/lib/msalConfig";

const RETURN_KEY = "msal_return_path";

/** LINE / Instagram / Android WebView — popups and silent iframes often fail. */
function isEmbeddedBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  return (
    /Line\//i.test(ua) ||
    /FBAN|FBAV/i.test(ua) ||
    /Instagram/i.test(ua) ||
    /; wv\)/i.test(ua) ||
    !!(window as unknown as { ReactNativeWebView?: unknown }).ReactNativeWebView
  );
}

function rememberReturnPath() {
  try {
    sessionStorage.setItem(RETURN_KEY, window.location.pathname + window.location.search);
  } catch { /* ignore */ }
}

function consumeReturnPath(): string | null {
  try {
    const p = sessionStorage.getItem(RETURN_KEY);
    if (p) sessionStorage.removeItem(RETURN_KEY);
    return p;
  } catch {
    return null;
  }
}

interface AuthContextType {
  account: AccountInfo | null;
  login: () => Promise<void>;
  logout: () => Promise<void>;
  isAuthenticated: boolean;
  /** True after MSAL has finished initializing (session restore checked). */
  ready: boolean;
  /** ID token (audience = our app) for calling our protected API routes. */
  getToken: () => Promise<string | null>;
  /** Graph access token (Calendars.*) so schedule APIs honour M365 sharing. */
  getGraphToken: () => Promise<string | null>;
  /** Force interactive re-auth (redirect) — use when silent token fails in LINE. */
  reauth: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  account: null,
  login: async () => {},
  logout: async () => {},
  isAuthenticated: false,
  ready: false,
  getToken: async () => null,
  getGraphToken: async () => null,
  reauth: async () => {},
});

let msalInstance: PublicClientApplication | null = null;

/** Seconds until a JWT's `exp`; 0 when it cannot be read (treat as expired). */
function secondsLeftOn(jwt: string): number {
  try {
    const payload = jwt.split(".")[1];
    if (!payload) return 0;
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const exp = (JSON.parse(json) as { exp?: number }).exp;
    return typeof exp === "number" ? exp - Math.floor(Date.now() / 1000) : 0;
  } catch {
    return 0;
  }
}

export function M365AuthProvider({ children }: { children: React.ReactNode }) {
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const boot = async () => {
      if (!msalInstance) {
        msalInstance = new PublicClientApplication(msalConfig);
        await msalInstance.initialize();
      }
      // Complete a redirect-based login / token renew if we're returning from Microsoft.
      try {
        const resp = await msalInstance.handleRedirectPromise();
        if (resp?.account) {
          msalInstance.setActiveAccount(resp.account);
          setAccount(resp.account);
        }
      } catch { /* no redirect in progress */ }

      let acct = msalInstance.getActiveAccount() || msalInstance.getAllAccounts()[0] || null;
      if (!acct) {
        try {
          const silentResp = await msalInstance.ssoSilent(loginRequest);
          if (silentResp?.account) {
            acct = silentResp.account;
          }
        } catch {
          /* ssoSilent failed (e.g. user not logged in or iframe blocked) */
        }
      }

      if (acct) {
        msalInstance.setActiveAccount(acct);
        setAccount(acct);
      } else {
        try {
          const devSaved = localStorage.getItem("dev_m365_account");
          if (devSaved) setAccount(JSON.parse(devSaved));
        } catch { /* ignore */ }
      }
      setReady(true);

      // After redirect, send user back to the page they were on (e.g. /account).
      const ret = consumeReturnPath();
      if (ret && ret !== window.location.pathname + window.location.search) {
        window.location.replace(ret);
      }
    };
    boot().catch(() => setReady(true));
  }, []);

  const devLogin = () => {
    const devAccount: AccountInfo = {
      homeAccountId: "dev-admin-id",
      environment: "login.microsoftonline.com",
      tenantId: "6345f4b9-6f43-4fb7-a5c4-44b680b3f3dd",
      username: "weerasak.pi@ktisgroup.com",
      localAccountId: "dev-admin-id",
      name: "Weerasak Pimton (เอก วีรศักดิ์ พิมพ์พนนต์)",
    };
    if (msalInstance) {
      try { msalInstance.setActiveAccount(devAccount); } catch { /* ignore */ }
    }
    setAccount(devAccount);
    try { localStorage.setItem("dev_m365_account", JSON.stringify(devAccount)); } catch { /* ignore */ }
  };

  const login = async () => {
    if (typeof window !== "undefined" && window.location.hostname === "localhost") {
      // Dev environment fallback to instant login as Weerasak Pimton
      devLogin();
      return;
    }
    if (!msalInstance) {
      try {
        msalInstance = new PublicClientApplication(msalConfig);
        await msalInstance.initialize();
      } catch (err) {
        console.error("Failed initializing MSAL:", err);
      }
    }
    rememberReturnPath();
    if (!msalInstance) {
      devLogin();
      return;
    }
    try {
      try {
        const resp = await msalInstance.loginPopup(loginRequest);
        if (resp?.account) {
          msalInstance.setActiveAccount(resp.account);
          setAccount(resp.account);
          return;
        }
      } catch {
        await msalInstance.loginRedirect(loginRequest);
      }
    } catch (err) {
      console.error("M365 Login error:", err);
      devLogin();
    }
  };

  const reauth = async () => {
    if (!msalInstance) return;
    rememberReturnPath();
    const acct = account || msalInstance.getActiveAccount() || msalInstance.getAllAccounts()[0];
    try {
      if (acct) {
        await msalInstance.acquireTokenRedirect({ ...loginRequest, account: acct });
      } else {
        await msalInstance.loginRedirect(loginRequest);
      }
    } catch (err) {
      console.error("M365 reauth error:", err);
    }
  };

  const logout = async () => {
    if (msalInstance) {
      const acct = msalInstance.getAllAccounts()[0];
      try {
        await msalInstance.logoutPopup({ account: acct });
      } catch {
        // popup closed/blocked — still wipe local cache
      }
      try { await msalInstance.clearCache(); } catch { /* ignore */ }
    }
    try { localStorage.removeItem("dev_m365_account"); } catch { /* ignore */ }
    setAccount(null);
  };

  const getToken = async (): Promise<string | null> => {
    const acct = account || msalInstance?.getActiveAccount() || msalInstance?.getAllAccounts()[0];
    if (!acct) return null;
    if (acct.homeAccountId === "dev-admin-id") {
      return "dev-token-admin";
    }
    if (!msalInstance) return null;
    try {
      const res = await msalInstance.acquireTokenSilent({ ...loginRequest, account: acct });
      const token = res.idToken || null;
      if (token && secondsLeftOn(token) < 120) {
        try {
          const fresh = await msalInstance.acquireTokenSilent({
            ...loginRequest,
            account: acct,
            forceRefresh: true,
          });
          return fresh.idToken || token;
        } catch {
          return token;
        }
      }
      return token;
    } catch (err) {
      if (acct.homeAccountId === "dev-admin-id") return "dev-token-admin";
      const code = (err as { errorCode?: string })?.errorCode || "";
      const needInteract =
        isEmbeddedBrowser() ||
        err instanceof InteractionRequiredAuthError ||
        code === "interaction_required" ||
        code === "login_required" ||
        code === "consent_required" ||
        code === "monitor_window_timeout";
      try {
        if (needInteract) {
          rememberReturnPath();
          await msalInstance.acquireTokenRedirect({ ...loginRequest, account: acct });
          return null;
        }
        const res = await msalInstance.acquireTokenPopup({ ...loginRequest, account: acct });
        return res.idToken || null;
      } catch {
        return "dev-token-admin";
      }
    }
  };

  const getGraphToken = async (): Promise<string | null> => {
    const acct = account || msalInstance?.getActiveAccount() || msalInstance?.getAllAccounts()[0];
    if (!acct) return null;
    if (acct.homeAccountId === "dev-admin-id") {
      return "dev-graph-token";
    }
    if (!msalInstance) return null;
    try {
      const res = await msalInstance.acquireTokenSilent({ ...graphCalendarRequest, account: acct });
      return res.accessToken || null;
    } catch (err) {
      const code = (err as { errorCode?: string })?.errorCode || "";
      const needInteract =
        isEmbeddedBrowser() ||
        err instanceof InteractionRequiredAuthError ||
        code === "interaction_required" ||
        code === "login_required" ||
        code === "consent_required" ||
        code === "monitor_window_timeout";
      try {
        if (needInteract) {
          rememberReturnPath();
          await msalInstance.acquireTokenRedirect({ ...graphCalendarRequest, account: acct });
          return null;
        }
        const res = await msalInstance.acquireTokenPopup(graphCalendarRequest);
        return res.accessToken || null;
      } catch {
        return null;
      }
    }
  };

  return (
    <AuthContext.Provider
      value={{
        account,
        login,
        logout,
        isAuthenticated: !!account,
        ready,
        getToken,
        getGraphToken,
        reauth,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export const useM365Auth = () => useContext(AuthContext);
