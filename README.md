# dsh-plugin-screenshot

面向模型的「截图」工具插件（[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，Windows 宿主）。

注册一个 `screenshot` 工具，让会话里的 AI 能真正「看见」并展示你的屏幕。

## 功能

- `target: "screen"` — 截取整个虚拟桌面（多显示器拼接）；
- `target: "window"` + `window_title` — 按标题子串（不区分大小写）截取顶级窗口；省略 `window_title` 时截取最近活跃的可见窗口；
- **被遮挡的窗口照常可截**：优先走 `PrintWindow(PW_RENDERFULLCONTENT)`，窗口自己渲染到位图，不依赖是否被盖住；
- **空白帧兜底**：GPU 渲染的应用（RustDesk / Chrome / Electron 等）被遮挡时 `PrintWindow` 可能返回空白帧，插件会采样检测并自动改用「临时前置 + 屏幕拷贝」，截完把你原来的前台窗口切回去；
- **最小化窗口**：先自动还原、截图、再缩回最小化（约 0.8 秒）；
- 从未渲染过内容的隐藏/托盘窗口（无表面）无法截取，会明确报错提示先把它唤起一次；
- `output_path` — 可选，PNG 相对会话工作区保存（默认 `screenshots/screenshot-<时间戳>.png`）。

返回值与内置 `read_image` 同构：`<path>/<type>image</type>` 信封 + 原生图像块，
图片同时通过持久附件服务入库，可在会话里直接查看、之后用 `read_image` 重读、用 `present` 展示。

## 环境要求

- Windows 10/11（截屏依赖 Windows PowerShell 与 user32/System.Drawing）；
- DeepSeek Harness ≥ 0.2.0；
- 当前模型需支持图像输入（返回原生图像块）。

## 安装

```powershell
git clone https://github.com/HsgtLgt/dsh-plugin-screenshot.git
```

然后在 DSH 插件管理（plugin_manager）中执行 `install_bundle`，指向克隆出的目录：

```
file:<克隆目录>/dsh-plugin-screenshot
```

对等依赖 `@deepseek-ai/dsh-tools` / `@deepseek-ai/cordis` 由 DSH 运行时树提供，无需手动安装。
安装/升级后需重启 DSH 应用使工具描述生效。

## 工具 schema

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `target` | `screen` \| `window` | 截图目标，默认 `screen` |
| `window_title` | string | `target=window` 时的标题子串匹配 |
| `output_path` | string | 可选保存路径（相对会话工作区） |

## 实现方式

- 路径解析走 `ctx.fs`（与 read/write 工具同一后端，含 cwd 归一化）；
- 截屏通过 `ctx.subprocess` 调 Windows PowerShell：`System.Drawing CopyFromScreen`
  + `user32 GetWindowRect / PrintWindow(PW_RENDERFULLCONTENT) / ShowWindow / SetForegroundWindow`，
  无任何原生依赖；
- 图片经 `ctx.attachments.saveImage` 持久化，遵守部署的图片字节/像素上限。

## 已知限制

- GPU 硬件渲染的窗口长期被遮挡后，`PrintWindow` 可能拿到**过期帧**（内容是旧的但非空白），
  此时空白检测无法识别，重截一次通常即可；
- 完全没有渲染表面的隐藏/托盘窗口截不了，会报错提示先唤起一次。

## License

[MIT](LICENSE)
