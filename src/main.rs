use axum::{
    extract::State,
    http::StatusCode,
    response::IntoResponse,
    response::Redirect,
    routing::get,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::sync::RwLock;
use tower_http::services::{ServeDir, ServeFile};
use uuid::Uuid;

type Store = Arc<RwLock<Vec<Message>>>;

#[derive(Clone)]
struct AppState {
    store: Store,
    http: reqwest::Client,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
enum Status {
    #[serde(rename = "Safe", alias = "safe")]
    Safe,
    #[serde(rename = "Help", alias = "help")]
    Help,
    #[serde(rename = "Resource", alias = "resource")]
    Resource,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Message {
    id: Uuid,
    alias: String,
    status: Status,
    content: String,
    // Unix timestamp (seconds) keeps payload small and parsing cheap.
    timestamp: u64,
}

#[derive(Debug, Deserialize)]
struct NewMessage {
    alias: String,
    status: Status,
    content: String,
}

#[derive(Debug, Deserialize)]
struct AiRequest {
    question: String,
}

#[derive(Debug, Serialize)]
struct AiResponse {
    answer: String,
}

#[derive(Debug, Serialize)]
struct ErrorResponse {
    error: String,
}

#[derive(Debug, Serialize)]
struct OllamaGenerateRequest<'a> {
    model: &'a str,
    prompt: &'a str,
    system: &'a str,
    stream: bool,
}

#[derive(Debug, Deserialize)]
struct OllamaGenerateResponse {
    response: String,
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    const HTTP_PORT: u16 = 80;
    const HTTPS_PORT: u16 = 443;
    const HTTPS_HOST: &str = "pilink.astatide.com";

    const TLS_CERT: &str = "/etc/pilink/certs/fullchain.pem";
    const TLS_KEY: &str = "/etc/pilink/certs/privkey.pem";

    let store: Store = Arc::new(RwLock::new(Vec::new()));
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(12))
        .build()
        .expect("http client build failed");

    let state = AppState { store, http };

    // Serve React/Tailwind build from ./dist; unknown paths fall back to index.html (SPA routing).
    let static_service = ServeDir::new("dist").not_found_service(ServeFile::new("dist/index.html"));

    let app_https = Router::new()
        .route("/health", get(health))
        .route("/api/posts", get(get_posts).post(create_post))
        .route("/api/ai", axum::routing::post(ai))
        .with_state(state)
        .nest_service("/", static_service);

    // HTTP listener exists only to redirect users into HTTPS.
    // Important for mobile browsers, and avoids mic permission issues on http://.
    let app_http = Router::new().fallback(move |uri: axum::http::Uri| async move {
        let pq = uri
            .path_and_query()
            .map(|x| x.as_str())
            .unwrap_or("/");
        Redirect::permanent(&format!("https://{HTTPS_HOST}{pq}"))
    });

    let tls = axum_server::tls_rustls::RustlsConfig::from_pem_file(TLS_CERT, TLS_KEY)
        .await
        .expect("failed to load TLS cert/key");

    let http_listener = tokio::net::TcpListener::bind(("0.0.0.0", HTTP_PORT))
        .await
        .expect("bind http failed");

    let https_addr = std::net::SocketAddr::from(([0, 0, 0, 0], HTTPS_PORT));

    // Run both servers concurrently.
    let http_task = tokio::spawn(async move {
        axum::serve(http_listener, app_http)
            .await
            .expect("http server failed")
    });

    let https_task = tokio::spawn(async move {
        axum_server::bind_rustls(https_addr, tls)
            .serve(app_https.into_make_service())
            .await
            .expect("https server failed")
    });

    let _ = tokio::join!(http_task, https_task);
}

async fn health() -> impl IntoResponse {
    (StatusCode::OK, "ok")
}

async fn get_posts(State(state): State<AppState>) -> impl IntoResponse {
    // Async read lock yields if a writer is active; clone to release lock quickly.
    let messages = state.store.read().await.clone();
    Json(messages)
}

async fn create_post(
    State(state): State<AppState>,
    Json(input): Json<NewMessage>,
) -> impl IntoResponse {
    let msg = Message {
        id: Uuid::new_v4(),
        alias: input.alias,
        status: input.status,
        content: input.content,
        timestamp: now_unix_secs(),
    };

    // Async write lock ensures concurrent POSTs serialize safely.
    state.store.write().await.push(msg.clone());

    (StatusCode::CREATED, Json(msg))
}

async fn ai(State(state): State<AppState>, Json(req): Json<AiRequest>) -> impl IntoResponse {
    let question = req.question.trim();
    if question.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "question is required".to_string(),
            }),
        )
            .into_response();
    }

    // Keep the system prompt short and directive to reduce token usage.
    const SYSTEM: &str = "You are a Disaster Survival Expert. Give concise, practical, step-by-step advice for emergencies. Prioritize safety, triage, shelter, water, food, first aid, and communication. If details are missing, ask 1-2 clarifying questions. Avoid speculation and do not mention being an AI.";

    let payload = OllamaGenerateRequest {
        model: "qwen2:0.5b",
        prompt: question,
        system: SYSTEM,
        stream: false,
    };

    // Async HTTP call to local Ollama; awaits without blocking the runtime.
    let res = match state
        .http
        .post("http://127.0.0.1:11434/api/generate")
        .json(&payload)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(ErrorResponse {
                    error: format!("ollama unreachable: {e}"),
                }),
            )
                .into_response();
        }
    };

    if !res.status().is_success() {
        return (
            StatusCode::BAD_GATEWAY,
            Json(ErrorResponse {
                error: format!("ollama error status: {}", res.status()),
            }),
        )
            .into_response();
    }

    let body: OllamaGenerateResponse = match res.json().await {
        Ok(b) => b,
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(ErrorResponse {
                    error: format!("ollama response parse error: {e}"),
                }),
            )
                .into_response();
        }
    };

    (
        StatusCode::OK,
        Json(AiResponse {
            answer: body.response,
        }),
    )
        .into_response()
}

fn now_unix_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
