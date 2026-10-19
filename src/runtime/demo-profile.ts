// The demo profile is a portfolio-demo decision, not a product default.
// Product defaults never change: only a process started with
// CONDUIT_DEMO_PROFILE=1 in its environment has the demo profile, and nothing
// in the API or settings can turn it on.

/** Portfolio-demo switch (Jon 2026-10-19). Off unless exactly "1". Read on every call. */
export const DEMO_PROFILE_ENV = 'CONDUIT_DEMO_PROFILE';

export function isDemoProfileEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[DEMO_PROFILE_ENV] === '1';
}
