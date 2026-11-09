import { withCurrentAdmin } from "@local/lib/api-auth";
import { apiError, json } from "@local/lib/http";
import {
  fetchLatestRelease,
  readUpdateStatus,
  requestSelfUpdate,
  SelfUpdateError,
} from "@local/lib/self-update";

export const dynamic = "force-dynamic";

export async function GET() {
  return withCurrentAdmin(async () => {
    const latest = await fetchLatestRelease({ fresh: true });
    const { watcherEnabled, status } = readUpdateStatus();
    return json({ ...latest, watcherEnabled, status });
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
