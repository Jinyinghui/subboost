import { getNodeSourceIds } from "@subboost/core/subscription/node-source-state";
import {
  DEFAULT_LOAD_BALANCE_STRATEGY,
  isLoadBalanceStrategy,
} from "@subboost/core/types/config";
import type {
  CustomProxyGroup,
  NodeRegion,
  ProxyGroupAdvancedConfig,
  ProxyGroupGroupType,
  ProxyGroupMemberRef,
} from "@subboost/core/types/config";
import type { ParsedNode } from "@subboost/core/types/node";
import { getProxyGroupMemberKey } from "@subboost/core/proxy-group-targets";

export const REGION_PRESETS: Array<{
  id: NodeRegion;
  label: string;
  emoji: string;
  keywords: string[];
  // 该地区作为 proxy-providers filter 时的正则（本地配置原文）；未设置时由 keywords 派生
  filter?: string;
}> = [
  { id: "us", label: "美国", emoji: "🇺🇸", keywords: ["美国", "US", "USA", "United States", "洛杉矶", "纽约", "西雅图"], filter: "(?i)美|us|america|united states" },
  { id: "hk", label: "香港", emoji: "🇭🇰", keywords: ["香港", "HK", "Hong Kong", "港"], filter: "(?i)港|hk|hongkong|hong kong" },
  { id: "jp", label: "日本", emoji: "🇯🇵", keywords: ["日本", "JP", "Japan", "东京", "大阪"], filter: "(?i)日|jp|japan" },
  { id: "sg", label: "新加坡", emoji: "🇸🇬", keywords: ["新加坡", "SG", "Singapore", "狮城"], filter: "(?i)新|狮城|sg|singapore" },
  { id: "tw", label: "台湾", emoji: "🇹🇼", keywords: ["台湾", "TW", "Taiwan", "台北"], filter: "(?i)台|tw|taiwan" },
  { id: "kr", label: "韩国", emoji: "🇰🇷", keywords: ["韩国", "KR", "Korea", "首尔"], filter: "(?i)韩|kr|korea" },
  { id: "uk", label: "英国", emoji: "🇬🇧", keywords: ["英国", "UK", "United Kingdom", "London", "伦敦"], filter: "(?i)英|uk|united kingdom|great britain" },
  { id: "de", label: "德国", emoji: "🇩🇪", keywords: ["德国", "DE", "Germany", "Frankfurt", "法兰克福"], filter: "(?i)德|de|germany" },
  { id: "fr", label: "法国", emoji: "🇫🇷", keywords: ["法国", "FR", "France", "Paris", "巴黎"], filter: "(?i)法|fr|france" },
  { id: "ca", label: "加拿大", emoji: "🇨🇦", keywords: ["加拿大", "CA", "Canada", "Toronto", "多伦多"], filter: "(?i)加|ca|canada" },
  { id: "nl", label: "荷兰", emoji: "🇳🇱", keywords: ["荷兰", "NL", "Netherlands"], filter: "(?i)荷|nl|netherlands" },
  { id: "au", label: "澳大利亚", emoji: "🇦🇺", keywords: ["澳大利亚", "AU", "Australia", "Sydney", "悉尼"], filter: "(?i)澳|au|australia" },
  // 以下为节点同步用的扩展国家：与上面 12 个预置共用同一份国家列表（系统内只一份）。
  // filter 沿用本地配置原文风格；个别两位代码因是其他国家/城市名的子串而不在 filter 与
  // keywords 里出现（如印度不用 in，因它是 Indonesia/Singapore 的子串；冰岛不用 is，
  // 因它是 Paris/Lisbon 的子串；瑞士不用 ch，因它是 China/Chile 的子串），改由中文名、
  // 英文名与城市名识别，避免误判。
  { id: "in", label: "印度", emoji: "🇮🇳", keywords: ["印度", "India", "孟买"], filter: "(?i)印度|india" },
  { id: "th", label: "泰国", emoji: "🇹🇭", keywords: ["泰国", "TH", "Thailand", "曼谷"], filter: "(?i)泰|th|thailand" },
  { id: "vn", label: "越南", emoji: "🇻🇳", keywords: ["越南", "VN", "Vietnam", "胡志明"], filter: "(?i)越|vn|vietnam" },
  { id: "id", label: "印度尼西亚", emoji: "🇮🇩", keywords: ["印度尼西亚", "印尼", "Indonesia", "雅加达"], filter: "(?i)印尼|indonesia" },
  { id: "my", label: "马来西亚", emoji: "🇲🇾", keywords: ["马来西亚", "MY", "Malaysia", "吉隆坡"], filter: "(?i)马来西亚|my|malaysia" },
  { id: "ph", label: "菲律宾", emoji: "🇵🇭", keywords: ["菲律宾", "PH", "Philippines", "马尼拉"], filter: "(?i)菲律宾|ph|philippines" },
  { id: "ru", label: "俄罗斯", emoji: "🇷🇺", keywords: ["俄罗斯", "Russia", "莫斯科"], filter: "(?i)俄罗斯|russia" },
  { id: "tr", label: "土耳其", emoji: "🇹🇷", keywords: ["土耳其", "Turkey", "伊斯坦布尔"], filter: "(?i)土耳其|turkey" },
  { id: "br", label: "巴西", emoji: "🇧🇷", keywords: ["巴西", "Brazil", "圣保罗"], filter: "(?i)巴西|brazil" },
  { id: "ar", label: "阿根廷", emoji: "🇦🇷", keywords: ["阿根廷", "Argentina", "布宜诺斯艾利斯"], filter: "(?i)阿根廷|argentina" },
  { id: "mx", label: "墨西哥", emoji: "🇲🇽", keywords: ["墨西哥", "MX", "Mexico"], filter: "(?i)墨西哥|mx|mexico" },
  { id: "cl", label: "智利", emoji: "🇨🇱", keywords: ["智利", "CL", "Chile"], filter: "(?i)智利|cl|chile" },
  { id: "pe", label: "秘鲁", emoji: "🇵🇪", keywords: ["秘鲁", "PE", "Peru"], filter: "(?i)秘鲁|pe|peru" },
  { id: "co", label: "哥伦比亚", emoji: "🇨🇴", keywords: ["哥伦比亚", "CO", "Colombia"], filter: "(?i)哥伦比亚|co|colombia" },
  { id: "za", label: "南非", emoji: "🇿🇦", keywords: ["南非", "ZA", "South Africa"], filter: "(?i)南非|za|south africa" },
  { id: "eg", label: "埃及", emoji: "🇪🇬", keywords: ["埃及", "EG", "Egypt", "开罗"], filter: "(?i)埃及|eg|egypt" },
  { id: "ng", label: "尼日利亚", emoji: "🇳🇬", keywords: ["尼日利亚", "Nigeria"], filter: "(?i)尼日利亚|nigeria" },
  { id: "ke", label: "肯尼亚", emoji: "🇰🇪", keywords: ["肯尼亚", "KE", "Kenya"], filter: "(?i)肯尼亚|ke|kenya" },
  { id: "ae", label: "阿联酋", emoji: "🇦🇪", keywords: ["阿联酋", "AE", "UAE", "United Arab Emirates", "迪拜"], filter: "(?i)阿联酋|ae|uae|united arab emirates" },
  { id: "sa", label: "沙特阿拉伯", emoji: "🇸🇦", keywords: ["沙特阿拉伯", "沙特", "Saudi Arabia", "利雅得"], filter: "(?i)沙特|saudi arabia" },
  { id: "il", label: "以色列", emoji: "🇮🇱", keywords: ["以色列", "Israel"], filter: "(?i)以色列|israel" },
  { id: "ua", label: "乌克兰", emoji: "🇺🇦", keywords: ["乌克兰", "UA", "Ukraine", "基辅"], filter: "(?i)乌克兰|ua|ukraine" },
  { id: "pl", label: "波兰", emoji: "🇵🇱", keywords: ["波兰", "PL", "Poland", "华沙"], filter: "(?i)波兰|pl|poland" },
  { id: "es", label: "西班牙", emoji: "🇪🇸", keywords: ["西班牙", "Spain", "马德里"], filter: "(?i)西班牙|spain" },
  { id: "it", label: "意大利", emoji: "🇮🇹", keywords: ["意大利", "IT", "Italy", "罗马"], filter: "(?i)意大利|it|italy" },
  { id: "se", label: "瑞典", emoji: "🇸🇪", keywords: ["瑞典", "Sweden"], filter: "(?i)瑞典|sweden" },
  { id: "no", label: "挪威", emoji: "🇳🇴", keywords: ["挪威", "NO", "Norway"], filter: "(?i)挪威|no|norway" },
  { id: "fi", label: "芬兰", emoji: "🇫🇮", keywords: ["芬兰", "FI", "Finland"], filter: "(?i)芬兰|fi|finland" },
  { id: "dk", label: "丹麦", emoji: "🇩🇰", keywords: ["丹麦", "DK", "Denmark"], filter: "(?i)丹麦|dk|denmark" },
  { id: "ch", label: "瑞士", emoji: "🇨🇭", keywords: ["瑞士", "Switzerland", "苏黎世", "日内瓦"], filter: "(?i)瑞士|switzerland" },
  { id: "at", label: "奥地利", emoji: "🇦🇹", keywords: ["奥地利", "AT", "Austria", "维也纳"], filter: "(?i)奥地利|at|austria" },
  { id: "be", label: "比利时", emoji: "🇧🇪", keywords: ["比利时", "Belgium", "布鲁塞尔"], filter: "(?i)比利时|belgium" },
  { id: "ie", label: "爱尔兰", emoji: "🇮🇪", keywords: ["爱尔兰", "IE", "Ireland"], filter: "(?i)爱尔兰|ie|ireland" },
  { id: "pt", label: "葡萄牙", emoji: "🇵🇹", keywords: ["葡萄牙", "Portugal", "里斯本"], filter: "(?i)葡萄牙|portugal" },
  { id: "gr", label: "希腊", emoji: "🇬🇷", keywords: ["希腊", "GR", "Greece"], filter: "(?i)希腊|gr|greece" },
  { id: "nz", label: "新西兰", emoji: "🇳🇿", keywords: ["新西兰", "NZ", "New Zealand"], filter: "(?i)新西兰|nz|new zealand" },
  { id: "is", label: "冰岛", emoji: "🇮🇸", keywords: ["冰岛", "Iceland", "雷克雅未克"], filter: "(?i)冰岛|iceland" },
  { id: "cz", label: "捷克", emoji: "🇨🇿", keywords: ["捷克", "CZ", "Czech"], filter: "(?i)捷克|cz|czech" },
  { id: "hu", label: "匈牙利", emoji: "🇭🇺", keywords: ["匈牙利", "HU", "Hungary"], filter: "(?i)匈牙利|hu|hungary" },
  { id: "ro", label: "罗马尼亚", emoji: "🇷🇴", keywords: ["罗马尼亚", "Romania"], filter: "(?i)罗马尼亚|romania" },
  { id: "pk", label: "巴基斯坦", emoji: "🇵🇰", keywords: ["巴基斯坦", "PK", "Pakistan"], filter: "(?i)巴基斯坦|pk|pakistan" },
  { id: "bd", label: "孟加拉", emoji: "🇧🇩", keywords: ["孟加拉", "BD", "Bangladesh"], filter: "(?i)孟加拉|bd|bangladesh" },
  { id: "lk", label: "斯里兰卡", emoji: "🇱🇰", keywords: ["斯里兰卡", "LK", "Sri Lanka"], filter: "(?i)斯里兰卡|lk|sri lanka" },
  { id: "kh", label: "柬埔寨", emoji: "🇰🇭", keywords: ["柬埔寨", "KH", "Cambodia"], filter: "(?i)柬埔寨|kh|cambodia" },
  { id: "la", label: "老挝", emoji: "🇱🇦", keywords: ["老挝", "Laos"], filter: "(?i)老挝|laos" },
  { id: "mm", label: "缅甸", emoji: "🇲🇲", keywords: ["缅甸", "MM", "Myanmar"], filter: "(?i)缅甸|mm|myanmar" },
  { id: "mn", label: "蒙古", emoji: "🇲🇳", keywords: ["蒙古", "MN", "Mongolia"], filter: "(?i)蒙古|mn|mongolia" },
  { id: "kz", label: "哈萨克斯坦", emoji: "🇰🇿", keywords: ["哈萨克斯坦", "KZ", "Kazakhstan"], filter: "(?i)哈萨克斯坦|kz|kazakhstan" },
  { id: "other", label: "其他", emoji: "🌐", keywords: [] },
];

export type ProxyGroupResolvedMemberKind = ProxyGroupMemberRef["kind"];

export interface ProxyGroupResolvedMember {
  ref: ProxyGroupMemberRef;
  key: string;
  name: string;
  kind: ProxyGroupResolvedMemberKind;
}

export interface ResolveProxyGroupMembersOptions {
  defaultProxyNames: string[];
  availableProxyNames?: string[];
  nodes: ParsedNode[];
  moduleNames?: Record<string, string>;
  customProxyGroups?: CustomProxyGroup[];
  advanced?: ProxyGroupAdvancedConfig;
  self?: { kind: "module" | "custom"; id: string; name: string };
}

export interface ResolveProxyGroupMembersResult {
  included: ProxyGroupResolvedMember[];
  excluded: ProxyGroupResolvedMember[];
  proxyNames: string[];
}

const NODE_REGIONS = new Set<NodeRegion>(REGION_PRESETS.map((preset) => preset.id));

function compileRegex(pattern?: string): RegExp | null {
  const raw = typeof pattern === "string" ? pattern.trim() : "";
  if (!raw) return null;
  try {
    return new RegExp(raw, "i");
  } catch {
    return null;
  }
}

function matchesRegion(nodeName: string, regions: NodeRegion[]): boolean {
  if (!Array.isArray(regions) || regions.length === 0) return true;
  const normalized = nodeName.toLowerCase();

  for (const region of regions) {
    if (region === "other") continue;
    const preset = REGION_PRESETS.find((item) => item.id === region);
    if (!preset) continue;
    if (preset.keywords.some((keyword) => normalized.includes(keyword.toLowerCase()))) return true;
  }

  if (regions.includes("other")) {
    for (const preset of REGION_PRESETS) {
      if (preset.id === "other") continue;
      if (preset.keywords.some((keyword) => normalized.includes(keyword.toLowerCase()))) return false;
    }
    return true;
  }

  return false;
}

/** 把一条 filter 正则编译成 JS 可用的正则：去掉 (?i) 前缀后按不区分大小写编译，失败返回 null。 */
export function compileCountryFilterRegex(filter: string | undefined): RegExp | null {
  const raw = typeof filter === "string" ? filter.trim() : "";
  if (!raw) return null;
  const body = raw.replace(/^\(\?i\)/, "");
  if (!body) return null;
  try {
    return new RegExp(body, "i");
  } catch {
    return null;
  }
}

/**
 * 识别一批节点名里实际有哪些国家：某国只要有一个节点命中即算存在。
 * 命中条件与分组的成员筛选一致：关键词子串（含城市名）或该国的 filter 正则。
 * 没有任何国家信息的节点不属于任何国家，不参与结果。
 */
export function detectNodeCountries(nodeNames: string[]): Set<NodeRegion> {
  const present = new Set<NodeRegion>();
  const compiled = REGION_PRESETS.filter((preset) => preset.id !== "other").map((preset) => ({
    id: preset.id,
    keywords: preset.keywords.map((keyword) => keyword.toLowerCase()),
    filterRe: compileCountryFilterRegex(preset.filter),
  }));
  for (const name of nodeNames) {
    if (typeof name !== "string" || !name.trim()) continue;
    const normalized = name.toLowerCase();
    for (const country of compiled) {
      if (present.has(country.id)) continue;
      if (country.keywords.some((keyword) => keyword && normalized.includes(keyword))) {
        present.add(country.id);
        continue;
      }
      if (country.filterRe && country.filterRe.test(name)) present.add(country.id);
    }
  }
  return present;
}

function stripCountryNameSuffix(value: string): string {
  const trimmed = value.trim();
  if (trimmed.endsWith("节点")) return trimmed.slice(0, -2).trim();
  return trimmed;
}

/**
 * 按用户填的国家名称匹配已知地区：先精确匹配 label（如“英国”），
 * 再匹配 keywords（如“UK”“France”“伦敦”，拉丁字母不区分大小写）。
 * “other”没有 keywords，不参与匹配。
 */
export function matchRegionForCountryName(name: string): NodeRegion | null {
  if (typeof name !== "string") return null;
  const stripped = stripCountryNameSuffix(name);
  if (!stripped) return null;
  const byLabel = REGION_PRESETS.find((preset) => preset.label === stripped);
  if (byLabel) return byLabel.id;
  const lowered = stripped.toLowerCase();
  const byKeyword = REGION_PRESETS.find(
    (preset) =>
      preset.id !== "other" &&
      preset.keywords.some((keyword) => keyword.toLowerCase() === lowered),
  );
  return byKeyword ? byKeyword.id : null;
}

/**
 * 反查一个分组对应的国家：先看 regions，再按名字匹配，
 * 最后按自定义表达式与地区派生 filter 比对。都对不上返回 null。
 * 用来判定“这是不是一个能对应到国家列表的国家分组”（比如默认挂 use:、自动同步），
 * 与 isCountryProxyGroup 的宽松判定（url-test 且有 regions/includeRegex）不同。
 */
export function resolveCountryGroupRegion(group: CustomProxyGroup): NodeRegion | null {
  const advanced = normalizeProxyGroupAdvancedConfig(group.advanced);
  const regions = advanced.regions ?? [];
  if (regions.length > 0 && regions[0] !== "other") return regions[0];
  const byName = matchRegionForCountryName(group.name);
  if (byName) return byName;
  const expression = advanced.includeRegex?.trim();
  if (expression) {
    const stripped = expression.replace(/^\(\?i\)/, "");
    const byExpression = REGION_PRESETS.find((preset) => {
      if (preset.id === "other") return false;
      const derived = buildRegionFilterRegex([preset.id]);
      return derived !== undefined && derived.replace(/^\(\?i\)/, "") === stripped;
    });
    if (byExpression) return byExpression.id;
  }
  return null;
}

export function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 由地区预设派生 proxy-providers 的 filter 正则。
 * - 有本地原文 filter 的地区用原文（去掉 (?i) 前缀后拼合）
 * - 其余地区用 keywords 派生
 * - "other" 无法用正向正则表达，跳过
 */
export function buildRegionFilterRegex(regions: NodeRegion[]): string | undefined {
  const normalized = normalizeRegions(regions);
  const parts: string[] = [];
  for (const region of normalized) {
    if (region === "other") continue;
    // normalizeRegions 已保证 region 一定在预设里
    const preset = REGION_PRESETS.find((item) => item.id === region)!;
    if (preset.filter) {
      const body = preset.filter.replace(/^\(\?i\)/, "");
      if (body) parts.push(body);
      continue;
    }
    for (const keyword of preset.keywords) {
      const trimmed = keyword.trim();
      if (trimmed) parts.push(escapeRegexLiteral(trimmed));
    }
  }
  if (parts.length === 0) return undefined;
  return `(?i)${parts.join("|")}`;
}

/**
 * 解析一个组在 proxy-providers 模式下的 filter 字段。
 * - includeRegex 优先（原样输出，与 YAML 导入的 filter → includeRegex 对称）
 * - 否则由 regions 派生
 * - excludeRegex 一律输出为 exclude-filter
 * 无 provider 时返回空对象（filter 只对 provider 生效）。
 */
export function resolveProviderFilterFields(
  advanced: ProxyGroupAdvancedConfig | undefined,
  hasProviders: boolean
): { filter?: string; "exclude-filter"?: string } {
  if (!hasProviders) return {};
  const normalized = normalizeProxyGroupAdvancedConfig(advanced);
  const out: { filter?: string; "exclude-filter"?: string } = {};
  if (normalized.includeRegex) {
    out.filter = normalized.includeRegex;
  } else {
    const derived = buildRegionFilterRegex(normalized.regions ?? []);
    if (derived) out.filter = derived;
  }
  if (normalized.excludeRegex) out["exclude-filter"] = normalized.excludeRegex;
  return out;
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function normalizeRegions(value: unknown): NodeRegion[] {
  if (!Array.isArray(value)) return [];
  const out: NodeRegion[] = [];
  const seen = new Set<NodeRegion>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const key = item.trim().toLowerCase() as NodeRegion;
    if (!NODE_REGIONS.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function normalizeGroupType(value: unknown): ProxyGroupGroupType | null {
  if (
    value === "select" ||
    value === "url-test" ||
    value === "fallback" ||
    value === "load-balance" ||
    value === "direct-first" ||
    value === "reject-first"
  ) {
    return value;
  }
  return null;
}

export function normalizeProxyGroupMemberRef(value: unknown): ProxyGroupMemberRef | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (item.kind === "direct") return { kind: "direct" };
  if (item.kind === "reject") return { kind: "reject" };
  if (item.kind === "node" && typeof item.name === "string" && item.name.trim()) {
    return { kind: "node", name: item.name.trim() };
  }
  if (item.kind === "module" && typeof item.id === "string" && item.id.trim()) {
    return { kind: "module", id: item.id.trim() };
  }
  if (item.kind === "custom" && typeof item.id === "string" && item.id.trim()) {
    return { kind: "custom", id: item.id.trim() };
  }
  return null;
}

function normalizeMemberList(value: unknown): ProxyGroupMemberRef[] {
  if (!Array.isArray(value)) return [];
  const out: ProxyGroupMemberRef[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const ref = normalizeProxyGroupMemberRef(item);
    if (!ref) continue;
    const key = getProxyGroupMemberKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

export function normalizeGroupTestUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
      ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}

export function normalizeProxyGroupAdvancedConfig(value: unknown): ProxyGroupAdvancedConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const item = value as Record<string, unknown>;
  const sourceIds = normalizeStringList(item.sourceIds);
  const regions = normalizeRegions(item.regions);
  const includeRegex = typeof item.includeRegex === "string" ? item.includeRegex.trim() : "";
  const excludeRegex = typeof item.excludeRegex === "string" ? item.excludeRegex.trim() : "";
  const groupType = normalizeGroupType(item.groupType);
  const strategy = groupType === "load-balance" && isLoadBalanceStrategy(item.strategy)
    ? item.strategy
    : groupType === "load-balance"
      ? DEFAULT_LOAD_BALANCE_STRATEGY
      : undefined;
  const extraMembers = normalizeMemberList(item.extraMembers);
  const excludedMembers = normalizeMemberList(item.excludedMembers);
  const memberOrder = normalizeMemberList(item.memberOrder);
  const testUrl = normalizeGroupTestUrl(item.testUrl);
  const tolerance =
    typeof item.tolerance === "number" &&
    Number.isInteger(item.tolerance) &&
    item.tolerance >= 0 &&
    item.tolerance <= 3600000
      ? item.tolerance
      : undefined;
  const providerOnly = item.providerOnly === true;
  const useProviders = typeof item.useProviders === "boolean" ? item.useProviders : undefined;
  return {
    ...(testUrl ? { testUrl } : {}),
    ...(sourceIds.length > 0 ? { sourceIds } : {}),
    ...(regions.length > 0 ? { regions } : {}),
    ...(includeRegex ? { includeRegex } : {}),
    ...(excludeRegex ? { excludeRegex } : {}),
    ...(groupType ? { groupType } : {}),
    ...(strategy ? { strategy } : {}),
    ...(extraMembers.length > 0 ? { extraMembers } : {}),
    ...(excludedMembers.length > 0 ? { excludedMembers } : {}),
    ...(memberOrder.length > 0 ? { memberOrder } : {}),
    ...(tolerance !== undefined ? { tolerance } : {}),
    ...(providerOnly ? { providerOnly: true } : {}),
    ...(useProviders !== undefined ? { useProviders } : {}),
  };
}

/**
 * 国家分组：本质上仍是自定义代理组（url-test，按表达式筛节点），只是在
 * “国家分组”区里单独管理。判断条件不依赖 memberSource——YAML 模板读回的
 * 分组不带 memberSource 字段，仍应认作国家分组。
 */
export function isCountryProxyGroup(group: CustomProxyGroup): boolean {
  if (group.groupType !== "url-test") return false;
  const advanced = normalizeProxyGroupAdvancedConfig(group.advanced);
  return (advanced.regions?.length ?? 0) > 0 || Boolean(advanced.includeRegex?.trim());
}

function buildMemberFromName(
  name: string,
  options: {
    nodeNameSet: Set<string>;
    moduleNameToId: Map<string, string>;
    customNameToId: Map<string, string>;
  }
): ProxyGroupResolvedMember | null {
  const trimmed = name.trim();
  if (!trimmed) return null;

  let ref: ProxyGroupMemberRef | null = null;
  if (trimmed === "DIRECT") ref = { kind: "direct" };
  else if (trimmed === "REJECT") ref = { kind: "reject" };
  else if (options.nodeNameSet.has(trimmed)) ref = { kind: "node", name: trimmed };
  else {
    const moduleId = options.moduleNameToId.get(trimmed);
    if (moduleId) ref = { kind: "module", id: moduleId };
    const customId = options.customNameToId.get(trimmed);
    if (!ref && customId) ref = { kind: "custom", id: customId };
  }

  if (!ref) return null;
  return {
    ref,
    key: getProxyGroupMemberKey(ref),
    name: trimmed,
    kind: ref.kind,
  };
}

function buildMemberFromRef(
  ref: ProxyGroupMemberRef,
  options: {
    nodeNameSet: Set<string>;
    moduleNames: Record<string, string>;
    customGroupsById: Map<string, CustomProxyGroup>;
  }
): ProxyGroupResolvedMember | null {
  const key = getProxyGroupMemberKey(ref);
  if (ref.kind === "direct") return { ref, key, name: "DIRECT", kind: ref.kind };
  if (ref.kind === "reject") return { ref, key, name: "REJECT", kind: ref.kind };
  if (ref.kind === "node") {
    const name = ref.name.trim();
    return name && options.nodeNameSet.has(name) ? { ref: { kind: "node", name }, key, name, kind: ref.kind } : null;
  }
  if (ref.kind === "module") {
    const name = options.moduleNames[ref.id]?.trim();
    return name ? { ref, key, name, kind: ref.kind } : null;
  }
  const group = options.customGroupsById.get(ref.id);
  const name = group?.name?.trim();
  return name ? { ref, key, name, kind: ref.kind } : null;
}

function nodePassesAdvancedFilters(
  member: ProxyGroupResolvedMember,
  nodeByName: Map<string, ParsedNode>,
  advanced: ProxyGroupAdvancedConfig
): boolean {
  if (member.ref.kind !== "node") return true;
  const node = nodeByName.get(member.ref.name);
  if (!node) return false;

  const sourceIds = normalizeStringList(advanced.sourceIds);
  if (sourceIds.length > 0) {
    const sourceIdSet = new Set(sourceIds);
    if (!getNodeSourceIds(node).some((id) => sourceIdSet.has(id))) return false;
  }

  const regions = normalizeRegions(advanced.regions);
  if (!matchesRegion(member.ref.name, regions)) return false;

  const includeRe = compileRegex(advanced.includeRegex);
  if (includeRe && !includeRe.test(member.ref.name)) return false;
  const excludeRe = compileRegex(advanced.excludeRegex);
  if (excludeRe && excludeRe.test(member.ref.name)) return false;

  return true;
}

export function resolveProxyGroupMembers(options: ResolveProxyGroupMembersOptions): ResolveProxyGroupMembersResult {
  const advanced = normalizeProxyGroupAdvancedConfig(options.advanced);
  const nodeByName = new Map(options.nodes.map((node) => [node.name, node]));
  const nodeNameSet = new Set(nodeByName.keys());
  const moduleNameToId = new Map<string, string>();
  for (const [id, name] of Object.entries(options.moduleNames || {})) {
    const trimmed = name.trim();
    if (id && trimmed) moduleNameToId.set(trimmed, id);
  }
  const customNameToId = new Map<string, string>();
  const customGroupsById = new Map<string, CustomProxyGroup>();
  for (const group of options.customProxyGroups || []) {
    if (group.enabled === false) continue;
    const name = typeof group.name === "string" ? group.name.trim() : "";
    if (group.id && name) {
      customNameToId.set(name, group.id);
      customGroupsById.set(group.id, group);
    }
  }

  const buildMembersFromNames = (names: string[]) => {
    const out: ProxyGroupResolvedMember[] = [];
    const seen = new Set<string>();
    for (const rawName of names || []) {
      if (typeof rawName !== "string") continue;
      const member = buildMemberFromName(rawName, { nodeNameSet, moduleNameToId, customNameToId });
      if (!member || seen.has(member.key)) continue;
      if (options.self && member.key === `${options.self.kind}:${options.self.id}`) continue;
      seen.add(member.key);
      out.push(member);
    }
    return out;
  };

  const defaultCandidates = buildMembersFromNames(options.defaultProxyNames || []);
  const availableCandidates = buildMembersFromNames(options.availableProxyNames || options.defaultProxyNames || []);
  const availableByKey = new Map(availableCandidates.map((member) => [member.key, member]));
  const candidateMap = new Map(defaultCandidates.map((member) => [member.key, member]));

  for (const ref of advanced.extraMembers || []) {
    const member = availableByKey.get(getProxyGroupMemberKey(ref)) || buildMemberFromRef(ref, {
      nodeNameSet,
      moduleNames: options.moduleNames || {},
      customGroupsById,
    });
    if (!member || candidateMap.has(member.key)) continue;
    if (options.self && member.key === `${options.self.kind}:${options.self.id}`) continue;
    candidateMap.set(member.key, member);
  }

  const candidates = Array.from(candidateMap.values());
  const extraKeys = new Set((advanced.extraMembers || []).map(getProxyGroupMemberKey));
  const excludedKeys = new Set((advanced.excludedMembers || []).map(getProxyGroupMemberKey));
  const includedBase = candidates.filter((member) => {
    if (excludedKeys.has(member.key)) return false;
    if (extraKeys.has(member.key)) return true;
    return nodePassesAdvancedFilters(member, nodeByName, advanced);
  });

  const byKey = new Map(includedBase.map((member) => [member.key, member]));
  const ordered: ProxyGroupResolvedMember[] = [];
  const used = new Set<string>();
  for (const ref of advanced.memberOrder || []) {
    const key = getProxyGroupMemberKey(ref);
    const member = byKey.get(key);
    if (!member || used.has(key)) continue;
    used.add(key);
    ordered.push(member);
  }
  for (const member of includedBase) {
    if (used.has(member.key)) continue;
    used.add(member.key);
    ordered.push(member);
  }

  const includedKeys = new Set(ordered.map((member) => member.key));
  const excludedSource = availableCandidates.length > 0 ? availableCandidates : candidates;
  const excluded = excludedSource.filter((member) => !includedKeys.has(member.key));

  return {
    included: ordered,
    excluded,
    proxyNames: ordered.map((member) => member.name),
  };
}
