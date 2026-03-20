"""
Text chunker — splits text into overlapping token-based chunks
using tiktoken (cl100k_base encoding).
"""

import math
import tiktoken

CHUNK_SIZE = 400       # tokens
CHUNK_OVERLAP = 80     # tokens
MIN_CHUNK_SIZE = 50    # tokens — discard chunks below this

_encoding = tiktoken.get_encoding("cl100k_base")


def chunk_text(text: str) -> list[str]:
    """
    Split text into overlapping chunks based on token count.

    Uses a sliding window of CHUNK_SIZE tokens, stepping by
    (CHUNK_SIZE - CHUNK_OVERLAP). Discards chunks below MIN_CHUNK_SIZE.

    Args:
        text: Input text to chunk

    Returns:
        List of chunk strings, each within the token size bounds
    """
    if not text or not text.strip():
        return []

    tokens = _encoding.encode(text)
    total_tokens = len(tokens)

    if total_tokens < MIN_CHUNK_SIZE:
        return []

    step = CHUNK_SIZE - CHUNK_OVERLAP
    chunks: list[str] = []

    for start in range(0, total_tokens, step):
        end = min(start + CHUNK_SIZE, total_tokens)
        chunk_tokens = tokens[start:end]

        # Discard chunks below minimum size
        if len(chunk_tokens) < MIN_CHUNK_SIZE:
            continue

        chunk_str = _encoding.decode(chunk_tokens)
        chunks.append(chunk_str)

        # If we've reached the end, stop
        if end >= total_tokens:
            break

    return chunks
