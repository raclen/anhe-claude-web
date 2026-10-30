#!/usr/bin/env python3
"""
生成应用图标（Claude 风格的「火花」标记）。

一处几何定义，两种产物：`web/public/mark.svg`（浏览器标签页、侧栏、新会话页
直接引用的矢量图）与同目录下的 PNG/ICO（PWA manifest、apple-touch-icon、
favicon）。尺寸和颜色都从下面的常量来，改一个数字两边同步，不存在「SVG 改了
但 PNG 忘改」的状态。

为什么用 Python + Pillow 而不是某个 SVG 光栅化器：本机没有 cairosvg/resvg/
sharp，Pillow 是唯一确定可用的绘图库。代价是光栅路径由本脚本自己画，所以
射线形状在 SVG 和 PNG 里各实现一次 —— 常量共享、几何一致，差距只在抗锯齿。

用法：python scripts/brand-assets.py
"""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw

PUBLIC = Path(__file__).resolve().parent.parent / "web" / "public"

# --- 几何 -------------------------------------------------------------------
#
# 一枚 12 射线火花：长短交替，从正上方顺时针铺开。这不是 Anthropic 商标的
# 精确还原（商标不能照抄），是同一视觉语言下的自有作品 —— 一眼能读成 Claude
# 的那颗火花，同时是本项目自己的图标。
VIEWBOX = 64
CENTER = VIEWBOX / 2
RAY_COUNT = 12
RAY_LONG = 22.5
RAY_SHORT = 17.0
RAY_INNER = 7.5
RAY_WIDTH = 4.4
START_DEG = -90  # 第一条射线朝正上
TILE_RADIUS = 14  # 圆角方砖的半径，仅 SVG/非 maskable 用

# --- 颜色 -------------------------------------------------------------------
#
# 暖炭黑底 + Claude 的陶土橙。底色是深色的，和以前一样：favicon 没法跟随主题，
# 深砖在浅色和深色两种浏览器 chrome 上都能读出来；橙色的火花在浅色侧栏上也很
# 跳。陶土橙是 Claude 的产品色，这是「符合 claude 含义」的那一半。
TILE = (31, 30, 29)        # #1F1E1D
SPARK = (217, 119, 87)     # #D97757
SPARK_HEX = "#d97757"
TILE_HEX = "#1f1e1d"


def rays() -> list[tuple[float, float, float]]:
    """每条射线的 (角度弧度, 起点半径, 终点半径)。"""
    out = []
    for index in range(RAY_COUNT):
        deg = START_DEG + index * (360 / RAY_COUNT)
        rad = math.radians(deg)
        outer = RAY_LONG if index % 2 == 0 else RAY_SHORT
        out.append((rad, RAY_INNER, outer))
    return out


def svg() -> str:
    lines = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {VIEWBOX} {VIEWBOX}"',
        f' width="{VIEWBOX}" height="{VIEWBOX}">',
        f'  <rect width="{VIEWBOX}" height="{VIEWBOX}" rx="{TILE_RADIUS}" fill="{TILE_HEX}"/>',
        f'  <g stroke="{SPARK_HEX}" stroke-width="{RAY_WIDTH}" stroke-linecap="round">',
    ]
    for rad, inner, outer in rays():
        x0 = CENTER + inner * math.cos(rad)
        y0 = CENTER + inner * math.sin(rad)
        x1 = CENTER + outer * math.cos(rad)
        y1 = CENTER + outer * math.sin(rad)
        lines.append(
            f'    <line x1="{x0:.2f}" y1="{y0:.2f}" x2="{x1:.2f}" y2="{y1:.2f}"/>'
        )
    lines += ["  </g>", "</svg>", ""]
    return "\n".join(lines)


def render(size: int, *, radius: float, scale: float = 1.0) -> Image.Image:
    """
    光栅化一枚图标。

    `radius` 是圆角在最终像素上的半径（0 = 满幅方块，给 maskable 用）；`scale`
    缩放射线，让 maskable 版留出安全区。先在 8 倍画布上画再缩回来 —— Pillow 的
    `line` 没有圆头，抗锯齿也只有缩小时才有，超采样一次把两件事一并解决。
    """
    ss = 8
    canvas = size * ss
    image = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    if radius > 0:
        draw.rounded_rectangle(
            (0, 0, canvas - 1, canvas - 1), radius=radius * ss, fill=TILE + (255,)
        )
    else:
        draw.rectangle((0, 0, canvas - 1, canvas - 1), fill=TILE + (255,))

    unit = canvas / VIEWBOX
    width = RAY_WIDTH * unit * scale
    for rad, inner, outer in rays():
        cx = cy = canvas / 2
        x0 = cx + inner * unit * scale * math.cos(rad)
        y0 = cy + inner * unit * scale * math.sin(rad)
        x1 = cx + outer * unit * scale * math.cos(rad)
        y1 = cy + outer * unit * scale * math.sin(rad)
        draw.line((x0, y0, x1, y1), fill=SPARK + (255,), width=max(1, round(width)))
        # 圆头：两端各盖一个半径 = 线宽一半的圆
        for x, y in ((x0, y0), (x1, y1)):
            draw.ellipse(
                (x - width / 2, y - width / 2, x + width / 2, y + width / 2),
                fill=SPARK + (255,),
            )
    return image.resize((size, size), Image.LANCZOS)


def main() -> None:
    PUBLIC.mkdir(parents=True, exist_ok=True)

    (PUBLIC / "mark.svg").write_text(svg(), encoding="utf-8")

    # 标签页与侧栏用的 PNG 尺寸：manifest 要 192/512，iOS 主屏图标要 180。
    render(192, radius=TILE_RADIUS * 192 / VIEWBOX).save(PUBLIC / "icon-192.png")
    render(512, radius=TILE_RADIUS * 512 / VIEWBOX).save(PUBLIC / "icon-512.png")
    render(180, radius=TILE_RADIUS * 180 / VIEWBOX).save(PUBLIC / "apple-touch-icon.png")

    # maskable：满幅方块 + 缩到 80% 安全区以内。任何圆形/水滴裁切都不会切到火花。
    render(512, radius=0, scale=0.88).save(PUBLIC / "icon-maskable-512.png")

    # 少数浏览器不管 <link rel="icon"> 直接来要 /favicon.ico；没有这个文件时
    # 静态服务会兜底返回 index.html，浏览器拿到 HTML 当图标。
    ico = [render(s, radius=TILE_RADIUS * s / VIEWBOX) for s in (16, 32, 48)]
    ico[-1].save(PUBLIC / "favicon.ico", format="ICO", sizes=[(16, 16), (32, 32), (48, 48)])

    for name in (
        "mark.svg",
        "icon-192.png",
        "icon-512.png",
        "icon-maskable-512.png",
        "apple-touch-icon.png",
        "favicon.ico",
    ):
        # 纯 ASCII：Windows 控制台默认 GBK，打勾号会 UnicodeEncodeError
        print(f"  ok web/public/{name}")


if __name__ == "__main__":
    main()
