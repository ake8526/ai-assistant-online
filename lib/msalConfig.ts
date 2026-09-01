import { Configuration, PopupRequest } from "@azure/msal-browser";

export const msalConfig: Configuration = {
  auth: {
    clientId: process.env.NEXT_PUBLIC_AZURE_CLIENT_ID || "e25bc0c0-aea3-4b45-849e-bb165f3b35ac",
    authority: `https://login.microsoftonline.com/${process.env.NEXT_PUBLIC_AZURE_TENANT_ID || "common"}`,
    redirectUri: typeof window !== "undefined" ? window.location.origin : "",
  },
  cache: {
    cacheLocation: "localStorage",
    storeAuthStateInCookie: false,
  },
};

/** Identity scopes — ID token for our API (audience = app client id). */
export const loginRequest: PopupRequest = {
  scopes: ["User.Read", "openid", "profile", "email"],
};

/**
 * ล็อกอินแบบให้เลือกบัญชีเสมอ — ไม่ใส่ใน loginRequest ปกติ เพราะตัวนั้นใช้กับ
 * acquireTokenSilent ด้วย ถ้าใส่ prompt ไป silent จะพัง
 *
 * ไม่มี prompt นี้ Azure AD มัก SSO กลับบัญชีเดิมทันที ไม่มีปุ่ม "บัญชีอื่น"
 */
export const loginSelectRequest: PopupRequest = {
  ...loginRequest,
  prompt: "select_account",
};

/**
 * Graph calendar scopes — access token for Microsoft Graph.
 * Free/busy and shared calendars then follow the signed-in user's M365 rights
 * (same as Outlook), not app-only Application Access Policy.
 */
export const graphCalendarRequest: PopupRequest = {
  scopes: [
    "User.Read",
    "People.Read",
    "Calendars.Read",
    "Calendars.ReadWrite",
  ],
};
