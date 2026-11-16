/**
 * The realtime channel the server publishes on when a thread's devices or
 * runs change; payload `{ threadId: string | null }`.
 *
 * Its own module with no imports, because the frontend bundle needs it and a
 * git install builds that bundle without dev dependencies: importing it from
 * contract.ts pulled the plugin SDK into the frontend and broke the install.
 */
export const CHANGED_CHANNEL = "limrun-changed";
