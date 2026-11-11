import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { resolveAppVersionInfo } from "@subboost/server-core/app-version";
import { compareStableVersions, parseStableVersion } from "@local/lib/release-version";
import type { LocalApiErrorCode } from "@local/lib/http";

const GITHUB_LATEST_RELEASE_URL = "https://api.github.com/repos/SubBoost/subboost/releases/latest";

export type SelfUpdateState = "idle" | "requested" | "running" | "succeeded" | "failed";

export type SelfUpdateStatus = {
  state: SelfUpdateState;
  requestedAt: string | null;
  requestedBy: string | null;
  targetVersion: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  message: string | null;
  logTail: string | null;
};

export type LatestReleaseInfo = {
  currentVersion: string;
  latestVersion: string | null;
  latestTag: string | null;
  releaseUrl: string | null;
  hasUpdate: boolean;
};

export type PrepullState = "idle" | "requested" | "pulling" | "ready" | "failed";

export type PrepullStatus = {
  state: PrepullState;
  targetVersion: string | null;
  imageTag: string | null;
  message: string | null;
  updatedAt: string | null;
};

export type UpdateHistoryEntry = {
  targetVersion: string | null;
  fromVersion: string | null;
  state: "succeeded" | "failed";
  startedAt: string | null;
  finishedAt: string | null;
  message: string | null;
};

export class SelfUpdateError extends Error {
  code: LocalApiErrorCode;
  status: number;

  constructor(code: LocalApiErrorCode, status: number, message: string) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function opsDir(): string {
  return process.env.SUBBOOST_OPS_DIR || "/ops";
}

function requestFile(): string {
  return `${opsDir()}/update-requested.json`;
}

function statusFile(): string {
  return `${opsDir()}/update-status.json`;
}

function logFile(): string {
  return `${opsDir()}/update.log`;
}

/** 日志面板每次显示的尾行数。 */
export const UPDATE_LOG_TAIL_LINES = 40;

const UPDATE_LOG_TAIL_MAX_BYTES = 128 * 1024;

/**
 * 直接读更新日志的实时尾部。状态文件里的 logTail 是安装时留下的旧文本，
 * 不能反映进行中的拉取进度；日志文件由宿主更新器持续追加，和状态文件在
 * 同一个 /ops 目录下，容器内可读。
 */
function readUpdateLogTail(): string | null {
  try {
    let content = readFileSync(logFile(), "utf8");
    if (content.length > UPDATE_LOG_TAIL_MAX_BYTES) {
      content = content.slice(content.length - UPDATE_LOG_TAIL_MAX_BYTES);
    }
    const lines = content
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0);
    if (lines.length === 0) return null;
    return lines.slice(-UPDATE_LOG_TAIL_LINES).join("\n");
  } catch {
    return null;
  }
}

function watcherFile(): string {
  return `${opsDir()}/watcher.json`;
}

function prepullRequestFile(): string {
  return `${opsDir()}/prepull-requested.json`;
}

function prepullStatusFile(): string {
  return `${opsDir()}/prepull-status.json`;
}

function prepullWatcherFile(): string {
  return `${opsDir()}/prepull-watcher.json`;
}

function historyFile(): string {
  return `${opsDir()}/update-history.json`;
}

function autoUpdateFile(): string {
  return `${opsDir()}/auto-update.json`;
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function readJsonObject(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isSelfUpdateState(value: unknown): value is SelfUpdateState {
  return (
    value === "idle" ||
    value === "requested" ||
    value === "running" ||
    value === "succeeded" ||
    value === "failed"
  );
}

function normalizeStatus(record: Record<string, unknown> | null): SelfUpdateStatus {
  return {
    state: isSelfUpdateState(record?.state) ? record.state : "idle",
    requestedAt: readString(record?.requestedAt),
    requestedBy: readString(record?.requestedBy),
    targetVersion: readString(record?.targetVersion),
    startedAt: readString(record?.startedAt),
    finishedAt: readString(record?.finishedAt),
    message: readString(record?.message),
    logTail: readString(record?.logTail),
  };
}

export function readUpdateStatus(): { watcherEnabled: boolean; status: SelfUpdateStatus } {
  const watcher = readJsonObject(watcherFile());
  const status = normalizeStatus(readJsonObject(statusFile()));
  // 状态文件里的 logTail 是旧文本，改用 live 日志尾部，页面才能看到实时进度。
  return { watcherEnabled: watcher?.installed === true, status: { ...status, logTail: readUpdateLogTail() } };
}

function isPrepullState(value: unknown): value is PrepullState {
  return (
    value === "idle" ||
    value === "requested" ||
    value === "pulling" ||
    value === "ready" ||
    value === "failed"
  );
}

function normalizePrepullStatus(record: Record<string, unknown> | null): PrepullStatus {
  return {
    state: isPrepullState(record?.state) ? record.state : "idle",
    targetVersion: readString(record?.targetVersion),
    imageTag: readString(record?.imageTag),
    message: readString(record?.message),
    updatedAt: readString(record?.updatedAt),
  };
}

export function readPrepullStatus(): { prepullWatcherEnabled: boolean; prepull: PrepullStatus } {
  const watcher = readJsonObject(prepullWatcherFile());
  return {
    prepullWatcherEnabled: watcher?.installed === true,
    prepull: normalizePrepullStatus(readJsonObject(prepullStatusFile())),
  };
}

export function requestPrepull(adminId: string, targetVersion: string): PrepullStatus {
  const dir = opsDir();
  if (!existsSync(dir)) {
    throw new SelfUpdateError(
      "CONFIGURATION_ERROR",
      503,
      "后台拉取未启用：更新服务目录不存在，请先在服务器执行一次 subboost update。"
    );
  }
  const { prepullWatcherEnabled, prepull } = readPrepullStatus();
  if (!prepullWatcherEnabled) {
    throw new SelfUpdateError(
      "CONFIGURATION_ERROR",
      503,
      "后台拉取未启用：拉取服务未安装，请在服务器执行 subboost ensure-update-services（更新到 v2.11.20 后需手动执行一次）。"
    );
  }
  // 同一版本已提交/拉取中/已就绪时直接返回，不重复提交。
  if (
    prepull.targetVersion === targetVersion &&
    (prepull.state === "requested" || prepull.state === "pulling" || prepull.state === "ready")
  ) {
    return prepull;
  }
  const { status } = readUpdateStatus();
  if (status.state === "requested" || status.state === "running" || existsSync(requestFile())) {
    throw new SelfUpdateError("CONFLICT", 409, "已有更新正在进行，拉取会在更新结束后进行。");
  }
  const requestedAt = new Date().toISOString();
  const request = { requestedAt, requestedBy: adminId, targetVersion };
  try {
    writeFileSync(prepullRequestFile(), `${JSON.stringify(request)}\n`, { flag: "wx" });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "EEXIST") return readPrepullStatus().prepull;
    throw new SelfUpdateError(
      "CONFIGURATION_ERROR",
      503,
      "无法写入拉取请求：更新服务目录不可写，请检查服务器上的更新服务安装。"
    );
  }
  const nextStatus: PrepullStatus = {
    state: "requested",
    targetVersion,
    imageTag: null,
    message: "已提交后台拉取请求，等待拉取服务执行……",
    updatedAt: requestedAt,
  };
  try {
    writeFileSync(prepullStatusFile(), `${JSON.stringify(nextStatus)}\n`);
  } catch {
    try {
      unlinkSync(prepullRequestFile());
    } catch {
      // Best effort: the watcher will ignore a stale request once the status is gone.
    }
    throw new SelfUpdateError("INTERNAL_ERROR", 500, "无法记录拉取状态，请稍后重试。");
  }
  return nextStatus;
}

function normalizeHistoryEntry(value: unknown): UpdateHistoryEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.state !== "succeeded" && record.state !== "failed") return null;
  return {
    targetVersion: readString(record.targetVersion),
    fromVersion: readString(record.fromVersion),
    state: record.state,
    startedAt: readString(record.startedAt),
    finishedAt: readString(record.finishedAt),
    message: readString(record.message),
  };
}

export function readUpdateHistory(): UpdateHistoryEntry[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(historyFile(), "utf8"));
    if (!Array.isArray(parsed)) return [];
    const entries: UpdateHistoryEntry[] = [];
    for (const item of parsed) {
      const entry = normalizeHistoryEntry(item);
      if (entry) entries.push(entry);
    }
    return entries;
  } catch {
    return [];
  }
}

export function readAutoUpdateSetting(): boolean {
  const record = readJsonObject(autoUpdateFile());
  return record?.enabled === true;
}

export function writeAutoUpdateSetting(enabled: boolean): boolean {
  const dir = opsDir();
  if (!existsSync(dir)) {
    throw new SelfUpdateError(
      "CONFIGURATION_ERROR",
      503,
      "定时更新未启用：更新服务目录不存在，请先在服务器执行一次 subboost update。"
    );
  }
  const payload = { enabled, updatedAt: new Date().toISOString() };
  const tmpFile = `${autoUpdateFile()}.tmp.${process.pid}`;
  try {
    writeFileSync(tmpFile, `${JSON.stringify(payload)}\n`);
    renameSync(tmpFile, autoUpdateFile());
  } catch {
    try {
      unlinkSync(tmpFile);
    } catch {
      // Best effort.
    }
    throw new SelfUpdateError("INTERNAL_ERROR", 500, "无法保存定时更新设置，请稍后重试。");
  }
  return enabled;
}

export function requestSelfUpdate(adminId: string, targetVersion: string | null): SelfUpdateStatus {
  const dir = opsDir();
  if (!existsSync(dir)) {
    throw new SelfUpdateError(
      "CONFIGURATION_ERROR",
      503,
      "站内更新未启用：更新服务目录不存在，请先在服务器执行一次 subboost update。"
    );
  }
  const { watcherEnabled, status } = readUpdateStatus();
  if (!watcherEnabled) {
    throw new SelfUpdateError(
      "CONFIGURATION_ERROR",
      503,
      "站内更新未启用：更新服务未安装，请先在服务器执行一次 subboost update。"
    );
  }
  if (status.state === "requested" || status.state === "running" || existsSync(requestFile())) {
    throw new SelfUpdateError("CONFLICT", 409, "已有更新正在进行，请稍后再试。");
  }

  const requestedAt = new Date().toISOString();
  const request = { requestedAt, requestedBy: adminId, targetVersion };
  try {
    writeFileSync(requestFile(), `${JSON.stringify(request)}\n`, { flag: "wx" });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "EEXIST") {
      throw new SelfUpdateError("CONFLICT", 409, "已有更新正在进行，请稍后再试。");
    }
    throw new SelfUpdateError(
      "CONFIGURATION_ERROR",
      503,
      "无法写入更新请求：更新服务目录不可写，请检查服务器上的更新服务安装。"
    );
  }

  const nextStatus: SelfUpdateStatus = {
    state: "requested",
    requestedAt,
    requestedBy: adminId,
    targetVersion,
    startedAt: null,
    finishedAt: null,
    message: "已提交更新请求，等待更新服务执行……",
    logTail: null,
  };
  try {
    writeFileSync(statusFile(), `${JSON.stringify(nextStatus)}\n`);
  } catch {
    try {
      unlinkSync(requestFile());
    } catch {
      // Best effort: the watcher will ignore a stale request once the status is gone.
    }
    throw new SelfUpdateError("INTERNAL_ERROR", 500, "无法记录更新状态，请稍后重试。");
  }
  return nextStatus;
}

function currentVersion(): string {
  return resolveAppVersionInfo({ env: process.env, cwd: process.cwd() }).releaseVersion;
}

function releasePageUrl(releaseJsonUrl: string, version: string): string {
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\/latest\/download\/release\.json$/.exec(
    releaseJsonUrl
  );
  if (match) return `https://github.com/${match[1]}/releases/tag/v${version}`;
  return releaseJsonUrl;
}

function fallbackInfo(current: string): LatestReleaseInfo {
  return {
    currentVersion: current,
    latestVersion: null,
    latestTag: null,
    releaseUrl: null,
    hasUpdate: false,
  };
}

export async function fetchLatestRelease(options: { fresh?: boolean } = {}): Promise<LatestReleaseInfo> {
  const current = currentVersion();
  const currentStable = parseStableVersion(current);
  if (!currentStable) return fallbackInfo(current);

  const releaseJsonUrl = readString(process.env.SUBBOOST_RELEASE_URL);
  try {
    if (releaseJsonUrl) {
      const response = await fetch(releaseJsonUrl, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
        ...(options.fresh
          ? { cache: "no-store" }
          : { next: { revalidate: 3600 } as Record<string, unknown> }),
      });
      if (!response.ok) return fallbackInfo(current);
      const data: unknown = await response.json().catch(() => null);
      const latestVersion = parseStableVersion(
        data && typeof data === "object" && !Array.isArray(data)
          ? (data as Record<string, unknown>).version
          : null
      );
      if (!latestVersion) return fallbackInfo(current);
      return {
        currentVersion: current,
        latestVersion: latestVersion.version,
        latestTag: `v${latestVersion.version}`,
        releaseUrl: releasePageUrl(releaseJsonUrl, latestVersion.version),
        hasUpdate: compareStableVersions(latestVersion, currentStable) > 0,
      };
    }

    const response = await fetch(GITHUB_LATEST_RELEASE_URL, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "SubBoost local release check",
      },
      signal: AbortSignal.timeout(10_000),
      ...(options.fresh
        ? { cache: "no-store" }
        : { next: { revalidate: 3600 } as Record<string, unknown> }),
    });
    if (!response.ok) return fallbackInfo(current);
    const data: unknown = await response.json().catch(() => null);
    const latestTag = readString(
      data && typeof data === "object" && !Array.isArray(data)
        ? (data as Record<string, unknown>).tag_name
        : null
    );
    const latestVersion = parseStableVersion(latestTag);
    if (!latestVersion) return fallbackInfo(current);
    const releaseUrl =
      readString(
        data && typeof data === "object" && !Array.isArray(data)
          ? (data as Record<string, unknown>).html_url
          : null
      ) ?? `https://github.com/SubBoost/subboost/releases/tag/${latestTag}`;
    return {
      currentVersion: current,
      latestVersion: latestVersion.version,
      latestTag,
      releaseUrl,
      hasUpdate: compareStableVersions(latestVersion, currentStable) > 0,
    };
  } catch {
    return fallbackInfo(current);
  }
}
