"""Check authenticated storage reports, exact cache counts and probe cleanup."""
import hashlib
from pathlib import Path

import requests

from tests.collections_acceptance import _database_snapshot


def _music_snapshot(root: Path) -> dict[str, tuple[str, int]]:
    result = {}
    for path in root.rglob("*"):
        if path.is_file():
            stat = path.stat()
            result[path.relative_to(root).as_posix()] = (hashlib.sha256(path.read_bytes()).hexdigest(), stat.st_mtime_ns)
    return result


def check_storage(base, data_dir: Path, music_dir: Path, check) -> None:
    response = requests.get(f"{base}/api/storage", timeout=30)
    response.raise_for_status()
    report = response.json()
    check("存储诊断准确标明 PostgreSQL 与缓存用途",
          report["database"]["engine"] == "PostgreSQL" and report["database"]["connected"]
          and "应用设置" in report["database"]["stores"]
          and report["cache"]["format"] == "AVIF" and report["cache"]["on_demand"]
          and Path(report["music"]["path"]) == music_dir,
          "无虚构 SQLite 配置文件路径")
    check("只读存储诊断不创建缓存目录",
          not (data_dir / "covers").exists() and not (data_dir / "thumbs").exists()
          and report["write_checks"] is None,
          "首次读取保持空数据目录")
    wire = response.text.lower()
    check("存储诊断不回显连接串或登录密钥",
          all(value not in wire for value in ("postgres://", "postgresql://", "redis://", "database_url", "password")))

    probe = requests.post(f"{base}/api/storage/check", timeout=30)
    probe.raise_for_status()
    checked = probe.json()
    check("显式写权限检测覆盖数据根及两类缓存",
          len(checked["write_checks"]) == 3 and all(item["state"] == "ok" for item in checked["write_checks"]))
    check("写权限检测清理所有临时文件", not list(data_dir.rglob(".metatidy-probe-*")))

    # A path occupied by a regular file is a reliable permission/setup failure
    # fixture, including when CI itself runs as root.
    thumbs = data_dir / "thumbs"
    thumbs.rmdir()
    thumbs.write_bytes(b"keep existing data")
    try:
        failed = requests.post(f"{base}/api/storage/check", timeout=30).json()
        result = next(item for item in failed["write_checks"] if Path(item["path"]) == thumbs)
        check("缓存目录不可写时给出失败原因并保留原文件",
              result["state"] == "error" and bool(result["error"])
              and thumbs.read_bytes() == b"keep existing data")
    finally:
        thumbs.unlink()
        thumbs.mkdir()


def check_cache_totals(base, data_dir: Path, check) -> None:
    report = requests.get(f"{base}/api/storage", timeout=30).json()
    for name, directory in (("originals", "covers"), ("thumbnails", "thumbs")):
        images = [path for path in (data_dir / directory).iterdir()
                  if path.is_file() and path.suffix in {".avif", ".original", ".jpg", ".jpeg", ".png", ".webp", ".gif"}]
        stats = report["cache"][name]
        check(f"缓存统计与磁盘一致：{directory}",
              stats["files"] == len(images) and stats["bytes"] == sum(path.stat().st_size for path in images)
              and not stats["truncated"] and not stats["error"],
              f"{stats['files']} images, {stats['bytes']} bytes; JSON不计入图片数")


def check_cache_clear(base, data_dir: Path, music_dir: Path, check) -> None:
    """Exercise the explicit cache cleanup boundary without touching music or DB."""
    import os
    import uuid

    covers = data_dir / "covers"
    thumbs = data_dir / "thumbs"
    portraits = data_dir / "artist-portraits"
    suffix = uuid.uuid4().hex
    identifier = int(suffix[:15], 16) + 1  # Positive i64, separate from real track IDs.
    thumb_image = thumbs / f"{identifier}-128.avif"
    thumb_metadata = Path(str(thumb_image) + ".json")
    cover_image = covers / f"{identifier + 1}.original"
    cover_metadata = Path(str(cover_image) + ".json")
    legacy_image = covers / f"{identifier + 2}.jpg"
    keep_file = thumbs / f"keep-{suffix}.tmp"
    portrait = portraits / f"{suffix}.avif"
    protected_target = data_dir / f"clear-cache-protected-{suffix}.bin"
    # These names would be eligible for deletion if they were regular files.
    nested = thumbs / f"{identifier + 3}-512.avif"
    nested_file = nested / "1-128.avif"
    link = thumbs / f"{identifier + 4}-256.avif"
    files = {
        thumb_image: b"thumb",
        thumb_metadata: b"thumb-meta",
        cover_image: b"original",
        cover_metadata: b"original-meta",
        legacy_image: b"legacy",
        keep_file: b"keep",
        portrait: b"portrait",
        protected_target: b"symlink target must survive",
        nested_file: b"nested keep",
    }
    originals = (cover_image, cover_metadata, legacy_image)
    protected = (keep_file, portrait, protected_target, nested_file)
    created_files = []
    created_directories = []
    file_link_created = False

    def unchanged(paths) -> bool:
        return all(path.is_file() and path.read_bytes() == files[path] for path in paths)

    def seed_file(path: Path) -> None:
        # Never overwrite a pre-existing file, even if the random ID collides.
        with path.open("xb") as stream:
            created_files.append(path)
            stream.write(files[path])

    def create_link(path: Path, target: Path, *, directory: bool = False) -> bool:
        try:
            path.symlink_to(target.resolve(), target_is_directory=directory)
            return True
        except (OSError, NotImplementedError) as error:
            # Linux CI must exercise this branch. Only Windows installations
            # without link privileges/support may skip it; other errors fail.
            if os.name == "nt" and (isinstance(error, NotImplementedError)
                                    or getattr(error, "winerror", None) in (50, 1314)):
                check("当前 Windows 不允许创建符号链接，跳过对应链接检查", True, str(error))
                return False
            raise

    before_music = _music_snapshot(music_dir)
    before_database = _database_snapshot()
    try:
        for directory in (covers, thumbs, portraits):
            if not directory.exists():
                directory.mkdir()
                created_directories.append(directory)
            if not directory.is_dir() or directory.is_symlink():
                raise AssertionError(f"验收缓存目录必须是普通目录：{directory}")
        nested.mkdir()
        created_directories.append(nested)
        for path in files:
            seed_file(path)
        file_link_created = create_link(link, protected_target)

        requests_to_check = [
            ({"scope": "all", "path": "/tmp"}, 400),
            ({"scope": "all", "future": True}, 400),
            ({"scope": "other"}, 400),
            ({"scope": None}, 400),
            ({}, 400),
        ]
        invalid_statuses = [requests.post(f"{base}/api/storage/clear-cache", json=body, timeout=30).status_code
                            for body, _ in requests_to_check]
        check("缓存清理严格校验 scope 并拒绝路径、未知键和错误类型", invalid_statuses == [code for _, code in requests_to_check], str(invalid_statuses))
        check("非法清理请求无副作用", unchanged(files)
              and (not file_link_created or link.is_symlink()))

        cleared = requests.post(f"{base}/api/storage/clear-cache", json={"scope": "thumbnails"}, timeout=30)
        cleared.raise_for_status()
        result = cleared.json()
        check("清理缩略图只删除受管 AVIF 与元数据", result["complete"] and result["failed_entries"] == 0
              and result["removed_images"] == 1
              and result["removed_metadata"] == 1 and result["removed_files"] == 2
              and result["removed_bytes"] == len(b"thumb") + len(b"thumb-meta")
              and not thumb_image.exists() and not thumb_metadata.exists()
              and unchanged((*originals, *protected))
              and (not file_link_created or link.is_symlink()), str(result))

        cleared = requests.post(f"{base}/api/storage/clear-cache", json={"scope": "originals"}, timeout=30)
        cleared.raise_for_status()
        result = cleared.json()
        check("清理原图含合法legacy jpg和元数据，保留头像缓存", result["complete"] and result["failed_entries"] == 0
              and result["removed_images"] == 2 and result["removed_metadata"] == 1
              and result["removed_files"] == 3 and result["removed_bytes"] == sum(map(len, (b"original", b"original-meta", b"legacy")))
              and all(not path.exists() for path in originals)
              and unchanged(protected), str(result))

        cleared = requests.post(f"{base}/api/storage/clear-cache", json={"scope": "all"}, timeout=30)
        cleared.raise_for_status()
        repeat = cleared.json()
        check("重复清理幂等且准确保留音乐、数据库与头像", repeat["complete"] and repeat["removed_files"] == 0
              and _music_snapshot(music_dir) == before_music
              and _database_snapshot() == before_database
              and unchanged(protected), str(repeat))

        if file_link_created:
            check("清理跳过受管名称的文件符号链接且保留目标",
                  link.is_symlink() and link.resolve() == protected_target.resolve()
                  and unchanged((protected_target,)), str(link))
        check("清理不递归进入受管名称的子目录", unchanged((nested_file,)))

        saved_thumb_directory = thumbs.with_name(f"thumbs-test-backup-{suffix}")
        thumbs.rename(saved_thumb_directory)
        try:
            if create_link(thumbs, music_dir, directory=True):
                rejected = requests.post(f"{base}/api/storage/clear-cache", json={"scope": "thumbnails"}, timeout=30)
                result = rejected.json()
                check("缓存目录本身是链接时拒绝跟随，并继续报告失败结果", rejected.status_code == 200
                      and result["complete"] is False and result["failed_entries"] == 1
                      and result["removed_files"] == 0
                      and _music_snapshot(music_dir) == before_music, str(result))

                # Re-seed originals that the earlier originals-only call removed.
                # The unsafe thumbs link must remain active for the all-scope call.
                for path in originals:
                    seed_file(path)
                clear_partial = requests.post(f"{base}/api/storage/clear-cache", json={"scope": "all"}, timeout=30)
                partial = clear_partial.json()
                check("全部清理遇到单个危险目录时继续处理另一目录并报告部分结果",
                      clear_partial.status_code == 200 and partial["complete"] is False
                      and partial["removed_files"] == 3 and partial["removed_images"] == 2
                      and partial["removed_metadata"] == 1 and partial["failed_entries"] == 1
                      and partial["removed_bytes"] == sum(len(files[path]) for path in originals)
                      and all(not path.exists() for path in originals)
                      and _music_snapshot(music_dir) == before_music
                      and _database_snapshot() == before_database
                      and unchanged((portrait, protected_target)), str(partial))
        finally:
            if thumbs.is_symlink():
                thumbs.unlink()
            if saved_thumb_directory.exists():
                # Do not erase an unexpected replacement to restore the fixture.
                # rename fails visibly and leaves the backup available to inspect.
                saved_thumb_directory.rename(thumbs)
        check("清理完成后音乐、数据库及所有保护文件保持原样",
              _music_snapshot(music_dir) == before_music
              and _database_snapshot() == before_database and unchanged(protected)
              and (not file_link_created or link.is_symlink()))
    finally:
        if file_link_created and link.is_symlink():
            link.unlink()
        for path in reversed(created_files):
            if path.is_symlink() or path.is_file():
                path.unlink()
        for directory in reversed(created_directories):
            if directory.is_dir() and not directory.is_symlink() and not any(directory.iterdir()):
                directory.rmdir()
