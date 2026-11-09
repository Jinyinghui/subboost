import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildDefaultSubBoostTemplateConfig: vi.fn(),
  builtinIdToType: vi.fn(),
  getBuiltinTemplateId: vi.fn(),
  getBuiltinTemplateSummaryMetadata: vi.fn(),
  getTemplateList: vi.fn(),
  validateSubBoostTemplateConfig: vi.fn(),
  decryptJsonObject: vi.fn(),
  encryptJson: vi.fn(),
  prisma: {
    localTemplate: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

vi.mock("@subboost/core/config/defaults", () => ({
  buildDefaultSubBoostTemplateConfig: mocks.buildDefaultSubBoostTemplateConfig,
}));
vi.mock("@subboost/core/templates/builtin", () => ({
  builtinIdToType: mocks.builtinIdToType,
  getBuiltinTemplateId: mocks.getBuiltinTemplateId,
  getBuiltinTemplateSummaryMetadata: mocks.getBuiltinTemplateSummaryMetadata,
}));
vi.mock("@subboost/core/templates", () => ({ getTemplateList: mocks.getTemplateList }));
vi.mock("@subboost/core/templates/config-template", () => ({
  validateSubBoostTemplateConfig: mocks.validateSubBoostTemplateConfig,
}));
vi.mock("./crypto", () => ({
  decryptJsonObject: mocks.decryptJsonObject,
  encryptJson: mocks.encryptJson,
}));
vi.mock("./prisma", () => ({ prisma: mocks.prisma }));

import { createTemplate, deleteTemplate, getTemplateDetail, listTemplates } from "./template-service";

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "local-1",
    ownerId: "owner-1",
    name: "Local Template",
    description: "desc",
    encryptedConfig: "encrypted",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    ...overrides,
  };
}

describe("local template service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getTemplateList.mockReturnValue([
      { id: "minimal", name: "Minimal", description: "small", groupCount: 1, ruleCount: 2 },
      { id: "standard", name: "Standard", description: "normal", groupCount: 3, ruleCount: 4 },
    ]);
    mocks.getBuiltinTemplateId.mockImplementation((id: string) => `builtin-${id}`);
    mocks.getBuiltinTemplateSummaryMetadata.mockReturnValue({
      downloads: 0,
      engagementCount: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      tags: ["官方"],
      isOfficial: true,
      isPublic: true,
    });
    mocks.builtinIdToType.mockImplementation((id: string) => {
      if (id === "builtin-minimal") return "minimal";
      return null;
    });
    mocks.buildDefaultSubBoostTemplateConfig.mockReturnValue({ template: "minimal" });
    mocks.decryptJsonObject.mockReturnValue({ enabledProxyGroups: ["ad", "private"], ruleOrder: [] });
    mocks.encryptJson.mockReturnValue("encrypted-new");
    mocks.validateSubBoostTemplateConfig.mockReturnValue({ ok: true, config: { rules: [] } });
  });

  it("lists built-in templates and owner templates", async () => {
    await expect(listTemplates(null, "default", ["builtin-standard"])).resolves.toEqual([
      expect.objectContaining({
        id: "builtin-standard",
        name: "Standard",
        proxyGroupCount: 3,
        ruleCount: 4,
        isOfficial: true,
      }),
    ]);

    await expect(listTemplates(null, "my")).rejects.toThrow("Authentication required.");

    mocks.prisma.localTemplate.findMany.mockResolvedValueOnce([row()]);
    await expect(listTemplates("owner-1", "my", ["local-1"])).resolves.toEqual([
      {
        id: "local-1",
        name: "Local Template",
        description: "desc",
        downloads: 0,
        engagementCount: 0,
        createdAt: "2026-01-01T00:00:00.000Z",
        tags: ["本地"],
        isOfficial: false,
        isPublic: false,
        isOwner: true,
        proxyGroupCount: 2,
        ruleCount: 3,
      },
    ]);
    expect(mocks.prisma.localTemplate.findMany).toHaveBeenCalledWith({
      where: { ownerId: "owner-1", id: { in: ["local-1"] } },
      orderBy: { updatedAt: "desc" },
    });
  });

  it("loads built-in and local template details", async () => {
    await expect(getTemplateDetail(null, "builtin-minimal")).resolves.toEqual({
      id: "builtin-minimal",
      name: "Minimal",
      description: "small",
      kind: "config",
      config: { template: "minimal" },
    });

    await expect(getTemplateDetail(null, "local-1")).rejects.toThrow("Authentication required.");

    mocks.prisma.localTemplate.findFirst.mockResolvedValueOnce(row({ description: null }));
    await expect(getTemplateDetail("owner-1", "local-1")).resolves.toEqual({
      id: "local-1",
      name: "Local Template",
      description: "",
      kind: "config",
      config: { enabledProxyGroups: ["ad", "private"], ruleOrder: [] },
    });

    mocks.prisma.localTemplate.findFirst.mockResolvedValueOnce(null);
    await expect(getTemplateDetail("owner-1", "missing")).resolves.toBeNull();
  });

  it("counts rules from enabled groups and custom entries even when ruleOrder is empty", async () => {
    mocks.decryptJsonObject.mockReturnValueOnce({
      enabledProxyGroups: ["ad", "private", "cn"],
      hiddenProxyGroups: ["private"],
      customRules: [
        { id: "r1", type: "domain", value: "example.com", target: "select" },
        { id: "r2", type: "domain", value: "example.org", target: "select" },
      ],
      customRuleSets: [
        { id: "rs1", name: "RS", format: "mrs", behavior: "domain", path: "geosite/test.mrs", target: "select" },
      ],
      ruleOrder: [],
    });
    mocks.prisma.localTemplate.findMany.mockResolvedValueOnce([row()]);
    await expect(listTemplates("owner-1", "my")).resolves.toEqual([
      expect.objectContaining({
        id: "local-1",
        proxyGroupCount: 3,
        // ad(1) + cn(2) + custom rules(2) + custom rule sets(1); hidden private(2) excluded.
        ruleCount: 6,
      }),
    ]);
  });

  it("creates validated local templates and rejects invalid payloads", async () => {
    await expect(createTemplate("owner-1", null)).rejects.toThrow("Invalid request body.");
    await expect(createTemplate("owner-1", { name: "", config: {} })).rejects.toThrow("Invalid name.");

    mocks.validateSubBoostTemplateConfig.mockReturnValueOnce({ ok: false, error: "bad config" });
    await expect(createTemplate("owner-1", { name: "Template", config: {} })).rejects.toThrow("bad config");

    mocks.prisma.localTemplate.create.mockResolvedValueOnce(row({ name: "Template", description: "saved" }));
    await expect(
      createTemplate("owner-1", {
        name: " Template ",
        description: ` ${"x".repeat(600)} `,
        config: { rules: [] },
      })
    ).resolves.toEqual(
      expect.objectContaining({
        id: "local-1",
        name: "Template",
        description: "saved",
      })
    );
    expect(mocks.prisma.localTemplate.create).toHaveBeenCalledWith({
      data: {
        ownerId: "owner-1",
        name: "Template",
        description: "x".repeat(500),
        encryptedConfig: "encrypted-new",
      },
    });
  });

  it("deletes only templates owned by the current user", async () => {
    mocks.prisma.localTemplate.findFirst.mockResolvedValueOnce(null);
    await expect(deleteTemplate("owner-1", "missing")).resolves.toBe(false);

    mocks.prisma.localTemplate.findFirst.mockResolvedValueOnce({ id: "local-1" });
    mocks.prisma.localTemplate.delete.mockResolvedValueOnce(row());
    await expect(deleteTemplate("owner-1", "local-1")).resolves.toBe(true);
    expect(mocks.prisma.localTemplate.delete).toHaveBeenCalledWith({ where: { id: "local-1" } });
  });
});
