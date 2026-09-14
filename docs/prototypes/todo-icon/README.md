# Zero task-count icon designs

These are the selected icon designs. They are prototypes only; the mobile app does not use them yet.

## States

| File | Meaning |
|---|---|
| `0-empty.svg` | No available tasks: one centered graphite-metal checkmark. |
| `1-task.svg` | One available task: one open ring and bar. |
| `2-tasks.svg` | Two available tasks: two open rows. |
| `3-tasks.svg` | Three available tasks: three open rows. |
| `4-plus-tasks.svg` | Four or more available tasks: four open rows. |

The icon count caps at four visible rows. All states use the same flat white circular ground and V7 dark graphite-metal finish. Task rows grow as the count falls so each state uses the icon area clearly. `comparison.png` shows the full family.

## Source and rendering

`template.svg` owns the background, material gradients, filters, and task-row definition. `render.py` adds each state's composition, writes the five self-contained SVGs, renders 2048 × 2048 RGBA PNGs, validates their dimensions and transparent corners, and creates the comparison sheet.

Requirements: Python 3, ImageMagick with SVG support, and DejaVu Sans for comparison labels.

```bash
python3 docs/prototypes/todo-icon/render.py
```

The checkmark uses the same `metalSide`, `ringBevel`, `silverFace`, and `metalShadow` definitions as the task rows. It uses purpose-built continuous geometry so the corner has no overlapping-bar seam.

## Not implemented

No launcher-icon switching, app configuration, native assets, changelog entry, build, or Pixel verification is included. Android and iOS support for changing an installed app icon needs a separate implementation plan and platform investigation.
