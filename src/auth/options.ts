import type Database from "better-sqlite3";
import type { BetterAuthOptions } from "better-auth";

export interface AuthConfig {
  baseURL: string;
  secret: string;
}

export function authOptions(db: Database.Database, config: AuthConfig): BetterAuthOptions {
  return {
    appName: "LoopShelf", database: db, baseURL: config.baseURL, secret: config.secret,
    trustedOrigins: [config.baseURL],
    emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 12,
      autoSignIn: false, revokeSessionsOnPasswordReset: true },
    session: { expiresIn: 60 * 60 * 24 * 7, cookieCache: { enabled: false } },
    advanced: { database: { generateId: "uuid" },
      useSecureCookies: config.baseURL.startsWith("https:"),
      ipAddress: { ipAddressHeaders: ["x-loopshelf-client-ip"] },
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax" } },
    rateLimit: { enabled: true, storage: "database", window: 60, max: 100,
      customRules: { "/sign-in/email": { window: 60, max: 5 } } },
  };
}
