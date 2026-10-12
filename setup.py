# SPDX-License-Identifier: GPL-2.0-only
from pathlib import Path
import shutil
from setuptools import setup
from setuptools.command.build_py import build_py


class BuildAssets(build_py):
    def run(self):
        super().run()
        root = Path(__file__).resolve().parent
        destination = Path(self.build_lib) / "capsulith" / "assets"
        for directory in ("runtime", "studio", "examples"):
            shutil.copytree(
                root / directory,
                destination / directory,
                dirs_exist_ok=True,
                ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
            )
        shutil.copy2(root / "LICENSE", destination / "LICENSE")
        shutil.copy2(
            root / "THIRD_PARTY_NOTICES.md", destination / "THIRD_PARTY_NOTICES.md"
        )


setup(cmdclass={"build_py": BuildAssets})
