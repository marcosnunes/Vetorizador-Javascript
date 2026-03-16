#!/usr/bin/env python3
import argparse
import base64
import io
import json
import os
import traceback


def _write_json(path, payload):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)


def _safe_preview(text, size=160):
    text = (text or "").strip()
    if not text:
        return ""
    return text[:size]


def _extract_text_with_paddle(pdf_bytes, total_pages_hint):
    import numpy as np
    import pypdfium2 as pdfium
    from paddleocr import PaddleOCR

    doc = pdfium.PdfDocument(pdf_bytes)
    total_pages = len(doc)
    pages_limit = total_pages
    if isinstance(total_pages_hint, int) and total_pages_hint > 0:
        pages_limit = min(total_pages, total_pages_hint)

    # Reduce noisy logs in server context.
    show_log = str(os.getenv("PDFTOARCGIS_PADDLE_SHOW_LOG", "false")).lower() == "true"
    lang = str(os.getenv("PDFTOARCGIS_PADDLE_LANG", "pt")).strip() or "pt"

    ocr = PaddleOCR(use_angle_cls=True, lang=lang, show_log=show_log)

    full_chunks = []
    pages_meta = []

    for idx in range(pages_limit):
        page = doc[idx]
        # Scale tuned for scanned documents with small coordinate fonts.
        pil_img = page.render(scale=2.4).to_pil()
        arr = np.array(pil_img)

        result = ocr.ocr(arr, cls=True)
        lines = []

        # Paddle returns nested arrays; handle both common layouts.
        if isinstance(result, list):
            for block in result:
                if isinstance(block, list):
                    for item in block:
                        if isinstance(item, (list, tuple)) and len(item) >= 2:
                            txt_info = item[1]
                            if isinstance(txt_info, (list, tuple)) and len(txt_info) >= 1:
                                line = str(txt_info[0] or "").strip()
                                if line:
                                    lines.append(line)

        page_text = "\n".join(lines).strip()
        if page_text:
            full_chunks.append(f"--- PAGINA {idx + 1} ---\n{page_text}")

        pages_meta.append({
            "pageNumber": idx + 1,
            "chars": len(page_text),
            "preview": _safe_preview(page_text)
        })

    return "\n\n".join(full_chunks).strip(), pages_meta


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    try:
        with open(args.input, "r", encoding="utf-8") as f:
            payload = json.load(f)

        b64 = str(payload.get("pdfBase64") or "").strip()
        if not b64:
            raise ValueError("pdfBase64 ausente no input do PaddleOCR local.")

        total_pages_hint = payload.get("totalPagesHint")
        if not isinstance(total_pages_hint, int):
            total_pages_hint = 0

        pdf_bytes = base64.b64decode(b64, validate=False)
        text, pages_meta = _extract_text_with_paddle(pdf_bytes, total_pages_hint)

        _write_json(args.output, {
            "success": True,
            "engine": "paddleocr-local",
            "text": text,
            "pages": pages_meta
        })
    except Exception as exc:
        _write_json(args.output, {
            "success": False,
            "error": f"{type(exc).__name__}: {exc}",
            "trace": traceback.format_exc(limit=3)
        })
        raise


if __name__ == "__main__":
    main()
