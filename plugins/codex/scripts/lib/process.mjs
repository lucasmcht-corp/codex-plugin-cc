import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  isOwnedWorker,
  ownedWindowsJobName
} from "./job-lifecycle.mjs";
import {
  DEFAULT_APP_SERVER_CLOSE_CONFIG,
  DEFAULT_PROCESS_COMMAND_TIMEOUT_MS,
  DEFAULT_PROCESS_POLL_INTERVAL_MS,
  DEFAULT_WORKER_CONFIG
} from "./runtime-config.mjs";

/**
 * @typedef {object} CommandResult
 * @property {string} command
 * @property {string[]} args
 * @property {number | null} status
 * @property {NodeJS.Signals | null} signal
 * @property {string} stdout
 * @property {string} stderr
 * @property {Error | null} error
 *
 * @typedef {object} CommandOptions
 * @property {string} [cwd]
 * @property {NodeJS.ProcessEnv} [env]
 * @property {string | Buffer | Uint8Array} [input]
 * @property {number} [maxBuffer]
 * @property {import("node:child_process").StdioOptions} [stdio]
 * @property {boolean | string} [shell]
 * @property {number} [timeout]
 *
 * @typedef {(command: string, args?: string[], options?: CommandOptions) => CommandResult} RunCommand
 * @typedef {import("./reliability-contracts").OwnedWorker} OwnedWorkerIdentity
 * @typedef {import("./reliability-contracts").PosixOwnedWorker} PosixWorkerIdentity
 * @typedef {import("./reliability-contracts").WindowsOwnedWorker} WindowsWorkerIdentity
 *
 * @typedef {object} ProcessIdentity
 * @property {number} pid
 * @property {number} parentPid
 * @property {number | null} processGroupId
 * @property {string} startKey
 * @property {string[] | null} argv
 * @property {string | null} command
 *
 * @typedef {object} ProcessInspectionOptions
 * @property {NodeJS.Platform} [platform]
 * @property {string} [cwd]
 * @property {NodeJS.ProcessEnv} [env]
 * @property {RunCommand} [runCommandImpl]
 * @property {(pid: number, options: { platform: NodeJS.Platform }) => ProcessIdentity | null} [inspectProcessImpl]
 * @property {number} [deadlineAt]
 * @property {number} [timeoutMs]
 *
 * @typedef {object} ProcessControlOptions
 * @property {NodeJS.Platform} [platform]
 * @property {string} [cwd]
 * @property {NodeJS.ProcessEnv} [env]
 * @property {RunCommand} [runCommandImpl]
 * @property {(pid: number, options: { platform: NodeJS.Platform }) => ProcessIdentity | null} [inspectProcessImpl]
 * @property {(pid: number, signal?: NodeJS.Signals | number) => boolean | void} [killImpl]
 * @property {number} [graceMs]
 * @property {number} [killMs]
 * @property {number} [timeoutMs]
 * @property {number} [intervalMs]
 * @property {number} [deadlineAt]
 *
 * @typedef {object} OwnedLaunchOptions
 * @property {NodeJS.Platform} [platform]
 * @property {string} [cwd]
 * @property {NodeJS.ProcessEnv} [env]
 * @property {import("node:child_process").StdioOptions} [stdio]
 * @property {string} [token]
 * @property {boolean} [terminateWithOwner]
 * @property {ProcessIdentity} [ownerIdentity]
 *
 * @typedef {object} WorkerTerminationConfig
 * @property {number} signalAnchorMs
 * @property {number} [stopKillMs]
 *
 * @typedef {ProcessControlOptions & {
 *   setTimeoutImpl?: typeof setTimeout,
 *   clearTimeoutImpl?: typeof clearTimeout,
 *   exitImpl?: (code?: number) => never | void
 * }} WorkerTerminationOptions
 *
 * @typedef {ProcessInspectionOptions & {
 *   supervisorPid?: number,
 *   jobName?: string
 * }} WorkerCaptureOptions
 *
 * @typedef {object} PosixGroupIdentity
 * @property {number} pid
 * @property {number} processGroupId
 * @property {string} [startKey]
 *
 * @typedef {object} LaunchDescriptor
 * @property {string} command
 * @property {string[]} args
 */

/**
 * @param {string} command
 * @param {string[]} [args]
 * @param {CommandOptions} [options]
 * @returns {CommandResult}
 */
export function runCommand(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer,
    stdio: options.stdio ?? "pipe",
    shell: options.shell ?? (process.platform === "win32" ? (process.env.SHELL || true) : false),
    timeout: options.timeout,
    windowsHide: true
  });

  return {
    command,
    args,
    status: result.status,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

/**
 * @param {string} command
 * @param {string[]} [args]
 * @param {CommandOptions} [options]
 */
export function runCommandChecked(command, args = [], options = {}) {
  const result = runCommand(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0 || result.signal) {
    throw new Error(formatCommandFailure(result));
  }
  return result;
}

/**
 * @param {string} command
 * @param {string[]} [versionArgs]
 * @param {CommandOptions} [options]
 */
export function binaryAvailable(command, versionArgs = ["--version"], options = {}) {
  const result = runCommand(command, versionArgs, options);
  if (
    result.error &&
    "code" in result.error &&
    result.error.code === "ENOENT"
  ) {
    return { available: false, detail: "not found" };
  }
  if (result.error) {
    return { available: false, detail: result.error.message };
  }
  if (result.status !== 0 || result.signal) {
    const detail =
      result.stderr.trim() ||
      result.stdout.trim() ||
      (result.signal ? `signal ${result.signal}` : `exit ${result.status}`);
    return { available: false, detail };
  }
  return { available: true, detail: result.stdout.trim() || result.stderr.trim() || "ok" };
}

/** @param {unknown} pid @returns {asserts pid is number} */
function assertPositiveIntegerPid(pid) {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    throw new RangeError("Process pid must be a positive integer.");
  }
}

/** @param {unknown} token @returns {asserts token is string} */
function assertWorkerToken(token) {
  if (typeof token !== "string" || !/^[a-zA-Z0-9._:-]+$/.test(token)) {
    throw new Error("Worker token must be a non-empty opaque token.");
  }
}

/** @param {unknown} error */
function isMissingProcessError(error) {
  return error instanceof Error && "code" in error && error.code === "ESRCH";
}

/** @param {unknown} error */
function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/** @param {Pick<ProcessInspectionOptions, "deadlineAt" | "timeoutMs">} options */
function remainingCommandTimeout(options) {
  if (options.deadlineAt === undefined) {
    return options.timeoutMs ?? DEFAULT_PROCESS_COMMAND_TIMEOUT_MS;
  }
  if (!Number.isFinite(options.deadlineAt)) {
    throw new Error("Process operation deadline must be finite.");
  }
  const remainingMs = Math.ceil(options.deadlineAt - Date.now());
  if (remainingMs <= 0) {
    throw new Error("Process operation deadline expired.");
  }
  return remainingMs;
}

/** @param {string} text @returns {unknown} */
function parseUnknownJson(text) {
  return JSON.parse(text);
}

/**
 * @param {unknown} output
 * @param {number} pid
 * @param {NodeJS.Platform} platform
 * @returns {ProcessIdentity | null}
 */
function parsePosixProcess(output, pid, platform) {
  const line = String(output ?? "").trim();
  if (!line) {
    return null;
  }
  const match = line.match(
    /^(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+([\s\S]+)$/
  );
  if (!match) {
    throw new Error(`Cannot parse process identity for pid ${pid}.`);
  }

  let argv = null;
  if (platform === "linux") {
    try {
      argv = fs
        .readFileSync(`/proc/${pid}/cmdline`)
        .toString("utf8")
        .split("\0")
        .filter(Boolean);
    } catch {
      argv = null;
    }
  }

  return {
    pid: Number(match[1]),
    parentPid: Number(match[2]),
    processGroupId: Number(match[3]),
    startKey: match[4],
    argv,
    command: match[5]
  };
}

/** @param {number} pid @returns {ProcessIdentity | null} */
function inspectLinuxProcess(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd === -1) {
      throw new Error(`Cannot parse Linux process identity for pid ${pid}.`);
    }
    const fields = stat.slice(commandEnd + 2).trim().split(/\s+/);
    const argv = fs
      .readFileSync(`/proc/${pid}/cmdline`)
      .toString("utf8")
      .split("\0")
      .filter(Boolean);
    return {
      pid,
      parentPid: Number(fields[1]),
      processGroupId: Number(fields[2]),
      startKey: `linux:${fields[19]}`,
      argv,
      command: argv.join(" ")
    };
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ESRCH")
    ) {
      return null;
    }
    throw error;
  }
}

/**
 * @param {number} pid
 * @param {ProcessInspectionOptions} [options]
 * @returns {ProcessIdentity | null}
 */
function inspectPosixProcess(pid, options = {}) {
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const timeout = remainingCommandTimeout(options);
  const result = runCommandImpl(
    "ps",
    ["-ww", "-p", String(pid), "-o", "pid=,ppid=,pgid=,lstart=,args="],
    {
      cwd: options.cwd,
      env: options.env,
      timeout
    }
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    if (!String(result.stdout ?? "").trim()) {
      return null;
    }
    throw new Error(formatCommandFailure(result));
  }
  return parsePosixProcess(result.stdout, pid, options.platform ?? process.platform);
}

/**
 * @param {number} pid
 * @param {ProcessInspectionOptions} [options]
 * @returns {ProcessIdentity | null}
 */
function inspectWindowsProcess(pid, options = {}) {
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const timeout = remainingCommandTimeout(options);
  const hashEntries = [
    "pid = [int]$p.ProcessId",
    "parentPid = [int]$p.ParentProcessId",
    "startKey = [string]$p.CreationDate.ToUniversalTime().Ticks",
    "command = [string]$p.CommandLine"
  ].join("; ");
  const script = [
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"`,
    "if ($null -eq $p) { exit 3 }",
    `$value = @{ ${hashEntries} }`,
    "[Console]::Out.Write(($value | ConvertTo-Json -Compress))"
  ].join("; ");
  const result = runCommandImpl(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      timeout
    }
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status === 3) {
    return null;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  const parsed = JSON.parse(result.stdout);
  return {
    pid: parsed.pid,
    parentPid: parsed.parentPid,
    processGroupId: null,
    startKey: parsed.startKey,
    argv: null,
    command: parsed.command
  };
}

/**
 * @param {number} pid
 * @param {ProcessInspectionOptions} [options]
 * @returns {ProcessIdentity | null}
 */
function inspectProcess(pid, options = {}) {
  const platform = options.platform ?? process.platform;
  const inspectProcessImpl = options.inspectProcessImpl;
  if (inspectProcessImpl) {
    return inspectProcessImpl(pid, { platform });
  }
  if (platform === "linux" && !options.runCommandImpl) {
    return inspectLinuxProcess(pid);
  }
  if (platform !== "win32" && platform !== "linux") {
    throw new Error(
      `Exact process-generation inspection is unsupported on platform ${platform}.`
    );
  }
  return platform === "win32"
    ? inspectWindowsProcess(pid, { ...options, platform })
    : inspectPosixProcess(pid, { ...options, platform });
}

/**
 * @param {number} pid
 * @param {ProcessInspectionOptions} [options]
 */
export function inspectProcessIdentity(pid, options = {}) {
  assertPositiveIntegerPid(pid);
  return inspectProcess(pid, options);
}

const POSIX_SUPERVISOR_FLAG = "--owned-posix-supervisor";
const WINDOWS_JOB_PREFIX = "Local\\CodexPlugin-";

const WINDOWS_TARGET_RUNNER = [
  "$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:CODEX_OWNED_TARGET)) | ConvertFrom-Json",
  "Remove-Item Env:CODEX_OWNED_TARGET -ErrorAction SilentlyContinue",
  "$targetCommand = [string]$payload.command",
  "$targetArgs = @($payload.args)",
  "& $targetCommand @targetArgs",
  "if ($null -eq $LASTEXITCODE) { exit 0 }",
  "exit $LASTEXITCODE"
].join("; ");

const WINDOWS_JOB_NATIVE_SOURCE = String.raw`
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class CodexOwnedJob {
  const uint CREATE_SUSPENDED = 0x00000004;
  const uint STARTF_USESTDHANDLES = 0x00000100;
  const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
  const uint SYNCHRONIZE = 0x00100000;
  const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x00001000;
  const uint INFINITE = 0xffffffff;
  const uint WAIT_OBJECT_0 = 0x00000000;
  const uint WAIT_FAILED = 0xffffffff;

  [StructLayout(LayoutKind.Sequential)]
  struct SECURITY_ATTRIBUTES {
    public uint nLength;
    public IntPtr lpSecurityDescriptor;
    [MarshalAs(UnmanagedType.Bool)] public bool bInheritHandle;
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFO {
    public uint cb;
    public string lpReserved;
    public string lpDesktop;
    public string lpTitle;
    public uint dwX;
    public uint dwY;
    public uint dwXSize;
    public uint dwYSize;
    public uint dwXCountChars;
    public uint dwYCountChars;
    public uint dwFillAttribute;
    public uint dwFlags;
    public short wShowWindow;
    public short cbReserved2;
    public IntPtr lpReserved2;
    public IntPtr hStdInput;
    public IntPtr hStdOutput;
    public IntPtr hStdError;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_INFORMATION {
    public IntPtr hProcess;
    public IntPtr hThread;
    public uint dwProcessId;
    public uint dwThreadId;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit;
    public long PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize;
    public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass;
    public uint SchedulingClass;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct IO_COUNTERS {
    public ulong ReadOperationCount;
    public ulong WriteOperationCount;
    public ulong OtherOperationCount;
    public ulong ReadTransferCount;
    public ulong WriteTransferCount;
    public ulong OtherTransferCount;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
    public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit;
    public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed;
    public UIntPtr PeakJobMemoryUsed;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CreateJobObject(IntPtr attributes, string name);

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr OpenJobObject(uint access, bool inheritHandle, string name);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CreateProcess(
    string applicationName,
    StringBuilder commandLine,
    IntPtr processAttributes,
    IntPtr threadAttributes,
    bool inheritHandles,
    uint creationFlags,
    IntPtr environment,
    string currentDirectory,
    ref STARTUPINFO startupInfo,
    out PROCESS_INFORMATION processInformation);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern uint ResumeThread(IntPtr thread);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern uint WaitForMultipleObjects(
    uint count,
    IntPtr[] handles,
    bool waitAll,
    uint milliseconds);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processId);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetProcessTimes(
    IntPtr process,
    out long creationTime,
    out long exitTime,
    out long kernelTime,
    out long userTime);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool TerminateJobObject(IntPtr job, uint exitCode);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool TerminateProcess(IntPtr process, uint exitCode);

  [DllImport("kernel32.dll")]
  static extern IntPtr GetStdHandle(int standardHandle);

  [DllImport("kernel32.dll")]
  static extern bool CloseHandle(IntPtr handle);

  static void ThrowLastError(string operation) {
    throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
  }

  static void CloseAndThrowLastError(IntPtr handle, string operation) {
    int error = Marshal.GetLastWin32Error();
    if (handle != IntPtr.Zero) CloseHandle(handle);
    throw new Win32Exception(error, operation);
  }

  public static int LaunchAndWait(
    string name,
    string application,
    string commandLine,
    string cwd,
    uint ownerPid,
    long ownerStartTicks) {
    IntPtr owner = IntPtr.Zero;
    if (ownerPid != 0) {
      owner = OpenProcess(
        SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
        false,
        ownerPid);
      if (owner == IntPtr.Zero) ThrowLastError("OpenProcess(owner)");
      long creationTime;
      long exitTime;
      long kernelTime;
      long userTime;
      if (!GetProcessTimes(owner, out creationTime, out exitTime, out kernelTime, out userTime)) {
        CloseAndThrowLastError(owner, "GetProcessTimes(owner)");
      }
      if (DateTime.FromFileTimeUtc(creationTime).Ticks != ownerStartTicks) {
        CloseHandle(owner);
        throw new InvalidOperationException("Owned process owner generation changed.");
      }
      if (WaitForSingleObject(owner, 0) == WAIT_OBJECT_0) {
        CloseHandle(owner);
        throw new InvalidOperationException("Owned process owner already exited.");
      }
    }
    IntPtr job = CreateJobObject(IntPtr.Zero, name);
    if (job == IntPtr.Zero) {
      CloseAndThrowLastError(owner, "CreateJobObject");
    }
    if (Marshal.GetLastWin32Error() == 183) {
      if (owner != IntPtr.Zero) CloseHandle(owner);
      CloseHandle(job);
      throw new InvalidOperationException("Owned Job Object name already exists.");
    }
    IntPtr limitsPointer = IntPtr.Zero;
    PROCESS_INFORMATION process = new PROCESS_INFORMATION();
    bool assigned = false;
    try {
      var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
      limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
      int limitsSize = Marshal.SizeOf(limits);
      limitsPointer = Marshal.AllocHGlobal(limitsSize);
      Marshal.StructureToPtr(limits, limitsPointer, false);
      if (!SetInformationJobObject(job, 9, limitsPointer, (uint)limitsSize)) {
        ThrowLastError("SetInformationJobObject");
      }

      var startup = new STARTUPINFO();
      startup.cb = (uint)Marshal.SizeOf(startup);
      startup.dwFlags = STARTF_USESTDHANDLES;
      startup.hStdInput = GetStdHandle(-10);
      startup.hStdOutput = GetStdHandle(-11);
      startup.hStdError = GetStdHandle(-12);
      if (!CreateProcess(
        application,
        new StringBuilder(commandLine),
        IntPtr.Zero,
        IntPtr.Zero,
        true,
        CREATE_SUSPENDED,
        IntPtr.Zero,
        cwd,
        ref startup,
        out process)) {
        ThrowLastError("CreateProcess");
      }
      if (!AssignProcessToJobObject(job, process.hProcess)) {
        ThrowLastError("AssignProcessToJobObject");
      }
      assigned = true;
      if (ResumeThread(process.hThread) == 0xffffffff) {
        ThrowLastError("ResumeThread");
      }
      CloseHandle(process.hThread);
      process.hThread = IntPtr.Zero;
      if (owner == IntPtr.Zero) {
        WaitForSingleObject(process.hProcess, INFINITE);
      } else {
        uint waitResult = WaitForMultipleObjects(
          2,
          new IntPtr[] { process.hProcess, owner },
          false,
          INFINITE);
        if (waitResult == WAIT_FAILED) ThrowLastError("WaitForMultipleObjects");
        if (waitResult == WAIT_OBJECT_0 + 1) {
          if (!TerminateJobObject(job, 143)) ThrowLastError("TerminateJobObject(owner)");
          WaitForSingleObject(process.hProcess, INFINITE);
          return 143;
        }
        if (waitResult != WAIT_OBJECT_0) {
          throw new InvalidOperationException("Unexpected owned process wait result.");
        }
      }
      uint exitCode;
      if (!GetExitCodeProcess(process.hProcess, out exitCode)) {
        ThrowLastError("GetExitCodeProcess");
      }
      return unchecked((int)exitCode);
    } finally {
      if (limitsPointer != IntPtr.Zero) Marshal.FreeHGlobal(limitsPointer);
      if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
      if (process.hProcess != IntPtr.Zero && !assigned) TerminateProcess(process.hProcess, 143);
      if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
      if (owner != IntPtr.Zero) CloseHandle(owner);
      CloseHandle(job);
    }
  }

  public static bool Terminate(string name, uint exitCode) {
    const uint JOB_OBJECT_TERMINATE = 0x0008;
    IntPtr job = OpenJobObject(JOB_OBJECT_TERMINATE, false, name);
    if (job == IntPtr.Zero) return false;
    try {
      if (!TerminateJobObject(job, exitCode)) ThrowLastError("TerminateJobObject");
      return true;
    } finally {
      CloseHandle(job);
    }
  }
}`;

/** @param {string} source */
function encodePowerShell(source) {
  return Buffer.from(source, "utf16le").toString("base64");
}

/** @param {unknown} value */
function powerShellLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

/** @param {string} command @param {string[]} args */
function encodeLaunchDescriptor(command, args) {
  return Buffer.from(JSON.stringify({ command, args }), "utf8").toString("base64");
}

/** @param {string} jobName @param {number} ownerPid @param {string} ownerStartKey */
function buildWindowsJobSupervisorScript(jobName, ownerPid, ownerStartKey) {
  const runner = encodePowerShell(WINDOWS_TARGET_RUNNER);
  return [
    `$jobName = ${powerShellLiteral(jobName)}`,
    `$nativeSource = ${powerShellLiteral(WINDOWS_JOB_NATIVE_SOURCE)}`,
    "Add-Type -TypeDefinition $nativeSource -Language CSharp",
    "$env:CODEX_OWNED_JOB_NAME = $jobName",
    "$env:CODEX_OWNED_SUPERVISOR_PID = [string]$PID",
    "$application = Join-Path $PSHOME 'powershell.exe'",
    `$commandLine = '"' + $application + '" -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${runner}`,
    `$exitCode = [CodexOwnedJob]::LaunchAndWait($jobName, $application, $commandLine, (Get-Location).Path, ${ownerPid}, ${ownerStartKey})`,
    "exit $exitCode"
  ].join("; ");
}

/** @param {ProcessIdentity} observed @param {string} jobName */
function commandHasWindowsJobSupervisor(observed, jobName) {
  const expectedCommand = encodePowerShell(
    buildWindowsJobSupervisorScript(jobName, 0, "0")
  );
  return String(observed.command ?? "").includes(expectedCommand);
}

/** @param {string} jobName */
function buildWindowsJobStopScript(jobName) {
  return [
    `$nativeSource = ${powerShellLiteral(WINDOWS_JOB_NATIVE_SOURCE)}`,
    "Add-Type -TypeDefinition $nativeSource -Language CSharp",
    `$stopped = [CodexOwnedJob]::Terminate(${powerShellLiteral(jobName)}, 143)`,
    "if (-not $stopped) { exit 3 }"
  ].join("; ");
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {OwnedLaunchOptions} [options]
 */
export function createOwnedProcessLaunch(command, args, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "linux" && platform !== "win32") {
    throw new Error(
      `Exact owned-process generation tracking is unsupported on platform ${platform}.`
    );
  }
  const env = {
    ...(options.env ?? process.env)
  };
  if (platform === "win32") {
    const token = options.token;
    assertWorkerToken(token);
    const jobName = ownedWindowsJobName(token);
    const ownerIdentity = options.terminateWithOwner
      ? options.ownerIdentity ?? inspectProcess(process.pid, { platform })
      : null;
    if (
      options.terminateWithOwner &&
      (
        ownerIdentity?.pid !== process.pid ||
        !/^\d+$/.test(ownerIdentity.startKey)
      )
    ) {
      throw new Error("Cannot capture the exact Windows owner generation.");
    }
    const ownerPid = ownerIdentity?.pid ?? 0;
    const ownerStartKey = ownerIdentity?.startKey ?? "0";
    env.CODEX_OWNED_TARGET = encodeLaunchDescriptor(command, args);
    return {
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        encodePowerShell(buildWindowsJobSupervisorScript(jobName, ownerPid, ownerStartKey))
      ],
      spawnOptions: {
        cwd: options.cwd,
        env,
        stdio: options.stdio ?? ["pipe", "pipe", "pipe"],
        shell: false,
        detached: false,
        windowsHide: true
      },
      ownership: {
        platform,
        jobName
      }
    };
  }

  env.CODEX_OWNED_TARGET = encodeLaunchDescriptor(command, args);
  return {
    command: process.execPath,
    args: [fileURLToPath(import.meta.url), POSIX_SUPERVISOR_FLAG],
    spawnOptions: {
      cwd: options.cwd,
      env,
      stdio: options.stdio ?? ["pipe", "pipe", "pipe", "ipc"],
      shell: false,
      detached: true,
      windowsHide: true
    },
    ownership: {
      platform,
      jobName: null
    }
  };
}

/**
 * @param {NodeJS.Platform} [platform]
 */
export function assertOwnedWorkerPlatformSupported(
  platform = process.platform
) {
  if (platform !== "linux" && platform !== "win32") {
    throw new Error(
      `Exact owned-process generation tracking is unsupported on platform ${platform}.`
    );
  }
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {string} token
 * @param {OwnedLaunchOptions} [options]
 */
export function createOwnedWorkerLaunch(command, args, token, options = {}) {
  const platform = options.platform ?? process.platform;
  assertOwnedWorkerPlatformSupported(platform);
  if (platform === "linux") {
    return {
      command,
      args,
      spawnOptions: {
        cwd: options.cwd,
        env: options.env ?? process.env,
        detached: true,
        stdio: options.stdio ?? "ignore",
        windowsHide: true
      },
      ownership: {
        platform,
        jobName: null
      }
    };
  }
  return createOwnedProcessLaunch(command, args, {
    ...options,
    platform,
    token,
    stdio: options.stdio ?? "ignore"
  });
}

/** @param {ProcessIdentity} observed @param {string} token */
function commandHasWorkerToken(observed, token) {
  const argv = observed.argv;
  const markerIndex = argv?.indexOf("--worker-token") ?? -1;
  if (argv && markerIndex !== -1) {
    return argv[markerIndex + 1] === token;
  }

  const escapedToken = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[\\s"'])--worker-token[\\s"']+${escapedToken}(?=$|[\\s"'])`).test(
    observed.command ?? ""
  );
}

/** @param {unknown} identity @returns {asserts identity is OwnedWorkerIdentity} */
function validateOwnedWorkerIdentity(identity) {
  if (!isOwnedWorker(identity)) {
    throw new Error("Owned worker identity is missing or unsupported.");
  }
  assertPositiveIntegerPid(identity.pid);
  assertWorkerToken(identity.token);
  if (identity.platform === "win32") {
    if (identity.jobName !== ownedWindowsJobName(identity.token)) {
      throw new Error("Owned Windows worker is missing its exact Job Object name.");
    }
  } else {
    assertPositiveIntegerPid(identity.processGroupId);
    if (identity.processGroupId !== identity.pid) {
      throw new Error("Owned POSIX worker must be the leader of its process group.");
    }
  }
}

/**
 * @param {number} pid
 * @param {string} token
 * @param {WorkerCaptureOptions} [options]
 * @returns {OwnedWorkerIdentity}
 */
export function captureOwnedWorkerIdentity(pid, token, options = {}) {
  assertPositiveIntegerPid(pid);
  assertWorkerToken(token);
  const platform = options.platform ?? process.platform;
  if (platform !== "linux" && platform !== "win32") {
    throw new Error(
      `Exact owned-process generation tracking is unsupported on platform ${platform}.`
    );
  }
  const supervisorPid =
    platform === "win32" && pid === process.pid
      ? Number(options.supervisorPid ?? process.env.CODEX_OWNED_SUPERVISOR_PID)
      : pid;
  assertPositiveIntegerPid(supervisorPid);
  const observed = inspectProcess(supervisorPid, { ...options, platform });
  if (!observed) {
    throw new Error(`Cannot capture owned worker identity: pid ${supervisorPid} is not running.`);
  }
  if (observed.pid !== supervisorPid || !observed.startKey) {
    throw new Error(`Cannot capture owned worker identity for pid ${supervisorPid}.`);
  }
  if (platform === "win32") {
    const jobName =
      options.jobName ??
      process.env.CODEX_OWNED_JOB_NAME ??
      ownedWindowsJobName(token);
    if (!commandHasWindowsJobSupervisor(observed, jobName)) {
      throw new Error(
        `Cannot capture owned worker identity: Job Object supervisor does not match pid ${supervisorPid}.`
      );
    }
  } else if (!commandHasWorkerToken(observed, token)) {
    throw new Error(`Cannot capture owned worker identity: worker token does not match pid ${pid}.`);
  }
  if (platform !== "win32" && observed.processGroupId !== supervisorPid) {
    throw new Error(`Cannot capture owned worker identity: pid ${pid} is not its process-group leader.`);
  }

  if (platform === "win32") {
    return {
      version: 2,
      pid: supervisorPid,
      token,
      startKey: observed.startKey,
      platform,
      processGroupId: null,
      jobName: ownedWindowsJobName(token)
    };
  }
  assertPositiveIntegerPid(observed.processGroupId);
  return {
    version: 1,
    pid: supervisorPid,
    token,
    startKey: observed.startKey,
    platform,
    processGroupId: observed.processGroupId
  };
}

/**
 * @param {unknown} identity
 * @param {ProcessInspectionOptions} [options]
 */
export function inspectOwnedWorker(identity, options = {}) {
  validateOwnedWorkerIdentity(identity);
  const observed = inspectProcess(identity.pid, {
    ...options,
    platform: identity.platform
  });
  if (!observed) {
    return { status: "gone", observed: null };
  }

  const matches =
    observed.pid === identity.pid &&
    observed.startKey === identity.startKey &&
    (identity.platform === "win32"
      ? commandHasWindowsJobSupervisor(observed, identity.jobName)
      : commandHasWorkerToken(observed, identity.token) &&
        observed.processGroupId === identity.processGroupId);
  return {
    status: matches ? "same" : "mismatch",
    observed
  };
}

/** @param {unknown} pid @param {Pick<ProcessControlOptions, "killImpl">} [options] */
export function isProcessAlive(pid, options = {}) {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  const killImpl = options.killImpl ?? process.kill.bind(process);
  try {
    killImpl(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

/** @param {number} processGroupId @param {Pick<ProcessControlOptions, "killImpl">} [options] */
function isProcessGroupAlive(processGroupId, options = {}) {
  assertPositiveIntegerPid(processGroupId);
  const killImpl = options.killImpl ?? process.kill.bind(process);
  try {
    killImpl(-processGroupId, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EPERM") {
      return true;
    }
    if (isMissingProcessError(error)) {
      return false;
    }
    throw error;
  }
}

/**
 * @param {() => boolean} isAlive
 * @param {Pick<ProcessControlOptions, "timeoutMs" | "intervalMs" | "deadlineAt">} [options]
 */
async function waitForConditionToClear(isAlive, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_WORKER_CONFIG.stopKillMs;
  const intervalMs =
    options.intervalMs ?? DEFAULT_PROCESS_POLL_INTERVAL_MS;
  const deadline = Math.min(
    Date.now() + timeoutMs,
    options.deadlineAt ?? Number.POSITIVE_INFINITY
  );
  while (Date.now() < deadline) {
    if (!isAlive()) {
      return true;
    }
    const waitMs = Math.min(intervalMs, Math.max(0, deadline - Date.now()));
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  return false;
}

/** @param {PosixWorkerIdentity} identity @param {ProcessControlOptions} [options] */
async function stopOwnedPosixWorkerTree(identity, options = {}) {
  const killImpl = options.killImpl ?? process.kill.bind(process);
  const processGroupId = identity.processGroupId;
  try {
    killImpl(-processGroupId, "SIGTERM");
  } catch (error) {
    if (!isMissingProcessError(error)) {
      throw error;
    }
  }

  const stoppedGracefully = await waitForConditionToClear(
    () => isProcessGroupAlive(processGroupId, { killImpl }),
    {
      timeoutMs: options.graceMs ?? DEFAULT_WORKER_CONFIG.stopGraceMs,
      intervalMs: options.intervalMs,
      deadlineAt: options.deadlineAt
    }
  );
  if (stoppedGracefully) {
    return { stopped: true, forced: false };
  }

  const beforeForce = inspectOwnedWorker(identity, options);
  if (beforeForce.status !== "same") {
    throw new Error(
      `Cannot force-stop worker ${identity.pid}: identity mismatch while its process group is still running.`
    );
  }

  try {
    killImpl(-processGroupId, "SIGKILL");
  } catch (error) {
    if (!isMissingProcessError(error)) {
      throw error;
    }
  }
  const stoppedForcibly = await waitForConditionToClear(
    () => isProcessGroupAlive(processGroupId, { killImpl }),
    {
      timeoutMs: options.killMs ?? DEFAULT_WORKER_CONFIG.stopKillMs,
      intervalMs: options.intervalMs,
      deadlineAt: options.deadlineAt
    }
  );
  if (!stoppedForcibly) {
    throw new Error(`Cannot verify forced shutdown of worker process group ${processGroupId}.`);
  }
  return { stopped: true, forced: true };
}

/** @param {PosixGroupIdentity} identity @param {ProcessControlOptions} [options] */
export async function stopOwnedPosixSupervisorGroup(identity, options = {}) {
  const deadlineAt =
    options.deadlineAt ??
    Date.now() +
      (options.graceMs ?? DEFAULT_APP_SERVER_CLOSE_CONFIG.termMs) +
      (options.killMs ?? DEFAULT_APP_SERVER_CLOSE_CONFIG.killMs);
  const boundedOptions = { ...options, deadlineAt };
  assertPositiveIntegerPid(identity?.pid);
  assertPositiveIntegerPid(identity?.processGroupId);
  if (identity.processGroupId !== identity.pid) {
    throw new Error("Owned POSIX supervisor must lead its process group.");
  }
  const initial = inspectProcess(identity.pid, boundedOptions);
  if (!initial) {
    if (!isProcessGroupAlive(identity.processGroupId, boundedOptions)) {
      return { stopped: true, forced: false };
    }
    throw new Error("Owned POSIX supervisor disappeared while its process group is still alive.");
  }
  if (
    initial.startKey !== identity.startKey ||
    initial.processGroupId !== identity.processGroupId
  ) {
    throw new Error("Owned POSIX supervisor identity mismatch.");
  }

  const killImpl = boundedOptions.killImpl ?? process.kill.bind(process);
  try {
    killImpl(-identity.processGroupId, "SIGTERM");
  } catch (error) {
    if (isMissingProcessError(error)) {
      return { stopped: true, forced: false };
    }
    throw error;
  }
  const graceMs = Math.min(
    boundedOptions.graceMs ?? DEFAULT_APP_SERVER_CLOSE_CONFIG.termMs,
    Math.max(0, deadlineAt - Date.now())
  );
  if (graceMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, graceMs));
  }

  const anchor = inspectProcess(identity.pid, boundedOptions);
  if (
    !anchor ||
    anchor.startKey !== identity.startKey ||
    anchor.processGroupId !== identity.processGroupId
  ) {
    throw new Error("Owned POSIX supervisor did not preserve its process-group anchor.");
  }
  try {
    killImpl(-identity.processGroupId, "SIGKILL");
  } catch (error) {
    if (!isMissingProcessError(error)) {
      throw error;
    }
  }
  const stopped = await waitForConditionToClear(
    () => isProcessGroupAlive(identity.processGroupId, { killImpl }),
    {
      timeoutMs:
        boundedOptions.killMs ?? DEFAULT_APP_SERVER_CLOSE_CONFIG.killMs,
      intervalMs: boundedOptions.intervalMs,
      deadlineAt
    }
  );
  if (!stopped) {
    throw new Error(`Cannot verify shutdown of process group ${identity.processGroupId}.`);
  }
  return { stopped: true, forced: true };
}

/** @param {string} jobName @param {ProcessControlOptions} [options] */
export function terminateOwnedWindowsJob(jobName, options = {}) {
  if (typeof jobName !== "string" || !jobName.startsWith(WINDOWS_JOB_PREFIX)) {
    throw new Error("Owned Windows Job Object name is invalid.");
  }
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const timeout = remainingCommandTimeout(options);
  const result = runCommandImpl(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      encodePowerShell(buildWindowsJobStopScript(jobName))
    ],
    {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      timeout
    }
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status === 3) {
    return { stopped: false, missing: true };
  }
  if (result.status !== 0 || result.signal) {
    throw new Error(formatCommandFailure(result));
  }
  return { stopped: true, missing: false };
}

/** @param {WindowsWorkerIdentity} identity @param {ProcessControlOptions} [options] */
async function stopOwnedWindowsWorkerTree(identity, options = {}) {
  const result = terminateOwnedWindowsJob(identity.jobName, options);
  if (result.missing) {
    const inspection = inspectOwnedWorker(identity, options);
    if (inspection.status === "same") {
      throw new Error(
        `Owned Windows Job Object ${identity.jobName} is missing while its supervisor is running.`
      );
    }
    return { stopped: true, forced: false };
  }

  const stopped = await waitForConditionToClear(() => {
    const inspection = inspectOwnedWorker(identity, options);
    return inspection.status === "same";
  }, {
    ...options,
    timeoutMs: options.killMs ?? DEFAULT_WORKER_CONFIG.stopKillMs
  });
  if (!stopped) {
    throw new Error(`Cannot verify Job Object shutdown of worker process tree ${identity.pid}.`);
  }
  return { stopped: true, forced: true };
}

/** @param {unknown} identity @param {ProcessControlOptions} [options] */
export async function stopOwnedWorkerTree(identity, options = {}) {
  validateOwnedWorkerIdentity(identity);
  const deadlineAt =
    options.deadlineAt ??
    Date.now() +
      (options.graceMs ?? DEFAULT_WORKER_CONFIG.stopGraceMs) +
      (options.killMs ?? DEFAULT_WORKER_CONFIG.stopKillMs);
  const boundedOptions = { ...options, deadlineAt };
  const beforeStop = inspectOwnedWorker(identity, boundedOptions);
  if (beforeStop.status === "gone") {
    if (
      identity.platform !== "win32" &&
      !isProcessGroupAlive(identity.processGroupId, {
        killImpl: options.killImpl
      })
    ) {
      return { stopped: true, forced: false };
    }
    throw new Error(
      `Cannot verify shutdown of worker tree ${identity.pid}: its identity anchor is gone.`
    );
  }
  if (beforeStop.status !== "same") {
    throw new Error(`Cannot stop worker ${identity.pid}: identity mismatch.`);
  }
  return identity.platform === "win32"
    ? stopOwnedWindowsWorkerTree(identity, boundedOptions)
    : stopOwnedPosixWorkerTree(identity, boundedOptions);
}

/**
 * @param {unknown} identity
 * @param {WorkerTerminationConfig} config
 * @param {WorkerTerminationOptions} [options]
 */
export function installBoundedWorkerTermination(identity, config, options = {}) {
  validateOwnedWorkerIdentity(identity);
  const killImpl = options.killImpl ?? process.kill.bind(process);
  const exitImpl = options.exitImpl ?? process.exit.bind(process);
  const setTimeoutImpl = options.setTimeoutImpl ?? setTimeout;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  /** @type {number | null} */
  let forceDeadlineAt = null;

  const forceExit = () => {
    timer = null;
    if (identity.platform === "win32") {
      try {
        terminateOwnedWindowsJob(identity.jobName, {
          ...options,
          deadlineAt:
            forceDeadlineAt ??
            Date.now() +
              (config.stopKillMs ?? DEFAULT_WORKER_CONFIG.stopKillMs)
        });
      } catch (error) {
        process.stderr.write(`Cannot force-stop Windows worker Job Object: ${getErrorMessage(error)}\n`);
      }
      exitImpl(143);
      return;
    }
    try {
      killImpl(-identity.processGroupId, "SIGKILL");
    } catch (error) {
      if (!isMissingProcessError(error)) {
        process.stderr.write(`Cannot force-stop worker group: ${getErrorMessage(error)}\n`);
      }
      exitImpl(143);
    }
  };

  const handleTermination = () => {
    if (timer !== null) {
      return;
    }
    forceDeadlineAt =
      Date.now() +
      config.signalAnchorMs +
      (config.stopKillMs ?? DEFAULT_WORKER_CONFIG.stopKillMs);
    timer = setTimeoutImpl(forceExit, config.signalAnchorMs);
    if (identity.platform === "win32") {
      return;
    }
    try {
      killImpl(-identity.processGroupId, "SIGTERM");
    } catch (error) {
      if (!isMissingProcessError(error)) {
        process.stderr.write(`Cannot propagate worker termination: ${getErrorMessage(error)}\n`);
      }
    }
  };

  process.on("SIGTERM", handleTermination);
  return () => {
    if (timer !== null) {
      return;
    }
    process.off("SIGTERM", handleTermination);
  };
}

/** @param {CommandResult} result */
export function formatCommandFailure(result) {
  const parts = [`${result.command} ${result.args.join(" ")}`.trim()];
  if (result.signal) {
    parts.push(`signal=${result.signal}`);
  } else {
    parts.push(`exit=${result.status}`);
  }
  const stderr = (result.stderr || "").trim();
  const stdout = (result.stdout || "").trim();
  if (stderr) {
    parts.push(stderr);
  } else if (stdout) {
    parts.push(stdout);
  }
  return parts.join(": ");
}

/** @returns {LaunchDescriptor} */
function decodeOwnedTarget() {
  const encoded = process.env.CODEX_OWNED_TARGET;
  if (!encoded) {
    throw new Error("Owned process supervisor is missing its launch descriptor.");
  }
  delete process.env.CODEX_OWNED_TARGET;
  const descriptor = parseUnknownJson(Buffer.from(encoded, "base64").toString("utf8"));
  if (
    typeof descriptor !== "object" ||
    descriptor === null ||
    !("command" in descriptor) ||
    typeof descriptor.command !== "string" ||
    !("args" in descriptor) ||
    !isStringArray(descriptor.args)
  ) {
    throw new Error("Owned process supervisor received an invalid launch descriptor.");
  }
  return {
    command: descriptor.command,
    args: descriptor.args
  };
}

/** @param {unknown} value @returns {value is string[]} */
function isStringArray(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

async function runPosixOwnedSupervisor() {
  const descriptor = decodeOwnedTarget();
  process.on("SIGTERM", () => {});
  process.on("disconnect", () => {
    try {
      process.kill(-process.pid, "SIGTERM");
    } catch (error) {
      if (!isMissingProcessError(error)) {
        process.stderr.write(`Cannot stop disconnected owned process group: ${getErrorMessage(error)}\n`);
      }
    }
    setTimeout(() => {
      try {
        process.kill(-process.pid, "SIGKILL");
      } catch (error) {
        if (!isMissingProcessError(error)) {
          process.stderr.write(`Cannot force-stop disconnected owned process group: ${getErrorMessage(error)}\n`);
        }
      }
    }, DEFAULT_APP_SERVER_CLOSE_CONFIG.termMs);
  });
  setInterval(() => {}, 60_000);
  const child = spawn(descriptor.command, descriptor.args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
    shell: false
  });
  process.stdin.pipe(child.stdin);
  child.stdout.pipe(process.stdout, { end: false });
  child.stderr.pipe(process.stderr, { end: false });

  child.stdin.on("error", (error) => {
    process.stdin.unpipe(child.stdin);
    if (process.connected && process.send) {
      process.send({
        type: "owned-target-error",
        message: error.message
      });
    }
  });
  child.once("error", (error) => {
    if (process.connected && process.send) {
      process.send({
        type: "owned-target-error",
        message: error.message
      });
    }
  });
  child.once("close", (code, signal) => {
    if (process.connected && process.send) {
      process.send({
        type: "owned-target-exit",
        code,
        signal
      });
    }
    child.stdout.unpipe(process.stdout);
    child.stderr.unpipe(process.stderr);
  });
  await new Promise(() => {});
}

const isProcessModuleEntrypoint =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isProcessModuleEntrypoint && process.argv[2] === POSIX_SUPERVISOR_FLAG) {
  runPosixOwnedSupervisor().catch((error) => {
    process.stderr.write(`Owned process supervisor failed: ${getErrorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
