#!/usr/bin/env python3
"""Convert a Gemini/Antigravity conversation database (.db) to Markdown.

The .db file is a protobuf binary store. The system also keeps a decoded,
human-readable transcript next to it. This script prefers that transcript
(<conv_id>/.system_generated/logs/transcript.jsonl) and converts it to a
readable Markdown chat log. If no transcript exists, it falls back to a
best-effort extraction of printable text from the .db blobs.

Usage:
    db2md.py <conversation.db> [output.md]
    db2md.py --jsonl transcript.jsonl <conversation.db> [output.md]

If output.md is omitted, it is derived from the conversation id
(e.g. <id>.md, or DIAG8.md if the input is named like *-<id>.db).
"""
import sys
import os
import re
import json
import sqlite3
import argparse


def conv_id_from_db(db_path):
    """Best-effort conversation id: from filename uuid or trajectory_meta."""
    m = re.search(r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})",
                  os.path.basename(db_path), re.I)
    if m:
        return m.group(1).lower()
    try:
        con = sqlite3.connect(db_path)
        cur = con.cursor()
        cur.execute("SELECT trajectory_id FROM trajectory_meta LIMIT 1")
        row = cur.fetchone()
        con.close()
        if row and row[0]:
            return row[0]
    except Exception:
        pass
    return None


def find_transcript(db_path, explicit=None):
    if explicit:
        if os.path.exists(explicit):
            return explicit
        raise FileNotFoundError(explicit)
    cid = conv_id_from_db(db_path)
    if not cid:
        return None
    home = os.path.expanduser("~")
    candidates = [
        os.path.join(home, "Library", "Application Support", "Google", "Antigravity",
                     "brain", cid, ".system_generated", "logs", "transcript.jsonl"),
        os.path.join(home, ".gemini", "antigravity", "brain", cid,
                     ".system_generated", "logs", "transcript.jsonl"),
        os.path.join(home, ".gemini", "antigravity", "brain", cid,
                     ".system_generated", "logs", "transcript_full.jsonl"),
    ]
    for c in candidates:
        if os.path.exists(c):
            return c
    return None


def clean_wrapper(text):
    """Drop a leading <TAG> control line if present."""
    if not text:
        return text
    lines = text.split("\n")
    if lines and re.match(r"^<\s*[A-Z_]+>\s*$", lines[0].strip()):
        lines = lines[1:]
        # also drop a following "## User"/"## System" header duplication is fine to keep
        return "\n".join(lines).lstrip("\n")
    return text


def render_tool_calls(tool_calls):
    if not tool_calls:
        return ""
    out = ["", "**Tool calls:**", ""]
    for i, tc in enumerate(tool_calls, 1):
        name = tc.get("name", "?") if isinstance(tc, dict) else str(tc)
        args = tc.get("args", {}) if isinstance(tc, dict) else {}
        out.append(f"{i}. `{name}`")
        if args:
            try:
                args_str = json.dumps(args, ensure_ascii=False, indent=2)
            except Exception:
                args_str = str(args)
            out.append("")
            out.append("```json")
            out.append(args_str)
            out.append("```")
    return "\n".join(out)


def render_content_block(content, heading, collapse=False, lang=""):
    if content is None:
        return ""
    content = str(content)
    if not content.strip():
        return ""
    if collapse and len(content) > 2000:
        return (f"<details>\n<summary>{heading}</summary>\n\n"
                f"```{lang}\n{content}\n```\n\n</details>")
    return f"```{lang}\n{content}\n```"


def convert_jsonl(jsonl_path):
    records = []
    with open(jsonl_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                records.append(json.loads(line))
            except Exception:
                continue
    return records


def records_from_db(db_path):
    """Best-effort raw extraction of printable runs from .db blobs."""
    con = sqlite3.connect(db_path)
    cur = con.cursor()
    rows = []
    for col in ("step_payload", "metadata", "render_info", "task_details"):
        try:
            cur.execute(f"SELECT idx, {col} FROM steps WHERE {col} IS NOT NULL")
            for idx, blob in cur.fetchall():
                if blob is None:
                    continue
                text = blob.decode("utf-8", "ignore")
                runs = re.findall(r"[\x20-\x7e\t\n]{20,}", text)
                if runs:
                    rows.append((idx, "\n".join(runs)))
        except Exception:
            continue
    con.close()
    rows.sort(key=lambda x: x[0])
    return [{"step_index": i, "type": "RAW", "content": c} for i, c in rows]


def to_markdown(records, source_label):
    md = []
    md.append(f"# Conversation transcript\n")
    md.append(f"_Source: {source_label}_")
    md.append("")
    md.append(f"Total entries: {len(records)}")
    md.append("")

    counts = {}
    for r in records:
        counts[r.get("type", "?")] = counts.get(r.get("type", "?"), 0) + 1
    if counts:
        md.append("Types: " + ", ".join(f"{k}={v}" for k, v in counts.items()))
        md.append("")

    for r in records:
        rtype = r.get("type", "GENERIC")
        idx = r.get("step_index", "")
        ts = r.get("created_at", "")
        ts_str = f" — `{ts}`" if ts else ""

        if rtype == "USER_INPUT":
            md.append(f"## 👤 User (step {idx}){ts_str}\n")
            md.append(clean_wrapper(r.get("content", "") or ""))
            md.append("")

        elif rtype == "PLANNER_RESPONSE":
            md.append(f"## 🤖 Assistant (step {idx}){ts_str}\n")
            thinking = r.get("thinking")
            if thinking:
                md.append("<details>")
                md.append("<summary>🧠 Reasoning</summary>")
                md.append("")
                md.append(str(thinking))
                md.append("")
                md.append("</details>")
                md.append("")
            tc = r.get("tool_calls")
            if tc:
                md.append(render_tool_calls(tc))
                md.append("")

        elif rtype == "GENERIC":
            content = r.get("content", "") or ""
            md.append(f"### 🔧 Tool output (step {idx}){ts_str}\n")
            md.append(render_content_block(content, "Tool output", collapse=True))
            md.append("")

        elif rtype == "SYSTEM_MESSAGE":
            md.append(f"### ⚙️ System (step {idx}){ts_str}\n")
            md.append("> " + clean_wrapper(r.get("content", "") or "").replace("\n", "\n> "))
            md.append("")

        elif rtype == "ERROR_MESSAGE":
            md.append(f"### ⚠️ Error (step {idx}){ts_str}\n")
            md.append("> " + (r.get("content", "") or "").replace("\n", "\n> "))
            md.append("")

        elif rtype == "CHECKPOINT":
            md.append(f"### 📌 Checkpoint (step {idx}){ts_str}\n")
            c = r.get("content", "")
            if c:
                md.append(render_content_block(c, "Checkpoint", collapse=True))
            md.append("")

        elif rtype == "RAW":
            md.append(f"### Raw blob (step {idx})\n")
            md.append(render_content_block(r.get("content", ""), "Raw", collapse=True))
            md.append("")

        else:
            md.append(f"## {rtype} (step {idx}){ts_str}\n")
            c = r.get("content")
            if c:
                md.append(render_content_block(c, rtype, collapse=True))
            md.append("")

    return "\n".join(md) + "\n"


def main():
    ap = argparse.ArgumentParser(description="Convert a Gemini/Antigravity .db chat to Markdown.")
    ap.add_argument("db", help="Path to the conversation .db file")
    ap.add_argument("output", nargs="?", help="Output .md path (optional)")
    ap.add_argument("--jsonl", help="Explicit path to transcript.jsonl")
    args = ap.parse_args()

    db_path = args.db
    if not os.path.exists(db_path):
        print(f"error: {db_path} not found", file=sys.stderr)
        sys.exit(1)

    cid = conv_id_from_db(db_path)
    jsonl = find_transcript(db_path, args.jsonl)

    if jsonl:
        records = convert_jsonl(jsonl)
        source = jsonl
    else:
        print("warning: no transcript.jsonl found, falling back to raw .db extraction",
              file=sys.stderr)
        records = records_from_db(db_path)
        source = db_path

    if not records:
        print("warning: no records extracted", file=sys.stderr)

    md = to_markdown(records, source)

    out_path = args.output
    if not out_path:
        if cid:
            out_path = os.path.join(os.path.dirname(os.path.abspath(db_path)),
                                    f"{cid}.md")
        else:
            out_path = os.path.splitext(db_path)[0] + ".md"
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(md)
    print(f"wrote {len(records)} entries -> {out_path}")


if __name__ == "__main__":
    main()
