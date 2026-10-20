# 星轨收集者 · WebXR Quest 3 Demo

一个用 Three.js + WebXR 写的小游戏，打包成 Quest 3 可安装的 APK（TWA）。

## 玩法

七个彩色方块在面前环绕。**盯住任意一个方块 0.8 秒**即可收集；戴手柄也可以直接用扳机锁定。限时 60 秒。

## 本地预览

```bash
npm install
npm run serve          # http://localhost:8788
```

桌面浏览器会自动进入 2D 模式（鼠标点击方块收集）。

## 文件结构

| 文件 | 作用 |
| --- | --- |
| `index.html` | 页面骨架、2D HUD、importmap |
| `game.js` | 全部游戏逻辑：场景、手柄、凝视拾取、计时、WebXR 会话 |
| `manifest.webmanifest` | PWA manifest（bubblewrap 会读取它生成 TWA 配置） |
| `sw.js` | Service Worker，network-first 缓存 |
| `vendor/three.*.js` | 本地打包的 three.js 0.186.1（不依赖 CDN） |
| `icon-*.png` | 512/192/maskable 图标 |
| `serve.mjs` | 零依赖静态服务器 |
| `keystore/` | APK 签名 keystore 与密码（**不会**提交到仓库） |

## 部署到 GitHub Pages

```bash
npm run serve          # 另开一个终端
npx gh-pages -d .     # 或手动推送到 gh-pages 分支
```

TWA 需要 `https://<域名>/.well-known/assetlinks.json` 里带上 APK 签名证书的 SHA-256 指纹。
