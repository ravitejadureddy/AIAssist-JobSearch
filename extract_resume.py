#!/usr/bin/env python3
"""Extract work experience sections from a PDF resume by company."""

import sys
import re
import textwrap

# ── PDF text extraction ──────────────────────────────────────────────────────

def extract_text(pdf_path):
    try:
        import pdfplumber
        with pdfplumber.open(pdf_path) as pdf:
            return "\n".join(page.extract_text() or "" for page in pdf.pages)
    except ImportError:
        pass
    try:
        from pypdf import PdfReader
        return "\n".join(
            page.extract_text() or "" for page in PdfReader(pdf_path).pages
        )
    except ImportError:
        pass
    sys.exit("Install pdfplumber or pypdf:  pip install pdfplumber")


# ── Text preprocessing ───────────────────────────────────────────────────────

def rejoin_wrapped_lines(text):
    """
    PDF renderers hard-wrap long lines at the page width. Re-join fragments
    that belong to the same sentence so each bullet reads as one complete line.

    A line is treated as a continuation of the previous when it starts with a
    lowercase letter (the sentence was cut mid-word/mid-phrase by the renderer).
    Empty lines are kept as paragraph separators.
    """
    lines = text.splitlines()
    out = []
    for line in lines:
        stripped = line.rstrip()
        if not out:
            out.append(stripped)
            continue
        if not stripped.strip():
            out.append(stripped)
            continue
        # Lowercase start → continuation of previous line
        if stripped.strip()[0].islower():
            if out[-1].strip():
                out[-1] = out[-1].rstrip() + " " + stripped.strip()
            else:
                out.append(stripped)
        else:
            out.append(stripped)
    return "\n".join(out)


# ── Patterns ─────────────────────────────────────────────────────────────────

DATE_RE = re.compile(
    r"(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{4}"
    r"\s*[-–—]+\s*"
    r"((Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s*\d{0,4}|Present|Current|Now)"
    r"|\d{4}\s*[-–—]+\s*(\d{4}|Present|Current|Now)",
    re.IGNORECASE,
)

EXP_SECTION_RE = re.compile(
    r"^(professional\s+experience|experience|work\s+(history|experience)|employment(\s+history)?)$",
    re.IGNORECASE,
)

STOP_SECTION_RE = re.compile(
    r"^(education|skills|technical\s+skills|core\s+competencies|summary|professional\s+summary|"
    r"certifications?|projects?|publications?|awards?|volunteer|languages?|additional)$",
    re.IGNORECASE,
)

BULLET_CHAR_RE = re.compile(r"^[•·\-\*]\s+(.+)$")


# ── Parser ───────────────────────────────────────────────────────────────────

def parse_experiences(text):
    text = rejoin_wrapped_lines(text)
    lines = [ln.rstrip() for ln in text.splitlines()]

    in_exp = False
    experiences = []
    current = None

    def close_current():
        if current and (current["role"] or current["bullets"]):
            experiences.append(current)

    i = 0
    while i < len(lines):
        line = lines[i].strip()

        if EXP_SECTION_RE.match(line):
            in_exp = True
            i += 1
            continue

        if STOP_SECTION_RE.match(line):
            if in_exp:
                close_current()
                current = None
                in_exp = False
            i += 1
            continue

        if not in_exp or not line:
            i += 1
            continue

        # ── Company line: contains a date range ──
        date_match = DATE_RE.search(line)
        if date_match:
            company_part = line[:date_match.start()].strip(" -–—|·•")
            period = date_match.group(0).strip()

            # Next non-empty line is the role title if it's short and has no date
            role = ""
            j = i + 1
            while j < len(lines) and not lines[j].strip():
                j += 1
            if j < len(lines):
                peek = lines[j].strip()
                if peek and not DATE_RE.search(peek) and len(peek.split()) <= 8:
                    role = peek
                    i = j

            close_current()
            current = {
                "company": company_part or "Unknown Company",
                "role": role,
                "period": period,
                "bullets": [],
            }
            i += 1
            continue

        # ── Bullet with explicit character (•, -, *) ──
        bm = BULLET_CHAR_RE.match(line)
        if bm:
            if current is not None:
                current["bullets"].append(bm.group(1))
            i += 1
            continue

        # ── Plain paragraph bullet (no character prefix) ──
        # Accept lines that start with a capital and are long enough to be real content
        if current is not None and len(line) > 40 and line[0].isupper():
            current["bullets"].append(line)
            i += 1
            continue

        i += 1

    close_current()
    return experiences


# ── Output ───────────────────────────────────────────────────────────────────

def print_experiences(experiences):
    if not experiences:
        print("No experience sections found.")
        return

    for exp in experiences:
        print(exp["company"])
        for b in exp["bullets"]:
            print(f"- {b}")
        print()


# ── Entry point ───────────────────────────────────────────────────────────────

def main():
    # When running in PyCharm, sys.argv has no extra args — use the hardcoded path below.
    # When running from terminal: python extract_resume.py <path/to/resume.pdf>
    DEFAULT_PDF = '/Users/ravidureddy/Desktop/career-ops/output/196-linkedin/resume.pdf'

    pdf_path = sys.argv[1] if len(sys.argv) >= 2 else DEFAULT_PDF
    if not pdf_path:
        print("Usage: python extract_resume.py <resume.pdf>")
        sys.exit(1)

    output_path = "/Users/ravidureddy/Desktop/career-ops/Resume_Exp_Points/Exp.txt"

    print(f"\nReading: {pdf_path}")

    text = extract_text(pdf_path)
    if not text.strip():
        sys.exit("Could not extract any text from the PDF.")

    experiences = parse_experiences(text)

    import io, os
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    buf = io.StringIO()
    sys.stdout = buf
    print_experiences(experiences)
    sys.stdout = sys.__stdout__
    output = buf.getvalue()

    with open(output_path, "w", encoding="utf-8") as f:
        f.write(output)

    print(output)
    print(f"Output saved to: {output_path}")


if __name__ == "__main__":
    main()
