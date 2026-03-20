"""
Unit tests for the WhatsApp export parser — 15 test cases.
"""

import pytest
from src.ingestion.whatsapp_parser import parse_whatsapp_export


# ── Test 1: Standard timestamp format [DD/MM/YY, HH:MM] ────────────
def test_standard_timestamp_format():
    raw = "[12/03/23, 14:30] Alice: Hello, how are you?"
    result = parse_whatsapp_export(raw)
    assert len(result) == 1
    assert result[0] == "Hello, how are you?"


# ── Test 2: US timestamp format [M/D/YY, HH:MM AM/PM] ──────────────
def test_us_timestamp_format():
    raw = "[3/5/23, 2:30 PM] Bob: Meeting at 3pm today"
    result = parse_whatsapp_export(raw)
    assert len(result) == 1
    assert result[0] == "Meeting at 3pm today"


# ── Test 3: Full timestamp [MM/DD/YYYY, HH:MM:SS AM/PM] ────────────
def test_full_timestamp_format():
    raw = "[03/05/2023, 02:30:45 PM] Charlie: Let me check my schedule"
    result = parse_whatsapp_export(raw)
    assert len(result) == 1
    assert result[0] == "Let me check my schedule"


# ── Test 4: Multi-line message joined correctly ─────────────────────
def test_multiline_message_joined():
    raw = """[12/03/23, 14:30] Alice: This is the first line
and this is the second line
and this is the third line"""
    result = parse_whatsapp_export(raw)
    assert len(result) == 1
    assert "first line" in result[0]
    assert "second line" in result[0]
    assert "third line" in result[0]


# ── Test 5: Media omission line removed ─────────────────────────────
def test_media_omission_removed():
    raw = """[12/03/23, 14:30] Alice: Hello
[12/03/23, 14:31] Bob: <Media omitted>
[12/03/23, 14:32] Alice: How are you?"""
    result = parse_whatsapp_export(raw)
    combined = " ".join(result)
    assert "Hello" in combined
    assert "How are you?" in combined
    # Media omission must not appear
    assert "Media omitted" not in combined


# ── Test 6: System message "end-to-end encrypted" removed ──────────
def test_system_message_encrypted_removed():
    raw = """[12/03/23, 14:30] Messages and calls are end-to-end encrypted. No one outside of this chat can read them.
[12/03/23, 14:31] Alice: Hi there!"""
    result = parse_whatsapp_export(raw)
    assert len(result) == 1
    assert result[0] == "Hi there!"


# ── Test 7: System message "left" event removed ────────────────────
def test_system_message_left_removed():
    raw = """[12/03/23, 14:30] Alice: Hello everyone
[12/03/23, 14:31] Bob left
[12/03/23, 14:32] Charlie: Bye Bob!"""
    result = parse_whatsapp_export(raw)
    combined = " ".join(result)
    assert "Hello everyone" in combined
    assert "Bye Bob!" in combined
    # System messages must not appear
    assert "Bob left" not in combined


# ── Test 8: Message with emoji preserved correctly ──────────────────
def test_emoji_preserved():
    raw = "[12/03/23, 14:30] Alice: Great job! 🎉🔥 Keep it up 💪"
    result = parse_whatsapp_export(raw)
    assert len(result) == 1
    assert "🎉" in result[0]
    assert "🔥" in result[0]
    assert "💪" in result[0]


# ── Test 9: Empty input returns empty list ──────────────────────────
def test_empty_input():
    assert parse_whatsapp_export("") == []
    assert parse_whatsapp_export("   ") == []
    assert parse_whatsapp_export("\n\n\n") == []


# ── Test 10: Input with only system messages returns empty list ─────
def test_only_system_messages():
    raw = """[12/03/23, 14:30] Messages and calls are end-to-end encrypted.
[12/03/23, 14:31] Bob joined using this group's invite link
[12/03/23, 14:32] Alice added Charlie
[12/03/23, 14:33] Dave left"""
    result = parse_whatsapp_export(raw)
    assert result == []


# ── Test 11: Message with URLs preserved ────────────────────────────
def test_urls_preserved():
    raw = "[12/03/23, 14:30] Alice: Check this out https://example.com/path?q=test#anchor"
    result = parse_whatsapp_export(raw)
    assert len(result) == 1
    assert "https://example.com/path?q=test#anchor" in result[0]


# ── Test 12: Group chat — all sender prefixes stripped ──────────────
def test_group_chat_sender_prefixes_stripped():
    raw = """[12/03/23, 14:30] Alice: Hello group!
[12/03/23, 14:31] Bob: Hi Alice!
[12/03/23, 14:32] Charlie: Hey everyone!"""
    result = parse_whatsapp_export(raw)
    combined = " ".join(result)
    assert "Hello group!" in combined
    assert "Hi Alice!" in combined
    assert "Hey everyone!" in combined
    # Verify no sender names remain
    assert "Alice:" not in combined
    assert "Bob:" not in combined
    assert "Charlie:" not in combined


# ── Test 13: Message containing colon in text (not sender prefix) ───
def test_colon_in_message_text():
    raw = "[12/03/23, 14:30] Alice: Time is: 3:00 PM today"
    result = parse_whatsapp_export(raw)
    assert len(result) == 1
    assert "3:00 PM" in result[0]


# ── Test 14: Unicode characters (Arabic, Hindi, Chinese) preserved ──
def test_unicode_characters_preserved():
    raw = """[12/03/23, 14:30] User1: مرحبا بالعالم
[12/03/23, 14:31] User2: नमस्ते दुनिया
[12/03/23, 14:32] User3: 你好世界"""
    result = parse_whatsapp_export(raw)
    combined = " ".join(result)
    assert "مرحبا" in combined
    assert "नमस्ते" in combined
    assert "你好世界" in combined


# ── Test 15: Message at exact 3-character boundary ──────────────────
def test_three_character_boundary():
    raw = """[12/03/23, 14:30] Alice: Yes
[12/03/23, 14:31] Bob: No
[12/03/23, 14:32] Charlie: OK!"""
    result = parse_whatsapp_export(raw)
    combined = " ".join(result)
    # "Yes" = 3 chars → included (in grouped output)
    # "No" = 2 chars → excluded (below 3-char filter)
    # "OK!" = 3 chars → included (in grouped output)
    assert "Yes" in combined
    assert "OK!" in combined
    # "No" is filtered out before grouping (< 3 chars)
    # Verify it's not in any result chunk
    for chunk in result:
        assert chunk.strip() != "No"


# ── Test 16: Multiple short messages grouped into single chunk ───────
def test_short_messages_grouped():
    """Short messages (< 50 tokens each) should be grouped together."""
    raw = "\n".join([
        "[12/03/23, 14:30] Alice: Hey",
        "[12/03/23, 14:31] Bob: Hi",
        "[12/03/23, 14:32] Alice: What's up?",
        "[12/03/23, 14:33] Bob: Nothing much",
        "[12/03/23, 14:34] Alice: Ok cool",
        "[12/03/23, 14:35] Bob: Yeah",
        "[12/03/23, 14:36] Alice: See you later",
        "[12/03/23, 14:37] Bob: Bye!",
        "[12/03/23, 14:38] Alice: Take care",
        "[12/03/23, 14:39] Bob: You too",
    ])
    result = parse_whatsapp_export(raw)
    # All 10 messages are very short — they should be grouped into
    # fewer chunks than 10. The exact count depends on token lengths,
    # but must be fewer than original count.
    assert len(result) < 10
    # All original content should be preserved
    combined = " ".join(result)
    assert "Hey" in combined
    assert "Bye!" in combined
    assert "Take care" in combined


# ── Test 17: Bracket-less timestamp format ────────────────────────────
def test_bracketless_timestamp_format():
    """Timestamps without brackets (DD/MM/YYYY, HH:MM -) should be parsed."""
    raw = """12/03/2023, 14:30 - Alice: The meeting is at 3pm tomorrow
12/03/2023, 14:31 - Bob: Got it, thanks for letting me know"""
    result = parse_whatsapp_export(raw)
    assert len(result) >= 1
    combined = " ".join(result)
    assert "meeting is at 3pm tomorrow" in combined
    assert "Got it" in combined
    # Verify timestamps and sender prefixes are stripped
    assert "12/03/2023" not in combined
    assert "Alice:" not in combined
    assert "Bob:" not in combined


# ── Test 18: Real-world WhatsApp export sample ────────────────────────
def test_real_world_export_sample():
    """A realistic WhatsApp export with mixed lengths and system messages."""
    raw = """[01/03/23, 09:00] Messages and calls are end-to-end encrypted. No one outside of this chat, not even WhatsApp, can read or listen to them.
[01/03/23, 09:01] Alice: Good morning everyone! I wanted to share the study plan for our Operating Systems exam. We need to cover process scheduling algorithms including FCFS, SJF, Round Robin, and Priority Scheduling. Also make sure to review memory management concepts like paging and segmentation.
[01/03/23, 09:02] Bob: Thanks Alice!
[01/03/23, 09:03] Charlie: <Media omitted>
[01/03/23, 09:04] Dave: Can someone share the notes from last lecture? I missed the class on deadlocks and the Banker's algorithm. I also need the practice questions that Professor Smith gave out.
[01/03/23, 09:05] Eve: Sure, I'll send them tonight"""
    result = parse_whatsapp_export(raw)
    combined = " ".join(result)
    # System message removed
    assert "end-to-end encrypted" not in combined
    # Media omission removed
    assert "Media omitted" not in combined
    # Content preserved
    assert "study plan" in combined
    assert "Operating Systems" in combined
    assert "deadlocks" in combined
    assert "Banker's algorithm" in combined
    # Short messages ("Thanks Alice!", "Sure, I'll send them tonight")
    # should be grouped — verify all content is present
    assert "Thanks Alice" in combined
    assert "send them tonight" in combined
