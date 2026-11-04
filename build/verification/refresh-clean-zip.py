"""Refresh the existing clean ZIP after dist synchronization, without local data.

This script is intentionally separate from synchronization: run it only after
dist/AvatarPrinter and its build-manifest.json contain the final release files.
The old archive's manifest allowlist is retained, with explicitly approved
collector modules and locked Node runtime packages. Replacement files come from the explicit UI list,
AvatarPrinter.exe, _internal, and the manifest itself. Every other file is
streamed from the old ZIP, never from the installed tree.
"""
from __future__ import annotations

import copy
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import stat
import tempfile
import time
import sys
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
import build_desktop
PACKAGE = ROOT / "dist" / "AvatarPrinter"
ARCHIVE = ROOT / "dist" / "AvatarPrinter-Windows-x64.zip"
CHECKSUM = ARCHIVE.with_suffix(ARCHIVE.suffix + ".sha256")
LOG = ROOT / "build" / "verification" / "zip-latest.json"
UPDATES = ROOT / "build" / "ui-update-files.json"
MANIFEST = "build-manifest.json"
PREFIX = "AvatarPrinter/"
CHUNK_SIZE = 1024 * 1024
EXPECTED_UI_FILES = 41
EXPECTED_INTERNAL_FILES = 97
EXPLICIT_UI_ADDITIONS = frozenset({"app/scene-gift-icons.mjs"})


def approved_additions():
    return EXPLICIT_UI_ADDITIONS | frozenset('app/' + name for name in (
        'lightweight-session.mjs', 'douyin-wire.mjs', 'douyin-events.mjs', 'collector-runtime.mjs',
        *build_desktop.collector_resources()))


def require(condition, message):
    if not condition:
        raise ValueError(message)


def clean_relative(name):
    require(isinstance(name, str) and bool(name), "Invalid package path")
    path = PurePosixPath(name)
    require(not path.is_absolute() and path.as_posix() == name
            and "\\" not in name and ":" not in name and "\x00" not in name
            and not any(part in ("", ".", "..") for part in name.split("/")),
            f"Unsafe package path: {name!r}")
    parts = tuple(part.casefold() for part in path.parts)
    forbidden_dirs = {"__pycache__", "tests", "test", "logs", "log", "profiles", "profile", "ebwebview"}
    require(not any(part in forbidden_dirs or "profile" in part or part.endswith(".webview2")
                    for part in parts[:-1]), f"Local/developer directory is forbidden: {name}")
    basename = parts[-1]
    require(not (basename.endswith((".log", ".pyc", ".pyo", ".tmp", ".dmp", ".test.mjs"))
                 or basename.startswith(("test_", ".collector-auth"))
                 or basename.replace("-", "").replace("_", "").startswith("pyspy")),
            f"Local/developer file is forbidden: {name}")
    return name


def manifest_files(manifest):
    require(isinstance(manifest, dict) and manifest.get("application") == "AvatarPrinter",
            "Unexpected application manifest")
    files = manifest.get("files")
    require(isinstance(files, dict) and bool(files), "Manifest has no file allowlist")
    for name, digest in files.items():
        clean_relative(name)
        require(name != MANIFEST, "Manifest must not hash itself")
        require(isinstance(digest, str) and len(digest) == 64
                and all(character in "0123456789abcdef" for character in digest),
                f"Invalid manifest digest: {name}")
    return files


def allowlist_additions(old_files, current_files, updates):
    old_names, current_names = set(old_files), set(current_files)
    require(not old_names - current_names, "Existing clean package files cannot be removed")
    additions = current_names - old_names
    require(additions <= approved_additions(), "Unapproved additions to the clean package allowlist")
    require(EXPLICIT_UI_ADDITIONS <= set(updates), "Explicit UI module is missing from the update list")
    require(additions <= set(updates), "New package entries must be explicit UI updates")
    return additions


def digest_stream(source, destination=None):
    digest = hashlib.sha256()
    size = 0
    while block := source.read(CHUNK_SIZE):
        digest.update(block)
        size += len(block)
        if destination is not None:
            destination.write(block)
    return digest.hexdigest(), size


def file_digest(path):
    with path.open("rb") as source:
        return digest_stream(source)[0]


def source_file(relative):
    clean_relative(relative)
    path = PACKAGE / relative
    require(path.is_file() and not path.is_symlink(), f"Missing/linked dist replacement: {relative}")
    require(path.resolve().is_relative_to(PACKAGE.resolve()), f"Replacement escapes package: {relative}")
    return path


def signature(path):
    value = path.stat()
    return value.st_size, value.st_mtime_ns, value.st_ino


def temporary_path(parent, suffix):
    with tempfile.NamedTemporaryFile(prefix=".AvatarPrinter-refresh-", suffix=suffix,
                                     dir=parent, delete=False) as temporary:
        return Path(temporary.name)


def write_json_atomic(path, value):
    temporary = temporary_path(path.parent, ".json")
    try:
        temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def refresh(report):
    require(ARCHIVE.is_file(), f"Clean source ZIP is missing: {ARCHIVE}")
    original_signature = signature(ARCHIVE)
    report["previousZipSha256"] = file_digest(ARCHIVE)
    require(CHECKSUM.is_file(), f"Source ZIP checksum is missing: {CHECKSUM}")
    recorded_checksum = CHECKSUM.read_text(encoding="utf-8").split()[0]
    require(recorded_checksum == report["previousZipSha256"], "Old ZIP does not match its checksum")

    manifest_bytes = source_file(MANIFEST).read_bytes()
    current_manifest = json.loads(manifest_bytes)
    current_files = manifest_files(current_manifest)
    expected_hashes = {**current_files, MANIFEST: hashlib.sha256(manifest_bytes).hexdigest()}
    updates = json.loads(UPDATES.read_text(encoding="utf-8"))
    require(isinstance(updates, list) and len(updates) == EXPECTED_UI_FILES
            and len(set(updates)) == len(updates), f"Expected {EXPECTED_UI_FILES} unique UI replacements")
    for name in updates:
        clean_relative(name)
        require(name.startswith("app/"), f"Unexpected UI replacement path: {name}")
    updates += ['app/' + name for name in build_desktop.collector_resources()]
    require(len(updates) == len(set(updates)), 'Duplicate production resource')

    internal = sorted(path.relative_to(PACKAGE).as_posix()
                      for path in (PACKAGE / "_internal").rglob("*") if path.is_file())
    require(len(internal) == EXPECTED_INTERNAL_FILES, f"Expected 97 _internal files, found {len(internal)}")
    require(set(internal) == {name for name in current_files if name.startswith("_internal/")},
            "Dist _internal files and manifest allowlist differ")
    replacements = set(updates) | {"AvatarPrinter.exe", MANIFEST} | set(internal)
    for name in replacements:
        source_file(name)
        require(name in expected_hashes, f"Replacement missing from manifest: {name}")

    staging_zip = temporary_path(ARCHIVE.parent, ".zip")
    staging_checksum = None
    try:
        with ZipFile(ARCHIVE, "r") as old, ZipFile(staging_zip, "w", ZIP_DEFLATED, compresslevel=6) as new:
            infos = old.infolist()
            names = [info.filename for info in infos]
            require(len(names) == len(set(names)), "Old ZIP has duplicate entries")
            require(len(names) == len({name.casefold() for name in names}), "Old ZIP has case-colliding entries")
            old_manifest = json.loads(old.read(PREFIX + MANIFEST))
            old_files = manifest_files(old_manifest)
            additions = allowlist_additions(old_files, current_files, updates)
            old_expected_names = {PREFIX + name for name in (*old_files, MANIFEST)}
            require(set(names) == old_expected_names, "Old ZIP entries differ from its clean manifest allowlist")
            expected_names = {PREFIX + name for name in expected_hashes}
            require(len(expected_names) == len({name.casefold() for name in expected_names}),
                    "New allowlist has case-colliding entries")
            require(replacements <= set(expected_hashes), "Replacement is outside the clean allowlist")

            total_bytes = 0
            preserved = 0
            for info in infos:
                relative = clean_relative(info.filename.removeprefix(PREFIX))
                require(info.filename == PREFIX + relative and not info.is_dir(), "Unexpected ZIP root or directory")
                require(not info.flag_bits & 1, f"Encrypted ZIP entry: {relative}")
                require(stat.S_IFMT(info.external_attr >> 16) != stat.S_IFLNK, f"Linked ZIP entry: {relative}")
                output_info = copy.copy(info)
                if relative in replacements:
                    path = source_file(relative)
                    output_info.date_time = tuple(time.localtime(path.stat().st_mtime)[:6])
                    output_info.file_size = path.stat().st_size
                    source_context = path.open("rb")
                else:
                    source_context = old.open(info, "r")
                    preserved += 1
                with source_context as source, new.open(output_info, "w", force_zip64=output_info.file_size >= 2**31) as target:
                    digest, size = digest_stream(source, target)
                require(digest == expected_hashes[relative], f"Source/manifest hash mismatch: {relative}")
                total_bytes += size

            # Only approved modules and the three pinned source-side Node
            # packages may extend the archive. Installed profiles supply no names.
            for relative in sorted(additions):
                path = source_file(relative)
                output_info = ZipInfo.from_file(path, arcname=PREFIX + relative)
                output_info.compress_type = ZIP_DEFLATED
                with path.open("rb") as source, new.open(output_info, "w", force_zip64=output_info.file_size >= 2**31) as target:
                    digest, size = digest_stream(source, target)
                require(digest == expected_hashes[relative], f"New UI/manifest hash mismatch: {relative}")
                total_bytes += size

        verified_count = 0
        with ZipFile(staging_zip, "r") as final:
            require(set(final.namelist()) == expected_names and len(final.infolist()) == len(expected_names),
                    "New ZIP allowlist mismatch")
            require(final.read(PREFIX + MANIFEST) == manifest_bytes, "ZIP manifest differs from dist")
            for info in final.infolist():
                # Reading every stream to EOF validates ZipExtFile's CRC, while
                # hashing the decompressed bytes validates every manifest item.
                with final.open(info, "r") as source:
                    digest, size = digest_stream(source)
                relative = info.filename.removeprefix(PREFIX)
                require(size == info.file_size, f"ZIP size mismatch: {relative}")
                require(digest == expected_hashes[relative], f"ZIP/manifest hash mismatch: {relative}")
                verified_count += 1

        require(source_file(MANIFEST).read_bytes() == manifest_bytes, "Dist manifest changed during refresh")
        require(signature(ARCHIVE) == original_signature, "Source ZIP changed during refresh")
        archive_hash = file_digest(staging_zip)
        staging_checksum = temporary_path(CHECKSUM.parent, ".sha256")
        staging_checksum.write_text(f"{archive_hash}  {ARCHIVE.name}\n", encoding="utf-8")
        report.update(entries=verified_count, manifestFiles=len(current_files), uiReplacements=len(updates),
                      internalReplacements=len(internal), replacedEntries=len(replacements - additions),
                      previousEntries=len(names), addedEntries=len(additions), allowlistAdditions=sorted(additions),
                      preservedEntries=preserved, uncompressedBytes=total_bytes,
                      crcVerifiedEntries=verified_count, manifestHashesVerified=len(current_files),
                      manifestBytesVerified=True, zipBytes=staging_zip.stat().st_size,
                      zipSha256=archive_hash, cleanAllowlistPreserved=True)
        # No output package is replaced until the staged archive fully passes.
        os.replace(staging_zip, ARCHIVE)
        report["zipPublished"] = True
        os.replace(staging_checksum, CHECKSUM)
        report["checksumPublished"] = True
    finally:
        staging_zip.unlink(missing_ok=True)
        if staging_checksum is not None:
            staging_checksum.unlink(missing_ok=True)


def main():
    report = {"startedAt": datetime.now(timezone.utc).isoformat(), "status": "pending",
              "archive": str(ARCHIVE), "checksum": str(CHECKSUM), "log": str(LOG),
              "zipPublished": False, "checksumPublished": False}
    try:
        refresh(report)
        report["status"] = "passed"
    except Exception as error:
        report.update(status="failed", errorType=type(error).__name__, error=str(error))
    report["finishedAt"] = datetime.now(timezone.utc).isoformat()
    write_json_atomic(LOG, report)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
