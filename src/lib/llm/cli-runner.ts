import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, extname, join } from "node:path";

export interface CliRunOptions {
  command: string;
  args: string[];
  stdin: string;
  timeoutMs: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface CliRunResult {
  stdout: string;
  stderr: string;
}

export function resolveCliCommand(
  command: string,
  platform = process.platform,
): string {
  if (command.includes("/") || command.includes("\\") || extname(command)) {
    return command;
  }

  if (platform !== "win32") return command;

  const pathValue = process.env.PATH ?? "";
  for (const dir of pathValue.split(delimiter).filter(Boolean)) {
    for (const suffix of [".cmd", ".exe", ""]) {
      const candidate = join(dir, `${command}${suffix}`);
      if (existsSync(candidate)) return candidate;
    }
  }

  return command;
}

export function runCli(options: CliRunOptions): Promise<CliRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveCliCommand(options.command), options.args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const rejectOnce = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    };

    const resolveOnce = (result: CliRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      // On Windows, descendants can retain the stdio handles after the
      // spawned CLI exits, so Node may never emit "close". The timeout is the
      // operation boundary; reject immediately instead of waiting forever.
      rejectOnce(new Error(`CLI process timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdin?.on("error", () => {
      // The CLI may exit before consuming stdin; close/error handling below
      // determines the command result.
    });

    child.on("error", (err) => {
      rejectOnce(err);
    });

    child.on("close", (code) => {
      if (timedOut) return;

      if (code !== 0) {
        const detail = stderr.trim() || stdout.trim() || `exit code ${code}`;
        rejectOnce(new Error(detail));
        return;
      }

      resolveOnce({ stdout, stderr });
    });

    if (options.stdin) child.stdin?.write(options.stdin);
    child.stdin?.end();
  });
}
