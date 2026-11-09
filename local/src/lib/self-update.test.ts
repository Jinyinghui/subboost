import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const files = vi.hoisted(() => new Map<string, string>());

vi.mock("node:fs", () => ({
  existsSync: vi.fn((path: string) => files.has(path)),
  readFileSync: vi.fn((path: string) => {
    const content = files.get(path);
    if (content === undefined) {
      const error = new Error("ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }
    return content;
  }),
  writeFileSync: vi.fn((path: string, data: string, options?: { flag?: string }) => {
    if (options?.flag === "wx" && files.has(path)) {
      const error = new Error("EEXIST") as NodeJS.ErrnoException;
      error.code = "EEXIST";
      throw error;
    }
    files.set(path, data);
  }),
  unlinkSync: vi.fn((path: string) => {
    files.delete(path);
  }),
}));

import { fetchLatestRelease, readUpdateStatus, requestSelfUpdate, SelfUpdateError } from "./self-update";

const originalOpsDir = process.env.SUBBOOST_OPS_DIR;
const originalReleaseUrl = process.env.SUBBOOST_RELEASE_URL;
const originalAppReleaseVersion = process.env.APP_RELEASE_VERSION;

function releaseResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("self-update lib", () => {
  beforeEach(() => {
    files.clear();
    process.env.SUBBOOST_OPS_DIR = "/ops";
    process.env.APP_RELEASE_VERSION = "2.11.2";
    delete process.env.SUBBOOST_RELEASE_URL;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (originalOpsDir === undefined) delete process.env.SUBBOOST_OPS_DIR;
    else process.env.SUBBOOST_OPS_DIR = originalOpsDir;
    if (originalReleaseUrl === undefined) delete process.env.SUBBOOST_RELEASE_URL;
    else process.env.SUBBOOST_RELEASE_URL = originalReleaseUrl;
    if (originalAppReleaseVersion === undefined) delete process.env.APP_RELEASE_VERSION;
    else process.env.APP_RELEASE_VERSION = originalAppReleaseVersion;
  });

  it("reports idle when no watcher or status files exist", () => {
    expect(readUpdateStatus()).toEqual({
      watcherEnabled: false,
      status: {
        state: "idle",
        requestedAt: null,
        requestedBy: null,
        targetVersion: null,
        startedAt: null,
        finishedAt: null,
        message: null,
        logTail: null,
      },
    });
  });

  it("reads an installed watcher and a running status", () => {
    files.set("/ops", "");
    files.set("/ops/watcher.json", JSON.stringify({ installed: true }));
    files.set(
      "/ops/update-status.json",
      JSON.stringify({ state: "running", targetVersion: "2.11.3", message: "正在更新……" })
    );
    const result = readUpdateStatus();
    expect(result.watcherEnabled).toBe(true);
    expect(result.status.state).toBe("running");
    expect(result.status.targetVersion).toBe("2.11.3");
  });

  it("refuses a request when the ops directory is missing", () => {
    expect(() => requestSelfUpdate("admin-1", "2.11.3")).toThrowError(SelfUpdateError);
    try {
      requestSelfUpdate("admin-1", "2.11.3");
    } catch (error) {
      expect((error as SelfUpdateError).status).toBe(503);
      expect((error as SelfUpdateError).code).toBe("CONFIGURATION_ERROR");
    }
  });

  it("refuses a request when the watcher is not installed", () => {
    files.set("/ops", "");
    expect(() => requestSelfUpdate("admin-1", "2.11.3")).toThrowError(/更新服务未安装/);
  });

  it("writes a request and a requested status when enabled", () => {
    files.set("/ops", "");
    files.set("/ops/watcher.json", JSON.stringify({ installed: true }));
    const status = requestSelfUpdate("admin-1", "2.11.3");
    expect(status.state).toBe("requested");
    expect(status.targetVersion).toBe("2.11.3");
    const request = JSON.parse(files.get("/ops/update-requested.json") ?? "{}") as Record<
      string,
      unknown
    >;
    expect(request.requestedBy).toBe("admin-1");
    expect(request.targetVersion).toBe("2.11.3");
    expect(
      (JSON.parse(files.get("/ops/update-status.json") ?? "{}") as Record<string, unknown>).state
    ).toBe("requested");
  });

  it("refuses a second request while one is running", () => {
    files.set("/ops", "");
    files.set("/ops/watcher.json", JSON.stringify({ installed: true }));
    files.set("/ops/update-status.json", JSON.stringify({ state: "running" }));
    try {
      requestSelfUpdate("admin-1", "2.11.3");
      expect.unreachable();
    } catch (error) {
      expect((error as SelfUpdateError).status).toBe(409);
      expect((error as SelfUpdateError).code).toBe("CONFLICT");
    }
  });

  it("checks the fork release manifest when SUBBOOST_RELEASE_URL is set", async () => {
    process.env.SUBBOOST_RELEASE_URL =
      "https://github.com/Jinyinghui/subboost/releases/latest/download/release.json";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => releaseResponse({ version: "2.11.3", image: "ghcr.io/jinyinghui/subboost:v2.11.3" }))
    );
    await expect(fetchLatestRelease({ fresh: true })).resolves.toEqual({
      currentVersion: "2.11.2",
      latestVersion: "2.11.3",
      latestTag: "v2.11.3",
      releaseUrl: "https://github.com/Jinyinghui/subboost/releases/tag/v2.11.3",
      hasUpdate: true,
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://github.com/Jinyinghui/subboost/releases/latest/download/release.json",
      expect.objectContaining({ cache: "no-store" })
    );
  });

  it("falls back to the upstream GitHub API without a release URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        releaseResponse({
          tag_name: "v2.11.3",
          html_url: "https://github.com/SubBoost/subboost/releases/tag/v2.11.3",
        })
      )
    );
    await expect(fetchLatestRelease()).resolves.toMatchObject({
      currentVersion: "2.11.2",
      latestVersion: "2.11.3",
      hasUpdate: true,
    });
  });

  it("reports no update when the release manifest cannot be fetched", async () => {
    process.env.SUBBOOST_RELEASE_URL =
      "https://github.com/Jinyinghui/subboost/releases/latest/download/release.json";
    vi.stubGlobal("fetch", vi.fn(async () => releaseResponse({}, 404)));
    await expect(fetchLatestRelease({ fresh: true })).resolves.toEqual({
      currentVersion: "2.11.2",
      latestVersion: null,
      latestTag: null,
      releaseUrl: null,
      hasUpdate: false,
    });
  });
});
