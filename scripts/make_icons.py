"""生成 PWA 图标 PNG（192/512 + maskable 512），零额外依赖，用 Pillow 绘制。"""

from __future__ import annotations

import os
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parent.parent / "public"

GOLD_TOP = (255, 241, 194)
GOLD_BOT = (245, 179, 1)
BG_TOP = (27, 42, 69)
BG_BOT = (8, 13, 24)

FONT_CANDIDATES = [
    r"C:\Windows\Fonts\arialbd.ttf",
    r"C:\Windows\Fonts\segoeuib.ttf",
    r"C:\Windows\Fonts\seguisb.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
]


def load_font(size: int) -> ImageFont.FreeTypeFont:
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    return ImageFont.load_default(size)


def vgrad(size: int, top, bottom) -> Image.Image:
    img = Image.new("RGB", (1, size))
    px = img.load()
    for y in range(size):
        t = y / max(1, size - 1)
        px[0, y] = tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
    return img.resize((size, size), Image.BICUBIC)


def rounded_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def draw_icon(size: int, pad_ratio: float, radius_ratio: float) -> Image.Image:
    S = size
    base = vgrad(S, BG_TOP, BG_BOT).convert("RGBA")
    base.putalpha(rounded_mask(S, int(S * radius_ratio)))

    layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    # 内容区（maskable 需要留安全区）
    inner = S * (1 - 2 * pad_ratio)
    cx = S / 2

    # 两张牌：后一张浅色，前一张深色金边
    cw, ch = inner * 0.44, inner * 0.58
    back = Image.new("RGBA", (int(cw), int(ch)), (0, 0, 0, 0))
    bd = ImageDraw.Draw(back)
    bd.rounded_rectangle((0, 0, cw - 1, ch - 1), radius=int(cw * 0.11), fill=(255, 255, 255, 225))
    back = back.rotate(-9, expand=True, resample=Image.BICUBIC)
    layer.alpha_composite(back, (int(cx - back.width / 2 - inner * 0.05), int(S * 0.5 - back.height / 2)))

    front = Image.new("RGBA", (int(cw), int(ch)), (0, 0, 0, 0))
    fd = ImageDraw.Draw(front)
    fd.rounded_rectangle(
        (0, 0, cw - 1, ch - 1),
        radius=int(cw * 0.11),
        fill=(14, 23, 40, 255),
        outline=GOLD_BOT + (255,),
        width=max(3, int(inner * 0.022)),
    )
    f = load_font(int(ch * 0.52))
    label = "0"
    tw = fd.textlength(label, font=f)
    bbox = fd.textbbox((0, 0), label, font=f)
    fd.text(
        ((cw - tw) / 2, (ch - (bbox[3] - bbox[1])) / 2 - bbox[1] - ch * 0.04),
        label,
        font=f,
        fill=GOLD_TOP + (255,),
    )
    front = front.rotate(7, expand=True, resample=Image.BICUBIC)
    layer.alpha_composite(
        front, (int(cx - front.width / 2 + inner * 0.04), int(S * 0.5 - front.height / 2))
    )

    # 底部 CABO 字样
    cf = load_font(max(10, int(inner * 0.14)))
    text = "CABO"
    tw = d.textlength(text, font=cf)
    d.text((cx - tw / 2, S * (1 - pad_ratio) - inner * 0.20), text, font=cf, fill=GOLD_BOT + (255,))

    out = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    out.alpha_composite(base)
    out.alpha_composite(layer)
    return out


def main() -> None:
    draw_icon(192, 0.10, 0.22).save(OUT / "icon-192.png")
    draw_icon(512, 0.10, 0.22).save(OUT / "icon-512.png")
    # maskable：内容收进中心 80%，背景铺满（安卓会裁圆）
    mask_bg = vgrad(512, BG_TOP, BG_BOT).convert("RGBA")
    fg = draw_icon(512, 0.18, 0.5)
    merged = Image.new("RGBA", (512, 512), (0, 0, 0, 0))
    merged.alpha_composite(mask_bg)
    merged.alpha_composite(fg)
    merged.save(OUT / "icon-maskable-512.png")
    print("icons written to", OUT)


if __name__ == "__main__":
    main()
