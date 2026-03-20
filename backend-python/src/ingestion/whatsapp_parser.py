"""
WhatsApp export parser — strips timestamps, sender prefixes, system messages,
media omissions, and blank lines. Returns a list of clean message strings.

Short messages (under MIN_CHUNK_SIZE tokens) are grouped with consecutive
short messages to preserve conversational context.
"""

import re
import tiktoken

# Token counting for short-message grouping
_encoding = tiktoken.get_encoding("cl100k_base")
MIN_CHUNK_SIZE = 50  # tokens — group messages below this threshold

# Timestamp patterns to strip from the beginning of lines
# Handles:
#   [DD/MM/YY, HH:MM AM/PM]        with narrow no-break space \u202f before AM/PM
#   [DD/MM/YYYY, HH:MM:SS AM/PM]
#   [DD/MM/YY, HH:MM:SS]
#   Without brackets: DD/MM/YYYY, HH:MM -
_TIMESTAMP_RE = re.compile(
    r"^\[?\d{1,2}/\d{1,2}/\d{2,4},\s+\d{1,2}:\d{2}(?::\d{2})?\s*[\u202f\s]*(?:AM|PM|am|pm)?\]?\s*[-\u2013\u2014]?\s*",
    re.UNICODE
)

# Sender prefix: everything up to and including the first ": "
# Handles emoji, ~, Unicode chars in names
_SENDER_PREFIX_RE = re.compile(r"^.+?:\s", re.UNICODE)

# System message patterns — discard entire line if any of these appear
_SYSTEM_PATTERNS = [
    "messages and calls are end-to-end encrypted",
    "message was deleted",
    "this message was deleted",
    "you deleted this message",
    "joined using this group's invite link",
    "joined using a group link",
    "changed the subject",
    "changed this group",
    "created group",
    "document omitted",
    "image omitted",
    "video omitted",
    "audio omitted",
    "sticker omitted",
    "gif omitted",
    "contact card omitted",
    "is a contact",
    "missed voice call",
    "missed video call",
    "you created group",
]

# Short system-like suffixes — only treat as system if line is short
_SYSTEM_WORD_PATTERNS = [
    " added ",
    " removed ",
    " left",
    "joined",
]

# Media omission pattern
_MEDIA_OMITTED_RE = re.compile(r"<media omitted>|<Media omitted>", re.IGNORECASE)

# Invisible Unicode characters to strip from message bodies
_INVISIBLE_CHARS = '\u200e\u200f\u202a\u202b\u202c\u202d\u202e\ufeff\u2060'


def _is_system_message(line: str) -> bool:
    """Check if a line is a system message that should be discarded."""
    lower = line.lower()
    for pattern in _SYSTEM_PATTERNS:
        if pattern in lower:
            return True
    # Only treat as system if the whole line is short (system msgs are brief)
    if len(lower.split()) <= 8:
        for pattern in _SYSTEM_WORD_PATTERNS:
            if pattern in lower:
                return True
    return False


def _clean_message(line: str) -> str:
    """Remove timestamp, sender prefix, and invisible chars from a message line."""
    # Strip timestamp
    cleaned = _TIMESTAMP_RE.sub("", line)
    # Strip sender prefix (everything up to first ": ")
    cleaned = _SENDER_PREFIX_RE.sub("", cleaned, count=1)
    # Strip invisible Unicode characters from start
    cleaned = cleaned.lstrip(_INVISIBLE_CHARS)
    return cleaned.strip()


def _count_tokens(text: str) -> int:
    """Count the number of tokens in a string."""
    return len(_encoding.encode(text))


def _group_short_messages(messages: list[str]) -> list[str]:
    """
    Group consecutive short messages (< MIN_CHUNK_SIZE tokens) together
    until the combined text exceeds MIN_CHUNK_SIZE tokens.
    Messages already at or above MIN_CHUNK_SIZE pass through unchanged.
    """
    result: list[str] = []
    buffer: list[str] = []
    buffer_tokens = 0

    for msg in messages:
        token_count = _count_tokens(msg)

        if token_count >= MIN_CHUNK_SIZE:
            # Flush any buffered short messages first
            if buffer:
                result.append(" ".join(buffer))
                buffer = []
                buffer_tokens = 0
            result.append(msg)
        else:
            buffer.append(msg)
            buffer_tokens += token_count
            if buffer_tokens >= MIN_CHUNK_SIZE:
                result.append(" ".join(buffer))
                buffer = []
                buffer_tokens = 0

    # Flush remaining buffer
    if buffer:
        result.append(" ".join(buffer))

    return result


def parse_whatsapp_export(raw_text: str) -> list[str]:
    """
    Parse a raw WhatsApp .txt export into a list of clean message strings.

    Strips timestamps, sender prefixes, system messages, media omissions,
    invisible Unicode characters, and blank lines. Handles \r\n line endings,
    narrow no-break spaces in timestamps, and emoji in sender names.

    Args:
        raw_text: Raw string content of a WhatsApp .txt export

    Returns:
        List of clean message strings, order preserved, no empty strings
    """
    if not raw_text or not raw_text.strip():
        return []

    # Strip BOM and normalize line endings
    raw_text = raw_text.lstrip('\ufeff')
    raw_text = raw_text.replace('\r\n', '\n').replace('\r', '\n')

    lines = raw_text.split("\n")
    messages: list[str] = []
    current_message: str | None = None

    for line in lines:
        stripped = line.strip()

        # Skip blank lines
        if not stripped:
            continue

        # Skip media omissions
        if _MEDIA_OMITTED_RE.search(stripped):
            if current_message is not None:
                messages.append(current_message)
                current_message = None
            continue

        # Check if this is a new timestamped line
        if _TIMESTAMP_RE.match(stripped):
            # Finalize previous message
            if current_message is not None:
                messages.append(current_message)
                current_message = None

            # Clean the line
            cleaned = _clean_message(stripped)

            # Skip system messages
            if _is_system_message(cleaned):
                continue

            # Skip empty after cleaning
            if not cleaned:
                continue

            current_message = cleaned
        else:
            # Continuation line
            if current_message is not None:
                current_message += " " + stripped.lstrip(_INVISIBLE_CHARS)
            else:
                if stripped and not _is_system_message(stripped):
                    current_message = stripped.lstrip(_INVISIBLE_CHARS)

    # Don't forget the last message
    if current_message is not None:
        messages.append(current_message)

    # Final filter: remove messages under 3 characters
    messages = [msg for msg in messages if len(msg) >= 3]

    # Group consecutive short messages together
    return _group_short_messages(messages)