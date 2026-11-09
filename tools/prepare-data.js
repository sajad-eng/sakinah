// Prepare runtime assets:
//  1) copy fontsource css + woff2 files into src/assets/fonts
//  2) download the full Quran (Arabic uthmani + English Sahih International)
//     from alquran.cloud once into tiny local JS bundles (offline reading)
//  3) build build/icon.ico from src/assets/icons/icon.png
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  return true;
}

// ---------- fonts ----------
const FONT_PKGS = [
  { pkg: '@fontsource/plus-jakarta-sans', dest: 'jakarta', weights: ['400.css', '500.css', '600.css', '700.css', '800.css'] },
  { pkg: '@fontsource/amiri', dest: 'amiri', weights: ['400.css', '700.css'] },
];

for (const { pkg, dest, weights } of FONT_PKGS) {
  const srcDir = path.join(ROOT, 'node_modules', pkg);
  if (!fs.existsSync(srcDir)) {
    console.log(`FONT MISSING: ${pkg}`);
    continue;
  }
  const outDir = path.join(ROOT, 'src', 'assets', 'fonts', dest);
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(path.join(outDir, 'files'), { recursive: true });

  // copy css entry points (they reference ./files/)
  for (const w of weights) {
    const css = path.join(srcDir, w);
    if (fs.existsSync(css)) fs.copyFileSync(css, path.join(outDir, w));
  }
  // copy all referenced woff2 files
  const filesDir = path.join(srcDir, 'files');
  if (fs.existsSync(filesDir)) {
    for (const f of fs.readdirSync(filesDir)) {
      if (f.endsWith('.woff2')) {
        fs.copyFileSync(path.join(filesDir, f), path.join(outDir, 'files', f));
      }
    }
  }
  const count = fs.readdirSync(path.join(outDir, 'files')).length;
  console.log(`fonts ok: ${dest} (${count} woff2)`);
}

// ---------- quran data ----------
const EDITIONS = [
  {
    slug: 'quran-uthmani',
    out: 'quran-ar.js',
    name: 'QURAN_AR',
  },
  {
    slug: 'en.sahih',
    out: 'quran-en.js',
    name: 'QURAN_EN',
  },
];

async function downloadQuran() {
  fs.mkdirSync(path.join(ROOT, 'src', 'data'), { recursive: true });
  for (const e of EDITIONS) {
    const url = `https://api.alquran.cloud/v1/quran/${e.slug}`;
    console.log(`downloading edition ${e.slug} …`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const json = await res.json();
    if (!json || !json.data || !json.data.surahs || json.data.surahs.length !== 114) {
      throw new Error(`unexpected payload for ${e.slug}`);
    }
    const ayahTotal = json.data.surahs.reduce((a, s) => a + s.ayahs.length, 0);
    const outPath = path.join(ROOT, 'src', 'data', e.out);
    fs.writeFileSync(outPath, `// Generated from api.alquran.cloud (edition ${e.slug}) — offline bundle for Sakinah\nwindow.${e.name} = ` + JSON.stringify(json) + ';');
    console.log(`quran ok: ${e.out} · ${json.data.surahs.length} surahs · ${ayahTotal} ayahs · ${(fs.statSync(outPath).size / 1e6).toFixed(2)} MB`);
  }
}

// ---------- ico ----------
async function makeIco() {
  try {
    require(path.join(__dirname, 'make-ico.js'));
    console.log('icon.ico ok (via make-ico)');
  } catch (err) {
    console.log('ico skipped:', err.message);
  }
}

(async () => {
  await downloadQuran();
  await makeIco();
  console.log('ALL PREPARED');
})().catch((err) => {
  console.error('PREPARE FAILED:', err);
  process.exit(1);
});
