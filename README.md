# DZMWebGameHost (Tauri + Vue 3)

一款轻量级网页游戏主机服务。启动客户端即自动在局域网内创建游戏服务，同一网络下的手机、平板、电脑等设备只需打开浏览器即可加入游戏，无需安装任何应用，随开随玩，开箱即用。

## 环境要求

- Node.js >= v22.12.0
- Rust >= 1.84.0（含 cargo）
- [Tauri 系统依赖](https://tauri.app/start/prerequisites/)（macOS 需 Xcode Command Line Tools，Windows 需 WebView2 + MSVC）

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

---

辅助文档：https://juejin.cn/post/7602544700475752458
