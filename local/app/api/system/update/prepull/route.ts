import { withCurrentAdmin } from "@local/lib/api-auth";
import { apiError, json } from "@local/lib/http";
import { fetchLatestRelease, requestPrepull, SelfUpdateError } from "@local/lib/self-update";

export const dynamic = "force-dynamic";

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
      // A missing or malformed body means "pre-pull the latest release".
    }
    if (!targetVersion) {
      const latest = await fetchLatestRelease({ fresh: true });
      targetVersion = latest.latestVersion;
    }
    if (!targetVersion) {
      return apiError("无法获取最新版本，请检查网络后重试。", "VALIDATION_ERROR", 400);
    }
    try {
      const prepull = requestPrepull(admin.id, targetVersion);
      return json({ prepull }, 202);
    } catch (error) {
      if (error instanceof SelfUpdateError) {
        return apiError(error.message, error.code, error.status);
      }
      throw error;
    }
  });
}
