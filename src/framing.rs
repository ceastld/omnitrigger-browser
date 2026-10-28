use crate::{invalid, MAX_FRAME};
use serde_json::Value;
use std::io::{self, Read, Write};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

fn length(bytes: [u8; 4]) -> io::Result<usize> {
    let length = u32::from_le_bytes(bytes) as usize;
    if length == 0 || length > MAX_FRAME {
        return Err(invalid("消息帧长度无效或超过 256 KiB"));
    }
    Ok(length)
}

pub fn encode(value: &Value) -> io::Result<Vec<u8>> {
    let bytes = serde_json::to_vec(value)?;
    if bytes.is_empty() || bytes.len() > MAX_FRAME {
        return Err(invalid("消息帧超过 256 KiB"));
    }
    let mut frame = Vec::with_capacity(bytes.len() + 4);
    frame.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
    frame.extend_from_slice(&bytes);
    Ok(frame)
}

pub async fn read<R: AsyncRead + Unpin>(reader: &mut R) -> io::Result<Value> {
    let mut header = [0; 4];
    reader.read_exact(&mut header).await?;
    let mut bytes = vec![0; length(header)?];
    reader.read_exact(&mut bytes).await?;
    Ok(serde_json::from_slice(&bytes)?)
}

pub async fn write<W: AsyncWrite + Unpin>(writer: &mut W, value: &Value) -> io::Result<()> {
    writer.write_all(&encode(value)?).await?;
    writer.flush().await
}

pub fn read_sync<R: Read>(reader: &mut R) -> io::Result<Value> {
    let mut header = [0; 4];
    reader.read_exact(&mut header)?;
    let mut bytes = vec![0; length(header)?];
    reader.read_exact(&mut bytes)?;
    Ok(serde_json::from_slice(&bytes)?)
}

pub fn write_sync<W: Write>(writer: &mut W, value: &Value) -> io::Result<()> {
    writer.write_all(&encode(value)?)?;
    writer.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn unicode_and_native_framing_round_trip() {
        let value = json!({"中文":"书签🔖"});
        let encoded = encode(&value).unwrap();
        assert_eq!(read_sync(&mut &encoded[..]).unwrap(), value);
        assert_eq!(
            u32::from_le_bytes(encoded[..4].try_into().unwrap()) as usize,
            encoded.len() - 4
        );
    }

    #[test]
    fn rejects_oversized_header_before_reading_payload() {
        let header = (MAX_FRAME as u32 + 1).to_le_bytes();
        assert_eq!(
            read_sync(&mut &header[..]).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        assert!(read_sync(&mut &[1, 0, 0, 0, b'{'][..]).is_err());
    }
}
