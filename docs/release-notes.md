# SubBoost v2.11.4

## 中文

- 模板库支持真正的 YAML 上传：选择本地 Clash YAML 文件即可导入为站内模板，自动生成除节点以外的分组、规则、规则集与 DNS 配置（节点只计个数、不导入；与内置分组同名的分组会改写该内置分组的高级配置）。上传失败或部分内容跳过时会有提示。
- 首页“上传模板”改名为“保存模板”（仍是把当前配置保存为模板）。
- 首页输入源默认只展开订阅链接，YAML 配置与节点链接两个框默认折叠（显示已填行数，点击展开）。

## English

- The template library now supports real YAML uploads: pick a local Clash YAML file and it is imported as a site template, generating groups, rules, rule sets, and DNS config except nodes (nodes are only counted, not imported; a group sharing a builtin group's name overrides that builtin group's advanced config). Failures and skipped items are reported.
- The home page "上传模板" button is renamed "保存模板" (still saves the current config as a template).
- Home input sources now start collapsed except the subscription URL: the YAML config and node links boxes show a filled-line count and expand on click.

# SubBoost v2.11.3

## 中文

- 新增站内更新：设置页“系统更新”卡片可检测新版本并一键更新，不用再去服务器终端执行 subboost update。更新沿用原有的更新流程（含数据库备份与失败回滚），更新中会显示进度，服务短暂重启后自动恢复。
- 更新检测改为读取自己的发布清单（SUBBOOST_RELEASE_URL），不再只看上游发布。

## English

- Add in-website updates: the System Update card on the Settings page checks for new releases and updates with one click, no more `subboost update` on the server. Updates reuse the existing update flow (database backup and rollback on failure) and show live progress while the service briefly restarts.
- Release checks now read the fork's own release manifest (SUBBOOST_RELEASE_URL) instead of only upstream releases.

---

# SubBoost v2.11.2

## 中文

- 修复应用“我保存的模板”后首页仍高亮完整版的问题：现在以实际应用的模板为准高亮，“我的模板”卡片会显示已应用的模板名称。
- 修复保存的模板显示 0 规则集的问题：规则数改为按模板实际生成的规则统计（可见代理组的内置规则 + 自定义规则 + 自定义规则集）。

## English

- Fix the home template picker still highlighting the Full builtin after applying a saved template: the highlight now follows the actually applied template, and the My Templates card shows the applied template name.
- Fix saved templates showing 0 rule sets: the count is now derived from the rules the template generates (builtin rules of visible proxy groups + custom rules + custom rule sets).

---

# SubBoost v2.11.1

## 中文

- 修复模板上传丢失内置代理组高级设置的问题：上传模板现在会完整保存各内置分组的高级配置（组类型、负载均衡策略、筛选条件、成员排序等），应用模板后不再还原为默认配置。
- 首页“选择模板”新增“我的模板”入口，可直接选用自己保存的模板。

## English

- Fix template uploads dropping builtin proxy-group advanced settings: uploads now preserve each builtin group's advanced configuration (group type, load-balance strategy, filters, member order), so applying a template no longer resets them to defaults.
- Add a "My Templates" entry to the home template picker for applying saved templates.

---

# SubBoost v2.11.0

## 中文

- 扩展自定义规则，支持更多 Mihomo 规则类型、AND/OR/NOT 逻辑组合及批量导入格式，改进规则参数和目标的保留。
- 新增订阅链接重置，可在订阅设置中更换链接并使旧链接失效。
- 改进规则格式识别、兼容健康检查的共享，以及移动端设置与弹窗布局。
- 改进部分 VLESS Reality 链接的导入兼容性。
- 修复大备份校验误报导致自部署升级中止的问题。

升级提示：如果旧版更新时出现 `read=141 pg_restore=0`，请先使用本次发布附带的独立修复脚本更新管理器，再运行 `subboost update`。修复脚本保留备份校验，不修改数据库和应用配置。

## English

- Expand custom rules with more Mihomo rule types, AND/OR/NOT logical combinations, and batch import formats, with improved preservation of rule parameters and targets.
- Add subscription link reset in subscription settings, replacing the link and invalidating the previous one.
- Improve rule format detection, sharing of compatible health checks, and mobile settings and dialog layouts.
- Improve import compatibility for certain VLESS Reality links.
- Fix false verification failures on large backups that could abort self-hosted updates.

Upgrade note: If an older installation reports `read=141 pg_restore=0` during an update, first use this release's standalone repair script to refresh the manager, then run `subboost update`. The repair script preserves backup verification and does not modify the database or application configuration.
