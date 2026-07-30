"use client";

import React, { createContext, useContext, useEffect, useState } from "react";
import { PublicClientApplication, AccountInfo } from "@azure/msal-browser";
import { msalConfig, loginRequest } from "@/lib/msalConfig";

interface AuthContextType {
  account: AccountInfo | null;
  login: () => Promise<void>;
  logout: () => Promise<void>;
  isAuthenticated: boolean;
  /** True after MSAL has finished initializing (session restore checked). */
  ready: boolean;
  /** ID token (audience = our app) for calling our protected API routes. */
  getToken: () => Promise<string | null>;
}

const AuthContext = createContext<AuthContextType>({
  account: null,
  login: async () => {},
  logout: async () => {},
  isAuthenticated: false,
  ready: false,
  getToken: async () => null,
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
      // Complete a redirect-based login if we're returning from Microsoft.
      try {
        const resp = await msalInstance.handleRedirectPromise();
        if (resp?.account) msalInstance.setActiveAccount(resp.account);
      } catch { /* no redirect in progress */ }
      const acct = msalInstance.getActiveAccount() || msalInstance.getAllAccounts()[0] || null;
      if (acct) setAccount(acct);
      setReady(true);
    };
    boot().catch(() => setReady(true));
  }, []);

  const login = async () => {
    if (!msalInstance) return;
    // Redirect flow works everywhere, including the LINE in-app webview where
    // popups are blocked. The result is picked up by handleRedirectPromise on
    // return (see boot()).
    try {
      await msalInstance.loginRedirect(loginRequest);
    } catch (err) {
      console.error("M365 Login error:", err);
    }
  };

  const logout = async () => {
    if (!msalInstance) return;
    const acct = msalInstance.getAllAccounts()[0];
    // No mainWindowRedirectUri: the popup ends the MS session but leaves the main
    // window alone, so the clearCache below always runs.
    try {
      await msalInstance.logoutPopup({ account: acct });
    } catch {
      // popup closed/blocked — that's fine, we still wipe the local cache next
    }
    // Always clear the local MSAL cache so the browser truly forgets this account
    // (otherwise 365 keeps showing as connected even after "sign out").
    try { await msalInstance.clearCache(); } catch { /* ignore */ }
    setAccount(null);
  };

  const getToken = async (): Promise<string | null> => {
    if (!msalInstance) return null;
    const acct = account || msalInstance.getAllAccounts()[0];
    if (!acct) return null;
    try {
      const res = await msalInstance.acquireTokenSilent({ ...loginRequest, account: acct });
      return res.idToken || null;
    } catch {
      try {
        const res = await msalInstance.acquireTokenPopup(loginRequest);
        return res.idToken || null;
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
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export const useM365Auth = () => useContext(AuthContext);
