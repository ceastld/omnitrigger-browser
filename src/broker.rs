use crate::{failure, framing, invalid, CAPACITY, MAX_RESULT};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncRead, AsyncWrite},
    sync::{mpsc, Semaphore},
};

type PeerId = u64;
struct Peer {
    tx: mpsc::Sender<Value>,
    profile: Option<Value>,
}
struct Pending {
    client: PeerId,
    original: String,
    extension: PeerId,
    session: String,
    deadline: Instant,
}
#[derive(Default)]
struct State {
    peers: HashMap<PeerId, Peer>,
    pending: HashMap<String, Pending>,
    next: u64,
}

fn text<'a>(value: &'a Value, field: &str) -> &'a str {
    value[field].as_str().unwrap_or("")
}
fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128
}

impl State {
    fn send(&self, peer: PeerId, message: Value) -> bool {
        self.peers
            .get(&peer)
            .is_some_and(|p| p.tx.try_send(message).is_ok())
    }

    fn drop_peer(&mut self, peer: PeerId) {
        self.peers.remove(&peer);
        let ids: Vec<_> = self
            .pending
            .iter()
            .filter(|(_, p)| p.client == peer || p.extension == peer)
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            let p = self.pending.remove(&id).unwrap();
            if p.client == peer {
                self.send(p.extension, json!({"v":1,"type":"cancel","id":id}));
            } else {
                self.send(
                    p.client,
                    failure(
                        &p.original,
                        "result_unknown",
                        "扩展连接中断，已派发调用结果未知",
                        true,
                    ),
                );
            }
        }
    }

    fn expire(&mut self) {
        let now = Instant::now();
        let ids: Vec<_> = self
            .pending
            .iter()
            .filter(|(_, p)| p.deadline <= now)
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            let p = self.pending.remove(&id).unwrap();
            self.send(p.extension, json!({"v":1,"type":"cancel","id":id}));
            self.send(
                p.client,
                failure(
                    &p.original,
                    "result_unknown",
                    "已派发调用超时，结果未知；没有自动重试",
                    true,
                ),
            );
        }
    }

    fn client_message(&mut self, peer: PeerId, message: Value) {
        let id = text(&message, "id");
        if message["v"] != 1 || !valid_id(id) {
            self.send(
                peer,
                failure(id, "invalid_request", "协议版本或请求 ID 无效", false),
            );
            return;
        }
        match text(&message, "type") {
            "profiles" => {
                let profiles: Vec<_> = self
                    .peers
                    .values()
                    .filter_map(|p| p.profile.clone())
                    .collect();
                self.send(peer, json!({"v":1,"type":"result","id":id,"ok":true,"has_value":true,"value":profiles}));
            }
            "call" => self.call(peer, message),
            "result.ack" | "cancel" => {
                let remote = self
                    .pending
                    .iter()
                    .find(|(_, p)| p.client == peer && p.original == id)
                    .map(|(id, p)| (id.clone(), p.extension));
                if let Some((remote, extension)) = remote {
                    let cancel = message["type"] == "cancel";
                    let mut message = message;
                    message["id"] = remote.clone().into();
                    self.send(extension, message);
                    if cancel {
                        self.pending.remove(&remote);
                    }
                }
            }
            _ => {
                self.send(
                    peer,
                    failure(id, "invalid_request", "不支持的客户端消息", false),
                );
            }
        }
    }

    fn call(&mut self, peer: PeerId, mut message: Value) {
        let original = text(&message, "id").to_owned();
        let method = text(&message, "method");
        let ms = message
            .get("timeout_ms")
            .and_then(Value::as_u64)
            .unwrap_or(10_000);
        if method.is_empty()
            || method.len() > 256
            || !message["args"].is_array()
            || ms == 0
            || ms > 60_000
            || message
                .get("timeout_ms")
                .is_some_and(|v| v.as_u64().is_none())
        {
            self.send(
                peer,
                failure(
                    &original,
                    "invalid_request",
                    "方法、参数数组或超时无效",
                    false,
                ),
            );
            return;
        }
        if self.pending.len() >= CAPACITY
            || self
                .pending
                .values()
                .any(|p| p.client == peer && p.original == original)
        {
            self.send(
                peer,
                failure(&original, "busy", "请求 ID 重复或全局 8 项配额已满", false),
            );
            return;
        }
        let requested = text(&message, "browser_instance_id");
        let matching: Vec<_> = self
            .peers
            .iter()
            .filter(|(_, p)| {
                p.profile.as_ref().is_some_and(|profile| {
                    requested.is_empty() || profile["browser_instance_id"] == requested
                })
            })
            .map(|(id, _)| *id)
            .collect();
        if matching.len() != 1 {
            let (code, description) = if matching.is_empty() {
                ("not_connected", "指定浏览器尚未连接")
            } else {
                (
                    "target_ambiguous",
                    "多个浏览器已连接，请指定 browser_instance_id",
                )
            };
            self.send(peer, failure(&original, code, description, false));
            return;
        }
        let extension = matching[0];
        let profile = self.peers[&extension].profile.as_ref().unwrap();
        let session = text(profile, "session_id").to_owned();
        if message.get("session_id").is_some_and(|v| v != &session) {
            self.send(
                peer,
                failure(&original, "not_connected", "浏览器会话已变化", false),
            );
            return;
        }
        self.next += 1;
        let remote = format!("bridge:{}", self.next);
        message["id"] = remote.clone().into();
        message["session_id"] = session.clone().into();
        message["browser_instance_id"] = profile["browser_instance_id"].clone();
        if framing::encode(&message).is_err() {
            self.send(
                peer,
                failure(
                    &original,
                    "payload_too_large",
                    "转发信封使请求超过 256 KiB",
                    false,
                ),
            );
            return;
        }
        if self.send(extension, message) {
            self.pending.insert(
                remote,
                Pending {
                    client: peer,
                    original,
                    extension,
                    session,
                    deadline: Instant::now() + Duration::from_millis(ms),
                },
            );
        } else {
            self.send(
                peer,
                failure(&original, "busy", "扩展发送队列不可用", false),
            );
        }
    }

    fn extension_message(&mut self, peer: PeerId, mut message: Value) -> io::Result<()> {
        if message["v"] != 1 {
            return Err(invalid("扩展协议版本无效"));
        }
        let id = text(&message, "id").to_owned();
        let Some(pending) = self.pending.get(&id) else {
            return Ok(());
        };
        if pending.extension != peer || message["session_id"] != pending.session {
            return Err(invalid("扩展结果会话身份不匹配"));
        }
        let kind = text(&message, "type");
        if !matches!(
            kind,
            "result" | "result.begin" | "result.chunk" | "result.end"
        ) {
            return Err(invalid("不支持的扩展结果类型"));
        }
        if kind == "result.begin"
            && message["total_bytes"]
                .as_u64()
                .is_none_or(|v| v > MAX_RESULT as u64)
        {
            return Err(invalid("扩展结果超过总大小限制"));
        }
        let terminal = matches!(kind, "result" | "result.end");
        let client = pending.client;
        message["id"] = pending.original.clone().into();
        if framing::encode(&message).is_err() {
            self.send(
                client,
                failure(
                    text(&message, "id"),
                    "payload_too_large",
                    "还原请求身份后结果帧过大",
                    true,
                ),
            );
            self.send(peer, json!({"v":1,"type":"cancel","id":id}));
            self.pending.remove(&id);
            return Ok(());
        }
        if !self.send(client, message) {
            self.send(peer, json!({"v":1,"type":"cancel","id":id}));
            self.pending.remove(&id);
        } else if terminal {
            self.pending.remove(&id);
        }
        Ok(())
    }
}

async fn handle<S: AsyncRead + AsyncWrite + Unpin>(
    mut stream: S,
    peer: PeerId,
    state: Arc<Mutex<State>>,
) -> io::Result<()> {
    let hello = tokio::time::timeout(Duration::from_secs(5), framing::read(&mut stream)).await??;
    let role = text(&hello, "role");
    if hello["v"] != 1 || hello["type"] != "hello" || !matches!(role, "client" | "extension") {
        return Err(invalid("握手无效"));
    }
    let profile = if role == "extension" {
        if !valid_id(text(&hello, "browser_instance_id")) || !valid_id(text(&hello, "session_id")) {
            return Err(invalid("扩展身份无效"));
        }
        Some(
            json!({"browser_instance_id":hello["browser_instance_id"],"session_id":hello["session_id"],"name":hello["name"],"capabilities":hello["capabilities"]}),
        )
    } else {
        None
    };
    let extension = profile.is_some();
    let (tx, mut rx) = mpsc::channel::<Value>(16);
    tx.try_send(json!({"v":1,"type":"hello","ok":true}))
        .map_err(|_| invalid("握手队列不可用"))?;
    {
        let mut s = state.lock().unwrap();
        if profile.as_ref().is_some_and(|profile| {
            s.peers.values().any(|p| {
                p.profile
                    .as_ref()
                    .is_some_and(|p| p["browser_instance_id"] == profile["browser_instance_id"])
            })
        }) {
            return Err(invalid("浏览器身份重复"));
        }
        s.peers.insert(peer, Peer { tx, profile });
    }
    let (mut reader, mut writer) = tokio::io::split(stream);
    let incoming = async {
        loop {
            let message = framing::read(&mut reader).await?;
            let mut state = state.lock().unwrap();
            if extension {
                state.extension_message(peer, message)?;
            } else {
                state.client_message(peer, message);
            }
        }
        #[allow(unreachable_code)]
        Ok::<(), io::Error>(())
    };
    let outgoing = async {
        while let Some(message) = rx.recv().await {
            tokio::time::timeout(
                Duration::from_secs(5),
                framing::write(&mut writer, &message),
            )
            .await??;
        }
        Ok::<(), io::Error>(())
    };
    let result = tokio::select! { r = incoming => r, r = outgoing => r };
    state.lock().unwrap().drop_peer(peer);
    result
}

#[cfg(windows)]
pub async fn serve(path: &str) -> io::Result<()> {
    let state = Arc::new(Mutex::new(State::default()));
    let capacity = Arc::new(Semaphore::new(32));
    let sweep = state.clone();
    let sweeper = tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(50));
        loop {
            interval.tick().await;
            sweep.lock().unwrap().expire();
        }
    });
    let result = async {
        let mut listener = crate::platform::create(path, true)?;
        eprintln!("Chrome API bridge 已监听 {path}");
        let mut peer = 0;
        loop {
            tokio::select! { result = listener.connect() => result?, _ = tokio::signal::ctrl_c() => break Ok(()) }
            let next = crate::platform::create(path, false)?;
            let stream = std::mem::replace(&mut listener, next);
            let Ok(permit) = capacity.clone().try_acquire_owned() else { drop(stream); continue; };
            peer += 1;
            let state = state.clone();
            tokio::spawn(async move { let _permit = permit; if let Err(error) = handle(stream, peer, state).await {
                if error.kind() != io::ErrorKind::UnexpectedEof && error.kind() != io::ErrorKind::BrokenPipe { eprintln!("连接结束：{error}"); }
            }});
        }
    }.await;
    sweeper.abort();
    result
}

#[cfg(not(windows))]
pub async fn serve(_: &str) -> io::Result<()> {
    Err(invalid("本机服务目前仅支持 Windows"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn peer(state: &mut State, id: u64, profile: Option<Value>) -> mpsc::Receiver<Value> {
        let (tx, rx) = mpsc::channel(16);
        state.peers.insert(id, Peer { tx, profile });
        rx
    }
    fn profile(id: &str) -> Value {
        json!({"browser_instance_id":id,"session_id":"s"})
    }

    #[test]
    fn routes_and_restores_request_identity() {
        let mut s = State::default();
        let mut client = peer(&mut s, 1, None);
        let mut extension = peer(&mut s, 2, Some(profile("p")));
        s.client_message(
            1,
            json!({"v":1,"type":"call","id":"local","method":"bookmarks.getTree","args":[]}),
        );
        let remote = extension.try_recv().unwrap();
        assert_ne!(remote["id"], "local");
        s.extension_message(
            2,
            json!({"v":1,"type":"result","id":remote["id"],"session_id":"s","ok":true,"value":[]}),
        )
        .unwrap();
        assert_eq!(client.try_recv().unwrap()["id"], "local");
        assert!(s.pending.is_empty());
    }

    #[test]
    fn refuses_ambiguous_profile_and_isolates_late_results() {
        let mut s = State::default();
        let mut client = peer(&mut s, 1, None);
        let _a = peer(&mut s, 2, Some(profile("a")));
        let _b = peer(&mut s, 3, Some(profile("b")));
        s.client_message(
            1,
            json!({"v":1,"type":"call","id":"x","method":"bookmarks.getTree","args":[]}),
        );
        assert_eq!(
            client.try_recv().unwrap()["error"]["code"],
            "target_ambiguous"
        );
        s.client_message(1, json!({"v":1,"type":"call","id":"x","browser_instance_id":"a","method":"bookmarks.getTree","args":[]}));
        s.drop_peer(2);
        assert_eq!(
            client.try_recv().unwrap()["error"]["code"],
            "result_unknown"
        );
        s.extension_message(
            3,
            json!({"v":1,"type":"result","id":"bridge:1","session_id":"s","ok":true}),
        )
        .unwrap();
        assert!(client.try_recv().is_err());
    }
}
