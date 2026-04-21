import { mkdir } from 'node:fs/promises'
import path from 'node:path'

const desktopRoot = path.resolve(import.meta.dir, '..')
const repoRoot = path.resolve(desktopRoot, '..')
const binariesDir = path.join(desktopRoot, 'src-tauri', 'binaries')

const targetTriple =
  process.env.TAURI_ENV_TARGET_TRIPLE ||
  process.env.CARGO_BUILD_TARGET ||
  (await detectHostTriple())

const hostTriple = await detectHostTriple()
const isNixOS = await Bun.file('/etc/NIXOS').exists() || await Bun.file('/etc/nixos').exists()

// 单一合并 sidecar：server / cli 共享一份 bun runtime + 共享依赖代码。
// 调用方（Tauri lib.rs / conversationService）通过第一个 positional 参数
// 选择 'server' 或 'cli' 模式，详见 desktop/sidecars/claude-sidecar.ts。
const outfile = path.join(binariesDir, `claude-sidecar-${targetTriple}`)
await compileExecutable({
  entrypoint: path.join(desktopRoot, 'sidecars/claude-sidecar.ts'),
  outfileBase: outfile,
  productName: 'Claude Code Sidecar',
  bunTarget: mapTargetTripleToBun(targetTriple),
})

if (isNixOS && targetTriple === hostTriple) {
  console.log(`[build-sidecars] NixOS detected, patching binary: ${outfile}`)
  try {
    // Try to find the interpreter path using common Nix environment hints
    // or by inspecting a known-good local binary (like 'bun' itself)
    const getInterpreter = () => {
        try {
            // Standard Nix way if running inside nix develop
            const ccPath = process.env.NIX_CC;
            if (ccPath) {
                const fs = require('node:fs');
                const linkerFile = path.join(ccPath, 'nix-support/dynamic-linker');
                if (fs.existsSync(linkerFile)) {
                    return fs.readFileSync(linkerFile, 'utf8').trim();
                }
            }
        } catch {}
        return null;
    };

    const interpreter = getInterpreter();
    if (interpreter) {
      console.log(`[build-sidecars] Setting interpreter to ${interpreter}`)
      const patch = Bun.spawn(['patchelf', '--set-interpreter', interpreter, outfile], {
          stdout: 'inherit',
          stderr: 'inherit'
      })
      await patch.exited
    } else {
        console.warn('[build-sidecars] Could not determine Nix interpreter path, skipping patchelf.')
    }
  } catch (e) {
    console.warn(`[build-sidecars] Failed to patch binary with patchelf: ${e}`)
  }
}

console.log(`[build-sidecars] Built desktop sidecar for ${targetTriple} (${mapTargetTripleToBun(targetTriple)})`)

async function detectHostTriple() {
  const proc = Bun.spawn(['rustc', '-vV'], {
    cwd: repoRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited

  if (exitCode !== 0) {
    throw new Error(`[build-sidecars] rustc -vV failed: ${stderr || stdout}`)
  }

  const hostLine = stdout
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('host: '))

  if (!hostLine) {
    throw new Error('[build-sidecars] Could not detect Rust host triple')
  }

  return hostLine.replace('host: ', '')
}

function mapTargetTripleToBun(triple: string) {
  switch (triple) {
    case 'aarch64-apple-darwin':
      return 'bun-darwin-arm64'
    case 'x86_64-apple-darwin':
      return 'bun-darwin-x64'
    case 'x86_64-pc-windows-msvc':
      return 'bun-windows-x64'
    case 'aarch64-pc-windows-msvc':
      return 'bun-windows-arm64'
    case 'x86_64-unknown-linux-gnu':
      return 'bun-linux-x64-baseline'
    case 'aarch64-unknown-linux-gnu':
      return 'bun-linux-arm64'
    case 'x86_64-unknown-linux-musl':
      return 'bun-linux-x64-musl'
    case 'aarch64-unknown-linux-musl':
      return 'bun-linux-arm64-musl'
    default:
      throw new Error(`[build-sidecars] Unsupported target triple: ${triple}`)
  }
}

async function compileExecutable({
  entrypoint,
  outfileBase,
  productName,
  bunTarget,
}: {
  entrypoint: string
  outfileBase: string
  productName: string
  bunTarget: string
}) {
  const result = await Bun.build({
    entrypoints: [entrypoint],
    // minify whitespace + identifiers + dead-code 大概能省 5-15% 的二进制大小，
    // 代价是 stack trace 里的函数名变成短名 —— 终端用户场景可接受。
    minify: { whitespace: true, identifiers: true, syntax: true },
    sourcemap: 'none',
    target: 'bun',
    // 可选 npm 包：开 telemetry / 用 sharp 图像 / 用 Bedrock/Vertex 等
    // 替代 provider 时才需要，全部不在顶层 package.json 里。标 external
    // 让 bun build 跳过解析；运行时 import 在没装时自然失败，由 try/catch
    // 或 feature() gate 兜底。
    external: [
      // OpenTelemetry exporters（开 OTEL_* env 时才加载）
      '@opentelemetry/exporter-trace-otlp-grpc',
      '@opentelemetry/exporter-trace-otlp-http',
      '@opentelemetry/exporter-trace-otlp-proto',
      '@opentelemetry/exporter-logs-otlp-grpc',
      '@opentelemetry/exporter-logs-otlp-http',
      '@opentelemetry/exporter-logs-otlp-proto',
      '@opentelemetry/exporter-metrics-otlp-grpc',
      '@opentelemetry/exporter-metrics-otlp-http',
      '@opentelemetry/exporter-metrics-otlp-proto',
      '@opentelemetry/exporter-prometheus',
      // 替代 LLM provider —— 默认不用，用户自装
      '@aws-sdk/client-bedrock',
      '@aws-sdk/client-sts',
      '@anthropic-ai/bedrock-sdk',
      '@anthropic-ai/foundry-sdk',
      '@anthropic-ai/vertex-sdk',
      '@azure/identity',
      // ant-internal / 可选工具
      '@anthropic-ai/mcpb',
      'fflate',
      'sharp',
      'react-devtools-core',
    ],
    compile: {
      target: bunTarget,
      outfile: outfileBase,
      autoloadTsconfig: true,
      autoloadPackageJson: true,
      windows: {
        title: productName,
        publisher: 'Claude Code',
        description: productName,
        hideConsole: true,
      },
    },
  })

  if (!result.success) {
    const logs = result.logs.map((log) => log.message).join('\n')
    throw new Error(`[build-sidecars] Failed to compile ${productName}:\n${logs}`)
  }

  const outputPath = result.outputs[0]?.path ?? outfileBase
  console.log(`[build-sidecars] ${productName} -> ${outputPath}`)

  // macOS Apple System Policy (ASP) requires valid code signatures on all
  // executables. Bun-compiled binaries ship with an invalid/empty signature
  // that causes "load code signature error 4" and SIGKILL at launch.
  // Fix: strip the broken signature, then ad-hoc sign.
  if (process.platform === 'darwin') {
    console.log(`[build-sidecars] ad-hoc signing ${outputPath} for macOS ...`)
    const strip = Bun.spawn(['codesign', '--remove-signature', outputPath], {
      stdout: 'inherit',
      stderr: 'inherit',
    })
    await strip.exited

    const sign = Bun.spawn(
      ['codesign', '--sign', '-', '--force', '--timestamp=none', outputPath],
      { stdout: 'inherit', stderr: 'inherit' },
    )
    const signExit = await sign.exited
    if (signExit !== 0) {
      throw new Error(`[build-sidecars] ad-hoc codesign failed for ${outputPath} (exit ${signExit})`)
    }
    console.log(`[build-sidecars] ad-hoc signed ${outputPath}`)
  }
}
