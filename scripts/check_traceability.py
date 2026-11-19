"""Check requirement and acceptance-scenario IDs in published specs."""

import re
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parent.parent
HEADING = re.compile(r"^ {0,3}(#{1,6})(?:[ \t]+|$)")
HEADING_ID = re.compile(r"(?:REQ|AC)-\S+")
REQUIREMENT = r"REQ-[A-Z0-9]+(?:-[A-Z0-9]+)*-[0-9]+"
IDENTIFIER = re.compile(r"(?:REQ|AC)-[A-Z0-9]+(?:-[A-Z0-9]+)*-[0-9]+")
RELATION = re.compile(r"^ {0,3}关联(?:\s|[：:])")
FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})(.*)$")
INDENTED_CODE = re.compile(r"^(?: {4}| {0,3}\t)")
COMMENT_OR_LITERAL = re.compile(
    r"\\[\\`<]|(?<!`)(?P<ticks>`+)(?!`).*?(?<!`)(?P=ticks)(?!`)"
    r"|(?P<comment><!--.*?-->)",
    re.DOTALL,
)


def inline_lines(lines, start):
    def replace_comment(match):
        if match["comment"] is None:
            return match[0]
        return " " + "\n" * match[0].count("\n")

    visible = COMMENT_OR_LITERAL.sub(replace_comment, "\n".join(lines))
    return enumerate(zip(lines, visible.split("\n")), start)


def spec_lines(path):
    fence = None
    in_comment = False
    paragraph = []
    paragraph_start = 0
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        marker = FENCE.match(line)
        if fence is not None:
            if marker and marker[1][0] == fence[0] and len(marker[1]) >= len(fence) and not marker[2].strip():
                fence = None
            continue
        if in_comment:
            in_comment = "-->" not in line
            continue
        heading = HEADING.match(line)
        indented = INDENTED_CODE.match(line)
        comment = not indented and line.lstrip(" ").startswith("<!--")
        # Only parse inline markup within one paragraph or heading.
        if line.strip() and not (marker or heading or comment or (indented and not paragraph)):
            if not paragraph:
                paragraph_start = number
            paragraph.append(line)
            continue
        if paragraph:
            yield from inline_lines(paragraph, paragraph_start)
            paragraph.clear()
        if marker:
            fence = marker[1]
        elif comment:
            in_comment = "-->" not in line
        elif heading:
            yield from inline_lines([line], number)
    if paragraph:
        yield from inline_lines(paragraph, paragraph_start)


def main() -> int:
    specs = sorted((ROOT / "specs").rglob("spec.md"))
    locations = {}
    scenarios = {}
    errors = []
    for path in specs:
        current = None
        for number, (original, visible) in spec_lines(path):
            heading = HEADING.match(original)
            if heading and len(heading[1]) <= 3:
                current = None
                if heading[1] != "###":
                    continue
                match = HEADING_ID.match(visible[heading.end():].lstrip(" \t"))
                if not match:
                    continue
                identifier = match[0]
                location = f"{path.relative_to(ROOT)}:{number}"
                if not IDENTIFIER.fullmatch(identifier):
                    errors.append(f"{location}: invalid ID {identifier}")
                elif identifier in locations:
                    errors.append(f"{location}: duplicate {identifier}, first defined at {locations[identifier]}")
                else:
                    locations[identifier] = location
                    if identifier.startswith("AC-"):
                        current = identifier
                        scenarios[current] = set()
            elif current is not None and RELATION.match(original) and RELATION.match(visible):
                scenarios[current].update(re.findall(rf"(?<![\w-]){REQUIREMENT}(?![\w-])", visible))

    requirements = {identifier for identifier in locations if identifier.startswith("REQ-")}
    covered = set()
    for scenario, related in scenarios.items():
        if not related:
            errors.append(f"{locations[scenario]}: {scenario} needs a 关联 line with a requirement ID")
        for unknown in sorted(related - requirements):
            errors.append(f"{locations[scenario]}: {scenario} references unknown {unknown}")
        covered.update(related & requirements)
    for missing in sorted(requirements - covered):
        errors.append(f"{locations[missing]}: {missing} has no acceptance scenario")

    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    print(f"Traceability checked: {len(specs)} specs, {len(requirements)} requirements, {len(scenarios)} scenarios")
    return 0


if __name__ == "__main__":
    sys.exit(main())
