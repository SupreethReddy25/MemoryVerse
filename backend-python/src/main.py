"""
MemoryVerse ML Service — FastAPI application entry point.
"""

import importlib.util
import os
from fastapi import FastAPI
from dotenv import load_dotenv

load_dotenv()

app = FastAPI(title="MemoryVerse ML Service")


def _load_router(filename: str, module_name: str):
    """Load a router module from a dotted filename."""
    path = os.path.join(os.path.dirname(__file__), "routes", filename)
    spec = importlib.util.spec_from_file_location(module_name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.router


# Mount routers
app.include_router(_load_router("ingest.router.py", "ingest_router"))
app.include_router(_load_router("rag.router.py", "rag_router"))


@app.get("/health")
async def health_check():
    """Health check endpoint."""
    return {"status": "ok"}
