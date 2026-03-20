"""
RAG pipeline — retrieves context from Pinecone, assembles prompt,
streams Gemini response tokens as SSE events.

The stream NEVER raises exceptions — errors are sent as SSE events
and the stream closes gracefully.
"""

import json
from typing import AsyncGenerator

import google.generativeai as genai

from src.vector_store.pinecone_client import query_namespace

# Configure Gemini on import
import os
from dotenv import load_dotenv
load_dotenv()
genai.configure(api_key=os.getenv("GEMINI_API_KEY", ""))

_SYSTEM_INSTRUCTION = (
    "You are a personal assistant replying on behalf of the user. "
    "Answer using ONLY the provided context. Be concise — maximum "
    "2 sentences. If the context doesn't contain a clear answer, "
    "say so honestly. Do not invent information."
)

_FALLBACK_MESSAGE = (
    "I don't have information about that in your personal knowledge base."
)


def _sse_token(text: str) -> str:
    """Format a token as an SSE event."""
    return "data: " + json.dumps({"token": text}) + "\n\n"


def _sse_done() -> str:
    """Format the done event."""
    return 'data: {"done": true}\n\n'


def _sse_error(message: str) -> str:
    """Format an error event with done flag."""
    return "data: " + json.dumps({"error": message, "done": True}) + "\n\n"


async def rag_stream(
    tenant_id: str,
    query_text: str,
    query_vector: list[float],
) -> AsyncGenerator[str, None]:
    """
    Execute RAG pipeline and stream tokens as SSE events.

    1. Query Pinecone for relevant context
    2. Assemble prompt with context
    3. Stream Gemini response as SSE events
    4. On error: yield error event and close gracefully (never raise)

    Args:
        tenant_id: User's tenant ID (for namespace isolation)
        query_text: Original query text (for the prompt)
        query_vector: 384-dim query embedding (for vector search)

    Yields:
        SSE-formatted strings: data: {"token": "..."}\n\n
        Final event: data: {"done": true}\n\n
    """
    try:
        # Step 1: Query Pinecone
        matches = query_namespace(tenant_id, query_vector, top_k=5)

        # Step 2: If no matches, return fallback
        if not matches:
            yield _sse_token(_FALLBACK_MESSAGE)
            yield _sse_done()
            return

        # Step 3: Assemble context
        context = "\n---\n".join([m["text"] for m in matches])

        # Step 4: Build prompt
        user_message = f"Context:\n{context}\n\nQuestion: {query_text}"

        # Step 5: Call Gemini with streaming
        model = genai.GenerativeModel(
            "gemini-2.5-flash",
            system_instruction=_SYSTEM_INSTRUCTION,
        )

        response = model.generate_content(user_message, stream=True)

        # Step 6: Stream each chunk
        for chunk in response:
            if chunk.text:
                yield _sse_token(chunk.text)

        # Step 7: Done event
        yield _sse_done()

    except Exception as e:
        print(f"GEMINI ERROR: {e}")
        yield _sse_error("LLM unavailable")
