/**
 * The Limrun API key, shared with the `lim` CLI.
 *
 * One sign-in per machine serves agents and this plugin: `LIM_API_KEY` in the
 * bb server's environment wins, then the key `lim login` or `lim set-api-key`
 * stored in `~/.lim/config.yaml` (a single `api-key: <value>` line, checked
 * against lim 0.57.3). The key never leaves the server: the browser only ever
 * receives one instance's stream URL and token.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type KeySource = "env" | "lim-config";

export interface ResolvedKey {
  key: string;
  source: KeySource;
}

export interface KeyEnvironment {
  env: Record<string, string | undefined>;
  readConfig: () => Promise<string | null>;
}

export const LIM_CONFIG_PATH = join(homedir(), ".lim", "config.yaml");

export function defaultKeyEnvironment(): KeyEnvironment {
  return {
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
  const fromEnv = environment.env.LIM_API_KEY?.trim();
  if (fromEnv) return { key: fromEnv, source: "env" };
  const config = await environment.readConfig();
  const fromConfig = config === null ? null : parseLimConfig(config);
  if (fromConfig !== null) return { key: fromConfig, source: "lim-config" };
  return null;
}
