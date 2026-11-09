import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "./route";

const mocks = vi.hoisted(() => ({
  admin: vi.fn(),
  fetchLatest: vi.fn(),
  readStatus: vi.fn(),
  requestUpdate: vi.fn(),
  SelfUpdateError: class SelfUpdateError extends Error {
    code: string;
    status: number;
    constructor(code: string, status: number, message: string) {
      super(message);
      this.code = code;
      this.status = status;
    }
  },
}));

vi.mock("@local/lib/api-auth", () => ({ withCurrentAdmin: mocks.admin }));
vi.mock("@local/lib/self-update", () => ({
  fetchLatestRelease: mocks.fetchLatest,
  readUpdateStatus: mocks.readStatus,
  requestSelfUpdate: mocks.requestUpdate,
  SelfUpdateError: mocks.SelfUpdateError,
}));

const latest = {
  currentVersion: "2.11.2",
  latestVersion: "2.11.3",
  latestTag: "v2.11.3",
  releaseUrl: "https://github.com/Jinyinghui/subboost/releases/tag/v2.11.3",
  hasUpdate: true,
};

const idleStatus = {
  state: "idle",
  requestedAt: null,
  requestedBy: null,
  targetVersion: null,
  startedAt: null,
  finishedAt: null,
  message: null,
  logTail: null,
};

describe("local system update route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.admin.mockImplementation((handler: (admin: { id: string }) => unknown) =>
      handler({ id: "admin-1" })
    );
    mocks.fetchLatest.mockResolvedValue(latest);
    mocks.readStatus.mockReturnValue({ watcherEnabled: true, status: idleStatus });
    mocks.requestUpdate.mockReturnValue({ ...idleStatus, state: "requested", targetVersion: "2.11.3" });
  });

  it("returns the latest release and watcher status to the admin", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ...latest,
      watcherEnabled: true,
      status: idleStatus,
    });
    expect(mocks.fetchLatest).toHaveBeenCalledWith({ fresh: true });
  });

  it("requests an update for the latest version and returns 202", async () => {
    const request = new Request("http://local.subboost.test/api/system/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetVersion: "2.11.3" }),
    });
    const response = await POST(request);
    expect(response.status).toBe(202);
    expect(mocks.requestUpdate).toHaveBeenCalledWith("admin-1", "2.11.3");
  });

  it("maps a concurrent update to 409", async () => {
    mocks.requestUpdate.mockImplementation(() => {
      throw new mocks.SelfUpdateError("CONFLICT", 409, "已有更新正在进行，请稍后再试。");
    });
    const request = new Request("http://local.subboost.test/api/system/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetVersion: "2.11.3" }),
    });
    const response = await POST(request);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "CONFLICT" });
  });

  it("maps a missing watcher to 503", async () => {
    mocks.requestUpdate.mockImplementation(() => {
      throw new mocks.SelfUpdateError(
        "CONFIGURATION_ERROR",
        503,
        "站内更新未启用：更新服务未安装，请先在服务器执行一次 subboost update。"
      );
    });
    const request = new Request("http://local.subboost.test/api/system/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetVersion: "2.11.3" }),
    });
    const response = await POST(request);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: "CONFIGURATION_ERROR" });
  });
});
