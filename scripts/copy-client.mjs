import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
mkdirSync(join(root, "dist"), { recursive: true });

// 客户端模块 id 必须等于包名（现存插件都如此：@linxin666/dsh-ssh → id "@linxin666/dsh-ssh"）。
// 发布前按 package.json 的 name 覆写，避免改名后 src/client.js 与包名不一致。
const src = readFileSync(join(root, "src", "client.js"), "utf8");
const patched = src.replace(/id:\s*"[^"]*"/, `id: ${JSON.stringify(pkg.name)}`);
if (patched === src && !src.includes(pkg.name)) {
  console.warn("⚠ src/client.js 里没找到 client 模块 id 行，已原样拷贝");
}
writeFileSync(join(root, "dist", "client.js"), patched);
console.log(`client bundle copied → dist/client.js (id: ${pkg.name})`);
