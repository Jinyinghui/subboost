import { describe, expect, it } from "vitest";
import { configToYaml } from "@subboost/core/generator/yaml";
import { generateProxyGroups } from "@subboost/core/generator/proxy-groups";
import {
  buildRegionFilterRegex,
  normalizeProxyGroupAdvancedConfig,
  resolveProviderFilterFields,
} from "@subboost/core/proxy-group-advanced";
import type { CustomProxyGroup, NodeRegion } from "@subboost/core/types/config";
import type { ParsedNode } from "@subboost/core/types/node";

function countryGroup(id: string, name: string, regions: NodeRegion[], tolerance?: number): CustomProxyGroup {
  return {
    id,
    name,
    emoji: "",
    memberSource: "filtered-nodes",
    includeInGroupMembers: true,
    groupType: "url-test",
    advanced: {
      regions,
      // 国家分组明确挂 use:（默认不挂）；本文件的用例验证的是挂 use: 时的本地格式输出
      useProviders: true,
      ...(tolerance !== undefined ? { tolerance } : {}),
    },
  };
}

describe("provider-mode local format", () => {
  it("emits country groups as use + filter with local literals and tolerance", () => {
    const groups = generateProxyGroups({
      nodes: [],
      proxyProviderNames: ["my_sub"],
      enabledModules: ["select", "auto"],
      ruleProviderBaseUrl: "https://rules.example.com",
      testUrl: "https://www.gstatic.com/generate_204",
      testInterval: 300,
      customProxyGroups: [
        countryGroup("hk", "🇭🇰 香港节点", ["hk"]),
        countryGroup("us", "🇺🇲 美国节点", ["us"], 150),
        countryGroup("tw", "🇨🇳 台湾节点", ["tw"]),
      ],
    });

    const hk = groups.find((group) => group.name === "🇭🇰 香港节点");
    expect(hk).toMatchObject({
      type: "url-test",
      use: ["my_sub"],
      filter: "(?i)港|hk|hongkong|hong kong",
      url: "https://www.gstatic.com/generate_204",
      interval: 300,
      tolerance: 50,
    });
    expect(hk).not.toHaveProperty("proxies");
    expect(hk).not.toHaveProperty("exclude-filter");

    expect(groups.find((group) => group.name === "🇺🇲 美国节点")).toMatchObject({
      type: "url-test",
      use: ["my_sub"],
      filter: "(?i)美|us|america|united states",
      tolerance: 150,
    });
    expect(groups.find((group) => group.name === "🇨🇳 台湾节点")).toMatchObject({
      type: "url-test",
      use: ["my_sub"],
      filter: "(?i)台|tw|taiwan",
      tolerance: 50,
    });
  });

  it("emits manual-switch select groups as use-only and keeps select module use-free", () => {
    const groups = generateProxyGroups({
      nodes: [],
      proxyProviderNames: ["my_sub"],
      enabledModules: ["select", "auto"],
      ruleProviderBaseUrl: "https://rules.example.com",
      testUrl: "https://www.gstatic.com/generate_204",
      testInterval: 300,
      customProxyGroups: [
        {
          id: "manual",
          name: "🚀 手动切换",
          emoji: "",
          groupType: "select",
          advanced: { providerOnly: true, useProviders: true },
        },
      ],
    });

    const manual = groups.find((group) => group.name === "🚀 手动切换");
    expect(manual).toMatchObject({ type: "select", use: ["my_sub"] });
    expect(manual).not.toHaveProperty("proxies");

    const select = groups.find((group) => group.name === "🚀 节点选择");
    expect(select).toMatchObject({ type: "select" });
    expect(select).not.toHaveProperty("use");

    const auto = groups.find((group) => group.name === "⚡ 自动选择");
    expect(auto).toMatchObject({
      type: "url-test",
      tolerance: 50,
      url: "https://www.gstatic.com/generate_204",
      interval: 300,
    });
    expect(auto).not.toHaveProperty("use");
    expect(auto).not.toHaveProperty("proxies");
  });

  it("attaches use: only when a group explicitly opts in, and honors per-group opt-out", () => {
    const groups = generateProxyGroups({
      nodes: [],
      proxyProviderNames: ["my_sub"],
      enabledModules: ["select", "auto", "ai"],
      ruleProviderBaseUrl: "https://rules.example.com",
      testUrl: "https://www.gstatic.com/generate_204",
      testInterval: 300,
      customProxyGroups: [
        { id: "plain", name: "Custom plain", emoji: "", groupType: "select" },
        {
          id: "forced",
          name: "Custom forced",
          emoji: "",
          groupType: "select",
          advanced: { useProviders: true },
        },
        {
          id: "optout",
          name: "Custom opt-out",
          emoji: "",
          groupType: "select",
          advanced: { useProviders: false },
        },
      ],
    });

    expect(groups.find((group) => group.name === "Custom plain")).not.toHaveProperty("use");
    expect(groups.find((group) => group.name === "Custom forced")).toMatchObject({ use: ["my_sub"] });
    expect(groups.find((group) => group.name === "Custom opt-out")).not.toHaveProperty("use");
    expect(groups.find((group) => group.name === "🤖 AI 服务")).not.toHaveProperty("use");
    expect(groups.find((group) => group.name === "🚀 节点选择")).not.toHaveProperty("use");
  });

  it("honors per-group opt-out of use: on node-consuming groups", () => {
    const groups = generateProxyGroups({
      nodes: [],
      proxyProviderNames: ["my_sub"],
      enabledModules: ["select", "auto"],
      ruleProviderBaseUrl: "https://rules.example.com",
      testUrl: "https://www.gstatic.com/generate_204",
      testInterval: 300,
      customProxyGroups: [
        {
          id: "optout",
          name: "Custom opt-out",
          emoji: "",
          groupType: "url-test",
          advanced: { useProviders: false },
        },
      ],
    });

    const group = groups.find((item) => item.name === "Custom opt-out");
    expect(group).toMatchObject({ type: "url-test", tolerance: 50 });
    expect(group).not.toHaveProperty("use");
    expect(group).not.toHaveProperty("filter");
  });

  it("leaves country groups without use: by default until they opt in", () => {
    const groups = generateProxyGroups({
      nodes: [],
      proxyProviderNames: ["my_sub"],
      enabledModules: ["select", "auto"],
      ruleProviderBaseUrl: "https://rules.example.com",
      testUrl: "https://www.gstatic.com/generate_204",
      testInterval: 300,
      customProxyGroups: [
        {
          id: "hk",
          name: "🇭🇰 香港节点",
          emoji: "",
          memberSource: "filtered-nodes",
          includeInGroupMembers: true,
          groupType: "url-test",
          advanced: { regions: ["hk"] },
        },
      ],
    });

    const hk = groups.find((group) => group.name === "🇭🇰 香港节点");
    expect(hk).toMatchObject({ type: "url-test", tolerance: 50 });
    expect(hk).not.toHaveProperty("use");
    expect(hk).not.toHaveProperty("filter");
  });

  it("keeps inline node members in url-test groups while filtering provider nodes", () => {
    const inlineNode: ParsedNode = {
      name: "香港 01",
      type: "ss",
      server: "hk.example.com",
      port: 8388,
      cipher: "aes-128-gcm",
      password: "secret",
    } as ParsedNode;
    const groups = generateProxyGroups({
      nodes: [inlineNode],
      proxyProviderNames: ["my_sub"],
      enabledModules: ["select", "auto"],
      ruleProviderBaseUrl: "https://rules.example.com",
      testUrl: "https://www.gstatic.com/generate_204",
      testInterval: 300,
      customProxyGroups: [countryGroup("hk", "🇭🇰 香港节点", ["hk"])],
    });

    expect(groups.find((group) => group.name === "🇭🇰 香港节点")).toMatchObject({
      type: "url-test",
      proxies: ["香港 01"],
      use: ["my_sub"],
      filter: "(?i)港|hk|hongkong|hong kong",
    });
  });

  it("serializes provider-only groups without lazy: false or empty proxies", () => {
    const groups = generateProxyGroups({
      nodes: [],
      proxyProviderNames: ["my_sub"],
      enabledModules: ["select", "auto"],
      ruleProviderBaseUrl: "https://rules.example.com",
      testUrl: "https://www.gstatic.com/generate_204",
      testInterval: 300,
      customProxyGroups: [countryGroup("hk", "🇭🇰 香港节点", ["hk"])],
    });
    const yaml = configToYaml({
      "proxy-groups": groups,
      proxies: [],
      rules: [],
    });

    expect(yaml).not.toContain("lazy:");
    expect(yaml).not.toContain("proxies: []");
    expect(yaml).toContain('filter: "(?i)港|hk|hongkong|hong kong"');
    expect(yaml).toContain("tolerance: 50");
  });
});

describe("region filter derivation", () => {
  it("uses local literals for the six local regions", () => {
    expect(buildRegionFilterRegex(["hk"])).toBe("(?i)港|hk|hongkong|hong kong");
    expect(buildRegionFilterRegex(["jp"])).toBe("(?i)日|jp|japan");
    expect(buildRegionFilterRegex(["us"])).toBe("(?i)美|us|america|united states");
    expect(buildRegionFilterRegex(["tw"])).toBe("(?i)台|tw|taiwan");
    expect(buildRegionFilterRegex(["sg"])).toBe("(?i)新|狮城|sg|singapore");
    expect(buildRegionFilterRegex(["kr"])).toBe("(?i)韩|kr|korea");
  });

  it("uses local literals for all twelve preset regions and combines them", () => {
    expect(buildRegionFilterRegex(["de"])).toBe("(?i)德|de|germany");
    expect(buildRegionFilterRegex(["ca"])).toBe("(?i)加|ca|canada");
    expect(buildRegionFilterRegex(["nl"])).toBe("(?i)荷|nl|netherlands");
    expect(buildRegionFilterRegex(["uk"])).toBe("(?i)英|uk|united kingdom|great britain");
    expect(buildRegionFilterRegex(["fr"])).toBe("(?i)法|fr|france");
    expect(buildRegionFilterRegex(["au"])).toBe("(?i)澳|au|australia");
    expect(buildRegionFilterRegex(["hk", "tw"])).toBe("(?i)港|hk|hongkong|hong kong|台|tw|taiwan");
    expect(buildRegionFilterRegex(["other"])).toBeUndefined();
    expect(buildRegionFilterRegex([])).toBeUndefined();
  });

  it("prefers includeRegex verbatim and maps excludeRegex to exclude-filter", () => {
    expect(
      resolveProviderFilterFields({ includeRegex: "(?i)港|hk", excludeRegex: "过期" }, true)
    ).toEqual({ filter: "(?i)港|hk", "exclude-filter": "过期" });
    expect(resolveProviderFilterFields({ regions: ["de"] }, true)).toEqual({
      filter: "(?i)德|de|germany",
    });
    expect(resolveProviderFilterFields({ regions: ["de"] }, false)).toEqual({});
    expect(resolveProviderFilterFields(undefined, true)).toEqual({});
  });

  it("normalizes the new advanced fields", () => {
    expect(
      normalizeProxyGroupAdvancedConfig({
        tolerance: 150,
        providerOnly: true,
        useProviders: false,
        regions: ["nl", "xx", "DE"],
      })
    ).toMatchObject({
      tolerance: 150,
      providerOnly: true,
      useProviders: false,
      regions: ["nl", "de"],
    });
    expect(normalizeProxyGroupAdvancedConfig({ tolerance: -1 })).not.toHaveProperty("tolerance");
    expect(normalizeProxyGroupAdvancedConfig({ tolerance: 1.5 })).not.toHaveProperty("tolerance");
    expect(normalizeProxyGroupAdvancedConfig({ providerOnly: "yes" })).not.toHaveProperty("providerOnly");
  });
});
