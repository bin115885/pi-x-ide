import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = mkdtempSync(join(tmpdir(), "pi-x-ide-production-"));

try {
  for (const path of ["package.json", "src", "scripts"]) {
    cpSync(join(root, path), join(fixture, path), { recursive: true });
  }
  mkdirSync(join(fixture, "ide-plugins/vscode"), { recursive: true });
  cpSync(join(root, "ide-plugins/vscode/package.json"), join(fixture, "ide-plugins/vscode/package.json"));

  // 独立目录复现 Pi 的安装命令，避免本机开发依赖掩盖缺失依赖。
  const result = spawnSync("npm install --omit=dev --legacy-peer-deps", {
    cwd: fixture,
    shell: true,
    stdio: "inherit",
    env: { ...process.env, NODE_PATH: "" },
  });
  assert.equal(result.status, 0, "Pi 精简安装必须成功");
  assert.ok(existsSync(join(fixture, "dist/src/pi/index.js")), "安装必须生成扩展入口");
  assert.ok(existsSync(join(fixture, "node_modules/@pi-x-ide/build-tui")), "构建依赖必须保留");
  assert.ok(!existsSync(join(fixture, "node_modules/@earendil-works/pi-tui")), "不应安装宿主 peer 依赖");
  console.log("Pi 精简安装回归检查通过");
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
