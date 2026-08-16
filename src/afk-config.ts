import { constants } from "node:fs";
import { copyFile, lstat, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export const RECOMMENDED_AFK_TIMEOUT_SECONDS = 60;

export type AfkConfigStatusKind = "configured" | "different" | "not-explicit" | "missing" | "unsupported" | "error";

export interface AfkConfigStatus {
  kind: AfkConfigStatusKind;
  configPath?: string;
  timeoutSeconds?: number;
  message?: string;
}

export interface AfkConfigurationResult {
  configPath: string;
  backupPath: string;
}

function configRoot(): string | undefined {
  if (process.platform !== "linux") return undefined;
  const xdgConfig = process.env.XDG_CONFIG_HOME;
  if (xdgConfig !== undefined && xdgConfig.length > 0 && isAbsolute(xdgConfig)) return xdgConfig;
  return join(homedir(), ".config");
}

export function getAfkConfigPath(): string | undefined {
  const root = configRoot();
  return root === undefined
    ? undefined
    : join(root, "activitywatch", "aw-watcher-afk", "aw-watcher-afk.toml");
}

function sectionBounds(lines: string[]): { start: number; end: number } | undefined {
  const start = lines.findIndex((line) => /^\s*\[aw-watcher-afk\]\s*(?:#.*)?$/.test(line));
  if (start === -1) return undefined;
  const relativeEnd = lines.slice(start + 1).findIndex((line) => /^\s*\[[^\]]+\]/.test(line));
  return { start, end: relativeEnd === -1 ? lines.length : start + 1 + relativeEnd };
}

export function readAfkTimeoutFromText(content: string): number | undefined {
  const lines = content.split(/\r?\n/);
  const bounds = sectionBounds(lines);
  if (bounds === undefined) return undefined;

  for (let index = bounds.start + 1; index < bounds.end; index += 1) {
    const match = /^\s*timeout\s*=\s*(\d+(?:\.\d+)?)\s*(?:#.*)?$/.exec(lines[index] ?? "");
    if (match?.[1] !== undefined) return Number(match[1]);
  }
  return undefined;
}

export function updateAfkConfigText(content: string, timeoutSeconds: number): string {
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const hadTrailingNewline = content.endsWith("\n");
  const lines = content.split(/\r?\n/);
  if (hadTrailingNewline) lines.pop();
  const bounds = sectionBounds(lines);
  if (bounds === undefined) throw new Error("The [aw-watcher-afk] section was not found");

  const timeoutPattern = /^(\s*)#?\s*timeout\s*=.*$/;
  for (let index = bounds.start + 1; index < bounds.end; index += 1) {
    const line = lines[index] ?? "";
    const match = timeoutPattern.exec(line);
    if (match !== null) {
      lines[index] = `${match[1] ?? ""}timeout = ${timeoutSeconds}`;
      return `${lines.join(newline)}${hadTrailingNewline ? newline : ""}`;
    }
  }

  lines.splice(bounds.start + 1, 0, `timeout = ${timeoutSeconds}`);
  return `${lines.join(newline)}${hadTrailingNewline ? newline : ""}`;
}

export async function inspectAfkConfig(): Promise<AfkConfigStatus> {
  const configPath = getAfkConfigPath();
  if (configPath === undefined) return { kind: "unsupported", message: "Automatic configuration is available on Linux only." };

  try {
    const info = await lstat(configPath);
    if (!info.isFile() || info.isSymbolicLink()) {
      return { kind: "error", configPath, message: "The ActivityWatch config is not a regular file." };
    }
    const timeoutSeconds = readAfkTimeoutFromText(await readFile(configPath, "utf8"));
    if (timeoutSeconds === undefined) return { kind: "not-explicit", configPath };
    return {
      kind: timeoutSeconds === RECOMMENDED_AFK_TIMEOUT_SECONDS ? "configured" : "different",
      configPath,
      timeoutSeconds
    };
  } catch (error) {
    const code = typeof error === "object" && error !== null
      ? (error as Record<string, unknown>).code
      : undefined;
    if (code === "ENOENT") return { kind: "missing", configPath };
    return { kind: "error", configPath, message: error instanceof Error ? error.message : String(error) };
  }
}

export async function configureAfkTimeout(
  timeoutSeconds = RECOMMENDED_AFK_TIMEOUT_SECONDS
): Promise<AfkConfigurationResult> {
  const configPath = getAfkConfigPath();
  if (configPath === undefined) throw new Error("Automatic configuration is available on Linux only");

  const info = await lstat(configPath);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Refusing to replace a non-regular ActivityWatch config file");
  const current = await readFile(configPath, "utf8");
  const updated = updateAfkConfigText(current, timeoutSeconds);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${configPath}.daily-hub-backup-${timestamp}`;
  const temporaryPath = `${configPath}.daily-hub-${process.pid}-${Date.now()}.tmp`;

  await copyFile(configPath, backupPath, constants.COPYFILE_EXCL);
  try {
    await writeFile(temporaryPath, updated, { encoding: "utf8", mode: info.mode & 0o777 });
    await rename(temporaryPath, configPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }

  return { configPath, backupPath };
}
