/**
 * dsh-plugin-screenshot — model-facing `screenshot` tool for DeepSeek Harness (Windows host).
 *
 * Captures either the whole virtual screen (all monitors) or the foreground-visible
 * window whose title contains a needle, saves a PNG under the calling session's
 * workspace, stores it through the durable attachment service, and returns the
 * image itself as a native image block (same envelope shape as `read_image`).
 *
 * Capture is delegated to Windows PowerShell via `ctx.subprocess`
 * (System.Drawing CopyFromScreen + user32 GetWindowRect), so no native
 * dependency is bundled.
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { basename, dirname } from "node:path";

const name = "dsh-plugin-screenshot";
const inject = ["tools", "subprocess", "fs"];

/** Model-facing output schema — mirrors read_image's image value. */
const IMAGE_VALUE_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: true,
	properties: {
		attachmentId: { type: "string", required: true },
		mediaType: { type: "string", enum: ["image/png"], required: true },
		bytes: { type: "integer", required: true },
		width: { type: "integer", required: true },
		height: { type: "integer", required: true },
		name: { type: "string" },
	},
};

function sessionCwd(exec) {
	return exec.agent?.session?.header?.cwd;
}

/** Quote a string as a single-quoted PowerShell literal. */
function psStr(value) {
	return `'${String(value).replace(/'/g, "''")}'`;
}

function localTimestamp() {
	const d = new Date();
	const p = (n, w = 2) => String(n).padStart(w, "0");
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function tailLines(text, maxLines) {
	const lines = String(text ?? "").split(/\r?\n/).filter((l) => l.trim().length > 0);
	return lines.slice(-maxLines).join("\n");
}

/**
 * Build the PowerShell capture script. Prints `OK <width>x<height>` on success.
 * @param {'screen'|'window'} mode
 * @param {string} needle window-title substring (case-insensitive), '' = foreground-most window
 * @param {string} outPath absolute host path of the PNG to write
 */
function buildScript(mode, needle, outPath) {
	const needleExpr = mode === "window" ? psStr(needle) : `''`;
	return [
		`$ErrorActionPreference = 'Stop'`,
		`[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`,
		`Add-Type -AssemblyName System.Drawing`,
		`Add-Type -AssemblyName System.Windows.Forms`,
		`$out = ${psStr(outPath)}`,
		`$dir = Split-Path -Parent $out`,
		`if ($dir) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }`,
		`Add-Type @'`,
		`using System;`,
		`using System.Runtime.InteropServices;`,
		`public class DshShot {`,
		`  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);`,
		`  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);`,
		`  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);`,
		`  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);`,
		`  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);`,
		`  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);`,
		`  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();`,
		`  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);`,
		`  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }`,
		`}`,
		`'@`,
		`function Test-Blank($bmp) {`,
		`  $min = 255.0; $max = 0.0`,
		`  $w = $bmp.Width; $h = $bmp.Height`,
		`  for ($i = 1; $i -le 10; $i++) { for ($j = 1; $j -le 10; $j++) {`,
		`    $c = $bmp.GetPixel([int]($w * $i / 11), [int]($h * $j / 11))`,
		`    $v = ($c.R + $c.G + $c.B) / 3.0`,
		`    if ($v -lt $min) { $min = $v }; if ($v -gt $max) { $max = $v }`,
		`  } }`,
		`  return (($max - $min) -lt 8)`,
		`}`,
		`$bmp = $null`,
		`$method = ''`,
		`if (${psStr(mode)} -eq 'window') {`,
		`  $needle = ${needleExpr}`,
		`  $candidates = @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } |`,
		`    ForEach-Object { [pscustomobject]@{ H = [IntPtr]$_.MainWindowHandle; T = $_.MainWindowTitle } })`,
		`  $picked = $null`,
		`  if ($needle -ne '') {`,
		`    $picked = $candidates | Where-Object { $_.T.ToLower().Contains($needle.ToLower()) } | Select-Object -First 1`,
		`  } elseif ($candidates.Count -gt 0) {`,
		`    $picked = $candidates[$candidates.Count - 1]`,
		`  }`,
		`  if ($null -eq $picked) {`,
		`    $titles = ($candidates | Select-Object -First 20 | ForEach-Object { $_.T }) -join ' | '`,
		`    throw ("no visible window matches title '{0}'. visible windows: {1}" -f $needle, $titles)`,
		`  }`,
		`  $wasMin = [DshShot]::IsIconic($picked.H)`,
		`  if ($wasMin) { [void][DshShot]::ShowWindow($picked.H, 9); Start-Sleep -Milliseconds 800 }`,
		`  try {`,
		`    $r = New-Object DshShot+RECT`,
		`    [void][DshShot]::GetWindowRect($picked.H, [ref]$r)`,
		`    $w = $r.Right - $r.Left`,
		`    $h2 = $r.Bottom - $r.Top`,
		`    if ($w -le 0 -or $h2 -le 0) { throw 'the matched window reports an empty rectangle' }`,
		`    $bmp = New-Object System.Drawing.Bitmap $w, $h2`,
		`    $g = [System.Drawing.Graphics]::FromImage($bmp)`,
		`    $hdc = $g.GetHdc()`,
		`    $ok = [DshShot]::PrintWindow($picked.H, $hdc, 2)`,
		`    $g.ReleaseHdc($hdc)`,
		`    $blank = $false`,
		`    if ($ok) { $blank = Test-Blank $bmp }`,
		`    if ((-not $ok) -or $blank) {`,
		`      if (-not [DshShot]::IsWindowVisible($picked.H)) { throw 'the window never rendered any content (hidden/tray window that owns no surface); bring it up once and retry' }`,
		`      $prev = [DshShot]::GetForegroundWindow()`,
		`      [void][DshShot]::ShowWindow($picked.H, 5)`,
		`      [DshShot]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)`,
		`      [void][DshShot]::SetForegroundWindow($picked.H)`,
		`      Start-Sleep -Milliseconds 700`,
		`      [void][DshShot]::GetWindowRect($picked.H, [ref]$r)`,
		`      $w = $r.Right - $r.Left; $h2 = $r.Bottom - $r.Top`,
		`      if ($bmp.Width -ne $w -or $bmp.Height -ne $h2) { $g.Dispose(); $bmp.Dispose(); $bmp = New-Object System.Drawing.Bitmap $w, $h2; $g = [System.Drawing.Graphics]::FromImage($bmp) }`,
		`      $g.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object System.Drawing.Size $w, $h2))`,
		`      if ($prev -ne [IntPtr]::Zero -and $prev -ne $picked.H) { [void][DshShot]::SetForegroundWindow($prev) }`,
		`      [DshShot]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)`,
		`      $method = 'foreground-fallback'`,
		`    } elseif ($ok) {`,
		`      $method = 'printwindow'`,
		`    } else {`,
		`      $method = 'copyfromscreen'`,
		`    }`,
		`  } finally {`,
		`    if ($wasMin) { [void][DshShot]::ShowWindow($picked.H, 6) }`,
		`  }`,
		`} else {`,
		`  $b = [System.Windows.Forms.SystemInformation]::VirtualScreen`,
		`  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height`,
		`  $g = [System.Drawing.Graphics]::FromImage($bmp)`,
		`  $g.CopyFromScreen($b.X, $b.Y, 0, 0, (New-Object System.Drawing.Size $b.Width, $b.Height))`,
		`  $method = 'copyfromscreen'`,
		`}`,
		`$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)`,
		`$w3 = $bmp.Width; $h3 = $bmp.Height`,
		`$g.Dispose(); $bmp.Dispose()`,
		`Write-Output ("OK {0}x{1} {2}" -f $w3, $h3, $method)`,
	].join("\n");
}

function apply(ctx) {
	ctx.tools.register(
		defineTool({
			name: "screenshot",
			description:
				"Capture a screenshot on the local Windows host and return the image itself. 'screen' captures the whole virtual screen across all monitors; 'window' captures the top-level window whose title contains window_title (or the most recently active visible window when window_title is omitted) — occluded (covered) windows are captured via PrintWindow, and minimized windows are briefly auto-restored, captured, then re-minimized. ROUTING: when the user names a specific app or asks to see an app's content (e.g. '看看 rustdesk 的远程桌面', '截一下微信'), ALWAYS use target='window' with the app name as window_title — do NOT fall back to 'screen', which only catches a sliver of a covered window. Use 'screen' only when the user explicitly wants the whole desktop. The PNG is saved under the session workspace (default screenshots/screenshot-<timestamp>.png), so it can be re-read later with read_image or attached with present. After a successful capture, ALWAYS show the image to the user by embedding it in your reply with Markdown image syntax: ![截图](<the returned path>) — a plain link will NOT render the picture. Windows only.",
			parameters: {
				target: {
					type: "string",
					enum: ["screen", "window"],
					description: "What to capture. Defaults to 'screen' (the whole virtual desktop).",
				},
				window_title: {
					type: "string",
					description:
						"With target=window: case-insensitive substring of the window title to capture, e.g. 'Visual Studio Code'. Omit for the most recently active visible window.",
				},
				output_path: {
					type: "string",
					description:
						"Optional destination path relative to the session workspace, e.g. 'shots/login-page.png'. Defaults to screenshots/screenshot-<timestamp>.png.",
				},
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						path: { type: "string", required: true },
						image: IMAGE_VALUE_SCHEMA,
					},
				},
				render: (_args, value) => [
					{
						type: "text",
						text: `<path>${value.path}</path>\n<type>image</type>\n<content>\n${value.image.mediaType} image, ${value.image.width}x${value.image.height} px, ${value.image.bytes} bytes\n</content>`,
					},
					{
						type: "image",
						attachment: {
							attachmentId: value.image.attachmentId,
							mediaType: value.image.mediaType,
							bytes: value.image.bytes,
							width: value.image.width,
							height: value.image.height,
							...(value.image.name === undefined ? {} : { name: value.image.name }),
						},
					},
				],
				presentationMeta: (_args, value) => ({ path: value.path }),
			},
			isConcurrencySafe: () => false,
			async execute(args, exec) {
				const mode = args.target ?? "screen";
				if (mode !== "screen" && mode !== "window") throw new Error("target must be 'screen' or 'window'");
				if (mode === "window" && args.window_title !== undefined && String(args.window_title).trim().length === 0) {
					throw new Error("window_title must be a non-empty string when given");
				}
				const needle = mode === "window" ? String(args.window_title ?? "") : "";

				const attachments = ctx.get("attachments");
				if (attachments === undefined) {
					throw new Error("cannot take a screenshot: no durable attachment service is mounted; the image could not be stored or returned");
				}

				const displayPath = args.output_path !== undefined && String(args.output_path).trim().length > 0
					? String(args.output_path).trim()
					: `screenshots/screenshot-${localTimestamp()}.png`;

				const target = await ctx.fs.resolve(displayPath, {
					...(sessionCwd(exec) !== undefined ? { cwd: sessionCwd(exec) } : {}),
					signal: exec.signal,
				});
				const hostPath = ctx.fs.processPath(target);

				const subprocess = ctx.subprocess;
				const exe = await subprocess.resolveExecutable("powershell.exe", undefined, exec.signal);
				const handle = subprocess.spawn({
					argv: [
						exe,
						"-NoProfile",
						"-NonInteractive",
						"-ExecutionPolicy",
						"Bypass",
						"-Command",
						buildScript(mode, needle, hostPath),
					],
					cwd: sessionCwd(exec) !== undefined ? ctx.fs.processPath(await ctx.fs.resolve(sessionCwd(exec))) : dirname(hostPath),
					stdio: {
						stdin: "ignore",
						stdout: { maxBytes: 65536 },
						stderr: { maxBytes: 65536 },
					},
					graceMs: 5000,
					signal: exec.signal,
				});
				const outcome = await handle.done;
				const stdout = handle.collected.stdout?.readFrom(0).text ?? "";
				const stderr = handle.collected.stderr?.readFrom(0).text ?? "";
				if (outcome.exitCode !== 0) {
					const detail = tailLines(stderr || stdout, 12);
					throw new Error(`screenshot failed (exit ${outcome.exitCode ?? "signal " + outcome.signal}): ${detail}`);
				}
				const match = /OK\s+(\d+)x(\d+)/.exec(stdout);
				if (match === null) {
					throw new Error(`screenshot produced no image (unexpected output): ${tailLines(stdout || stderr, 6)}`);
				}

				const byteCap = Math.min(attachments.imageLimits.maxImageBytes, attachments.imageLimits.maxMessageImageBytes);
				const data = await ctx.fs.readBytes(target, exec.signal, byteCap);
				const ref = await attachments.saveImage({ data, mediaType: "image/png", name: basename(target.displayPath) });

				return {
					path: target.displayPath,
					image: {
						attachmentId: ref.attachmentId,
						mediaType: ref.mediaType,
						bytes: ref.bytes,
						width: ref.width,
						height: ref.height,
						...(ref.name === undefined ? {} : { name: ref.name }),
					},
				};
			},
			presentCall(args) {
				const target = args.target ?? "screen";
				const title = target === "window"
					? `Screenshot window${args.window_title ? ` “${args.window_title}”` : ""}`
					: "Screenshot screen";
				return {
					card: "generic",
					title,
					kind: "read",
					locations: args.output_path !== undefined ? [{ path: args.output_path }] : [],
				};
			},
		}),
	);
}

export { apply, inject, name };
