# 桥接协议 v1

全部传输均为 UTF-8 JSON，4 字节 little-endian 字节长度前缀；单帧最大 262144 字节（含 JSON 信封），总结果最大 33554432 字节。不是 NDJSON。

客户端连接 Named Pipe 后发送 `{ "v":1,"type":"hello","role":"client" }`，服务返回 `{ "v":1,"type":"hello","ok":true }`。
Native Host 连接同一 pipe，以 role=extension 握手，转发扩展的 hello 字段：`browser_instance_id`（storage.local 随机 ID）、`session_id`（每次 Native 连接新 ID）、`name`、`capabilities`。
扩展发往 Native Host 的首条消息为 `{v:1,type:"hello",role:"extension",browser_instance_id,session_id,name,capabilities}`；bridge 回 hello(ok=true)，host 转发给扩展。

客户端可调用 `{v:1,type:"profiles",id}`，结果为 `{v:1,type:"result",id,ok:true,has_value:true,value:[{browser_instance_id,session_id,name,capabilities}]}`。
客户端发送 `{v:1,type:"call",id,browser_instance_id?:string,method:string,args:array,timeout_ms?:number}`。未指定 profile 时仅在恰好一个连接时自动选择，否则 not_connected / target_ambiguous。
bridge 将请求 id 改为自身唯一 ID，添加 session_id，再转发；结果返回客户端时还原原 ID。

方法不带 chrome. 前缀，例如 bookmarks.getTree，参数为 []。普通结果为 `{v:1,type:"result",id,session_id,ok:true,has_value:true,value:...}`；undefined 用 has_value:false。
错误为 `{v:1,type:"result",id,ok:false,error:{code,message,effect_state:"not_started"|"unknown"}}`。effect_state 只表示本次派发是否已尝试，不证明浏览器回滚。方法错误 chrome_error；不可用 api_unavailable；协议错误 invalid_request；忙碌 busy；断线后已派发 result_unknown。没有自动重试。

超过单帧的结果：先把普通成功 result 的 value 序列化为 UTF-8 JSON 字节。
- `{v:1,type:"result.begin",id,session_id,total_bytes,chunk_count}`
- `{v:1,type:"result.chunk",id,session_id,index,data}`，data 为最多 131072 原始字节的 base64。
- 每次 chunk 发送后等待 `{v:1,type:"result.ack",id,index}` 再发送下一块（单块窗口）。bridge 收到客户端 ack 后还原 ID 转给扩展。
- `{v:1,type:"result.end",id,session_id}`；接收方验证总长、顺序、块数并 JSON.parse，返回原生值。
- ACK 超时或断线停止发送；不继续无限缓冲。begin/所有块/结束均使用同一个请求 ID。

初版并发最多 8 次全局调用；客户端生成连接内唯一 ID，broker 拒绝仍在途的重复 ID。timeout_ms 为 1..60000 的整数，默认 10000；截至超时的总预算包括结果传输。通道/服务内部 cancel 使用 `{v:1,type:"cancel",id}`；调用超时后停止等待及后续分块，不能中断已进入 Chrome 的 API。

首版实现 Promise 与同步 JSON 方法；callback-only 与事件订阅返回 unsupported_api，不假装已完成。后续在同一版本扩充显式适配和订阅，不先试调用失败后重复调用。

