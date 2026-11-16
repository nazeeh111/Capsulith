# SPDX-License-Identifier: GPL-2.0-only
"""Publish replacement outputs without destroying their source inputs."""

import errno
import os
from pathlib import Path
import stat
import tempfile


def _output_target(path):
    while True:
        try:
            path.stat()
        except FileNotFoundError:
            # Validate the actual traversal before resolving away any "..".
            parent = path.parent
            if not stat.S_ISDIR(parent.stat().st_mode):
                raise NotADirectoryError(errno.ENOTDIR, "Not a directory", str(parent))
            try:
                current = path.lstat()
            except FileNotFoundError:
                return parent.resolve(strict=True) / path.name
            if not stat.S_ISLNK(current.st_mode):
                raise ValueError(f"Output changed while resolving: {path}")
            # A dangling link's raw referent needs the same traversal checks.
            path = parent / os.readlink(path)
        else:
            return path.resolve(strict=True)


def _checked_mode(path, inputs):
    try:
        current = path.stat()
    except FileNotFoundError:
        return None
    for source in inputs:
        if source is not None and path.samefile(source):
            raise ValueError(f"Output must not replace an input: {path}")
    if not stat.S_ISREG(current.st_mode):
        raise ValueError(f"Output must be a regular file: {path}")
    flags = os.O_WRONLY | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    try:
        opened = os.fstat(descriptor)
        if not stat.S_ISREG(opened.st_mode) or not os.path.samestat(current, opened):
            raise ValueError(f"Output changed before replacement: {path}")
    finally:
        os.close(descriptor)
    return current.st_mode & 0o777


def replace_output(path, data, *, inputs):
    """Stage complete bytes before replacing an unrelated destination.

    Existing output symlinks keep pointing to their resolved referent. Ordinary
    permission bits are retained and existing files must allow a non-truncating
    write-open; new files use tempfile's restrictive defaults
    (0600 on POSIX). Other inode metadata and hard-link relationships are not
    retained. This is not protection against hostile concurrent path substitution
    or a power-loss guarantee.
    """
    try:
        target = _output_target(path)
    except RuntimeError as error:
        raise ValueError(f"Cannot resolve output: {path}") from error
    inputs = tuple(inputs)
    _checked_mode(target, inputs)
    staged = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb", dir=target.parent, prefix=".capsulith-", suffix=".tmp",
            delete=False,
        ) as destination:
            staged = Path(destination.name)
            destination.write(data)
            destination.flush()
            mode = _checked_mode(target, inputs)
            if mode is not None:
                os.chmod(staged, mode)
            os.fsync(destination.fileno())
        os.replace(staged, target)
    finally:
        if staged is not None:
            staged.unlink(missing_ok=True)
