"""
Pinecone vector store client — manages namespace-isolated vector operations.

CRITICAL: The namespace is ALWAYS computed as f"user_{tenant_id}" inside this
module. It must NEVER be passed in as a parameter or accepted from external input.
"""

import os
from pinecone import Pinecone

_pinecone_client: Pinecone | None = None
_index_name: str | None = None


def _get_index():
    """Get or initialize the Pinecone index (lazy singleton)."""
    global _pinecone_client, _index_name

    if _pinecone_client is None:
        api_key = os.getenv("PINECONE_API_KEY")
        if not api_key:
            raise ValueError("PINECONE_API_KEY environment variable is not set")

        _pinecone_client = Pinecone(api_key=api_key)
        _index_name = os.getenv("PINECONE_INDEX_NAME", "memoryverse")

    return _pinecone_client.Index(_index_name)


def _derive_namespace(tenant_id: str) -> str:
    """
    Derive the Pinecone namespace from tenant_id.
    This is the ONLY place where namespace is computed.
    """
    return f"user_{tenant_id}"


def upsert_chunks(
    tenant_id: str,
    document_id: str,
    chunks: list[str],
    embeddings: list[list[float]],
) -> int:
    """
    Upsert chunk vectors to the tenant's isolated Pinecone namespace.

    Args:
        tenant_id: User's tenant ID (namespace derived server-side)
        document_id: Document identifier
        chunks: List of text chunks
        embeddings: List of embedding vectors (must match chunks length)

    Returns:
        Count of vectors upserted

    Raises:
        ValueError: If a namespace parameter is somehow injected
    """
    namespace = _derive_namespace(tenant_id)

    vectors = []
    for i, (chunk, embedding) in enumerate(zip(chunks, embeddings)):
        vectors.append({
            "id": f"{document_id}_chunk_{i}",
            "values": embedding,
            "metadata": {
                "text": chunk,
                "document_id": document_id,
            },
        })

    index = _get_index()
    index.upsert(vectors=vectors, namespace=namespace)

    return len(vectors)


def delete_document_chunks(tenant_id: str, document_id: str) -> int:
    """
    Delete all vectors for a specific document within the tenant's namespace.

    Args:
        tenant_id: User's tenant ID (namespace derived server-side)
        document_id: Document whose chunks should be deleted

    Returns:
        Count of vectors deleted
    """
    namespace = _derive_namespace(tenant_id)
    index = _get_index()

    # Fetch vector IDs matching this document
    # Pinecone doesn't support metadata-filtered delete on all plans,
    # so we list and delete by prefix
    results = index.list(prefix=f"{document_id}_chunk_", namespace=namespace)

    vector_ids = list(results)
    if vector_ids:
        index.delete(ids=vector_ids, namespace=namespace)

    return len(vector_ids)


def delete_namespace(tenant_id: str) -> None:
    """
    Delete ALL vectors in a tenant's namespace. Use with caution.

    Args:
        tenant_id: User's tenant ID (namespace derived server-side)
    """
    namespace = _derive_namespace(tenant_id)
    index = _get_index()
    index.delete(delete_all=True, namespace=namespace)


def query_namespace(
    tenant_id: str,
    query_vector: list[float],
    top_k: int = 5,
) -> list[dict]:
    """
    Query vectors in a tenant's isolated Pinecone namespace.

    Args:
        tenant_id: User's tenant ID (namespace derived server-side)
        query_vector: 384-dim query embedding
        top_k: Maximum number of results to return

    Returns:
        List of matches, each as:
        {"id": str, "score": float, "text": str, "document_id": str}
        Matches with score < 0.3 are filtered out.
    """
    namespace = _derive_namespace(tenant_id)
    index = _get_index()

    results = index.query(
        vector=query_vector,
        top_k=top_k,
        namespace=namespace,
        include_metadata=True,
    )

    matches = []
    for match in results.get("matches", []):
        score = match.get("score", 0.0)

        # Filter out low-confidence retrievals
        if score < 0.03:
            continue

        metadata = match.get("metadata", {})
        matches.append({
            "id": match["id"],
            "score": score,
            "text": metadata.get("text", ""),
            "document_id": metadata.get("document_id", ""),
        })

    return matches

