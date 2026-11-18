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
    import uuid

    covers = data_dir / "covers"
    thumbs = data_dir / "thumbs"
    thumbs_was_dir = thumbs.is_dir() and not thumbs.is_symlink()
    covers.mkdir(exist_ok=True)
    thumbs.mkdir(exist_ok=True)
    portraits = data_dir / "artist-portraits"
    portraits.mkdir(exist_ok=True)
    suffix = uuid.uuid4().hex
    files = {
        thumbs / f"{710000000 + int(suffix[:4], 16)}-128.avif": b"thumb",
        thumbs / "keep.tmp": b"keep",
        covers / f"{720000000 + int(suffix[4:8], 16)}.original": b"original",
        covers / f"{730000000 + int(suffix[8:12], 16)}.jpg": b"legacy",
        portraits / f"{suffix}.avif": b"portrait",
    }
    thumb_image = next(path for path in files if path.parent == thumbs and path.name.endswith(".avif"))
    thumb_metadata = Path(str(thumb_image) + ".json")
    cover_image = next(path for path in files if path.parent == covers and path.name.endswith(".original"))
    cover_metadata = Path(str(cover_image) + ".json")
    files[thumb_metadata] = b"thumb-meta"
    files[cover_metadata] = b"original-meta"
    for path, value in files.items():
        path.write_bytes(value)
    nested = thumbs / f"{suffix}.avif"
    nested.mkdir()
    nested_file = nested / "1-128.avif"
    nested_file.write_bytes(b"nested keep")
    link = thumbs / f"{suffix}-256.avif"
    try:
        link.symlink_to(files[thumb_image])
    except (OSError, NotImplementedError):
        link = None

    before_music = _music_snapshot(music_dir)
    before_database = _database_snapshot()
    try:
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
        check("非法清理请求无副作用", all(path.exists() for path in files) and (nested_file.exists())
              and (link is None or link.is_symlink()))

        cleared = requests.post(f"{base}/api/storage/clear-cache", json={"scope": "thumbnails"}, timeout=30)
        cleared.raise_for_status()
        result = cleared.json()
        check("清理缩略图只删除受管 AVIF 与元数据", result["complete"] and result["failed_entries"] == 0
              and result["removed_images"] == 1
              and result["removed_metadata"] == 1 and result["removed_files"] == 2
              and result["removed_bytes"] == len(b"thumb") + len(b"thumb-meta")
              and not thumb_image.exists() and not thumb_metadata.exists()
              and files[thumbs / "keep.tmp"] == (thumbs / "keep.tmp").read_bytes()
          and nested_file.exists() and (link is None or link.is_symlink()), str(result))

        cleared = requests.post(f"{base}/api/storage/clear-cache", json={"scope": "originals"}, timeout=30)
        cleared.raise_for_status()
        result = cleared.json()
        check("清理原图含合法legacy jpg和元数据，保留头像缓存", result["complete"] and result["failed_entries"] == 0
              and result["removed_images"] == 2 and result["removed_metadata"] == 1
              and result["removed_files"] == 3 and result["removed_bytes"] == sum(map(len, (b"original", b"original-meta", b"legacy")))
              and not cover_image.exists() and not cover_metadata.exists()
              and files[portraits / f"{suffix}.avif"].exists(), str(result))

        repeat = requests.post(f"{base}/api/storage/clear-cache", json={"scope": "all"}, timeout=30).json()
        check("重复清理幂等且准确保留音乐、数据库与头像", repeat["complete"] and repeat["removed_files"] == 0
              and _music_snapshot(music_dir) == before_music
              and _database_snapshot() == before_database
              and files[portraits / f"{suffix}.avif"].exists(), str(repeat))

        if link is not None:
            check("清理跳过缩略图缓存目录内的符号链接且保留目标", link.is_symlink() and files[thumb_image].exists(), str(link))
        unsafe_thumb = data_dir / "thumbs"
        saved_thumb_directory = unsafe_thumb.with_name(f"thumbs-test-backup-{suffix}")
        unsafe_thumb.rename(saved_thumb_directory)
        try:
            unsafe_thumb.symlink_to(music_dir, target_is_directory=True)
            rejected = requests.post(f"{base}/api/storage/clear-cache", json={"scope": "thumbnails"}, timeout=30)
            check("缓存目录本身是链接时拒绝跟随，并继续报告失败结果", rejected.status_code == 200
                  and rejected.json()["complete"] is False and rejected.json()["failed_entries"] == 1
                  and _music_snapshot(music_dir) == before_music)
        except (OSError, NotImplementedError):
            check("当前平台不允许创建目录符号链接时跳过该测试分支", True)
        finally:
            if unsafe_thumb.is_symlink():
                unsafe_thumb.unlink()
            elif unsafe_thumb.exists():
                unsafe_thumb.rmdir()
            if saved_thumb_directory.exists():
                saved_thumb_directory.rename(unsafe_thumb)
        if unsafe_thumb.is_symlink():
            clear_partial = requests.post(f"{base}/api/storage/clear-cache", json={"scope": "all"}, timeout=30)
            partial = clear_partial.json()
            check("全部清理遇到单个危险目录时继续处理另一目录并报告部分结果",
                  clear_partial.status_code == 200 and partial["complete"] is False
                  and partial["removed_files"] == 3 and partial["failed_entries"] == 1
                  and not cover_image.exists() and _music_snapshot(music_dir) == before_music, str(partial))
    finally:
        if not thumbs_was_dir and thumbs.is_dir() and not thumbs.is_symlink() and not any(thumbs.iterdir()):
            thumbs.rmdir()
        if link is not None and link.is_symlink():
            link.unlink()
        if nested_file.exists():
            nested_file.unlink()
        if nested.exists():
            nested.rmdir()
        for path in files:
            if path.exists() and path.is_file():
                path.unlink()
