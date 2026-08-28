#!/usr/bin/env python3
"""
Batch-evaluate the smart skirmish AI against the stock one.

Runs N headless matches, parses the records written by -aiEval, and reports
win rates with confidence intervals.

Two details matter for the result to mean anything:

  * Side swapping. On an asymmetric map, starting position can matter more
    than AI quality. Each pairing is played twice with the roles exchanged,
    so position bias cancels instead of being attributed to the AI.

  * Interval estimates. A 6-4 record is not evidence of anything. The Wilson
    score interval is reported so a difference is only called when the data
    supports it.

Example:

    ./run_eval.py --exe ./generalszh \\
                  --map "Maps/Tournament Desert/Tournament Desert.map" \\
                  --games 40 --players 1,2
"""

import argparse
import math
import os
import re
import subprocess
import sys
import tempfile
from collections import defaultdict


RESULT_RE = re.compile(r"^RESULT\s+(.*)$")
PLAYER_RE = re.compile(r"^PLAYER\s+(.*)$")


def parse_kv(line):
    """Parse 'a=1 b=two c=3' into a dict, leaving values as strings."""
    out = {}
    for tok in line.split():
        if "=" in tok:
            k, v = tok.split("=", 1)
            out[k] = v
    return out


def parse_records(path):
    """Yield (result_dict, [player_dicts]) for each match record in the file."""
    if not os.path.exists(path):
        return

    current = None
    players = []

    with open(path, "r", errors="replace") as fh:
        for line in fh:
            line = line.strip()

            m = RESULT_RE.match(line)
            if m:
                if current is not None:
                    yield current, players
                current = parse_kv(m.group(1))
                players = []
                continue

            m = PLAYER_RE.match(line)
            if m and current is not None:
                players.append(parse_kv(m.group(1)))
                continue

            if line == "END" and current is not None:
                yield current, players
                current = None
                players = []

    if current is not None:
        yield current, players


def wilson(wins, total, z=1.96):
    """Wilson score interval for a binomial proportion. Returns (lo, hi)."""
    if total == 0:
        return (0.0, 0.0)

    p = wins / total
    denom = 1.0 + (z * z) / total
    centre = p + (z * z) / (2 * total)
    margin = z * math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total)

    return ((centre - margin) / denom, (centre + margin) / denom)


def run_match(exe, mapfile, smart_players, max_frames, record_path,
              extra_args, timeout):
    """Run one headless match. Returns True if the process exited cleanly."""
    cmd = [
        exe,
        "-file", mapfile,
        "-forceSkirmishAI",
        "-noDraw",
        "-noaudio",
        "-noshellmap",
        "-quickstart",
        "-aiEval", record_path,
        "-aiEvalMaxFrames", str(max_frames),
    ]

    if smart_players:
        cmd += ["-smartAIPlayers", ",".join(str(i) for i in smart_players)]

    cmd += extra_args

    try:
        proc = subprocess.run(
            cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=timeout,
        )
        return proc.returncode == 0
    except subprocess.TimeoutExpired:
        return False
    except FileNotFoundError:
        print("error: could not execute %s" % exe, file=sys.stderr)
        sys.exit(2)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--exe", required=True, help="path to the game binary")
    ap.add_argument("--map", required=True, help="map to play")
    ap.add_argument("--games", type=int, default=20, help="number of matches")
    ap.add_argument("--players", default="1,2",
                    help="comma list of the two contending player indices "
                         "(default 1,2)")
    ap.add_argument("--max-frames", type=int, default=30 * 60 * 30,
                    help="declare a draw after this many logic frames "
                         "(default 30 minutes of game time)")
    ap.add_argument("--timeout", type=int, default=900,
                    help="hard wall-clock cap per match, seconds")
    ap.add_argument("--out", default=None,
                    help="keep the raw record file at this path")
    ap.add_argument("--no-swap", action="store_true",
                    help="do not alternate sides between runs (not advised)")
    ap.add_argument("extra", nargs="*",
                    help="extra args passed through to the game")
    args = ap.parse_args()

    try:
        slots = [int(x) for x in args.players.split(",") if x.strip() != ""]
    except ValueError:
        print("error: --players must be a comma list of integers", file=sys.stderr)
        sys.exit(2)

    if len(slots) != 2:
        print("error: --players needs exactly two indices", file=sys.stderr)
        sys.exit(2)

    record_path = args.out or os.path.join(tempfile.mkdtemp(prefix="aieval-"),
                                           "records.txt")
    if os.path.exists(record_path):
        os.remove(record_path)

    print("running %d matches on %s" % (args.games, args.map))
    print("records -> %s\n" % record_path)

    failures = 0
    for i in range(args.games):
        # Alternate which slot gets the smart AI so starting position cannot
        # masquerade as AI strength.
        if args.no_swap:
            smart = [slots[0]]
        else:
            smart = [slots[i % 2]]

        ok = run_match(args.exe, args.map, smart, args.max_frames,
                       record_path, args.extra, args.timeout)
        if not ok:
            failures += 1

        sys.stdout.write("\r  %d/%d complete (%d failed)"
                         % (i + 1, args.games, failures))
        sys.stdout.flush()

    print("\n")
    report(record_path, failures)


def report(record_path, failures):
    wins = defaultdict(int)
    played = defaultdict(int)
    reasons = defaultdict(int)
    end_frames = []
    stats = defaultdict(lambda: defaultdict(list))

    matches = 0

    for result, players in parse_records(record_path):
        matches += 1
        reasons[result.get("reason", "?")] += 1

        try:
            end_frames.append(int(result.get("endFrame", "0")))
        except ValueError:
            pass

        winner = result.get("winner", "-1")

        for p in players:
            ai = p.get("ai", "?")
            if ai == "human":
                continue

            played[ai] += 1
            if p.get("idx") == winner:
                wins[ai] += 1

            for key in ("unitsBuilt", "unitsLost", "unitsKilled",
                        "bldgBuilt", "earned"):
                if key in p:
                    try:
                        stats[ai][key].append(int(p[key]))
                    except ValueError:
                        pass

    if matches == 0:
        print("No match records were produced.")
        print("Check that the binary accepted -aiEval and that the map loaded.")
        if failures:
            print("%d process runs failed outright." % failures)
        return

    print("matches recorded: %d   (process failures: %d)" % (matches, failures))

    if end_frames:
        avg = sum(end_frames) / len(end_frames)
        print("mean match length: %.0f frames (~%.1f min game time)"
              % (avg, avg / 30.0 / 60.0))

    print("outcomes: " + ", ".join("%s=%d" % (k, v)
                                   for k, v in sorted(reasons.items())))
    print()

    print("%-8s %7s %7s %8s   %s" % ("AI", "played", "wins", "winrate",
                                     "95% interval"))
    print("-" * 58)

    for ai in sorted(played.keys()):
        n = played[ai]
        w = wins[ai]
        lo, hi = wilson(w, n)
        print("%-8s %7d %7d %7.1f%%   [%.1f%%, %.1f%%]"
              % (ai, n, w, 100.0 * w / n, 100.0 * lo, 100.0 * hi))

    # Only call a difference when the intervals actually separate.
    if "smart" in played and "stock" in played:
        s_lo, s_hi = wilson(wins["smart"], played["smart"])
        k_lo, k_hi = wilson(wins["stock"], played["stock"])

        print()
        if s_lo > k_hi:
            print("=> smart AI is ahead; the intervals do not overlap.")
        elif k_lo > s_hi:
            print("=> stock AI is ahead; the intervals do not overlap.")
        else:
            print("=> inconclusive at this sample size; intervals overlap.")
            print("   Run more games before reading anything into the gap.")

    print()
    for ai in sorted(stats.keys()):
        parts = []
        for key, vals in sorted(stats[ai].items()):
            if vals:
                parts.append("%s=%.0f" % (key, sum(vals) / len(vals)))
        if parts:
            print("mean %-6s %s" % (ai, "  ".join(parts)))


if __name__ == "__main__":
    main()
