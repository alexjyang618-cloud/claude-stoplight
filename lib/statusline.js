// Claude Code's status line, as Clawd's source for plan usage.
//
// Claude Code's terminal UI runs one status line command (settings.json's
// statusLine) after every reply and hands it the session's data on stdin,
// including the 5-hour and weekly usage it has just been told by the API. (A
// session the Claude app hosts has no status line and never runs it.) Clawd
// registers a command that passes that data on to the widget, and nothing else:
//
//  - With no status line configured, the command is a single curl call that
//    prints nothing, so the status line stays blank.
//
//  - With one already configured, it is kept. Claude Code is pointed at a
//    small PowerShell script instead (the form Claude Code's docs give as
//    working whether it runs commands through Git Bash or PowerShell), which
//    forwards stdin to Clawd without waiting for it and then runs the original
//    command with the same input, through the same shell Claude Code would
//    have used, passing its output and exit code straight through. The
//    original entry is saved and put back, exactly, when Clawd's is removed.
//
// This file only builds and recognises those things; main.js reads and writes
// the files.

const ROUTE = '/claude-stoplight/statusline'; // in the plain command's URL: how that one is recognised

const FILES = {
  wrapper: 'clawd-statusline.ps1', // by this name the wrapped one is recognised, wherever it is kept
  originalSh: 'statusline-original.sh', // the original command, for Git Bash
  originalPs1: 'statusline-original.ps1', // and for PowerShell
  shell: 'statusline-shell.txt', // which shell the wrapper found itself under
};

const fwd = (p) => String(p).replace(/\\/g, '/');

// the last line of the PowerShell copy of the original command
const PS_EXIT = 'if (-not $?) { if ($LASTEXITCODE) { exit $LASTEXITCODE } else { exit 1 } }';

function plainCommand(port) {
  return `curl.exe -s -o NUL -m 1 -X POST --data-binary "@-" http://127.0.0.1:${port}${ROUTE} ; exit 0`;
}

// Forward slashes: Git Bash eats unquoted backslashes, and PowerShell takes either.
function wrapperCommand(dir) {
  return `powershell -NoProfile -ExecutionPolicy Bypass -File "${fwd(dir)}/${FILES.wrapper}"`;
}

function isCommand(sl) {
  return Boolean(sl && typeof sl === 'object' && sl.type === 'command' && typeof sl.command === 'string' && sl.command.trim());
}

function isWrapper(sl) {
  return Boolean(sl && typeof sl === 'object' && typeof sl.command === 'string' && fwd(sl.command).includes(`/${FILES.wrapper}`));
}

function isOurs(sl) {
  return isWrapper(sl) || Boolean(sl && typeof sl === 'object' && typeof sl.command === 'string' && sl.command.includes(ROUTE));
}

const clone = (v) => JSON.parse(JSON.stringify(v));

// What installing would make of settings.json's statusLine.
//   kind 'plain': no status line of the user's own; ours is the bare curl call
//   kind 'wrap':  the user's is kept, behind the wrapper; `original` is theirs
//   kind 'skip':  an entry we do not understand; leave it alone
// `current` is true when settings.json already says exactly this. `saved` is
// the original entry remembered from an earlier wrap.
function plan(settings, { port, dir, saved }) {
  const cur = settings && settings.statusLine;
  if (isWrapper(cur)) {
    const command = wrapperCommand(dir);
    return {
      kind: 'wrap',
      statusLine: Object.assign({}, cur, { type: 'command', command }),
      original: isCommand(saved) ? clone(saved) : null,
      current: cur.command === command,
    };
  }
  if (isOurs(cur) || cur === undefined || cur === null) {
    const command = plainCommand(port);
    return {
      kind: 'plain',
      statusLine: { type: 'command', command },
      original: null,
      current: Boolean(cur && cur.type === 'command' && cur.command === command),
    };
  }
  if (isCommand(cur)) {
    // their other keys (padding, refreshInterval...) keep applying
    return {
      kind: 'wrap',
      statusLine: Object.assign({}, cur, { command: wrapperCommand(dir) }),
      original: clone(cur),
      current: false,
    };
  }
  return { kind: 'skip', statusLine: cur, original: null, current: true };
}

// Take ours out of a settings object, putting back the entry it wrapped.
// Returns true when the object changed.
function remove(settings, saved) {
  if (!settings || !isOurs(settings.statusLine)) return false;
  if (isWrapper(settings.statusLine) && isCommand(saved)) settings.statusLine = clone(saved);
  else delete settings.statusLine;
  return true;
}

// The wrapper. Windows PowerShell 5.1 has to be able to run it, so: no
// ternaries, no null-conditional operators, and the bytes of stdin are passed
// on as bytes rather than through PowerShell's string pipeline, which would
// re-encode them.
function wrapperScript(port) {
  return `# Clawd's status line wrapper. The Clawd widget writes this file whenever it
# installs its status line, so edits here do not last.
#
# Claude Code runs it as the status line command. It hands the session data on
# stdin to Clawd (for the plan usage gauges) without waiting for it, then runs
# the status line that was configured before, with the same input, and passes
# its output and exit code straight through. If Clawd is not running, the
# first step fails silently and the second is unaffected.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$code = 0

# The shell Claude Code runs status lines through: Git Bash when it is
# installed, otherwise PowerShell. Whichever started this script is the one it
# picked; failing that, the same rule is applied here.
function Find-Shell {
  try {
    $me = Get-CimInstance Win32_Process -Filter "ProcessId=$PID" -Property ParentProcessId
    $parent = Get-Process -Id $me.ParentProcessId
    $name = $parent.ProcessName.ToLower()
    if (($name -eq 'bash' -or $name -eq 'sh') -and $parent.Path) { return @(('bash|' + $parent.Path), $true) }
    if (($name -eq 'powershell' -or $name -eq 'pwsh') -and $parent.Path) { return @(('powershell|' + $parent.Path), $true) }
  } catch {}
  $candidates = @()
  if ($env:CLAUDE_CODE_GIT_BASH_PATH) { $candidates += $env:CLAUDE_CODE_GIT_BASH_PATH }
  try {
    $dir = Split-Path -Parent (Get-Command git.exe -ErrorAction Stop).Source
    for ($i = 0; $i -lt 3 -and $dir; $i++) {
      $candidates += (Join-Path $dir 'bin\\bash.exe')
      $dir = Split-Path -Parent $dir
    }
  } catch {}
  if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles 'Git\\bin\\bash.exe') }
  if (\${env:ProgramFiles(x86)}) { $candidates += (Join-Path \${env:ProgramFiles(x86)} 'Git\\bin\\bash.exe') }
  if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\\Git\\bin\\bash.exe') }
  foreach ($c in $candidates) {
    if ($c -and (Test-Path -LiteralPath $c)) { return @(('bash|' + $c), $false) }
  }
  return @(('powershell|' + (Join-Path $PSHOME 'powershell.exe')), $false)
}

try {
  # the session data, as the bytes Claude Code sent
  $stdin = [Console]::OpenStandardInput()
  $buffer = New-Object System.IO.MemoryStream
  $stdin.CopyTo($buffer)
  $bytes = $buffer.ToArray()

  function Start-WithInput([string]$file, [string]$arguments, [bool]$quiet) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $file
    $psi.Arguments = $arguments
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardInput = $true
    if ($quiet) {
      $psi.RedirectStandardOutput = $true
      $psi.RedirectStandardError = $true
    }
    $p = [System.Diagnostics.Process]::Start($psi)
    try { $p.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length) } catch {}
    try { $p.StandardInput.Close() } catch {}
    return $p
  }

  # 1. Clawd. Not waited for: the status line is no slower for it. Windows'
  # own curl, by its full path: started by bare name it would be looked for
  # in the session's working folder first, and that folder is someone's repo.
  try {
    $curl = Join-Path $env:SystemRoot 'System32\\curl.exe'
    if (Test-Path -LiteralPath $curl) {
      $null = Start-WithInput $curl '-s -o NUL -m 1 -X POST --data-binary @- http://127.0.0.1:${port}${ROUTE}' $true
    }
  } catch {}

  # 2. the status line that was configured before
  $shellFile = Join-Path $here '${FILES.shell}'
  $shell = $null
  try {
    $item = Get-Item -LiteralPath $shellFile -ErrorAction Stop
    if (((Get-Date) - $item.LastWriteTime).TotalHours -lt 12) {
      $shell = [string](Get-Content -LiteralPath $shellFile -TotalCount 1)
    }
  } catch {}
  if ($shell) {
    $shell = $shell.Trim()
    $at = $shell.IndexOf('|')
    if ($at -lt 1) { $shell = $null }
    elseif (-not (Test-Path -LiteralPath $shell.Substring($at + 1))) { $shell = $null }
  }
  if (-not $shell) {
    $found = Find-Shell
    $shell = $found[0]
    # only what the parent process showed is worth remembering
    if ($found[1]) {
      try { Set-Content -LiteralPath $shellFile -Value $shell -Encoding UTF8 } catch {}
    }
  }
  $at = $shell.IndexOf('|')
  $kind = $shell.Substring(0, $at)
  $exe = $shell.Substring($at + 1)
  if ($kind -eq 'bash') {
    $script = (Join-Path $here '${FILES.originalSh}') -replace '\\\\', '/'
    $run = Start-WithInput $exe ('"' + $script + '"') $false
  } else {
    $script = Join-Path $here '${FILES.originalPs1}'
    $run = Start-WithInput $exe ('-NoProfile -ExecutionPolicy Bypass -File "' + $script + '"') $false
  }
  $run.WaitForExit()
  $code = $run.ExitCode
} catch {
  # Claude Code shows only what a status line prints, so this is seen by
  # whoever runs the script by hand to find out why theirs has gone blank
  try { [Console]::Error.WriteLine('Clawd status line wrapper: ' + $_.Exception.Message) } catch {}
  $code = 1
}
exit $code
`;
}

// The files the wrapper needs beside it. `bom`: Windows PowerShell reads a
// script without a byte-order mark in the system's ANSI code page, which would
// garble any non-ASCII character in the original command; Git Bash, on the
// other hand, chokes on one.
function wrapperFiles(original, port) {
  const command = `${String(original.command).replace(/\r\n?/g, '\n').replace(/\n+$/, '')}\n`;
  return [
    { name: FILES.wrapper, text: wrapperScript(port), bom: true, eol: '\r\n' },
    { name: FILES.originalSh, text: command, bom: false, eol: '\n' },
    // run as a script file, PowerShell would exit 0 whatever the command did:
    // a command that failed still has to read as failed
    { name: FILES.originalPs1, text: `${command}${PS_EXIT}\n`, bom: true, eol: '\r\n' },
  ];
}

function encode({ text, bom, eol }) {
  const body = Buffer.from(text.replace(/\r\n?/g, '\n').replace(/\n/g, eol), 'utf8');
  return bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body;
}

// A stand-in for what Claude Code sends, for trying the wrapper before
// settings.json is pointed at it. `nonce` lets the widget recognise this
// payload when the wrapper forwards it. No rate_limits: it must not move the
// gauges.
function samplePayload(nonce, cwd) {
  return {
    cwd,
    session_id: '00000000-0000-4000-8000-000000000000',
    transcript_path: '',
    model: { id: 'claude-sample', display_name: 'Claude' },
    workspace: { current_dir: cwd, project_dir: cwd, added_dirs: [] },
    version: '2.1.0',
    output_style: { name: 'default' },
    cost: { total_cost_usd: 0, total_duration_ms: 0, total_api_duration_ms: 0, total_lines_added: 0, total_lines_removed: 0 },
    context_window: {
      total_input_tokens: 0,
      total_output_tokens: 0,
      context_window_size: 200000,
      used_percentage: 0,
      remaining_percentage: 100,
      current_usage: null,
    },
    exceeds_200k_tokens: false,
    clawd_selftest: nonce,
  };
}

module.exports = {
  ROUTE,
  FILES,
  plainCommand,
  wrapperCommand,
  isCommand,
  isOurs,
  isWrapper,
  plan,
  remove,
  wrapperScript,
  wrapperFiles,
  encode,
  samplePayload,
};
