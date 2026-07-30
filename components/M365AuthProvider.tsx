"use client";

import React, { createContext, useContext, useEffect, useState } from "react";
import { PublicClientApplication, AccountInfo } from "@azure/msal-browser";
import { msalConfig, loginRequest } from "@/lib/msalConfig";

interface AuthContextType {
  account: AccountInfo | null;
  login: () => Promise<void>;
  logout: () => void;
  isAuthenticated: boolean;
  /** ID token (audience = our app) for calling our protected API routes. */
  getToken: () => Promise<string | null>;
}

const AuthContext = createContext<AuthContextType>({
  account: null,
  login: async () => {},
  logout: () => {},
  isAuthenticated: false,
  getToken: async () => null,
});

let msalInstance: PublicClientApplication | null = null;

export function M365AuthProvider({ children }: { children: React.ReactNode }) {
  const [account, setAccount] = useState<AccountInfo | null>(null);

  useEffect(() => {
    if (!msalInstance && typeof window !== "undefined") {
      msalInstance = new PublicClientApplication(msalConfig);
      msalInstance.initialize().then(() => {
        const currentAccounts = msalInstance?.getAllAccounts();
        if (currentAccounts && currentAccounts.length > 0) {
          setAccount(currentAccounts[0]);
        }
      });
    }
  }, []);

  const login = async () => {
    if (!msalInstance) return;
    try {
      const response = await msalInstance.loginPopup(loginRequest);
      setAccount(response.account);
    } catch (err) {
      console.error("M365 Login error:", err);
    }
  };

  const logout = () => {
    if (!msalInstance) return;
    msalInstance.logoutPopup();
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
        getToken,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export const useM365Auth = () => useContext(AuthContext);
