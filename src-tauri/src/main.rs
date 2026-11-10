#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::time::Duration;

async fn get_json(
    url: &str,
    timeout: Duration,
    limit: usize,
) -> Result<serde_json::Value, &'static str> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(timeout)
        .build()
        .map_err(|_| "unavailable")?;
    let mut response = client.get(url).send().await.map_err(|_| "unavailable")?;
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

async fn check_version(url: &str, timeout: Duration) -> Result<String, &'static str> {
    let value = get_json(url, timeout, 4096).await?;
    value
        .get("version")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty() && s.len() <= 128)
        .map(str::to_owned)
        .ok_or("unavailable")
}

async fn fetch_models(url: &str, timeout: Duration) -> Result<Vec<String>, &'static str> {
    let value = get_json(url, timeout, 4 * 1024 * 1024).await?;
    value
        .get("models")
        .and_then(|v| v.as_array())
        .ok_or("unavailable")?
        .iter()
        .map(|model| {
            model
                .get("name")
                .and_then(|name| name.as_str())
                .filter(|name| !name.trim().is_empty() && name.len() <= 512)
                .map(str::to_owned)
                .ok_or("unavailable")
        })
        .collect()
}

#[tauri::command]
async fn ollama_models() -> Result<Vec<String>, String> {
    fetch_models("http://127.0.0.1:11434/api/tags", Duration::from_secs(3))
        .await
        .map_err(str::to_owned)
}

#[tauri::command]
async fn ollama_connection() -> Result<String, String> {
    check_version("http://127.0.0.1:11434/api/version", Duration::from_secs(3))
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
                Some(names) => assert_eq!(result.unwrap(), names),
                None => assert!(result.is_err()),
            }
        }
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
        let actual =
            tauri::async_runtime::block_on(fetch_models(url, Duration::from_secs(3))).unwrap();
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
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![ollama_connection, ollama_models])
        .run(tauri::generate_context!())
        .expect("failed to run Lokvyn");
}
