# 大雄无限画布插件仓库

这是大雄无限画布的插件、插件安装包和桌面插件管理器仓库。

- 大雄无限画布主仓库：[hero8152/Infinite-Canvas](https://github.com/hero8152/Infinite-Canvas)
- 插件安装包：[Releases](https://github.com/heyu1084916812/daxiong-canvas-plugins/releases)
- Windows 桌面插件管理器：[下载正式版 EXE](https://github.com/heyu1084916812/daxiong-canvas-plugins/releases/tag/plugin-manager-v1.3.1)

## 普通用户如何使用

### 1. 先准备大雄无限画布

从[大雄无限画布主仓库](https://github.com/hero8152/Infinite-Canvas)获取画布。以下两种启动形式都兼容：

- 兼容用户自己封装的exe版
- **原始启动器版**：主目录中有 `main.py`，并通过 `run.bat` 或 Python 启动。

### 2. 安装桌面插件管理器

1. 打开[大雄插件管理 v1.3.1 正式发行版](https://github.com/heyu1084916812/daxiong-canvas-plugins/releases/tag/plugin-manager-v1.3.1)。
2. 在“资源”中下载 `Daxiong-Plugin-Manager.exe`，不要下载 GitHub 自动生成的 `Source code`。
3. 把它放进大雄无限画布主目录，不要放在单独的下载目录。
4. 双击 `Daxiong-Plugin-Manager.exe`（也可以自行改名为“大雄插件管理.exe”）。

副标题下方提供“项目主页”和当前版本号。管理器启动后会自动检查自己的新版；发现新版时主动弹窗，确认后自动下载、校验、替换并重新打开。

如果画布还没有插件系统，点击“接入画布”。插件管理器会从 EXE 内部安装插件后台并生成 `run.bat`，不修改 `main.py`，已有相关文件会先备份到 `data/plugin-system-backups/`。

管理器会直接读取 GitHub 仓库的插件清单，并把全部插件显示为卡片。已经安装的插件显示当前状态和更新按钮；尚未安装的插件显示“一键安装”，用户可以按需选择，不必先手动安装一次。即使画布里还是旧版插件后台，未安装插件也不会再被隐藏。

插件管理器会先连接已经运行的大雄画布；如果后台尚未运行，会自动寻找并使用：

1. `python/python.exe + plugin_host.py` 或系统 Python
2. `大雄无限画布.exe`
3. `run.bat`

### 3. 第一次安装插件

插件管理器会列出仓库中尚未安装的插件，点击“一键安装”即可。只有仓库连接失败时，才需要从 [Releases](https://github.com/heyu1084916812/daxiong-canvas-plugins/releases) 手动下载插件 ZIP，再通过“安装 ZIP”导入。

每个插件都是独立安装包，可以按需安装，不需要一次安装全部插件。

### 4. 以后更新插件

插件安装后，桌面管理器会自动读取本仓库的更新索引：

- 有新版时显示本地版本和最新版本。
- 点击“一键更新”即可下载并升级。
- 下载后会校验文件大小、SHA-256、插件 ID、版本号和主程序兼容性。
- 更新默认保留 `plugin-data/` 中的插件数据。
- 包含后端的插件更新后需要重启大雄画布；纯前端插件刷新画布即可。

## 当前插件

| 插件 | ID | 当前版本 |
|---|---|---:|
| 设计大师 | `canvas-agent` | 2.2.48 |
| 局部提取与图像融合 | `local-patch` | 2.7.1 |
| 长图节点 | `long-image-node` | 1.2.0 |
| 画布 Bug 修复 | `canvas-bug-fix` | 1.8.1 |
| 节点对齐 | `node-align-distribute` | 1.2.1 |

## 插件开发与发布

1. 修改 `plugins/<插件ID>/` 中的源码。
2. 将 `plugin.json` 的 `version` 提升为新的 `x.y.z` 版本。
3. 可在 `plugin.json` 中填写 `release_notes` 字符串数组。
4. 提交并推送到 `main` 分支。
5. GitHub Actions 会校验插件、创建标准 ZIP、发布 GitHub Release，并更新 `updates` 分支中的 `plugins-index.json`。

已经发布过的版本不会被覆盖。如需修正，请提升版本号后重新发布。

## 安全边界

发布包不会包含测试目录、缓存、日志、运行数据、图片结果或 `plugin-data`。插件管理器不会在没有用户确认的情况下静默安装插件更新。
