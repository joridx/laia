/**
 * src/net/ — Network resilience layer for Laia.
 * Ported from Claudia's src/lib/net/, adapted (lighter, no audit log).
 */

export { friendlyError } from './friendly-error.js';
export {
  resilientFetch,
  configureService,
  getService,
  listServices,
  getBreakerState,
  resetBreaker,
  clearCache,
} from './fetch-client.js';
