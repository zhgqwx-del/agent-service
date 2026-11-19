"""Create a change directory from the STDD Markdown templates."""

import argparse
from pathlib import Path
import re


ROOT = Path(__file__).resolve().parent.parent


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("change_id", help="Directory name, for example 014-order-cancellation")
    parser.add_argument("title", help="Title shown in the change documents")
    parser.add_argument("--design", action="store_true", help="Include design.md")
    parser.add_argument("--roles", action="store_true", help="Include the draft spec, UX design and test plan")
    args = parser.parse_args()

    if not re.fullmatch(r"[0-9]+-[a-z0-9]+(?:-[a-z0-9]+)*", args.change_id):
        parser.error("change_id must look like 014-order-cancellation")
    title = args.title.strip()
    if not title or len(title.splitlines()) != 1:
        parser.error("title must be a non-empty single line")

    changes = ROOT / "changes"
    destination = changes / args.change_id
    if (changes / "archive" / args.change_id).exists():
        parser.error(f"change is already archived: {args.change_id}")

    names = ["change.md", "tasks.md", "verification.md"]
    if args.design:
        names.append("design.md")
    if args.roles:
        names.extend(("spec.md", "ux-design.md", "test-plan.md"))
    templates = ROOT / "docs" / "stdd" / "templates"
    try:
        files = {
            name: (templates / name).read_text(encoding="utf-8")
            .replace("<NNN-slug>", args.change_id, 1)
            .replace("<能力名称>" if name == "spec.md" else "<变更名称>", title, 1)
            for name in names
        }
        changes.mkdir(exist_ok=True)
        destination.mkdir()
    except (OSError, UnicodeError) as error:
        parser.exit(1, f"Cannot create {destination}: {error}\n")

    created = []
    try:
        for name, content in files.items():
            path = destination / name
            with path.open("x", encoding="utf-8") as output:
                created.append(path)
                output.write(content)
    except OSError as error:
        try:
            for path in created:
                path.unlink()
            destination.rmdir()
        except OSError as cleanup_error:
            parser.exit(1, f"Creation failed: {error}\nCleanup failed: {cleanup_error}\n")
        parser.exit(1, f"Creation failed: {error}\n")

    print(f"Created {destination.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
