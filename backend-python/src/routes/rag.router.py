"""
RAG router — endpoint for RAG query streaming via SSE.
"""

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from src.rag.pipeline import rag_stream

router = APIRouter()


class RagRequest(BaseModel):
    tenant_id: str
    query_vector: list[float]
    query_text: str


@router.post("/rag")
async def rag_query(req: RagRequest):
    """
    Execute RAG query and stream tokens as SSE events.
    Called internally by backend-node — never directly from frontend or Android.
    """
    return StreamingResponse(
        rag_stream(req.tenant_id, req.query_text, req.query_vector),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )
