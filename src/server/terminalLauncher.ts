import { execFile, spawn } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type { TerminalSettings } from "../shared/types.ts";
import { isValidShellReference, normalizeRuntimePlatform } from "../shared/terminal.ts";

const execFileAsync = promisify(execFile);

const TERMINAL_APPLESCRIPT = `
on run argv
  tell application "Terminal"
    activate
    do script (item 1 of argv)
  end tell
end run
`;

const ITERM_APPLESCRIPT = `
on run argv
  tell application "iTerm"
    activate
    if (count of windows) is 0 then
      create window with default profile command (item 1 of argv)
    else
      tell current window
        create tab with default profile command (item 1 of argv)
      end tell
    end if
  end tell
end run
`;

export type TerminalLaunchArtifact = {
  path: string;
  content: string;
  mode: number;
};

export type TerminalLaunch = {
  file: string;
  args: string[];
  artifact?: TerminalLaunchArtifact;
  cwd?: string;
  detached?: boolean;
};

const shellQuote = (value: string): string => {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
};

const interactiveShellCommand = (shellPath: string, command: string): string =>
  `${shellQuote(shellPath)} -lic ${shellQuote(command)}`;

const warpLaunch = (
  shellPath: string,
  command: string,
  cwd: string | null,
  dataDir: string,
): TerminalLaunch => {
  const artifactPath = join(dataDir, "terminal-launches", "ai-session-search.yaml");
  const workingDirectory = cwd ?? homedir();
  const shellCommand = interactiveShellCommand(shellPath, command);
  const content = [
    "---",
    "name: AI Session Search",
    "windows:",
    "  - tabs:",
    "      - title: AI Session Search",
    "        layout:",
    `          cwd: ${JSON.stringify(workingDirectory)}`,
    "          commands:",
    `            - exec: ${JSON.stringify(shellCommand)}`,
    "",
  ].join("\n");
  return {
    file: "/usr/bin/open",
    args: [`warp://launch${encodeURI(artifactPath)}`],
    artifact: { path: artifactPath, content, mode: 0o600 },
  };
};

const customLaunch = (
  customPath: string | null,
  shellPath: string,
  command: string,
  dataDir: string,
  runtimePlatform: NodeJS.Platform,
  cwd: string | null,
): TerminalLaunch => {
  const platform = normalizeRuntimePlatform(runtimePlatform);
  const absoluteCustomPath = platform === "win32"
    ? /^[A-Za-z]:[\\/]/.test(customPath ?? "") || /^\\\\/.test(customPath ?? "")
    : customPath !== null && isAbsolute(customPath);
  if (customPath === null || !absoluteCustomPath) {
    throw new Error("Custom terminal path must be absolute");
  }
  if (platform === "win32") {
    const shellArgs = windowsShellArgs(shellPath, command);
    return {
      file: customPath,
      args: ["-e", shellPath, ...shellArgs],
      ...(cwd === null ? {} : { cwd }),
      detached: true,
    };
  }
  if (!customPath.toLocaleLowerCase().endsWith(".app")) {
    return { file: customPath, args: ["-e", shellPath, "-lic", command] };
  }
  const artifactPath = join(dataDir, "terminal-launches", "resume.command");
  const shellCommand = interactiveShellCommand(shellPath, command);
  return {
    file: "/usr/bin/open",
    args: ["-a", customPath, artifactPath],
    artifact: {
      path: artifactPath,
      content: `#!/bin/zsh\nexec ${shellCommand}\n`,
      mode: 0o700,
    },
  };
};

const windowsShellArgs = (shellPath: string, command: string): string[] =>
  /(^|[\\/])cmd(?:\.exe)?$/i.test(shellPath)
    ? ["/K", command]
    : ["-NoExit", "-Command", command];

const windowsLaunch = (
  settings: TerminalSettings,
  command: string,
  cwd: string | null,
  dataDir: string,
): TerminalLaunch => {
  if (settings.terminal === "windows-terminal") {
    // wt.exe treats semicolons as subcommand separators even inside a single argument.
    const wtCommand = command.replaceAll(";", "\\;");
    return {
      file: "wt.exe",
      args: [
        "-w",
        "0",
        "new-tab",
        ...(cwd === null ? [] : ["-d", cwd]),
        settings.shellPath,
        ...windowsShellArgs(settings.shellPath, wtCommand),
      ],
      detached: true,
    };
  }
  const shellArgs = windowsShellArgs(settings.shellPath, command);
  if (settings.terminal === "powershell" || settings.terminal === "cmd") {
    return {
      file: settings.shellPath,
      args: shellArgs,
      ...(cwd === null ? {} : { cwd }),
      detached: true,
    };
  }
  if (settings.terminal === "custom") {
    return customLaunch(settings.customPath, settings.shellPath, command, dataDir, "win32", cwd);
  }
  throw new Error(`${settings.terminal} terminal launching is not supported on Windows`);
};

export const buildTerminalLaunch = (
  settings: TerminalSettings,
  command: string,
  cwd: string | null,
  dataDir: string,
  runtimePlatform: NodeJS.Platform = process.platform,
): TerminalLaunch => {
  const platform = normalizeRuntimePlatform(runtimePlatform);
  if (!isValidShellReference(settings.shellPath, platform)) {
    throw new Error(platform === "win32" ? "Invalid shell executable" : "Shell path must be absolute");
  }
  if (platform === "win32") return windowsLaunch(settings, command, cwd, dataDir);
  if (settings.terminal === "custom") {
    return customLaunch(settings.customPath, settings.shellPath, command, dataDir, runtimePlatform, cwd);
  }
  if (runtimePlatform !== "darwin") {
    throw new Error(`${settings.terminal} terminal launching is only supported on macOS`);
  }
  const shellCommand = interactiveShellCommand(settings.shellPath, command);
  if (settings.terminal === "terminal") {
    return { file: "/usr/bin/osascript", args: ["-e", TERMINAL_APPLESCRIPT, shellCommand] };
  }
  if (settings.terminal === "iterm2") {
    return { file: "/usr/bin/osascript", args: ["-e", ITERM_APPLESCRIPT, shellCommand] };
  }
  return warpLaunch(settings.shellPath, command, cwd, dataDir);
};

export class TerminalLauncher {
  readonly #dataDir: string;

  constructor(dataDir: string) {
    this.#dataDir = dataDir;
  }

  async launch(settings: TerminalSettings, command: string, cwd: string | null): Promise<void> {
    const launch = buildTerminalLaunch(settings, command, cwd, this.#dataDir);
    if (isAbsolute(settings.shellPath)) await stat(settings.shellPath);
    if (settings.terminal === "custom" && settings.customPath !== null) {
      await stat(settings.customPath);
    }
    if (launch.artifact !== undefined) {
      await mkdir(join(this.#dataDir, "terminal-launches"), { recursive: true });
      await writeFile(launch.artifact.path, launch.artifact.content, { mode: launch.artifact.mode });
    }
    if (launch.detached === true) {
      try {
        await spawnDetached(launch);
      } catch (error) {
        if (settings.terminal !== "windows-terminal" || !isMissingExecutable(error)) throw error;
        await spawnDetached({
          file: settings.shellPath,
          args: windowsShellArgs(settings.shellPath, command),
          ...(cwd === null ? {} : { cwd }),
          detached: true,
        });
      }
      return;
    }
    await execFileAsync(launch.file, launch.args, { timeout: 15_000 });
  }
}

const isMissingExecutable = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";

const spawnDetached = (launch: TerminalLaunch): Promise<void> =>
  new Promise((resolveSpawn, reject) => {
    const child = spawn(launch.file, launch.args, {
      ...(launch.cwd === undefined ? {} : { cwd: launch.cwd }),
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolveSpawn();
    });
  });
