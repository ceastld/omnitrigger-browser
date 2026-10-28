use std::io;

#[cfg(windows)]
mod windows {
    use super::*;
    use std::ptr;
    use tokio::net::windows::named_pipe::{
        ClientOptions, NamedPipeClient, NamedPipeServer, ServerOptions,
    };
    use windows_sys::Win32::{
        Foundation::{CloseHandle, LocalFree, HANDLE},
        Security::{
            Authorization::{
                ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
            },
            GetTokenInformation, TokenUser, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER,
        },
        System::Threading::{GetCurrentProcess, OpenProcessToken},
    };

    pub fn current_sid() -> io::Result<String> {
        // TokenUser is read from the current process; both native allocations are released.
        unsafe {
            let mut token: HANDLE = ptr::null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
                return Err(io::Error::last_os_error());
            }
            let result = (|| {
                let mut size = 0;
                GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &mut size);
                if size == 0 {
                    return Err(io::Error::last_os_error());
                }
                // u64 storage ensures TOKEN_USER pointer alignment.
                let mut buffer = vec![0u64; (size as usize).div_ceil(8)];
                if GetTokenInformation(
                    token,
                    TokenUser,
                    buffer.as_mut_ptr().cast(),
                    size,
                    &mut size,
                ) == 0
                {
                    return Err(io::Error::last_os_error());
                }
                let user = &*buffer.as_ptr().cast::<TOKEN_USER>();
                let mut sid = ptr::null_mut();
                if ConvertSidToStringSidW(user.User.Sid, &mut sid) == 0 {
                    return Err(io::Error::last_os_error());
                }
                let mut length = 0;
                while *sid.add(length) != 0 {
                    length += 1;
                }
                let value = String::from_utf16_lossy(std::slice::from_raw_parts(sid, length));
                LocalFree(sid.cast());
                Ok(value)
            })();
            CloseHandle(token);
            result
        }
    }

    pub fn default_pipe() -> io::Result<String> {
        Ok(format!(
            r"\\.\pipe\omnitrigger-browser-v1-{}",
            current_sid()?
        ))
    }

    pub type Client = NamedPipeClient;
    pub type Server = NamedPipeServer;

    pub async fn connect(path: &str) -> io::Result<Client> {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(3);
        loop {
            match ClientOptions::new().open(path) {
                Ok(client) => return Ok(client),
                Err(error)
                    if error.raw_os_error() == Some(231)
                        && tokio::time::Instant::now() < deadline =>
                {
                    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                }
                Err(error) => return Err(error),
            }
        }
    }

    pub fn create(path: &str, first: bool) -> io::Result<Server> {
        let sddl: Vec<u16> = format!("D:P(A;;GA;;;SY)(A;;GA;;;{})\0", current_sid()?)
            .encode_utf16()
            .collect();
        // The descriptor is only borrowed by CreateNamedPipe and is freed immediately afterward.
        unsafe {
            let mut descriptor = ptr::null_mut();
            if ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                1,
                &mut descriptor,
                ptr::null_mut(),
            ) == 0
            {
                return Err(io::Error::last_os_error());
            }
            let attributes = SECURITY_ATTRIBUTES {
                nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: descriptor,
                bInheritHandle: 0,
            };
            let result = ServerOptions::new()
                .first_pipe_instance(first)
                .reject_remote_clients(true)
                .create_with_security_attributes_raw(
                    path,
                    (&attributes as *const SECURITY_ATTRIBUTES)
                        .cast_mut()
                        .cast(),
                );
            LocalFree(descriptor);
            result
        }
    }
}

#[cfg(windows)]
pub use windows::*;

#[cfg(not(windows))]
pub fn default_pipe() -> io::Result<String> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "本原型的本机连接目前仅支持 Windows",
    ))
}
