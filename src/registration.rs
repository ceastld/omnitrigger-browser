//! Native Host 配置与当前用户注册；网络和桥接服务启动由调用方管理。
use serde::Serialize;
use serde_json::Value;
use std::{fmt, path::Path};

#[derive(Debug, Serialize)]
pub struct RegistrationError {
    pub code: String,
    pub message: String,
}

impl fmt::Display for RegistrationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for RegistrationError {}

fn error(code: &str, message: impl Into<String>) -> RegistrationError {
    RegistrationError {
        code: code.into(),
        message: message.into(),
    }
}

fn validate_ids(ids: &[String]) -> Result<(), RegistrationError> {
    if ids.len() > 32
        || ids
            .iter()
            .any(|id| id.len() != 32 || !id.bytes().all(|byte| (b'a'..=b'p').contains(&byte)))
    {
        return Err(error(
            "invalid_extension_id",
            "扩展 ID 必须为 32 位小写 a 到 p 字符，数量不能超过 32",
        ));
    }
    Ok(())
}

pub fn configure(
    directory: &Path,
    extension_ids: &[String],
    pipe: Option<&str>,
) -> Result<Value, RegistrationError> {
    validate_ids(extension_ids)?;
    let default;
    let pipe = match pipe {
        Some(pipe) => pipe,
        None => {
            default = crate::platform::default_pipe()
                .map_err(|issue| error("platform_error", issue.to_string()))?;
            &default
        }
    };
    run("Configure", directory, extension_ids, Some(pipe))
}

pub fn status(directory: &Path) -> Result<Value, RegistrationError> {
    run("Status", directory, &[], None)
}

pub fn unregister(directory: &Path) -> Result<Value, RegistrationError> {
    run("Unregister", directory, &[], None)
}

#[cfg(windows)]
fn run(
    mode: &str,
    directory: &Path,
    ids: &[String],
    pipe: Option<&str>,
) -> Result<Value, RegistrationError> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use std::{
        os::windows::process::CommandExt,
        process::{Command, Stdio},
    };
    const SCRIPT: &str = include_str!("../installer/register-native-host.ps1");
    let script: Vec<u8> = SCRIPT
        .trim_start_matches('\u{feff}')
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect();
    let output = Command::new("powershell.exe")
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-EncodedCommand",
        ])
        .arg(STANDARD.encode(script))
        .env("OMNITRIGGER_REGISTRATION_MODE", mode)
        .env("OMNITRIGGER_REGISTRATION_DIRECTORY", directory)
        .env(
            "OMNITRIGGER_REGISTRATION_IDS",
            serde_json::to_string(ids).expect("serializable IDs"),
        )
        .env("OMNITRIGGER_REGISTRATION_PIPE", pipe.unwrap_or(""))
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(0x0800_0000)
        .output()
        .map_err(|issue| {
            error(
                "registration_process",
                format!("无法运行 Native Host 注册器：{issue}"),
            )
        })?;
    if output.stdout.len() > 128 * 1024 {
        return Err(error("invalid_response", "注册器响应过大"));
    }
    let result: Value = serde_json::from_slice(&output.stdout).map_err(|issue| {
        error(
            "invalid_response",
            format!("注册器未返回有效 JSON：{issue}"),
        )
    })?;
    if output.status.success() && result["ok"] == true && result["state"].is_object() {
        Ok(result["state"].clone())
    } else {
        Err(error(
            result["error"]["code"]
                .as_str()
                .unwrap_or("registration_failed"),
            result["error"]["message"]
                .as_str()
                .unwrap_or("Native Host 注册失败"),
        ))
    }
}

#[cfg(not(windows))]
fn run(_: &str, _: &Path, _: &[String], _: Option<&str>) -> Result<Value, RegistrationError> {
    Err(error(
        "unsupported_platform",
        "Native Host 注册目前仅支持 Windows",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extension_ids_are_validated_before_any_registration() {
        assert!(validate_ids(&[]).is_ok());
        assert!(validate_ids(&["a".repeat(32), "p".repeat(32)]).is_ok());
        for id in [
            "a".repeat(31),
            "a".repeat(33),
            "A".repeat(32),
            "q".repeat(32),
            "../other".into(),
        ] {
            assert_eq!(
                validate_ids(&[id]).unwrap_err().code,
                "invalid_extension_id"
            );
        }
        assert!(validate_ids(&vec!["a".repeat(32); 33]).is_err());
    }
}
