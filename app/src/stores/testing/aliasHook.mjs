// A module resolve hook for the store tests (registerHooks from node:module). The stores import
// '@/…' as tsconfig maps it; this resolves those to src/….ts, except the four that need React
// Native, Metro or a server, which resolve to the stand-ins beside this file.

const STUBS = {
  '@/lib/supabase': './supabase.mjs',
  '@/lib/storage': './storage.mjs',
  '@/api/workoutLoads': './workoutLoads.mjs',
  '@/lib/recovery/constants': './constants.mjs',
};
const SRC = new URL('../../', import.meta.url);

export function resolve(specifier, context, nextResolve) {
  if (Object.hasOwn(STUBS, specifier)) return { url: new URL(STUBS[specifier], import.meta.url).href, shortCircuit: true };
  if (specifier.startsWith('@/')) return { url: new URL(`${specifier.slice(2)}.ts`, SRC).href, shortCircuit: true };
  return nextResolve(specifier, context);
}
