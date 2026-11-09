import {
  REGION_PRESETS,
  buildRegionFilterRegex,
  escapeRegexLiteral,
  normalizeProxyGroupAdvancedConfig,
} from "@subboost/core/proxy-group-advanced";
import type {
  CustomProxyGroup,
  NodeRegion,
  ProxyGroupAdvancedConfig,
} from "@subboost/core/types/config";
import { DEFAULT_COUNTRY_PROXY_GROUPS } from "@subboost/ui/store/config-store/definitions";

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

/** 该国家组当前生效的表达式：自定义表达式优先，否则由地区派生。 */
export function resolveCountryGroupExpression(group: CustomProxyGroup): string {
  const advanced = normalizeProxyGroupAdvancedConfig(group.advanced);
  if (advanced.includeRegex?.trim()) return advanced.includeRegex.trim();
  return buildRegionFilterRegex(advanced.regions ?? []) ?? "";
}

/**
 * 行内改表达式后要写回 advanced 的补丁。
 * - 清空，或改回与地区派生一致时：清除自定义表达式，恢复按地区派生
 * - 否则：保存为自定义表达式（优先于地区派生）
 */
export function resolveCountryExpressionPatch(
  group: CustomProxyGroup,
  nextValue: string,
): Partial<ProxyGroupAdvancedConfig> {
  const advanced = normalizeProxyGroupAdvancedConfig(group.advanced);
  const derived = buildRegionFilterRegex(advanced.regions ?? []) ?? "";
  const trimmed = nextValue.trim();
  if (!trimmed || trimmed === derived) return { includeRegex: undefined };
  return { includeRegex: trimmed };
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
 * 新增国家时生成分组草稿（不含 id，由 store 生成）。
 * - 能对上已知地区：用该地区的预设名与 regions，表达式由地区派生
 * - 对不上：表达式先按名字自动生成 `(?i)名字`，用户可在行内二次修改
 * 返回 null 表示名字为空。
 */
export function buildCountryGroupDraft(name: string): Omit<CustomProxyGroup, "id"> | null {
  const stripped = stripCountryNameSuffix(name);
  if (!stripped) return null;
  const regionId = matchRegionForCountryName(name);
  if (regionId) {
    // 名字以预置分组为准（本地配置原文，如美国用 🇺🇲、台湾用 🇨🇳、新加坡用“狮城节点”，
    // 与地区预设的 emoji/label 不完全相同）；容差同样沿用预置。
    const preset = DEFAULT_COUNTRY_PROXY_GROUPS.find(
      (item) => normalizeProxyGroupAdvancedConfig(item.advanced).regions?.includes(regionId),
    );
    const presetAdvanced = preset ? normalizeProxyGroupAdvancedConfig(preset.advanced) : {};
    const fallback = REGION_PRESETS.find((item) => item.id === regionId)!;
    return {
      name: preset?.name ?? `${fallback.emoji} ${fallback.label}节点`,
      emoji: "",
      memberSource: "filtered-nodes",
      includeInGroupMembers: true,
      groupType: "url-test",
      advanced: {
        regions: [regionId],
        ...(presetAdvanced.tolerance !== undefined ? { tolerance: presetAdvanced.tolerance } : {}),
      },
    };
  }
  return {
    name: `${stripped}节点`,
    emoji: "",
    memberSource: "filtered-nodes",
    includeInGroupMembers: true,
    groupType: "url-test",
    advanced: { includeRegex: `(?i)${escapeRegexLiteral(stripped)}` },
  };
}
