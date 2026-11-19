"""Summarize a range of local Git refs for a review or release draft."""

import argparse
import subprocess


def git(*args: str) -> str:
    result = subprocess.run(
        ["git", "--no-pager", "-c", "core.quotePath=false", *args],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or f"git {args[0]} exited with {result.returncode}")
    return result.stdout.rstrip()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("base", help="Base branch, tag or commit in this Git checkout")
    parser.add_argument("head", nargs="?", default="HEAD", help="Candidate ref (default: HEAD)")
    parser.add_argument("--merge-base", action="store_true", help="Start the file diff at the common ancestor")
    args = parser.parse_args()

    try:
        base = git("rev-parse", "--verify", "--end-of-options", f"{args.base}^{{commit}}")
        head = git("rev-parse", "--verify", "--end-of-options", f"{args.head}^{{commit}}")
        diff_start = git("merge-base", base, head) if args.merge_base else base
        commits = git("log", "--format=%h %s", f"{base}..{head}", "--")
        diff_args = ["diff", "--no-ext-diff", "--no-textconv"]
        files = git(*diff_args, "--name-status", diff_start, head, "--")
        stats = git(*diff_args, "--stat", diff_start, head, "--")
    except (OSError, RuntimeError) as error:
        parser.exit(1, f"Cannot summarize Git range: {error}\n")

    print(f"Base: {base}\nHead: {head}\nDiff start: {diff_start}")
    for label, value in [("Commits reachable only from head", commits), ("Changed paths", files), ("Diff stat", stats)]:
        print(f"\n{label}\n{value or '(none)'}")


if __name__ == "__main__":
    main()
