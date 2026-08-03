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

      const acct = msalInstance.getActiveAccount() || msalInstance.getAllAccounts()[0] || null;
      if (acct) {
        msalInstance.setActiveAccount(acct);
        setAccount(acct);
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

  const login = async () => {
    if (!msalInstance) return;
    rememberReturnPath();
    try {
      await msalInstance.loginRedirect(loginRequest);
    } catch (err) {
      console.error("M365 Login error:", err);
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
    if (!msalInstance) return;
    const acct = msalInstance.getAllAccounts()[0];
    try {
      await msalInstance.logoutPopup({ account: acct });
    } catch {
      // popup closed/blocked — still wipe local cache
    }
    try { await msalInstance.clearCache(); } catch { /* ignore */ }
    setAccount(null);
  };

  const getToken = async (): Promise<string | null> => {
    if (!msalInstance) return null;
    const acct = account || msalInstance.getActiveAccount() || msalInstance.getAllAccounts()[0];
    if (!acct) return null;
    try {
      const res = await msalInstance.acquireTokenSilent({ ...loginRequest, account: acct });
      return res.idToken || null;
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
          await msalInstance.acquireTokenRedirect({ ...loginRequest, account: acct });
          return null; // navigation in progress
        }
        const res = await msalInstance.acquireTokenPopup({ ...loginRequest, account: acct });
        return res.idToken || null;
      } catch {
        return null;
      }
    }
  };

  const getGraphToken = async (): Promise<string | null> => {
    if (!msalInstance) return null;
    const acct = account || msalInstance.getActiveAccount() || msalInstance.getAllAccounts()[0];
    if (!acct) return null;
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
