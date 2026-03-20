"""
Unit tests for the text chunker — 8 test cases.
"""

import math
import pytest
import tiktoken
from src.ingestion.chunker import chunk_text, CHUNK_SIZE, CHUNK_OVERLAP, MIN_CHUNK_SIZE

_encoding = tiktoken.get_encoding("cl100k_base")


def _generate_text_with_n_tokens(n: int) -> str:
    """Generate a text string with approximately n tokens."""
    # Use a simple repeating pattern that tokenizes predictably
    word = "hello "
    tokens_per_word = len(_encoding.encode(word))
    # Generate more than enough words, then trim to exact token count
    text = word * (n * 2)
    tokens = _encoding.encode(text)
    return _encoding.decode(tokens[:n])


# ── Test 1: Short text (< MIN_CHUNK_SIZE tokens) returns empty list ─
def test_short_text_returns_empty():
    # Generate text with fewer than MIN_CHUNK_SIZE tokens
    short_text = _generate_text_with_n_tokens(MIN_CHUNK_SIZE - 1)
    result = chunk_text(short_text)
    assert result == []


# ── Test 2: Text of exactly CHUNK_SIZE tokens returns one chunk ─────
def test_exact_chunk_size_returns_one_chunk():
    text = _generate_text_with_n_tokens(CHUNK_SIZE)
    result = chunk_text(text)
    assert len(result) == 1
    # Verify the chunk's token count
    chunk_tokens = _encoding.encode(result[0])
    assert len(chunk_tokens) == CHUNK_SIZE


# ── Test 3: Text of CHUNK_SIZE + 1 tokens returns two chunks ───────
def test_chunk_size_plus_one_returns_two_chunks():
    text = _generate_text_with_n_tokens(CHUNK_SIZE + 1)
    result = chunk_text(text)
    assert len(result) == 2


# ── Test 4: Overlap — last 80 tokens of chunk 1 == first 80 of chunk 2
def test_overlap_correct():
    # Need text long enough for at least 2 full chunks
    text = _generate_text_with_n_tokens(CHUNK_SIZE + CHUNK_OVERLAP + 100)
    result = chunk_text(text)
    assert len(result) >= 2

    # Get tokens for first two chunks
    chunk1_tokens = _encoding.encode(result[0])
    chunk2_tokens = _encoding.encode(result[1])

    # Last CHUNK_OVERLAP tokens of chunk 1 should equal first CHUNK_OVERLAP of chunk 2
    overlap_from_chunk1 = chunk1_tokens[-CHUNK_OVERLAP:]
    overlap_from_chunk2 = chunk2_tokens[:CHUNK_OVERLAP]
    assert overlap_from_chunk1 == overlap_from_chunk2


# ── Test 5: No chunk below MIN_CHUNK_SIZE tokens ───────────────────
def test_no_chunk_below_min_size():
    text = _generate_text_with_n_tokens(CHUNK_SIZE + 10)
    result = chunk_text(text)
    for chunk in result:
        token_count = len(_encoding.encode(chunk))
        assert token_count >= MIN_CHUNK_SIZE


# ── Test 6: Empty string returns empty list ─────────────────────────
def test_empty_string_returns_empty():
    assert chunk_text("") == []
    assert chunk_text("   ") == []


# ── Test 7: Very long text produces correct chunk count ─────────────
def test_long_text_chunk_count():
    total_tokens = 10000
    text = _generate_text_with_n_tokens(total_tokens)
    result = chunk_text(text)

    step = CHUNK_SIZE - CHUNK_OVERLAP
    expected_count = math.ceil((total_tokens - CHUNK_OVERLAP) / step)

    # Allow for last chunk being too small and discarded
    # The exact count depends on whether the last chunk meets MIN_CHUNK_SIZE
    assert len(result) >= expected_count - 1
    assert len(result) <= expected_count


# ── Test 8: Output chunks decode back to valid UTF-8 strings ───────
def test_chunks_are_valid_utf8():
    text = _generate_text_with_n_tokens(1000)
    result = chunk_text(text)
    for chunk in result:
        # This will raise if not valid UTF-8
        chunk.encode("utf-8").decode("utf-8")
        assert isinstance(chunk, str)
        assert len(chunk) > 0
