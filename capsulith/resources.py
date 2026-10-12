# SPDX-License-Identifier: GPL-2.0-only
from pathlib import Path


def resource_root():
    source = Path(__file__).resolve().parent.parent
    return (
        source
        if (source / "runtime" / "index.cjs").is_file()
        else Path(__file__).resolve().parent / "assets"
    )
