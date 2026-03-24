# DZMWebGameHost (Tauri + Vue 3)

一款轻量级网页游戏主机服务。启动客户端即自动在局域网内创建游戏服务，同一网络下的手机、平板、电脑等设备只需打开浏览器即可加入游戏，无需安装任何应用，随开随玩，开箱即用。

## 环境要求

- Node.js >= v22.12.0
- Rust >= 1.84.0（含 cargo）
- [Tauri 系统依赖](https://tauri.app/start/prerequisites/)（macOS 需 Xcode Command Line Tools）
- **Windows 额外要求：** 需安装 **Visual Studio Installer**，并勾选工作负载 **「使用 C++ 的桌面开发」**（提供 MSVC、Windows SDK 等，Rust / Tauri 编译原生代码依赖）。另需系统已安装 **WebView2**（Win10/11 通常自带，缺失时按 [Tauri 文档](https://tauri.app/start/prerequisites/) 安装）。

## 启动开发

```bash
npm install
npm run dev:mac   # macOS
npm run dev:win   # Windows
```

## 打包构建

```bash
npm run build:mac   # 输出 .dmg
npm run build:win   # 输出 .exe 安装包
```

## 使用方式

1. 启动客户端，点击 **「启动服务」**
2. 将显示的局域网地址（如 `http://192.168.1.100:3000`）告知同局域网玩家
3. 玩家用浏览器访问该地址即可进入游戏大厅

## 打包修改版本号

需要同时修改以下两处，保持版本一致：

只需修改 `src-tauri/tauri.conf.json` 中的 `"version"` 字段即可：

```json
"version": "x.x.x"
```

该字段直接控制 dmg/exe 输出文件名及系统「关于此应用」中显示的版本号，修改后重新打包即生效（如 `DZMWebGameHost_0.2.0_aarch64.dmg`）。

> `src-tauri/Cargo.toml` 中也有 `version`，但那是 Rust 包版本，不影响打包结果，建议跟着一起改保持一致即可，非必须。

## 应用图标（Logo）

**放哪：** 源图放在 **`src-tauri/icons/icon.png`**（覆盖同名文件即可）。  
**规格：** 建议 **1024×1024 像素** 的 **标准 PNG**（RGBA 透明底或纯色底均可；macOS 会自己加圆角，源图不必裁圆角）。

**一键生成（macOS + Windows 共用）：** 在项目根目录执行：

```bash
npm run tauri icon src-tauri/icons/icon.png
```

也可先用任意路径的源图生成到默认的 `src-tauri/icons/`：

```bash
npm run tauri icon /你的路径/logo.png
```

生成后会更新 `icon.png`、`icon.icns`（macOS）、`icon.ico`（Windows）及各尺寸 `Square*.png` 等，与 `tauri.conf.json` 里 `bundle.icon` 配置一致。改完图标后重新执行 **打包构建** 即可。

**常见错误1：** 若出现 `Invalid PNG signature`，说明文件**不是合法 PNG**（例如把 JPG/WebP 强行改名为 `.png`）。请在设计软件或预览里 **「导出为 PNG」** 再替换，勿仅改扩展名。

**常见错误2（Windows）：图标替换后安装包安装完桌面图标仍显示旧图标。**  
这是 Windows 图标缓存未刷新导致的，与打包内容无关。在 PowerShell（管理员）中执行以下命令清除缓存，执行后桌面会短暂消失再恢复，图标即可正确显示：

```powershell
taskkill /f /im explorer.exe
Remove-Item -Force "$env:LOCALAPPDATA\IconCache.db" -ErrorAction SilentlyContinue
Remove-Item -Force -Recurse "$env:LOCALAPPDATA\Microsoft\Windows\Explorer\iconcache*" -ErrorAction SilentlyContinue
Remove-Item -Force -Recurse "$env:LOCALAPPDATA\Microsoft\Windows\Explorer\thumbcache*" -ErrorAction SilentlyContinue
Start-Process explorer.exe
```

---

[Rust 多版本管理](https://blog.csdn.net/zz00008888/article/details/157730032)

[Mac 软件安装问题：未签名应用「已损坏」问题解决方案](https://blog.csdn.net/zz00008888/article/details/157727094)
