# Zero task-count icon designs

These selected designs are now the Android launcher's task-count states.
`comparison.png` preserves the reviewed family in one sheet.

## States

| Production source | Meaning |
|---|---|
| `apps/agent-mobile/assets/brand/task-count/0-empty.svg` | No Home tasks: the reduced graphite-metal checkmark with more launcher-mask clearance. |
| `apps/agent-mobile/assets/brand/task-count/1-task.svg` | One Home task: one open ring and bar. |
| `apps/agent-mobile/assets/brand/task-count/2-tasks.svg` | Two Home tasks: two open rows. |
| `apps/agent-mobile/assets/brand/task-count/3-tasks.svg` | Three Home tasks: three open rows. |
| `apps/agent-mobile/assets/brand/task-count/4-plus-tasks.svg` | Four or more Home tasks: four open rows. |

The icon count caps at four visible rows. All states use the same full-bleed
white square and V7 dark graphite-metal finish. Task rows grow as the count falls
so each state uses the icon area clearly. Android receives separate foreground,
background, and monochrome layers, then applies the launcher's circle, squircle,
rounded-square, or square mask.

## Source and rendering

`apps/agent-mobile/assets/brand/task-count/template.svg` owns the background,
material gradients, filters, and task-row definition. `bin/generate-todo-icons`
owns each state's composition and generates the self-contained SVGs, Android
legacy/adaptive/monochrome PNGs, and this comparison sheet.

Requirements: Python 3, ImageMagick with SVG support, and DejaVu Sans for the
comparison labels.

```bash
bin/generate-todo-icons
```

The comparison sheet shows the unmasked square launcher sources. The generator
validates dimensions, full-bleed white launcher corners, transparent favicon and
splash corners, web artwork coverage, neutral colors, and Android's adaptive safe
zone. The checkmark uses the task rows' graphite material with continuous
geometry, so its corner has no overlapping-bar seam. The current design scales
the original path by 1.2325 and its material strokes by 1.088; the generated
adaptive foreground occupies 444 × 323 pixels of its 1024 × 1024 layer.

Runtime switching is Android-only. Android's primary APK and pre-hydration icon
is the static three-row mark from `apps/agent-mobile/assets/brand/todo-icon.svg`;
these five task-count designs are alternate launcher states selected after Home
hydrates. The static iOS icon, splash mark, mobile tab icon, and web favicon also
derive from that three-row source. Browser favicons remove its white background
and enlarge the artwork to about 90% of the canvas; native launcher and Apple
touch outputs keep opaque backgrounds for platform masking.
