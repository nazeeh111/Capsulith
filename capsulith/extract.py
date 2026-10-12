# SPDX-License-Identifier: GPL-2.0-only
"""Extract closed direct-control-flow native features without loading their image."""

from __future__ import annotations
from capstone import Cs, CS_ARCH_ARM64, CS_MODE_ARM
from capstone.arm64_const import ARM64_OP_IMM, ARM64_OP_MEM, ARM64_OP_REG
from .artifact import (
    ArtifactError,
    MAX_CODE,
    MAX_READONLY,
    MAX_SPAN,
    parse_artifact,
    require,
)

ALLOWED_IMPORTS = frozenset(("_memcpy", "_memmove", "_memset"))
DATA_SECTIONS = frozenset(("__const", "__cstring"))


def _resolve_root(image, root):
    if isinstance(root, bool):
        raise ArtifactError("root must be a symbol or original function-start address")
    if isinstance(root, str):
        matches = [
            f for f in image.functions if root == f["name"] or root in f["aliases"]
        ]
        if not matches and not root.startswith("_"):
            matches = [f for f in image.functions if "_" + root in f["aliases"]]
        if matches:
            require(
                len(matches) == 1,
                "root symbol is ambiguous; select its original address",
            )
            return matches[0]
        try:
            root = int(root, 0)
        except ValueError as error:
            raise ArtifactError(f"unknown function symbol: {root}") from error
    require(
        isinstance(root, int) and root >= 0,
        "root must be a symbol or original function-start address",
    )
    matches = [f for f in image.functions if f["address"] == root]
    require(len(matches) == 1, f"0x{root:x} is not a verified function-start address")
    return matches[0]


def _readonly_sections(image):
    sections = []
    for section in image.sections:
        if section["name"] not in DATA_SECTIONS or not section["size"]:
            continue
        require(
            not section["zeroFill"]
            and section["protection"] & 1
            and not section["protection"] & 2,
            f"readonly candidate {section['segment']},{section['name']} is writable or not file backed",
        )
        require(
            not section["relocationCount"],
            f"readonly candidate {section['name']} contains unresolved relocations",
        )
        require(
            not any(
                section["address"] <= pointer < section["address"] + section["size"]
                for pointer in image.fixups
            ),
            f"readonly candidate {section['name']} contains relocated static pointers",
        )
        sections.append(section)
    require(
        sum(s["size"] for s in sections) <= MAX_READONLY, "readonly data exceeds 4 MiB"
    )
    return sections


def _check_address(image, address, instruction, memory=False, writing=False):
    section = image.section_at(address)
    require(
        section is not None,
        f"unsupported static address 0x{address:x} at 0x{instruction:x}",
    )
    require(
        not section["protection"] & 2,
        f"writable static dependency {section['segment']},{section['name']} at 0x{instruction:x}",
    )
    if memory:
        require(not writing, f"static memory write at 0x{instruction:x} is unsupported")
        require(
            section["name"] in DATA_SECTIONS,
            f"unsupported static data section {section['name']} at 0x{instruction:x}",
        )
        require(
            not any(address <= pointer < address + 16 for pointer in image.fixups),
            f"relocated static pointer access at 0x{instruction:x}",
        )
    return section


def _instructions(image, function):
    decoder = Cs(CS_ARCH_ARM64, CS_MODE_ARM)
    decoder.detail = True
    code = image.bytes_at(function["address"], function["size"])
    instructions = list(decoder.disasm(code, function["address"]))
    require(
        len(instructions) * 4 == len(code)
        and all(
            i.address == function["address"] + n * 4 and i.size == 4
            for n, i in enumerate(instructions)
        ),
        f"incomplete or invalid ARM64 disassembly in {function['name']}",
    )
    return instructions


def _physical_register(instruction, register):
    name = instruction.reg_name(register)
    if name == "fp":
        return "x29"
    if name == "lr":
        return "x30"
    if name == "wsp":
        return "sp"
    if name == "wzr":
        return "xzr"
    if name.startswith("w") and name[1:].isdigit():
        return "x" + name[1:]
    return name


def _register_value(instruction, register, constants):
    value = constants.get(_physical_register(instruction, register))
    if value is not None and instruction.reg_name(register).startswith("w"):
        value &= 0xFFFFFFFF
    return value


def _set_register(instruction, register, value, constants):
    name = _physical_register(instruction, register)
    if name == "xzr":
        return
    if instruction.reg_name(register).startswith("w"):
        value &= 0xFFFFFFFF
    constants[name] = value


def _can_fall_through(function, instructions):
    """Check reachable sequential edges, without mistaking dead padding for code."""
    by_address = {instruction.address: instruction for instruction in instructions}
    pending = [function["address"]]
    visited = set()
    while pending:
        address = pending.pop()
        if address == function["end"]:
            return True
        if address in visited or address not in by_address:
            continue
        visited.add(address)
        instruction = by_address[address]
        mnemonic = instruction.mnemonic
        if mnemonic == "ret":
            continue
        if mnemonic == "b":
            target = instruction.operands[-1].imm
            if function["address"] <= target < function["end"]:
                pending.append(target)
            continue
        if mnemonic.startswith("b.") or mnemonic in ("cbz", "cbnz", "tbz", "tbnz"):
            target = instruction.operands[-1].imm
            if function["address"] <= target < function["end"]:
                pending.append(target)
        pending.append(address + 4)
    return False


def extract_capsule(blob: bytes, root) -> dict:
    image = parse_artifact(blob)
    require(
        image.base == 0, "nonzero preferred image bases are unsupported in this release"
    )
    first = _resolve_root(image, root)
    readonly = _readonly_sections(image)
    functions = {f["address"]: f for f in image.functions}
    selected = {first["address"]}
    pending = [first]
    imports = {}
    edges, records, static = [], [], []
    byte_count = 0
    while pending:
        function = pending.pop()
        require(
            not any(
                function["address"] <= pointer < function["end"]
                for pointer in image.fixups
            ),
            f"function {function['name']} contains unresolved chained pointers",
        )
        require(
            not image.text["relocationCount"],
            "selected executable section contains unresolved relocations",
        )
        byte_count += function["size"]
        require(byte_count <= MAX_CODE, "selected code exceeds 4 MiB")
        constants = {}
        decoded = _instructions(image, function)
        joins = {
            i.operands[-1].imm
            for i in decoded
            if i.mnemonic in ("b", "bl", "cbz", "cbnz", "tbz", "tbnz")
            or i.mnemonic.startswith("b.")
        }
        for instruction in decoded:
            if instruction.address in joins:
                constants.clear()
            mnemonic = instruction.mnemonic
            operands = instruction.operands
            require(
                mnemonic
                not in (
                    "br",
                    "blr",
                    "eret",
                    "drps",
                    "svc",
                    "hvc",
                    "smc",
                    "brk",
                    "hlt",
                    "udf",
                    "mrs",
                    "msr",
                    "sys",
                    "sysl",
                    "dc",
                    "ic",
                    "tlbi",
                    "at",
                    "wfe",
                    "wfi",
                    "sev",
                    "sevl",
                    "dcps1",
                    "dcps2",
                    "dcps3",
                )
                and not mnemonic.startswith(
                    (
                        "braa",
                        "brab",
                        "blraa",
                        "blrab",
                        "retaa",
                        "retab",
                        "pac",
                        "aut",
                        "xpac",
                    )
                ),
                f"unsupported control instruction {mnemonic} at 0x{instruction.address:x}",
            )
            if mnemonic == "ret":
                require(
                    not operands
                    or (
                        len(operands) == 1
                        and _physical_register(instruction, operands[0].reg) == "x30"
                    ),
                    f"unsupported indirect return at 0x{instruction.address:x}",
                )
            target = None
            direct = mnemonic in (
                "b",
                "bl",
                "cbz",
                "cbnz",
                "tbz",
                "tbnz",
            ) or mnemonic.startswith("b.")
            if direct:
                require(
                    operands and operands[-1].type == ARM64_OP_IMM,
                    "invalid direct-control operand",
                )
                target = operands[-1].imm
                require(
                    target % 4 == 0,
                    f"unaligned control target at 0x{instruction.address:x}",
                )
                if target in image.imports:
                    name = image.imports[target]
                    require(
                        name in ALLOWED_IMPORTS,
                        f"unsupported import {name} called at 0x{instruction.address:x}",
                    )
                    imports[target] = name
                    kind = "import"
                elif function["address"] <= target < function["end"]:
                    kind = "branch"
                elif target in functions:
                    helper = functions[target]
                    kind = "call" if mnemonic == "bl" else "tail-or-shared-branch"
                    if target not in selected:
                        selected.add(target)
                        pending.append(helper)
                else:
                    raise ArtifactError(
                        f"unknown direct target 0x{target:x} at 0x{instruction.address:x}"
                    )
                edges.append(
                    {
                        "from": instruction.address,
                        "to": target,
                        "kind": kind,
                        "function": function["address"],
                    }
                )
            # Register constants identify static references; unknown ABI-derived pointers
            # remain runtime-checked against declared logical memory ranges.
            known = dict(constants)
            _, writes = instruction.regs_access()
            for register in writes:
                constants.pop(_physical_register(instruction, register), None)
            for operand in operands:
                if operand.type != ARM64_OP_MEM:
                    continue
                base = _physical_register(instruction, operand.mem.base)
                if base in known:
                    address = known[base] + operand.mem.disp
                    writing = mnemonic.startswith(("st", "cas", "swp"))
                    section = _check_address(
                        image,
                        address,
                        instruction.address,
                        memory=True,
                        writing=writing,
                    )
                    static.append(
                        {
                            "instruction": instruction.address,
                            "address": address,
                            "section": section["name"],
                            "indexed": bool(operand.mem.index),
                        }
                    )
            if mnemonic in ("adr", "adrp"):
                require(
                    len(operands) == 2 and operands[1].type == ARM64_OP_IMM,
                    "invalid PC-relative address instruction",
                )
                address = operands[1].imm
                # ADRP targets a page, which may start before its first section.
                candidates = [
                    s
                    for s in image.sections
                    if s["size"]
                    and s["address"] < address + 4096
                    and address < s["address"] + s["size"]
                ]
                if mnemonic == "adrp":
                    require(
                        candidates and not any(s["protection"] & 2 for s in candidates),
                        f"unsupported or writable static page at 0x{instruction.address:x}",
                    )
                else:
                    _check_address(image, address, instruction.address)
                _set_register(instruction, operands[0].reg, address, constants)
                static.append(
                    {
                        "instruction": instruction.address,
                        "address": address,
                        "kind": mnemonic,
                    }
                )
            elif (
                mnemonic in ("add", "sub")
                and len(operands) >= 3
                and operands[1].type == ARM64_OP_REG
                and operands[2].type == ARM64_OP_IMM
            ):
                base = _register_value(instruction, operands[1].reg, known)
                if base is not None:
                    value = operands[2].imm << operands[2].shift.value
                    address = base + (value if mnemonic == "add" else -value)
                    _check_address(image, address, instruction.address)
                    _set_register(instruction, operands[0].reg, address, constants)
            elif (
                mnemonic == "mov"
                and len(operands) == 2
                and operands[1].type == ARM64_OP_REG
            ):
                base = _register_value(instruction, operands[1].reg, known)
                if base is not None:
                    _set_register(instruction, operands[0].reg, base, constants)
            elif mnemonic.startswith(("ldr", "ldrsw")):
                for operand in operands[1:2]:
                    if operand.type == ARM64_OP_IMM:
                        section = _check_address(
                            image, operand.imm, instruction.address, memory=True
                        )
                        static.append(
                            {
                                "instruction": instruction.address,
                                "address": operand.imm,
                                "section": section["name"],
                                "kind": "literal-read",
                            }
                        )
            if mnemonic == "bl":
                for register in list(constants):
                    if (
                        register.startswith("x")
                        and register[1:].isdigit()
                        and int(register[1:]) <= 18
                    ):
                        constants.pop(register, None)
            if direct and mnemonic != "bl" or mnemonic == "ret":
                constants.clear()
            records.append(
                {
                    "address": instruction.address,
                    "bytes": bytes(instruction.bytes).hex(),
                    "mnemonic": mnemonic,
                    "operands": instruction.op_str,
                    "function": function["address"],
                }
            )
        if _can_fall_through(function, decoded):
            next_function = functions.get(function["end"])
            require(
                next_function is not None,
                f"function {function['name']} falls through outside verified function starts",
            )
            edges.append(
                {
                    "from": function["end"] - 4,
                    "to": function["end"],
                    "kind": "fallthrough",
                    "function": function["address"],
                }
            )
            if next_function["address"] not in selected:
                selected.add(next_function["address"])
                pending.append(next_function)
    chosen = sorted((functions[a] for a in selected), key=lambda f: f["address"])
    chunks = [
        {
            "kind": "code",
            "address": f["address"],
            "bytes": image.bytes_at(f["address"], f["size"]).hex(),
            "name": f["name"],
        }
        for f in chosen
    ]
    chunks += [
        {
            "kind": "readonly",
            "address": s["address"],
            "bytes": image.bytes_at(s["address"], s["size"]).hex(),
            "name": s["segment"] + "," + s["name"],
        }
        for s in readonly
    ]
    minimum = min(c["address"] for c in chunks)
    maximum = max(c["address"] + len(c["bytes"]) // 2 for c in chunks)
    require(
        maximum - minimum <= MAX_SPAN and maximum <= MAX_SPAN,
        "capsule addresses exceed the runtime portable 16 MiB address range",
    )
    return {
        "schema": 1,
        "architecture": "arm64",
        "artifactSHA256": image.digest,
        "entry": first["address"],
        "chunks": chunks,
        "imports": [
            {"address": address, "name": name}
            for address, name in sorted(imports.items())
        ],
        "extraction": {
            "format": "Mach-O64 dylib",
            "artifactBytes": len(image.blob),
            "imageBase": image.base,
            "root": first["name"],
            "functions": [{**f, "supportStatus": "extracted"} for f in chosen],
            "dependencies": sorted(edges, key=lambda edge: edge["from"]),
            "instructions": sorted(
                records, key=lambda instruction: instruction["address"]
            ),
            "staticReferences": sorted(
                static, key=lambda reference: reference["instruction"]
            ),
            "codeBytes": byte_count,
            "readonlyBytes": sum(s["size"] for s in readonly),
            "dataPolicy": "complete file-backed non-relocated readonly __const and __cstring sections",
            "abi": "caller supplied; not inferred",
            "staticReferencePolicy": "syntactic constants within a basic block; runtime access trace is authoritative",
            "limitations": [
                "direct control flow only",
                "zero preferred image base only",
                "no OS or writable static state",
                "no relocatable static pointer data",
                "runtime checks every logical memory access",
            ],
        },
    }
