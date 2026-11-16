#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use scraper::{Html, Selector};
use std::{
    collections::{BTreeMap, HashMap},
    ffi::OsString,
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, LazyLock, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter};

static OLLAMA_START_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static OLLAMA_PULL_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static OLLAMA_PULL_CONTROLS: LazyLock<Mutex<HashMap<String, Arc<PullControl>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

struct PullControl {
    cancelled: AtomicBool,
    finished: AtomicBool,
    cancel_notify: tokio::sync::Notify,
    finish_notify: tokio::sync::Notify,
}

impl PullControl {
    fn new() -> Self {
        Self {
            cancelled: AtomicBool::new(false),
            finished: AtomicBool::new(false),
            cancel_notify: tokio::sync::Notify::new(),
            finish_notify: tokio::sync::Notify::new(),
        }
    }

    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        self.cancel_notify.notify_one();
    }

    fn finish(&self) {
        self.finished.store(true, Ordering::Release);
        self.finish_notify.notify_one();
    }

    async fn cancelled(&self) {
        loop {
            let notified = self.cancel_notify.notified();
            if self.cancelled.load(Ordering::Acquire) {
                return;
            }
            notified.await;
        }
    }

    async fn wait_finished(&self) {
        loop {
            let notified = self.finish_notify.notified();
            if self.finished.load(Ordering::Acquire) {
                return;
            }
            notified.await;
        }
    }
}

const CATALOG_RESPONSE_LIMIT: usize = 2 * 1024 * 1024;
const CATALOG_PAGE_SIZE: u32 = 20;
const CATALOG_DETAIL_CONCURRENCY: usize = 4;

#[derive(Debug, PartialEq)]
struct CatalogModel {
    name: String,
    description: String,
    capabilities: Vec<String>,
    cloud: bool,
    downloads: Option<String>,
    sizes: Vec<String>,
    download_size: Option<String>,
}

fn selector(value: &str) -> Result<Selector, &'static str> {
    Selector::parse(value).map_err(|_| "unavailable")
}

fn element_text(element: scraper::ElementRef<'_>) -> String {
    element
        .text()
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn valid_download_size(value: &str) -> bool {
    let Some(number) = ["TB", "GB", "MB", "KB", "B"]
        .iter()
        .find_map(|unit| value.strip_suffix(unit))
    else {
        return false;
    };
    !number.is_empty()
        && number.chars().filter(|character| *character == '.').count() <= 1
        && number
            .chars()
            .all(|character| character.is_ascii_digit() || character == '.')
        && number.chars().any(|character| character.is_ascii_digit())
}

fn parse_default_download_size(html: &str, model_name: &str) -> Option<String> {
    if model_name.is_empty()
        || !model_name
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._-".contains(character))
    {
        return None;
    }
    let document = Html::parse_document(html);
    let tag_selector =
        Selector::parse(&format!("a[href=\"/library/{model_name}:latest\"]")).ok()?;
    let size_selector = Selector::parse("p.col-span-2").ok()?;
    for tag_link in document.select(&tag_selector) {
        let mut parent = tag_link.parent();
        while let Some(node) = parent {
            parent = node.parent();
            let Some(element) = scraper::ElementRef::wrap(node) else {
                continue;
            };
            if let Some(size) = element
                .select(&size_selector)
                .next()
                .map(element_text)
                .filter(|value| valid_download_size(value))
            {
                return Some(size);
            }
        }
    }
    None
}

fn catalog_query_params(
    query: &str,
    page: u32,
    sort: &str,
    capability: &str,
) -> Vec<(String, String)> {
    let mut params = Vec::new();
    if !query.is_empty() {
        params.push(("q".into(), query.into()));
    }
    if sort != "popular" {
        params.push(("o".into(), sort.into()));
    }
    if page > 1 {
        params.push(("page".into(), page.to_string()));
    }
    if !capability.is_empty() {
        params.push(("c".into(), capability.into()));
    }
    params
}

fn parse_catalog_page(html: &str, page: u32) -> Result<serde_json::Value, &'static str> {
    let document = Html::parse_document(html);
    let results = selector("#searchresults")?;
    let root = document.select(&results).next();
    let count_selector = selector("[data-result-count]")?;
    let count = root
        .and_then(|root| root.select(&count_selector).next())
        .and_then(|element| element.value().attr("data-result-count"))
        .and_then(|value| value.parse::<u32>().ok());
    if page == 1 && count.is_none() {
        return Err("unavailable");
    }
    if count.is_some_and(|count| count > CATALOG_PAGE_SIZE) {
        return Err("unavailable");
    }
    let has_more = root
        .and_then(|root| root.select(&count_selector).next())
        .and_then(|element| element.value().attr("data-has-more"))
        .map(|value| value == "true")
        .unwrap_or_else(|| {
            selector("li[hx-get^='/search?page=']")
                .ok()
                .is_some_and(|selector| document.select(&selector).next().is_some())
        });
    let card_selector = selector("li > a[href^='/library/']")?;
    let title_selector = selector("h2")?;
    let description_selector = selector("p")?;
    let capability_selector = selector("span[class*='bg-indigo-50']")?;
    let cloud_selector = selector("span[class*='bg-cyan-50']")?;
    let size_selector = selector("span[class*='bg-[#ddf4ff]']")?;
    let downloads_selector = selector("div[class*='mt-3'] span[title*='downloads']")?;
    let models = document
        .select(&card_selector)
        .take(CATALOG_PAGE_SIZE as usize)
        .filter_map(|card| {
            let href = card.value().attr("href")?;
            let name = href.strip_prefix("/library/")?.trim_matches('/');
            if name.is_empty()
                || name.len() > 128
                || !name
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric() || "._-".contains(character))
            {
                return None;
            }
            card.select(&title_selector).next()?;
            let description = card
                .select(&description_selector)
                .next()
                .map(element_text)
                .unwrap_or_default();
            if description.len() > 1024 {
                return None;
            }
            let capabilities = card
                .select(&capability_selector)
                .map(element_text)
                .filter(|value| !value.is_empty() && value.len() <= 32)
                .take(16)
                .collect::<Vec<_>>();
            let cloud = card
                .select(&cloud_selector)
                .any(|badge| element_text(badge).eq_ignore_ascii_case("cloud"));
            let sizes = card
                .select(&size_selector)
                .map(element_text)
                .filter(|value| !value.is_empty() && value.len() <= 16)
                .take(16)
                .collect::<Vec<_>>();
            let downloads = card
                .select(&downloads_selector)
                .next()
                .and_then(|element| element.value().attr("title"))
                .filter(|value| value.len() <= 64)
                .map(str::to_owned);
            Some(CatalogModel {
                name: name.to_owned(),
                description,
                capabilities,
                cloud,
                downloads,
                sizes,
                download_size: None,
            })
        })
        .map(|model| {
            serde_json::json!({
                "name": model.name,
                "description": model.description,
                "capabilities": model.capabilities,
                "cloud": model.cloud,
                "downloads": model.downloads,
                "sizes": model.sizes,
                "downloadSize": model.download_size,
            })
        })
        .collect::<Vec<_>>();
    Ok(serde_json::json!({
        "models": models,
        "page": page,
        "hasMore": has_more,
    }))
}

fn valid_model_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 512
        && value.trim() == value
        && !value.contains("://")
        && !value.starts_with('/')
        && !value.ends_with('/')
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._:/-".contains(character))
}

#[derive(Debug, PartialEq)]
struct OllamaModel {
    name: String,
    size: Option<u64>,
    modified_at: Option<String>,
}

async fn get_json(
    url: &str,
    timeout: Duration,
    limit: usize,
) -> Result<serde_json::Value, &'static str> {
    request_json(url, reqwest::Method::GET, None, timeout, limit).await
}

async fn request_json(
    url: &str,
    method: reqwest::Method,
    body: Option<serde_json::Value>,
    timeout: Duration,
    limit: usize,
) -> Result<serde_json::Value, &'static str> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(timeout)
        .build()
        .map_err(|_| "unavailable")?;
    let request = client.request(method, url);
    let mut response = match body {
        Some(body) => {
            request
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(serde_json::to_vec(&body).map_err(|_| "unavailable")?)
                .send()
                .await
        }
        None => request.send().await,
    }
    .map_err(|_| "unavailable")?;
    if !response.status().is_success() {
        return Err("unavailable");
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "unavailable")? {
        if chunk.len() > limit.saturating_sub(body.len()) {
            return Err("unavailable");
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|_| "unavailable")
}

#[derive(Debug, PartialEq)]
struct ModelDetails {
    format: Option<String>,
    family: Option<String>,
    parameter_size: Option<String>,
    quantization_level: Option<String>,
    parameters: Option<String>,
    template: Option<String>,
    system: Option<String>,
    model_info: BTreeMap<String, String>,
}

#[derive(Debug, PartialEq)]
struct RunningModel {
    name: String,
    size_vram: Option<u64>,
    expires_at: Option<String>,
}

fn parse_model_details(value: &serde_json::Value) -> Result<ModelDetails, &'static str> {
    let details = value
        .get("details")
        .and_then(serde_json::Value::as_object)
        .ok_or("unavailable")?;
    let field = |key: &str| {
        details
            .get(key)
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.trim().is_empty() && value.len() <= 128)
            .map(str::to_owned)
    };
    let config_field = |key: &str| {
        value
            .get(key)
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.trim().is_empty() && value.len() <= 64 * 1024)
            .map(str::to_owned)
    };
    let model_info = value
        .get("model_info")
        .and_then(serde_json::Value::as_object)
        .map(|entries| {
            entries
                .iter()
                .filter_map(|(key, value)| {
                    if key.is_empty() || key.len() > 128 {
                        return None;
                    }
                    let value = match value {
                        serde_json::Value::String(value) if value.len() <= 128 => value.clone(),
                        serde_json::Value::Number(value) => value.to_string(),
                        serde_json::Value::Bool(value) => value.to_string(),
                        _ => return None,
                    };
                    Some((key.clone(), value))
                })
                .take(64)
                .collect()
        })
        .unwrap_or_default();
    Ok(ModelDetails {
        format: field("format"),
        family: field("family"),
        parameter_size: field("parameter_size"),
        quantization_level: field("quantization_level"),
        parameters: config_field("parameters"),
        template: config_field("template"),
        system: config_field("system"),
        model_info,
    })
}

fn parse_running_models(value: &serde_json::Value) -> Result<Vec<RunningModel>, &'static str> {
    value
        .get("models")
        .and_then(serde_json::Value::as_array)
        .ok_or("unavailable")?
        .iter()
        .map(|model| {
            let name = model
                .get("name")
                .and_then(serde_json::Value::as_str)
                .filter(|name| !name.trim().is_empty() && name.len() <= 512)
                .map(str::to_owned)
                .ok_or("unavailable")?;
            let expires_at = model
                .get("expires_at")
                .and_then(serde_json::Value::as_str)
                .filter(|value| !value.trim().is_empty() && value.len() <= 64)
                .map(str::to_owned);
            Ok(RunningModel {
                name,
                size_vram: model.get("size_vram").and_then(serde_json::Value::as_u64),
                expires_at,
            })
        })
        .collect()
}

async fn set_model_loaded(
    url: &str,
    model_name: &str,
    loaded: bool,
    timeout: Duration,
) -> Result<(), &'static str> {
    let mut body = serde_json::json!({ "model": model_name, "messages": [], "stream": false });
    if !loaded {
        body["keep_alive"] = serde_json::json!(0);
    }
    let response = request_json(url, reqwest::Method::POST, Some(body), timeout, 64 * 1024).await?;
    let expected_reason = if loaded { "load" } else { "unload" };
    if response.get("done").and_then(serde_json::Value::as_bool) != Some(true)
        || response
            .get("done_reason")
            .and_then(serde_json::Value::as_str)
            != Some(expected_reason)
    {
        return Err("unavailable");
    }
    Ok(())
}

async fn check_version(url: &str, timeout: Duration) -> Result<String, &'static str> {
    let value = get_json(url, timeout, 4096).await?;
    value
        .get("version")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty() && s.len() <= 128)
        .map(str::to_owned)
        .ok_or("unavailable")
}

fn ollama_executables() -> Vec<OsString> {
    let mut paths = vec![OsString::from("ollama")];
    #[cfg(target_os = "macos")]
    paths.extend([
        OsString::from("/opt/homebrew/bin/ollama"),
        OsString::from("/usr/local/bin/ollama"),
        OsString::from("/Applications/Ollama.app/Contents/Resources/ollama"),
    ]);
    #[cfg(target_os = "windows")]
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        paths.push(
            std::path::PathBuf::from(local_app_data)
                .join("Programs/Ollama/ollama.exe")
                .into_os_string(),
        );
    }
    paths
}

async fn ensure_ollama(
    url: &str,
    executables: &[OsString],
    timeout: Duration,
) -> Result<String, &'static str> {
    let _guard = OLLAMA_START_LOCK.lock().await;
    if let Ok(version) = check_version(url, Duration::from_millis(500)).await {
        return Ok(version);
    }

    let mut child = executables
        .iter()
        .find_map(|path| {
            let mut command = Command::new(path);
            command
                .arg("serve")
                .env("OLLAMA_HOST", "127.0.0.1:11434")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            #[cfg(target_os = "windows")]
            {
                use std::os::windows::process::CommandExt;
                command.creation_flags(0x08000000);
            }
            command.spawn().ok()
        })
        .ok_or("unavailable")?;

    let deadline = Instant::now() + timeout;
    loop {
        if let Ok(version) = check_version(url, Duration::from_millis(500)).await {
            std::thread::spawn(move || {
                let _ = child.wait();
            });
            return Ok(version);
        }
        match child.try_wait() {
            Ok(Some(_)) => return Err("unavailable"),
            Ok(None) => {}
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("unavailable");
            }
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err("unavailable");
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

async fn fetch_models(url: &str, timeout: Duration) -> Result<Vec<OllamaModel>, &'static str> {
    let value = get_json(url, timeout, 4 * 1024 * 1024).await?;
    value
        .get("models")
        .and_then(|v| v.as_array())
        .ok_or("unavailable")?
        .iter()
        .map(|model| {
            let name = model
                .get("name")
                .and_then(serde_json::Value::as_str)
                .filter(|name| !name.trim().is_empty() && name.len() <= 512)
                .map(str::to_owned)
                .ok_or("unavailable")?;
            let size = model.get("size").and_then(serde_json::Value::as_u64);
            let modified_at = model
                .get("modified_at")
                .and_then(serde_json::Value::as_str)
                .filter(|value| !value.trim().is_empty() && value.len() <= 64)
                .map(str::to_owned);
            Ok(OllamaModel {
                name,
                size,
                modified_at,
            })
        })
        .collect()
}

#[tauri::command]
async fn ollama_models() -> Result<Vec<serde_json::Value>, String> {
    fetch_models("http://127.0.0.1:11434/api/tags", Duration::from_secs(3))
        .await
        .map(|models| {
            models
                .into_iter()
                .map(|model| {
                    serde_json::json!({
                        "name": model.name,
                        "size": model.size,
                        "modifiedAt": model.modified_at,
                    })
                })
                .collect()
        })
        .map_err(str::to_owned)
}

#[tauri::command]
async fn ollama_catalog(
    query: String,
    page: u32,
    sort: String,
    capability: Option<String>,
) -> Result<serde_json::Value, String> {
    let query = query.trim();
    if query.len() > 120 || page == 0 || page > 1000 {
        return Err("unavailable".into());
    }
    let sort = match sort.as_str() {
        "popular" | "newest" | "name" | "price" | "context" => sort,
        _ => "popular".into(),
    };
    let capability = capability.unwrap_or_default();
    if !matches!(
        capability.as_str(),
        "" | "local"
            | "cloud"
            | "tools"
            | "thinking"
            | "vision"
            | "embedding"
            | "decision"
            | "audio"
    ) {
        return Err("unavailable".into());
    }
    let client = reqwest::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|_| "unavailable")?;
    let request = client
        .get("https://ollama.com/search")
        .query(&catalog_query_params(query, page, &sort, &capability));
    let request = if page > 1 {
        request
            .header("HX-Request", "true")
            .header("HX-Target", "searchresults")
    } else {
        request
    };
    let mut response = request.send().await.map_err(|_| "unavailable")?;
    if !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|length| length > CATALOG_RESPONSE_LIMIT as u64)
    {
        return Err("unavailable".into());
    }
    let mut html = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "unavailable")? {
        if chunk.len() > CATALOG_RESPONSE_LIMIT.saturating_sub(html.len()) {
            return Err("unavailable".into());
        }
        html.extend_from_slice(&chunk);
    }
    let html = std::str::from_utf8(&html).map_err(|_| "unavailable")?;
    let mut catalog = parse_catalog_page(html, page).map_err(str::to_owned)?;
    enrich_catalog_download_sizes(&client, &mut catalog).await;
    Ok(catalog)
}

async fn fetch_default_download_size(client: &reqwest::Client, model_name: &str) -> Option<String> {
    let url = format!("https://ollama.com/library/{model_name}/tags");
    let mut response = client
        .get(url)
        .timeout(Duration::from_secs(8))
        .send()
        .await
        .ok()?;
    if !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|length| length > CATALOG_RESPONSE_LIMIT as u64)
    {
        return None;
    }
    let mut html = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? {
        if chunk.len() > CATALOG_RESPONSE_LIMIT.saturating_sub(html.len()) {
            return None;
        }
        html.extend_from_slice(&chunk);
    }
    let html = std::str::from_utf8(&html).ok()?;
    parse_default_download_size(html, model_name)
}

async fn enrich_catalog_download_sizes(client: &reqwest::Client, catalog: &mut serde_json::Value) {
    let Some(models) = catalog.get("models").and_then(serde_json::Value::as_array) else {
        return;
    };
    let model_names = models
        .iter()
        .filter(|model| {
            !model
                .get("cloud")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false)
        })
        .filter_map(|model| {
            model
                .get("name")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
        })
        .collect::<Vec<_>>();
    let semaphore = std::sync::Arc::new(tokio::sync::Semaphore::new(CATALOG_DETAIL_CONCURRENCY));
    let mut tasks = tokio::task::JoinSet::new();
    for model_name in model_names {
        let client = client.clone();
        let semaphore = semaphore.clone();
        tasks.spawn(async move {
            let _permit = semaphore.acquire_owned().await.ok()?;
            let size = fetch_default_download_size(&client, &model_name).await;
            Some((model_name, size))
        });
    }
    let mut download_sizes = HashMap::new();
    while let Some(result) = tasks.join_next().await {
        if let Ok(Some((name, size))) = result {
            download_sizes.insert(name, size);
        }
    }
    if let Some(models) = catalog
        .get_mut("models")
        .and_then(serde_json::Value::as_array_mut)
    {
        for model in models {
            let Some(name) = model.get("name").and_then(serde_json::Value::as_str) else {
                continue;
            };
            if let Some(size) = download_sizes.get(name).and_then(Option::as_ref) {
                model["downloadSize"] = serde_json::Value::String(size.clone());
            }
        }
    }
}

fn safe_pull_error(message: &str) -> String {
    let normalized = message.split_whitespace().collect::<Vec<_>>().join(" ");
    let bounded = normalized.chars().take(256).collect::<String>();
    if bounded.is_empty() {
        "Ollama pull failed".into()
    } else {
        bounded
    }
}

fn emit_pull_event(app: &AppHandle, model_name: &str, line: &[u8]) -> Result<bool, String> {
    if line.is_empty() {
        return Ok(false);
    }
    if line.len() > 16 * 1024 {
        return Err("Ollama returned an oversized pull event".into());
    }
    let value: serde_json::Value =
        serde_json::from_slice(line).map_err(|_| "Ollama returned invalid pull data".to_owned())?;
    if let Some(error) = value.get("error").and_then(serde_json::Value::as_str) {
        return Err(safe_pull_error(error));
    }
    let status = value
        .get("status")
        .and_then(serde_json::Value::as_str)
        .filter(|status| !status.is_empty() && status.len() <= 256)
        .ok_or_else(|| "Ollama pull event did not include a status".to_owned())?;
    let complete = status == "success";
    let _ = app.emit(
        "ollama-pull-progress",
        serde_json::json!({
            "model": model_name,
            "status": if complete { "complete" } else { "downloading" },
            "message": status,
            "completed": value.get("completed").and_then(serde_json::Value::as_u64),
            "total": value.get("total").and_then(serde_json::Value::as_u64),
        }),
    );
    Ok(complete)
}

#[tauri::command]
async fn ollama_pull_model(app: AppHandle, model_name: String) -> Result<(), String> {
    if !valid_model_name(&model_name) {
        return Err("Invalid Ollama model name".into());
    }
    let control = Arc::new(PullControl::new());
    {
        let mut controls = OLLAMA_PULL_CONTROLS
            .lock()
            .map_err(|_| "Download controls are unavailable".to_owned())?;
        if controls.contains_key(&model_name) {
            return Err("This model is already queued or downloading".into());
        }
        controls.insert(model_name.clone(), control.clone());
    }

    let result = ollama_pull_model_inner(&app, &model_name, &control).await;
    if let Ok(mut controls) = OLLAMA_PULL_CONTROLS.lock() {
        if controls
            .get(&model_name)
            .is_some_and(|registered| Arc::ptr_eq(registered, &control))
        {
            controls.remove(&model_name);
        }
    }
    control.finish();
    result
}

async fn ollama_pull_model_inner(
    app: &AppHandle,
    model_name: &str,
    control: &PullControl,
) -> Result<(), String> {
    let _guard = tokio::select! {
        _ = control.cancelled() => return Err("Download cancelled".into()),
        guard = OLLAMA_PULL_LOCK.lock() => guard,
    };
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(7 * 24 * 60 * 60))
        .build()
        .map_err(|error| {
            format!(
                "Could not prepare Ollama request: {}",
                safe_pull_error(&error.to_string())
            )
        })?;
    let request = client
        .post("http://127.0.0.1:11434/api/pull")
        .json(&serde_json::json!({ "model": model_name, "stream": true }))
        .send();
    let mut response = tokio::select! {
        _ = control.cancelled() => return Err("Download cancelled".into()),
        response = request => response.map_err(|error| {
            format!(
                "Could not connect to Ollama: {}",
                safe_pull_error(&error.to_string())
            )
        })?,
    };
    if !response.status().is_success() {
        let status = response.status();
        let detail = match response.chunk().await {
            Ok(Some(chunk)) if chunk.len() <= 16 * 1024 => {
                serde_json::from_slice::<serde_json::Value>(&chunk)
                    .ok()
                    .and_then(|value| {
                        value
                            .get("error")
                            .and_then(serde_json::Value::as_str)
                            .map(str::to_owned)
                    })
                    .map(|message| format!(": {}", safe_pull_error(&message)))
                    .unwrap_or_default()
            }
            _ => String::new(),
        };
        return Err(format!("Ollama returned HTTP {status}{detail}"));
    }
    let mut pending = Vec::new();
    let mut complete = false;
    loop {
        let chunk = tokio::select! {
            _ = control.cancelled() => return Err("Download cancelled".into()),
            chunk = response.chunk() => chunk.map_err(|error| {
                format!(
                    "Failed reading Ollama pull response: {}",
                    safe_pull_error(&error.to_string())
                )
            })?,
        };
        let Some(chunk) = chunk else { break };
        pending.extend_from_slice(&chunk);
        if pending.len() > 16 * 1024 && !pending.contains(&b'\n') {
            return Err("Ollama returned an oversized pull event".into());
        }
        while let Some(newline) = pending.iter().position(|byte| *byte == b'\n') {
            let line = pending.drain(..=newline).collect::<Vec<_>>();
            complete |= emit_pull_event(app, model_name, &line[..line.len() - 1])?;
        }
    }
    if !pending.is_empty() {
        complete |= emit_pull_event(app, model_name, &pending)?;
    }
    if complete {
        Ok(())
    } else {
        Err("Ollama pull ended before completion".into())
    }
}

#[tauri::command]
async fn ollama_cancel_pull(model_name: String) -> Result<(), String> {
    let control = OLLAMA_PULL_CONTROLS
        .lock()
        .map_err(|_| "Download controls are unavailable".to_owned())?
        .get(&model_name)
        .cloned()
        .ok_or_else(|| "No active download for this model".to_owned())?;
    control.cancel();
    control.wait_finished().await;
    Ok(())
}

#[tauri::command]
async fn ollama_model_details(model_name: String) -> Result<serde_json::Value, String> {
    let url = "http://127.0.0.1:11434/api/show";
    let response = request_json(
        url,
        reqwest::Method::POST,
        Some(serde_json::json!({ "name": model_name })),
        Duration::from_secs(3),
        4 * 1024 * 1024,
    )
    .await
    .map_err(str::to_owned)?;
    let details = parse_model_details(&response).map_err(str::to_owned)?;
    Ok(serde_json::json!({
        "format": details.format,
        "family": details.family,
        "parameter_size": details.parameter_size,
        "quantization_level": details.quantization_level,
        "parameters": details.parameters,
        "template": details.template,
        "system": details.system,
        "model_info": details.model_info,
    }))
}

#[tauri::command]
async fn ollama_running_models() -> Result<Vec<serde_json::Value>, String> {
    let response = get_json(
        "http://127.0.0.1:11434/api/ps",
        Duration::from_secs(3),
        1024 * 1024,
    )
    .await
    .map_err(str::to_owned)?;
    parse_running_models(&response)
        .map(|models| {
            models
                .into_iter()
                .map(|model| {
                    serde_json::json!({
                        "name": model.name,
                        "sizeVram": model.size_vram,
                        "expiresAt": model.expires_at,
                    })
                })
                .collect()
        })
        .map_err(str::to_owned)
}

async fn change_model_state(model_name: String, loaded: bool) -> Result<(), String> {
    if model_name.trim().is_empty() || model_name.len() > 512 {
        return Err("unavailable".to_owned());
    }
    set_model_loaded(
        "http://127.0.0.1:11434/api/chat",
        &model_name,
        loaded,
        Duration::from_secs(10 * 60),
    )
    .await
    .map_err(str::to_owned)
}

#[tauri::command]
async fn ollama_load_model(model_name: String) -> Result<(), String> {
    change_model_state(model_name, true).await
}

#[tauri::command]
async fn ollama_unload_model(model_name: String) -> Result<(), String> {
    change_model_state(model_name, false).await
}

#[tauri::command]
async fn ollama_connection() -> Result<String, String> {
    ensure_ollama(
        "http://127.0.0.1:11434/api/version",
        &ollama_executables(),
        Duration::from_secs(15),
    )
    .await
    .map_err(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        thread,
        time::Duration,
    };

    #[test]
    fn existing_service_is_reused_without_launching_a_process() {
        let url = server(
            "HTTP/1.1 200 OK\r\nContent-Length: 19\r\n\r\n{\"version\":\"0.1.0\"}",
            Duration::ZERO,
        );
        let result = tauri::async_runtime::block_on(ensure_ollama(
            &url,
            &["/nonexistent/lokvyn-ollama".into()],
            Duration::from_millis(300),
        ));
        assert_eq!(result.unwrap(), "0.1.0");
    }

    #[test]
    fn parses_live_catalog_cards_and_rejects_invalid_library_paths() {
        let html = r#"
            <div id="searchresults">
              <div data-result-count="20" data-has-more="true"></div>
              <ul>
                <li><a href="/library/qwen3.8">
                  <h2 title="qwen3.8"><span>qwen3.8</span></h2>
                  <div><span class="bg-indigo-50">vision</span><span class="bg-indigo-50">tools</span></div>
                  <p> Qwen model <strong>for reasoning</strong>. </p>
                  <div class="mt-3"><span title="6,522,021 downloads">6.5M</span>
                    <span class="bg-[#ddf4ff]">27b</span>
                  </div>
                </a></li>
                <li><a href="/library/../escape"><h2>Invalid path</h2></a></li>
                <li><a href="https://example.com/library/other"><h2>External path</h2></a></li>
              </ul>
            </div>
        "#;

        let result = parse_catalog_page(html, 3).unwrap();
        assert_eq!(result["page"], 3);
        assert_eq!(result["hasMore"], true);
        assert_eq!(result["models"].as_array().unwrap().len(), 1);
        assert_eq!(
            result["models"][0],
            serde_json::json!({
                "name": "qwen3.8",
                "description": "Qwen model for reasoning.",
                "capabilities": ["vision", "tools"],
                "cloud": false,
                "downloads": "6,522,021 downloads",
                "sizes": ["27b"],
                "downloadSize": null,
            })
        );
    }

    #[test]
    fn parses_default_model_download_size_from_ollama_tags_page() {
        let html = r#"
            <div class="group px-4 py-3">
              <div class="hidden md:flex flex-col">
                <div class="grid grid-cols-12 items-center">
                  <span class="col-span-6"><a href="/library/qwen3:latest">qwen3:latest</a></span>
                  <p class="col-span-2 text-neutral-500">5.2GB</p>
                  <p class="col-span-2">40K</p>
                </div>
              </div>
            </div>
        "#;

        assert_eq!(
            parse_default_download_size(html, "qwen3"),
            Some("5.2GB".into())
        );
    }

    #[test]
    fn omits_download_size_when_default_tag_or_valid_size_is_missing() {
        let missing_latest = r#"
            <div class="grid grid-cols-12 items-center">
              <a href="/library/qwen3:8b">qwen3:8b</a>
              <p class="col-span-2">5.2GB</p>
            </div>
        "#;
        let invalid_size = r#"
            <div class="grid grid-cols-12 items-center">
              <a href="/library/qwen3:latest">qwen3:latest</a>
              <p class="col-span-2">unknown</p>
            </div>
        "#;

        assert_eq!(parse_default_download_size(missing_latest, "qwen3"), None);
        assert_eq!(parse_default_download_size(invalid_size, "qwen3"), None);
    }

    #[test]
    fn identifies_cloud_models_in_catalog_cards() {
        let html = r#"
            <div id="searchresults">
              <div data-result-count="1" data-has-more="false"></div>
              <ul>
                <li><a href="/library/deepseek-v4.1-flash">
                  <h2 title="deepseek-v4.1-flash"><span>deepseek-v4.1-flash</span></h2>
                  <div>
                    <span class="bg-indigo-50">vision</span>
                    <span class="bg-cyan-50">cloud</span>
                  </div>
                  <p>A cloud model.</p>
                </a></li>
              </ul>
            </div>
        "#;

        let result = parse_catalog_page(html, 1).unwrap();
        assert_eq!(result["models"][0]["cloud"], true);
        assert_eq!(
            result["models"][0]["capabilities"],
            serde_json::json!(["vision"])
        );
    }

    #[test]
    fn rejects_catalog_pages_without_expected_metadata() {
        assert!(parse_catalog_page("<div id=\"searchresults\"></div>", 1).is_err());
        assert!(parse_catalog_page("<main>unrelated content</main>", 1).is_err());
    }

    #[test]
    fn parses_ollama_pagination_fragments_and_detects_the_next_page() {
        let html = r#"
            <li><a href="/library/qwen3.8">
              <h2 title="qwen3.8"><span>qwen3.8</span></h2>
              <div><span class="bg-indigo-50">vision</span></div>
              <p>A model family.</p>
              <div class="mt-3"><span class="bg-[#ddf4ff]">27b</span></div>
            </a></li>
            <li hx-get="/search?page=3" hx-trigger="revealed"></li>
        "#;

        let result = parse_catalog_page(html, 2).unwrap();
        assert_eq!(result["page"], 2);
        assert_eq!(result["hasMore"], true);
        assert_eq!(result["models"].as_array().unwrap().len(), 1);
        assert_eq!(result["models"][0]["name"], "qwen3.8");
    }

    #[test]
    fn omits_default_catalog_query_parameters_that_ollama_redirects() {
        assert_eq!(
            catalog_query_params("", 1, "popular", ""),
            Vec::<(String, String)>::new()
        );
        assert_eq!(
            catalog_query_params("llama", 2, "newest", "vision"),
            vec![
                ("q".into(), "llama".into()),
                ("o".into(), "newest".into()),
                ("page".into(), "2".into()),
                ("c".into(), "vision".into()),
            ]
        );
    }

    #[test]
    fn validates_ollama_pull_model_names_without_accepting_whitespace_or_urls() {
        for name in ["qwen3:8b", "org/model:latest", "model_name-2.1"] {
            assert!(valid_model_name(name), "expected {name} to be accepted");
        }
        for name in [
            "",
            " qwen3",
            "qwen3 ",
            "https://example.com/model",
            "/model",
            "model/",
            "bad name",
        ] {
            assert!(!valid_model_name(name), "expected {name:?} to be rejected");
        }
        assert!(!valid_model_name(&"a".repeat(513)));
    }

    #[test]
    fn bounds_and_sanitizes_ollama_pull_errors_for_display() {
        assert_eq!(
            safe_pull_error("  model not found\ntry another tag  "),
            "model not found try another tag"
        );
        assert_eq!(safe_pull_error("\n\t"), "Ollama pull failed");
        assert_eq!(safe_pull_error(&"x".repeat(300)).len(), 256);
    }

    #[test]
    fn pull_control_cancellation_and_completion_are_observable() {
        let control = PullControl::new();
        let waiter_control = Arc::new(control);
        let cancel_control = waiter_control.clone();
        tauri::async_runtime::block_on(async move {
            let cancelled = waiter_control.clone();
            let waiter = tokio::spawn(async move { cancelled.cancelled().await });
            tokio::task::yield_now().await;
            cancel_control.cancel();
            waiter.await.unwrap();
            cancel_control.finish();
            cancel_control.wait_finished().await;
        });
    }

    #[test]
    fn missing_executable_returns_an_error_and_can_be_retried() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/api/version", listener.local_addr().unwrap());
        drop(listener);
        for _ in 0..2 {
            assert!(tauri::async_runtime::block_on(ensure_ollama(
                &url,
                &["/nonexistent/lokvyn-ollama".into()],
                Duration::from_millis(100),
            ))
            .is_err());
        }
    }

    #[cfg(unix)]
    #[test]
    fn exited_process_and_startup_timeout_return_errors() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/api/version", listener.local_addr().unwrap());
        drop(listener);
        for executable in ["/usr/bin/false", "/usr/bin/yes"] {
            let start = Instant::now();
            assert!(tauri::async_runtime::block_on(ensure_ollama(
                &url,
                &[executable.into()],
                Duration::from_millis(300),
            ))
            .is_err());
            assert!(start.elapsed() < Duration::from_secs(3));
        }
    }

    fn server(response: impl Into<String>, delay: Duration) -> String {
        let response = response.into();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = [0; 1024];
            let _ = stream.read(&mut buf);
            thread::sleep(delay);
            let _ = stream.write_all(response.as_bytes());
        });
        format!("http://{address}/api/version")
    }

    #[test]
    fn accepts_valid_version_only() {
        let url = server(
            "HTTP/1.1 200 OK\r\nContent-Length: 19\r\n\r\n{\"version\":\"0.1.0\"}",
            Duration::ZERO,
        );
        assert_eq!(
            tauri::async_runtime::block_on(check_version(&url, Duration::from_secs(1))).unwrap(),
            "0.1.0"
        );
        let url = server(
            "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}",
            Duration::ZERO,
        );
        assert!(
            tauri::async_runtime::block_on(check_version(&url, Duration::from_secs(1))).is_err()
        );
    }

    #[test]
    fn reads_model_names_and_rejects_invalid_payloads() {
        for (body, expected) in [
            (
                r#"{"models":[{"name":"alpha:latest"},{"name":"beta:7b"}]}"#,
                Some(vec!["alpha:latest", "beta:7b"]),
            ),
            (r#"{"models":[]}"#, Some(vec![])),
            (r#"{"models":[{}]}"#, None),
            (r#"{"models":[{"name":" "}]}"#, None),
            (r#"{}"#, None),
            ("not json", None),
        ] {
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{}",
                body.len(),
                body
            );
            let url = server(response, Duration::ZERO);
            let result = tauri::async_runtime::block_on(fetch_models(&url, Duration::from_secs(1)));
            match expected {
                Some(names) => assert_eq!(
                    result
                        .unwrap()
                        .into_iter()
                        .map(|model| model.name)
                        .collect::<Vec<_>>(),
                    names
                ),
                None => assert!(result.is_err()),
            }
        }
    }

    #[test]
    fn reads_model_metadata_and_omits_invalid_optional_values() {
        let body = r#"{"models":[{"name":"alpha:latest","size":4294967296,"modified_at":"2025-01-02T03:04:05Z"},{"name":"beta:latest","size":"unknown","modified_at":"not-a-date"},{"name":"gamma:latest"}]}"#;
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{}",
            body.len(),
            body
        );
        let url = server(response, Duration::ZERO);
        let result =
            tauri::async_runtime::block_on(fetch_models(&url, Duration::from_secs(1))).unwrap();
        assert_eq!(result.len(), 3);
        assert_eq!(result[0].name, "alpha:latest");
        assert_eq!(result[0].size, Some(4_294_967_296));
        assert_eq!(
            result[0].modified_at.as_deref(),
            Some("2025-01-02T03:04:05Z")
        );
        assert_eq!(result[1].size, None);
        assert_eq!(result[1].modified_at.as_deref(), Some("not-a-date"));
        assert_eq!(result[2].size, None);
        assert_eq!(result[2].modified_at, None);
    }

    #[test]
    fn parses_running_models_and_rejects_invalid_names() {
        let parsed = parse_running_models(&serde_json::json!({
            "models": [{
                "name": "alpha:latest",
                "size_vram": 4096,
                "expires_at": "2026-11-12T12:00:00Z"
            }]
        }))
        .unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].name, "alpha:latest");
        assert_eq!(parsed[0].size_vram, Some(4096));
        assert_eq!(
            parsed[0].expires_at.as_deref(),
            Some("2026-11-12T12:00:00Z")
        );
        assert!(parse_running_models(&serde_json::json!({ "models": [{}] })).is_err());
        assert!(parse_running_models(&serde_json::json!({})).is_err());
    }

    #[test]
    fn parses_available_read_only_model_configuration() {
        let parsed = parse_model_details(&serde_json::json!({
            "details": { "format": "gguf", "family": "llama" },
            "parameters": "temperature 0.7",
            "template": "{{ .Prompt }}",
            "system": "Be concise.",
            "model_info": {
                "general.architecture": "llama",
                "general.parameter_count": 8000000000_i64,
                "ignored.nested": { "unsafe": true }
            }
        }))
        .unwrap();
        assert_eq!(parsed.parameters.as_deref(), Some("temperature 0.7"));
        assert_eq!(parsed.template.as_deref(), Some("{{ .Prompt }}"));
        assert_eq!(parsed.system.as_deref(), Some("Be concise."));
        assert_eq!(
            parsed.model_info.get("general.architecture").unwrap(),
            "llama"
        );
        assert_eq!(
            parsed.model_info.get("general.parameter_count").unwrap(),
            "8000000000"
        );
        assert!(!parsed.model_info.contains_key("ignored.nested"));
        assert!(parse_model_details(&serde_json::json!({})).is_err());
    }

    #[test]
    fn sends_documented_load_and_unload_requests() {
        for (loaded, expected_reason, body_fragment) in [
            (true, "load", r#""messages":[]"#),
            (false, "unload", r#""keep_alive":0"#),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let (sender, receiver) = std::sync::mpsc::channel();
            thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = [0; 4096];
                let size = stream.read(&mut request).unwrap();
                sender
                    .send(String::from_utf8_lossy(&request[..size]).into_owned())
                    .unwrap();
                let body = format!(r#"{{"done":true,"done_reason":"{expected_reason}"}}"#);
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{}",
                    body.len(),
                    body
                );
                stream.write_all(response.as_bytes()).unwrap();
            });
            assert!(tauri::async_runtime::block_on(set_model_loaded(
                &format!("http://{address}/api/chat"),
                "alpha:latest",
                loaded,
                Duration::from_secs(1),
            ))
            .is_ok());
            let request = receiver.recv_timeout(Duration::from_secs(1)).unwrap();
            assert!(request.starts_with("POST /api/chat HTTP/1.1\r\n"));
            assert!(request.contains(r#""model":"alpha:latest""#));
            assert!(request.contains(body_fragment));
            assert!(request.contains(r#""stream":false"#));
        }
    }

    #[test]
    fn parses_available_model_details_and_omits_missing_fields() {
        let complete = serde_json::json!({
            "details": {
                "format": "gguf",
                "family": "llama",
                "parameter_size": "8B",
                "quantization_level": "Q4_K_M"
            }
        });
        assert_eq!(
            parse_model_details(&complete).unwrap(),
            ModelDetails {
                format: Some("gguf".into()),
                family: Some("llama".into()),
                parameter_size: Some("8B".into()),
                quantization_level: Some("Q4_K_M".into()),
                parameters: None,
                template: None,
                system: None,
                model_info: BTreeMap::new(),
            }
        );

        let partial = serde_json::json!({"details": {"format": "gguf"}});
        assert_eq!(
            parse_model_details(&partial).unwrap(),
            ModelDetails {
                format: Some("gguf".into()),
                family: None,
                parameter_size: None,
                quantization_level: None,
                parameters: None,
                template: None,
                system: None,
                model_info: BTreeMap::new(),
            }
        );
        assert!(parse_model_details(&serde_json::json!({})).is_err());
    }

    #[test]
    fn requests_details_for_the_selected_model() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (sender, receiver) = std::sync::mpsc::channel();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0; 2048];
            let size = stream.read(&mut request).unwrap();
            sender
                .send(String::from_utf8_lossy(&request[..size]).into_owned())
                .unwrap();
            let body = r#"{"details":{"format":"gguf"}}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{}",
                body.len(),
                body
            );
            stream.write_all(response.as_bytes()).unwrap();
        });
        let result = tauri::async_runtime::block_on(request_json(
            &format!("http://{address}/api/show"),
            reqwest::Method::POST,
            Some(serde_json::json!({ "name": "selected:tag" })),
            Duration::from_secs(1),
            4096,
        ));
        assert!(result.is_ok());
        let request = receiver.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(request.starts_with("POST /api/show HTTP/1.1\r\n"));
        assert!(request.contains("content-type: application/json"));
        assert!(request.ends_with(r#"{"name":"selected:tag"}"#));
    }

    #[test]
    fn rejects_model_http_errors_and_oversized_responses() {
        let url = server(
            "HTTP/1.1 500 Error\r\nContent-Length: 0\r\n\r\n",
            Duration::ZERO,
        );
        assert!(
            tauri::async_runtime::block_on(fetch_models(&url, Duration::from_secs(1))).is_err()
        );
        let body = " ".repeat(4 * 1024 * 1024 + 1);
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{}",
            body.len(),
            body
        );
        let url = server(response, Duration::ZERO);
        assert!(
            tauri::async_runtime::block_on(fetch_models(&url, Duration::from_secs(3))).is_err()
        );
    }

    #[test]
    fn rejects_failures_redirects_and_timeouts() {
        for response in [
            "HTTP/1.1 500 Error\r\nContent-Length: 0\r\n\r\n",
            "HTTP/1.1 302 Found\r\nLocation: http://example.com\r\nContent-Length: 0\r\n\r\n",
        ] {
            let url = server(response, Duration::ZERO);
            assert!(
                tauri::async_runtime::block_on(check_version(&url, Duration::from_secs(1)))
                    .is_err()
            );
        }
        let url = server("", Duration::from_millis(200));
        assert!(
            tauri::async_runtime::block_on(check_version(&url, Duration::from_millis(30))).is_err()
        );
        assert!(tauri::async_runtime::block_on(check_version(
            "http://127.0.0.1:0/api/version",
            Duration::from_millis(100)
        ))
        .is_err());
    }

    #[test]
    #[ignore = "requires a running local Ollama server"]
    fn connects_to_local_ollama() {
        let result = tauri::async_runtime::block_on(check_version(
            "http://127.0.0.1:11434/api/version",
            Duration::from_secs(3),
        ));
        assert!(result.is_ok(), "local Ollama connection failed: {result:?}");
    }

    #[test]
    #[ignore = "requires a running local Ollama server"]
    fn lists_local_ollama_models() {
        let url = "http://127.0.0.1:11434/api/tags";
        let actual = tauri::async_runtime::block_on(fetch_models(url, Duration::from_secs(3)))
            .unwrap()
            .into_iter()
            .map(|model| model.name)
            .collect::<Vec<_>>();
        let response =
            tauri::async_runtime::block_on(get_json(url, Duration::from_secs(3), 4 * 1024 * 1024))
                .unwrap();
        let expected: Vec<&str> = response["models"]
            .as_array()
            .unwrap()
            .iter()
            .map(|model| model["name"].as_str().unwrap())
            .collect();
        assert_eq!(actual, expected);
    }

    #[test]
    #[ignore = "requires a running local Ollama server"]
    fn lists_running_local_ollama_models() {
        let response = tauri::async_runtime::block_on(get_json(
            "http://127.0.0.1:11434/api/ps",
            Duration::from_secs(3),
            1024 * 1024,
        ))
        .unwrap();
        assert!(parse_running_models(&response).is_ok());
    }

    #[test]
    #[ignore = "requires a running local Ollama server with an installed model"]
    fn reads_details_for_a_local_ollama_model() {
        let models = tauri::async_runtime::block_on(ollama_models()).unwrap();
        let model_name = models
            .first()
            .and_then(|model| model.get("name"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
            .expect("local Ollama has no installed models");
        let details = tauri::async_runtime::block_on(ollama_model_details(model_name)).unwrap();
        assert!(details.as_object().is_some_and(|fields| !fields.is_empty()));
    }
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            ollama_connection,
            ollama_models,
            ollama_catalog,
            ollama_pull_model,
            ollama_cancel_pull,
            ollama_model_details,
            ollama_running_models,
            ollama_load_model,
            ollama_unload_model
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Lokvyn");
}
