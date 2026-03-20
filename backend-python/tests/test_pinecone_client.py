"""
Unit tests for the Pinecone client — query_namespace function (3 tests).
Uses mocked Pinecone to avoid real API calls.
"""

import pytest
from unittest.mock import patch, MagicMock


# Mock the Pinecone client before importing
@pytest.fixture(autouse=True)
def mock_pinecone(monkeypatch):
    """Mock Pinecone client for all tests."""
    import src.vector_store.pinecone_client as pc_module

    mock_index = MagicMock()
    monkeypatch.setattr(pc_module, "_pinecone_client", MagicMock())
    monkeypatch.setattr(pc_module, "_index_name", "test-index")

    # Make _get_index return our mock
    monkeypatch.setattr(pc_module, "_get_index", lambda: mock_index)

    return mock_index


# ── Test 1: query_namespace returns correctly shaped dicts ──────────
def test_query_namespace_returns_correct_shape(mock_pinecone):
    from src.vector_store.pinecone_client import query_namespace

    mock_pinecone.query.return_value = {
        "matches": [
            {
                "id": "doc1_chunk_0",
                "score": 0.85,
                "metadata": {
                    "text": "The exam is on March 15th",
                    "document_id": "doc1",
                },
            },
            {
                "id": "doc1_chunk_1",
                "score": 0.72,
                "metadata": {
                    "text": "It will be in Hall B",
                    "document_id": "doc1",
                },
            },
        ]
    }

    results = query_namespace("tenant-abc", [0.1] * 384, top_k=5)

    assert len(results) == 2
    assert results[0]["id"] == "doc1_chunk_0"
    assert results[0]["score"] == 0.85
    assert results[0]["text"] == "The exam is on March 15th"
    assert results[0]["document_id"] == "doc1"
    assert results[1]["id"] == "doc1_chunk_1"


# ── Test 2: Matches with score < 0.3 are filtered out ──────────────
def test_query_namespace_filters_low_scores(mock_pinecone):
    from src.vector_store.pinecone_client import query_namespace

    mock_pinecone.query.return_value = {
        "matches": [
            {
                "id": "doc1_chunk_0",
                "score": 0.85,
                "metadata": {"text": "High confidence match", "document_id": "doc1"},
            },
            {
                "id": "doc1_chunk_1",
                "score": 0.25,  # Below threshold
                "metadata": {"text": "Low confidence match", "document_id": "doc1"},
            },
            {
                "id": "doc1_chunk_2",
                "score": 0.1,  # Way below threshold
                "metadata": {"text": "Very low match", "document_id": "doc1"},
            },
        ]
    }

    results = query_namespace("tenant-abc", [0.1] * 384, top_k=5)

    assert len(results) == 1
    assert results[0]["score"] == 0.85
    assert results[0]["text"] == "High confidence match"


# ── Test 3: Namespace is always f"user_{tenant_id}" ────────────────
def test_query_namespace_uses_correct_namespace(mock_pinecone):
    from src.vector_store.pinecone_client import query_namespace

    mock_pinecone.query.return_value = {"matches": []}

    query_namespace("my-tenant-123", [0.1] * 384, top_k=5)

    # Verify the mock was called with the correct namespace
    mock_pinecone.query.assert_called_once()
    call_kwargs = mock_pinecone.query.call_args.kwargs
    assert call_kwargs["namespace"] == "user_my-tenant-123"
