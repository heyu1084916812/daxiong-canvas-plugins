# 大雄无限画布插件仓库

该仓库是大雄无限画布插件管理器的官方更新源。

## 插件管理器

`plugin-manager/` 提供 Windows 桌面版“大雄插件管理”。下载 `大雄插件管理.exe` 后，将它放到大雄无限画布主目录（与 `大雄无限画布.exe`、`plugin_host.py` 同级）再运行。

桌面版会自动检查本仓库的插件更新索引，并提供一键更新；同时保留本地 ZIP 安装和升级入口。

## 发布插件

1. 修改 `plugins/<插件ID>/` 中的源码。
2. 将 `plugin.json` 的 `version` 提升为新的 `x.y.z` 版本。
3. 可在 `plugin.json` 中填写 `release_notes` 字符串数组。
4. 提交并推送到 `main` 分支。
5. GitHub Actions 会校验插件、创建标准 ZIP、发布 GitHub Release，并更新 `updates` 分支中的 `plugins-index.json`。

已经发布过的版本不会被覆盖。如需修正，请提升版本号后重新发布。

## 安全边界

发布包不会包含测试目录、缓存、日志、运行数据、图片结果或 `plugin-data`。插件管理器下载后还会校验文件大小、SHA-256、插件 ID、版本号和主程序兼容性。
