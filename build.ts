import { readFile, writeFile, cp } from "fs/promises";

await Bun.build({
  entrypoints: ["./src/main.ts"],
  outdir: "./dist",
  minify: true,
  sourcemap: "linked",
});

const html = await readFile("./index.html", "utf-8");
await writeFile(
  "./dist/index.html",
  html.replace('./src/main.ts', './main.js'),
);
