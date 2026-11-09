import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
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

function watcherFile(): string {
  return `${opsDir()}/watcher.json`;
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
  return {
    watcherEnabled: watcher?.installed === true,
    status: normalizeStatus(readJsonObject(statusFile())),
  };
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
