/**
 * 应用的品牌 mark —— 一枚黑底橙色火花，几何定义在
 * `scripts/brand-assets.py`，产物落在 `web/public/`。
 *
 * 之所以是一次「换图」而不是换个文件名：原来那张是白 π 位图，π 是项目早期的
 * 代号；现在这枚火花是 Claude 的视觉语言（陶土橙 + 交替长短的十二射线），
 * 侧栏、新会话页、运行状态行、浏览器标签页、以及装到桌面后的应用图标全部共用
 * 同一份矢量文件，换图只改脚本一处。
 *
 * 用 SVG 而不是 PNG：这枚图标是纯几何图形，矢量在 24px 的侧栏砖和 512px 的
 * 桌面图标上都不会糊；位图只在 PWA manifest 和 apple-touch-icon 要求固定像素
 * 尺寸的地方出现（见 `web/index.html`）。
 *
 * 放在 `public/` 而不是 `src/assets/`：favicon 与 manifest 需要一个稳定地址，
 * 而打包器会给 `src/` 里的资源加指纹，两者都要在构建后仍可按名字取到。
 */
export const BRAND_MARK_URL = "/mark.svg";

/**
 * 旧名字。品牌从 π 换成火花时保留了它，因为 `TurnStatus` 等处的注释和
 * 三处 `<img>` 都还按这个名字引用 —— 保留一个别名比一次无关重命名
 * 更容易读懂「只是换了图」这件事。
 *
 * @deprecated 新代码请用 `BRAND_MARK_URL`。
 */
export const PI_MARK_URL = BRAND_MARK_URL;
