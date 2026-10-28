#[cfg(windows)]
#[tokio::main]
async fn main() {
    use omnitrigger_browser::{
        broker, client::BrowserClient, configured_pipe, platform, registration,
    };
    use serde_json::Value;
    let result: Result<(), Box<dyn std::error::Error>> = async {
        let mut args: Vec<String> = std::env::args().skip(1).collect();
        let mut option = |name: &str| -> Result<Option<String>, Box<dyn std::error::Error>> {
            if let Some(index) = args.iter().position(|arg| arg == name) {
                if index + 1 >= args.len() { return Err(format!("{name} 缺少参数").into()); }
                let value = args.remove(index + 1); args.remove(index); Ok(Some(value))
            } else { Ok(None) }
        };
        let pipe = option("--pipe")?;
        let profile = option("--profile")?;
        let timeout = option("--timeout-ms")?.map(|v| v.parse::<u64>()).transpose()?.unwrap_or(10_000);
        let install_dir = option("--install-dir")?;
        let extension_id = option("--extension-id")?;
        let command = args.first().map(String::as_str).unwrap_or("help");
        if command == "endpoint" { println!("{}", platform::default_pipe()?); return Ok(()); }
        if command == "help" || command == "--help" || command == "-h" {
            println!("OmniTrigger Browser 0.1.0\n\n  serve [--pipe PATH]\n  profiles [--pipe PATH]\n  call METHOD ARGS_JSON [--profile ID] [--timeout-ms 10000] [--pipe PATH]\n  register --extension-id ID[,ID] [--install-dir DIR] [--pipe PATH]\n  configure [--extension-id ID[,ID]] [--install-dir DIR] [--pipe PATH]\n  unregister [--install-dir DIR]\n  registration-status [--install-dir DIR]\n  endpoint\n\n例如：call bookmarks.getTree '[]'\n当前为 Windows 开发原型；调用真实浏览器 API，不自动重试。");
            return Ok(());
        }
        if matches!(command, "configure" | "register" | "unregister" | "registration-status") {
            let directory = install_dir.map(std::path::PathBuf::from).unwrap_or(std::env::current_exe()?.parent().ok_or("无法定位连接器目录")?.to_path_buf());
            let ids: Vec<String> = extension_id.as_deref().unwrap_or("").split(',').filter(|s| !s.is_empty()).map(str::to_owned).collect();
            if command == "register" && ids.is_empty() { return Err("register 需要 --extension-id".into()); }
            let state = match command {
                "configure" | "register" => registration::configure(&directory, &ids, pipe.as_deref())?,
                "unregister" => registration::unregister(&directory)?,
                _ => registration::status(&directory)?,
            };
            println!("{}", serde_json::to_string(&state)?);
            return Ok(());
        }
        let pipe = pipe.map(Ok).unwrap_or_else(configured_pipe)?;
        if command == "serve" { broker::serve(&pipe).await?; return Ok(()); }
        let mut client = BrowserClient::connect(&pipe, profile).await?;
        let result = match command {
            "profiles" => client.profiles().await?,
            "call" if args.len() == 3 => {
                let input: Value = serde_json::from_str(&args[2])?;
                client.call(&args[1], input, timeout).await?
            }
            _ => return Err("命令或参数无效；运行 --help 查看用法".into()),
        };
        println!("{}", serde_json::to_string(&result)?);
        // JSON stdout is suitable for piping; diagnostics stay on stderr.
        Ok(())
    }.await;
    if let Err(error) = result {
        let details = error
            .downcast_ref::<omnitrigger_browser::client::RpcError>()
            .map(|error| serde_json::to_value(error).expect("serializable RPC error"))
            .or_else(|| {
                error
                    .downcast_ref::<registration::RegistrationError>()
                    .map(|error| {
                        serde_json::to_value(error).expect("serializable registration error")
                    })
            })
            .unwrap_or_else(
                || serde_json::json!({"code":"client_error","message":error.to_string()}),
            );
        eprintln!("{}", serde_json::json!({"ok":false,"error":details}));
        std::process::exit(1);
    }
}

#[cfg(not(windows))]
fn main() {
    eprintln!("本原型的本机连接目前仅支持 Windows");
    std::process::exit(1);
}
