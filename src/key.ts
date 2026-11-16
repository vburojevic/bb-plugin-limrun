/**
 * The Limrun API key, held by the bb server only.
 *
 * In order: the key pasted on bb's Limrun page (a bb secret setting), then
 * `LIM_API_KEY` in the bb server's environment, then the key `lim login` or
 * `lim set-api-key` stored in `~/.lim/config.yaml` on the server's machine (a
 * single `api-key: <value>` line, checked against lim 0.57.3). Agents never
 * get it: their lim reaches Limrun through the server's proxy, and the browser
 * only gets one simulator's stream URL and stream-only token.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type KeySource = "bb" | "env" | "lim-config";

export interface ResolvedKey {
  key: string;
  source: KeySource;
}

export interface KeyEnvironment {
  /** The key pasted on bb's Limrun page, if any. */
  fromSettings?: () => Promise<string | null>;
  env: Record<string, string | undefined>;
  readConfig: () => Promise<string | null>;
}

export const LIM_CONFIG_PATH = join(homedir(), ".lim", "config.yaml");

export function defaultKeyEnvironment(fromSettings?: () => Promise<string | null>): KeyEnvironment {
  return {
    ...(fromSettings ? { fromSettings } : {}),
    env: process.env,
    readConfig: async () => {
      try {
        return await readFile(LIM_CONFIG_PATH, "utf8");
      } catch {
        return null;
      }
    },
  };
}

/** The `api-key` value of lim's YAML config, unquoted, or null. */
export function parseLimConfig(text: string): string | null {
  for (const raw of text.split(/\r?\n/)) {
    const match = /^api-key:\s*(.*?)\s*$/.exec(raw);
    if (match === null) continue;
    let value = match[1] ?? "";
    const quote = value[0];
    if ((quote === "'" || quote === '"') && value.endsWith(quote) && value.length >= 2) {
      value = value.slice(1, -1);
    }
    return value.length > 0 ? value : null;
  }
  return null;
}

export async function resolveApiKey(environment: KeyEnvironment): Promise<ResolvedKey | null> {
  const fromSettings = (await environment.fromSettings?.())?.trim();
  if (fromSettings) return { key: fromSettings, source: "bb" };
  const fromEnv = environment.env.LIM_API_KEY?.trim();
  if (fromEnv) return { key: fromEnv, source: "env" };
  const config = await environment.readConfig();
  const fromConfig = config === null ? null : parseLimConfig(config);
  if (fromConfig !== null) return { key: fromConfig, source: "lim-config" };
  return null;
}
