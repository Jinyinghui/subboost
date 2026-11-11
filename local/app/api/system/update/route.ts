import { withCurrentAdmin } from "@local/lib/api-auth";
import { apiError, json } from "@local/lib/http";
import {
  fetchLatestRelease,
  readAutoUpdateSetting,
  readPrepullStatus,
  readUpdateHistory,
  readUpdateStatus,
  requestPrepull,
  requestSelfUpdate,
  SelfUpdateError,
} from "@local/lib/self-update";

export const dynamic = "force-dynamic";

export async function GET() {
  return withCurrentAdmin(async (admin) => {
    const latest = await fetchLatestRelease({ fresh: true });
    const { watcherEnabled, status } = readUpdateStatus();
    const { prepullWatcherEnabled, prepull } = readPrepullStatus();
    const history = readUpdateHistory();
    const autoUpdateEnabled = readAutoUpdateSetting();
    // 新版已出、后台还没拉、又没有更新在跑时，顺手提交一次后台拉取
    // （幂等：同一版本已提交/拉取中/已就绪时直接返回，不重复提交）。
    let currentPrepull = prepull;
    if (
      latest.hasUpdate &&
      latest.latestVersion &&
      prepullWatcherEnabled &&
      status.state !== "requested" &&
      status.state !== "running" &&
      (prepull.state === "idle" || prepull.state === "failed")
    ) {
      try {
        currentPrepull = requestPrepull(admin.id, latest.latestVersion);
      } catch {
        // Best effort: 后台拉取只是加速，失败不影响状态查询。
      }
    }
    return json({
      ...latest,
      watcherEnabled,
      prepullWatcherEnabled,
      status,
      prepull: currentPrepull,
      history,
      autoUpdateEnabled,
    });
  });
}

export async function POST(request: Request) {
  return withCurrentAdmin(async (admin) => {
    let targetVersion: string | null = null;
    try {
      const body: unknown = await request.json().catch(() => null);
      if (body && typeof body === "object" && !Array.isArray(body)) {
        const raw = (body as Record<string, unknown>).targetVersion;
        if (typeof raw === "string" && raw.trim()) targetVersion = raw.trim();
      }
    } catch {
      // A missing or malformed body just means "update to the latest release".
    }
    try {
      const status = requestSelfUpdate(admin.id, targetVersion);
      return json({ status }, 202);
    } catch (error) {
      if (error instanceof SelfUpdateError) {
        return apiError(error.message, error.code, error.status);
      }
      throw error;
    }
  });
}
