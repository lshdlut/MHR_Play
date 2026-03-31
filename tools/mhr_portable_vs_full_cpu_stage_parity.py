#!/usr/bin/env python3
from __future__ import annotations

import sys

from mhr_full_cpu_stage_compare import main as compare_main


if __name__ == "__main__":
    sys.argv = [sys.argv[0], "--candidate", "portable", *sys.argv[1:]]
    raise SystemExit(compare_main())
