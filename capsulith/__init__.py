# SPDX-License-Identifier: GPL-2.0-only
"""Preserve supported native features as bounded portable capsules."""

from .artifact import ArtifactError, inspect_artifact
from .extract import extract_capsule
from .module import extract_module

__version__ = "0.3.0"
__all__ = ["ArtifactError", "extract_capsule", "extract_module", "inspect_artifact"]
