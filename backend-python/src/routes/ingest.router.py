"""
Ingest router — endpoints for document ingestion, embedding, and namespace management.
"""

import base64
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, field_validator
from typing import Literal

from src.ingestion.whatsapp_parser import parse_whatsapp_export
from src.ingestion.pdf_parser import parse_pdf
from src.ingestion.chunker import chunk_text
from src.embeddings.embedder import embed_text, embed_batch
from src.vector_store.pinecone_client import upsert_chunks, delete_namespace

router = APIRouter()


# ─── Request / Response Models ──────────────────────────────

class IngestRequest(BaseModel):
    tenant_id: str
    document_id: str
    file_type: Literal["whatsapp", "pdf"]
    content: str


class IngestResponse(BaseModel):
    status: str
    vectors_upserted: int


class EmbedRequest(BaseModel):
    text: str


class EmbedResponse(BaseModel):
    vector: list[float]


class NamespaceDeleteRequest(BaseModel):
    tenant_id: str


class ErrorResponse(BaseModel):
    error: str
    code: str


# ─── Endpoints ──────────────────────────────────────────────

@router.post("/ingest", response_model=IngestResponse)
async def ingest_document(req: IngestRequest):
    """
    Ingest a document: parse → chunk → embed → upsert to Pinecone.
    Supports WhatsApp exports (raw text) and PDFs (base64-encoded bytes).
    """
    try:
        # Step 1: Parse based on file type
        if req.file_type == "whatsapp":
            messages = parse_whatsapp_export(req.content)
            text = "\n".join(messages)
        elif req.file_type == "pdf":
            file_bytes = base64.b64decode(req.content)
            text = parse_pdf(file_bytes)
        else:
            raise HTTPException(
                status_code=422,
                detail={"error": f"Invalid file_type: {req.file_type}", "code": "VALIDATION_ERROR"},
            )

        # Step 2: Chunk the text
        chunks = chunk_text(text)

        if len(chunks) == 0:
            raise HTTPException(
                status_code=400,
                detail={"error": "No content after parsing", "code": "EMPTY_CONTENT"},
            )

        # Step 3: Embed all chunks
        embeddings = embed_batch(chunks)

        # Step 4: Upsert to Pinecone
        count = upsert_chunks(
            tenant_id=req.tenant_id,
            document_id=req.document_id,
            chunks=chunks,
            embeddings=embeddings,
        )

        return IngestResponse(status="ok", vectors_upserted=count)

    except HTTPException:
        raise
    except Exception as e:
        # Check if it's a Pinecone-related error
        error_str = str(e).lower()
        if "pinecone" in error_str or "vector" in error_str or "index" in error_str:
            raise HTTPException(
                status_code=503,
                detail={"error": "Vector store unavailable", "code": "VECTOR_STORE_ERROR"},
            )
        raise HTTPException(
            status_code=500,
            detail={"error": str(e), "code": "INTERNAL_ERROR"},
        )


@router.post("/embed", response_model=EmbedResponse)
async def embed_text_endpoint(req: EmbedRequest):
    """
    Internal endpoint — generate a single embedding for query text.
    Called by backend-node for the query path.
    """
    vector = embed_text(req.text)
    return EmbedResponse(vector=vector)


@router.delete("/namespace")
async def delete_namespace_endpoint(req: NamespaceDeleteRequest):
    """
    Delete ALL vectors in a tenant's namespace. Use with caution.
    """
    delete_namespace(req.tenant_id)
    return {"status": "ok"}
