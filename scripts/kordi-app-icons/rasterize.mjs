// Renders SVG markup to PNG with headless Chrome, then resizes with `sips` (macOS).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].filter(Boolean);

function chromePath() {
  const found = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
  if (!found) throw new Error('Google Chrome is required to render icons; set CHROME_PATH.');
  return found;
}

// Headless Chrome occasionally exits early under load; retry a few times.
function runChrome(chrome, args) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      execFileSync(chrome, args, { stdio: 'ignore' });
      return;
    } catch (error) {
      if (attempt >= 3) throw error;
    }
  }
}

export function createRasterizer() {
  const workDir = mkdtempSync(join(tmpdir(), 'kordi-icons-'));
  const chrome = chromePath();
  let counter = 0;

  function render(svg, outPath, size) {
    const source = join(workDir, `icon-${++counter}.svg`);
    const renderSize = Math.max(size, 1024);
    writeFileSync(source, svg.replace(/width="\d+" height="\d+"/, `width="${renderSize}" height="${renderSize}"`));
    const shot = join(workDir, `icon-${counter}.png`);
    runChrome(chrome, [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      '--default-background-color=00000000',
      `--window-size=${renderSize},${renderSize}`,
      `--screenshot=${shot}`,
      `file://${source}`,
    ]);
    execFileSync('sips', ['-z', String(size), String(size), shot, '--out', outPath], { stdio: 'ignore' });
  }

  // Renders a non-square SVG at its own pixel size.
  function renderWide(svg, outPath, width, height) {
    const source = join(workDir, `wide-${++counter}.svg`);
    writeFileSync(source, svg);
    runChrome(chrome, [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      `--window-size=${width},${height}`,
      `--screenshot=${outPath}`,
      `file://${source}`,
    ]);
  }

  return { render, renderWide, dispose: () => rmSync(workDir, { recursive: true, force: true }) };
}
