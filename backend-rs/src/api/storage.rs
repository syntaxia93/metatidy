//! On-demand storage diagnostics and explicit, bounded image-cache cleanup.
//! Never expose connection strings or accept a client-supplied filesystem path.

use std::fs;
use std::io::Write;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::extract::State;
use axum::Json;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::Semaphore;

use crate::AppState;

use super::ApiResult;

const MAX_ENTRIES: usize = 50_000;
const STATS_BUDGET: Duration = Duration::from_secs(2);
const CLEAR_BUDGET: Duration = Duration::from_secs(10);
const MAX_CLEAR_REQUEST_BYTES: usize = 256;
const MAX_REPORTED_ERRORS: usize = 20;
static WORKER: Lazy<Arc<Semaphore>> = Lazy::new(|| Arc::new(Semaphore::new(1)));

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum CacheScope {
    Thumbnails,
    Originals,
    All,
}

impl CacheScope {
    fn label(self) -> &'static str {
        match self {
            Self::Thumbnails => "thumbnails",
            Self::Originals => "originals",
            Self::All => "all",
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ClearCacheRequest {
    scope: CacheScope,
}

#[derive(Debug, Serialize)]
struct ClearCacheError {
    path: String,
    message: String,
}

#[derive(Debug, Serialize)]
struct ClearCacheReport {
    scope: &'static str,
    finished_at: f64,
    complete: bool,
    removed_files: u64,
    removed_images: u64,
    removed_metadata: u64,
    removed_bytes: u64,
    skipped_entries: u64,
    failed_entries: u64,
    errors: Vec<ClearCacheError>,
    truncated: bool,
}

#[derive(Debug, Serialize)]
struct CacheStats {
    path: String,
    exists: bool,
    files: u64,
    bytes: u64,
    truncated: bool,
    error: String,
}

fn cache_stats(path: &Path, deadline: Instant, limit: usize) -> CacheStats {
    let mut stats = CacheStats {
        path: path.to_string_lossy().into_owned(),
        exists: false,
        files: 0,
        bytes: 0,
        truncated: false,
        error: String::new(),
    };
    let entries = match fs::read_dir(path) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return stats,
        Err(error) => {
            stats.error = error.to_string();
            return stats;
        }
    };
    stats.exists = true;
    // Cache files are flat; do not traverse audio storage or follow symlinks.
    // The budget bounds enumeration, not the duration of an individual OS call.
    for (index, entry) in entries.enumerate() {
        if index >= limit || Instant::now() >= deadline {
            stats.truncated = true;
            break;
        }
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                stats.error = error.to_string();
                stats.truncated = true;
                continue;
            }
        };
        let path = entry.path();
        let extension = path.extension().and_then(|ext| ext.to_str()).unwrap_or("");
        if !matches!(
            extension,
            "avif" | "original" | "jpg" | "jpeg" | "png" | "webp" | "gif"
        ) {
            continue;
        }
        match fs::symlink_metadata(path) {
            Ok(meta) if meta.is_file() => {
                stats.files += 1;
                stats.bytes = stats.bytes.saturating_add(meta.len());
            }
            Ok(_) => {}
            Err(error) => {
                stats.error = error.to_string();
                stats.truncated = true;
            }
        }
    }
    stats
}

#[derive(Debug, Serialize)]
struct WriteCheck {
    path: String,
    state: &'static str,
    error: String,
}

fn check_write(path: &Path) -> WriteCheck {
    let probe = path.join(format!(".metatidy-probe-{}", uuid::Uuid::new_v4().simple()));
    let mut created = false;
    let result = (|| -> std::io::Result<()> {
        fs::create_dir_all(path)?;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&probe)?;
        created = true;
        file.write_all(b"1")?;
        file.sync_all()?;
        Ok(())
    })();
    // Cleanup is attempted even when the write failed (e.g. disk full).
    let cleanup = if created {
        fs::remove_file(&probe)
    } else {
        Ok(())
    };
    let error = match (result, cleanup) {
        (Ok(()), Ok(())) => String::new(),
        (Err(error), Ok(())) => error.to_string(),
        (Ok(()), Err(error)) => format!("测试文件清理失败：{error}"),
        (Err(write), Err(cleanup)) => format!("写入失败：{write}；测试文件清理失败：{cleanup}"),
    };
    WriteCheck {
        path: path.to_string_lossy().into_owned(),
        state: if error.is_empty() { "ok" } else { "error" },
        error,
    }
}

pub async fn info(State(state): State<AppState>) -> ApiResult {
    inspect(state, false).await
}

pub async fn check(State(state): State<AppState>) -> ApiResult {
    inspect(state, true).await
}

/// Delete only recognized cache files from their exact configured directories.
/// No client-supplied paths are accepted, and directory entries are never followed.
pub async fn clear_cache(State(state): State<AppState>, body: Bytes) -> ApiResult {
    if body.len() > MAX_CLEAR_REQUEST_BYTES {
        return Err(super::ApiError::bad_request("缓存清理请求过大"));
    }
    let request: ClearCacheRequest = serde_json::from_slice(&body)
        .map_err(|error| super::ApiError::bad_request(format!("请求参数不正确：{error}")))?;
    let worker = WORKER.clone().acquire_owned().await.map_err(anyhow::Error::from)?;
    let guard = crate::cover_cache::cache_write_guard().await;
    let config = state.config;
    let report = tokio::task::spawn_blocking(move || {
        let _guard = guard;
        let _worker = worker;
        clear_cache_blocking(&config, request.scope)
    })
    .await
    .map_err(anyhow::Error::from)?;
    Ok(Json(serde_json::to_value(report).map_err(anyhow::Error::from)?))
}

async fn inspect(state: AppState, write_probe: bool) -> ApiResult {
    let connected = matches!(
        tokio::time::timeout(
            Duration::from_secs(3),
            sqlx::query_scalar::<_, i32>("SELECT 1").fetch_one(&state.db)
        )
        .await,
        Ok(Ok(1))
    );
    let worker = WORKER
        .clone()
        .acquire_owned()
        .await
        .map_err(anyhow::Error::from)?;
    // Keep cache observation and write probes out of the cleanup critical section.
    // Acquire the worker before the read lock, matching cleanup's worker→write order.
    let cache_guard = crate::cover_cache::cache_read_guard().await;
    let config = state.config;
    let report = tokio::task::spawn_blocking(move || {
        let _cache_guard = cache_guard;
        let _worker = worker;
        let covers = config.cover_cache_dir();
        let thumbs = config.thumb_cache_dir();
        let write_checks = write_probe.then(|| {
            [&config.data_dir, &covers, &thumbs]
                .into_iter()
                .map(|path| check_write(path))
                .collect::<Vec<_>>()
        });
        let music_exists = config.music_dir.is_dir();
        let deadline = Instant::now() + STATS_BUDGET;
        json!({
            "checked_at": chrono::Utc::now().timestamp(),
            "database": {
                "engine": "PostgreSQL", "connected": connected,
                "stores": ["曲库索引", "应用设置", "别名", "任务记录"],
            },
            "music": { "path": config.music_dir, "exists": music_exists },
            "cache": {
                "root": config.data_dir, "format": "AVIF", "on_demand": true,
                "originals": cache_stats(&covers, deadline, MAX_ENTRIES),
                "thumbnails": cache_stats(&thumbs, deadline, MAX_ENTRIES),
            },
            "runtime": { "container": Path::new("/.dockerenv").exists() },
            "write_checks": write_checks,
        })
    })
    .await
    .map_err(anyhow::Error::from)?;
    Ok(Json(report))
}

enum CacheTargetState {
    Missing,
    Directory,
}

fn is_symlink_or_reparse(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        return metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0;
    }
    #[cfg(not(windows))]
    false
}

fn canonical_if_present(path: &Path) -> Result<Option<std::path::PathBuf>, String> {
    match fs::canonicalize(path) {
        Ok(path) => Ok(Some(path)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("无法验证目录 {}：{error}", path.display())),
    }
}

/// Only the two literal children of the configured data root may be cleared.
/// Reject a cache target within, or containing, the configured music tree.
fn validate_cache_target(
    data_root: &Path,
    target: &Path,
    expected_name: &str,
    music_dir: &Path,
) -> Result<CacheTargetState, String> {
    let root = match canonical_if_present(data_root)? {
        Some(root) => root,
        None => return Ok(CacheTargetState::Missing),
    };
    let root_metadata = fs::symlink_metadata(data_root)
        .map_err(|error| format!("无法验证数据目录 {}：{error}", data_root.display()))?;
    if !root_metadata.is_dir() || is_symlink_or_reparse(&root_metadata) {
        return Err("配置的数据目录不是普通目录".into());
    }

    let name = target
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "缓存目录名称无效".to_string())?;
    if name != expected_name || target.parent() != Some(data_root) {
        return Err("缓存目录不匹配受管理的数据目录".into());
    }
    let parent = canonical_if_present(target.parent().expect("parent checked"))?
        .ok_or_else(|| "缓存目录的父目录不存在".to_string())?;
    if parent != root {
        return Err("缓存目录不在配置的数据目录内".into());
    }

    let metadata = match fs::symlink_metadata(target) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(CacheTargetState::Missing)
        }
        Err(error) => return Err(format!("无法验证缓存目录 {}：{error}", target.display())),
    };
    if !metadata.is_dir() || is_symlink_or_reparse(&metadata) {
        return Err(format!("缓存目标 {} 不是普通目录", target.display()));
    }
    let resolved_target = fs::canonicalize(target)
        .map_err(|error| format!("无法验证缓存目录 {}：{error}", target.display()))?;
    if resolved_target != root.join(expected_name) {
        return Err("缓存目标解析到预期目录之外".into());
    }
    if let Some(music) = canonical_if_present(music_dir)? {
        if resolved_target.starts_with(&music) || music.starts_with(&resolved_target) {
            return Err("缓存目标与音乐目录重叠，已拒绝清理".into());
        }
    }
    let absolute_target = std::path::absolute(target)
        .map_err(|error| format!("无法验证缓存目录 {}：{error}", target.display()))?;
    let absolute_music = std::path::absolute(music_dir)
        .map_err(|error| format!("无法验证音乐目录 {}：{error}", music_dir.display()))?;
    if absolute_target.starts_with(&absolute_music) || absolute_music.starts_with(&absolute_target) {
        return Err("缓存目标与配置的音乐目录重叠，已拒绝清理".into());
    }
    Ok(CacheTargetState::Directory)
}

fn positive_decimal_id(value: &str) -> bool {
    !value.is_empty()
        && value.bytes().all(|byte| byte.is_ascii_digit())
        && value.parse::<i64>().is_ok_and(|id| id > 0)
        && !value.starts_with('0')
}

fn recognized_cache_file(name: &str, thumbnails: bool) -> Option<bool> {
    let sidecar_suffix = if thumbnails { ".avif.json" } else { ".original.json" };
    if let Some(stem) = name.strip_suffix(sidecar_suffix) {
        let id_and_edge = if thumbnails { stem.split_once('-') } else { None };
        let valid = if thumbnails {
            id_and_edge.is_some_and(|(id, edge)| {
                positive_decimal_id(id) && matches!(edge, "128" | "256" | "512")
            })
        } else {
            positive_decimal_id(stem)
        };
        return valid.then_some(true);
    }

    if let Some(stem) = name.strip_suffix(".jpg") {
        return positive_decimal_id(stem).then_some(false);
    }
    if thumbnails {
        let Some(stem) = name.strip_suffix(".avif") else {
            return None;
        };
        let Some((id, edge)) = stem.split_once('-') else {
            return None;
        };
        (positive_decimal_id(id) && matches!(edge, "128" | "256" | "512")).then_some(false)
    } else {
        name.strip_suffix(".original")
            .filter(|id| positive_decimal_id(id))
            .map(|_| false)
    }
}

fn clear_cache_directory(
    directory: &Path,
    thumbnails: bool,
    deadline: Instant,
    budget: &mut usize,
    report: &mut ClearCacheReport,
) {
    if *budget == 0 || Instant::now() >= deadline {
        report.truncated = true;
        return;
    }
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
        Err(error) => {
            record_clear_error(report, directory, error.to_string());
            return;
        }
    };
    for entry in entries {
        if *budget == 0 || Instant::now() >= deadline {
            report.truncated = true;
            break;
        }
        *budget -= 1;
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                record_clear_error(report, directory, error.to_string());
                continue;
            }
        };
        let path = entry.path();
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            report.skipped_entries = report.skipped_entries.saturating_add(1);
            continue;
        };
        let Some(sidecar) = recognized_cache_file(&name, thumbnails) else {
            report.skipped_entries = report.skipped_entries.saturating_add(1);
            continue;
        };
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) => {
                record_clear_error(report, &path, error.to_string());
                continue;
            }
        };
        if !metadata.is_file() || is_symlink_or_reparse(&metadata) {
            report.skipped_entries = report.skipped_entries.saturating_add(1);
            continue;
        }
        match fs::remove_file(&path) {
            Ok(()) => {
                report.removed_files = report.removed_files.saturating_add(1);
                report.removed_bytes = report.removed_bytes.saturating_add(metadata.len());
                if sidecar {
                    report.removed_metadata = report.removed_metadata.saturating_add(1);
                } else {
                    report.removed_images = report.removed_images.saturating_add(1);
                }
            }
            Err(error) => {
                record_clear_error(report, &path, error.to_string());
            }
        }
    }
}

fn record_clear_error(report: &mut ClearCacheReport, path: &Path, message: String) {
    report.failed_entries = report.failed_entries.saturating_add(1);
    if report.errors.len() < MAX_REPORTED_ERRORS {
        report.errors.push(ClearCacheError {
            path: path.to_string_lossy().into_owned(),
            message,
        });
    } else {
        report.truncated = true;
    }
}

fn clear_cache_blocking(
    config: &crate::config::Config,
    scope: CacheScope,
) -> ClearCacheReport {
    clear_cache_paths(&config.data_dir, &config.music_dir, scope, MAX_ENTRIES, CLEAR_BUDGET)
}

fn clear_cache_paths(
    data_root: &Path,
    music_dir: &Path,
    scope: CacheScope,
    limit: usize,
    duration: Duration,
) -> ClearCacheReport {
    // Own the paths so the blocking task never borrows configuration temporaries.
    let targets: Vec<(std::path::PathBuf, &str, bool)> = match scope {
        CacheScope::Thumbnails => vec![(data_root.join("thumbs"), "thumbs", true)],
        CacheScope::Originals => vec![(data_root.join("covers"), "covers", false)],
        CacheScope::All => vec![
            (data_root.join("thumbs"), "thumbs", true),
            (data_root.join("covers"), "covers", false),
        ],
    };
    let mut report = ClearCacheReport {
        scope: scope.label(),
        finished_at: 0.0,
        complete: false,
        removed_files: 0,
        removed_images: 0,
        removed_metadata: 0,
        removed_bytes: 0,
        skipped_entries: 0,
        failed_entries: 0,
        errors: Vec::new(),
        truncated: false,
    };
    let deadline = Instant::now() + duration;
    let mut remaining = limit;
    for (target, name, thumbnails) in targets {
        match validate_cache_target(data_root, &target, name, music_dir) {
            Ok(CacheTargetState::Missing) => continue,
            Ok(CacheTargetState::Directory) => {
                clear_cache_directory(&target, thumbnails, deadline, &mut remaining, &mut report);
            }
            Err(message) => record_clear_error(&mut report, &target, message),
        }
        if remaining == 0 || Instant::now() >= deadline {
            report.truncated = true;
            break;
        }
    }
    report.finished_at = chrono::Utc::now().timestamp_millis() as f64 / 1000.0;
    report.complete = report.failed_entries == 0 && !report.truncated;
    report
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stats_are_read_only_and_count_only_flat_cache_images() {
        let root = std::env::temp_dir().join(format!("metatidy-storage-{}", uuid::Uuid::new_v4()));
        let missing = cache_stats(&root, Instant::now() + STATS_BUDGET, MAX_ENTRIES);
        assert!(!missing.exists);
        assert!(!root.exists());
        fs::create_dir(&root).unwrap();
        fs::write(root.join("1-128.avif"), b"avif bytes").unwrap();
        fs::write(root.join("1-128.avif.json"), b"sidecar").unwrap();
        fs::write(root.join("unfinished.tmp"), b"partial").unwrap();
        fs::create_dir(root.join("nested.avif")).unwrap();
        let stats = cache_stats(&root, Instant::now() + STATS_BUDGET, MAX_ENTRIES);
        assert!(stats.exists);
        assert_eq!(stats.files, 1);
        assert_eq!(stats.bytes, 10);
        assert!(stats.error.is_empty());
        assert!(cache_stats(&root, Instant::now() + STATS_BUDGET, 0).truncated);
        fs::remove_file(root.join("1-128.avif")).unwrap();
        fs::remove_file(root.join("1-128.avif.json")).unwrap();
        fs::remove_file(root.join("unfinished.tmp")).unwrap();
        fs::remove_dir(root.join("nested.avif")).unwrap();
        fs::remove_dir(root).unwrap();
    }

    #[test]
    fn probe_cleans_up_and_reports_non_directory_errors() {
        let root =
            std::env::temp_dir().join(format!("metatidy-probe-test-{}", uuid::Uuid::new_v4()));
        let checked = check_write(&root);
        assert_eq!(checked.state, "ok");
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
        let file = root.join("blocked");
        fs::write(&file, b"existing file").unwrap();
        let failed = check_write(&file);
        assert_eq!(failed.state, "error");
        assert!(!failed.error.is_empty());
        assert_eq!(fs::read(&file).unwrap(), b"existing file");
        fs::remove_file(file).unwrap();
        fs::remove_dir(root).unwrap();
    }

    #[test]
    fn clear_file_matcher_only_accepts_owned_flat_cache_names() {
        assert_eq!(recognized_cache_file("1-128.avif", true), Some(false));
        assert_eq!(recognized_cache_file("1-128.avif.json", true), Some(true));
        assert_eq!(recognized_cache_file("42-512.avif", true), Some(false));
        assert_eq!(recognized_cache_file("42-64.avif", true), None);
        assert_eq!(recognized_cache_file("42.avif", true), None);
        assert_eq!(recognized_cache_file("42.original", false), Some(false));
        assert_eq!(recognized_cache_file("42.original.json", false), Some(true));
        assert_eq!(recognized_cache_file("42.jpg", false), Some(false));
        assert_eq!(recognized_cache_file("0.original", false), None);
        assert_eq!(recognized_cache_file("042.original", false), None);
        assert_eq!(recognized_cache_file("42.jpeg", false), None);
        assert_eq!(recognized_cache_file("42-128.avif", false), None);
    }

    #[test]
    fn cache_clear_counts_images_and_metadata_without_touching_unknown_entries() {
        let root = std::env::temp_dir().join(format!("metatidy-clear-{}", uuid::Uuid::new_v4()));
        let thumbs = root.join("thumbs");
        let covers = root.join("covers");
        fs::create_dir_all(&thumbs).unwrap();
        fs::create_dir_all(&covers).unwrap();
        fs::write(thumbs.join("1-128.avif"), b"image").unwrap();
        fs::write(thumbs.join("1-128.avif.json"), b"meta").unwrap();
        fs::write(thumbs.join("keep.tmp"), b"keep").unwrap();
        fs::create_dir(thumbs.join("9-256.avif")).unwrap();
        fs::write(covers.join("2.original"), b"original").unwrap();

        // Config construction is intentionally avoided here: the matcher and
        // deletion loop are tested with the same private directory contract.
        let mut report = ClearCacheReport {
            scope: "thumbnails",
            finished_at: 0.0,
            complete: false,
            removed_files: 0,
            removed_images: 0,
            removed_metadata: 0,
            removed_bytes: 0,
            skipped_entries: 0,
            failed_entries: 0,
            errors: Vec::new(),
            truncated: false,
        };
        let mut budget = MAX_ENTRIES;
        clear_cache_directory(
            &thumbs,
            true,
            Instant::now() + CLEAR_BUDGET,
            &mut budget,
            &mut report,
        );
        assert_eq!(report.removed_files, 2);
        assert_eq!(report.removed_images, 1);
        assert_eq!(report.removed_metadata, 1);
        assert!(thumbs.join("keep.tmp").exists());
        assert!(thumbs.join("9-256.avif").is_dir());
        assert!(covers.join("2.original").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cache_target_validation_rejects_files_links_and_music_overlap() {
        let root = std::env::temp_dir().join(format!("metatidy-clear-boundary-{}", uuid::Uuid::new_v4()));
        let music = root.join("music");
        let data = root.join("data");
        fs::create_dir_all(&music).unwrap();
        fs::create_dir_all(&data).unwrap();
        assert!(matches!(validate_cache_target(&data, &data.join("thumbs"), "thumbs", &music), Ok(CacheTargetState::Missing)));

        let file_target = data.join("covers");
        fs::write(&file_target, b"keep").unwrap();
        assert!(validate_cache_target(&data, &file_target, "covers", &music).is_err());
        fs::remove_file(file_target).unwrap();

        let linked_cache = data.join("thumbs");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&music, &linked_cache).unwrap();
            assert!(validate_cache_target(&data, &linked_cache, "thumbs", &music).is_err());
            fs::remove_file(&linked_cache).unwrap();
        }
        #[cfg(windows)]
        {
            if std::os::windows::fs::symlink_dir(&music, &linked_cache).is_ok() {
                assert!(validate_cache_target(&data, &linked_cache, "thumbs", &music).is_err());
                fs::remove_file(&linked_cache).unwrap();
            }
        }

        let inside_music_data = music.join("data");
        fs::create_dir_all(inside_music_data.join("thumbs")).unwrap();
        assert!(validate_cache_target(&inside_music_data, &inside_music_data.join("thumbs"), "thumbs", &music).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cache_clear_respects_entry_budget_and_marks_partial_results_incomplete() {
        let root = std::env::temp_dir().join(format!("metatidy-clear-budget-{}", uuid::Uuid::new_v4()));
        let thumbs = root.join("thumbs");
        fs::create_dir_all(&thumbs).unwrap();
        for id in 1..=3 { fs::write(thumbs.join(format!("{id}-128.avif")), [id as u8]).unwrap(); }
        let report = clear_cache_paths(&root, &root.join("music"), CacheScope::Thumbnails, 1, CLEAR_BUDGET);
        assert!(!report.complete);
        assert!(report.truncated);
        assert_eq!(report.removed_files, 1);
        assert_eq!(report.failed_entries, 0);
        fs::remove_dir_all(root).unwrap();
    }
}
