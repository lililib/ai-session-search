import { describe, expect, test } from "vitest";
import { buildTerminalLaunch } from "./terminalLauncher.ts";

const command = "cd '/workspace/My Project' && yolo session-1";

describe("buildTerminalLaunch", () => {
  test("runs Terminal and iTerm commands through interactive login zsh", () => {
    const terminal = buildTerminalLaunch(
      { terminal: "terminal", customPath: null, shellPath: "/bin/zsh" },
      command,
      "/workspace/My Project",
      "/tmp/app-data",
      "darwin",
    );
    const iterm = buildTerminalLaunch(
      { terminal: "iterm2", customPath: null, shellPath: "/bin/zsh" },
      command,
      "/workspace/My Project",
      "/tmp/app-data",
      "darwin",
    );

    expect(terminal.file).toBe("/usr/bin/osascript");
    expect(terminal.args.at(-1)).toMatch(/^\/bin\/zsh -lic /);
    expect(terminal.args.at(-1)).toContain("yolo session-1");
    expect(iterm.file).toBe("/usr/bin/osascript");
    expect(iterm.args.at(-1)).toMatch(/^\/bin\/zsh -lic /);
    expect(iterm.args.at(-1)).toContain("yolo session-1");
  });

  test("opens iTerm commands in a new tab of the current window", () => {
    const launch = buildTerminalLaunch(
      { terminal: "iterm2", customPath: null, shellPath: "/bin/zsh" },
      "yolo session-1",
      "/workspace",
      "/tmp/app-data",
      "darwin",
    );
    const appleScript = launch.args[1] ?? "";

    expect(appleScript).toContain("if (count of windows) is 0 then");
    expect(appleScript).toContain("tell current window");
    expect(appleScript).toContain("create tab with default profile command");
  });

  test("builds a Warp launch configuration with safely encoded values", () => {
    const launch = buildTerminalLaunch(
      { terminal: "warp", customPath: null, shellPath: "/bin/zsh" },
      'yolo "session-1"',
      "/workspace/My Project",
      "/tmp/app data",
      "darwin",
    );

    expect(launch.file).toBe("/usr/bin/open");
    expect(launch.args[0]?.replace(/%5C/gi, "/")).toMatch(/^warp:\/\/launch\//);
    expect(launch.artifact?.content).toContain('cwd: "/workspace/My Project"');
    expect(launch.artifact?.content).toContain("/bin/zsh -lic");
    expect(launch.artifact?.content).toContain("yolo");
  });

  test("opens a command file with a custom macOS application path", () => {
    const launch = buildTerminalLaunch(
      { terminal: "custom", customPath: "/Applications/Ghostty.app", shellPath: "/bin/zsh" },
      command,
      "/workspace/My Project",
      "/tmp/app-data",
      "darwin",
    );

    expect(launch.file).toBe("/usr/bin/open");
    expect(launch.args.slice(0, 2)).toEqual(["-a", "/Applications/Ghostty.app"]);
    expect(launch.artifact).toMatchObject({ mode: 0o700 });
    expect(launch.artifact?.content).toContain("/bin/zsh -lic");
  });

  test("uses interactive login zsh for a custom terminal executable", () => {
    const launch = buildTerminalLaunch(
      { terminal: "custom", customPath: "/usr/local/bin/ghostty", shellPath: "/bin/zsh" },
      "yolo session-1",
      "/workspace",
      "/tmp/app-data",
      "darwin",
    );

    expect(launch.args).toEqual(["-e", "/bin/zsh", "-lic", "yolo session-1"]);
  });

  test("rejects a relative custom terminal path", () => {
    expect(() =>
      buildTerminalLaunch(
        { terminal: "custom", customPath: "Ghostty.app", shellPath: "/bin/zsh" },
        command,
        "/workspace",
        "/tmp/app-data",
        "darwin",
      ),
    ).toThrow("absolute");
  });

  test("uses the configured shell path for every terminal launcher", () => {
    const iterm = buildTerminalLaunch(
      { terminal: "iterm2", customPath: null, shellPath: "/bin/bash" },
      "resume-session",
      "/workspace",
      "/tmp/app-data",
      "darwin",
    );
    const custom = buildTerminalLaunch(
      { terminal: "custom", customPath: "/usr/local/bin/ghostty", shellPath: "/bin/bash" },
      "resume-session",
      "/workspace",
      "/tmp/app-data",
      "darwin",
    );

    expect(iterm.args.at(-1)).toMatch(/^\/bin\/bash -lic /);
    expect(custom.args).toEqual(["-e", "/bin/bash", "-lic", "resume-session"]);
  });

  test("escapes PowerShell statement separators passed through Windows Terminal", () => {
    const launch = buildTerminalLaunch(
      { terminal: "windows-terminal", customPath: null, shellPath: "powershell.exe" },
      "Set-Location -LiteralPath 'C:\\Workspace\\Demo'; yolo session-1; Write-Host done",
      "C:\\Workspace\\Demo",
      "C:\\Users\\Alice\\AppData\\Roaming\\AI Session Search",
      "win32",
    );

    expect(launch.file).toBe("wt.exe");
    expect(launch.args).toEqual([
      "-w",
      "0",
      "new-tab",
      "-d",
      "C:\\Workspace\\Demo",
      "powershell.exe",
      "-NoExit",
      "-Command",
      "Set-Location -LiteralPath 'C:\\Workspace\\Demo'\\; yolo session-1\\; Write-Host done",
    ]);
  });

  test("can open standalone PowerShell and Command Prompt windows", () => {
    const powershell = buildTerminalLaunch(
      { terminal: "powershell", customPath: null, shellPath: "pwsh.exe" },
      "Set-Location C:\\Workspace; yolo session-1",
      "C:\\Workspace",
      "C:\\AppData",
      "win32",
    );
    const commandPrompt = buildTerminalLaunch(
      { terminal: "cmd", customPath: null, shellPath: "cmd.exe" },
      "yolo session-1",
      "C:\\Workspace",
      "C:\\AppData",
      "win32",
    );

    expect(powershell).toMatchObject({
      file: "pwsh.exe",
      args: ["-NoExit", "-Command", "Set-Location C:\\Workspace; yolo session-1"],
      cwd: "C:\\Workspace",
      detached: true,
    });
    expect(commandPrompt).toMatchObject({
      file: "cmd.exe",
      args: ["/K", "yolo session-1"],
      cwd: "C:\\Workspace",
      detached: true,
    });
  });
});
