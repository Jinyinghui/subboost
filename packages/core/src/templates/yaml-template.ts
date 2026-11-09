/**
 * Clash / Mihomo YAML 配置 → SubBoost 模板配置转换器
 *
 * 用途：模板库“上传 YAML”——把用户本地在用的 Clash YAML 配置导入为网站内
 * 可一键应用的配置模板。只导入“生成策略”，不导入节点：
 * - proxy-groups → 自定义代理组（成员按名引用，生成时对当前订阅节点解析）
 * - 与内置分组同名的 YAML 分组（如“🚀 节点选择”）直接改写该内置分组的高级配置，
 *   而不是再建一个同名自定义组（否则生成结果会出现两个同名分组）
 * - rules / rule-providers → 自定义规则 / 自定义规则集
 * - dns 段 → dnsYaml（原文保留）
 * - mixed-port / allow-lan → 全局端口与局域网设置
 * - proxies（节点列表）会被忽略并计数
 *
 * 内置分组以精简版为底（服务端要求模板至少启用一个可见分组），YAML 自身
 * 的分组/规则作为自定义层叠加其上。
 */

import { loadSubscriptionYaml } from "@subboost/core/parser/yaml-scalars";
import { validateSubBoostTemplateConfig } from "@subboost/core/templates/config-template";
import { getModulesForTemplate, PROXY_GROUP_MODULES } from "@subboost/core/generator/proxy-groups";
import { normalizeProxyGroupAdvancedConfig } from "@subboost/core/proxy-group-advanced";
import { getProxyGroupMemberKey } from "@subboost/core/proxy-group-targets";
import { isCustomRuleType, supportsNoResolve } from "@subboost/core/rules/custom-rule-types";
import { getCustomRuleOrderKey, getCustomRuleSetOrderKey } from "@subboost/core/rules/custom-rule-utils";
import { normalizeCustomRuleValue } from "@subboost/core/rules/custom-rule-value";
import {
  allocateRuleSetId,
  isValidRuleSetPathOrUrl,
} from "@subboost/core/rules/rule-model";
import {
  isLoadBalanceStrategy,
  isProxyGroupGroupType,
  type CustomProxyGroup,
  type CustomRule,
  type CustomRuleSet,
  type LoadBalanceStrategy,
  type ProxyGroupAdvancedConfig,
  type ProxyGroupGroupType,
  type ProxyGroupMemberRef,
} from "@subboost/core/types/config";
import type { SubBoostTemplateConfig } from "@subboost/core/types/template-config";

export interface YamlTemplateFallbacks {
  dnsYaml: string;
  mixedPort: number;
  allowLan: boolean;
  testUrl: string;
  testInterval: number;
  ruleProviderBaseUrl: string;
}

export interface YamlTemplateSummary {
  groups: number;
  rules: number;
  ruleSets: number;
  ignoredNodes: number;
  skippedGroups: number;
  skippedRules: number;
}

export interface YamlTemplateResult {
  config: SubBoostTemplateConfig;
  warnings: string[];
  summary: YamlTemplateSummary;
}

const GROUP_TYPE_MAP: Record<string, ProxyGroupGroupType> = {
  select: "select",
  "url-test": "url-test",
  fallback: "fallback",
  "load-balance": "load-balance",
  // 中转组在站内没有等价类型，降级为手动选择组（成员保留），见 warnings
  relay: "select",
  direct: "direct-first",
  reject: "reject-first",
};

const MODULE_NAME_TO_ID = new Map(PROXY_GROUP_MODULES.map((module) => [module.name, module.id]));
const MINIMAL_MODULE_IDS = getModulesForTemplate("minimal");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function slugify(value: string): string {
  const slug = value
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return slug || "group";
}

/**
 * 按逗号切分规则行，括号内的逗号不切分（AND/OR/NOT 的子条件里有逗号）。
 */
export function splitRuleLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let depth = 0;
  for (const char of line) {
    if (char === "(") depth += 1;
    if (char === ")") depth = Math.max(0, depth - 1);
    if (char === "," && depth === 0) {
      fields.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  fields.push(current.trim());
  return fields;
}

/**
 * 提取 YAML 顶层 key 的原始文本块（用于 dns 段原文保留）。
 */
export function extractTopLevelBlock(text: string, key: string): string | null {
  const lines = text.split(/\r?\n/);
  const keyPattern = new RegExp(`^${key}:\\s*(#.*)?$`);
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (keyPattern.test(lines[index])) {
      start = index;
      break;
    }
  }
  if (start < 0) return null;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      end = index;
      break;
    }
  }
  const block = lines.slice(start, end).join("\n").trimEnd();
  return block;
}

interface PendingRuleSetRef {
  provider: string;
  target: string;
  noResolve: boolean;
}

interface DraftGroup {
  raw: Record<string, unknown>;
  name: string;
  /** 自定义组 id；与内置分组同名时为 null（改写内置分组） */
  id: string | null;
  /** 与内置分组同名时为该内置分组 id，否则为 null */
  moduleId: string | null;
  groupType: ProxyGroupGroupType;
}

export function convertClashYamlToTemplate(yamlText: string, fallbacks: YamlTemplateFallbacks): YamlTemplateResult {
  const warnings: string[] = [];
  const source = typeof yamlText === "string" ? yamlText : "";
  if (!source.trim()) throw new Error("YAML 内容为空");

  let parsed: unknown;
  try {
    parsed = loadSubscriptionYaml(source);
  } catch (error) {
    throw new Error(`YAML 解析失败：${error instanceof Error ? error.message : "未知错误"}`);
  }
  if (!isRecord(parsed)) throw new Error("不是有效的 Clash YAML 配置（顶层应为映射）");

  const rawGroups = Array.isArray(parsed["proxy-groups"]) ? parsed["proxy-groups"] : [];
  const rawRules = Array.isArray(parsed.rules) ? parsed.rules : [];
  const rawProviders = isRecord(parsed["rule-providers"]) ? parsed["rule-providers"] : {};
  const rawProxies = Array.isArray(parsed.proxies) ? parsed.proxies : [];
  if (rawGroups.length === 0 && rawRules.length === 0 && Object.keys(rawProviders).length === 0 && !extractTopLevelBlock(source, "dns")) {
    throw new Error("YAML 中没有找到可导入的分组、规则或 DNS 配置");
  }

  const enabledModuleIds = new Set<string>(MINIMAL_MODULE_IDS);

  // ---- 第一遍：建组（先拿 id，供成员互相引用） ----
  const drafts: DraftGroup[] = [];
  const customNameToId = new Map<string, string>();
  const overriddenModuleIds = new Set<string>();
  let skippedGroups = 0;
  rawGroups.forEach((raw, index) => {
    if (!isRecord(raw)) {
      warnings.push(`第 ${index + 1} 个分组不是对象，已跳过`);
      skippedGroups += 1;
      return;
    }
    const name = toTrimmedString(raw.name);
    const rawType = toTrimmedString(raw.type).toLowerCase();
    if (!name) {
      warnings.push(`第 ${index + 1} 个分组缺少名称，已跳过`);
      skippedGroups += 1;
      return;
    }
    if (customNameToId.has(name) || overriddenModuleIds.has(MODULE_NAME_TO_ID.get(name) ?? "")) {
      warnings.push(`分组“${name}”重复定义，仅保留第一处`);
      skippedGroups += 1;
      return;
    }
    const groupType = GROUP_TYPE_MAP[rawType];
    if (!groupType || !isProxyGroupGroupType(groupType)) {
      warnings.push(`分组“${name}”的类型“${rawType || "（空）"}”暂不支持，已跳过`);
      skippedGroups += 1;
      return;
    }
    if (rawType === "relay") {
      warnings.push(`分组“${name}”是中转组（relay），已按手动选择组导入，中转语义不保留`);
    }
    const moduleId = MODULE_NAME_TO_ID.get(name);
    if (moduleId) {
      overriddenModuleIds.add(moduleId);
      drafts.push({ raw, name, id: null, moduleId, groupType });
      return;
    }
    const id = `yaml-${index + 1}-${slugify(name)}`;
    customNameToId.set(name, id);
    drafts.push({ raw, name, id, moduleId: null, groupType });
  });

  const classifyMember = (member: string): ProxyGroupMemberRef | null => {
    const trimmed = member.trim();
    if (!trimmed) return null;
    if (trimmed === "DIRECT") return { kind: "direct" };
    if (trimmed === "REJECT") return { kind: "reject" };
    const customId = customNameToId.get(trimmed);
    if (customId) return { kind: "custom", id: customId };
    const moduleId = MODULE_NAME_TO_ID.get(trimmed);
    if (moduleId) {
      enabledModuleIds.add(moduleId);
      return { kind: "module", id: moduleId };
    }
    return { kind: "node", name: trimmed };
  };

  // ---- 第二遍：成员、类型细节 ----
  const customProxyGroups: CustomProxyGroup[] = [];
  const proxyGroupAdvanced: Record<string, ProxyGroupAdvancedConfig> = {};
  let testUrl: string | undefined;
  let testInterval: number | undefined;
  for (const draft of drafts) {
    const raw = draft.raw;
    const members = toStringArray(raw.proxies);
    if (raw.use !== undefined) {
      warnings.push(`分组“${draft.name}”引用了 proxy-providers（use），无法在站内解析，已忽略该引用`);
    }
    const refs: ProxyGroupMemberRef[] = [];
    const nodeNames: string[] = [];
    let hasDirect = false;
    let hasReject = false;
    for (const member of members) {
      const ref = classifyMember(member);
      if (!ref) continue;
      refs.push(ref);
      if (ref.kind === "node") nodeNames.push(ref.name);
      if (ref.kind === "direct") hasDirect = true;
      if (ref.kind === "reject") hasReject = true;
    }

    const filter = toTrimmedString(raw.filter);
    const excludeFilter = toTrimmedString(raw["exclude-filter"]);
    const includeAll = raw["include-all"] === true;
    let includeRegex: string | undefined;
    let excludeRegex: string | undefined;
    if (nodeNames.length > 0) {
      const exactNames = `^(${nodeNames.map(escapeRegex).join("|")})$`;
      includeRegex = filter && !includeAll ? `${exactNames}|(?:${filter})` : exactNames;
    } else if (filter && !includeAll) {
      includeRegex = filter;
    } else if (!includeAll && refs.length > 0) {
      // 只有分组/DIRECT/REJECT 成员时，挡住默认的全部节点
      excludeRegex = ".*";
    }
    if (excludeFilter) excludeRegex = excludeFilter;

    const excludedMembers: ProxyGroupMemberRef[] = [];
    if (draft.groupType === "select") {
      if (!hasDirect) excludedMembers.push({ kind: "direct" });
      if (!hasReject) excludedMembers.push({ kind: "reject" });
    } else if (draft.groupType === "direct-first") {
      if (!hasReject) excludedMembers.push({ kind: "reject" });
    } else if (draft.groupType === "reject-first") {
      if (!hasDirect) excludedMembers.push({ kind: "direct" });
    }
    if (draft.moduleId) {
      // 内置分组的默认成员还包括其他内置分组与自定义分组：YAML 列表是显式成员，
      // 未列出的分组引用也要排除，否则会混进默认成员（如 select 组默认带 auto 组）
      const listedKeys = new Set(refs.map((ref) => getProxyGroupMemberKey(ref)));
      for (const builtinModule of PROXY_GROUP_MODULES) {
        if (builtinModule.id === draft.moduleId) continue;
        const ref: ProxyGroupMemberRef = { kind: "module", id: builtinModule.id };
        if (!listedKeys.has(getProxyGroupMemberKey(ref))) excludedMembers.push(ref);
      }
      for (const customId of customNameToId.values()) {
        const ref: ProxyGroupMemberRef = { kind: "custom", id: customId };
        if (!listedKeys.has(getProxyGroupMemberKey(ref))) excludedMembers.push(ref);
      }
    }

    const groupTestUrl = toTrimmedString(raw.url);
    if ((draft.groupType === "url-test" || draft.groupType === "fallback") && groupTestUrl) {
      if (!testUrl) testUrl = groupTestUrl;
    }
    const groupInterval = typeof raw.interval === "number" && Number.isFinite(raw.interval) && raw.interval > 0
      ? raw.interval
      : undefined;
    if ((draft.groupType === "url-test" || draft.groupType === "fallback") && groupInterval && !testInterval) {
      testInterval = groupInterval;
    }

    let strategy: LoadBalanceStrategy | undefined;
    if (draft.groupType === "load-balance") {
      const rawStrategy = toTrimmedString(raw.strategy);
      if (rawStrategy && isLoadBalanceStrategy(rawStrategy)) strategy = rawStrategy;
      else if (rawStrategy) warnings.push(`分组“${draft.name}”的负载均衡策略“${rawStrategy}”不支持，已用默认策略`);
    }

    const advanced = normalizeProxyGroupAdvancedConfig({
      ...(groupTestUrl ? { testUrl: groupTestUrl } : {}),
      ...(includeRegex ? { includeRegex } : {}),
      ...(excludeRegex ? { excludeRegex } : {}),
      groupType: draft.groupType,
      ...(strategy ? { strategy } : {}),
      ...(refs.length > 0 ? { extraMembers: refs } : {}),
      ...(excludedMembers.length > 0 ? { excludedMembers } : {}),
      ...(refs.length > 0 ? { memberOrder: refs } : {}),
    });

    if (draft.moduleId) {
      // 与内置分组同名：改写该内置分组的高级配置，不另建自定义组
      proxyGroupAdvanced[draft.moduleId] = advanced;
      enabledModuleIds.add(draft.moduleId);
      continue;
    }
    customProxyGroups.push({
      id: draft.id as string,
      name: draft.name,
      emoji: "",
      groupType: draft.groupType,
      ...(strategy ? { strategy } : {}),
      includeInGroupMembers: true,
      advanced,
    });
  }

  // ---- 规则 ----
  const customRules: CustomRule[] = [];
  const pendingRuleSetRefs: PendingRuleSetRef[] = [];
  // 保持 YAML 原有顺序：规则与规则集引用按出现顺序记录，最后统一生成 ruleOrder
  const orderedEntries: Array<{ kind: "rule"; id: string } | { kind: "ruleset"; ref: PendingRuleSetRef }> = [];
  let skippedRules = 0;
  let ruleCounter = 0;
  rawRules.forEach((rawLine, index) => {
    if (typeof rawLine !== "string" || !rawLine.trim()) {
      if (typeof rawLine !== "string" && rawLine !== undefined && rawLine !== null) {
        warnings.push(`第 ${index + 1} 条规则不是文本，已跳过`);
        skippedRules += 1;
      }
      return;
    }
    const fields = splitRuleLine(rawLine);
    const type = (fields[0] ?? "").toUpperCase();
    if (type === "MATCH" || type === "FINAL") {
      skippedRules += 1;
      return;
    }
    if (type === "RULE-SET") {
      const provider = fields[1] ?? "";
      const target = fields[2] ?? "";
      if (!provider || !target) {
        warnings.push(`第 ${index + 1} 条规则集引用缺少提供者或目标，已跳过`);
        skippedRules += 1;
        return;
      }
      const ref: PendingRuleSetRef = {
        provider,
        target,
        noResolve: fields.slice(3).some((field) => field.toLowerCase() === "no-resolve"),
      };
      pendingRuleSetRefs.push(ref);
      orderedEntries.push({ kind: "ruleset", ref });
      return;
    }
    if (!isCustomRuleType(type)) {
      warnings.push(`第 ${index + 1} 条规则的类型“${type || "（空）"}”暂不支持，已跳过`);
      skippedRules += 1;
      return;
    }
    if (fields.length < 3 || !fields[1] || !fields[2]) {
      warnings.push(`第 ${index + 1} 条规则格式不完整，已跳过`);
      skippedRules += 1;
      return;
    }
    const valueResult = normalizeCustomRuleValue(type, fields[1]);
    if (!valueResult.ok) {
      warnings.push(`第 ${index + 1} 条规则的值无效（${valueResult.error}），已跳过`);
      skippedRules += 1;
      return;
    }
    const target = fields[2];
    const moduleId = MODULE_NAME_TO_ID.get(target);
    if (moduleId) enabledModuleIds.add(moduleId);
    ruleCounter += 1;
    const id = `yaml-rule-${ruleCounter}`;
    const noResolve = fields.slice(3).some((field) => field.toLowerCase() === "no-resolve");
    customRules.push({
      id,
      type,
      value: valueResult.value,
      target,
      ...(noResolve && supportsNoResolve(type) ? { noResolve: true } : {}),
    });
    orderedEntries.push({ kind: "rule", id });
  });

  // ---- 规则提供者 → 自定义规则集 ----
  const customRuleSets: CustomRuleSet[] = [];
  const usedRuleSetIds = new Set<string>();
  const ruleSetByProviderTarget = new Map<string, CustomRuleSet>();
  const ruleSetIdByRef = new Map<PendingRuleSetRef, string>();
  const inferFormat = (url: string): "mrs" | "yaml" | "text" => {
    const lower = url.toLowerCase();
    if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "yaml";
    if (lower.endsWith(".txt")) return "text";
    return "mrs";
  };
  for (const ref of pendingRuleSetRefs) {
    const dedupeKey = JSON.stringify([ref.provider, ref.target]);
    const existing = ruleSetByProviderTarget.get(dedupeKey);
    if (existing) {
      ruleSetIdByRef.set(ref, existing.id);
      continue;
    }
    const provider = rawProviders[ref.provider];
    if (!isRecord(provider)) {
      warnings.push(`规则集“${ref.provider}”未在 rule-providers 中定义，已跳过引用它的规则`);
      skippedRules += 1;
      continue;
    }
    const providerType = toTrimmedString(provider.type).toLowerCase();
    let path = "";
    if (providerType === "http") {
      path = toTrimmedString(provider.url);
    } else if (providerType === "file") {
      path = toTrimmedString(provider.path);
    } else {
      warnings.push(`规则提供者“${ref.provider}”的类型“${providerType || "（空）"}”暂不支持，已跳过引用它的规则`);
      skippedRules += 1;
      continue;
    }
    if (!path || !isValidRuleSetPathOrUrl(path)) {
      warnings.push(`规则提供者“${ref.provider}”的地址无效或为本地文件路径，已跳过引用它的规则`);
      skippedRules += 1;
      continue;
    }
    const behaviorRaw = toTrimmedString(provider.behavior).toLowerCase();
    const behavior = behaviorRaw === "domain" || behaviorRaw === "ipcidr" || behaviorRaw === "classical"
      ? behaviorRaw
      : "domain";
    const formatRaw = toTrimmedString(provider.format).toLowerCase();
    let format: "mrs" | "yaml" | "text" = formatRaw === "mrs" || formatRaw === "yaml" || formatRaw === "text"
      ? formatRaw
      : inferFormat(path);
    if (behavior === "classical" && format === "mrs") format = "yaml";
    const id = allocateRuleSetId(ref.provider, usedRuleSetIds);
    usedRuleSetIds.add(id);
    const moduleId = MODULE_NAME_TO_ID.get(ref.target);
    if (moduleId) enabledModuleIds.add(moduleId);
    const ruleSet: CustomRuleSet = {
      id,
      name: ref.provider,
      behavior,
      format,
      path,
      target: ref.target,
      ...(ref.noResolve ? { noResolve: true } : {}),
    };
    customRuleSets.push(ruleSet);
    ruleSetByProviderTarget.set(dedupeKey, ruleSet);
    ruleSetIdByRef.set(ref, id);
  }

  // 按 YAML 原有顺序生成 ruleOrder（同名规则集去重，保留首次出现位置）
  const orderKeys: string[] = [];
  const seenOrderKeys = new Set<string>();
  for (const entry of orderedEntries) {
    const key = entry.kind === "rule"
      ? getCustomRuleOrderKey(entry.id)
      : (() => {
          const id = ruleSetIdByRef.get(entry.ref);
          return id ? getCustomRuleSetOrderKey(id) : null;
        })();
    if (!key || seenOrderKeys.has(key)) continue;
    seenOrderKeys.add(key);
    orderKeys.push(key);
  }

  // ---- DNS 与全局 ----
  const dnsBlock = extractTopLevelBlock(source, "dns");
  const mixedPortRaw = parsed["mixed-port"];
  const mixedPort = typeof mixedPortRaw === "number" && Number.isInteger(mixedPortRaw) && mixedPortRaw >= 1 && mixedPortRaw <= 65535
    ? mixedPortRaw
    : fallbacks.mixedPort;
  const allowLan = typeof parsed["allow-lan"] === "boolean" ? parsed["allow-lan"] : fallbacks.allowLan;
  const testUrlValue = testUrl && /^https?:\/\//i.test(testUrl) ? testUrl : fallbacks.testUrl;
  const testIntervalValue = testInterval ?? fallbacks.testInterval;

  const config: SubBoostTemplateConfig = {
    schema: "subboost-template-config/v1",
    template: "minimal",
    enabledProxyGroups: [...enabledModuleIds],
    hiddenProxyGroups: [],
    customProxyGroups,
    proxyGroupAdvanced,
    customRuleSets,
    builtinRuleEdits: {},
    customRules,
    ruleOrder: orderKeys,
    dialerProxyGroups: [],
    proxyGroupNameOverrides: {},
    dnsYaml: dnsBlock ?? fallbacks.dnsYaml,
    mixedPort,
    allowLan,
    testUrl: testUrlValue,
    testInterval: testIntervalValue,
    ruleProviderBaseUrl: fallbacks.ruleProviderBaseUrl,
  };

  const validated = validateSubBoostTemplateConfig(config);
  if (!validated.ok) throw new Error(`模板生成失败：${validated.error}`);

  return {
    config: validated.config,
    warnings,
    summary: {
      groups: customProxyGroups.length + overriddenModuleIds.size,
      rules: customRules.length,
      ruleSets: customRuleSets.length,
      ignoredNodes: rawProxies.length,
      skippedGroups,
      skippedRules,
    },
  };
}
