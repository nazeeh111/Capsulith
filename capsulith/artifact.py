# SPDX-License-Identifier: GPL-2.0-only
"""Bounded parsing of supported ARM64 Mach-O images. Never loads native code."""

from __future__ import annotations
import hashlib
import struct
from dataclasses import dataclass, field

MAX_FILE = 32 * 1024 * 1024
MAX_FUNCTIONS = 65536
MAX_CODE = MAX_READONLY = 4 * 1024 * 1024
MAX_SPAN = 16 * 1024 * 1024
MAX_COMMANDS = 4096
MAX_SYMBOLS = 262144


class ArtifactError(ValueError):
    """Malformed or unsupported native artifact, with a reviewable diagnosis."""


def require(condition, message):
    if not condition:
        raise ArtifactError(message)


def bounded(blob, offset, size, label):
    require(
        isinstance(offset, int)
        and isinstance(size, int)
        and offset >= 0
        and size >= 0
        and offset <= len(blob)
        and size <= len(blob) - offset,
        f"{label} exceeds artifact bounds",
    )
    return blob[offset : offset + size]


def unpack(blob, fmt, offset, label):
    bounded(blob, offset, struct.calcsize(fmt), label)
    return struct.unpack_from(fmt, blob, offset)


def cstring(blob, offset, end, label):
    require(0 <= offset < end <= len(blob), f"invalid {label} string offset")
    stop = blob.find(b"\0", offset, min(end, offset + 1025))
    require(stop >= 0, f"unterminated or excessive {label} name")
    try:
        return blob[offset:stop].decode("utf-8")
    except UnicodeDecodeError as error:
        raise ArtifactError(f"invalid UTF-8 {label} name") from error


def uleb(blob, cursor, end, label):
    value = 0
    for shift in range(0, 70, 7):
        require(cursor < end, f"truncated {label} integer")
        byte = blob[cursor]
        cursor += 1
        require(shift != 63 or byte <= 1, f"overflowing {label} integer")
        value |= (byte & 127) << shift
        if not byte & 128:
            return value, cursor
    raise ArtifactError(f"overflowing {label} integer")


@dataclass
class Image:
    blob: bytes
    digest: str
    sections: list[dict] = field(default_factory=list)
    segments: list[dict] = field(default_factory=list)
    functions: list[dict] = field(default_factory=list)
    imports: dict[int, str] = field(default_factory=dict)
    fixups: set[int] = field(default_factory=set)
    commands: list[dict] = field(default_factory=list)
    text: dict | None = None
    base: int = 0
    symbols: list[dict] = field(default_factory=list)

    def section_at(self, address, size=1):
        for section in self.sections:
            if (
                section["address"] <= address
                and size >= 0
                and address + size <= section["address"] + section["size"]
            ):
                return section
        return None

    def bytes_at(self, address, size):
        section = self.section_at(address, size)
        require(
            section is not None and not section["zeroFill"],
            f"address 0x{address:x} is outside file-backed sections",
        )
        return bounded(
            self.blob,
            section["offset"] + address - section["address"],
            size,
            "section bytes",
        )


def parse_artifact(data: bytes) -> Image:
    require(isinstance(data, (bytes, bytearray, memoryview)), "artifact must be bytes")
    require(32 <= len(data) <= MAX_FILE, "artifact must contain 32 bytes to 32 MiB")
    blob = bytes(data)
    magic, cpu, subtype, kind, count, command_bytes, flags, reserved = unpack(
        blob, "<8I", 0, "header"
    )
    require(magic == 0xFEEDFACF, "only little-endian Mach-O64 images are supported")
    require(
        cpu == 0x0100000C and subtype & 0xFFFFFF == 0,
        "only ordinary ARM64 images are supported; ARM64e and other architectures are unsupported",
    )
    require(kind == 6, "only Mach-O dylibs are supported")
    require(0 < count <= MAX_COMMANDS, "load-command count exceeds bounds")
    bounded(blob, 32, command_bytes, "load commands")
    require(command_bytes >= count * 8, "load-command area is too small")
    image = Image(blob, hashlib.sha256(blob).hexdigest())
    command_end = 32 + command_bytes
    position = 32
    singletons = {}
    linkedit = []
    for _ in range(count):
        command, size = unpack(blob, "<II", position, "load command")
        require(
            size >= 8 and size % 8 == 0 and position + size <= command_end,
            "invalid load-command size",
        )
        image.commands.append({"command": command, "size": size})
        if command in (2, 0xB, 0x26, 0x80000034, 0x80000033, 0x80000022, 0x22):
            require(command not in singletons, "duplicate singleton load command")
            singletons[command] = position
        if command == 0x19:
            require(size >= 72, "truncated segment command")
            (
                name,
                address,
                virtual,
                offset,
                file_size,
                maxprot,
                protection,
                nsections,
                segment_flags,
            ) = unpack(blob, "<16s4Q4I", position + 8, "segment")
            require(
                size == 72 + nsections * 80 and nsections <= 255,
                "invalid segment section count",
            )
            require(
                address + virtual <= (1 << 64) and file_size <= virtual,
                "invalid segment span",
            )
            require(
                protection & ~7 == 0
                and maxprot & ~7 == 0
                and not protection & ~maxprot,
                "invalid segment protection",
            )
            bounded(blob, offset, file_size, "segment file range")
            try:
                segment_name = name.rstrip(b"\0").decode("ascii", errors="strict")
            except UnicodeDecodeError as error:
                raise ArtifactError("non-ASCII segment identity") from error
            segment = dict(
                name=segment_name,
                address=address,
                size=virtual,
                offset=offset,
                fileSize=file_size,
                protection=protection,
            )
            image.segments.append(segment)
            for j in range(nsections):
                fields = unpack(blob, "<16s16sQQ8I", position + 72 + j * 80, "section")
                try:
                    section_name = fields[0].rstrip(b"\0").decode("ascii")
                    declared_segment = fields[1].rstrip(b"\0").decode("ascii")
                except UnicodeDecodeError as error:
                    raise ArtifactError("non-ASCII section identity") from error
                a, length, off, align, reloc, nreloc, section_flags, r1, r2, r3 = (
                    fields[2:]
                )
                require(
                    declared_segment == segment_name,
                    "section segment identity mismatch",
                )
                require(
                    address <= a <= address + virtual
                    and length <= address + virtual - a,
                    "section exceeds virtual segment",
                )
                require(
                    align <= 31 and a % (1 << align) == 0, "invalid section alignment"
                )
                zero = section_flags & 255 in (1, 12, 18)
                if not zero:
                    require(
                        not length or off >= command_end,
                        "section overlaps load-command metadata",
                    )
                    bounded(blob, off, length, "section file range")
                    require(
                        offset <= off and off + length <= offset + file_size,
                        "section exceeds file segment",
                    )
                    require(
                        a - address == off - offset,
                        "inconsistent section file/virtual mapping",
                    )
                require(nreloc <= MAX_SYMBOLS, "too many section relocations")
                bounded(blob, reloc, nreloc * 8, "section relocations")
                section = dict(
                    name=section_name,
                    segment=segment_name,
                    address=a,
                    size=length,
                    offset=off,
                    flags=section_flags,
                    reserved1=r1,
                    reserved2=r2,
                    relocationCount=nreloc,
                    relocationOffset=reloc,
                    protection=protection,
                    zeroFill=zero,
                    index=len(image.sections) + 1,
                )
                image.sections.append(section)
        elif command in (0x26, 0x29, 0x1D, 0x1E, 0x80000033, 0x80000034):
            require(size == 16, "invalid linkedit command size")
            off, length = unpack(blob, "<II", position + 8, "linkedit range")
            bounded(blob, off, length, "linkedit data")
            linkedit.append((command, off, length))
        elif command in (0x22, 0x80000022):
            require(size == 48, "invalid dyld-info size")
            fields = unpack(blob, "<10I", position + 8, "dyld-info")
            for j in range(0, 10, 2):
                bounded(blob, fields[j], fields[j + 1], "dyld-info stream")
            require(
                not any(fields[j] for j in (1, 3, 5, 7)),
                "legacy dyld relocation/binding streams are unsupported",
            )
            if fields[9]:
                linkedit.append((0x80000033, fields[8], fields[9]))
        elif command in (0xC, 0xD, 0x80000018, 0x8000001F, 0x80000023):
            require(size >= 24, "truncated dylib identity command")
            name_offset, timestamp, current, compatibility = unpack(
                blob, "<4I", position + 8, "dylib identity"
            )
            require(name_offset >= 24, "invalid dylib name offset")
            cstring(blob, position + name_offset, position + size, "dylib")
        elif command in (0x8000001C, 0x27):
            require(size >= 16, "truncated path command")
            (name_offset,) = unpack(blob, "<I", position + 8, "path offset")
            require(name_offset >= 12, "invalid path offset")
            cstring(blob, position + name_offset, position + size, "path")
        elif command == 0x1B:
            require(size == 24, "invalid UUID command")
        elif command == 0x32:
            require(size >= 24, "truncated build-version command")
            platform, minimum, sdk, tools = unpack(
                blob, "<4I", position + 8, "build version"
            )
            require(size == 24 + tools * 8, "invalid build-tool count")
        elif command == 0x2A:
            require(size == 16, "invalid source-version command")
        elif command == 0x2C:
            require(size == 24, "invalid encryption command")
            off, length, encrypted, pad = unpack(
                blob, "<4I", position + 8, "encryption"
            )
            bounded(blob, off, length, "encrypted range")
            require(encrypted == 0, "encrypted images are unsupported")
        position += size
    require(position == command_end, "load-command sizes do not fill declared area")
    require(
        image.sections and len(image.sections) <= 255, "missing or excessive sections"
    )
    for ranges, label in ((image.segments, "segments"), (image.sections, "sections")):
        occupied = sorted(
            (r["address"], r["address"] + r["size"]) for r in ranges if r["size"]
        )
        require(
            all(occupied[i][1] <= occupied[i + 1][0] for i in range(len(occupied) - 1)),
            f"overlapping virtual {label}",
        )
    file_segments = sorted(
        (s["offset"], s["offset"] + s["fileSize"])
        for s in image.segments
        if s["fileSize"]
    )
    require(
        all(
            file_segments[i][1] <= file_segments[i + 1][0]
            for i in range(len(file_segments) - 1)
        ),
        "overlapping file segments",
    )
    file_sections = sorted(
        (s["offset"], s["offset"] + s["size"])
        for s in image.sections
        if s["size"] and not s["zeroFill"]
    )
    require(
        all(
            file_sections[i][1] <= file_sections[i + 1][0]
            for i in range(len(file_sections) - 1)
        ),
        "overlapping file sections",
    )
    text_candidates = [
        s for s in image.sections if s["name"] == "__text" and s["segment"] == "__TEXT"
    ]
    require(len(text_candidates) == 1, "exactly one __TEXT,__text section is required")
    image.text = text_candidates[0]
    require(
        image.text["protection"] & 4
        and not image.text["protection"] & 2
        and not image.text["zeroFill"]
        and image.text["size"] <= MAX_CODE,
        "text must be executable, immutable, file backed, and at most 4 MiB",
    )
    image.base = min(s["address"] for s in image.segments if s["size"])
    require(
        max(s["address"] + s["size"] for s in image.segments) - image.base <= MAX_SPAN,
        "image span exceeds 16 MiB",
    )
    _symbols(image, singletons)
    _function_starts(image, linkedit)
    _exports(image, linkedit)
    _imports(image, singletons)
    _fixups(image, linkedit)
    return image


def _symbols(image, singletons):
    require(2 in singletons, "a symbol table is required for import/export identities")
    position = singletons[2]
    require(
        next(c["size"] for c in image.commands if c["command"] == 2) == 24,
        "invalid symbol command size",
    )
    off, count, string_off, string_size = unpack(
        image.blob, "<4I", position + 8, "symbol table"
    )
    require(count <= MAX_SYMBOLS, "symbol count exceeds bounds")
    bounded(image.blob, off, count * 16, "symbol entries")
    bounded(image.blob, string_off, string_size, "symbol strings")
    require(string_size > 0, "empty symbol string table")
    for j in range(count):
        string_index, typ, section, description, address = unpack(
            image.blob, "<IBBHQ", off + 16 * j, "symbol"
        )
        require(section <= len(image.sections), "symbol references an invalid section")
        name = cstring(
            image.blob, string_off + string_index, string_off + string_size, "symbol"
        )
        image.symbols.append(
            dict(name=name, type=typ, section=section, address=address)
        )


def _function_starts(image, linkedit):
    candidates = [(o, n) for c, o, n in linkedit if c == 0x26]
    require(
        len(candidates) == 1 and candidates[0][1],
        "LC_FUNCTION_STARTS metadata is required",
    )
    off, size = candidates[0]
    cursor, end, address = off, off + size, image.base
    starts = []
    terminated = False
    while cursor < end:
        delta, cursor = uleb(image.blob, cursor, end, "function start")
        if delta == 0:
            terminated = True
            require(not any(image.blob[cursor:end]), "nonzero function-start padding")
            break
        address += delta
        require(
            image.text["address"]
            <= address
            < image.text["address"] + image.text["size"]
            and address % 4 == 0,
            "function start lies outside aligned text",
        )
        starts.append(address)
        require(len(starts) <= MAX_FUNCTIONS, "function count exceeds bounds")
    require(terminated and starts, "unterminated or empty function-start metadata")
    named = {}
    for symbol in image.symbols:
        if (
            symbol["type"] & 0xE0 == 0
            and symbol["type"] & 0xE == 0xE
            and symbol["section"] == image.text["index"]
        ):
            named.setdefault(symbol["address"], []).append(symbol)
    for j, address in enumerate(starts):
        aliases = named.get(address, [])
        aliases.sort(key=lambda s: (not bool(s["type"] & 1), s["name"]))
        finish = (
            starts[j + 1]
            if j + 1 < len(starts)
            else image.text["address"] + image.text["size"]
        )
        require(
            finish > address and (finish - address) % 4 == 0, "invalid function extent"
        )
        image.functions.append(
            dict(
                address=address,
                end=finish,
                size=finish - address,
                name=aliases[0]["name"] if aliases else f"function@0x{address:x}",
                aliases=[s["name"] for s in aliases],
                exported=any(s["type"] & 1 for s in aliases),
                supportStatus="unchecked",
            )
        )


def _exports(image, linkedit):
    candidates = [(o, n) for c, o, n in linkedit if c == 0x80000033 and n]
    require(len(candidates) <= 1, "duplicate export tries")
    if not candidates:
        return
    off, size = candidates[0]
    blob = bounded(image.blob, off, size, "export trie")
    visited, exports = set(), []
    todo = [(0, "", frozenset())]
    while todo:
        node, prefix, ancestry = todo.pop()
        require(node < size and node not in ancestry, "cyclic or invalid export trie")
        require(
            len(prefix.encode("utf-8")) <= 1024 and len(visited) <= MAX_SYMBOLS,
            "export trie exceeds bounds",
        )
        visited.add((node, prefix))
        terminal_size, cursor = uleb(blob, node, size, "export terminal")
        terminal_end = cursor + terminal_size
        require(terminal_end < size, "truncated export terminal")
        if terminal_size:
            flags, value_pos = uleb(blob, cursor, terminal_end, "export flags")
            if flags & 8:
                ordinal, value_pos = uleb(
                    blob, value_pos, terminal_end, "reexport ordinal"
                )
                target_name = cstring(blob, value_pos, terminal_end, "reexport")
                value_pos += len(target_name.encode("utf-8")) + 1
            else:
                address, value_pos = uleb(
                    blob, value_pos, terminal_end, "export address"
                )
                if flags & 16:
                    resolver, value_pos = uleb(
                        blob, value_pos, terminal_end, "export resolver"
                    )
                if flags & 3 == 0 and not flags & 16:
                    exports.append((prefix, image.base + address))
            require(flags & ~0x3F == 0 and flags & 3 != 3, "unsupported export flags")
            require(
                value_pos == terminal_end and prefix, "invalid export terminal payload"
            )
        children = blob[terminal_end]
        cursor = terminal_end + 1
        for _ in range(children):
            suffix = cstring(blob, cursor, size, "export edge")
            require(suffix, "empty export edge")
            cursor += len(suffix.encode("utf-8")) + 1
            child, cursor = uleb(blob, cursor, size, "export child")
            todo.append((child, prefix + suffix, ancestry | {node}))
        require(len(todo) + len(visited) <= MAX_SYMBOLS, "export trie exceeds bounds")
    by_address = {f["address"]: f for f in image.functions}
    for name, address in exports:
        if address in by_address:
            function = by_address[address]
            function["exported"] = True
            if name not in function["aliases"]:
                function["aliases"].append(name)
            if function["name"].startswith("function@"):
                function["name"] = name


def _imports(image, singletons):
    stubs = [s for s in image.sections if s["flags"] & 255 == 8]
    if 0xB not in singletons:
        require(not stubs, "stub imports require LC_DYSYMTAB")
        return
    position = singletons[0xB]
    require(
        next(c["size"] for c in image.commands if c["command"] == 0xB) == 80,
        "invalid dynamic-symbol command size",
    )
    fields = unpack(image.blob, "<18I", position + 8, "dynamic symbols")
    for start, count in zip(fields[:6:2], fields[1:6:2]):
        require(
            start + count <= len(image.symbols), "dynamic-symbol range exceeds table"
        )
    require(
        fields[15] == 0 and fields[17] == 0,
        "dynamic external/local relocation tables are unsupported",
    )
    off, count = fields[12:14]
    require(count <= MAX_SYMBOLS, "indirect symbol count exceeds bounds")
    for off_index, count_index, entry_size in (
        (6, 7, 8),
        (8, 9, 56),
        (10, 11, 4),
        (14, 15, 8),
        (16, 17, 8),
    ):
        require(
            fields[count_index] <= MAX_SYMBOLS, "dynamic metadata count exceeds bounds"
        )
        bounded(
            image.blob,
            fields[off_index],
            fields[count_index] * entry_size,
            "dynamic metadata table",
        )
    table = bounded(image.blob, off, count * 4, "indirect symbols")
    for section in stubs:
        width, first = section["reserved2"], section["reserved1"]
        require(
            width >= 4 and width % 4 == 0 and section["size"] % width == 0,
            "invalid import-stub width",
        )
        require(
            first + section["size"] // width <= count,
            "stub indices exceed indirect-symbol table",
        )
        for j in range(section["size"] // width):
            (index,) = unpack(table, "<I", (first + j) * 4, "stub symbol")
            require(
                index < len(image.symbols),
                "unsupported local or invalid import-stub symbol",
            )
            symbol = image.symbols[index]
            require(
                symbol["type"] & 0xE == 0 and symbol["section"] == 0 and symbol["name"],
                "stub does not name an undefined import",
            )
            image.imports[section["address"] + j * width] = symbol["name"]


def _fixups(image, linkedit):
    candidates = [(o, n) for c, o, n in linkedit if c == 0x80000034 and n]
    if not candidates:
        return
    off, size = candidates[0]
    blob = bounded(image.blob, off, size, "chained fixups")
    (
        version,
        starts_off,
        imports_off,
        symbols_off,
        imports_count,
        imports_format,
        symbols_format,
    ) = unpack(blob, "<7I", 0, "chained header")
    require(
        version == 0 and symbols_format == 0 and imports_count <= MAX_SYMBOLS,
        "unsupported chained-fixup header",
    )
    require(
        imports_format in (1, 2, 3) or imports_count == 0,
        "unsupported chained import format",
    )
    width = {1: 4, 2: 8, 3: 16}.get(imports_format, 0)
    bounded(blob, imports_off, imports_count * width, "chained imports")
    require(symbols_off <= len(blob), "invalid chained symbol offset")
    for j in range(imports_count):
        (word,) = unpack(
            blob,
            "<Q" if imports_format == 3 else "<I",
            imports_off + j * width,
            "chained import",
        )
        require(
            imports_format != 3 or not word & 0xFFFE0000,
            "nonzero chained-import reserved bits",
        )
        name_off = word >> (32 if imports_format == 3 else 9)
        cstring(blob, symbols_off + name_off, len(blob), "chained import")
    (segment_count,) = unpack(blob, "<I", starts_off, "chain segment count")
    require(segment_count == len(image.segments), "chained segment count mismatch")
    offsets = unpack(
        blob, "<" + "I" * segment_count, starts_off + 4, "chain segment starts"
    )
    for index, relative in enumerate(offsets):
        if not relative:
            continue
        cursor = starts_off + relative
        length, page_size, fmt, seg_offset, maximum, pages = unpack(
            blob, "<IHHQIH", cursor, "chain segment"
        )
        require(
            length >= 22 + pages * 2 and length % 2 == 0, "invalid chain-segment length"
        )
        bounded(blob, cursor, length, "chain segment payload")
        require(
            page_size in (4096, 16384) and fmt in (2, 6),
            "only chained 64-bit pointer formats 2 and 6 are supported",
        )
        segment = image.segments[index]
        require(
            image.base + seg_offset == segment["address"]
            and pages <= (segment["size"] + page_size - 1) // page_size,
            "chain segment location mismatch",
        )
        entries = unpack(
            blob, "<" + "H" * ((length - 22) // 2), cursor + 22, "chain page starts"
        )
        for page, initial in enumerate(entries[:pages]):
            if initial == 0xFFFF:
                continue
            start_list = [initial]
            if initial & 0x8000:
                extra = initial & 0x7FFF
                require(extra >= pages, "invalid multi-chain offset")
                start_list = []
                while True:
                    require(extra < len(entries), "multi-chain offset exceeds payload")
                    item = entries[extra]
                    extra += 1
                    start_list.append(item & 0x7FFF)
                    if item & 0x8000:
                        break
            for initial in start_list:
                require(
                    initial < page_size and initial % 4 == 0,
                    "invalid chain page offset",
                )
                delta = initial
                while True:
                    require(delta + 8 <= page_size, "chain pointer exceeds page")
                    address = segment["address"] + page * page_size + delta
                    require(address not in image.fixups, "duplicate chained pointer")
                    (word,) = unpack(
                        image.bytes_at(address, 8), "<Q", 0, "chain pointer"
                    )
                    require(
                        not ((word >> 32) & 0x7FFFF)
                        if word >> 63
                        else not ((word >> 44) & 0x7F),
                        "nonzero chained-pointer reserved bits",
                    )
                    if word >> 63:
                        require(
                            (word & 0xFFFFFF) < imports_count,
                            "chained bind ordinal exceeds imports",
                        )
                    image.fixups.add(address)
                    require(
                        len(image.fixups) <= MAX_SYMBOLS,
                        "chained pointer count exceeds bounds",
                    )
                    advance = (word >> 51) & 0xFFF
                    if not advance:
                        break
                    delta += advance * 4


def inspect_artifact(blob: bytes) -> dict:
    image = parse_artifact(blob)
    return {
        "schema": 1,
        "architecture": "arm64",
        "format": "Mach-O64 dylib",
        "artifactSHA256": image.digest,
        "artifactBytes": len(image.blob),
        "functions": image.functions,
        "sections": image.sections,
        "imports": [
            {"address": a, "name": n} for a, n in sorted(image.imports.items())
        ],
        "fixupCount": len(image.fixups),
        "supportStatus": "inventory only; extract a root to check its dependencies",
        "limits": {
            "fileBytes": MAX_FILE,
            "functions": MAX_FUNCTIONS,
            "codeBytes": MAX_CODE,
            "readonlyBytes": MAX_READONLY,
            "addressSpan": MAX_SPAN,
        },
    }
