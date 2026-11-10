import { describe, expect, it } from "vitest";
import type { CustomProxyGroup } from "@subboost/core/types/config";
import {
  buildCountryGroupDraft,
  isCountryProxyGroup,
  matchRegionForCountryName,
  resolveCountryExpressionPatch,
  resolveCountryGroupExpression,
} from "./country-groups";

function group(overrides: Partial<CustomProxyGroup>): CustomProxyGroup {
  return {
    id: "g1",
    name: "🇭🇰 香港节点",
    emoji: "",
    groupType: "url-test",
    includeInGroupMembers: true,
    ...overrides,
  } as CustomProxyGroup;
}

describe("country-groups", () => {
  it("treats url-test groups with regions or a custom expression as country groups", () => {
    expect(isCountryProxyGroup(group({ advanced: { regions: ["hk"] } }))).toBe(true);
    expect(isCountryProxyGroup(group({ advanced: { includeRegex: "(?i)泰国" } }))).toBe(true);
    expect(
      isCountryProxyGroup(group({ advanced: { includeRegex: "(?i)泰国" }, memberSource: undefined })),
    ).toBe(true);
    expect(isCountryProxyGroup(group({ advanced: {} }))).toBe(false);
    expect(isCountryProxyGroup(group({ groupType: "select", advanced: { regions: ["hk"] } }))).toBe(false);
    expect(isCountryProxyGroup(group({ groupType: "select", advanced: { providerOnly: true } }))).toBe(false);
  });

  it("resolves the effective expression from the custom expression first, then regions", () => {
    expect(resolveCountryGroupExpression(group({ advanced: { regions: ["hk"] } }))).toBe(
      "(?i)港|hk|hongkong|hong kong",
    );
    expect(
      resolveCountryGroupExpression(
        group({ advanced: { regions: ["hk"], includeRegex: "(?i)港|hk" } }),
      ),
    ).toBe("(?i)港|hk");
    expect(resolveCountryGroupExpression(group({ advanced: {} }))).toBe("");
    expect(resolveCountryGroupExpression(group({ advanced: { regions: ["uk"] } }))).toBe(
      "(?i)英|uk|united kingdom|great britain",
    );
    expect(resolveCountryGroupExpression(group({ advanced: { regions: ["nl"] } }))).toBe(
      "(?i)荷|nl|netherlands",
    );
  });

  it("clears the custom expression when the edited value is empty or equals the derived one", () => {
    const hk = group({ advanced: { regions: ["hk"] } });
    expect(resolveCountryExpressionPatch(hk, "")).toEqual({ includeRegex: undefined });
    expect(resolveCountryExpressionPatch(hk, "(?i)港|hk|hongkong|hong kong")).toEqual({
      includeRegex: undefined,
    });
    expect(resolveCountryExpressionPatch(hk, "(?i)港|hk")).toEqual({ includeRegex: "(?i)港|hk" });
    // 没有地区时：派生为空，任意非空输入都直接保存为自定义表达式
    const bare = group({ advanced: {} });
    expect(resolveCountryExpressionPatch(bare, "(?i)泰国")).toEqual({ includeRegex: "(?i)泰国" });
    expect(resolveCountryExpressionPatch(bare, "")).toEqual({ includeRegex: undefined });
  });

  it("matches a region by label or keyword", () => {
    expect(matchRegionForCountryName("英国")).toBe("uk");
    expect(matchRegionForCountryName("英国节点")).toBe("uk");
    expect(matchRegionForCountryName("UK")).toBe("uk");
    expect(matchRegionForCountryName("France")).toBe("fr");
    expect(matchRegionForCountryName("伦敦")).toBe("uk");
    expect(matchRegionForCountryName("美国")).toBe("us");
    expect(matchRegionForCountryName("泰国")).toBe("th");
    expect(matchRegionForCountryName("越南")).toBe("vn");
    expect(matchRegionForCountryName("毛里求斯")).toBe(null);
    expect(matchRegionForCountryName("")).toBe(null);
    expect(matchRegionForCountryName("节点")).toBe(null);
  });

  it("builds a draft from a known region with its preset name and regions", () => {
    expect(buildCountryGroupDraft("英国")).toEqual({
      name: "🇬🇧 英国节点",
      emoji: "",
      memberSource: "filtered-nodes",
      includeInGroupMembers: true,
      groupType: "url-test",
      advanced: { regions: ["uk"] },
    });
    expect(buildCountryGroupDraft("美国")).toEqual(
      expect.objectContaining({
        name: "🇺🇲 美国节点",
        advanced: { regions: ["us"], tolerance: 150 },
      }),
    );
    // 名字以本地配置原文为准：台湾用 🇨🇳、新加坡用“狮城节点”，与地区预设不同
    expect(buildCountryGroupDraft("台湾")).toEqual(
      expect.objectContaining({ name: "🇨🇳 台湾节点", advanced: { regions: ["tw"] } }),
    );
    expect(buildCountryGroupDraft("新加坡")).toEqual(
      expect.objectContaining({ name: "🇸🇬 狮城节点", advanced: { regions: ["sg"] } }),
    );
  });

  it("builds a draft from an unknown name with an auto-generated expression", () => {
    expect(buildCountryGroupDraft("毛里求斯")).toEqual({
      name: "毛里求斯节点",
      emoji: "",
      memberSource: "filtered-nodes",
      includeInGroupMembers: true,
      groupType: "url-test",
      advanced: { includeRegex: "(?i)毛里求斯" },
    });
    expect(buildCountryGroupDraft("Mauritius")).toEqual(
      expect.objectContaining({
        name: "Mauritius节点",
        advanced: { includeRegex: "(?i)Mauritius" },
      }),
    );
    expect(buildCountryGroupDraft("  ")).toBe(null);
  });

  it("falls back to the region preset name when no preset group exists for the region", () => {
    // “其他”能匹配到地区但没有对应的预置分组：走回退名，不带容差
    expect(buildCountryGroupDraft("其他")).toEqual({
      name: "🌐 其他节点",
      emoji: "",
      memberSource: "filtered-nodes",
      includeInGroupMembers: true,
      groupType: "url-test",
      advanced: { regions: ["other"] },
    });
  });
});
