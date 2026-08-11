# 大雄插件管理桌面版

配套画布：[大雄无限画布](https://github.com/hero8152/Infinite-Canvas)

## 下载和安装

1. 在本目录打开 `大雄插件管理.exe`，点击 GitHub 文件页面右上方的下载按钮。
2. 把下载的 `大雄插件管理.exe` 放进大雄无限画布主目录。
3. 双击运行。

请勿直接在浏览器下载目录或临时目录中运行。插件管理器需要与画布启动文件处于同一主目录。

## 两种画布版本都兼容

### 便携 EXE 版

目录中有：

```text
大雄无限画布.exe
大雄插件管理.exe
plugin_host.py
plugins/
```

双击插件管理器后，它会连接已经运行的画布；如果画布尚未运行，会自动启动 `大雄无限画布.exe`。

### 原始启动器版

目录中有：

```text
大雄插件管理.exe
plugin_host.py
start.bat 或 run.bat
plugins/
```

插件管理器会使用内置 Python 或系统 Python 运行 `plugin_host.py`；如果不可用，再尝试 `start.bat` 或 `run.bat`。

## 第一次安装插件

1. 从仓库 [Releases](https://github.com/heyu1084916812/daxiong-canvas-plugins/releases) 下载插件 ZIP。
2. 点击插件管理器右上角的“安装 ZIP”。
3. 选择下载的 ZIP。
4. 根据提示刷新画布或重启大雄画布。

## 后续一键更新

- 启动时自动检查 GitHub 插件仓库。
- 显示本地版本和最新版本。
- 点击“一键更新”下载并升级。
- 校验体积、SHA-256、插件 ID、版本和核心兼容性。
- 默认保留 `plugin-data/` 中的插件数据。
- 仍然保留本地“升级 ZIP”入口作为备用。

## 源码与构建

源码位于 `source/PluginManagerApp.cs`。在 Windows 上运行 `build.ps1` 即可重新编译，生成文件位于当前目录的 `大雄插件管理.exe`。
