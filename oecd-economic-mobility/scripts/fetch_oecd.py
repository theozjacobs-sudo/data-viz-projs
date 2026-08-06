#!/usr/bin/env python3
"""Fetch OECD data for the economic-mobility dashboard from the SDMX REST API.

Dependency-free (stdlib only). Downloads land in oecd-economic-mobility/data/.

Usage:
    python3 scripts/fetch_oecd.py            # fetch everything
    python3 scripts/fetch_oecd.py catalog    # just the dataflow catalog

API docs: https://sdmx.oecd.org/public/rest/  (SDMX 2.1 REST)
The v2 endpoint (…/public/rest/v2/…) supports c[DIM]=code filters, which lets
us filter on MEASURE without knowing every dimension position in the key.
"""
import sys
import time
import urllib.request
from pathlib import Path

BASE = "https://sdmx.oecd.org/public/rest"
DATA_DIR = Path(__file__).resolve().parent.parent / "data"

# (name, url) pairs. csvfilewithlabels = tidy CSV with both codes and labels.
TARGETS = {
    # The full dataflow catalog — what does the OECD publish? (XML, ~10 MB)
    "catalog": ("catalog.xml", f"{BASE}/dataflow/all/all/latest"),
    # Income Distribution Database structure (dimensions + codelists)
    "idd_structure": (
        "idd_structure.xml",
        f"{BASE}/datastructure/OECD.WISE.INE/DSD_WISE_IDD?references=all",
    ),
    # IDD: Gini (disposable income), S80/S20, relative income poverty — all
    # countries, all years, total population. Filtered via the v2 API.
    "idd_data": (
        "idd_data.csv",
        f"{BASE}/v2/data/dataflow/OECD.WISE.INE/DSD_WISE_IDD@DF_IDD/"
        "?c[MEASURE]=INC_DISP_GINI,PR_INC_DISP,S80S20,PR_INC_DISP_MEDIAN"
        "&c[AGE]=_T&format=csvfilewithlabels",
    ),
}


def fetch(name: str, filename: str, url: str, retries: int = 3) -> bool:
    dest = DATA_DIR / filename
    req = urllib.request.Request(url, headers={"User-Agent": "curl/8.0"})
    for attempt in range(1, retries + 1):
        try:
            print(f"[{name}] GET {url}")
            with urllib.request.urlopen(req, timeout=120) as resp:
                dest.write_bytes(resp.read())
            print(f"[{name}] -> {dest} ({dest.stat().st_size:,} bytes)")
            return True
        except Exception as exc:  # noqa: BLE001 - report and retry
            print(f"[{name}] attempt {attempt}/{retries} failed: {exc}")
            time.sleep(2 * attempt)
    return False


def main() -> int:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    wanted = sys.argv[1:] or list(TARGETS)
    failures = [n for n in wanted if not fetch(n, *TARGETS[n])]
    if failures:
        print(f"FAILED: {', '.join(failures)}")
        return 1
    print("All fetches complete.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
