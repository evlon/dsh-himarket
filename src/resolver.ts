/**
 * Official @deepseek-ai/* package resolver.
 *
 * The web profile's node_modules/@deepseek-ai is an empty directory: official
 * packages actually live in the global dsh install, and Node's CJS resolution
 * walks parent directories, so createRequire(ctx.baseUrl) resolves them from
 * the profile directory.
 *
 * This bridge package carries only light deps; official packages (mcp-client /
 * settings / tools / schemastery) are ALWAYS resolved at runtime through this
 * module, never statically imported (a static import would resolve against this
 * package's own node_modules and fail under the profile).
 *
 * @module dsh-himarket/resolver
 */

import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

/** Resolve an official package entry from the profile directory (file:// URL). */
export function resolveOfficial(specifier: string, baseUrl: string): string {
  const req = createRequire(baseUrl)
  const resolved = req.resolve(specifier)
  return pathToFileURL(resolved).href
}

/** Dynamically import an official package (ESM or CJS). */
export async function importOfficial(specifier: string, baseUrl: string): Promise<Record<string, unknown>> {
  return (await import(resolveOfficial(specifier, baseUrl))) as Record<string, unknown>
}

/** Synchronously require an official CJS package (e.g. schemastery). */
export function requireOfficial(specifier: string, baseUrl: string): unknown {
  const req = createRequire(baseUrl)
  return req(specifier)
}
