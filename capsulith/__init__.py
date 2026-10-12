# SPDX-License-Identifier: GPL-2.0-only
"""Preserve supported native features as bounded portable capsules."""

from .artifact import ArtifactError, inspect_artifact
from .extract import extract_capsule

__version__ = "0.1.0"
__all__ = ["ArtifactError", "inspect_artifact", "extract_capsule"]
