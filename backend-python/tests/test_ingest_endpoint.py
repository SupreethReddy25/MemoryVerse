"""
Integration tests for the ingest endpoint — 7 test cases.
Uses mocked Pinecone and embedder to avoid real API calls.
"""

import base64
import pytest
from unittest.mock import patch, MagicMock
from httpx import AsyncClient, ASGITransport

# Mock the embedder and pinecone_client BEFORE importing main
# to prevent the real sentence-transformers model from loading
_mock_model = MagicMock()
_mock_model.encode = MagicMock(side_effect=lambda texts, **kwargs: [
    [0.1] * 384 for _ in (texts if isinstance(texts, list) else [texts])
])

with patch("src.embeddings.embedder._model", _mock_model):
    with patch("src.embeddings.embedder.embed_text", return_value=[0.1] * 384):
        with patch("src.embeddings.embedder.embed_batch", return_value=[[0.1] * 384]):
            pass

import src.embeddings.embedder as embedder_module
import src.vector_store.pinecone_client as pinecone_module

# Apply mocks at module level
embedder_module.embed_text = MagicMock(return_value=[0.1] * 384)
embedder_module.embed_batch = MagicMock(return_value=[[0.1] * 384] * 5)
pinecone_module.upsert_chunks = MagicMock(return_value=5)
pinecone_module.delete_namespace = MagicMock()

# Now import the app (it will use our mocked modules)
import importlib.util
import os

_router_path = os.path.join(os.path.dirname(__file__), "..", "src", "routes", "ingest.router.py")
_router_path = os.path.abspath(_router_path)
_spec = importlib.util.spec_from_file_location("ingest_router", _router_path)
_ingest_module = importlib.util.module_from_spec(_spec)

# Patch the imports within the router module
import sys
sys.modules["src.embeddings.embedder"] = embedder_module
sys.modules["src.vector_store.pinecone_client"] = pinecone_module
_spec.loader.exec_module(_ingest_module)

from fastapi import FastAPI

app = FastAPI(title="MemoryVerse ML Service - Test")
app.include_router(_ingest_module.router)


@app.get("/health")
async def health_check():
    return {"status": "ok"}


# ─── Helper to generate valid WhatsApp content ─────────────────────
def _make_whatsapp_content(n_messages: int = 50) -> str:
    """Generate WhatsApp export with enough messages to produce chunks."""
    lines = []
    for i in range(n_messages):
        msg = f"This is test message number {i} with enough content to be meaningful and produce valid chunks when processed through the pipeline"
        lines.append(f"[12/03/23, 14:{i % 60:02d}] User{i % 3}: {msg}")
    return "\n".join(lines)


def _make_short_whatsapp_content() -> str:
    """Generate WhatsApp content that produces 0 chunks after parsing."""
    return "[12/03/23, 14:30] Alice: Hi"


# ─── Fixtures ───────────────────────────────────────────────────────
@pytest.fixture(autouse=True)
def reset_mocks():
    """Reset mocks before each test."""
    embedder_module.embed_text.reset_mock()
    embedder_module.embed_batch.reset_mock()
    pinecone_module.upsert_chunks.reset_mock()
    pinecone_module.delete_namespace.reset_mock()
    # Re-set return values
    embedder_module.embed_batch.return_value = [[0.1] * 384] * 50
    pinecone_module.upsert_chunks.return_value = 5
    yield


# ── Test 1: POST /ingest with valid WhatsApp content → 200 ─────────
@pytest.mark.asyncio
async def test_ingest_whatsapp_valid():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post("/ingest", json={
            "tenant_id": "tenant-A",
            "document_id": "doc-001",
            "file_type": "whatsapp",
            "content": _make_whatsapp_content(),
        })
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"
    assert data["vectors_upserted"] > 0


# ── Test 2: POST /ingest with valid PDF → 200 ──────────────────────
@pytest.mark.asyncio
async def test_ingest_pdf_valid():
    # Create a multi-page PDF in memory using PyMuPDF
    import fitz
    doc = fitz.open()

    # Generate text across multiple pages to ensure enough tokens for chunks
    sentence = "This is a test PDF document with meaningful content for ingestion testing. "
    for page_num in range(5):
        page = doc.new_page()
        # Insert text in small blocks to avoid truncation
        y = 72
        for _ in range(30):
            page.insert_text((72, y), sentence * 3, fontsize=10)
            y += 15

    pdf_bytes = doc.write()
    doc.close()

    content_b64 = base64.b64encode(pdf_bytes).decode("utf-8")

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post("/ingest", json={
            "tenant_id": "tenant-B",
            "document_id": "doc-002",
            "file_type": "pdf",
            "content": content_b64,
        })
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"
    assert data["vectors_upserted"] > 0


# ── Test 3: POST /ingest with content producing 0 chunks → 400 ─────
@pytest.mark.asyncio
async def test_ingest_empty_content():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post("/ingest", json={
            "tenant_id": "tenant-C",
            "document_id": "doc-003",
            "file_type": "whatsapp",
            "content": _make_short_whatsapp_content(),
        })
    assert response.status_code == 400
    data = response.json()
    assert data["detail"]["code"] == "EMPTY_CONTENT"


# ── Test 4: POST /ingest with invalid file_type → 422 ──────────────
@pytest.mark.asyncio
async def test_ingest_invalid_file_type():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post("/ingest", json={
            "tenant_id": "tenant-D",
            "document_id": "doc-004",
            "file_type": "excel",
            "content": "some content",
        })
    assert response.status_code == 422


# ── Test 5: POST /embed with text → 200, 384 dimensions ────────────
@pytest.mark.asyncio
async def test_embed_text():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post("/embed", json={
            "text": "What is the meaning of life?",
        })
    assert response.status_code == 200
    data = response.json()
    assert len(data["vector"]) == 384


# ── Test 6: DELETE /namespace → 200 ─────────────────────────────────
@pytest.mark.asyncio
async def test_delete_namespace():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.request("DELETE", "/namespace", json={
            "tenant_id": "tenant-E",
        })
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"
    pinecone_module.delete_namespace.assert_called_with("tenant-E")


# ── Test 7 (CRITICAL): Namespace isolation test ────────────────────
@pytest.mark.asyncio
async def test_namespace_isolation():
    """
    Make two /ingest calls with different tenant_ids.
    Verify pinecone_client.upsert_chunks was called with the correct
    tenant_id for each, ensuring namespace isolation.
    """
    pinecone_module.upsert_chunks.reset_mock()

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        # First ingest for tenant_A
        await client.post("/ingest", json={
            "tenant_id": "tenant_A",
            "document_id": "doc-A1",
            "file_type": "whatsapp",
            "content": _make_whatsapp_content(),
        })

        # Second ingest for tenant_B
        await client.post("/ingest", json={
            "tenant_id": "tenant_B",
            "document_id": "doc-B1",
            "file_type": "whatsapp",
            "content": _make_whatsapp_content(),
        })

    # Verify upsert was called twice with different tenant_ids
    assert pinecone_module.upsert_chunks.call_count == 2

    calls = pinecone_module.upsert_chunks.call_args_list

    # First call should be for tenant_A
    first_call_kwargs = calls[0].kwargs if calls[0].kwargs else {}
    first_call_args = calls[0].args if calls[0].args else ()
    first_tenant = first_call_kwargs.get("tenant_id") or first_call_args[0]
    assert first_tenant == "tenant_A"

    # Second call should be for tenant_B
    second_call_kwargs = calls[1].kwargs if calls[1].kwargs else {}
    second_call_args = calls[1].args if calls[1].args else ()
    second_tenant = second_call_kwargs.get("tenant_id") or second_call_args[0]
    assert second_tenant == "tenant_B"

    # They must NEVER share a namespace
    assert first_tenant != second_tenant
