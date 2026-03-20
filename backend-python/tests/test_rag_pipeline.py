"""
Tests for the RAG pipeline — 5 test cases.
Uses mocked Gemini API and Pinecone to avoid real API calls.
"""

import json
import pytest
from unittest.mock import patch, MagicMock, AsyncMock


# ─── Helper to collect async generator output ──────────────────────
async def _collect_stream(gen):
    """Collect all yielded values from an async generator."""
    results = []
    async for item in gen:
        results.append(item)
    return results


# ─── Mock setup ─────────────────────────────────────────────────────
def _make_mock_matches(texts=None):
    """Create mock Pinecone query results."""
    if texts is None:
        texts = ["The OS exam is on March 15th at 9am in Hall B."]
    return [
        {"id": f"doc_chunk_{i}", "score": 0.9, "text": t, "document_id": "doc-1"}
        for i, t in enumerate(texts)
    ]


def _make_mock_chunk(text):
    """Create a mock Gemini response chunk."""
    chunk = MagicMock()
    chunk.text = text
    return chunk


# ── Test 1: rag_stream with matching context yields tokens + done ───
@pytest.mark.asyncio
async def test_rag_stream_with_context():
    mock_chunks = [_make_mock_chunk("March"), _make_mock_chunk(" 15th")]
    mock_response = MagicMock()
    mock_response.__iter__ = MagicMock(return_value=iter(mock_chunks))

    with patch("src.rag.pipeline.query_namespace", return_value=_make_mock_matches()):
        with patch("src.rag.pipeline.genai") as mock_genai:
            mock_model = MagicMock()
            mock_model.generate_content.return_value = mock_response
            mock_genai.GenerativeModel.return_value = mock_model

            from src.rag.pipeline import rag_stream
            events = await _collect_stream(rag_stream("tenant-A", "when is the OS exam?", [0.1] * 384))

    # Should have token events + done event
    assert len(events) >= 3  # at least 2 tokens + done

    # Check token events
    token_events = [e for e in events if '"token"' in e]
    assert len(token_events) >= 2

    # Check done event
    done_events = [e for e in events if '"done"' in e]
    assert len(done_events) >= 1


# ── Test 2: rag_stream with no matches yields fallback + done ───────
@pytest.mark.asyncio
async def test_rag_stream_no_matches():
    with patch("src.rag.pipeline.query_namespace", return_value=[]):
        from src.rag.pipeline import rag_stream
        events = await _collect_stream(rag_stream("tenant-B", "unknown query", [0.1] * 384))

    assert len(events) == 2

    # First event should be the fallback message
    first_data = json.loads(events[0].replace("data: ", "").strip())
    assert "don't have information" in first_data["token"]

    # Second event should be done
    second_data = json.loads(events[1].replace("data: ", "").strip())
    assert second_data["done"] is True


# ── Test 3: rag_stream with Gemini error yields error event ─────────
@pytest.mark.asyncio
async def test_rag_stream_gemini_error():
    with patch("src.rag.pipeline.query_namespace", return_value=_make_mock_matches()):
        with patch("src.rag.pipeline.genai") as mock_genai:
            mock_model = MagicMock()
            mock_model.generate_content.side_effect = Exception("API quota exceeded")
            mock_genai.GenerativeModel.return_value = mock_model

            from src.rag.pipeline import rag_stream
            events = await _collect_stream(rag_stream("tenant-C", "test query", [0.1] * 384))

    # Should yield error event, NOT raise
    assert len(events) >= 1
    error_data = json.loads(events[-1].replace("data: ", "").strip())
    assert error_data["error"] == "LLM unavailable"
    assert error_data["done"] is True


# ── Test 4: SSE format check — every event starts with "data: " ─────
@pytest.mark.asyncio
async def test_sse_format():
    with patch("src.rag.pipeline.query_namespace", return_value=[]):
        from src.rag.pipeline import rag_stream
        events = await _collect_stream(rag_stream("tenant-D", "test", [0.1] * 384))

    for event in events:
        assert event.startswith("data: "), f"Event doesn't start with 'data: ': {event}"
        assert event.endswith("\n\n"), f"Event doesn't end with '\\n\\n': {event}"


# ── Test 5 (CRITICAL): Context isolation — correct namespace used ───
@pytest.mark.asyncio
async def test_context_isolation():
    """
    rag_stream called with tenant_id "user_A" must query Pinecone with
    namespace "user_user_A" and never access "user_user_B".
    """
    with patch("src.rag.pipeline.query_namespace") as mock_query:
        mock_query.return_value = []

        from src.rag.pipeline import rag_stream

        # Call for tenant "user_A"
        await _collect_stream(rag_stream("user_A", "test query", [0.1] * 384))

        # Verify query_namespace was called with "user_A" as tenant_id
        # (pinecone_client will derive namespace "user_user_A" internally)
        mock_query.assert_called_once_with("user_A", [0.1] * 384, top_k=5)

        mock_query.reset_mock()

        # Call for tenant "user_B"
        await _collect_stream(rag_stream("user_B", "test query", [0.1] * 384))

        # Verify query_namespace was called with "user_B", not "user_A"
        mock_query.assert_called_once_with("user_B", [0.1] * 384, top_k=5)
