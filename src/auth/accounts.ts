import { betterAuth } from "better-auth";
import type Database from "better-sqlite3";
import { z } from "zod";
import { authOptions, type AuthConfig } from "./options.ts";
import { withDatabase } from "../database/access.ts";

/** Operator-only local operations; these instances are never mounted as HTTP handlers. */
export async function createAccount(db: Database.Database, config: AuthConfig, input: unknown) {
  const data = z.object({ name: z.string().trim().min(1).max(100), email: z.email(),
    password: z.string().min(12).max(128) }).strict().parse(input);
  return withDatabase(db, async () => {
    const options = authOptions(db, config);
    const auth = betterAuth({ ...options, emailAndPassword: { ...options.emailAndPassword!, disableSignUp: false } });
    const result = await auth.api.signUpEmail({ body: data });
    return { id: result.user.id, email: result.user.email, name: result.user.name };
  });
}

export async function resetAccountPassword(db: Database.Database, config: AuthConfig, input: unknown): Promise<void> {
  const data = z.object({ email: z.email(), password: z.string().min(12).max(128) }).strict().parse(input);
  await withDatabase(db, async () => {
    const options = authOptions(db, config);
    let token: string | undefined;
    const auth = betterAuth({ ...options, emailAndPassword: { ...options.emailAndPassword!,
      sendResetPassword: async (message) => { token = message.token; } } });
    await auth.api.requestPasswordReset({ body: { email: data.email } });
    if (!token) throw new Error("Account does not exist");
    await auth.api.resetPassword({ body: { token, newPassword: data.password } });
  });
}
