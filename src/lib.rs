pub mod broker;
pub mod client;
pub mod framing;
pub mod platform;
pub mod registration;

use serde_json::{json, Value};
use std::{io, path::PathBuf};

pub const MAX_FRAME: usize = 256 * 1024;
pub const MAX_RESULT: usize = 32 * 1024 * 1024;
pub const CHUNK_BYTES: usize = 128 * 1024;
pub const CAPACITY: usize = 8;

pub fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}

pub fn failure(id: &str, code: &str, message: &str, dispatched: bool) -> Value {
    json!({"v":1,"type":"result","id":id,"ok":false,"error":{
        "code":code,"message":message,"effect_state":if dispatched {"unknown"} else {"not_started"}
    }})
}

pub fn config_path() -> PathBuf {
    if let Some(path) = std::env::var_os("OMNITRIGGER_BROWSER_CONFIG") {
        return path.into();
    }
    PathBuf::from(std::env::var_os("LOCALAPPDATA").unwrap_or_else(|| ".".into()))
        .join("OmniTriggerBrowser/connection.json")
}

pub fn configured_pipe() -> io::Result<String> {
    if let Ok(pipe) = std::env::var("OMNITRIGGER_BROWSER_PIPE") {
        return Ok(pipe);
    }
    let path = config_path();
    match std::fs::read(path) {
        Ok(bytes) => {
            if bytes.len() > 64 * 1024 {
                return Err(invalid("连接配置过大"));
            }
            let config: Value = serde_json::from_slice(&bytes)?;
            config["pipe"]
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| invalid("连接配置缺少 pipe"))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => platform::default_pipe(),
        Err(error) => Err(error),
    }
}
