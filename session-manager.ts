import { DynamicBorder, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Text, type SelectItem } from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, basename } from "node:path";

const SESSION_DIR = join(homedir(), ".pi", "agent", "sessions");
const CONFIG_FILE = join(homedir(), ".pi", "agent", "session-manager.json");
const DEFAULT_ARCHIVE_AGE_DAYS = 7;
const STARTUP_ARCHIVE_DELAY_MS = 1000;

type Config = { autoArchive: boolean; archiveAgeDays: number; lastArchiveAt?: number };

const defaultConfig: Config = { autoArchive: false, archiveAgeDays: DEFAULT_ARCHIVE_AGE_DAYS };

async function readConfig(): Promise<Config> {
  try {
    const parsed = JSON.parse(await fs.readFile(CONFIG_FILE, "utf8")) as Partial<Config>;
    const archiveAgeDays = typeof parsed.archiveAgeDays === "number" && Number.isFinite(parsed.archiveAgeDays)
      ? Math.max(1, Math.min(3650, Math.floor(parsed.archiveAgeDays)))
      : DEFAULT_ARCHIVE_AGE_DAYS;
    const lastArchiveAt = typeof parsed.lastArchiveAt === "number" && Number.isFinite(parsed.lastArchiveAt)
      ? parsed.lastArchiveAt
      : undefined;
    return { autoArchive: parsed.autoArchive === true, archiveAgeDays, lastArchiveAt };
  } catch {
    return { ...defaultConfig };
  }
}

async function writeConfig(config: Config): Promise<void> {
  await fs.mkdir(join(homedir(), ".pi", "agent"), { recursive: true });
  const temporary = `${CONFIG_FILE}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, CONFIG_FILE);
}

async function findSessionFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await findSessionFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(path);
    }
  }
  return files;
}

async function unzipFile(archive: string, destinationDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("unzip", ["-q", "-n", archive, "-d", destinationDir], { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`unzip exited with code ${code ?? "unknown"}`));
    });
  });
}

async function zipFile(file: string): Promise<void> {
  const archive = `${file}.zip`;
  const temporaryArchive = `${archive}.${process.pid}.tmp`;
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("zip", ["-q", "-9", "-j", temporaryArchive, file], { stdio: "ignore" });
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`zip exited with code ${code ?? "unknown"}`));
      });
    });
    await fs.rename(temporaryArchive, archive);
  } catch (error) {
    await fs.rm(temporaryArchive, { force: true }).catch(() => undefined);
    throw error;
  }
}

function sessionDirectoryForCwd(cwd: string): string {
  const normalized = cwd.replace(/\//g, "-");
  return join(SESSION_DIR, `--${normalized.replace(/^-/, "")}--`);
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (!part || typeof part !== "object") return "";
    const item = part as { type?: string; text?: unknown };
    return typeof item.text === "string" && ["text", "input_text", "output_text"].includes(item.type ?? "") ? item.text : "";
  }).filter(Boolean).join("\n");
}

function entryId(source: string, index: number): string {
  return createHash("sha1").update(`${source}:${index}`).digest("hex").slice(0, 8);
}

function piSessionJsonl(source: string, cwd: string, timestamp: string, messages: Array<{ role: "user" | "assistant"; text: string; timestamp: string }>): string {
  const sessionId = createHash("sha1").update(source).digest("hex").slice(0, 32);
  const header = { type: "session", version: 3, id: sessionId, timestamp, cwd };
  let parentId: string | null = null;
  const entries = messages.map((message, index) => {
    const id = entryId(source, index);
    const value = message.role === "assistant"
      ? { role: "assistant", content: [{ type: "text", text: message.text }], api: "imported", provider: "imported", model: "imported", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.parse(message.timestamp) || Date.now() }
      : { role: "user", content: message.text, timestamp: Date.parse(message.timestamp) || Date.now() };
    const entry = { type: "message", id, parentId, timestamp: message.timestamp, message: value };
    parentId = id;
    return entry;
  });
  return [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
}

async function convertExternalSession(file: string, sourceType: "claude" | "codex"): Promise<string | undefined> {
  const raw = await fs.readFile(file, "utf8");
  const sourceStat = await fs.stat(file);
  const messages: Array<{ role: "user" | "assistant"; text: string; timestamp: string }> = [];
  let cwd = process.cwd();
  let firstTimestamp = new Date(sourceStat.mtimeMs).toISOString();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line) as any;
      const timestamp = typeof item.timestamp === "string" ? item.timestamp : firstTimestamp;
      if (sourceType === "claude") {
        if (typeof item.cwd === "string") cwd = item.cwd;
        if (item.type !== "user" && item.type !== "assistant") continue;
        if (item.isMeta || item.isSidechain) continue;
        const text = textFromContent(item.message?.content);
        if (text.trim()) messages.push({ role: item.type, text, timestamp });
      } else {
        if (item.type === "session_meta" && typeof item.payload?.cwd === "string") {
          cwd = item.payload.cwd;
          continue;
        }
        const payload = item.type === "response_item" ? item.payload : undefined;
        if (payload?.type !== "message" || (payload.role !== "user" && payload.role !== "assistant")) continue;
        const text = textFromContent(payload.content);
        if (text.trim()) messages.push({ role: payload.role, text, timestamp });
      }
    } catch {
      // Ignore malformed or partially-written lines.
    }
  }
  if (messages.length === 0) return undefined;
  const destinationDir = sessionDirectoryForCwd(cwd);
  await fs.mkdir(destinationDir, { recursive: true });
  const name = `${sourceType}-${basename(file).replace(/[^a-zA-Z0-9._-]/g, "-")}`;
  const destination = join(destinationDir, name.endsWith(".jsonl") ? name : `${name}.jsonl`);
  try {
    await fs.access(destination);
    // Existing imports may predate timestamp preservation; refresh their mtime.
    await fs.utimes(destination, sourceStat.atime, sourceStat.mtime);
    return undefined;
  } catch {
    // New file.
  }
  await fs.writeFile(destination, piSessionJsonl(file, cwd, firstTimestamp, messages), { mode: 0o600 });
  // Preserve source modification time so imported sessions remain archiveable.
  await fs.utimes(destination, sourceStat.atime, sourceStat.mtime);
  return destination;
}

async function importExternalSessions(
  sourceType: "claude" | "codex",
  onProgress?: (completed: number, total: number) => void,
): Promise<{ imported: number; files: string[] }> {
  const root = sourceType === "claude" ? join(homedir(), ".claude", "projects") : join(homedir(), ".codex", "sessions");
  const files = await findSessionFiles(root);
  const imported: string[] = [];
  onProgress?.(0, files.length);
  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    try {
      const destination = await convertExternalSession(file, sourceType);
      if (destination) imported.push(destination);
    } catch (error) {
      console.warn(`[session-manager] import failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    onProgress?.(index + 1, files.length);
  }
  return { imported: imported.length, files: imported };
}

async function unpackSessions(sessionDir: string, onProgress?: (completed: number, total: number) => void): Promise<number> {
  const archives = (await fs.readdir(sessionDir, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl.zip"))
    .map((entry) => join(sessionDir, entry.name));
  let unpacked = 0;
  onProgress?.(0, archives.length);

  for (let index = 0; index < archives.length; index++) {
    const archive = archives[index];
    const target = archive.slice(0, -4);
    try {
      await fs.access(target);
    } catch {
      try {
        await unzipFile(archive, sessionDir);
        // unzip -n leaves an existing target untouched.
        try { await fs.access(target); unpacked++; } catch { /* no session in archive */ }
      } catch (error) {
        console.warn(`[session-manager] unpack failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    onProgress?.(index + 1, archives.length);
  }
  return unpacked;
}

async function countOldSessions(currentSession: string | undefined, archiveAgeDays: number): Promise<number> {
  const cutoff = Date.now() - archiveAgeDays * 24 * 60 * 60 * 1000;
  const files = await findSessionFiles(SESSION_DIR);
  let count = 0;
  for (const file of files) {
    if (currentSession && file === currentSession) continue;
    try {
      const stat = await fs.stat(file);
      if (stat.mtimeMs <= cutoff && !(await fs.access(`${file}.zip`).then(() => true).catch(() => false))) count++;
    } catch {
      // Ignore files that disappear during scanning.
    }
  }
  return count;
}

async function archiveOldSessions(
  currentSession: string | undefined,
  archiveAgeDays: number,
  onProgress?: (completed: number, total: number) => void,
  shouldContinue: () => boolean = () => true,
): Promise<{ archived: number; cancelled: boolean }> {
  const cutoff = Date.now() - archiveAgeDays * 24 * 60 * 60 * 1000;
  const files = await findSessionFiles(SESSION_DIR);
  let archived = 0;
  onProgress?.(0, files.length);

  for (let index = 0; index < files.length; index++) {
    if (!shouldContinue()) return { archived, cancelled: true };
    const file = files[index];
    if (currentSession && file === currentSession) {
      onProgress?.(index + 1, files.length);
      continue;
    }

    try {
      const stat = await fs.stat(file);
      if (stat.mtimeMs > cutoff) {
        onProgress?.(index + 1, files.length);
        continue;
      }

      const archive = `${file}.zip`;
      try {
        await fs.access(archive);
        // Do not overwrite an existing archive or remove its source.
        onProgress?.(index + 1, files.length);
        continue;
      } catch {
        // The archive does not exist; continue.
      }

      await zipFile(file);
      await fs.unlink(file);
      archived++;
    } catch (error) {
      console.warn(`[session-manager] archive failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    onProgress?.(index + 1, files.length);
  }

  return { archived, cancelled: false };
}

export default function sessionManagerExtension(pi: ExtensionAPI) {
  let config: Config = { ...defaultConfig };

  async function selectMenu(
    ctx: ExtensionCommandContext,
    title: string,
    items: Array<{ value: string; label: string; description?: string }>,
  ): Promise<string | null> {
    if (ctx.mode !== "tui") {
      const selectedLabel = await ctx.ui.select(title, items.map((item) => item.label));
      return items.find((item) => item.label === selectedLabel)?.value ?? null;
    }
    return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
      const container = new Container();
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
      container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
      const selectList = new SelectList(items as SelectItem[], Math.min(items.length, 10), {
        selectedPrefix: (t) => theme.fg("accent", t),
        selectedText: (t) => theme.fg("accent", t),
        description: (t) => theme.fg("muted", t),
        scrollInfo: (t) => theme.fg("dim", t),
        noMatch: (t) => theme.fg("warning", t),
      });
      selectList.onSelect = (item) => done(String(item.value));
      selectList.onCancel = () => done(null);
      container.addChild(selectList);
      container.addChild(new Text(theme.fg("dim", "↑↓ navigate · enter select · esc cancel"), 1, 0));
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
      return {
        render: (width: number) => container.render(width),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => { selectList.handleInput(data); tui.requestRender(); },
      };
    });
  }
  let running = false;
  let lifecycleGeneration = 0;
  let activeSessionFile: string | undefined;

  const runArchive = async (
    ctx: ExtensionContext,
    report = false,
    onProgress?: (completed: number, total: number) => void,
    expectedGeneration?: number,
  ): Promise<boolean> => {
    if (!config.autoArchive || running) return false;
    running = true;
    try {
      const generation = expectedGeneration ?? lifecycleGeneration;
      const result = await archiveOldSessions(
        activeSessionFile ?? ctx.sessionManager.getSessionFile(),
        config.archiveAgeDays,
        onProgress,
        () => generation === lifecycleGeneration,
      );
      if (report && !result.cancelled) {
        ctx.ui.notify(result.archived ? `Zipped ${result.archived} old session${result.archived === 1 ? "" : "s"}.` : "No old sessions to zip.", "info");
      }
      if (result.cancelled) return false;
    } finally {
      running = false;
    }
    return true;
  };

  pi.on("session_start", (_event, ctx) => {
    lifecycleGeneration++;
    activeSessionFile = ctx.sessionManager.getSessionFile();
    const sessionGeneration = lifecycleGeneration;
    void (async () => {
      config = await readConfig();
      if (!config.autoArchive) return;
      const lastArchiveAt = config.lastArchiveAt ?? 0;
      if (Date.now() - lastArchiveAt < 24 * 60 * 60 * 1000) return;

      await new Promise((resolve) => setTimeout(resolve, STARTUP_ARCHIVE_DELAY_MS));
      config = await readConfig();
      if (!config.autoArchive || Date.now() - (config.lastArchiveAt ?? 0) < 24 * 60 * 60 * 1000) return;

      if (!await runArchive(ctx, false, undefined, sessionGeneration)) return;
      config.lastArchiveAt = Date.now();
      await writeConfig(config);
    })().catch((error) => {
      console.warn(`[session-manager] startup archive failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  });

  pi.on("session_shutdown", async () => {
    lifecycleGeneration++;
    activeSessionFile = undefined;
  });

  async function showSettings(ctx: ExtensionCommandContext): Promise<void> {
    while (true) {
      config = await readConfig();
      const choice = await selectMenu(ctx, "Session manager · Settings", [
        { value: "auto-zip", label: `Archive sessions automatically: ${config.autoArchive ? "ON" : "OFF"}` },
        { value: "zip-age", label: `Session age threshold: ${config.archiveAgeDays} day${config.archiveAgeDays === 1 ? "" : "s"}`, description: "Never archive sessions below this age (automatic or manual)" },
        { value: "Back", label: "Back" },
      ]);
      if (!choice || choice === "Back") return;

      if (choice === "auto-zip") {
        config.autoArchive = !config.autoArchive;
        await writeConfig(config);
        ctx.ui.notify(`Auto-zip turned ${config.autoArchive ? "on" : "off"}.`, "info");
      } else if (choice === "zip-age") {
        const value = await ctx.ui.input("Auto-zip threshold", "Enter 1–3650 days");
        if (value === undefined) continue;
        const days = Number.parseInt(value.trim(), 10);
        if (!Number.isInteger(days) || days < 1 || days > 3650) {
          ctx.ui.notify("Zip age must be a whole number from 1 to 3650.", "error");
          continue;
        }
        config.archiveAgeDays = days;
        await writeConfig(config);
        ctx.ui.notify(`Zip age set to ${days} day${days === 1 ? "" : "s"}.`, "info");
      }
    }
  }

  async function runWithProgress<T>(ctx: ExtensionCommandContext, title: string, operation: (update: (completed: number, total: number) => void) => Promise<T>): Promise<T> {
    if (ctx.mode !== "tui") return operation(() => undefined);
    let result!: T;
    let failure: unknown;
    await ctx.ui.custom<void>((tui, theme, _kb, done) => {
      const text = new Text(theme.fg("accent", `${title}\nStarting...`), 1, 0);
      const container = new Container();
      container.addChild(text);
      const update = (completed: number, total: number) => {
        const width = 30;
        const ratio = total > 0 ? completed / total : 1;
        const filled = Math.round(width * ratio);
        const bar = "█".repeat(filled) + "░".repeat(width - filled);
        text.setText(theme.fg("accent", `${title}\n[${bar}] ${completed}/${total}`));
        tui.requestRender();
      };
      void operation(update).then(
        (value) => { result = value; done(); },
        (error) => { failure = error; done(); },
      );
      return container;
    });
    if (failure) throw failure;
    return result;
  }

async function showImportMenu(ctx: ExtensionCommandContext): Promise<void> {
    const claudeCount = (await findSessionFiles(join(homedir(), ".claude", "projects"))).length;
    const codexCount = (await findSessionFiles(join(homedir(), ".codex", "sessions"))).length;
    const choice = await selectMenu(ctx, "Session manager · Import sessions", [
      { value: "claude", label: `Import Claude sessions (${claudeCount})` },
      { value: "codex", label: `Import Codex sessions (${codexCount})` },
      { value: "Back", label: "Back" },
    ]);
    if (!choice || choice === "Back") return;

    const source = choice === "claude" ? "claude" : "codex";
    const result = await runWithProgress(ctx, `Importing ${source} sessions`, (update) => importExternalSessions(source, update));
    ctx.ui.notify(`Imported ${result.imported} ${source} session${result.imported === 1 ? "" : "s"}.`, "info");
  }

  async function showMainMenu(ctx: ExtensionCommandContext): Promise<void> {
    while (true) {
      config = await readConfig();
      const sessionDir = ctx.sessionManager.getSessionDir();
      const archiveCount = sessionDir
        ? (await fs.readdir(sessionDir, { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl.zip")).length
        : 0;
      const oldSessionCount = await countOldSessions(ctx.sessionManager.getSessionFile(), config.archiveAgeDays);
      const choice = await selectMenu(ctx, "Session manager", [
        { value: "settings", label: "Settings..." },
        { value: "import", label: "Import sessions..." },
        { value: "unzip", label: `Restore sessions (${archiveCount})`, description: "Make archived sessions available for /resume in the current project" },
        { value: "zip", label: `Archive old sessions (${oldSessionCount})`, description: "Compress old Pi sessions" },
      ]);
      if (!choice) return;

      if (choice === "settings") {
        await showSettings(ctx);
      } else if (choice === "import") {
        await showImportMenu(ctx);
      } else if (choice === "unzip") {
        if (!sessionDir) {
          ctx.ui.notify("No persistent session directory is active.", "warning");
        } else {
          const unpacked = await runWithProgress(ctx, "Unzipping sessions", (update) => unpackSessions(sessionDir, update));
          ctx.ui.notify(unpacked ? `Unzipped ${unpacked} session${unpacked === 1 ? "" : "s"}.` : "No sessions needed unpacking.", "info");
        }
      } else if (choice === "zip") {
        if (running) {
          ctx.ui.notify("Archiving is already in progress.", "warning");
          continue;
        }
        const previous = config.autoArchive;
        config.autoArchive = true;
        await runWithProgress(ctx, "Zipping old sessions", (update) => runArchive(ctx, true, update));
        config.autoArchive = previous;
      }
    }
  }

  pi.registerCommand("session-manager", {
    description: "Configure automatic archiving of old Pi sessions",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      config = await readConfig();
      if (!ctx.hasUI) {
        ctx.ui.notify(`Auto-zip is ${config.autoArchive ? "on" : "off"}; zip age is ${config.archiveAgeDays} days.`, "info");
        return;
      }
      await showMainMenu(ctx);
    },
  });
}
