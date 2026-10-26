import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
const { version, license } = JSON.parse(await readFile(new URL('node_modules/gsap/package.json', root), 'utf8'));
await mkdir(new URL('public/vendor/', root), { recursive: true });
for (const file of ['gsap.min.js']) {
  await copyFile(new URL('node_modules/gsap/dist/' + file, root), new URL('public/vendor/' + file, root));
}
await writeFile(new URL('public/vendor/README.txt', root), `GSAP ${version}\nSource: official gsap npm package, pinned in package-lock.json.\n${license}\nOriginal license notices are retained in the JavaScript file.\nRegenerate with: node scripts/vendor.mjs\n`);
