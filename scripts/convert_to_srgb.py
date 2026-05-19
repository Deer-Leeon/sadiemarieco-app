"""Convert images in assets/images/ from Display P3 (or any other profile) to sRGB.

Why: iPhone photos ship with a Display P3 ICC profile embedded. Safari color-manages
this correctly, but Chrome (and most other browsers) render P3 images inconsistently —
typically over-saturated or over-exposed. Converting the pixel data to sRGB once,
ahead of time, gives consistent colors across every browser and device.

Usage: .venv/bin/python scripts/convert_to_srgb.py
       (run from the project root after activating Pillow in the local venv)
"""

from __future__ import annotations

import io
import shutil
import sys
from pathlib import Path

from PIL import Image, ImageCms

SRGB_ICC_PATH = Path("/System/Library/ColorSync/Profiles/sRGB Profile.icc")
IMAGES_DIR = Path("assets/images")
JPEG_QUALITY = 90
JPEG_SUBSAMPLING = 0  # 4:4:4 — minimal chroma loss


def convert_one(path: Path, srgb_profile: ImageCms.ImageCmsProfile) -> None:
    print(f"\n→ {path}")
    with Image.open(path) as img:
        img.load()
        src_icc = img.info.get("icc_profile")
        if src_icc:
            src_profile = ImageCms.ImageCmsProfile(io.BytesIO(src_icc))
            src_name = ImageCms.getProfileName(src_profile).strip()
            print(f"   source profile: {src_name}")
            converted = ImageCms.profileToProfile(
                img,
                inputProfile=src_profile,
                outputProfile=srgb_profile,
                renderingIntent=ImageCms.Intent.PERCEPTUAL,
                outputMode="RGB",
            )
        else:
            print("   no embedded profile — assuming already sRGB, re-saving with sRGB tag")
            converted = img.convert("RGB")

        srgb_icc_bytes = srgb_profile.tobytes()

        exif = img.info.get("exif")
        save_kwargs = {
            "format": "JPEG",
            "quality": JPEG_QUALITY,
            "subsampling": JPEG_SUBSAMPLING,
            "optimize": True,
            "icc_profile": srgb_icc_bytes,
            "progressive": True,
        }
        if exif:
            save_kwargs["exif"] = exif

        tmp_path = path.with_suffix(path.suffix + ".tmp")
        converted.save(tmp_path, **save_kwargs)

    tmp_path.replace(path)
    size_kb = path.stat().st_size / 1024
    print(f"   converted → sRGB, saved ({size_kb:.0f} KB)")


def main() -> int:
    if not SRGB_ICC_PATH.exists():
        print(f"ERROR: sRGB ICC profile not found at {SRGB_ICC_PATH}", file=sys.stderr)
        return 1
    if not IMAGES_DIR.is_dir():
        print(f"ERROR: {IMAGES_DIR} does not exist", file=sys.stderr)
        return 1

    srgb_profile = ImageCms.ImageCmsProfile(str(SRGB_ICC_PATH))

    targets = sorted(
        p for p in IMAGES_DIR.iterdir()
        if p.suffix.lower() in {".jpg", ".jpeg"} and not p.name.startswith(".")
    )

    if not targets:
        print("No JPEG images found in assets/images/")
        return 0

    print(f"Converting {len(targets)} image(s) to sRGB IEC61966-2.1…")
    for path in targets:
        try:
            convert_one(path, srgb_profile)
        except Exception as exc:
            print(f"   FAILED: {exc}", file=sys.stderr)
            return 2

    print("\nDone.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
