import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CustomProxyGroup } from "@subboost/core/types/config";

const mocks = vi.hoisted(() => ({
  newCountryName: "",
  store: {} as Record<string, any>,
  toast: vi.fn(),
  confirmDialog: vi.fn(),
  interactions: { proxyGroupAdded: vi.fn() },
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useCallback: (callback: unknown) => callback,
    useMemo: (factory: () => unknown) => factory(),
    useState: (initial: unknown) => {
      const setter = (value: unknown) => {
        mocks.newCountryName =
          typeof value === "function"
            ? (value as (prev: unknown) => unknown)(mocks.newCountryName)
            : value;
      };
      return [mocks.newCountryName ?? initial, setter];
    },
  };
});

vi.mock("lucide-react", () => ({
  Plus: () => React.createElement("span", null, "plus-icon"),
  Trash2: () => React.createElement("span", null, "trash-icon"),
}));

vi.mock("@subboost/ui/components/ui/confirm-dialog", () => ({
  confirmDialog: mocks.confirmDialog,
}));

vi.mock("@subboost/ui/components/ui/badge", () => ({
  Badge: (props: any) => React.createElement("span", props, props.children),
}));

vi.mock("@subboost/ui/components/ui/button", () => ({
  Button: (props: any) => React.createElement("button", props, props.children),
}));

vi.mock("@subboost/ui/components/ui/input", () => ({
  Input: (props: any) => React.createElement("input", props),
}));

vi.mock("@subboost/ui/components/ui/toaster", () => ({
  toast: mocks.toast,
}));

vi.mock("@subboost/core/generator/proxy-groups", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@subboost/core/generator/proxy-groups")>();
  return {
    ...actual,
    PROXY_GROUP_MODULES: [
      { id: "select", name: "Select", rules: [] },
      { id: "auto", name: "Auto", rules: [] },
    ],
  };
});

vi.mock("@subboost/core/proxy-group-name", () => ({
  resolveProxyGroupModuleName: (module: { id: string; name: string }, override?: string) =>
    override || module.name,
}));

vi.mock("@subboost/ui/store/config-store", () => ({
  useConfigStore: () => mocks.store,
}));

vi.mock("@subboost/ui/product/interactions", () => ({
  useProductInteractionAdapter: () => mocks.interactions,
}));

import { CountryGroupsSection } from "./country-groups-section";

type TestElement = React.ReactElement<Record<string, any>>;

function flattenElements(value: React.ReactNode): TestElement[] {
  const out: TestElement[] = [];
  const visit = (item: React.ReactNode): void => {
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    if (!React.isValidElement(item)) return;
    if (typeof item.type === "function") {
      visit((item.type as (props: unknown) => React.ReactNode)(item.props));
      return;
    }
    out.push(item as TestElement);
    visit((item.props as { children?: React.ReactNode }).children);
  };
  visit(value);
  return out;
}

function countryGroup(overrides: Partial<CustomProxyGroup>): CustomProxyGroup {
  return {
    id: "hk",
    name: "🇭🇰 香港节点",
    emoji: "",
    memberSource: "filtered-nodes",
    includeInGroupMembers: true,
    groupType: "url-test",
    advanced: { regions: ["hk"] },
    ...overrides,
  } as CustomProxyGroup;
}

describe("CountryGroupsSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.newCountryName = "";
    mocks.confirmDialog.mockResolvedValue(true);
    mocks.store = {
      customProxyGroups: [
        countryGroup({}),
        countryGroup({
          id: "th",
          name: "泰国节点",
          advanced: { includeRegex: "(?i)泰国|thailand" },
        }),
        {
          id: "manual",
          name: "🚀 手动切换",
          emoji: "",
          groupType: "select",
          includeInGroupMembers: false,
          advanced: { providerOnly: true },
        },
      ],
      dialerProxyGroups: [],
      proxyGroupNameOverrides: {},
      groupListeners: [],
      addCustomProxyGroup: vi.fn(),
      removeCustomProxyGroup: vi.fn(),
      updateCustomProxyGroup: vi.fn(),
    };
  });

  it("lists country groups with their effective expressions and skips other groups", () => {
    const elements = flattenElements(CountryGroupsSection());
    const nameLabels = elements.filter(
      (element) =>
        element.type === "div" &&
        (element.props.title === "🇭🇰 香港节点" || element.props.title === "泰国节点"),
    );
    expect(nameLabels).toHaveLength(2);
    const manualLabel = elements.find(
      (element) => element.type === "div" && element.props.title === "🚀 手动切换",
    );
    expect(manualLabel).toBeUndefined();
    const expressionInputs = elements.filter(
      (element) =>
        element.type === "input" &&
        typeof element.props.title === "string" &&
        element.props.title.endsWith("的筛选表达式"),
    );
    expect(expressionInputs.map((input) => input.props.value)).toEqual([
      "(?i)港|hk|hongkong|hong kong",
      "(?i)泰国|thailand",
    ]);
  });

  it("writes a custom expression inline and clears it back to the derived one", () => {
    const elements = flattenElements(CountryGroupsSection());
    const hkInput = elements.find(
      (element) => element.type === "input" && element.props.title === "🇭🇰 香港节点 的筛选表达式",
    );
    hkInput?.props.onChange({ target: { value: "(?i)港|hk" } });
    expect(mocks.store.updateCustomProxyGroup).toHaveBeenCalledWith(
      "hk",
      expect.objectContaining({
        advanced: expect.objectContaining({ includeRegex: "(?i)港|hk" }),
      }),
    );

    vi.clearAllMocks();
    const next = flattenElements(CountryGroupsSection());
    const hkInputAgain = next.find(
      (element) => element.type === "input" && element.props.title === "🇭🇰 香港节点 的筛选表达式",
    );
    hkInputAgain?.props.onChange({ target: { value: "" } });
    expect(mocks.store.updateCustomProxyGroup).toHaveBeenCalledWith(
      "hk",
      expect.objectContaining({
        advanced: expect.objectContaining({ includeRegex: undefined }),
      }),
    );
  });

  it("adds a known country with its preset draft and an unknown one with an auto-generated expression", () => {
    let elements = flattenElements(CountryGroupsSection());
    const addInput = elements.find(
      (element) => element.type === "input" && element.props.placeholder?.includes("国家名称"),
    );
    const addButton = elements.find(
      (element) => element.type === "button" && element.props.title === "添加国家",
    );

    addInput?.props.onChange({ target: { value: "英国" } });
    elements = flattenElements(CountryGroupsSection());
    elements
      .find((element) => element.type === "button" && element.props.title === "添加国家")
      ?.props.onClick();
    expect(mocks.store.addCustomProxyGroup).toHaveBeenCalledWith(
      expect.objectContaining({ name: "🇬🇧 英国节点", advanced: { regions: ["uk"] } }),
    );

    vi.clearAllMocks();
    addInput?.props.onChange({ target: { value: "越南" } });
    elements = flattenElements(CountryGroupsSection());
    elements
      .find((element) => element.type === "button" && element.props.title === "添加国家")
      ?.props.onClick();
    expect(mocks.store.addCustomProxyGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "越南节点",
        advanced: { includeRegex: "(?i)越南" },
      }),
    );
    expect(addButton).toBeDefined();
  });

  it("warns on a duplicate country name instead of adding", () => {
    const elements = flattenElements(CountryGroupsSection());
    const addInput = elements.find(
      (element) => element.type === "input" && element.props.placeholder?.includes("国家名称"),
    );
    addInput?.props.onChange({ target: { value: "香港" } });
    const next = flattenElements(CountryGroupsSection());
    next
      .find((element) => element.type === "button" && element.props.title === "添加国家")
      ?.props.onClick();
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringContaining("已存在") }),
    );
    expect(mocks.store.addCustomProxyGroup).not.toHaveBeenCalled();
  });

  it("deletes a country group directly when it has no listener", async () => {
    const elements = flattenElements(CountryGroupsSection());
    const deleteButton = elements.find(
      (element) => element.type === "button" && element.props["aria-label"] === "删除 🇭🇰 香港节点",
    );
    await deleteButton?.props.onClick();
    expect(mocks.store.removeCustomProxyGroup).toHaveBeenCalledWith("hk");
  });

  it("asks for confirmation when the group has a listener binding", async () => {
    mocks.store.groupListeners = [
      { target: { kind: "custom", id: "hk" }, port: 7890, enabled: true, allowLan: false },
    ];
    mocks.confirmDialog.mockResolvedValueOnce(true);
    let elements = flattenElements(CountryGroupsSection());
    let deleteButton = elements.find(
      (element) => element.type === "button" && element.props["aria-label"] === "删除 🇭🇰 香港节点",
    );
    await deleteButton?.props.onClick();
    expect(mocks.confirmDialog).toHaveBeenCalledWith(
      expect.objectContaining({ title: "确认删除「🇭🇰 香港节点」？" }),
    );
    expect(mocks.store.removeCustomProxyGroup).toHaveBeenCalledWith("hk");

    vi.clearAllMocks();
    mocks.confirmDialog.mockResolvedValueOnce(false);
    elements = flattenElements(CountryGroupsSection());
    deleteButton = elements.find(
      (element) => element.type === "button" && element.props["aria-label"] === "删除 🇭🇰 香港节点",
    );
    await deleteButton?.props.onClick();
    expect(mocks.store.removeCustomProxyGroup).not.toHaveBeenCalled();
  });

  it("adds on Enter, ignores other keys, and ignores an empty name", () => {
    let elements = flattenElements(CountryGroupsSection());
    const addInput = elements.find(
      (element) => element.type === "input" && element.props.placeholder?.includes("国家名称"),
    );
    const addButton = elements.find(
      (element) => element.type === "button" && element.props.title === "添加国家",
    );

    addButton?.props.onClick();
    expect(mocks.store.addCustomProxyGroup).not.toHaveBeenCalled();

    addInput?.props.onChange({ target: { value: "越南" } });
    elements = flattenElements(CountryGroupsSection());
    elements
      .find((element) => element.type === "input" && element.props.placeholder?.includes("国家名称"))
      ?.props.onKeyDown({ key: "a" });
    expect(mocks.store.addCustomProxyGroup).not.toHaveBeenCalled();

    elements
      .find((element) => element.type === "input" && element.props.placeholder?.includes("国家名称"))
      ?.props.onKeyDown({ key: "Enter" });
    expect(mocks.store.addCustomProxyGroup).toHaveBeenCalledWith(
      expect.objectContaining({ name: "越南节点" }),
    );
  });

  it("counts dialer group names when checking duplicates", () => {
    mocks.store.dialerProxyGroups = [null, { name: "  " }, { name: "越南节点" }];
    const elements = flattenElements(CountryGroupsSection());
    const addInput = elements.find(
      (element) => element.type === "input" && element.props.placeholder?.includes("国家名称"),
    );
    addInput?.props.onChange({ target: { value: "越南" } });
    const next = flattenElements(CountryGroupsSection());
    next
      .find((element) => element.type === "button" && element.props.title === "添加国家")
      ?.props.onClick();
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringContaining("已存在") }),
    );
    expect(mocks.store.addCustomProxyGroup).not.toHaveBeenCalled();
  });

  it("shows an empty state when there are no country groups", () => {
    mocks.store.customProxyGroups = [
      {
        id: "manual",
        name: "🚀 手动切换",
        emoji: "",
        groupType: "select",
        includeInGroupMembers: false,
        advanced: { providerOnly: true },
      },
    ];
    const elements = flattenElements(CountryGroupsSection());
    const emptyState = elements.find(
      (element) =>
        element.type === "div" &&
        typeof element.props.children === "string" &&
        element.props.children.includes("暂无国家分组"),
    );
    expect(emptyState).toBeDefined();
    const expressionInputs = elements.filter(
      (element) =>
        element.type === "input" &&
        typeof element.props.title === "string" &&
        element.props.title.endsWith("的筛选表达式"),
    );
    expect(expressionInputs).toHaveLength(0);
  });
});
