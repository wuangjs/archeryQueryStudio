import { build, context } from "esbuild";
import { mkdir, copyFile } from "node:fs/promises";

const watch = process.argv.includes("--watch");
const production = process.env.NODE_ENV === "production" || watch === false;
await mkdir("dist", { recursive: true });

const extensionOptions = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: !production,
  minify: production,
  logLevel: "info",
};

const webviewOptions = {
  entryPoints: ["webview/main.ts"],
  bundle: true,
  outfile: "dist/webview.js",
  format: "iife",
  platform: "browser",
  target: "es2022",
  sourcemap: !production,
  minify: production,
  logLevel: "info",
};

if (watch) {
  const e = await context(extensionOptions);
  const w = await context(webviewOptions);
  await Promise.all([e.watch(), w.watch()]);
  await copyFile("webview/styles.css", "dist/webview.css");
  console.log("watching extension and webview...");
} else {
  await Promise.all([build(extensionOptions), build(webviewOptions)]);
  await copyFile("webview/styles.css", "dist/webview.css");
}
