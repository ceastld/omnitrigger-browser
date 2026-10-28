#![cfg_attr(windows, windows_subsystem = "windows")]

#[cfg(windows)]
#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("Native Host：{error}");
        std::process::exit(1);
    }
}

#[cfg(windows)]
async fn run() -> Result<(), Box<dyn std::error::Error>> {
    use omnitrigger_browser::{config_path, framing, invalid, platform};
    use serde_json::Value;
    use std::time::Duration;
    let origin = std::env::args()
        .nth(1)
        .ok_or("Native Host 只能由 Chrome 启动")?;
    let adjacent = std::env::current_exe()?.with_file_name("connection.json");
    let path = if std::env::var_os("OMNITRIGGER_BROWSER_CONFIG").is_some() || !adjacent.is_file() {
        config_path()
    } else {
        adjacent
    };
    let config: Value = serde_json::from_slice(&std::fs::read(path)?)?;
    let id = origin
        .strip_prefix("chrome-extension://")
        .and_then(|s| s.strip_suffix('/'))
        .ok_or("扩展来源无效")?;
    if id.len() != 32
        || !id.bytes().all(|b| (b'a'..=b'p').contains(&b))
        || !config["extension_ids"]
            .as_array()
            .is_some_and(|ids| ids.iter().any(|value| value == id))
    {
        return Err("扩展来源不在安装配置中".into());
    }
    // Dedicated std threads avoid Tokio stdin's uninterruptible runtime-shutdown wait.
    let (input_tx, mut input_rx) = tokio::sync::mpsc::channel(8);
    std::thread::spawn(move || {
        let mut input = std::io::stdin().lock();
        while let Ok(message) = framing::read_sync(&mut input) {
            if input_tx.blocking_send(message).is_err() {
                break;
            }
        }
    });
    let (output_tx, mut output_rx) = tokio::sync::mpsc::channel::<Value>(8);
    std::thread::spawn(move || {
        let mut output = std::io::stdout().lock();
        while let Some(message) = output_rx.blocking_recv() {
            if framing::write_sync(&mut output, &message).is_err() {
                break;
            }
        }
    });
    let hello = tokio::time::timeout(Duration::from_secs(5), input_rx.recv())
        .await?
        .ok_or("扩展未发送握手")?;
    if hello["v"] != 1 || hello["type"] != "hello" || hello["role"] != "extension" {
        return Err(invalid("扩展握手无效").into());
    }
    let pipe = config["pipe"].as_str().ok_or("连接配置缺少 pipe")?;
    let mut stream = platform::connect(pipe).await?;
    framing::write(&mut stream, &hello).await?;
    let hello = tokio::time::timeout(Duration::from_secs(5), framing::read(&mut stream)).await??;
    output_tx.send(hello).await?;
    let (mut reader, mut writer) = tokio::io::split(stream);
    let to_native = async {
        loop {
            let message = framing::read(&mut reader).await?;
            tokio::time::timeout(Duration::from_secs(5), output_tx.send(message))
                .await?
                .map_err(|_| invalid("Native 输出队列已关闭"))?;
        }
        #[allow(unreachable_code)]
        Ok::<(), std::io::Error>(())
    };
    let to_pipe = async {
        while let Some(message) = input_rx.recv().await {
            tokio::time::timeout(
                Duration::from_secs(5),
                framing::write(&mut writer, &message),
            )
            .await??;
        }
        Ok::<(), std::io::Error>(())
    };
    tokio::select! { r = to_native => r?, r = to_pipe => r? }
    Ok(())
}

#[cfg(not(windows))]
fn main() {
    eprintln!("Native Host 当前仅支持 Windows");
    std::process::exit(1);
}
