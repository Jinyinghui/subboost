import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET, PATCH } from "./route";

const mocks = vi.hoisted(() => ({
  admin: vi.fn(),
  readSetting: vi.fn(),
  writeSetting: vi.fn(),
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
  readAutoUpdateSetting: mocks.readSetting,
  writeAutoUpdateSetting: mocks.writeSetting,
  SelfUpdateError: mocks.SelfUpdateError,
}));

function patchRequest(body?: unknown) {
  return new Request("http://local.subboost.test/api/system/update/auto-update", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("local system update auto-update route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.admin.mockImplementation((handler: (admin: { id: string }) => unknown) =>
      handler({ id: "admin-1" })
    );
    mocks.readSetting.mockReturnValue(false);
    mocks.writeSetting.mockImplementation((enabled: boolean) => enabled);
  });

  it("returns the current setting", async () => {
    mocks.readSetting.mockReturnValue(true);
    const response = await GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ enabled: true });
  });

  it("saves the setting and returns it", async () => {
    const response = await PATCH(patchRequest({ enabled: true }));
    expect(response.status).toBe(200);
    expect(mocks.writeSetting).toHaveBeenCalledWith(true);
    await expect(response.json()).resolves.toEqual({ enabled: true });
  });

  it("rejects a non-boolean setting", async () => {
    const response = await PATCH(patchRequest({ enabled: "yes" }));
    expect(response.status).toBe(400);
    expect(mocks.writeSetting).not.toHaveBeenCalled();
  });

  it("rejects a malformed JSON body", async () => {
    const request = new Request("http://local.subboost.test/api/system/update/auto-update", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    const response = await PATCH(request);
    expect(response.status).toBe(400);
    expect(mocks.writeSetting).not.toHaveBeenCalled();
  });

  it("rejects a JSON array body", async () => {
    const response = await PATCH(patchRequest([true]));
    expect(response.status).toBe(400);
    expect(mocks.writeSetting).not.toHaveBeenCalled();
  });

  it("maps a missing ops directory to 503", async () => {
    mocks.writeSetting.mockImplementation(() => {
      throw new mocks.SelfUpdateError("CONFIGURATION_ERROR", 503, "更新服务目录不存在");
    });
    const response = await PATCH(patchRequest({ enabled: true }));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: "CONFIGURATION_ERROR" });
  });

  it("rethrows unexpected errors from the setting write", async () => {
    mocks.writeSetting.mockImplementation(() => {
      throw new Error("boom");
    });
    await expect(PATCH(patchRequest({ enabled: true }))).rejects.toThrow("boom");
  });
});
