#![cfg(windows)]
use crate::{framing, invalid, platform, CHUNK_BYTES, MAX_RESULT};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{fmt, io, time::Duration};

#[derive(Debug, Serialize, Deserialize)]
pub struct RpcError {
    pub code: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effect_state: Option<String>,
}
impl fmt::Display for RpcError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for RpcError {}
impl From<io::Error> for RpcError {
    fn from(error: io::Error) -> Self {
        Self {
            code: "transport_error".into(),
            message: error.to_string(),
            effect_state: None,
        }
    }
}

/// A sequential Rust connection. Independent connections and JS SDK support concurrent calls.
pub struct BrowserClient {
    stream: Option<platform::Client>,
    next: u64,
    profile: Option<String>,
}

impl BrowserClient {
    pub async fn connect(pipe: &str, profile: Option<String>) -> Result<Self, RpcError> {
        let mut stream = platform::connect(pipe).await?;
        framing::write(&mut stream, &json!({"v":1,"type":"hello","role":"client"})).await?;
        let hello = tokio::time::timeout(Duration::from_secs(5), framing::read(&mut stream))
            .await
            .map_err(|_| invalid("连接握手超时"))??;
        if hello["v"] != 1 || hello["type"] != "hello" || hello["ok"] != true {
            return Err(invalid("bridge 握手失败").into());
        }
        Ok(Self {
            stream: Some(stream),
            next: 0,
            profile,
        })
    }

    pub async fn profiles(&mut self) -> Result<Value, RpcError> {
        self.request(json!({"v":1,"type":"profiles"}), 5000).await
    }

    pub async fn call(
        &mut self,
        method: &str,
        args: Value,
        timeout_ms: u64,
    ) -> Result<Value, RpcError> {
        if !args.is_array() || !(1..=60_000).contains(&timeout_ms) {
            return Err(invalid("参数必须是 JSON 数组，超时为 1..60000 毫秒").into());
        }
        let mut call =
            json!({"v":1,"type":"call","method":method,"args":args,"timeout_ms":timeout_ms});
        if let Some(profile) = &self.profile {
            call["browser_instance_id"] = profile.clone().into();
        }
        self.request(call, timeout_ms + 1000).await
    }

    async fn request(&mut self, mut message: Value, timeout_ms: u64) -> Result<Value, RpcError> {
        self.next += 1;
        let id = format!("rust:{}", self.next);
        message["id"] = id.clone().into();
        let stream = self.stream.as_mut().ok_or_else(|| invalid("连接已关闭"))?;
        framing::encode(&message)?;
        let is_call = message["type"] == "call";
        let result = tokio::time::timeout(Duration::from_millis(timeout_ms), async {
            framing::write(stream, &message).await?;
            receive(stream, &id).await
        })
        .await;
        // A cancelled read_exact may have consumed a partial frame: never reuse this transport.
        match result {
            Ok(Ok(response)) if response["ok"] == true => Ok(if response["has_value"] == true {
                response["value"].clone()
            } else {
                Value::Null
            }),
            Ok(Ok(response)) => Err(serde_json::from_value(response["error"].clone())
                .unwrap_or_else(|_| RpcError::from(invalid("错误回执格式无效")))),
            Ok(Err(error)) => {
                self.stream = None;
                if is_call {
                    Err(RpcError {
                        code: "result_unknown".into(),
                        message: error.to_string(),
                        effect_state: Some("unknown".into()),
                    })
                } else {
                    Err(error.into())
                }
            }
            Err(_) => {
                self.stream = None;
                Err(RpcError {
                    code: "result_unknown".into(),
                    message: "调用超时，连接已关闭，未自动重试".into(),
                    effect_state: Some("unknown".into()),
                })
            }
        }
    }
}

async fn receive(stream: &mut platform::Client, id: &str) -> io::Result<Value> {
    let mut assembly: Option<(usize, usize, usize, String, Vec<u8>)> = None;
    loop {
        let message = framing::read(stream).await?;
        if message["v"] != 1 || message["id"] != id {
            return Err(invalid("响应身份不匹配"));
        }
        match message["type"].as_str().unwrap_or("") {
            "result" => return Ok(message),
            "result.begin" if assembly.is_none() => {
                let total = message["total_bytes"]
                    .as_u64()
                    .ok_or_else(|| invalid("结果总长无效"))? as usize;
                let count = message["chunk_count"]
                    .as_u64()
                    .ok_or_else(|| invalid("结果块数无效"))? as usize;
                let session = message["session_id"]
                    .as_str()
                    .ok_or_else(|| invalid("缺少响应会话"))?
                    .to_owned();
                if total == 0 || total > MAX_RESULT || count == 0 || count > 4096 {
                    return Err(invalid("分块结果超过限制"));
                }
                assembly = Some((total, count, 0, session, Vec::with_capacity(total)));
            }
            "result.chunk" => {
                let Some((total, count, index, session, bytes)) = assembly.as_mut() else {
                    return Err(invalid("分块结果缺少 begin"));
                };
                if message["index"].as_u64() != Some(*index as u64)
                    || message["session_id"] != *session
                    || *index >= *count
                {
                    return Err(invalid("分块顺序或会话无效"));
                }
                let chunk = STANDARD
                    .decode(
                        message["data"]
                            .as_str()
                            .ok_or_else(|| invalid("分块内容无效"))?,
                    )
                    .map_err(|_| invalid("分块 base64 无效"))?;
                if chunk.is_empty()
                    || chunk.len() > CHUNK_BYTES
                    || bytes.len() + chunk.len() > *total
                {
                    return Err(invalid("分块大小无效"));
                }
                bytes.extend_from_slice(&chunk);
                framing::write(
                    stream,
                    &json!({"v":1,"type":"result.ack","id":id,"index":*index}),
                )
                .await?;
                *index += 1;
            }
            "result.end" => {
                let Some((total, count, index, session, bytes)) = assembly.take() else {
                    return Err(invalid("结果缺少 begin"));
                };
                if total != bytes.len() || count != index || message["session_id"] != session {
                    return Err(invalid("分块结果不完整"));
                }
                let value: Value = serde_json::from_slice(&bytes)?;
                return Ok(
                    json!({"v":1,"type":"result","id":id,"ok":true,"has_value":true,"value":value}),
                );
            }
            _ => return Err(invalid("未知结果消息")),
        }
    }
}
