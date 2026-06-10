#!/usr/bin/env python3
"""Lint a blocker report against the structural contract in assets/blocker-report-template.md.

Usage:
    python validate-blocker.py <path-to-report.md>

Exit codes:
    0 — report passes all structural checks
    1 — report fails one or more checks (details printed to stdout)
    2 — invocation error (bad args, file not found)

The script checks mechanical structure only. Judgment — is the decision really
the smallest one? is the evidence actually localized to the failing surface? —
stays with the conductor reviewer.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

KNOWN_CATEGORIES = {
    "implementation-failure",
    "artifact-ambiguity",
    "oracle-contradiction",
    "policy-conflict",
}

VAGUE_DECISION_PHRASES = [
    r"\bhelp me\b",
    r"\bfigure\s+(this|it|out|things)\b",
    r"\bplease\s+advise\b",
    r"\bnot\s+sure\b",
    r"\bstuck\b",
    r"\bwhat\s+should\s+i\s+do\b",
    r"\bguidance\s+needed\b",
]

REQUIRED_SECTIONS = [
    "Category",
    "Failing surface",
    "Observed behavior",
    "What was tried",
    "Smallest decision required",
    "Protected surfaces check",
]

OBSERVED_BEHAVIOR_MIN_CHARS = 50


def parse_sections(text: str) -> dict[str, str]:
    """Split a markdown document into sections keyed by H2 heading."""
    sections: dict[str, str] = {}
    current_heading: str | None = None
    current_content: list[str] = []
    for line in text.splitlines():
        m = re.match(r"^##\s+(.+?)\s*$", line)
        if m:
            if current_heading is not None:
                sections[current_heading] = "\n".join(current_content).strip()
            current_heading = m.group(1).strip()
            current_content = []
        elif current_heading is not None:
            current_content.append(line)
    if current_heading is not None:
        sections[current_heading] = "\n".join(current_content).strip()
    return sections


def strip_html_comments(text: str) -> str:
    """Remove <!-- ... --> blocks so instructional comments don't count as content."""
    return re.sub(r"<!--.*?-->", "", text, flags=re.DOTALL).strip()


def check_category(content: str) -> list[str]:
    content = strip_html_comments(content)
    if not content:
        return ["section is empty after stripping comments"]
    # Category should be a single bare token on its own.
    tokens = [line.strip().strip("`*_ ").lower() for line in content.splitlines() if line.strip()]
    tokens = [t for t in tokens if t and not t.startswith("#")]
    if not tokens:
        return ["no category token found"]
    chosen = tokens[0]
    if chosen not in KNOWN_CATEGORIES:
        return [
            f"category '{chosen}' is not in the known enum: {sorted(KNOWN_CATEGORIES)}. "
            "If this is a genuine misfit, pick the closest and add a '## Category fit note' section."
        ]
    return []


def check_failing_surface(content: str) -> list[str]:
    content = strip_html_comments(content)
    if not content or content.startswith("<") and content.endswith(">"):
        return ["section is empty or still contains an unfilled placeholder"]
    # Look for something that resembles a concrete locator:
    #   file paths (foo/bar.ext or foo/bar:line)
    #   endpoints (METHOD /path)
    #   artifact paths (artifacts/foo::something)
    locators = [
        r"[\w./-]+\.\w+(:\d+)?",                       # file path with extension
        r"\b(GET|POST|PUT|PATCH|DELETE|WEBSOCKET|SSE)\s+/\S+",  # HTTP endpoint
        r"artifacts/\S+",                              # artifact path
        r"oracle/\S+",                                 # oracle path
        r"\benv\s+var\s+\w+",                          # env var
        r"\bport\s+\d+",                               # port number
    ]
    if not any(re.search(pat, content, re.IGNORECASE) for pat in locators):
        return [
            "no concrete locator found. Expected a file:line, endpoint, artifact path, "
            "oracle path, env var name, or port number."
        ]
    return []


def check_observed_behavior(content: str) -> list[str]:
    content = strip_html_comments(content)
    # Strip code fences and whitespace so an empty ``` ``` block doesn't pass.
    stripped = re.sub(r"```.*?```", "", content, flags=re.DOTALL).strip()
    stripped_in_fence = re.findall(r"```(.*?)```", content, flags=re.DOTALL)
    fence_content = "\n".join(stripped_in_fence).strip()
    total_content = (stripped + "\n" + fence_content).strip()
    if len(total_content) < OBSERVED_BEHAVIOR_MIN_CHARS:
        return [
            f"section contains fewer than {OBSERVED_BEHAVIOR_MIN_CHARS} characters of content. "
            "Paste the raw stderr, test output, or conflicting artifact excerpts — not a paraphrase."
        ]
    return []


def check_what_was_tried(content: str) -> list[str]:
    content = strip_html_comments(content)
    attempt_lines = [
        line for line in content.splitlines()
        if re.match(r"^\s*-\s*Attempt\s+\d+\s*:", line, re.IGNORECASE)
    ]
    # Require at least one attempt entry, and the entry must have content after the colon.
    if not attempt_lines:
        return ["no '- Attempt N: ...' entries found. Blockers are for escalating AFTER effort."]
    unfilled = [
        line for line in attempt_lines
        if re.search(r":\s*<", line) or re.match(r"^\s*-\s*Attempt\s+\d+\s*:\s*$", line)
    ]
    if unfilled:
        return [
            f"{len(unfilled)} of {len(attempt_lines)} attempt entries still contain unfilled "
            "placeholders. Fill them or delete them."
        ]
    return []


def check_smallest_decision(content: str) -> list[str]:
    content = strip_html_comments(content)
    if not content or (content.startswith("<") and content.endswith(">")):
        return ["section is empty or still contains an unfilled placeholder"]
    errors: list[str] = []
    lowered = content.lower()
    for pattern in VAGUE_DECISION_PHRASES:
        if re.search(pattern, lowered):
            errors.append(
                f"vague phrasing detected (matched /{pattern}/). Name the specific bounded "
                "decision the conductor must make."
            )
    # Must end with a question mark or contain "Authorize" / "Pick" / "Revise" / "Accept" etc.
    if "?" not in content and not re.search(
        r"\b(authorize|pick|revise|accept|extend|abort|grant|split)\b", lowered
    ):
        errors.append(
            "decision doesn't read as a bounded question. Phrase it as a question "
            "('... or ...?') or as a specific action verb (authorize / pick / revise / etc.)."
        )
    return errors


def check_protected_surfaces(content: str) -> list[str]:
    content = strip_html_comments(content)
    checkbox_matches = re.findall(r"-\s*\[([ xX])\]", content)
    if len(checkbox_matches) < 3:
        return [f"expected 3 attestation checkboxes, found {len(checkbox_matches)}"]
    unchecked_positions = [i + 1 for i, c in enumerate(checkbox_matches) if c == " "]
    if unchecked_positions:
        return [
            f"checkboxes {unchecked_positions} are unchecked. Verify each protected-surface "
            "attestation before filing; if any can't be checked, this blocker is also a "
            "protected-surface violation and should be filed separately."
        ]
    return []


CHECKERS = {
    "Category": check_category,
    "Failing surface": check_failing_surface,
    "Observed behavior": check_observed_behavior,
    "What was tried": check_what_was_tried,
    "Smallest decision required": check_smallest_decision,
    "Protected surfaces check": check_protected_surfaces,
}


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: validate-blocker.py <path-to-blocker-report.md>", file=sys.stderr)
        return 2
    path = Path(argv[1])
    if not path.exists():
        print(f"file not found: {path}", file=sys.stderr)
        return 2

    text = path.read_text(encoding="utf-8")
    sections = parse_sections(text)

    errors: list[str] = []
    for section_name in REQUIRED_SECTIONS:
        if section_name not in sections:
            errors.append(f"missing required section: ## {section_name}")
            continue
        checker = CHECKERS.get(section_name)
        if checker is None:
            continue
        for err in checker(sections[section_name]):
            errors.append(f"[{section_name}] {err}")

    if errors:
        print(f"FAIL: {path}")
        for err in errors:
            print(f"  - {err}")
        return 1

    print(f"OK: {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
