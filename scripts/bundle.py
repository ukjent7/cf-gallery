#!/usr/bin/env python3
"""Assemble the self-contained gallery document.

Reads src/gallery/{index.src.html,style.css,app.js} plus src/urls.js and
build/data.json, and writes public/index.html: one file with no external
requests, so it still works when double-clicked from disk.

Why inline instead of shipping separate files: fetch() of a sibling .json is
blocked under file://, and the whole point of this artifact is that it can be
emailed or opened locally without a server.

Usage: python scripts/bundle.py [--out PATH] [--check]
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
GALLERY = os.path.join(REPO, "src", "gallery")
DATA_JSON = os.path.join(REPO, "build", "data.json")
DEFAULT_OUT = os.path.join(REPO, "public", "index.html")

PAYLOAD_ORDER = ["DATA", "CACHE", "STORE", "FULLCG", "BRANDG"]


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def urls_source():
    """src/urls.js verbatim, minus its ESM export block.

    The gallery has no module loader; the file's declarations become part of the
    single script. Comments are kept because they document the rules at the
    point of use.
    """
    src = read(os.path.join(REPO, "src", "urls.js"))
    start = src.index("// BEGIN-EXPORTS")
    end = src.index("// END-EXPORTS") + len("// END-EXPORTS")
    stripped = src[:start] + src[end:]
    # Drop the leading module doc comment's import-era wording, and any
    # leftover blank lines at the join.
    return stripped.replace("\n\n\n", "\n\n").rstrip() + "\n"


def payload_source(data):
    lines = []
    for name in PAYLOAD_ORDER:
        if name not in data:
            sys.exit(f"error: build/data.json missing {name}")
        blob = json.dumps(data[name], ensure_ascii=False, separators=(",", ":"))
        # "</script>" inside a JSON string would close the tag early. The data
        # is machine-generated titles, but this is cheap insurance.
        blob = blob.replace("</", "<\\/")
        lines.append(f"const {name} = {blob};")
    return "\n".join(lines) + "\n"


def build(out_path=None, check_only=False):
    out_path = out_path or DEFAULT_OUT
    data_path = DATA_JSON
    if not os.path.isfile(data_path):
        sys.exit("error: build/data.json not found; run scripts/prep_data.py first")
    data = json.loads(read(data_path))

    shell = read(os.path.join(GALLERY, "index.src.html"))
    css = read(os.path.join(GALLERY, "style.css"))
    app = read(os.path.join(GALLERY, "app.js"))

    for token in ("/*__STYLE__*/", "/*__PAYLOAD__*/", "/*__URLS__*/", "/*__APP__*/"):
        if token not in shell:
            sys.exit(f"error: {token} missing from index.src.html")

    doc = (shell
           .replace("/*__STYLE__*/", css.rstrip("\n"))
           .replace("/*__PAYLOAD__*/", payload_source(data).rstrip("\n"))
           .replace("/*__URLS__*/", urls_source().rstrip("\n"))
           .replace("/*__APP__*/", app.rstrip("\n")))

    # Guard: the inlined JS must not contain a literal closing script tag.
    script_body = doc[doc.index("<script>") + len("<script>"):doc.rindex("</script>")]
    if re.search(r"</script", script_body, re.I):
        sys.exit("error: inlined payload contains a literal </script")

    raw = doc.encode("utf-8")
    if check_only:
        print(f"check ok: {len(raw):,} B would be written to {out_path}")
        return doc

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8", newline="\n") as f:
        f.write(doc)

    import gzip
    gz = len(gzip.compress(raw, 9))
    print(f"wrote {out_path}")
    print(f"  {len(raw):,} B raw, {gz:,} B gzip")
    print(f"  markup+code {len(raw) - sum(len(json.dumps(data[n], ensure_ascii=False, separators=(',', ':')).encode()) for n in PAYLOAD_ORDER):,} B, "
          f"payload {sum(len(json.dumps(data[n], ensure_ascii=False, separators=(',', ':')).encode()) for n in PAYLOAD_ORDER):,} B")
    return doc


if __name__ == "__main__":
    out = None
    check = "--check" in sys.argv
    if "--out" in sys.argv:
        i = sys.argv.index("--out")
        out = os.path.abspath(sys.argv[i + 1])
    build(out, check_only=check)
