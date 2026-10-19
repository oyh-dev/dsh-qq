import path from 'node:path';
import { runProcess } from './media.js';
import { ensureDir } from './util.js';

export class AppController {
  constructor({ logger }) {
    this.logger = logger ?? (() => {});
    this._shell = null;
  }

  async _pwsh() {
    if (this._shell) return this._shell;
    for (const candidate of ['pwsh.exe', 'powershell.exe']) {
      try {
        const { stdout } = await runProcess('where.exe', [candidate], 5000);
        const first = stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
        if (first) {
          this._shell = first;
          return first;
        }
      } catch {
        /* try next */
      }
    }
    throw new Error('未找到 PowerShell (pwsh.exe / powershell.exe)');
  }

  async run(script, timeoutMs = 30000) {
    const shell = await this._pwsh();
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const { stdout, stderr } = await runProcess(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], timeoutMs);
    const text = stdout.trim();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return { output: text, stderr: stderr.trim() || undefined };
    }
  }

  async listWindows() {
    const data = await this.run(`
$rows = Get-Process | Where-Object { $_.MainWindowTitle } | Sort-Object ProcessName | ForEach-Object {
  [pscustomobject]@{ pid = $_.Id; process = $_.ProcessName; title = $_.MainWindowTitle }
}
@($rows) | ConvertTo-Json -Compress -Depth 5
`);
    if (Array.isArray(data)) return data;
    if (data && typeof data === 'object') return [data];
    return [];
  }

  async launch(target, { args = [], cwd = '', waitMs = 800 } = {}) {
    if (!target) throw new Error('缺少要启动的程序路径或名称');
    const argList = Array.isArray(args) ? args : [String(args)];
    const quotedArgs = argList.map((arg) => psQuote(String(arg))).join(',');
    const script = `
$ErrorActionPreference = 'Stop'
$p = Start-Process -FilePath ${psQuote(target)}${cwd ? ` -WorkingDirectory ${psQuote(cwd)}` : ''}${argList.length ? ` -ArgumentList @(${quotedArgs})` : ''} -PassThru
Start-Sleep -Milliseconds ${Math.max(0, Math.min(10000, Number(waitMs) || 0))}
$info = [pscustomobject]@{
  pid = $p.Id
  process = $p.ProcessName
  exited = $p.HasExited
  mainWindowTitle = if ($p.HasExited) { '' } else { $p.MainWindowTitle }
}
$info | ConvertTo-Json -Compress
`;
    return this.run(script, 20000);
  }

  async activate({ pid, title } = {}) {
    if (!pid && !title) throw new Error('activate 需要 pid 或 title');
    const selector = pid
      ? `Get-Process -Id ${Number(pid)} -ErrorAction Stop`
      : `Get-Process | Where-Object { $_.MainWindowTitle -like ${psQuote(`*${title}*`)} } | Select-Object -First 1`;
    const script = `
$ErrorActionPreference = 'Stop'
$p = ${selector}
if (-not $p) { throw '未找到匹配的窗口进程' }
$wsh = New-Object -ComObject WScript.Shell
$ok = $wsh.AppActivate($p.Id)
Start-Sleep -Milliseconds 300
[pscustomobject]@{ pid = $p.Id; process = $p.ProcessName; title = $p.MainWindowTitle; activated = [bool]$ok } | ConvertTo-Json -Compress
`;
    return this.run(script, 15000);
  }

  async close({ pid, title, force = false } = {}) {
    if (!pid && !title) throw new Error('close 需要 pid 或 title');
    const selector = pid
      ? `Get-Process -Id ${Number(pid)} -ErrorAction Stop`
      : `Get-Process | Where-Object { $_.MainWindowTitle -like ${psQuote(`*${title}*`)} } | Select-Object -First 1`;
    const script = `
$ErrorActionPreference = 'Stop'
$p = ${selector}
if (-not $p) { throw '未找到匹配的窗口进程' }
$closed = $p.CloseMainWindow()
if (-not $closed -and ${force ? '$true' : '$false'}) { $p.Kill() }
Start-Sleep -Milliseconds 400
[pscustomobject]@{ pid = $p.Id; process = $p.ProcessName; closeRequested = [bool]$closed; killed = (-not $closed -and ${force ? '$true' : '$false'}) } | ConvertTo-Json -Compress
`;
    return this.run(script, 15000);
  }

  async screenshot(outDir) {
    await ensureDir(outDir);
    const file = path.join(outDir, `screen_${Date.now()}.png`);
    const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
try {
  $g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
  $bmp.Save(${psQuote(file)}, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
  $g.Dispose()
  $bmp.Dispose()
}
[pscustomobject]@{ path = ${psQuote(file)}; width = $bounds.Width; height = $bounds.Height } | ConvertTo-Json -Compress
`;
    const result = await this.run(script, 20000);
    return result ?? { path: file };
  }

  async sendKeys(text, { pid, title } = {}) {
    if (!text) throw new Error('缺少要输入的文本');
    const selector = pid
      ? `Get-Process -Id ${Number(pid)} -ErrorAction Stop`
      : title
        ? `Get-Process | Where-Object { $_.MainWindowTitle -like ${psQuote(`*${title}*`)} } | Select-Object -First 1`
        : null;
    const script = `
$ErrorActionPreference = 'Stop'
${selector ? `$p = ${selector}\nif (-not $p) { throw '未找到匹配的窗口进程' }\n$wsh = New-Object -ComObject WScript.Shell\n[void]$wsh.AppActivate($p.Id)\nStart-Sleep -Milliseconds 300\n` : ''}
$wsh2 = New-Object -ComObject WScript.Shell
$wsh2.SendKeys(${psQuote(text)})
[pscustomobject]@{ sent = $true; length = ${String(text).length} } | ConvertTo-Json -Compress
`;
    return this.run(script, 15000);
  }
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}
