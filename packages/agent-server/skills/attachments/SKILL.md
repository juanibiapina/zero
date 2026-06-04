---
name: attachments
description: "User-sent attachments (photos, PDFs, documents). Use when the user sends a file or refers to a file they shared."
---

# attachments

Files the user sends over Telegram are saved to `/workspace/attachments/`.
Each turn that carries a file includes a `[File saved to <path> (<mime>)]`
note with the on-disk path and MIME type.

## How to handle each type

- **Images** (`image/*`): use the `read` tool directly on the path. Pi
  reads images natively (auto-resizes, vision).
- **Text-based PDFs**: extract text with `pdftotext <file.pdf> -`.
- **Scanned / image-only PDFs** (pdftotext returns little or nothing):
  rasterize pages and read them with vision:
  ```
  pdftoppm -png -r 150 <file.pdf> /workspace/attachments/<name>-page
  ```
  then `read` the generated PNGs. Use `pdfinfo <file.pdf>` to check page count first.
- **Anything else** (text, csv, json, code, audio, video): inspect with
  bash (`file`, `head`, `cat`, etc.) as appropriate.

## Notes

- Files persist across conversations under `/workspace/attachments/`.
- Filenames may be auto-generated (e.g. `photo_<id>.jpg`) when the
  original message carried none.
