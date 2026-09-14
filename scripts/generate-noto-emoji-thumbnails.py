#!/usr/bin/env python3
"""Build the offline desktop picker atlases. Requires Pillow 12.1.0.

Run with --cache-dir pointing to a disposable download directory. The source
catalog controls every URL; only public Google Fonts PNGs are downloaded.
"""

import argparse
import concurrent.futures
import hashlib
import io
import json
import math
from pathlib import Path
import time
import urllib.request
import urllib.error

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
TILE = 96
COLUMNS = 16
PER_SHEET = 256
STATIC_SYMBOLS = {"a9_fe0f": "emoji_u00a9.png", "ae_fe0f": "emoji_u00ae.png"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache-dir", type=Path, required=True)
    args = parser.parse_args()
    args.cache_dir.mkdir(parents=True, exist_ok=True)
    catalog_bytes = (ROOT / "shared/noto-emoji/catalog.json").read_bytes()
    ids = [item["id"] for item in json.loads(catalog_bytes)["emoji"]]

    def download(emoji_id):
        assert all(part and all(c in "0123456789abcdef" for c in part) for part in emoji_id.split("_"))
        cached = args.cache_dir / f"{emoji_id}.png"
        if not cached.exists():
            url = f"https://fonts.gstatic.com/s/e/notoemoji/latest/{emoji_id}/128.png"
            # The animation catalog includes these symbols but its CDN has no
            # corresponding images. Use Google's static Noto artwork instead.
            if emoji_id in STATIC_SYMBOLS:
                url = "https://raw.githubusercontent.com/googlefonts/noto-emoji/main/png/128/" + STATIC_SYMBOLS[emoji_id]
            for attempt in range(3):
                try:
                    try:
                        response = urllib.request.urlopen(url, timeout=20)
                    except urllib.error.HTTPError as error:
                        if error.code != 404:
                            raise
                        response = urllib.request.urlopen(url.replace('/128.png', '/512.png'), timeout=20)
                    with response:
                        data = response.read(2 * 1024 * 1024 + 1)
                    assert len(data) <= 2 * 1024 * 1024
                    cached.write_bytes(data)
                    break
                except Exception:
                    if attempt == 2:
                        raise
                    time.sleep(attempt + 1)
        data = cached.read_bytes()
        image = Image.open(io.BytesIO(data))
        assert image.format == "PNG" and image.size in [(128, 128), (512, 512)]
        return image.convert("RGBA").resize((TILE, TILE), Image.Resampling.LANCZOS), hashlib.sha256(data).hexdigest()

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        images = list(pool.map(download, ids))
    destination = ROOT / "app/desktop/src/assets/noto-thumbnails"
    destination.mkdir(exist_ok=True)
    sheets = []
    for start in range(0, len(images), PER_SHEET):
        batch = images[start:start + PER_SHEET]
        rows = math.ceil(len(batch) / COLUMNS)
        sheet = Image.new("RGBA", (COLUMNS * TILE, rows * TILE))
        for index, (image, _) in enumerate(batch):
            sheet.paste(image, ((index % COLUMNS) * TILE, (index // COLUMNS) * TILE))
        filename = f"atlas-{len(sheets)}.webp"
        sheet.save(destination / filename, "WEBP", quality=88, method=6)
        sheets.append({"file": filename, "rows": rows})
    manifest = {
        "tileSize": TILE, "columns": COLUMNS, "perSheet": PER_SHEET,
        "catalogSha256": hashlib.sha256(catalog_bytes).hexdigest(),
        "sourceImagesSha256": hashlib.sha256("\n".join(digest for _, digest in images).encode()).hexdigest(),
        "sheets": sheets, "ids": ids,
        "staticSymbolIds": list(STATIC_SYMBOLS),
    }
    (destination / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    total = sum((destination / sheet["file"]).stat().st_size for sheet in sheets)
    print(f"Built {len(sheets)} atlases for {len(ids)} emoji: {total:,} bytes.")


if __name__ == "__main__":
    main()
