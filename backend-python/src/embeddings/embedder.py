"""
Embedder — singleton sentence-transformers model for generating
384-dimensional embeddings using all-MiniLM-L6-v2.
"""

from sentence_transformers import SentenceTransformer
import numpy as np

# Load model ONCE at module level (singleton pattern)
_model = SentenceTransformer("all-MiniLM-L6-v2")


def embed_text(text: str) -> list[float]:
    """
    Generate a single 384-dimensional embedding.

    Args:
        text: Input text to embed

    Returns:
        384-dim embedding as a plain Python list of floats
    """
    embedding = _model.encode(text)
    return embedding.tolist()


def embed_batch(texts: list[str]) -> list[list[float]]:
    """
    Generate embeddings for a batch of texts.

    Args:
        texts: List of input texts to embed

    Returns:
        List of 384-dim embeddings as plain Python lists of floats
    """
    embeddings = _model.encode(texts, batch_size=32)
    return [emb.tolist() for emb in embeddings]
