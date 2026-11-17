# Local Kovach brand

The mark is a terminal prompt `>` with a glowing ingot for the cursor: a coding agent that works at your prompt, and the smith's forge the name comes from (*kovač*).

| File | Use |
| --- | --- |
| `mark-light.svg`, `mark-dark.svg` | The mark alone, transparent background, for light or dark surfaces |
| `wordmark-light.svg`, `wordmark-dark.svg` | Mark + "Local Kovach" lockup, text outlined (no font needed) |
| `app-icon.svg`, `app-icon-1024.png`, `AppIcon.icns` | macOS app icon (1024 master on the standard 824 px tile) |
| `favicon.svg`, `favicon.ico`, `favicon-{16,32,48,180}.png` | Browser and touch icons |
| `social-preview.svg`, `social-preview.png` | GitHub social preview, 1280 × 640 |

## Colours

| Name | Hex | Role |
| --- | --- | --- |
| Graphite | `#16181D` | Ink on light, background of icons |
| Paper | `#F4F5F7` | Ink on dark |
| Ember | `#E8642C` | The ingot. Only ever the cursor bar, never text |
| Slate | `#5B606B` / `#A9AEB8` | "Local" in the wordmark, on light / on dark |

## Rules

- Keep the ember bar the only coloured element. Don't recolour the chevron.
- Clear space around the mark: at least half its height on every side.
- Smallest sizes: mark 16 px, wordmark 20 px tall.
- Always write the name as "Local Kovach" in text.

## Rebuilding

`scripts/brand/generate.py` writes every SVG and PNG above. It shapes the wordmark with Space Grotesk (SIL Open Font License 1.1) and saves the letters as outlines, so the font itself is not shipped.

```sh
pip install fonttools uharfbuzz brotli icnsutil
npm pack @fontsource/space-grotesk@5 && tar xzf fontsource-space-grotesk-*.tgz
SPACE_GROTESK_DIR=package/files python3 scripts/brand/generate.py out
# .ico: convert out/favicon-16.png out/favicon-32.png out/favicon-48.png out/favicon.ico
# .icns: render app-icon.svg at 16–1024 px and pack the PNGs with icnsutil
```
