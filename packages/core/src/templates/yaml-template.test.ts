import { describe, expect, it, vi } from "vitest";
import { generateProxyGroups } from "@subboost/core/generator/proxy-groups";
import type { ParsedNode } from "@subboost/core/types/node";
import {
  convertClashYamlToTemplate,
  extractTopLevelBlock,
  splitRuleLine,
  type YamlTemplateFallbacks,
} from "./yaml-template";

const FALLBACKS: YamlTemplateFallbacks = {
  dnsYaml: "enable: true\nnameserver:\n  - 223.5.5.5\n",
  mixedPort: 7890,
  allowLan: false,
  testUrl: "http://www.gstatic.com/generate_204",
  testInterval: 300,
  ruleProviderBaseUrl: "https://rules.example.com",
};

const SAMPLE_YAML = `
mixed-port: 7891
allow-lan: true
proxies:
  - { name: "HK-01", type: ss, server: 1.2.3.4, port: 8388, cipher: aes-256-gcm, password: secret }
  - { name: "US-01", type: vmess, server: 5.6.7.8, port: 443, uuid: 00000000-0000-0000-0000-000000000000, alterId: 0, cipher: auto }
proxy-groups:
  - name: "🚀 节点选择"
    type: select
    proxies: ["HK-01", "US-01", "DIRECT"]
  - name: "香港测速"
    type: url-test
    url: http://www.gstatic.com/generate_204
    interval: 600
    proxies: ["HK-01"]
  - name: "流媒体"
    type: select
    proxies: ["🚀 节点选择", "香港测速", "DIRECT"]
  - name: "中转组"
    type: relay
    proxies: ["HK-01", "US-01"]
  - name: "负载均衡"
    type: load-balance
    strategy: round-robin
    proxies: ["HK-01", "US-01"]
rule-providers:
  adguard:
    type: http
    behavior: domain
    url: "https://example.com/adguard.mrs"
    path: "./ruleset/adguard.mrs"
    interval: 86400
rules:
  - DOMAIN-SUFFIX,example.com,流媒体
  - RULE-SET,adguard,REJECT
  - GEOIP,cn,DIRECT
  - MATCH,DIRECT
dns:
  enable: true
  nameserver:
    - 223.5.5.5
  fallback:
    - 8.8.8.8
`;

describe("convertClashYamlToTemplate", () => {
  it("converts groups, rules, rule sets, dns and globals", () => {
    const result = convertClashYamlToTemplate(SAMPLE_YAML, FALLBACKS);

    expect(result.summary.groups).toBe(5);
    expect(result.summary.rules).toBe(2);
    expect(result.summary.ruleSets).toBe(1);
    expect(result.summary.ignoredNodes).toBe(2);
    expect(result.summary.skippedRules).toBe(1); // MATCH
    expect(result.config.template).toBe("minimal");
    expect(result.config.mixedPort).toBe(7891);
    expect(result.config.allowLan).toBe(true);
    expect(result.config.testUrl).toBe("http://www.gstatic.com/generate_204");
    expect(result.config.testInterval).toBe(600);
    expect(result.config.dnsYaml).toContain("nameserver:");
    expect(result.config.dnsYaml).toContain("8.8.8.8");
    expect(result.warnings.some((warning) => warning.includes("中转组") && warning.includes("relay"))).toBe(true);
  });

  it("overrides the builtin select module instead of duplicating its name", () => {
    const result = convertClashYamlToTemplate(SAMPLE_YAML, FALLBACKS);

    expect(result.config.customProxyGroups.some((group) => group.name === "🚀 节点选择")).toBe(false);
    const advanced = result.config.proxyGroupAdvanced?.select;
    expect(advanced).toBeDefined();
    expect(advanced?.groupType).toBe("select");
    // 节点成员用 includeRegex 精确锁定，DIRECT 列入 memberOrder，REJECT 被排除
    expect(advanced?.includeRegex).toBe("^(HK-01|US-01)$");
    expect(advanced?.memberOrder).toContainEqual({ kind: "node", name: "HK-01" });
    expect(advanced?.memberOrder).toContainEqual({ kind: "direct" });
    expect(advanced?.excludedMembers).toContainEqual({ kind: "reject" });
    expect(result.config.enabledProxyGroups).toContain("select");
  });

  it("maps custom group members to node/group refs with exact-name filters", () => {
    const result = convertClashYamlToTemplate(SAMPLE_YAML, FALLBACKS);

    const streaming = result.config.customProxyGroups.find((group) => group.name === "流媒体");
    expect(streaming).toBeDefined();
    expect(streaming?.groupType).toBe("select");
    expect(streaming?.advanced?.extraMembers).toContainEqual({ kind: "module", id: "select" });
    const hkGroup = result.config.customProxyGroups.find((group) => group.name === "香港测速");
    expect(streaming?.advanced?.extraMembers).toContainEqual({ kind: "custom", id: hkGroup?.id });
    // 流媒体组没有节点成员：挡住默认的全部节点
    expect(streaming?.advanced?.excludeRegex).toBe(".*");
    expect(streaming?.advanced?.memberOrder?.[0]).toEqual({ kind: "module", id: "select" });
  });

  it("maps url-test and load-balance details", () => {
    const result = convertClashYamlToTemplate(SAMPLE_YAML, FALLBACKS);

    const hk = result.config.customProxyGroups.find((group) => group.name === "香港测速");
    expect(hk?.groupType).toBe("url-test");
    expect(hk?.advanced?.testUrl).toBe("http://www.gstatic.com/generate_204");
    expect(hk?.advanced?.includeRegex).toBe("^(HK-01)$");

    const lb = result.config.customProxyGroups.find((group) => group.name === "负载均衡");
    expect(lb?.groupType).toBe("load-balance");
    expect(lb?.strategy).toBe("round-robin");
  });

  it("preserves provider-backed groups (use/filter/tolerance) from a local-format YAML", () => {
    const yaml = `
proxy-groups:
  - name: "🇭🇰 香港节点"
    type: url-test
    url: https://www.gstatic.com/generate_204
    interval: 300
    tolerance: 50
    use:
      - my_sub
    filter: (?i)港|hk|hongkong|hong kong
  - name: "🇺🇲 美国节点"
    type: url-test
    url: https://www.gstatic.com/generate_204
    interval: 300
    tolerance: 150
    use:
      - my_sub
    filter: (?i)美|us|america|united states
  - name: "🚀 手动切换"
    type: select
    use:
      - my_sub
  - name: "🚀 节点选择"
    type: select
    proxies: ["🇭🇰 香港节点", "🇺🇲 美国节点", "🚀 手动切换", "DIRECT"]
rules:
  - MATCH,DIRECT
`;
    const result = convertClashYamlToTemplate(yaml, FALLBACKS);

    const hk = result.config.customProxyGroups.find((group) => group.name === "🇭🇰 香港节点");
    expect(hk?.groupType).toBe("url-test");
    expect(hk?.advanced?.includeRegex).toBe("(?i)港|hk|hongkong|hong kong");
    expect(hk?.advanced?.tolerance).toBe(50);
    expect(hk?.advanced?.useProviders).toBe(true);

    const us = result.config.customProxyGroups.find((group) => group.name === "🇺🇲 美国节点");
    expect(us?.advanced?.tolerance).toBe(150);
    expect(us?.advanced?.useProviders).toBe(true);

    const manual = result.config.customProxyGroups.find((group) => group.name === "🚀 手动切换");
    expect(manual?.groupType).toBe("select");
    expect(manual?.advanced?.useProviders).toBe(true);
    expect(manual?.advanced?.providerOnly).toBe(true);

    // 本站 provider 引用不再警告（语义已保留）
    expect(result.warnings.some((warning) => warning.includes("proxy-providers"))).toBe(false);
  });

  it("keeps YAML rule order across custom rules and rule sets", () => {
    const result = convertClashYamlToTemplate(SAMPLE_YAML, FALLBACKS);

    expect(result.config.ruleOrder).toEqual([
      "custom-rule:yaml-rule-1",
      "custom-rule-set:adguard",
      "custom-rule:yaml-rule-2",
    ]);
    const ruleSet = result.config.customRuleSets[0];
    expect(ruleSet.id).toBe("adguard");
    expect(ruleSet.behavior).toBe("domain");
    expect(ruleSet.format).toBe("mrs");
    expect(ruleSet.path).toBe("https://example.com/adguard.mrs");
    expect(ruleSet.target).toBe("REJECT");
    const geoRule = result.config.customRules.find((rule) => rule.type === "GEOIP");
    expect(geoRule?.value).toBe("cn");
    expect(geoRule?.target).toBe("DIRECT");
  });

  it("skips unsupported groups, rules and providers with warnings", () => {
    const yaml = `
proxy-groups:
  - name: "未知组"
    type: dns
    proxies: []
  - name: "重复组"
    type: select
    proxies: []
  - name: "重复组"
    type: select
    proxies: []
rules:
  - UNKNOWN-TYPE,foo,DIRECT
  - DOMAIN-SUFFIX
  - RULE-SET,missing-provider,DIRECT
  - RULE-SET,localfile,DIRECT
rule-providers:
  localfile:
    type: file
    behavior: domain
    path: ./local/rules.txt
`;
    const result = convertClashYamlToTemplate(yaml, FALLBACKS);

    expect(result.summary.groups).toBe(1);
    expect(result.summary.rules).toBe(0);
    expect(result.summary.ruleSets).toBe(0);
    expect(result.summary.skippedGroups).toBe(2);
    expect(result.summary.skippedRules).toBeGreaterThanOrEqual(3);
    expect(result.warnings.some((warning) => warning.includes("未知组"))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("重复定义"))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("missing-provider"))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("localfile"))).toBe(true);
  });

  it("skips malformed group entries and handles member edge cases", () => {
    const yaml = `
proxies:
  - { name: "HK-01", type: ss, server: 1.2.3.4, port: 8388, cipher: aes-256-gcm, password: secret }
  - { name: "US-01", type: ss, server: 5.6.7.8, port: 8388, cipher: aes-256-gcm, password: secret }
proxy-groups:
  - "not-an-object"
  - type: select
    proxies: [HK-01]
  - name: 无类型组
    proxies: [HK-01]
  - name: "!!!"
    type: select
    proxies: []
  - name: 直连优先
    type: direct
    proxies: [REJECT]
  - name: 直连优先2
    type: direct
    proxies: [HK-01]
  - name: 拒绝优先
    type: reject
    proxies: [DIRECT]
  - name: 拒绝优先2
    type: reject
    proxies: [HK-01]
  - name: 带 use 的组
    type: select
    use: [provider-a]
    proxies: [HK-01]
  - name: 均衡无策略
    type: load-balance
    proxies: [HK-01, US-01]
  - name: 均衡错策略
    type: load-balance
    strategy: bogus-strategy
    proxies: [HK-01]
  - name: 测速一
    type: url-test
    url: http://example.com/ping
    interval: 301
    proxies: [HK-01]
  - name: 测速二
    type: url-test
    url: http://cp.cloudflare.com/generate_204
    interval: 600
    proxies: [US-01]
  - name: 过滤组合
    type: select
    filter: "HK|US"
    proxies: [HK-01, US-01]
  - name: 过滤全含
    type: select
    filter: "HK|US"
    include-all: true
    proxies: [HK-01]
  - name: 仅分组过滤
    type: select
    filter: "HK"
    proxies: ["🚀 节点选择"]
  - name: 仅分组全含
    type: select
    filter: "HK"
    include-all: true
    proxies: ["🚀 节点选择"]
  - name: 排除过滤
    type: select
    exclude-filter: "JP.*"
    proxies: [HK-01]
  - name: 空成员
    type: select
    proxies: ["", HK-01]
  - name: 含拒绝的选择组
    type: select
    proxies: [HK-01, REJECT]
  - name: 无 proxies 组
    type: select
`;
    const result = convertClashYamlToTemplate(yaml, FALLBACKS);
    const byName = new Map(result.config.customProxyGroups.map((group) => [group.name, group]));

    expect(result.summary.groups).toBe(18);
    expect(result.summary.skippedGroups).toBe(3);
    expect(result.config.testUrl).toBe("http://example.com/ping");
    expect(result.config.testInterval).toBe(301);
    expect(result.warnings.some((warning) => warning.includes("不是对象"))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("缺少名称"))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("（空）"))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("proxy-providers"))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("bogus-strategy"))).toBe(true);

    expect(byName.get("!!!")?.id).toBe("yaml-4-group");
    // direct-first 带 REJECT：不再排除 REJECT；不带则排除
    expect(byName.get("直连优先")?.advanced.excludedMembers ?? []).toEqual([]);
    expect(byName.get("直连优先2")?.advanced.excludedMembers).toEqual([{ kind: "reject" }]);
    // reject-first 带 DIRECT：不再排除 DIRECT；不带则排除
    expect(byName.get("拒绝优先")?.advanced.excludedMembers ?? []).toEqual([]);
    expect(byName.get("拒绝优先2")?.advanced.excludedMembers).toEqual([{ kind: "direct" }]);
    // select 带 REJECT：只排除 DIRECT
    expect(byName.get("含拒绝的选择组")?.advanced.excludedMembers).toEqual([{ kind: "direct" }]);
    // 无策略与错策略都落到默认策略（consistent-hashing）
    expect(byName.get("均衡无策略")?.strategy).toBe("consistent-hashing");
    expect(byName.get("均衡错策略")?.strategy).toBe("consistent-hashing");
    // 节点 + filter 组合成精确名或 filter；include-all 只留精确名
    expect(byName.get("过滤组合")?.advanced.includeRegex).toBe("^(HK-01|US-01)$|(?:HK|US)");
    expect(byName.get("过滤全含")?.advanced.includeRegex).toBe("^(HK-01)$");
    // 只有分组引用时：filter 直接当 includeRegex；include-all 则不加任何过滤
    expect(byName.get("仅分组过滤")?.advanced.includeRegex).toBe("HK");
    expect(byName.get("仅分组全含")?.advanced.includeRegex).toBeUndefined();
    expect(byName.get("仅分组全含")?.advanced.excludeRegex).toBeUndefined();
    expect(byName.get("排除过滤")?.advanced.excludeRegex).toBe("JP.*");
    // 空成员被跳过
    expect(byName.get("空成员")?.advanced.extraMembers).toEqual([{ kind: "node", name: "HK-01" }]);
    // 无 proxies：无成员、无过滤，但 select 仍排除 DIRECT/REJECT
    expect(byName.get("无 proxies 组")?.advanced.extraMembers).toBeUndefined();
    expect(byName.get("无 proxies 组")?.advanced.excludedMembers).toEqual([{ kind: "direct" }, { kind: "reject" }]);
  });

  it("keeps listed module and custom refs out of a builtin override's exclusions", () => {
    const yaml = `
proxies:
  - { name: "HK-01", type: ss, server: 1.2.3.4, port: 8388, cipher: aes-256-gcm, password: secret }
proxy-groups:
  - name: 选我
    type: select
    proxies: [HK-01]
  - name: "🚀 节点选择"
    type: select
    proxies: ["⚡ 自动选择", 选我, HK-01]
`;
    const result = convertClashYamlToTemplate(yaml, FALLBACKS);
    const excluded = result.config.proxyGroupAdvanced["select"]?.excludedMembers ?? [];

    expect(excluded.some((ref) => ref.kind === "module" && ref.id === "auto")).toBe(false);
    expect(excluded.some((ref) => ref.kind === "custom")).toBe(false);
    expect(excluded.some((ref) => ref.kind === "module" && ref.id === "ad")).toBe(true);
    expect(excluded.some((ref) => ref.kind === "direct")).toBe(true);
    expect(excluded.some((ref) => ref.kind === "reject")).toBe(true);
  });

  it("handles rule and provider edge cases", () => {
    const yaml = `
proxies:
  - { name: "HK-01", type: ss, server: 1.2.3.4, port: 8388, cipher: aes-256-gcm, password: secret }
proxy-groups:
  - name: 测速组
    type: url-test
    url: http://www.gstatic.com/generate_204
    proxies: [HK-01]
rules:
  - 123
  - null
  - ""
  - "RULE-SET,adguard"
  - "RULE-SET,,DIRECT"
  - ",example.com,DIRECT"
  - "AND,DOMAIN,DIRECT"
  - "DOMAIN,example.com,🚀 节点选择"
  - "IP-CIDR,203.0.113.0/24,DIRECT,no-resolve"
  - "DOMAIN,other.com,DIRECT,no-resolve"
  - "RULE-SET,adguard,DIRECT"
  - "RULE-SET,adguard,DIRECT"
  - "RULE-SET,provider-yaml,🚀 节点选择"
  - "RULE-SET,provider-txt,DIRECT"
  - "RULE-SET,provider-file,DIRECT"
  - "RULE-SET,provider-bad-type,DIRECT"
  - "RULE-SET,provider-no-type,DIRECT"
  - "RULE-SET,provider-ipcidr,DIRECT"
  - "RULE-SET,provider-classical,DIRECT"
  - "RULE-SET,provider-classical-mrs,DIRECT,no-resolve"
  - "RULE-SET,provider-missing,DIRECT"
  - "RULE-SET,provider-explicit-format,DIRECT"
  - "RULE-SET,provider-no-behavior,DIRECT"
  - "MATCH,DIRECT"
rule-providers:
  adguard:
    type: http
    behavior: domain
    url: "https://rules.example.com/adguard.mrs"
  provider-yaml:
    type: http
    behavior: domain
    url: "https://rules.example.com/list.yaml"
  provider-txt:
    type: http
    behavior: domain
    url: "https://rules.example.com/list.txt"
  provider-file:
    type: file
    behavior: domain
    path: "geosite/cn.mrs"
  provider-bad-type:
    type: redis
    behavior: domain
    url: "https://rules.example.com/x.mrs"
  provider-no-type:
    behavior: domain
    url: "https://rules.example.com/x.mrs"
  provider-ipcidr:
    type: http
    behavior: ipcidr
    url: "https://rules.example.com/ip.mrs"
  provider-classical:
    type: http
    behavior: classical
    url: "https://rules.example.com/c.yaml"
  provider-classical-mrs:
    type: http
    behavior: classical
    format: mrs
    url: "https://rules.example.com/c.mrs"
  provider-explicit-format:
    type: http
    behavior: domain
    format: text
    url: "https://rules.example.com/e.mrs"
  provider-no-behavior:
    type: http
    url: "https://rules.example.com/nb.mrs"
`;
    const result = convertClashYamlToTemplate(yaml, FALLBACKS);
    const ruleSetByName = new Map(result.config.customRuleSets.map((ruleSet) => [ruleSet.name, ruleSet]));

    expect(result.summary.rules).toBe(3);
    expect(result.summary.ruleSets).toBe(9);
    expect(result.summary.skippedRules).toBe(9);
    expect(result.warnings.some((warning) => warning.includes("不是文本"))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("缺少提供者或目标"))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("（空）"))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("的值无效"))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("未在 rule-providers 中定义"))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("provider-bad-type"))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("provider-no-type"))).toBe(true);

    const ipRule = result.config.customRules.find((rule) => rule.type === "IP-CIDR");
    expect(ipRule?.noResolve).toBe(true);
    const domainRule = result.config.customRules.find((rule) => rule.type === "DOMAIN" && rule.value === "other.com");
    expect(domainRule?.noResolve).toBeUndefined();
    expect(result.config.customRules.find((rule) => rule.value === "example.com")?.target).toBe("🚀 节点选择");

    expect(ruleSetByName.get("provider-yaml")).toEqual(
      expect.objectContaining({ format: "yaml", behavior: "domain", target: "🚀 节点选择" }),
    );
    expect(ruleSetByName.get("provider-txt")).toEqual(expect.objectContaining({ format: "text" }));
    expect(ruleSetByName.get("provider-file")).toEqual(
      expect.objectContaining({ format: "mrs", path: "geosite/cn.mrs" }),
    );
    expect(ruleSetByName.get("provider-ipcidr")).toEqual(expect.objectContaining({ behavior: "ipcidr" }));
    expect(ruleSetByName.get("provider-classical")).toEqual(
      expect.objectContaining({ behavior: "classical", format: "yaml" }),
    );
    expect(ruleSetByName.get("provider-classical-mrs")).toEqual(
      expect.objectContaining({ behavior: "classical", format: "yaml", noResolve: true }),
    );
    expect(ruleSetByName.get("provider-explicit-format")).toEqual(expect.objectContaining({ format: "text" }));
    expect(ruleSetByName.get("provider-no-behavior")).toEqual(expect.objectContaining({ behavior: "domain" }));
    // 重复引用只生成一个规则集
    expect(result.config.customRuleSets.filter((ruleSet) => ruleSet.name === "adguard")).toHaveLength(1);
  });

  it("converts a dns-only file and rejects non-string input", () => {
    const result = convertClashYamlToTemplate("dns:\n  nameserver:\n    - 8.8.8.8\n", FALLBACKS);

    expect(result.config.dnsYaml).toContain("nameserver:");
    expect(result.summary.groups).toBe(0);
    expect(result.summary.rules).toBe(0);

    expect(() => convertClashYamlToTemplate(null as never, FALLBACKS)).toThrow("YAML 内容为空");
    // 空块也返回 key 行本身（至少包含 key 行，不会是空串）
    expect(extractTopLevelBlock("dns:\nproxies: []\n", "dns")).toBe("dns:");
  });

  it("reports unknown parse errors", async () => {
    const yamlScalars = await import("@subboost/core/parser/yaml-scalars");
    const spy = vi.spyOn(yamlScalars, "loadSubscriptionYaml").mockImplementationOnce(() => {
      throw "boom";
    });
    try {
      expect(() => convertClashYamlToTemplate("mixed-port: 7890", FALLBACKS)).toThrow("YAML 解析失败：未知错误");
    } finally {
      spy.mockRestore();
    }
  });

  it("uses fallbacks when the YAML has no globals or dns", () => {
    const result = convertClashYamlToTemplate(
      "proxy-groups:\n  - name: A\n    type: select\n    proxies: []\n",
      FALLBACKS,
    );

    expect(result.config.mixedPort).toBe(FALLBACKS.mixedPort);
    expect(result.config.allowLan).toBe(FALLBACKS.allowLan);
    expect(result.config.dnsYaml).toBe(FALLBACKS.dnsYaml);
    expect(result.config.testUrl).toBe(FALLBACKS.testUrl);
  });

  it("rejects empty, malformed and content-free YAML", () => {
    expect(() => convertClashYamlToTemplate("", FALLBACKS)).toThrow("YAML 内容为空");
    expect(() => convertClashYamlToTemplate("a: [unclosed", FALLBACKS)).toThrow("YAML 解析失败");
    expect(() => convertClashYamlToTemplate("- a\n- b\n", FALLBACKS)).toThrow("不是有效的 Clash YAML");
    expect(() => convertClashYamlToTemplate("port: 7890\n", FALLBACKS)).toThrow("没有找到可导入");
  });

  it("generates working proxy groups from the converted template", () => {
    const { config } = convertClashYamlToTemplate(SAMPLE_YAML, FALLBACKS);
    const nodes = [
      { name: "HK-01", type: "ss", server: "1.2.3.4", port: 8388, cipher: "aes-256-gcm", password: "secret" },
      { name: "US-01", type: "vmess", server: "5.6.7.8", port: 443, uuid: "00000000-0000-0000-0000-000000000000", alterId: 0, cipher: "auto" },
      { name: "JP-01", type: "ss", server: "9.9.9.9", port: 8388, cipher: "aes-256-gcm", password: "secret" },
    ] as unknown as ParsedNode[];
    const groups = generateProxyGroups({
      nodes,
      enabledModules: config.enabledProxyGroups,
      ruleProviderBaseUrl: config.ruleProviderBaseUrl,
      testUrl: config.testUrl,
      testInterval: config.testInterval,
      customProxyGroups: config.customProxyGroups,
      proxyGroupAdvanced: config.proxyGroupAdvanced,
    });

    const byName = new Map(groups.map((group) => [group.name, group]));
    // 内置 select 被 YAML 改写：只有 HK-01/US-01/DIRECT，没有 JP-01
    expect(byName.get("🚀 节点选择")?.proxies).toEqual(["HK-01", "US-01", "DIRECT"]);
    // url-test 组只有 HK-01
    expect(byName.get("香港测速")?.proxies).toEqual(["HK-01"]);
    expect(byName.get("香港测速")?.type).toBe("url-test");
    // 流媒体组：两个子组 + DIRECT，不含任何节点
    expect(byName.get("流媒体")?.proxies).toEqual(["🚀 节点选择", "香港测速", "DIRECT"]);
    // 同名分组没有重复出现
    expect(groups.filter((group) => group.name === "🚀 节点选择")).toHaveLength(1);
  });
});

describe("splitRuleLine", () => {
  it("keeps commas inside parentheses together", () => {
    expect(splitRuleLine("AND,((DOMAIN,example.com),(NETWORK,TCP)),PROXY")).toEqual([
      "AND",
      "((DOMAIN,example.com),(NETWORK,TCP))",
      "PROXY",
    ]);
    expect(splitRuleLine("DOMAIN-SUFFIX,example.com,PROXY,no-resolve")).toEqual([
      "DOMAIN-SUFFIX",
      "example.com",
      "PROXY",
      "no-resolve",
    ]);
  });
});

describe("extractTopLevelBlock", () => {
  it("extracts the dns block verbatim and stops at the next top-level key", () => {
    const text = "mixed-port: 7890\ndns:\n  enable: true\n  nameserver:\n    - 1.1.1.1\ntun:\n  enable: false\n";
    expect(extractTopLevelBlock(text, "dns")).toBe(
      "dns:\n  enable: true\n  nameserver:\n    - 1.1.1.1",
    );
    expect(extractTopLevelBlock(text, "tun")).toBe("tun:\n  enable: false");
    expect(extractTopLevelBlock(text, "missing")).toBeNull();
  });
});
