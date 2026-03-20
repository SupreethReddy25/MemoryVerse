"""
PDF parser — extracts text from PDF bytes using PyMuPDF (fitz).
"""

import re
import fitz  # PyMuPDF


def parse_pdf(file_bytes: bytes) -> str:
    """
    Extract and clean text from a PDF file.

    Args:
        file_bytes: Raw PDF file bytes

    Returns:
        Single cleaned string with all page text joined by double newlines
    """
    doc = fitz.open(stream=file_bytes, filetype="pdf")
    pages: list[str] = []

    for page in doc:
        text = page.get_text()

        # Remove form feed characters
        text = text.replace("\x0c", "")

        # Strip leading/trailing whitespace per page
        text = text.strip()

        # Collapse 3+ consecutive newlines into 2
        text = re.sub(r"\n{3,}", "\n\n", text)

        if text:
            pages.append(text)

    doc.close()

    return "\n\n".join(pages)
