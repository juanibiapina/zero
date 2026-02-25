# Icons

## Cloudflare Product Icons

We use the official Cloudflare product icons from the [`cloudflare/cloudflare-docs`](https://github.com/cloudflare/cloudflare-docs) repo.

### Source

Icons live at `src/icons/` on the `production` branch:

- **Browse:** https://github.com/cloudflare/cloudflare-docs/tree/production/src/icons
- **Raw download:** `https://raw.githubusercontent.com/cloudflare/cloudflare-docs/production/src/icons/{name}.svg`

### Available icons

Every Cloudflare product has an icon. Some useful ones:

`workers.svg`, `pages.svg`, `r2.svg`, `d1.svg`, `durable-objects.svg`, `kv.svg`, `queues.svg`, `workers-ai.svg`, `hyperdrive.svg`, `vectorize.svg`, `workflows.svg`, `containers.svg`, `turnstile.svg`, `stream.svg`, `images.svg`, `ai-gateway.svg`, `pipelines.svg`, `secrets-store.svg`, `browser-rendering.svg`

### Adding a new icon

1. Download the SVG:
   ```bash
   curl -sL "https://raw.githubusercontent.com/cloudflare/cloudflare-docs/production/src/icons/{name}.svg" \
     -o zero/web/public/icons/{name}.svg
   ```

2. Use it in a node component:
   ```tsx
   <img src="/icons/{name}.svg" alt="..." style={{ width: 36, height: 36 }} />
   ```

### Styling

The icons are monochrome (black, no fill color set) so they can be tinted with CSS filters. For example, to tint orange:

```css
filter: invert(44%) sepia(98%) saturate(1200%) hue-rotate(360deg) brightness(98%) contrast(95%);
```

### Reference

- [Cloudflare Style Guide — Icons](https://developers.cloudflare.com/style-guide/components/icons/)
