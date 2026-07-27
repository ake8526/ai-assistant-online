"use client";

import React, { createContext, useContext, useEffect, useState } from "react";
import { PublicClientApplication, AccountInfo } from "@azure/msal-browser";
import { msalConfig, loginRequest } from "@/lib/msalConfig";

interface AuthContextType {
  account: AccountInfo | null;
  login: () => Promise<void>;
  logout: () => void;
  isAuthenticated: boolean;
}

const AuthContext = createContext<AuthContextType>({
  account: null,
  login: async () => {},
  logout: () => {},
  isAuthenticated: false,
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

  return (
    <AuthContext.Provider
      value={{
        account,
        login,
        logout,
        isAuthenticated: !!account,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export const useM365Auth = () => useContext(AuthContext);
