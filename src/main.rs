use axum::{
    extract::{
        ws::{Message as WsMsg, WebSocket, WebSocketUpgrade},
        Path, State,
    },
    http::StatusCode,
    response::{IntoResponse, Redirect},
    routing::{delete, get, post},
    Json, Router,
};
use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    env,
    convert::Infallible,
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{mpsc, RwLock};
use tokio_stream::wrappers::UnboundedReceiverStream;
use tower_http::services::{ServeDir, ServeFile};
use uuid::Uuid;

// ── constants ──────────────────────────────────────────────────────────────────

const MAX_MESSAGES: usize = 500;
const FLOOR_LEASE: Duration = Duration::from_secs(4);
const TLS_CERT: &str = "/etc/pilink/certs/fullchain.pem";
const TLS_KEY: &str = "/etc/pilink/certs/privkey.pem";
const HTTPS_HOST: &str = "pilink.astatide.com";
const OLLAMA_URL: &str = "http://127.0.0.1:11434";
const DEFAULT_OLLAMA_MODEL: &str = "qwen2:0.5b";
const SYSTEM_PROMPT: &str = "You are PI, a helpful on-device assistant inside PILink, created by Soham Bhagat. You answer any question concisely and clearly. You also understand PILink (local Wi-Fi bubble, real-time chat, push-to-talk voice channel, offline-first) and can help troubleshoot it. If the user asks something ambiguous, ask 1-2 clarifying questions. Do not claim end-to-end encryption; the security boundary is the local Wi-Fi password and local-only networking.";

// ── types ──────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Message {
    id: Uuid,
    sender: String,
    content: String,
    timestamp: u64,
}

#[derive(Deserialize)]
struct NewMessage {
    sender: String,
    content: String,
}

#[derive(Deserialize)]
struct AiRequest {
    question: String,
}

#[derive(Deserialize)]
struct AiStreamRequest {
    question: String,
}

#[derive(Serialize)]
struct AiResponse {
    answer: String,
}

#[derive(Serialize)]
struct AiHealth {
    available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    want: Option<String>,
}

#[derive(Serialize)]
struct ErrBody {
    error: String,
}

#[derive(Serialize)]
struct OllamaReq<'a> {
    model: &'a str,
    prompt: &'a str,
    system: &'a str,
    stream: bool,
    options: OllamaOptions,
    keep_alive: &'a str,
}

#[derive(Debug, Serialize)]
struct OllamaOptions {
    num_predict: u32,
}

#[derive(Deserialize)]
struct OllamaRes {
    response: String,
}

#[derive(Deserialize)]
struct OllamaStreamRes {
    #[serde(default)]
    response: String,
    #[serde(default)]
    done: bool,
}

#[derive(Deserialize)]
struct OllamaTags {
    #[serde(default)]
    models: Vec<OllamaTagModel>,
}

#[derive(Deserialize)]
struct OllamaTagModel {
    name: String,
}

/// Incoming WebSocket event envelope.
#[derive(Deserialize)]
struct WsIn {
    #[serde(rename = "type")]
    t: String,
    #[serde(default)]
    payload: Value,
}

// ── state ──────────────────────────────────────────────────────────────────────

struct WsClient {
    tx: mpsc::UnboundedSender<String>,
}

struct FloorHolder {
    id: Uuid,
    name: String,
    deadline: Instant,
}

struct VoiceState {
    participants: HashMap<Uuid, String>, // id → display name
    floor: Option<FloorHolder>,
}

#[derive(Clone)]
struct AppState {
    msgs: Arc<RwLock<Vec<Message>>>,
    clients: Arc<RwLock<HashMap<Uuid, WsClient>>>,
    voice: Arc<RwLock<VoiceState>>,
    http: reqwest::Client,
    ollama_model: String,
}

// ── helpers ────────────────────────────────────────────────────────────────────

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn ev(t: &str, p: Value) -> String {
    serde_json::to_string(&json!({"type": t, "payload": p})).unwrap()
}

fn ev0(t: &str) -> String {
    serde_json::to_string(&json!({"type": t})).unwrap()
}

async fn broadcast(clients: &RwLock<HashMap<Uuid, WsClient>>, msg: &str) {
    // Remove dead clients so we don't leak senders.
    let mut dead: Vec<Uuid> = Vec::new();
    {
        let map = clients.read().await;
        for (id, c) in map.iter() {
            if c.tx.send(msg.into()).is_err() {
                dead.push(*id);
            }
        }
    }
    if !dead.is_empty() {
        let mut map = clients.write().await;
        for id in dead {
            map.remove(&id);
        }
    }
}

async fn unicast(clients: &RwLock<HashMap<Uuid, WsClient>>, id: Uuid, msg: &str) {
    let mut remove = false;
    {
        if let Some(c) = clients.read().await.get(&id) {
            if c.tx.send(msg.into()).is_err() {
                remove = true;
            }
        }
    }
    if remove {
        clients.write().await.remove(&id);
    }
}

async fn broadcast_floor(app: &AppState) {
    let holder = {
        let v = app.voice.read().await;
        v.floor
            .as_ref()
            .map(|f| json!({"id": f.id, "name": f.name}))
    };
    broadcast(
        &app.clients,
        &ev("floor:state", json!({"holder": holder})),
    )
    .await;
}

// ── main ───────────────────────────────────────────────────────────────────────

#[tokio::main(flavor = "current_thread")]
async fn main() {
    // rustls 0.23+ requires an explicit crypto provider selection.
    // We pick ring for broad compatibility and low friction on Raspberry Pi.
    rustls::crypto::ring::default_provider()
        .install_default()
        .expect("install rustls crypto provider");

    let ollama_model = env::var("PILINK_OLLAMA_MODEL").unwrap_or_else(|_| DEFAULT_OLLAMA_MODEL.to_string());

    let app = AppState {
        msgs: Arc::new(RwLock::new(Vec::new())),
        clients: Arc::new(RwLock::new(HashMap::new())),
        voice: Arc::new(RwLock::new(VoiceState {
            participants: HashMap::new(),
            floor: None,
        })),
        http: reqwest::Client::builder()
            .timeout(Duration::from_secs(180))
            .build()
            .expect("http client"),
        ollama_model,
    };

    // Background: expire floor lease every second.
    {
        let app = app.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(1));
            loop {
                tick.tick().await;
                let expired = {
                    let v = app.voice.read().await;
                    v.floor
                        .as_ref()
                        .map_or(false, |f| f.deadline < Instant::now())
                };
                if expired {
                    app.voice.write().await.floor = None;
                    broadcast_floor(&app).await;
                }
            }
        });
    }

    let spa = ServeDir::new("dist").not_found_service(ServeFile::new("dist/index.html"));

    let router = Router::new()
        .route("/health", get(health))
        .route("/api/messages", get(get_msgs).post(post_msg))
        .route("/api/messages/clear", post(clear_msgs))
        .route("/api/messages/:id", delete(del_msg))
        .route("/api/ai", post(ai))
        .route("/api/ai/health", get(ai_health))
        .route("/api/ai/stream", post(ai_stream))
        .route("/api/ws", get(ws_upgrade))
        .with_state(app)
        .fallback_service(spa);

    // If TLS certs exist → production (HTTPS :443 + HTTP redirect :80).
    // Otherwise → dev mode (HTTP :3000, proxied by Vite).
    if std::path::Path::new(TLS_CERT).exists() {
        eprintln!("[pilink] https://{HTTPS_HOST} (:443 + :80 redirect)");

        let tls = axum_server::tls_rustls::RustlsConfig::from_pem_file(TLS_CERT, TLS_KEY)
            .await
            .expect("load TLS certs");

        let redirect = Router::new().fallback(|uri: axum::http::Uri| async move {
            let pq = uri.path_and_query().map(|v| v.as_str()).unwrap_or("/");
            Redirect::permanent(&format!("https://{HTTPS_HOST}{pq}"))
        });

        let h80 = tokio::spawn(async move {
            let l = tokio::net::TcpListener::bind(("0.0.0.0", 80u16))
                .await
                .expect("bind :80");
            axum::serve(l, redirect).await.ok();
        });

        let h443 = tokio::spawn(async move {
            let addr = std::net::SocketAddr::from(([0, 0, 0, 0], 443u16));
            axum_server::bind_rustls(addr, tls)
                .serve(router.into_make_service())
                .await
                .ok();
        });

        let _ = tokio::join!(h80, h443);
    } else {
        eprintln!("[pilink] dev mode → http://127.0.0.1:3000");
        let l = tokio::net::TcpListener::bind(("0.0.0.0", 3000u16))
            .await
            .expect("bind :3000");
        axum::serve(l, router).await.ok();
    }
}

// ── HTTP handlers ──────────────────────────────────────────────────────────────

async fn health() -> &'static str {
    "ok"
}

async fn get_msgs(State(app): State<AppState>) -> Json<Vec<Message>> {
    Json(app.msgs.read().await.clone())
}

async fn post_msg(
    State(app): State<AppState>,
    Json(input): Json<NewMessage>,
) -> impl IntoResponse {
    let msg = Message {
        id: Uuid::new_v4(),
        sender: input.sender.chars().take(32).collect(),
        content: input.content.chars().take(600).collect(),
        timestamp: now(),
    };
    {
        let mut s = app.msgs.write().await;
        s.push(msg.clone());
        let excess = s.len().saturating_sub(MAX_MESSAGES);
        if excess > 0 { s.drain(..excess); }
    }
    broadcast(
        &app.clients,
        &ev("message:new", serde_json::to_value(&msg).unwrap()),
    )
    .await;
    (StatusCode::CREATED, Json(msg))
}

async fn del_msg(State(app): State<AppState>, Path(id): Path<Uuid>) -> StatusCode {
    let found = {
        let mut s = app.msgs.write().await;
        let before = s.len();
        s.retain(|m| m.id != id);
        s.len() < before
    };
    if found {
        broadcast(
            &app.clients,
            &ev("message:delete", json!({"id": id})),
        )
        .await;
        StatusCode::OK
    } else {
        StatusCode::NOT_FOUND
    }
}

async fn clear_msgs(State(app): State<AppState>) -> StatusCode {
    app.msgs.write().await.clear();
    broadcast(&app.clients, &ev0("chat:clear")).await;
    StatusCode::OK
}

async fn ai(State(app): State<AppState>, Json(req): Json<AiRequest>) -> impl IntoResponse {
    let q = req.question.trim().to_string();
    if q.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrBody {
                error: "question required".into(),
            }),
        )
            .into_response();
    }

    let body = OllamaReq {
        model: &app.ollama_model,
        prompt: &q,
        system: SYSTEM_PROMPT,
        stream: false,
        options: OllamaOptions { num_predict: 140 },
        keep_alive: "30m",
    };

    let res = match app
        .http
        .post(format!("{OLLAMA_URL}/api/generate"))
        .json(&body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(ErrBody {
                    error: format!("ollama unreachable: {e}"),
                }),
            )
                .into_response()
        }
    };

    if !res.status().is_success() {
        if res.status() == StatusCode::NOT_FOUND {
            let msg = format!(
                "model '{}' not installed on this node. Fix: ollama pull {}",
                app.ollama_model, app.ollama_model
            );
            return (StatusCode::BAD_GATEWAY, Json(ErrBody { error: msg })).into_response();
        }
        return (
            StatusCode::BAD_GATEWAY,
            Json(ErrBody {
                error: format!("ollama status {}", res.status()),
            }),
        )
            .into_response();
    }

    match res.json::<OllamaRes>().await {
        Ok(o) => (StatusCode::OK, Json(AiResponse { answer: o.response })).into_response(),
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(ErrBody {
                error: format!("parse: {e}"),
            }),
        )
            .into_response(),
    }
}

async fn ai_stream(State(app): State<AppState>, Json(req): Json<AiStreamRequest>) -> impl IntoResponse {
    let q = req.question.trim().to_string();
    if q.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrBody {
                error: "question required".into(),
            }),
        )
            .into_response();
    }

    let body = OllamaReq {
        model: &app.ollama_model,
        prompt: &q,
        system: SYSTEM_PROMPT,
        stream: true,
        options: OllamaOptions { num_predict: 140 },
        keep_alive: "30m",
    };

    let res = match app
        .http
        .post(format!("{OLLAMA_URL}/api/generate"))
        .json(&body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(ErrBody {
                    error: format!("ollama unreachable: {e}"),
                }),
            )
                .into_response();
        }
    };

    if !res.status().is_success() {
        if res.status() == StatusCode::NOT_FOUND {
            let msg = format!(
                "model '{}' not installed on this node. Fix: ollama pull {}",
                app.ollama_model, app.ollama_model
            );
            return (StatusCode::BAD_GATEWAY, Json(ErrBody { error: msg })).into_response();
        }
        return (
            StatusCode::BAD_GATEWAY,
            Json(ErrBody {
                error: format!("ollama status {}", res.status()),
            }),
        )
            .into_response();
    }

    let (tx, rx) = mpsc::unbounded_channel::<Result<bytes::Bytes, Infallible>>();

    tokio::spawn(async move {
        let mut buf: Vec<u8> = Vec::new();
        let mut stream = res.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let Ok(chunk) = chunk else { break };
            buf.extend_from_slice(&chunk);
            while let Some(pos) = buf.iter().position(|b| *b == b'\n') {
                let line = buf.drain(..=pos).collect::<Vec<u8>>();
                let line = match std::str::from_utf8(&line) {
                    Ok(s) => s.trim(),
                    Err(_) => continue,
                };
                if line.is_empty() {
                    continue;
                }
                let Ok(ev) = serde_json::from_str::<OllamaStreamRes>(line) else { continue };
                if !ev.response.is_empty() {
                    let out = json!({"token": ev.response});
                    let _ = tx.send(Ok(bytes::Bytes::from(format!("{}\n", out))));
                }
                if ev.done {
                    let _ = tx.send(Ok(bytes::Bytes::from_static(b"{\"done\":true}\n")));
                    return;
                }
            }
        }
        let _ = tx.send(Ok(bytes::Bytes::from_static(
            b"{\"done\":true}\n",
        )));
    });

    let body = axum::body::Body::from_stream(UnboundedReceiverStream::new(rx));
    (
        StatusCode::OK,
        [(
            axum::http::header::CONTENT_TYPE,
            "application/x-ndjson; charset=utf-8",
        )],
        body,
    )
        .into_response()
}

async fn ai_health(State(app): State<AppState>) -> Json<AiHealth> {
    let want = app.ollama_model.clone();

    let res = app
        .http
        .get(format!("{OLLAMA_URL}/api/tags"))
        .timeout(Duration::from_secs(3))
        .send()
        .await;

    let Ok(res) = res else {
        return Json(AiHealth {
            available: false,
            reason: Some("ollama_down".to_string()),
            want: Some(want),
        });
    };

    if !res.status().is_success() {
        return Json(AiHealth {
            available: false,
            reason: Some("ollama_down".to_string()),
            want: Some(want),
        });
    }

    let tags = res.json::<OllamaTags>().await;
    let Ok(tags) = tags else {
        return Json(AiHealth {
            available: false,
            reason: Some("ollama_down".to_string()),
            want: Some(want),
        });
    };

    let has_model = tags.models.iter().any(|m| m.name == want);
    if has_model {
        Json(AiHealth {
            available: true,
            reason: None,
            want: None,
        })
    } else {
        Json(AiHealth {
            available: false,
            reason: Some("model_missing".to_string()),
            want: Some(want),
        })
    }
}

// ── WebSocket ──────────────────────────────────────────────────────────────────

async fn ws_upgrade(
    ws: WebSocketUpgrade,
    State(app): State<AppState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| ws_session(socket, app))
}

/// One WebSocket session. Splits into a send task (channel → WS) and a receive
/// loop (WS → event handler). Cleans up voice/floor state on disconnect.
async fn ws_session(socket: WebSocket, app: AppState) {
    let (sink, mut stream) = socket.split();
    let (tx, rx) = mpsc::unbounded_channel::<String>();
    let cid = Uuid::new_v4();

    // Register client.
    app.clients
        .write()
        .await
        .insert(cid, WsClient { tx: tx.clone() });

    // Queue initial state through the channel (send task drains these first).
    let _ = tx.send(ev("self:id", json!({"id": cid})));
    {
        let m = app.msgs.read().await;
        let _ = tx.send(ev("history", serde_json::to_value(&*m).unwrap()));
    }
    {
        let v = app.voice.read().await;
        let peers: Vec<Value> = v
            .participants
            .iter()
            .map(|(i, n)| json!({"id": i, "name": n}))
            .collect();
        let _ = tx.send(ev("voice:peers", json!(peers)));
        let holder = v
            .floor
            .as_ref()
            .map(|f| json!({"id": f.id, "name": f.name}));
        let _ = tx.send(ev("floor:state", json!({"holder": holder})));
    }

    // Task: drain channel → WebSocket sink.
    let mut send_task = tokio::spawn(async move {
        let mut rx = rx;
        let mut sink = sink;
        while let Some(msg) = rx.recv().await {
            if sink.send(WsMsg::Text(msg)).await.is_err() {
                break;
            }
        }
    });

    // Task: read WebSocket → event handler.
    let app2 = app.clone();
    let mut recv_task = tokio::spawn(async move {
        while let Some(Ok(frame)) = stream.next().await {
            match frame {
                WsMsg::Text(txt) => {
                    if let Ok(incoming) = serde_json::from_str::<WsIn>(&txt) {
                        handle_ws_event(&app2, cid, incoming).await;
                    }
                }
                WsMsg::Close(_) => break,
                _ => {}
            }
        }
    });

    // When either task ends, cancel the other.
    tokio::select! {
        _ = &mut send_task => recv_task.abort(),
        _ = &mut recv_task => send_task.abort(),
    }

    // ── disconnect cleanup ─────────────────────────────────────────────────
    app.clients.write().await.remove(&cid);

    let was_in_voice = {
        let mut v = app.voice.write().await;
        let was = v.participants.remove(&cid).is_some();
        if was && v.floor.as_ref().map(|f| f.id) == Some(cid) {
            v.floor = None;
        }
        was
    };
    if was_in_voice {
        broadcast(&app.clients, &ev("voice:leave", json!({"id": cid}))).await;
        broadcast_floor(&app).await;
    }
}

/// Dispatch a single incoming WS event.
async fn handle_ws_event(app: &AppState, cid: Uuid, e: WsIn) {
    let p = &e.payload;

    match e.t.as_str() {
        "ping" => {
            unicast(&app.clients, cid, &ev0("pong")).await;
        }
        // ── chat ───────────────────────────────────────────────────────────
        "message:send" => {
            let sender = p.get("sender").and_then(|v| v.as_str()).unwrap_or_default();
            let content = p.get("content").and_then(|v| v.as_str()).unwrap_or_default();
            if sender.is_empty() || content.is_empty() {
                return;
            }
            let msg = Message {
                id: Uuid::new_v4(),
                sender: sender.chars().take(32).collect(),
                content: content.chars().take(600).collect(),
                timestamp: now(),
            };
            {
                let mut s = app.msgs.write().await;
                s.push(msg.clone());
                let excess = s.len().saturating_sub(MAX_MESSAGES);
                if excess > 0 { s.drain(..excess); }
            }
            broadcast(
                &app.clients,
                &ev("message:new", serde_json::to_value(&msg).unwrap()),
            )
            .await;
        }

        "message:delete" => {
            let Some(id) = p
                .get("id")
                .and_then(|v| v.as_str())
                .and_then(|s| s.parse::<Uuid>().ok())
            else {
                return;
            };
            let found = {
                let mut s = app.msgs.write().await;
                let n = s.len();
                s.retain(|m| m.id != id);
                s.len() < n
            };
            if found {
                broadcast(&app.clients, &ev("message:delete", json!({"id": id}))).await;
            }
        }

        "chat:clear" => {
            app.msgs.write().await.clear();
            broadcast(&app.clients, &ev0("chat:clear")).await;
        }

        "typing" => {
            let name = p.get("name").and_then(|v| v.as_str()).unwrap_or_default();
            let is_typing = p.get("typing").and_then(|v| v.as_bool()).unwrap_or(false);
            if name.is_empty() {
                return;
            }
            let msg = ev("typing", json!({"id": cid, "name": name, "typing": is_typing}));
            let mut dead: Vec<Uuid> = Vec::new();
            {
                let map = app.clients.read().await;
                for (id, c) in map.iter() {
                    if *id == cid {
                        continue;
                    }
                    if c.tx.send(msg.clone()).is_err() {
                        dead.push(*id);
                    }
                }
            }
            if !dead.is_empty() {
                let mut map = app.clients.write().await;
                for id in dead {
                    map.remove(&id);
                }
            }
        }

        // ── voice presence ─────────────────────────────────────────────────
        "voice:join" => {
            let name = p
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            if name.is_empty() {
                return;
            }
            let existing: Vec<Value>;
            {
                let mut v = app.voice.write().await;
                if v.participants.contains_key(&cid) {
                    return;
                }
                // Snapshot existing peers *before* inserting self.
                existing = v
                    .participants
                    .iter()
                    .map(|(i, n)| json!({"id": i, "name": n}))
                    .collect();
                v.participants.insert(cid, name.clone());
            }
            // Tell the joiner who else is in channel (they create WebRTC offers).
            unicast(&app.clients, cid, &ev("voice:joined", json!(existing))).await;
            // Tell everyone (including joiner) about the new participant.
            broadcast(
                &app.clients,
                &ev("voice:join", json!({"id": cid, "name": name})),
            )
            .await;
        }

        "voice:leave" => {
            let removed = {
                let mut v = app.voice.write().await;
                let r = v.participants.remove(&cid).is_some();
                if r && v.floor.as_ref().map(|f| f.id) == Some(cid) {
                    v.floor = None;
                }
                r
            };
            if removed {
                broadcast(&app.clients, &ev("voice:leave", json!({"id": cid}))).await;
                broadcast_floor(app).await;
            }
        }

        // ── floor control ──────────────────────────────────────────────────
        "floor:request" => {
            let mut v = app.voice.write().await;
            let Some(name) = v.participants.get(&cid).cloned() else {
                return;
            };
            if v.floor.is_none() {
                v.floor = Some(FloorHolder {
                    id: cid,
                    name,
                    deadline: Instant::now() + FLOOR_LEASE,
                });
                drop(v);
                broadcast_floor(app).await;
            } else {
                drop(v);
                unicast(&app.clients, cid, &ev0("floor:denied")).await;
            }
        }

        "floor:release" => {
            let mut v = app.voice.write().await;
            if v.floor.as_ref().map(|f| f.id) == Some(cid) {
                v.floor = None;
                drop(v);
                broadcast_floor(app).await;
            }
        }

        "floor:heartbeat" => {
            let mut v = app.voice.write().await;
            if let Some(ref mut f) = v.floor {
                if f.id == cid {
                    f.deadline = Instant::now() + FLOOR_LEASE;
                }
            }
        }

        // ── WebRTC signaling relay ─────────────────────────────────────────
        t @ ("webrtc:offer" | "webrtc:answer" | "webrtc:ice") => {
            let Some(to) = p
                .get("to")
                .and_then(|v| v.as_str())
                .and_then(|s| s.parse::<Uuid>().ok())
            else {
                return;
            };
            // Relay payload, replacing "to" with "from".
            let mut relay = serde_json::Map::new();
            if let Value::Object(map) = p {
                for (k, v) in map {
                    if k != "to" {
                        relay.insert(k.clone(), v.clone());
                    }
                }
            }
            relay.insert("from".into(), json!(cid));
            unicast(&app.clients, to, &ev(t, Value::Object(relay))).await;
        }

        _ => {}
    }
}
