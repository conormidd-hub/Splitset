/**
 * One-tap sign-in for preview builds.
 *
 * Both values are inlined at bundle time, so they exist only in builds whose environment
 * defines them. On Vercel they are set for the Preview environment alone (and
 * scripts/vercel-build.mjs drops them from production builds regardless), so production never
 * shows the card and never carries the password. Locally, add them to app/.env.
 *
 * The account itself is created by supabase/seed_demo.py and holds only sample data.
 */
const email = process.env.EXPO_PUBLIC_DEMO_EMAIL;
const password = process.env.EXPO_PUBLIC_DEMO_PASSWORD;

export const demoAccount: { email: string; password: string } | null =
  email && password ? { email, password } : null;

/** True when the signed-in user is the demo athlete. */
export function isDemoUser(userEmail: string | null | undefined): boolean {
  return !!demoAccount && !!userEmail && userEmail.toLowerCase() === demoAccount.email.toLowerCase();
}
