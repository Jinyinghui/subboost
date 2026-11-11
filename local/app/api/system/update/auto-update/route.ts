import { withCurrentAdmin } from "@local/lib/api-auth";
import { apiError, json, jsonBodyError, LOCAL_JSON_BODY_LIMITS, readJsonBody } from "@local/lib/http";
import { readAutoUpdateSetting, SelfUpdateError, writeAutoUpdateSetting } from "@local/lib/self-update";

export const dynamic = "force-dynamic";

export async function GET() {
  return withCurrentAdmin(async () => {
    return json({ enabled: readAutoUpdateSetting() });
  });
}

export async function PATCH(request: Request) {
  return withCurrentAdmin(async () => {
    const parsedBody = await readJsonBody(request, LOCAL_JSON_BODY_LIMITS.small);
    if (!parsedBody.ok) return jsonBodyError(parsedBody);
    const body = parsedBody.value;
    const enabled =
      typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>).enabled
        : undefined;
    if (typeof enabled !== "boolean") {
      return apiError("enabled must be a boolean.", "VALIDATION_ERROR", 400);
    }
    try {
      return json({ enabled: writeAutoUpdateSetting(enabled) });
    } catch (error) {
      if (error instanceof SelfUpdateError) {
        return apiError(error.message, error.code, error.status);
      }
      throw error;
    }
  });
}
