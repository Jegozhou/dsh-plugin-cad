/** Small async helpers shared by the runtime tests. */

/** Resolve after `ms` milliseconds. */
export function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
