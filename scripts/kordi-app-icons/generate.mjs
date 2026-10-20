#!/usr/bin/env node
// Regenerates every Kordi app icon from `icons.mjs`.
// Usage: node scripts/kordi-app-icons/generate.mjs   (macOS, needs Google Chrome)
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AMBER,
  APP_ICON_VARIANTS,
  CREAM,
  DEVELOPMENT_VARIANT,
  INK,
  inlineMarkSvg,
  launchMarkSvg,
  readmeTitleSvg,
  macIconSvg,
  silhouetteSvg,
  squareIconSvg,
  supportAvatarSvg,
} from './icons.mjs';
import { createRasterizer } from './rasterize.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const iosAssets = join(repoRoot, 'app/ios/Kordi/Resources/Assets.xcassets');
const desktopIcons = join(repoRoot, 'app/desktop/src-tauri/icons');
const desktopPublic = join(repoRoot, 'app/desktop/public/app-icons');

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const catalogInfo = { author: 'xcode', version: 1 };
const primary = APP_ICON_VARIANTS[0];

// iOS asset names: the primary stays `AppIcon`; alternates are `AppIcon-<key>`.
const iosAlternateIconName = (key) => `AppIcon-${key}`;
const iosPreviewImageName = (key) => `AppIconPreview-${key}`;

function writeAppIconSet(dir, images) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const entries = images.map(({ file, appearance }) => ({
    ...(appearance ? { appearances: [{ appearance: 'luminosity', value: appearance }] } : {}),
    filename: file,
    idiom: 'universal',
    platform: 'ios',
    size: '1024x1024',
  }));
  writeFileSync(join(dir, 'Contents.json'), json({ images: entries, info: catalogInfo }));
}

function writeImageSet(dir, file) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'Contents.json'), json({
    images: [{ filename: file, idiom: 'universal' }],
    info: catalogInfo,
  }));
}

function writeIcns(raster, svg, outPath) {
  const workDir = mkdtempSync(join(tmpdir(), 'kordi-iconset-'));
  const iconset = join(workDir, 'icon.iconset');
  mkdirSync(iconset);
  for (const size of [16, 32, 128, 256, 512]) {
    raster.render(svg, join(iconset, `icon_${size}x${size}.png`), size);
    raster.render(svg, join(iconset, `icon_${size}x${size}@2x.png`), size * 2);
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', outPath]);
  rmSync(workDir, { recursive: true, force: true });
}

const raster = createRasterizer();
try {
  // iOS primary icon with dark and tinted appearances.
  const primaryDir = join(iosAssets, 'AppIcon.appiconset');
  writeAppIconSet(primaryDir, [
    { file: 'Kordi-AppIcon.png' },
    { file: 'Kordi-AppIcon-Dark.png', appearance: 'dark' },
    { file: 'Kordi-AppIcon-Tinted.png', appearance: 'tinted' },
  ]);
  raster.render(squareIconSvg(primary), join(primaryDir, 'Kordi-AppIcon.png'), 1024);
  raster.render(squareIconSvg({ bird: CREAM }), join(primaryDir, 'Kordi-AppIcon-Dark.png'), 1024);
  raster.render(squareIconSvg({ bird: '#ffffff', beak: '#bdbdbd' }), join(primaryDir, 'Kordi-AppIcon-Tinted.png'), 1024);

  // iOS Beta keeps a gray icon.
  const betaDir = join(iosAssets, 'AppIconBeta.appiconset');
  writeAppIconSet(betaDir, [{ file: 'Kordi-Beta-AppIcon.png' }]);
  raster.render(squareIconSvg(DEVELOPMENT_VARIANT), join(betaDir, 'Kordi-Beta-AppIcon.png'), 1024);

  for (const variant of APP_ICON_VARIANTS) {
    if (variant !== primary) {
      const dir = join(iosAssets, `${iosAlternateIconName(variant.key)}.appiconset`);
      writeAppIconSet(dir, [{ file: `${variant.key}.png` }]);
      raster.render(squareIconSvg(variant), join(dir, `${variant.key}.png`), 1024);
    }
    const previewDir = join(iosAssets, `${iosPreviewImageName(variant.key)}.imageset`);
    writeImageSet(previewDir, `${variant.key}.png`);
    raster.render(squareIconSvg(variant), join(previewDir, `${variant.key}.png`), 180);
  }

  // Launch screen mark, 96pt: black on light and cream on dark.
  const launchDir = join(iosAssets, 'KordiLaunchMark.imageset');
  rmSync(launchDir, { recursive: true, force: true });
  mkdirSync(launchDir, { recursive: true });
  const launchImages = [];
  for (const [suffix, bird, appearance] of [['', undefined, null], ['-dark', CREAM, 'dark']]) {
    for (const scale of [1, 2, 3]) {
      const file = `kordi-launch-mark${suffix}@${scale}x.png`;
      raster.render(launchMarkSvg({ bird }), join(launchDir, file), 96 * scale);
      launchImages.push({
        ...(appearance ? { appearances: [{ appearance: 'luminosity', value: appearance }] } : {}),
        filename: file,
        idiom: 'universal',
        scale: `${scale}x`,
      });
    }
  }
  writeFileSync(join(launchDir, 'Contents.json'), json({ images: launchImages, info: catalogInfo }));

  // Desktop bundle icons, menu bar template, runtime Dock icons, and picker thumbnails.
  raster.render(macIconSvg(primary), join(desktopIcons, 'icon.png'), 1024);
  writeIcns(raster, macIconSvg(primary), join(desktopIcons, 'icon.icns'));
  raster.render(macIconSvg(DEVELOPMENT_VARIANT), join(desktopIcons, 'icon-dev.png'), 1024);
  writeIcns(raster, macIconSvg(DEVELOPMENT_VARIANT), join(desktopIcons, 'icon-dev.icns'));
  raster.render(silhouetteSvg({ color: '#000000', crop: true }), join(desktopIcons, 'menu-bar-template.png'), 36);

  mkdirSync(join(desktopIcons, 'app-icons'), { recursive: true });
  mkdirSync(desktopPublic, { recursive: true });
  for (const variant of APP_ICON_VARIANTS) {
    raster.render(macIconSvg(variant), join(desktopIcons, 'app-icons', `${variant.key}.png`), 512);
    raster.render(macIconSvg(variant), join(desktopPublic, `${variant.key}.png`), 128);
  }

  // Browser favicon (SVG plus a 512 PNG for the hosted pages).
  const faviconSvg = inlineMarkSvg({ color: INK, beak: AMBER }).replace(" aria-hidden='true'", '');
  writeFileSync(join(repoRoot, 'app/desktop/public/favicon.svg'), `${faviconSvg}\n`);
  raster.render(faviconSvg.replace('<svg ', '<svg width="512" height="512" '), join(repoRoot, 'app/desktop/public/favicon.png'), 512);

  // Kordi Support avatar and the README title image.
  writeFileSync(join(repoRoot, 'app/desktop/public/kordi-support-avatar.svg'), supportAvatarSvg());
  raster.renderWide(readmeTitleSvg(), join(repoRoot, '.github/assets/kordi-title.png'), 1774, 887);
} finally {
  raster.dispose();
}
