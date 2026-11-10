# SubBoost v2.11.19

## 中文

- 设置页“系统更新”卡片现在能实时看到更新进度：更新进行中时，卡片里直接显示更新日志的实时尾部（每 4 秒刷新，自动滚动到底），顶部还有一行最新进度（如 `df81fddd1aae Downloading 115.3MB`），不用再到终端 `tail` 日志。更新失败时也能看到同样的日志，方便定位原因。
- 实现上是接口直接读宿主更新器持续追加的 `update.log`（和状态文件在同一个 `/ops` 目录，容器内可读），不再用状态文件里安装时留下的旧 `logTail`；日志文件默认 644，容器内 node 用户可读，无需改更新脚本。

## English

- The settings "System update" card now shows live update progress: while an update is running, the card displays the live tail of the update log (refreshed every 4 seconds, auto-scrolled to the bottom), with the latest progress line on top (e.g. `df81fddd1aae Downloading 115.3MB`), so there is no need to `tail` the log in a terminal. The same log is shown when an update fails, to help locate the cause.
- Implementation: the API reads `update.log`, which the host updater keeps appending (same `/ops` directory as the status file, readable from the container), instead of the stale `logTail` left in the status file at install time. The log file is 644 by default, readable by the in-container node user, so no updater script change was needed.

# SubBoost v2.11.18

## 中文

- 预览里手动改过的 YAML 现在能进订阅了：保存订阅时，改过的版本会随配置一起存下来，订阅链接直接下发改过的 YAML（冻结快照），而不是按结构化配置重新生成。保存对话框的注意事项里会提示这一点。
- 行为说明：改过一次后，之后改分组/规则不会影响已保存的订阅，直到重新保存且没有手动编辑（那次保存会清掉手动版本、恢复按结构化配置生成）。自动更新刷新节点时手动版本会保留，仍下发改过的 YAML。
- 编辑已保存的订阅时，预览会还原成当时手动改过的版本；改了结构化配置后预览重新生成，手动版本随之清掉（和 2.11.17 的预览规则一致）。

## English

- A manually edited preview YAML now flows into saved subscriptions: when you save a subscription, the edited version is stored with the config and the subscription link serves it as-is (a frozen snapshot) instead of regenerating from the structured config. The save dialog notes this.
- Semantics: once saved with edits, later group/rule changes do not affect the saved subscription until you re-save without manual edits (that save clears the edited version and restores generation from the structured config). Auto-update node refreshes keep the edited version, which continues to be served.
- Editing a saved subscription restores the preview to the previously edited YAML; changing the structured config regenerates the preview and clears the manual version (same rule as v2.11.17).

# SubBoost v2.11.17

## 中文

- 预览的 YAML 现在可以直接改：YAML 预览右上角多了“编辑”按钮，点开后在同一个深色面板里直接改文本（Tab 键插两个空格，不会跳走焦点），点“完成”回到语法高亮。改过后预览区显示“已编辑”，“下载配置”下载的就是改过的版本；“恢复生成结果”可以丢弃改动、回到生成结果。
- 注意：编辑只影响预览和下载的文本，不会同步回左侧的结构化配置（分组、规则、订阅链接仍按结构化配置生成）。改动配置、点“生成”、撤销/重做时，预览会重新生成，之前的编辑会被清掉。

## English

- The previewed YAML is now editable: the YAML preview has an "Edit" button at its top right, opening an editor in the same dark panel (Tab inserts two spaces instead of moving focus); "Done" returns to the syntax-highlighted view. After editing, the preview shows an "edited" badge and "Download config" downloads the edited text; "Restore generated" discards the edits and returns to the generated output.
- Note: editing only affects the previewed and downloaded text — it is not written back into the structured config on the left (groups, rules, and subscription links still generate from the structured config). When the config changes, Generate is clicked, or undo/redo runs, the preview regenerates and any edits are discarded.

# SubBoost v2.11.16

## 中文

- 修复订阅链接填入后国家分组没有反应的问题：之前订阅链接默认走 proxy-providers 模式，站点从不拉取订阅内容，store 里没有任何节点，2.11.15 的自动同步也就永远触发不了。现在填入订阅链接后会做一次尽力预解析（停下输入 800ms 后触发，手动点“导入”也会触发）：只识别订阅里节点的国家，不把节点存入 store、不影响生成配置；识别出的国家参与国家分组同步——有该国节点的分组启用、没有的禁用、没有的国家自动新建分组。预解析失败（如订阅拉不到）不影响导入本身，该订阅只不参与国家同步。
- 批量导入（生成配置时）同样会对 provider 模式订阅做预解析识别国家。

## English

- Fixed country groups not reacting when a subscription link is entered: subscription links default to proxy-providers mode, in which the site never fetched the subscription content, so the store had no nodes and the v2.11.15 auto-sync could never trigger. Now, entering a subscription link triggers a best-effort pre-parse (800ms after typing stops, or when Import is clicked): it only detects the countries of the subscription's nodes, without storing nodes or affecting the generated config; the detected countries take part in country-group sync — groups with nodes enable, those without disable, and missing countries get a group auto-created. A failed pre-parse (e.g. the subscription cannot be fetched) does not affect the import itself; that subscription simply does not take part in country sync.
- Batch import (when generating a config) now also pre-parses provider-mode subscriptions to detect countries.

# SubBoost v2.11.15

## 中文

- 国家分组现在按节点自动同步：每次订阅刷新或节点变化时，系统从节点名字里识别国家（共用同一份 57 国列表），有该国节点的分组自动启用，没有的自动禁用（分组保留在列表里、变灰显示“已禁用”，不生成进配置），节点里出现此前没有的国家时自动新建该国分组（表达式按国家名自动生成，可改）。手动删掉的国家分组，只要对应国家节点还在，下次同步会重新加回来；手动禁用的分组，下次节点变化时若该国仍有节点也会重新启用。节点名字里没有任何国家信息的节点不参与分组。
- 国家分组现在默认挂 `use:`：国家分组的 `use:` 默认随订阅 provider 挂上（可在组的高级设置里选“从不挂 use:”退出），其他非国家分组仍默认不挂。
- 生成的配置里，顶部空的 `proxies:` 现在明确写成 `proxies: []`。

## English

- Country groups now auto-sync with nodes: whenever a subscription refreshes or nodes change, the system detects countries from node names (one shared 57-country list), enables groups whose country has nodes, disables those without (the group stays in the list, dimmed with a "disabled" badge, and is not generated into the config), and auto-creates a country group (with an auto-generated, editable expression) for a node country that has none. A manually deleted country group is re-added on the next sync while its nodes exist; a manually disabled one is re-enabled on the next node change if its country still has nodes. Nodes whose names carry no country information join no group.
- Country groups now attach `use:` by default: country groups attach `use:` to the subscription provider unless opted out in the group's advanced settings ("never attach use:"); other non-country groups still default to not attaching it.
- The generated config now renders the empty top-level `proxies:` explicitly as `proxies: []`.

# SubBoost v2.11.14

## 中文

- 网页端更新不再“假成功”：之前发布清单下载失败时，更新器会静默退回“只重拉当前镜像”，退出码仍为 0，网页于是显示更新完成、版本却一动没动。现在清单地址已配置但下载失败时，更新直接报错退出，网页端会显示失败原因和日志，不会再误报成功。没有配置清单地址时仍保留原来的只更新当前镜像行为。
- 设置页系统更新卡片的成功提示不再写死：更新成功后只有在确实没有新版本时才显示“当前已是最新版本”，如果仍有新版本，会显示“仍有新版本 vX 可更新”。

## English

- Website updates no longer report a false success: when the release manifest download failed, the updater used to silently fall back to re-pulling the current image and exit 0, so the website showed the update as complete while the version never moved. Now, when a release URL is configured but the manifest cannot be downloaded, the update fails loudly and the website shows the failure reason and log tail instead of a false success. When no release URL is configured, the previous current-image-only behavior is kept.
- The success message on the settings update card is no longer hardcoded: after a successful update it only says "already the latest version" when there genuinely is no newer version; if a newer version is still available, it says a newer version vX is still available for update.

# SubBoost v2.11.13

## 中文

- 分流代理组的 `use:` 默认改为从不挂：只有在组的高级设置里把“订阅 provider（use:）”明确选为“始终挂 use:”的组才会挂 `use:`，其余分组默认都不挂；之前已明确设为“始终挂”的组不受影响。无订阅 provider（内联节点模式）时行为不变。注意：订阅模式下靠 provider 节点筛成员的组（如国家分组、自动选择）需要挂 `use:` 才有成员和 `filter:`，不挂时会是空组——这类组请在卡片里单独选“始终挂 use:”。另外，生成器现在不再输出空的 `proxies: []`（以前只对挂 `use:` 的组省略）。
- 已启用成员列表里，国家分组的成员标签现在显示为“国家分组”，不再显示为“自定义组”。
- 去掉了所有分组高级设置里的“地区”选择：地区筛选现在只通过表达式（国家分组区的表达式输入框，或“包含正则”）来设置；已保存配置里的地区数据不受影响，仍会按原来的表达式参与生成。

## English

- `use:` is no longer attached to proxy groups by default: only groups whose advanced setting explicitly selects "always attach use:" get `use:`; every other group defaults to not attaching it. Groups already set to "always attach" are unaffected, and inline-node mode is unchanged. Note: in provider mode, groups that take members from the provider (e.g. country groups, auto-select) need `use:` to have members and `filter:` — without it they generate as empty groups, so select "always attach use:" on those cards. The generator also no longer emits empty `proxies: []` for any group (previously only omitted for groups with `use:`).
- In the enabled-members list, country groups now carry the "国家分组" tag instead of "自定义组".
- Removed the region picker from every group's advanced settings: region filtering is now done through expressions only (the expression input in the country-groups section, or "include regex"). Regions already saved in a config are untouched and still contribute to generation as before.

# SubBoost v2.11.12

## 中文

- 根治网页端更新报“无法记录更新状态”的问题：更新状态文件（`/ops/update-status.json`）由网站（`node` 用户）与宿主机 updater（root）轮流写，之前 root 写完后网站就写不了，下次点更新还没开始就失败。现在 updater 每次写完状态文件都会把它改回网站用户所有（改不了时退到所有人可写），网站端不再被锁在外面。之前遇到这个报错时，删掉该状态文件即可恢复（网站下次点更新时会重建）。

## English

- Fixes the root cause of the in-site update error "failed to record update status": the update status file (`/ops/update-status.json`) is written alternately by the website (`node` user) and the host updater (root), and after root wrote it the website could no longer overwrite it, so the next web update failed before starting. The updater now hands the file back to the website user after every write (falling back to world-writable when chown is unavailable). If you hit this error on an older version, deleting the status file restores it (the website recreates it on the next update request).

# SubBoost v2.11.11

## 中文

- 分流代理组的 `use:` 默认改为全部挂：所有分组（测速/兜底/负载均衡/服务组/节点选择/自定义分组等）在有订阅 provider 时默认都挂 `use:`，不再只给消费节点的组挂；如需某组不挂，在该组的高级设置里把“订阅 provider（use:）”选为“从不挂 use:”即可，之前已明确设为“从不”的组不受影响。无订阅 provider（内联节点模式）时行为不变。

## English

- `use:` is now attached to all proxy groups by default: whenever a subscription provider exists, every group (url-test, fallback, load-balance, service groups, node selection, custom groups, etc.) gets `use:` instead of only node-consuming groups; to exclude a group, set its "Subscription provider (use:)" to "Never attach use:" in that group's advanced settings — groups already set to never are unaffected. Behavior is unchanged when there is no subscription provider (inline-node mode).

# SubBoost v2.11.10

## 中文

- 国家分组从自定义分组里独立出来：分流代理组配置新增“国家分组”分类标签（排在自定义分组之前），12 个预置国家（及之后新增的国家）都放在这里，带顶部的国家分组区（改表达式、新增国家）；自定义分组标签里只剩非国家分组。国家分组仍是普通自定义分组，改名、规则、高级设置都在国家分组标签内的卡片上改；两个标签的计数各算各的，新建配置默认展开国家分组。

## English

- Country groups are no longer listed under custom groups: the proxy-group config now has a dedicated "Country groups" category tab (placed before custom groups) holding the 12 preset countries (and any countries added later), with the country-groups section at the top (edit expressions, add countries); the custom-groups tab only shows non-country groups. Country groups remain ordinary custom groups — rename, rules and advanced settings live on their cards inside the country tab; each tab counts its own groups, and a fresh config expands the country tab by default.

# SubBoost v2.11.9

## 中文

- 分流代理组配置里新增独立的“国家分组”区：新建配置默认预置 12 个国家（香港、日本、美国、台湾、新加坡、韩国、英国、法国、澳大利亚、德国、加拿大、荷兰），名字与表达式沿用本地配置格式（如美国 🇺🇲、台湾 🇨🇳、新加坡“狮城节点”，美国容差 150）；每行直接改该国的筛选表达式，清空后恢复按地区自动派生；新增国家时按填的名字自动生成表达式（对得上已知地区用该地区的预设表达式，对不上先生成 `(?i)名字`），生成后可二次修改；重名会提示，不会重复添加。国家分组仍是普通自定义分组，改名、规则、高级设置见下方自定义分组。
- 英国、法国、澳大利亚、德国、加拿大、荷兰的地区表达式补为本地格式（如德国 `(?i)德|de|germany`）。

## English

- The proxy-group config now has a dedicated "Country groups" section: a new config presets 12 countries (Hong Kong, Japan, US, Taiwan, Singapore, Korea, UK, France, Australia, Germany, Canada, Netherlands) with names and expressions following the local config format (e.g. US 🇺🇲, Taiwan 🇨🇳, Singapore "狮城节点", US tolerance 150); each row edits that country's filter expression inline, and clearing it falls back to the region-derived one; adding a country auto-generates its expression from the typed name (a known region uses its preset expression, otherwise `(?i)<name>` is generated first), editable afterwards; duplicates are warned about instead of added. Country groups remain ordinary custom groups — rename, rules and advanced settings live in the custom-group cards below.
- Region expressions for the UK, France, Australia, Germany, Canada and Netherlands now use the local format (e.g. Germany `(?i)德|de|germany`).

# SubBoost v2.11.8

## 中文

- 修复 proxy-providers 模式下分流代理组里点选未启用成员无效的问题：订阅走 provider 模式时站内不拉取节点，面板里“节点为空就清空已启用成员”的旧逻辑会把已生成组里的代理组成员（DIRECT / 自动选择 / 国家分组等）也一并藏掉，导致未启用栏点谁都加不进已启用栏。现在已启用成员直接按生成结果显示，点选可正常追加。

## English

- Fixed selecting a disabled member in a proxy group doing nothing in proxy-providers mode: with provider mode the site fetches no nodes, and the panel's old "no nodes means no included members" shortcut also hid generated proxy-group members (DIRECT / auto-select / country groups), so clicking any disabled member never moved it to the included list. Included members now follow the generated result, and clicking adds members normally.

# SubBoost v2.11.7

## 中文

- 更新下载更耐网络波动：下载清单、compose 与 manager 文件时失败会自动重试 3 次（间隔 2 秒），GitHub 偶发 504 不会一次就让更新走降级分支；最后一次失败的 curl 错误会写进更新日志，不再被吞掉，方便定位是网络问题还是地址问题。

## English

- Updates are now resilient to flaky downloads: fetching the release manifest, compose file and manager retries up to 3 times (2s apart), so a transient GitHub 504 no longer drops the update into the fallback branch; the final curl error is written to the update log instead of being swallowed, making it clear whether the failure is network or URL related.

# SubBoost v2.11.6

## 中文

- 首页默认不再自动添加 YAML 配置 #2 和节点链接 #3 输入框：新建配置时只有订阅链接 #1，需要时再通过“添加导入源”自行加。
- 默认预置国家分组：新建配置自带香港、日本、美国、台湾、狮城、韩国 6 个国家组（与本地配置一致，含地区表达式与美国容差 150），默认进节点选择，不用每次手动添加；仍是普通自定义组，可改名、改地区/容差、可删除。

## English

- The home page no longer auto-adds the YAML config (#2) and node links (#3) input boxes: a new config starts with only the subscription link (#1); add the others via "Add import source" when needed.
- Country groups are now preset by default: a new config includes the Hong Kong, Japan, US, Taiwan, Singapore and Korea groups (matching the local config, including region expressions and US tolerance 150), included in node selection by default, so they no longer need manual adding every time; they remain ordinary custom groups that can be renamed, retuned or deleted.

# SubBoost v2.11.5

## 中文

- 订阅链接默认走 proxy-providers 模式：不再在站内拉取/解析节点，生成的配置里写 `proxy-providers` 供客户端拉取；provider 按顺序命名为 `my_sub`、`my_sub_2`……，路径为 `./proxies/my_sub.yaml`。已配好的订阅链接（未显式关闭该模式）也会自动切过去；想看节点列表时可把单个源切回内联模式。
- 国家组按本地配置格式输出：地区组（url-test）在 provider 模式下输出 `use:` + `filter:`（如香港 `(?i)港|hk|hongkong|hong kong`），不再列出节点名；德国、加拿大、荷兰等地区同样按表达式自动分组（新增荷兰预设）。url-test 组默认容差 50（美国组可单独配 150），不再输出 `lazy: false`，仅用 `use:` 取节点的组不再输出空的 `proxies: []`。
- `use:` 默认只挂在消费节点的组上（测速/兜底/负载均衡、仅订阅取节点的组）；节点选择、服务组等默认不再挂 `use:`。每组的高级设置里可以单独改：默认/始终挂/从不挂，以及“仅从订阅取节点”（用于“手动切换”类分组）。
- 上传本地 Clash YAML 为模板时，`use:`/`filter`/`tolerance` 会保留到模板里（`my_sub` 引用不再警告），保存模板后再使用也能读回。

## English

- Subscription links now default to proxy-providers mode: nodes are no longer fetched/parsed in SubBoost; the generated config writes `proxy-providers` for the client to fetch. Providers are named sequentially `my_sub`, `my_sub_2`, …, with paths `./proxies/my_sub.yaml`. Existing subscription links (that did not explicitly opt out) migrate automatically; switch a single source back to inline mode to see its node list again.
- Country groups now follow the local config format: region groups (url-test) in provider mode emit `use:` + `filter:` (e.g. Hong Kong `(?i)港|hk|hongkong|hong kong`) instead of listing node names; Germany, Canada, the Netherlands and other regions group by expression the same way (Netherlands preset added). url-test groups default to tolerance 50 (US can be set to 150 separately), no longer emit `lazy: false`, and groups that only use `use:` no longer emit an empty `proxies: []`.
- `use:` is attached by default only to node-consuming groups (url-test/fallback/load-balance and provider-only groups); the select group, service groups and others no longer get it by default. Each group's advanced settings can override this (default/always/never), plus a "provider nodes only" switch for manual-switch style groups.
- Uploading a local Clash YAML as a template now preserves `use:`/`filter`/`tolerance` in the template (`my_sub` references no longer warn), so saved templates round-trip the country groups.

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
