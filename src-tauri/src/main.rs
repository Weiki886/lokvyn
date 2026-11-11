#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::time::Duration;

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
    Ok(ModelDetails {
        format: field("format"),
        family: field("family"),
        parameter_size: field("parameter_size"),
        quantization_level: field("quantization_level"),
    })
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
    }))
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
            ollama_model_details
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Lokvyn");
}
