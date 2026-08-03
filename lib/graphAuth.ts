// Request-scoped Graph auth: when a user access token is present, Graph calls
// run as that user (delegated) and respect Microsoft 365 calendar sharing /
// free-busy permissions — same as Outlook. Cron / background jobs leave this
// empty and keep using app-only client credentials.
import { AsyncLocalStorage } from "async_hooks";

type Store = { userToken?: string };

const als = new AsyncLocalStorage<Store>();

export function getUserGraphToken(): string | undefined {
  return als.getStore()?.userToken;
}

export async function runWithUserGraphToken<T>(
  userToken: string | undefined,
  fn: () => Promise<T>
): Promise<T> {
  if (!userToken) return fn();
  return als.run({ userToken }, fn);
}
