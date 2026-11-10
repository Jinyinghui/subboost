import { describe, expect, it } from "vitest";
import type { CustomProxyGroup } from "@subboost/core/types/config";
import type { ParsedNode } from "@subboost/core/types/node";
import { DEFAULT_COUNTRY_PROXY_GROUPS } from "./definitions";
import { syncCountryGroupsWithNodes } from "./country-groups-sync";
import {
  buildCountryGroupDraftForRegion,
  resolveCountryGroupRegion,
} from "@subboost/ui/product/converter/advanced-mode/sections/country-groups";

function node(name: string): ParsedNode {
  return { name } as ParsedNode;
}

function countryGroup(id: string, overrides: Partial<CustomProxyGroup> = {}): CustomProxyGroup {
  const preset = DEFAULT_COUNTRY_PROXY_GROUPS.find((group) => group.id === id)!;
  return { ...preset, ...overrides };
}

describe("syncCountryGroupsWithNodes", () => {
  it("enables groups with nodes and disables the rest", () => {
    const groups = DEFAULT_COUNTRY_PROXY_GROUPS.map((group) => ({ ...group }));
    const next = syncCountryGroupsWithNodes(groups, [node("香港-01"), node("日本-02")]);
    expect(next).not.toBe(groups);
    expect(next.find((group) => group.id === "hk")?.enabled).not.toBe(false);
    expect(next.find((group) => group.id === "jp")?.enabled).not.toBe(false);
    expect(next.find((group) => group.id === "us")?.enabled).toBe(false);
    expect(next.find((group) => group.id === "nl")?.enabled).toBe(false);
  });

  it("re-enables a previously disabled group when nodes appear", () => {
    const groups = DEFAULT_COUNTRY_PROXY_GROUPS.map((group) =>
      group.id === "us" ? { ...group, enabled: false } : { ...group },
    );
    const next = syncCountryGroupsWithNodes(groups, [node("美国-01")]);
    expect(next.find((group) => group.id === "us")?.enabled).toBe(true);
    expect(next.find((group) => group.id === "hk")?.enabled).toBe(false);
  });

  it("auto-adds a country that has nodes but no group", () => {
    const groups = DEFAULT_COUNTRY_PROXY_GROUPS.map((group) => ({ ...group }));
    const next = syncCountryGroupsWithNodes(groups, [node("香港-01"), node("印度-01")]);
    const added = next.find((group) => group.id === "in");
    expect(added).toBeDefined();
    expect(added?.name).toBe("🇮🇳 印度节点");
    expect(added?.groupType).toBe("url-test");
    expect(added?.memberSource).toBe("filtered-nodes");
    expect(added?.includeInGroupMembers).toBe(true);
    expect(added?.enabled).not.toBe(false);
  });

  it("re-adds a deleted preset with its preset name and tolerance", () => {
    const groups = DEFAULT_COUNTRY_PROXY_GROUPS.filter((group) => group.id !== "us").map(
      (group) => ({ ...group }),
    );
    const next = syncCountryGroupsWithNodes(groups, [node("美国-01")]);
    const added = next.find((group) => group.id === "us");
    expect(added?.name).toBe("🇺🇲 美国节点");
    expect(added?.advanced?.tolerance).toBe(150);
  });

  it("leaves non-country groups untouched", () => {
    const manual: CustomProxyGroup = {
      id: "custom-manual",
      name: "手动切换",
      emoji: "",
      groupType: "select",
    };
    const groups = [...DEFAULT_COUNTRY_PROXY_GROUPS.map((group) => ({ ...group })), manual];
    const next = syncCountryGroupsWithNodes(groups, [node("香港-01")]);
    expect(next.find((group) => group.id === "custom-manual")).toEqual(manual);
  });

  it("returns the same array when nothing changes", () => {
    const groups = [
      countryGroup("hk"),
      { ...countryGroup("us"), enabled: false },
    ];
    const next = syncCountryGroupsWithNodes(groups, [node("香港-01")]);
    expect(next).toBe(groups);
  });

  it("ignores nodes without any country information and info nodes", () => {
    const groups = DEFAULT_COUNTRY_PROXY_GROUPS.map((group) => ({ ...group }));
    const next = syncCountryGroupsWithNodes(groups, [
      node("Hello-01"),
      node("剩余流量：100GB"),
    ]);
    expect(next).toHaveLength(DEFAULT_COUNTRY_PROXY_GROUPS.length);
    expect(next.every((group) => group.enabled === false)).toBe(true);
  });

  it("disables every country group when the node list is empty", () => {
    const groups = DEFAULT_COUNTRY_PROXY_GROUPS.map((group) => ({ ...group }));
    const next = syncCountryGroupsWithNodes(groups, []);
    expect(next.every((group) => group.enabled === false)).toBe(true);
  });

  it("leaves a country group alone when its country cannot be resolved", () => {
    const unknown: CustomProxyGroup = {
      id: "custom-unknown",
      name: "自定义分组",
      emoji: "",
      groupType: "url-test",
      advanced: { includeRegex: "(?i)zzz" },
    };
    const groups = [...DEFAULT_COUNTRY_PROXY_GROUPS.map((group) => ({ ...group })), unknown];
    const next = syncCountryGroupsWithNodes(groups, [node("香港-01")]);
    expect(next.find((group) => group.id === "custom-unknown")).toEqual(unknown);
  });

  it("resolves a group's country from its custom expression", () => {
    const group: CustomProxyGroup = {
      id: "custom-expr",
      name: "自定义分组",
      emoji: "",
      groupType: "url-test",
      advanced: { includeRegex: "(?i)港|hk|hongkong|hong kong" },
    };
    expect(resolveCountryGroupRegion(group)).toBe("hk");
    const groups = [...DEFAULT_COUNTRY_PROXY_GROUPS.map((item) => ({ ...item })), group];
    const next = syncCountryGroupsWithNodes(groups, [node("香港-01")]);
    expect(next.find((item) => item.id === "custom-expr")?.enabled).not.toBe(false);
    const disabled = syncCountryGroupsWithNodes(groups, [node("日本-01")]);
    expect(disabled.find((item) => item.id === "custom-expr")?.enabled).toBe(false);
  });

  it("builds no draft for the other region", () => {
    expect(buildCountryGroupDraftForRegion("other")).toBeNull();
    expect(buildCountryGroupDraftForRegion("xx" as unknown as never)).toBeNull();
  });

  it("falls back to a prefixed id when the region id is taken", () => {
    const squatter: CustomProxyGroup = {
      id: "in",
      name: "印度专线",
      emoji: "",
      groupType: "select",
    };
    const groups = [...DEFAULT_COUNTRY_PROXY_GROUPS.map((group) => ({ ...group })), squatter];
    const next = syncCountryGroupsWithNodes(groups, [node("印度-01")]);
    const added = next.find((group) => group.name === "🇮🇳 印度节点");
    expect(added?.id).toBe("country-in");
    expect(next.find((group) => group.id === "in")).toEqual(squatter);
  });
});
