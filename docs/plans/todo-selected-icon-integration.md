# Selected todo icon integration

Use the user-approved `white-graphite-v6.svg` on mobile and the agent web app.
The approval on 2026-09-13 supersedes the pending concept gate in the separate
icon exploration plan. Preserve the SVG's three graphite task rows and material
finish; do not redesign it or change application UI colors.

## Implementation

1. Copy the approved SVG unchanged to
   `apps/agent-mobile/assets/brand/todo-icon.svg` as the shipped source of truth.
2. Add `bin/generate-todo-icons` (Python standard library + ImageMagick). Generate
   opaque 1024px app icon, transparent adaptive foreground inside Android's safe
   zone, a monochrome foreground from the same geometry, transparent splash mark,
   48px fallback favicon, and web SVG/PNG/180px touch icon. Strip metadata and
   verify deterministic regeneration. Android/iOS apply their own masks; use a
   white adaptive background and remove the stock Expo icon overrides.
3. Wire Expo config and the agent-web HTML favicon/touch-icon links. Leave the
   landing site, dashboard, tab icons, accents, package IDs, and app names alone.
4. Document generation, add mobile and web changelog entries, and commit source,
   derivatives, config, and docs together. Do not commit other icon studies.

## Verification and release

- Run generation twice; compare checksums. Inspect full-size and 16/32/48px
  previews, dimensions/alpha, and adaptive mask cropping. Confirm config resolves.
- Run mobile and web checks and Android export; the beta polish's whole-repo CI
  already passed lint/typecheck/build and reached the known NixOS workerd failure
  in dashboard tests. GitHub CI remains the whole-repo gate.
- Build a development client locally, install only that build on the Pixel, and
  inspect the launcher and successful startup. The Pixel remains dev-client-only.
- Inspect the web favicon through Vite preview and verify the built assets.
- Finish the interrupted throwaway-task move check and remove its project.
- Commit, push main, wait for CI and the agent Worker's asset deployment, then
  build/publish the preview APK using the existing local/Drive release procedure.

No EAS cloud build, app-store submission, unrelated branding, or UI recoloring.

## Evidence

- Development build 68 (`development-pixel`, local) ran prebuild and generated the
  graphite foreground before compilation. Installed on the Pixel without clearing
  data; launcher screenshot `2026-09-14_011128/icon-search/.../icon-zero-agent.png`
  shows the selected icon without clipping. Version 68 remains a dev client.
- The app loaded local Metro and completed rename → move to loose → Home → move
  back to project, waiting-condition resolve, and project deletion. All remaining
  throwaway entities were deleted; timeout/font/radio settings were restored.
- Android monochrome geometry passed generated-asset validation; themed launcher
  mode was not toggled. Standalone splash appearance still needs release-device
  inspection; the dev client cannot prove that launch surface.

- Generated twice with identical SHA-256 checksums. Shipped source preserves the
  approved SVG artwork; only trailing whitespace on three blank lines was removed
  for repository checks. Dimensions, alpha, grayscale, and adaptive safe-zone checks pass.
- Mobile: 123 tests, lint/typecheck, and Android export pass. Web tests/lint and the
  production-configured web build pass. Expo config resolves the new paths.
- Browser: Vite preview at port 4176 served SVG favicon (4340 bytes), PNG fallback,
  and touch icon with 200 and correct image MIME types. Closed the test tab and
  stopped preview afterward; screenshot at `/tmp/todo-icon-web.png`.
- Development build 67 succeeded but Pixel showed the old Expo icon. Its build log
  explicitly skipped app-config package settings because an Android directory was
  present. The git-ignored native project was packed by `.easignore` and bypassed
  prebuild; this was not a launcher-cache assumption.
- Repair: exclude generated Android/iOS projects from both archive entry points,
  preserve the old local Android folder under ignored `.local/native-backup`, and
  add a `development-pixel` profile inheriting the dev client but compiling only
  ARM64. Preview keeps all ABIs. Rebuild and verify actual native prebuild resources
  before counting the launcher check as passed.
